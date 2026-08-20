import { stripVTControlCharacters } from "node:util";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { setKeybindings } from "@earendil-works/pi-tui";
import { beforeAll, beforeEach, describe, expect, test } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import type { SessionTreeNode } from "../src/core/session-manager.ts";
import { TreeEntryPreview } from "../src/modes/interactive/components/tree-entry-preview.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

beforeAll(() => {
	initTheme("dark");
});

beforeEach(() => {
	setKeybindings(new KeybindingsManager());
});

type PreviewMessage = { role: string; timestamp: number } & Record<string, unknown>;

function nodeFromEntry(message: PreviewMessage): SessionTreeNode {
	return {
		entry: {
			type: "message",
			id: "e1",
			parentId: null,
			timestamp: new Date().toISOString(),
			message: message as unknown as AgentMessage,
		},
		children: [],
	};
}

function assistantNode(content: unknown): SessionTreeNode {
	return nodeFromEntry({
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4",
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
	});
}

function renderPlain(preview: TreeEntryPreview, width: number): string[] {
	return preview.render(width).map(stripVTControlCharacters);
}

describe("TreeEntryPreview", () => {
	const DOWN = "\x1b[B";
	const UP = "\x1b[A";
	const WHEEL_DOWN = "\x1b[<65;10;5M";
	const WHEEL_UP = "\x1b[<64;10;5M";
	const ESCAPE = "\x1b";

	test("renders title, sections, and full markdown content", () => {
		const node = assistantNode([{ type: "text", text: "# Heading\n\nSome **bold** text." }]);
		const preview = new TreeEntryPreview(node, 20);

		const lines = renderPlain(preview, 80);
		const text = lines.join("\n");
		expect(text).toContain("Entry Preview");
		expect(text).toContain("assistant");
		expect(text).toContain("── Message ──");
		expect(text).toContain("Heading");
		expect(text).toContain("bold");
		expect(text).toContain("back");
	});

	test("renders thinking, tool calls, and tool results as separate sections", () => {
		const node = assistantNode([
			{ type: "thinking", thinking: "let me think" },
			{ type: "text", text: "Reading the file." },
			{ type: "toolCall", id: "tc-1", name: "read", arguments: { path: "test.ts" } },
		]);
		const preview = new TreeEntryPreview(node, 30);

		const text = renderPlain(preview, 80).join("\n");
		expect(text).toContain("── Thinking ──");
		expect(text).toContain("let me think");
		expect(text).toContain("── Message ──");
		expect(text).toContain("Reading the file.");
		expect(text).toContain("── Tool call: read ──");
		expect(text).toContain('"path"');
		expect(text).toContain('"test.ts"');
	});

	test("tool result entry shows result section", () => {
		const node = nodeFromEntry({
			role: "toolResult",
			toolCallId: "tc-1",
			toolName: "read",
			content: [{ type: "text", text: "file contents here" }],
			isError: false,
			timestamp: Date.now(),
		});
		const preview = new TreeEntryPreview(node, 20);

		const text = renderPlain(preview, 80).join("\n");
		expect(text).toContain("tool result: read");
		expect(text).toContain("── Result ──");
		expect(text).toContain("file contents here");
	});

	test("tool result preview shows the originating tool call when provided", () => {
		const node = nodeFromEntry({
			role: "toolResult",
			toolCallId: "tc-1",
			toolName: "bash",
			content: [{ type: "text", text: "total 16" }],
			isError: false,
			timestamp: Date.now(),
		});
		const preview = new TreeEntryPreview(node, 20, {
			relatedToolCall: { name: "bash", arguments: { command: "ls -la" } },
		});

		const text = renderPlain(preview, 80).join("\n");
		expect(text).toContain("── Tool call: bash ──");
		expect(text).toContain('"command"');
		expect(text).toContain('"ls -la"');
		expect(text).toContain("── Result ──");
		expect(text).toContain("total 16");
	});

	test("bash execution shows command section", () => {
		const node = nodeFromEntry({
			role: "bashExecution",
			command: "ls -la",
			output: "total 16\ndrwxr-xr-x  5 user  staff  160 Aug 20 10:00 .",
			exitCode: 0,
			timestamp: Date.now(),
		});
		const preview = new TreeEntryPreview(node, 20);

		const text = renderPlain(preview, 80).join("\n");
		expect(text).toContain("bash command");
		expect(text).toContain("── Command ──");
		expect(text).toContain("ls -la");
		expect(text).toContain("── Execution ──");
		expect(text).toContain("exit code: 0");
		expect(text).toContain("── Output ──");
		expect(text).toContain("total 16");
	});

	test("tool result error and details sections", () => {
		const node = nodeFromEntry({
			role: "toolResult",
			toolCallId: "tc-1",
			toolName: "read",
			content: [{ type: "text", text: "boom" }],
			isError: true,
			details: { line: 42 },
			timestamp: Date.now(),
		});
		const preview = new TreeEntryPreview(node, 20);

		const text = renderPlain(preview, 80).join("\n");
		expect(text).toContain("tool result (error)");
		expect(text).toContain("── Result (error) ──");
		expect(text).toContain("boom");
		expect(text).toContain("── Details ──");
		expect(text).toContain('"line"');
	});

	test("long tool call arguments wrap instead of truncating", () => {
		const longContent = "y".repeat(300);
		const node = assistantNode([
			{ type: "toolCall", id: "tc-1", name: "write", arguments: { path: "a.txt", content: longContent } },
		]);
		const preview = new TreeEntryPreview(node, 30);

		const text = renderPlain(preview, 40).join("\n");
		expect(text).toContain("── Tool call: write ──");
		// The full 300-char payload is present across wrapped lines, not truncated
		const yCount = text.replace(/[^y]/g, "").length;
		expect(yCount).toBeGreaterThanOrEqual(300);
	});

	test("scrolls content with arrow keys and clamps at boundaries", () => {
		const longText = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n\n");
		const node = assistantNode([{ type: "text", text: longText }]);
		const preview = new TreeEntryPreview(node, 12); // content viewport = 8 lines
		const width = 80;

		expect(renderPlain(preview, width).join("\n")).toContain("line 0");

		// Scroll down several times
		for (let i = 0; i < 10; i++) preview.handleInput(DOWN);
		const scrolled = renderPlain(preview, width).join("\n");
		expect(scrolled).not.toContain("line 0");
		expect(scrolled).toContain("line");

		// Scroll past the end: clamp, no crash
		for (let i = 0; i < 200; i++) preview.handleInput(DOWN);
		expect(() => renderPlain(preview, width)).not.toThrow();

		// Scroll back up to the start
		for (let i = 0; i < 300; i++) preview.handleInput(UP);
		expect(renderPlain(preview, width).join("\n")).toContain("line 0");
	});

	test("scrolls with SGR mouse wheel events", () => {
		const longText = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n\n");
		const node = assistantNode([{ type: "text", text: longText }]);
		const preview = new TreeEntryPreview(node, 12);
		const width = 80;

		expect(renderPlain(preview, width).join("\n")).toContain("line 0");

		for (let i = 0; i < 5; i++) preview.handleInput(WHEEL_DOWN);
		const scrolled = renderPlain(preview, width).join("\n");
		expect(scrolled).not.toContain("line 0");

		// Wheel release events are ignored
		preview.handleInput("\x1b[<65;10;5m");
		expect(renderPlain(preview, width).join("\n")).toBe(scrolled);

		for (let i = 0; i < 20; i++) preview.handleInput(WHEEL_UP);
		expect(renderPlain(preview, width).join("\n")).toContain("line 0");
	});

	test("escape closes via onClose", () => {
		const node = assistantNode([{ type: "text", text: "hi" }]);
		const preview = new TreeEntryPreview(node, 20);
		let closed = false;
		preview.onClose = () => {
			closed = true;
		};

		preview.handleInput(ESCAPE);
		expect(closed).toBe(true);
	});

	test("renders a fixed-height page with stable footer", () => {
		const node = assistantNode([{ type: "text", text: "short" }]);
		const preview = new TreeEntryPreview(node, 14);

		const lines = renderPlain(preview, 80);
		expect(lines).toHaveLength(14);
		expect(lines[0]).toContain("Entry Preview");
		expect(lines[lines.length - 1]).toContain("back");
	});

	test("shows scroll position indicator when content overflows", () => {
		const longText = Array.from({ length: 60 }, (_, i) => `line ${i}`).join("\n\n");
		const node = assistantNode([{ type: "text", text: longText }]);
		const preview = new TreeEntryPreview(node, 12);

		const footer = renderPlain(preview, 80)[11];
		expect(footer).toMatch(/1-\d+\/\d+/);
	});

	test("entries without content render a placeholder section", () => {
		const node = {
			entry: {
				type: "model_change",
				id: "m1",
				parentId: null,
				timestamp: new Date().toISOString(),
				provider: "anthropic",
				modelId: "claude-sonnet-4",
			},
			children: [],
		} as unknown as SessionTreeNode;
		const preview = new TreeEntryPreview(node, 20);

		const text = renderPlain(preview, 80).join("\n");
		expect(text).toContain("model: claude-sonnet-4");
		expect(text).toContain("── Info ──");
	});

	describe("text selection", () => {
		const PRESS = (x: number, y: number) => `\x1b[<0;${x};${y}M`;
		const DRAG = (x: number, y: number) => `\x1b[<32;${x};${y}M`;
		const RELEASE = (x: number, y: number) => `\x1b[<0;${x};${y}m`;

		function longTextNode(): SessionTreeNode {
			const longText = Array.from({ length: 30 }, (_, i) => `line number ${i}`).join("\n");
			return assistantNode([{ type: "text", text: longText }]);
		}

		test("drag highlights text; release keeps it and does not copy", () => {
			const preview = new TreeEntryPreview(longTextNode(), 20);
			const width = 80;
			preview.render(width); // cache lines and establish layout
			preview.setOverlayPlacement(0, 0);

			// Screen rows: 0 = title, 1 = blank, 2.. = content. Select content rows 2-4 fully
			preview.handleInput(PRESS(1, 3));
			preview.handleInput(DRAG(40, 6));

			// Selection highlight visible in raw (ANSI) render
			const raw = preview.render(width).join("\n");
			expect(raw).toContain("\x1b[7m");

			let copied: string | undefined;
			preview.onCopySelection = (text) => {
				copied = text;
			};
			preview.handleInput(RELEASE(40, 6));

			// Release no longer auto-copies
			expect(copied).toBeUndefined();

			// Selection remains highlighted after release (until next press)
			expect(preview.render(width).join("\n")).toContain("\x1b[7m");

			// Ctrl+X copies the selection
			preview.handleInput("\x18");
			expect(copied).toBeDefined();
			const copiedLines = copied!.split("\n");
			expect(copiedLines.length).toBeGreaterThanOrEqual(3);
			expect(copiedLines.some((l) => l.includes("line number"))).toBe(true);
		});

		test("ctrl+x with no selection copies the full content", () => {
			const preview = new TreeEntryPreview(longTextNode(), 20);
			const width = 80;
			preview.render(width);

			let copied: string | undefined;
			preview.onCopySelection = (text) => {
				copied = text;
			};
			preview.handleInput("\x18");

			expect(copied).toBeDefined();
			expect(copied!.split("\n").length).toBeGreaterThan(10);
			expect(copied).toContain("line number 0");
		});

		test("click without drag clears the selection and copies nothing", () => {
			const preview = new TreeEntryPreview(longTextNode(), 20);
			const width = 80;
			preview.render(width);
			preview.setOverlayPlacement(0, 0);

			// Establish a selection first
			preview.handleInput(PRESS(1, 3));
			preview.handleInput(DRAG(40, 6));
			preview.handleInput(RELEASE(40, 6));

			// A plain click (no movement) clears it
			let copied: string | undefined;
			preview.onCopySelection = (text) => {
				copied = text;
			};
			preview.handleInput(PRESS(5, 4));
			preview.handleInput(RELEASE(5, 4));

			expect(copied).toBeUndefined();
			expect(preview.render(width).join("\n")).not.toContain("\x1b[7m");
		});

		test("wheel events still scroll while selection is active", () => {
			const preview = new TreeEntryPreview(longTextNode(), 12);
			const width = 80;
			preview.render(width);
			preview.setOverlayPlacement(0, 0);

			preview.handleInput(PRESS(1, 3));
			preview.handleInput(DRAG(40, 5));

			preview.handleInput("\x1b[<65;10;5M"); // wheel down
			const text = renderPlain(preview, width).join("\n");
			expect(text).not.toContain("line number 0");
			preview.handleInput("\x1b[<64;10;5M"); // wheel up
		});

		test("clicks outside the content area do not create a selection", () => {
			const preview = new TreeEntryPreview(longTextNode(), 20);
			const width = 80;
			preview.render(width);
			preview.setOverlayPlacement(0, 0);

			// Row 0 is the title
			preview.handleInput(PRESS(1, 0));
			preview.handleInput(RELEASE(1, 0));

			expect(preview.render(width).join("\n")).not.toContain("\x1b[7m");
		});
	});
});
