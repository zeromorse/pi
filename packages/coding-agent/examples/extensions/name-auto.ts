/**
 * Auto session naming extension.
 *
 * Names the session automatically after the first agent turn settles, so the
 * session selector (/resume) shows a meaningful title instead of the first
 * message. Uses a small cheap model when available; falls back to the active
 * model. Never overrides a name set manually via /name -- manual wins.
 *
 * Also registers /name-auto for manual re-trigger (e.g. after clearing the
 * name, or when the first turn was too short to name well):
 *   /name-auto       - regenerate the name from the current conversation
 *   /name-auto off   - disable auto-naming for this session
 *   /name-auto on    - re-enable auto-naming for this session
 *
 * Usage:
 *   pi --extension examples/extensions/name-auto.ts
 */

import { uuidv7 } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type ContentBlock = {
	type?: string;
	text?: string;
};

type SessionMessage = {
	role?: string;
	content?: unknown;
};

/** Preferred small/fast models for naming (first configured one wins). */
const PREFERRED_MODELS: Array<{ provider: string; modelId: string }> = [
	{ provider: "mcli", modelId: "glm-5.3-flash" },
	{ provider: "google", modelId: "gemini-2.5-flash" },
	{ provider: "google", modelId: "gemini-2.0-flash" },
];

/** Max characters of conversation text fed to the naming model. */
const MAX_CONVERSATION_CHARS = 6000;

/** Max characters of the generated name. */
const MAX_NAME_CHARS = 40;

/**
 * The mcli gateway (internal Claude-compatible proxy) drops requests whose
 * system prompt does not start with the official Claude Code marker. Direct
 * complete() calls bypass the before_provider_request extension hook used by
 * the mcli-compat extension, so inject the marker here for mcli requests.
 */
const MCLI_SYSTEM_MARKER = "You are Claude Code, Anthropic's official CLI for Claude.";

/** Prepend the mcli system marker to a provider request payload. */
function withMcliSystemMarker(payload: unknown): unknown {
	if (!payload || typeof payload !== "object") return payload;
	const system = (payload as { system?: unknown }).system;
	const marker = { type: "text", text: MCLI_SYSTEM_MARKER };
	if (Array.isArray(system)) {
		const alreadyPresent = system.some(
			(part) =>
				typeof part === "object" && part !== null && (part as { text?: unknown }).text === MCLI_SYSTEM_MARKER,
		);
		if (alreadyPresent) return payload;
		return { ...payload, system: [marker, ...system] };
	}
	if (typeof system === "string" && system.length > 0) {
		return { ...payload, system: [marker, { type: "text", text: system }] };
	}
	return { ...payload, system: [marker] };
}

const NAME_PROMPT = `You generate short session titles for a coding agent conversation.

Rules:
- Reply with ONE title only. No quotes, no punctuation at the end, no explanation.
- Max ~20 characters (Chinese) or ~6 words (English).
- Describe the core task or topic (e.g. "起送价接口校验分析", "Fix login race condition").
- Use the same language as the conversation.
- If the conversation is trivial or unclear, reply with a 2-6 word generic topic.`;

function extractText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((b): b is ContentBlock => !!b && typeof b === "object" && (b as ContentBlock).type === "text")
		.map((b) => b.text ?? "")
		.join("\n");
}

/** Build a compact conversation transcript for naming. */
function buildTranscript(messages: SessionMessage[]): string {
	const parts: string[] = [];
	let total = 0;
	for (const msg of messages) {
		if (msg.role !== "user" && msg.role !== "assistant") continue;
		const text = extractText(msg.content).trim();
		if (!text) continue;
		const line = `${msg.role}: ${text}`;
		if (total + line.length > MAX_CONVERSATION_CHARS) {
			parts.push(`${line.slice(0, MAX_CONVERSATION_CHARS - total)}...`);
			break;
		}
		parts.push(line);
		total += line.length;
	}
	return parts.join("\n\n");
}

export default function (pi: ExtensionAPI) {
	// Per-session state, reset when the session changes.
	let attemptMade = false;
	let disabled = false;
	let running = false;

	pi.on("session_start", () => {
		attemptMade = false;
		disabled = false;
		running = false;
	});

	/** Collect user/assistant messages from the session tree (main branch order). */
	function getConversation(ctx: {
		sessionManager: { getEntries(): Array<{ type: string; message?: SessionMessage }> };
	}): SessionMessage[] {
		return ctx.sessionManager
			.getEntries()
			.filter(
				(e) => e.type === "message" && e.message && (e.message.role === "user" || e.message.role === "assistant"),
			)
			.map((e) => e.message as SessionMessage);
	}

	/** Pick a naming model: preferred small model with configured auth, else the active model. */
	function pickModel(ctx: Parameters<Parameters<typeof pi.on>[1]>[1]) {
		for (const pref of PREFERRED_MODELS) {
			const model = ctx.modelRegistry.find(pref.provider, pref.modelId);
			if (model && ctx.modelRegistry.hasConfiguredAuth(model)) return model;
		}
		return ctx.model;
	}

	async function generateName(ctx: Parameters<Parameters<typeof pi.on>[1]>[1]): Promise<string | undefined> {
		const conversation = getConversation(ctx);
		const transcript = buildTranscript(conversation);
		if (transcript.length < 20) return undefined;

		const model = pickModel(ctx);
		if (!model) return undefined;

		const response = await ctx.modelRegistry.complete(
			model,
			{
				systemPrompt: NAME_PROMPT,
				messages: [
					{
						role: "user",
						content: [{ type: "text", text: `<conversation>\n${transcript}\n</conversation>` }],
						timestamp: Date.now(),
					},
				],
			},
			{
				maxTokens: 200,
				cacheRetention: "none",
				sessionId: uuidv7(),
				onPayload: model.provider === "mcli" ? withMcliSystemMarker : undefined,
			},
		);

		// complete() resolves failed calls as an AssistantMessage with an error
		// stopReason instead of throwing, so surface the real error here.
		if (response.stopReason === "error" || response.stopReason === "aborted") {
			throw new Error(response.errorMessage ?? `命名模型调用失败 (${response.provider}/${response.model})`);
		}

		const name = response.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text)
			.join("")
			.replace(/^["'「『]|["'」』]$/g, "")
			.replace(/\s+/g, " ")
			.trim()
			.slice(0, MAX_NAME_CHARS);
		return name || undefined;
	}

	async function autoName(
		ctx: Parameters<Parameters<typeof pi.on>[1]>[1],
		reason: "settled" | "manual",
	): Promise<void> {
		if (running) return;
		if (reason === "settled") {
			if (disabled || attemptMade) return;
			// Manual names (and previous auto names) always win.
			if (pi.getSessionName()) return;
		} else if (pi.getSessionName()) {
			ctx.ui.notify("已有会话名，先 /name 清空后再试", "warning");
			return;
		}

		running = true;
		try {
			attemptMade = true;
			const name = await generateName(ctx);
			if (!name) {
				if (reason === "manual") ctx.ui.notify("会话内容太少，无法生成名字", "warning");
				return;
			}
			pi.setSessionName(name);
			ctx.ui.notify(`会话已命名: ${name}`, "info");
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(`自动命名失败: ${message}`, "warning");
		} finally {
			running = false;
		}
	}

	pi.on("agent_settled", async (_event, ctx) => {
		if (!ctx.hasUI) return; // skip in -p / json modes
		await autoName(ctx, "settled");
	});

	pi.registerCommand("name-auto", {
		description: "自动生成会话名 (off: 禁用 / on: 启用)",
		handler: async (args, ctx) => {
			const flag = args.trim().toLowerCase();
			if (flag === "off") {
				disabled = true;
				ctx.ui.notify("已禁用本会话的自动命名", "info");
				return;
			}
			if (flag === "on") {
				disabled = false;
				ctx.ui.notify("已启用本会话的自动命名", "info");
				return;
			}
			await autoName(ctx, "manual");
		},
	});
}
