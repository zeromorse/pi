import {
	type Component,
	extractAnsiCode,
	getKeybindings,
	Markdown,
	sliceByColumn,
	stripTerminalSequences,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { SessionTreeNode } from "../../../core/session-manager.ts";
import { getMarkdownTheme, highlightCode, theme } from "../theme/theme.ts";
import { keyHint } from "./keybinding-hints.ts";

/** SGR mouse sequence: ESC [ < button ; x ; y M (press) or m (release) */
const SGR_MOUSE_RE = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/;
/** SGR wheel button codes */
const WHEEL_UP_BUTTON = 64;
const WHEEL_DOWN_BUTTON = 65;
/** SGR motion modifier: button + 32 while dragging */
const MOTION_MODIFIER = 32;

/** Lines scrolled per wheel event */
const WHEEL_SCROLL_LINES = 3;

/** Lines before the content viewport: title + blank */
const CONTENT_ROW_OFFSET = 2;

/** Rendered-line selection point (columns are within the rendered line) */
interface SelectionPoint {
	line: number;
	col: number;
}

/** Raw section content kinds rendered at render-time width */
type SectionContent =
	| { kind: "markdown"; header: string; text: string }
	| { kind: "code"; header: string; code: string; lang?: string }
	| { kind: "plain"; header: string; text: string };

/**
 * Full-detail preview page for a tree entry.
 *
 * Rendered inside a capturing overlay with SGR mouse tracking enabled, so the
 * mouse wheel scrolls and Escape returns to the tree. Message text renders as
 * markdown (including syntax-highlighted code blocks); tool call arguments
 * render as syntax-highlighted JSON.
 */
export class TreeEntryPreview implements Component {
	private readonly sections: SectionContent[];
	private readonly title: string;
	private readonly viewportHeight: number;
	private scrollTop = 0;
	private cachedLines: string[] | undefined;
	private cachedWidth = 0;
	private overlayRow = 0;
	private overlayCol = 0;
	private selectionAnchor: SelectionPoint | undefined;
	private selectionFocus: SelectionPoint | undefined;
	private selectionActive = false;
	public onClose?: () => void;
	public onCopySelection?: (text: string) => void;

	constructor(
		node: SessionTreeNode,
		viewportHeight: number,
		options?: { relatedToolCall?: { name: string; arguments: Record<string, unknown> } },
	) {
		this.title = this.buildTitle(node);
		this.viewportHeight = Math.max(6, viewportHeight);
		this.sections = this.buildSections(node, options?.relatedToolCall);
	}

	invalidate(): void {
		this.cachedLines = undefined;
	}

	private buildTitle(node: SessionTreeNode): string {
		const entry = node.entry;
		const label = node.label ? theme.fg("warning", ` [${node.label}]`) : "";
		const time = this.formatTimestamp(entry.timestamp);
		return `${theme.bold(theme.fg("accent", "Entry Preview"))}${theme.fg("muted", `  ${this.entryKind(node)}`)}${theme.fg("dim", `  ${time}`)}${label}`;
	}

	private entryKind(node: SessionTreeNode): string {
		const entry = node.entry;
		switch (entry.type) {
			case "message": {
				const msg = entry.message;
				if (msg.role === "toolResult") {
					const toolMsg = msg as { toolName?: string; isError?: boolean };
					return `tool result${toolMsg.isError ? " (error)" : ""}: ${toolMsg.toolName ?? "tool"}`;
				}
				if (msg.role === "bashExecution") return "bash command";
				return msg.role;
			}
			case "custom_message":
				return `custom message: ${entry.customType}`;
			case "compaction":
				return "compaction summary";
			case "branch_summary":
				return "branch summary";
			case "model_change":
				return `model: ${entry.modelId}`;
			case "thinking_level_change":
				return `thinking: ${entry.thinkingLevel}`;
			case "custom":
				return `custom: ${entry.customType}`;
			case "label":
				return `label: ${entry.label ?? "(cleared)"}`;
			case "session_info":
				return `title: ${entry.name ?? "empty"}`;
			default:
				return "entry";
		}
	}

	private buildSections(
		node: SessionTreeNode,
		relatedToolCall?: { name: string; arguments: Record<string, unknown> },
	): SectionContent[] {
		const entry = node.entry;
		const sections: SectionContent[] = [];

		switch (entry.type) {
			case "message": {
				const msg = entry.message;
				if (msg.role === "bashExecution") {
					const bashMsg = msg as {
						command?: string;
						output?: string;
						exitCode?: number;
						cancelled?: boolean;
						truncated?: boolean;
						fullOutputPath?: string;
					};
					if (bashMsg.command?.trim()) {
						sections.push({ kind: "code", header: "Command", code: bashMsg.command, lang: "bash" });
					}
					const meta: string[] = [];
					if (bashMsg.exitCode !== undefined) meta.push(`exit code: ${bashMsg.exitCode}`);
					if (bashMsg.cancelled) meta.push("cancelled");
					if (bashMsg.truncated) meta.push("output truncated");
					if (bashMsg.fullOutputPath) meta.push(`full output: ${bashMsg.fullOutputPath}`);
					if (meta.length > 0) sections.push({ kind: "plain", header: "Execution", text: meta.join("\n") });
					if (bashMsg.output?.trim()) {
						sections.push({ kind: "plain", header: "Output", text: bashMsg.output });
					}
					break;
				}
				const content = (msg as { content?: unknown }).content;
				if (!Array.isArray(content)) {
					if (typeof content === "string" && content.trim()) {
						sections.push({ kind: "markdown", header: "Message", text: content });
					}
					break;
				}
				const textParts: string[] = [];
				const thinkingParts: string[] = [];
				const toolCalls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
				let imageCount = 0;
				for (const block of content) {
					if (typeof block !== "object" || block === null || !("type" in block)) continue;
					const b = block as {
						type: string;
						text?: string;
						thinking?: string;
						name?: string;
						arguments?: Record<string, unknown>;
					};
					if (b.type === "text" && b.text?.trim()) textParts.push(b.text);
					else if (b.type === "thinking" && b.thinking?.trim()) thinkingParts.push(b.thinking);
					else if (b.type === "image") imageCount++;
					else if (b.type === "toolCall" && b.name) {
						toolCalls.push({ name: b.name, arguments: b.arguments ?? {} });
					}
				}
				if (thinkingParts.length > 0) {
					sections.push({ kind: "plain", header: "Thinking", text: thinkingParts.join("\n\n") });
				}
				if (textParts.length > 0 && msg.role !== "toolResult") {
					sections.push({ kind: "markdown", header: "Message", text: textParts.join("\n\n") });
				}
				if (imageCount > 0 && msg.role !== "toolResult") {
					sections.push({ kind: "plain", header: "Images", text: `${imageCount} image(s) attached` });
				}
				for (const tc of toolCalls) {
					sections.push({
						kind: "code",
						header: `Tool call: ${tc.name}`,
						code: JSON.stringify(tc.arguments, null, 2),
						lang: "json",
					});
				}
				if (msg.role === "toolResult") {
					const toolMsg = msg as { isError?: boolean; details?: unknown; toolName?: string };
					// Show the originating tool call (command, arguments) when it can be
					// resolved from the assistant message that produced this result
					if (relatedToolCall) {
						sections.push({
							kind: "code",
							header: `Tool call: ${relatedToolCall.name}`,
							code: JSON.stringify(relatedToolCall.arguments, null, 2),
							lang: "json",
						});
					}
					if (textParts.length > 0) {
						sections.push({
							kind: "plain",
							header: toolMsg.isError ? "Result (error)" : "Result",
							text: textParts.join("\n\n"),
						});
					}
					if (imageCount > 0) {
						sections.push({ kind: "plain", header: "Images", text: `${imageCount} image(s) attached` });
					}
					if (toolMsg.details !== undefined) {
						sections.push({
							kind: "code",
							header: "Details",
							code: JSON.stringify(toolMsg.details, null, 2),
							lang: "json",
						});
					}
				}
				const assistantMsg = msg as { errorMessage?: string };
				if (assistantMsg.errorMessage && textParts.length === 0 && toolCalls.length === 0) {
					sections.push({ kind: "plain", header: "Error", text: assistantMsg.errorMessage });
				}
				break;
			}
			case "custom_message": {
				const text =
					typeof entry.content === "string"
						? entry.content
						: entry.content
								.filter((c): c is { type: "text"; text: string } => c.type === "text")
								.map((c) => c.text)
								.join("\n\n");
				if (text.trim()) sections.push({ kind: "markdown", header: "Message", text });
				break;
			}
			case "compaction":
			case "branch_summary":
				if (entry.summary.trim()) sections.push({ kind: "markdown", header: "Summary", text: entry.summary });
				break;
			default:
				sections.push({ kind: "plain", header: "Info", text: this.entryKind(node) });
				break;
		}

		if (sections.length === 0) {
			sections.push({ kind: "plain", header: "Info", text: "(no content)" });
		}
		return sections;
	}

	private formatTimestamp(timestamp: string): string {
		const date = new Date(timestamp);
		if (Number.isNaN(date.getTime())) return timestamp;
		return date.toLocaleString();
	}

	/** Render all content lines for a given width (cached per width) */
	private contentLines(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;

		const indent = "  ";
		const contentWidth = Math.max(10, width - indent.length * 2);
		const lines: string[] = [];
		const markdownTheme = getMarkdownTheme();

		for (const section of this.sections) {
			lines.push(theme.fg("borderAccent", `── ${section.header} ──`));
			let body: string[];
			switch (section.kind) {
				case "markdown":
					body = new Markdown(section.text, 0, 0, markdownTheme).render(contentWidth);
					break;
				case "code":
					body = [];
					for (const highlighted of highlightCode(section.code, section.lang)) {
						// Wrap highlighted lines instead of truncating so long tool
						// arguments (e.g. embedded file contents) stay fully visible
						body.push(...wrapTextWithAnsi(highlighted, contentWidth));
					}
					break;
				case "plain":
					body = [];
					for (const raw of section.text.split(/\r\n|\r|\n/)) {
						body.push(...(raw.trim() === "" ? [""] : wrapTextWithAnsi(raw, contentWidth)));
					}
					break;
			}
			for (const line of body) {
				lines.push(truncateToWidth(`${indent}${line}`, width));
			}
			lines.push("");
		}

		this.cachedLines = lines;
		this.cachedWidth = width;
		return lines;
	}

	private totalLines(width: number): number {
		return this.contentLines(width).length;
	}

	private maxScrollTop(width: number): number {
		return Math.max(0, this.totalLines(width) - this.contentViewportHeight());
	}

	/** Rows available for content between the title and footer */
	private contentViewportHeight(): number {
		return this.viewportHeight - 4;
	}

	render(width: number): string[] {
		const lines: string[] = [];
		lines.push(truncateToWidth(`  ${this.title}`, width));
		lines.push("");

		const content = this.contentLines(width);
		const viewport = this.contentViewportHeight();
		this.scrollTop = Math.min(this.scrollTop, this.maxScrollTop(width));
		const visible = content.slice(this.scrollTop, this.scrollTop + viewport);

		const selection = this.getSelectionBounds(content.length);
		for (let i = 0; i < visible.length; i++) {
			const contentIndex = this.scrollTop + i;
			lines.push(this.applySelectionToLine(visible[i], contentIndex, selection));
		}
		// Pad to keep the footer position stable while scrolling
		for (let i = visible.length; i < viewport; i++) {
			lines.push("");
		}

		lines.push("");
		const scrolled = this.maxScrollTop(width) > 0;
		const position = scrolled
			? `  ${Math.min(this.scrollTop + 1, this.totalLines(width))}-${Math.min(this.scrollTop + viewport, this.totalLines(width))}/${this.totalLines(width)}`
			: "";
		const footer = `${keyHint("tui.select.cancel", "back")}  ${keyHint("app.message.copy", "copy")}${position ? theme.fg("dim", position) : ""}`;
		lines.push(truncateToWidth(`  ${footer}`, width));
		return lines;
	}

	/** Overlay screen position callback: maps SGR mouse coordinates to content */
	setOverlayPlacement(row: number, col: number): void {
		this.overlayRow = row;
		this.overlayCol = col;
	}

	/** Normalized selection bounds over rendered lines, or undefined */
	private getSelectionBounds(contentLineCount: number): { start: SelectionPoint; end: SelectionPoint } | undefined {
		if (!this.selectionAnchor || !this.selectionFocus) return undefined;
		if (
			this.selectionAnchor.line === this.selectionFocus.line &&
			this.selectionAnchor.col === this.selectionFocus.col
		) {
			return undefined;
		}
		const anchorBeforeFocus =
			this.selectionAnchor.line < this.selectionFocus.line ||
			(this.selectionAnchor.line === this.selectionFocus.line && this.selectionAnchor.col < this.selectionFocus.col);
		const start = anchorBeforeFocus ? this.selectionAnchor : this.selectionFocus;
		const end = anchorBeforeFocus ? this.selectionFocus : this.selectionAnchor;
		if (start.line >= contentLineCount) return undefined;
		return {
			start: { line: start.line, col: Math.max(0, start.col) },
			end: { line: Math.min(end.line, contentLineCount - 1), col: Math.max(0, end.col) },
		};
	}

	/** Apply inverse-video highlight to the selected columns of a rendered line */
	private applySelectionToLine(
		line: string,
		contentIndex: number,
		selection: { start: SelectionPoint; end: SelectionPoint } | undefined,
	): string {
		if (!selection || contentIndex < selection.start.line || contentIndex > selection.end.line) return line;

		const lineWidth = visibleWidth(line);
		let startCol = 0;
		let endCol = lineWidth;
		if (contentIndex === selection.start.line) startCol = Math.min(selection.start.col, lineWidth);
		if (contentIndex === selection.end.line) endCol = Math.min(selection.end.col, lineWidth);
		if (endCol <= startCol) return line;

		const before = sliceByColumn(line, 0, startCol, true);
		const selected = sliceByColumn(line, startCol, endCol - startCol, true);
		const after = sliceByColumn(line, endCol, Math.max(0, lineWidth - endCol), true);
		return `${before}${this.inverseVideo(selected)}${after}`;
	}

	/** Wrap selected text in inverse video, re-asserting it after embedded ANSI codes */
	private inverseVideo(text: string): string {
		let result = "\x1b[7m";
		let index = 0;
		while (index < text.length) {
			const ansi = extractAnsiCode(text, index);
			if (!ansi) {
				result += text[index];
				index += 1;
				continue;
			}
			result += ansi.code;
			if (ansi.code.endsWith("m")) result += "\x1b[7m";
			index += ansi.length;
		}
		return `${result}\x1b[27m`;
	}

	/** Extract the selected text from rendered content lines */
	private getSelectedText(width: number): string | undefined {
		const content = this.contentLines(width);
		const selection = this.getSelectionBounds(content.length);
		if (!selection) return undefined;

		const lines: string[] = [];
		for (let i = selection.start.line; i <= selection.end.line; i++) {
			const line = content[i] ?? "";
			const lineWidth = visibleWidth(line);
			let startCol = 0;
			let endCol = lineWidth;
			if (i === selection.start.line) startCol = Math.min(selection.start.col, lineWidth);
			if (i === selection.end.line) endCol = Math.min(selection.end.col, lineWidth);
			if (endCol <= startCol) continue;
			lines.push(stripTerminalSequences(sliceByColumn(line, startCol, endCol - startCol, true)).trimEnd());
		}
		const text = lines.join("\n");
		return text.length > 0 ? text : undefined;
	}

	/** Map an SGR mouse event to a rendered-line selection point */
	private mouseToPoint(x: number, y: number, width: number): SelectionPoint | undefined {
		const line = y - this.overlayRow - CONTENT_ROW_OFFSET + this.scrollTop;
		if (line < 0 || line >= this.totalLines(width)) return undefined;
		return { line, col: Math.max(0, x - this.overlayCol) };
	}

	private handleSelectionMouse(button: number, x: number, y: number, release: boolean, width: number): void {
		const drag = (button & MOTION_MODIFIER) !== 0;
		const baseButton = button & 3;
		if (release) {
			if (!this.selectionActive) return;
			this.selectionActive = false;
			if (!this.selectionAnchor) return;
			const point = this.mouseToPoint(x, y, width);
			if (point) this.selectionFocus = point;
			// Keep the highlight after release; it is cleared by the next press.
			// Copying is explicit (app.message.copy), not automatic.
			if (!this.getSelectionBounds(this.totalLines(width))) {
				this.selectionAnchor = undefined;
				this.selectionFocus = undefined;
			}
			return;
		}
		if (drag) {
			if (!this.selectionActive || !this.selectionAnchor) return;
			const point = this.mouseToPoint(x, y, width);
			if (point) this.selectionFocus = point;
			return;
		}
		if (baseButton !== 0) return;
		this.selectionActive = true;
		const point = this.mouseToPoint(x, y, width);
		this.selectionAnchor = point;
		this.selectionFocus = point;
	}

	handleInput(keyData: string): void {
		// Mouse events: SGR sequences arrive as raw input while overlay mouse tracking is on
		const mouse = SGR_MOUSE_RE.exec(keyData);
		if (mouse) {
			const release = mouse[4] === "m";
			const button = Number.parseInt(mouse[1], 10);
			const x = Number.parseInt(mouse[2], 10) - 1;
			const y = Number.parseInt(mouse[3], 10) - 1;
			if (!release && (button === WHEEL_UP_BUTTON || button === WHEEL_DOWN_BUTTON)) {
				this.scrollBy(button === WHEEL_UP_BUTTON ? -WHEEL_SCROLL_LINES : WHEEL_SCROLL_LINES);
				return;
			}
			// Press / drag / release drive text selection
			this.handleSelectionMouse(button, x, y, release, this.cachedWidth || 80);
			return;
		}

		const kb = getKeybindings();
		if (kb.matches(keyData, "tui.select.cancel")) {
			this.onClose?.();
		} else if (kb.matches(keyData, "app.message.copy")) {
			this.copySelectionOrAll();
		} else if (kb.matches(keyData, "tui.select.up")) {
			this.scrollBy(-1);
		} else if (kb.matches(keyData, "tui.select.down")) {
			this.scrollBy(1);
		} else if (kb.matches(keyData, "tui.editor.cursorLeft") || kb.matches(keyData, "tui.select.pageUp")) {
			this.scrollBy(-this.contentViewportHeight());
		} else if (kb.matches(keyData, "tui.editor.cursorRight") || kb.matches(keyData, "tui.select.pageDown")) {
			this.scrollBy(this.contentViewportHeight());
		} else if (kb.matches(keyData, "tui.altScreen.top")) {
			this.scrollTop = 0;
		} else if (kb.matches(keyData, "tui.altScreen.bottom")) {
			this.scrollTop = Number.MAX_SAFE_INTEGER;
		}
	}

	private scrollBy(delta: number): void {
		this.scrollTop = Math.max(0, this.scrollTop + delta);
	}

	/** Copy the active selection, or the whole entry when nothing is selected */
	private copySelectionOrAll(): void {
		const width = this.cachedWidth || 80;
		const text = this.getSelectedText(width);
		if (text) {
			this.onCopySelection?.(text);
			return;
		}
		const all: string[] = [];
		for (const line of this.contentLines(width)) {
			all.push(stripTerminalSequences(line).trimEnd());
		}
		const fullText = all.join("\n");
		if (fullText) this.onCopySelection?.(fullText);
	}
}
