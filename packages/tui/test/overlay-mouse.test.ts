import assert from "node:assert";
import { describe, it } from "node:test";
import type { Component, TUI } from "../src/tui.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

/** VirtualTerminal that records everything written to it */
class RecordingTerminal extends VirtualTerminal {
	written: string[] = [];

	override write(data: string): void {
		this.written.push(data);
		super.write(data);
	}

	output(): string {
		return this.written.join("");
	}
}

class EmptyContent implements Component {
	render(): string[] {
		return [];
	}
	invalidate(): void {}
}

class MouseOverlay implements Component {
	public lastInput: string | undefined;

	render(): string[] {
		return ["preview"];
	}

	invalidate(): void {}

	handleInput(data: string): void {
		this.lastInput = data;
	}
}

function enableSequence(): string {
	return "\x1b[?1000h\x1b[?1002h\x1b[?1004h\x1b[?1006h";
}

function disableSequence(): string {
	return "\x1b[?1006l\x1b[?1004l\x1b[?1002l\x1b[?1000l";
}

describe("overlay mouse tracking", () => {
	it("writes SGR enable sequence when a mouse overlay is shown and disable when hidden", async () => {
		const terminal = new RecordingTerminal(80, 24);
		const tui: TUI = new TuiMainScreen(terminal);
		tui.addChild(new EmptyContent());
		tui.start();

		const overlay = new MouseOverlay();
		const handle = tui.showOverlay(overlay, { mouse: true });
		await new Promise<void>((resolve) => process.nextTick(resolve));

		assert.ok(terminal.output().includes(enableSequence()));

		handle.hide();
		await new Promise<void>((resolve) => process.nextTick(resolve));

		assert.ok(terminal.output().includes(disableSequence()));
		tui.stop();
	});

	it("does not enable mouse tracking for overlays without the mouse option", async () => {
		const terminal = new RecordingTerminal(80, 24);
		const tui: TUI = new TuiMainScreen(terminal);
		tui.addChild(new EmptyContent());
		tui.start();

		const handle = tui.showOverlay(new MouseOverlay(), {});
		await new Promise<void>((resolve) => process.nextTick(resolve));

		assert.ok(!terminal.output().includes(enableSequence()));

		handle.hide();
		tui.stop();
	});

	it("forwards SGR wheel sequences to the focused overlay component", async () => {
		const terminal = new RecordingTerminal(80, 24);
		const tui: TUI = new TuiMainScreen(terminal);
		tui.addChild(new EmptyContent());
		tui.start();

		const overlay = new MouseOverlay();
		tui.showOverlay(overlay, { mouse: true });
		await new Promise<void>((resolve) => process.nextTick(resolve));

		terminal.sendInput("\x1b[<65;10;5M");
		assert.strictEqual(overlay.lastInput, "\x1b[<65;10;5M");
		tui.stop();
	});

	it("re-asserts mouse tracking after stop and start", async () => {
		const terminal = new RecordingTerminal(80, 24);
		const tui: TUI = new TuiMainScreen(terminal);
		tui.addChild(new EmptyContent());
		tui.start();

		const overlay = new MouseOverlay();
		tui.showOverlay(overlay, { mouse: true });
		await new Promise<void>((resolve) => process.nextTick(resolve));

		tui.stop();
		terminal.written = [];
		tui.start();
		await new Promise<void>((resolve) => process.nextTick(resolve));

		assert.ok(terminal.output().includes(enableSequence()));
		tui.stop();
	});
});

describe("overlay onPlaced", () => {
	it("reports the resolved screen position each render", async () => {
		const terminal = new RecordingTerminal(80, 24);
		const tui: TUI = new TuiMainScreen(terminal);
		tui.addChild(new EmptyContent());
		tui.start();

		let placed: { row: number; col: number; width: number } | undefined;
		tui.showOverlay(new MouseOverlay(), {
			mouse: true,
			onPlaced: (row, col, width) => {
				placed = { row, col, width };
			},
		});
		tui.requestRender(true);
		await terminal.waitForRender();

		assert.ok(placed !== undefined);
		assert.strictEqual(placed.width, 80);
		assert.ok(placed.row >= 0 && placed.row < 24);
		assert.strictEqual(placed.col, 0);
		tui.stop();
	});
});
