import { TuiMainScreen } from "@earendil-works/pi-tui";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { createEditToolDefinition } from "../src/core/tools/edit.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

const ui = new TuiMainScreen(new VirtualTerminal(80, 24));

function createCompletedTool(definition?: ReturnType<typeof createEditToolDefinition>): ToolExecutionComponent {
	const component = new ToolExecutionComponent("custom_tool", "id", {}, {}, definition, ui, "/");
	component.updateResult({ content: [{ type: "text", text: "done" }], isError: false });
	return component;
}

describe("ToolExecutionComponent hidden mode", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	afterAll(() => {
		ui.stop();
	});

	test("renders nothing when hidden after completion", () => {
		const component = createCompletedTool();
		expect(component.render(80).length).toBeGreaterThan(0);

		component.setHidden(true);
		expect(component.render(80)).toEqual([]);
	});

	test("keeps rendering a pending tool while hidden", () => {
		const component = new ToolExecutionComponent("custom_tool", "id", {}, {}, undefined, ui, "/");
		expect(component.render(80).length).toBeGreaterThan(0);

		component.setHidden(true);
		expect(component.render(80).length).toBeGreaterThan(0);
	});

	test("stops rendering once the pending tool completes", () => {
		const component = new ToolExecutionComponent("custom_tool", "id", {}, {}, undefined, ui, "/");
		component.setHidden(true);
		expect(component.render(80).length).toBeGreaterThan(0);

		component.updateResult({ content: [{ type: "text", text: "done" }], isError: false });
		expect(component.render(80)).toEqual([]);
	});

	test("renders again after un-hiding", () => {
		const component = createCompletedTool();
		component.setHidden(true);
		expect(component.render(80)).toEqual([]);

		component.setHidden(false);
		expect(component.render(80).length).toBeGreaterThan(0);
	});

	test("hides self-rendered tools as well", () => {
		const component = new ToolExecutionComponent(
			"edit",
			"id",
			{ path: "file.txt", edits: [{ oldText: "old", newText: "new" }] },
			{},
			createEditToolDefinition("/"),
			ui,
			"/",
		);
		component.updateResult({ content: [{ type: "text", text: "ok" }], isError: false });
		expect(component.render(80).length).toBeGreaterThan(0);

		component.setHidden(true);
		expect(component.render(80)).toEqual([]);
	});
});
