import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import {
	type AssistantMessage,
	type AssistantMessageEvent,
	type Context,
	EventStream,
	getModel,
} from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";
import { createTestResourceLoader } from "./utilities.ts";

class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected event type");
			},
		);
	}
}

function createAssistantMessage(text: string, overrides?: Partial<AssistantMessage>): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
		...overrides,
	};
}

describe("AgentSession side question (/btw)", () => {
	let session: AgentSession;
	let tempDir: string;
	let streamFnCallCount = 0;
	const capturedContexts: Context[] = [];

	beforeEach(async () => {
		tempDir = join(tmpdir(), `pi-side-question-test-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
		streamFnCallCount = 0;
		capturedContexts.length = 0;
	});

	afterEach(() => {
		if (session) {
			session.dispose();
		}
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true });
		}
	});

	async function createSession() {
		const model = getModel("anthropic", "claude-sonnet-4-5")!;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: "Test system prompt", tools: [] },
			streamFn: (_model, context) => {
				streamFnCallCount++;
				capturedContexts.push(context);
				const stream = new MockAssistantStream();
				if (streamFnCallCount === 1) {
					// Main prompt: emit the start of a reply but never finish,
					// keeping the agent in the streaming state.
					queueMicrotask(() => {
						stream.push({ type: "start", partial: createAssistantMessage("") });
					});
				} else {
					// Side question: answer immediately.
					queueMicrotask(() => {
						const msg = createAssistantMessage("Side answer");
						stream.push({ type: "start", partial: msg });
						stream.push({ type: "done", reason: "stop", message: msg });
					});
				}
				return stream;
			},
		});

		const sessionManager = SessionManager.inMemory();
		const settingsManager = SettingsManager.create(tempDir, tempDir);
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		const modelRegistry = await createModelRegistry(authStorage, tempDir);
		await authStorage.modify("anthropic", async () => ({ type: "api_key", key: "test-key" }));

		session = new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			cwd: tempDir,
			modelRuntime: getModelRuntime(modelRegistry),
			resourceLoader: createTestResourceLoader(),
		});

		return { session, sessionManager };
	}

	it("answers a side question while the agent is streaming, without interrupting or recording it", async () => {
		const { session, sessionManager } = await createSession();

		// Start a main prompt that stays streaming (never completes).
		const mainPrompt = session.prompt("Main task");
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(session.isStreaming).toBe(true);

		// Ask a side question mid-stream.
		const stream = await session.createSideQuestionStream("What is the answer?");
		const result = await stream.result();

		expect(result.content).toEqual([{ type: "text", text: "Side answer" }]);

		// The side question went through a separate LLM call with the session
		// history plus the question, and no tools.
		expect(streamFnCallCount).toBe(2);
		const sideContext = capturedContexts[1];
		expect(sideContext.tools).toBeUndefined();
		const lastMessage = sideContext.messages[sideContext.messages.length - 1];
		expect(lastMessage.role).toBe("user");
		expect(lastMessage).toMatchObject({ content: [{ type: "text", text: "What is the answer?" }] });
		// The main prompt's history is included.
		expect(sideContext.messages[0].role).toBe("user");
		expect(sideContext.messages[0]).toMatchObject({ content: [{ type: "text", text: "Main task" }] });

		// The side question and answer are not recorded in the session.
		const recordedTexts = sessionManager
			.getEntries()
			.map((entry) => {
				if (entry.type !== "message" || entry.message.role !== "user") return "";
				const content = entry.message.content;
				if (typeof content === "string") return content;
				return content.map((c) => (c.type === "text" ? c.text : "")).join(" ");
			})
			.join("\n");
		expect(recordedTexts).not.toContain("What is the answer?");
		expect(recordedTexts).not.toContain("Side answer");

		// The agent is still streaming the main prompt, uninterrupted.
		expect(session.isStreaming).toBe(true);
		expect(session.getFollowUpMessages()).toEqual([]);
		expect(session.getSteeringMessages()).toEqual([]);

		// The main prompt never resolves in this mock; dispose cleans it up.
		void mainPrompt;
	});
});
