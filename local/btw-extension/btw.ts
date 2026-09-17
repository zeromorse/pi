/**
 * /btw side question extension.
 *
 * `/btw <message>` (or `btw <message>`) asks a one-off side question while the
 * agent is busy: the answer streams back via an independent LLM call over the
 * current conversation snapshot, without interrupting the agent and without
 * entering the session history. When idle, the message is sent as a normal
 * prompt.
 *
 * This is a fork-local replacement for the former in-core implementation
 * (commit 3900babfb): keeping /btw out of packages/coding-agent/src removes
 * recurring merge conflicts with upstream in agent-session.ts,
 * interactive-mode.ts and slash-commands.ts.
 *
 * Deployed as a symlink: ~/.pi/agent/extensions/btw.ts -> local/btw-extension/btw.ts
 * Imports resolve through pi's jiti aliases regardless of the file location.
 */
import { convertToLlm, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { contentText } from "@earendil-works/pi-ai";

/** Matches "/btw" or "btw" followed by a separator (space, colon, comma, or full-width variants). */
const BTW_PREFIX = /^\/btw[\s:,，：]+|^btw[\s:,，：]+/i;
const WIDGET_ID = "btw";
/** Max lines kept in the streaming widget; older lines are dropped. */
const MAX_WIDGET_LINES = 15;

const SIDE_QUESTION_SUFFIX =
	"\n\nThe user is asking a quick side question while a task continues in the background. " +
	"Answer the question directly and concisely, drawing on the conversation above. " +
	"You have no tools available for this answer: do not call tools and do not attempt to continue or resume the background task.";

/** Extract the text answer (text blocks only, thinking excluded) from an assistant message. */
function answerText(partial: { content: readonly unknown[] }): string {
	let text = "";
	for (const block of partial.content) {
		if (
			block &&
			typeof block === "object" &&
			(block as { type?: string }).type === "text"
		) {
			text += (block as { text?: string }).text ?? "";
		}
	}
	return text.trim();
}

/** Conversation snapshot as LLM messages: active branch with compaction applied. */
function snapshotMessages(ctx: ExtensionContext) {
	return convertToLlm(
		ctx.sessionManager
			.buildContextEntries()
			.filter((entry) => entry.type === "message")
			.map((entry) => entry.message),
	);
}

async function runSideQuestion(pi: ExtensionAPI, ctx: ExtensionContext, question: string): Promise<void> {
	const model = ctx.model;
	if (!model) {
		if (ctx.hasUI) ctx.ui.notify("No model selected", "error");
		return;
	}

	const messages = snapshotMessages(ctx);
	messages.push({
		role: "user",
		content: [{ type: "text", text: question }],
		timestamp: Date.now(),
	});

	const options: Parameters<typeof ctx.modelRegistry.streamSimple>[2] = {
		sessionId: ctx.sessionManager.getSessionId(),
	};
	if (model.reasoning && ctx.thinkingLevel && ctx.thinkingLevel !== "off") {
		options.reasoning = ctx.thinkingLevel;
	}

	const widgetLines = (text: string, suffix?: string): string[] => {
		const lines = (text || "…").split("\n");
		const shown = lines.slice(-MAX_WIDGET_LINES);
		if (lines.length > MAX_WIDGET_LINES) shown.unshift(`… (+${lines.length - MAX_WIDGET_LINES} lines)`);
		if (suffix) shown.push(suffix);
		return shown;
	};

	const show = (lines: string[]): void => {
		if (ctx.hasUI) ctx.ui.setWidget(WIDGET_ID, [`(btw) ${question}`, ...lines]);
	};

	show(["…"]);

	try {
		const stream = ctx.modelRegistry.streamSimple(model, { systemPrompt: ctx.getSystemPrompt() + SIDE_QUESTION_SUFFIX, messages }, options);
		for await (const event of stream) {
			if (event.type === "done") {
				show(widgetLines(answerText(event.message)));
			} else if (event.type === "error") {
				show(widgetLines(answerText(event.error), "(error)"));
			} else {
				show(widgetLines(answerText(event.partial)));
			}
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (ctx.hasUI) ctx.ui.notify(`Side question failed: ${message}`, "error");
		show([`(error) ${message}`]);
	}
}

export default function btwExtension(pi: ExtensionAPI): void {
	// "/btw <message>" via slash command (shows up in command autocomplete).
	pi.registerCommand("btw", {
		description: "Ask a side question answered immediately, without interrupting the agent",
		getArgumentCompletions: () => null,
		handler: async (args, ctx) => {
			const question = args.trim();
			if (!question) {
				if (ctx.hasUI) ctx.ui.notify('Add a message after "btw" to ask a side question.', "warning");
				return;
			}
			// Idle: send as a normal prompt, matching the original core behavior.
			if (ctx.isIdle()) {
				pi.sendUserMessage(question);
				return;
			}
			await runSideQuestion(pi, ctx, question);
		},
	});

	// "btw <message>" (no slash) via input interception. Also clears a previous
	// answer widget on any other input.
	pi.on("input", async (event, ctx) => {
		const match = BTW_PREFIX.exec(event.text);

		if (!match) {
			// Any other input dismisses the previous side-question answer.
			if (ctx.hasUI) ctx.ui.setWidget(WIDGET_ID, undefined);
			return { action: "continue" };
		}

		// Only interactive input; messages injected by extensions or RPC go through normal processing.
		if (event.source !== "interactive") return { action: "continue" };

		const question = event.text.slice(match[0].length).trim();
		if (!question) {
			if (ctx.hasUI) ctx.ui.notify('Add a message after "btw" to ask a side question.', "warning");
			return { action: "handled" };
		}

		// Idle: strip the prefix and let it run as a normal prompt.
		if (event.streamingBehavior === undefined && ctx.isIdle()) {
			return { action: "transform", text: question };
		}

		// Busy (streaming, compaction, retries): answer immediately, outside the agent loop.
		// Fire and forget: the input pipeline must not wait for the answer.
		void runSideQuestion(pi, ctx, question);
		return { action: "handled" };
	});

	// Clean up on session switch/reload.
	pi.on("session_shutdown", (_event, ctx) => {
		if (ctx.hasUI) ctx.ui.setWidget(WIDGET_ID, undefined);
	});
}
