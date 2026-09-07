/**
 * Tests that provider request extension hooks (`before_provider_request` /
 * `after_provider_response`) run for standalone LLM requests that bypass the
 * agent loop, such as compaction and branch-summary summarization.
 *
 * These requests call `agent.streamFunction` directly with options that do not
 * carry the Agent's onPayload/onResponse, so the stream function must inject
 * the extension hooks itself.
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type Api,
	type AssistantMessage,
	createAssistantMessageEventStream,
	type Model,
	type SimpleStreamOptions,
	type Usage,
} from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import type { ExtensionAPI, ExtensionFactory } from "../src/core/extensions/index.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createInMemoryModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "./utilities.ts";

interface CapturedRequest {
	/** Payload as it would be sent before the onPayload hook. */
	payload: unknown;
	/** Payload after applying the provider options' onPayload hook, if any. */
	hookedPayload: unknown;
	hasOnPayload: boolean;
}

describe("createAgentSession extension hooks on standalone requests", () => {
	let tempDir: string;
	let cwd: string;
	let agentDir: string;
	let hookPayloads: unknown[];
	let hookResponseStatuses: number[];
	let capturedRequests: CapturedRequest[];

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-sdk-hooks-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		cwd = join(tempDir, "project");
		agentDir = join(tempDir, "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		hookPayloads = [];
		hookResponseStatuses = [];
		capturedRequests = [];
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	const PROVIDER = "hook-capture";

	const model: Model<Api> = {
		id: "capture-model",
		name: "Capture Model",
		api: "openai-completions",
		provider: PROVIDER,
		baseUrl: "https://capture.example",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 4096,
	};

	const zeroUsage: Usage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};

	/** Extension that records payloads and rewrites them with a marker. */
	const hookExtension: ExtensionFactory = (pi: ExtensionAPI) => {
		pi.on("before_provider_request", (event) => {
			hookPayloads.push(event.payload);
			return { ...(event.payload as object), marker: "injected" };
		});
		pi.on("after_provider_response", (event) => {
			hookResponseStatuses.push(event.status);
		});
	};

	function createDoneStream() {
		const stream = createAssistantMessageEventStream();
		const message: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "Summary: the conversation was about math." }],
			api: model.api,
			provider: PROVIDER,
			model: model.id,
			usage: zeroUsage,
			stopReason: "stop",
			timestamp: Date.now(),
		};
		stream.end(message);
		return stream;
	}

	async function createSession() {
		const authStorage = AuthStorage.inMemory({
			[PROVIDER]: { type: "api_key", key: "test-api-key" },
		});
		const modelRegistry = await createInMemoryModelRegistry(authStorage);
		modelRegistry.registerProvider(PROVIDER, {
			api: model.api,
			streamSimple: (_model, _context, providerOptions?) => {
				const options = providerOptions as SimpleStreamOptions | undefined;
				const entry: CapturedRequest = {
					payload: { requestIndex: capturedRequests.length },
					hookedPayload: undefined,
					hasOnPayload: options?.onPayload !== undefined,
				};
				capturedRequests.push(entry);
				// Apply the payload hook the way real providers do before sending.
				if (options?.onPayload) {
					void Promise.resolve(options.onPayload(entry.payload, _model)).then((hooked) => {
						entry.hookedPayload = hooked;
					});
				}
				return createDoneStream();
			},
		});

		const sessionManager = SessionManager.inMemory(cwd);
		const settingsManager = SettingsManager.create(cwd, agentDir);
		settingsManager.applyOverrides({ compaction: { keepRecentTokens: 1 } });

		const extensionsResult = await createTestExtensionsResult([hookExtension], cwd);

		return await createAgentSession({
			cwd,
			agentDir,
			model,
			modelRuntime: getModelRuntime(modelRegistry),
			sessionManager,
			settingsManager,
			resourceLoader: createTestResourceLoader({ extensionsResult }),
		});
	}

	it("runs before_provider_request for direct streamFunction calls without options.onPayload", async () => {
		const { session } = await createSession();

		const stream = await session.agent.streamFunction(model, { messages: [] }, { sessionId: session.sessionId });
		await stream.result();
		session.dispose();

		expect(capturedRequests.length).toBe(1);
		expect(capturedRequests[0].hasOnPayload).toBe(true);
		// Hook rewrote the payload with the marker.
		expect((capturedRequests[0].hookedPayload as { marker?: string } | undefined)?.marker).toBe("injected");
	});

	it("does not double-run hooks when options.onPayload is already set", async () => {
		const { session } = await createSession();

		const explicitPayloads: unknown[] = [];
		const stream = await session.agent.streamFunction(
			model,
			{ messages: [] },
			{
				sessionId: session.sessionId,
				onPayload: (payload) => {
					explicitPayloads.push(payload);
					return payload;
				},
			},
		);
		await stream.result();
		session.dispose();

		expect(explicitPayloads.length).toBe(1);
		// The extension hook must not run in addition to the explicit onPayload.
		expect(hookPayloads.length).toBe(0);
	});

	it("runs before_provider_request for compaction summarization requests", async () => {
		const { session } = await createSession();

		const sessionManager = session.sessionManager;
		sessionManager.appendMessage({
			role: "user",
			content: "What is 2+2?",
			timestamp: Date.now(),
		});
		sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "4" }],
			api: model.api,
			provider: PROVIDER,
			model: model.id,
			usage: zeroUsage,
			stopReason: "stop",
			timestamp: Date.now(),
		});

		const result = await session.compact();
		session.dispose();

		expect(result.summary).toBeDefined();
		// The summarization request must have gone through the extension hook.
		expect(capturedRequests.length).toBeGreaterThan(0);
		for (const request of capturedRequests) {
			expect(request.hasOnPayload).toBe(true);
			expect((request.hookedPayload as { marker?: string } | undefined)?.marker).toBe("injected");
		}
		expect(hookPayloads.length).toBe(capturedRequests.length);
	});
});
