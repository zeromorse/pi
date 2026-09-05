import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setKeybindings, type TUI } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import type { ModelRuntime } from "../src/core/model-runtime.ts";
import { ModelSelectorComponent } from "../src/modes/interactive/components/model-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";
import { createModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

function createFakeTui(): TUI {
	return { requestRender: () => {} } as unknown as TUI;
}

describe("model selector", () => {
	let harness: Harness | undefined;

	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
	});

	afterEach(() => {
		harness?.cleanup();
		harness = undefined;
	});

	it("keeps the current model marked while browsing", async () => {
		harness = await createHarness({
			models: [
				{ id: "current-model", name: "Current Model", reasoning: true },
				{ id: "browsed-model", name: "Browsed Model", reasoning: true },
			],
		});
		const currentModel = harness.getModel("current-model")!;
		const selector = new ModelSelectorComponent(
			createFakeTui(),
			currentModel,
			harness.session.modelRuntime,
			[],
			() => {},
			() => {},
		);

		const getModelRow = (id: string): string | undefined =>
			stripAnsi(selector.render(120).join("\n"))
				.split("\n")
				.find((line) => line.includes(`${id} [`))
				?.trimEnd();

		expect(getModelRow("current-model")).toBe(`→ ✓ current-model [${currentModel.provider}]`);
		selector.handleInput("\x1b[B");
		expect(getModelRow("current-model")).toBe(`  ✓ current-model [${currentModel.provider}]`);
		expect(getModelRow("browsed-model")).toBe(`→   browsed-model [${currentModel.provider}]`);
		selector.dispose();
	});

	it("lists every catalog that failed to refresh", async () => {
		harness = await createHarness();
		vi.spyOn(harness.session.modelRuntime, "refresh").mockResolvedValue({
			aborted: false,
			errors: new Map([
				["openai", new Error("unavailable")],
				["anthropic", new Error("unavailable")],
			]),
		});

		const selector = new ModelSelectorComponent(
			createFakeTui(),
			harness.getModel(),
			harness.session.modelRuntime,
			[],
			() => {},
			() => {},
		);

		await vi.waitFor(() => {
			const rendered = stripAnsi(selector.render(120).join("\n"));
			expect(rendered).toContain("Could not refresh 2 model catalogs (openai, anthropic); showing cached models.");
		});
	});
});

function providersModelsJson(providers: Record<string, Array<{ id: string; name?: string }>>): Record<string, unknown> {
	return {
		providers: Object.fromEntries(
			Object.entries(providers).map(([name, models]) => [
				name,
				{
					baseUrl: "https://example.test/v1",
					api: "openai-completions",
					apiKey: "test-key",
					models,
				},
			]),
		),
	};
}

async function runtimeWithModels(
	models: Record<string, Array<{ id: string; name?: string }>>,
): Promise<{ runtime: ModelRuntime; tempDir: string }> {
	const tempDir = mkdtempSync(join(tmpdir(), "pi-model-selector-two-level-"));
	const modelsPath = join(tempDir, "models.json");
	writeFileSync(modelsPath, JSON.stringify(providersModelsJson(models)));
	const runtime = getModelRuntime(await createModelRegistry(AuthStorage.inMemory(), modelsPath));
	// Do not hit the network while refreshing model catalogs in tests.
	vi.spyOn(runtime, "refresh").mockResolvedValue({ aborted: false, errors: new Map() });
	return { runtime, tempDir };
}

function renderLines(selector: ModelSelectorComponent): string[] {
	return stripAnsi(selector.render(120).join("\n")).split("\n");
}

/** Returns the id of the highlighted model row, or undefined if none is highlighted. */
function highlightedId(lines: string[]): string | undefined {
	const line = lines.find((l) => l.startsWith("→ "));
	if (!line) return undefined;
	const rest = line.replace(/^→\s*/, "");
	return rest.split(" [")[0]?.replace(/^✓\s*/, "").trim() || undefined;
}

describe("two-level provider → model navigation", () => {
	const tempDirs: string[] = [];

	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
	});

	afterEach(() => {
		while (tempDirs.length > 0) {
			rmSync(tempDirs.pop()!, { recursive: true, force: true });
		}
	});

	it("shows the provider list first and drills into a provider on Enter", async () => {
		const { runtime, tempDir } = await runtimeWithModels({
			alpha: [
				{ id: "alpha-1", name: "Alpha One" },
				{ id: "alpha-2", name: "Alpha Two" },
			],
			beta: [{ id: "beta-1", name: "Beta One" }],
		});
		tempDirs.push(tempDir);

		let cancelled = false;
		let selected: string | undefined;
		const current = runtime.getModel("alpha", "alpha-1");
		const selector = new ModelSelectorComponent(
			createFakeTui(),
			current,
			runtime,
			[],
			(model) => {
				selected = model.id;
			},
			() => {
				cancelled = true;
			},
		);

		await vi.waitFor(() => {
			expect(stripAnsi(selector.render(120).join("\n"))).toContain("Model catalogs refreshed.");
		});

		// Provider list: both providers with their model counts, current provider first.
		let lines = renderLines(selector);
		expect(lines.some((l) => l.includes("alpha (2)"))).toBe(true);
		expect(lines.some((l) => l.includes("beta (1)"))).toBe(true);
		// No model rows are rendered while browsing providers.
		expect(lines.some((l) => l.includes("alpha-1 [alpha]"))).toBe(false);
		expect(lines.some((l) => l.includes("beta-1 [beta]"))).toBe(false);

		// Enter on the highlighted provider (alpha) opens its model list.
		selector.handleInput("\r");
		lines = renderLines(selector);
		expect(highlightedId(lines)).toBe("alpha-1");
		expect(lines.some((l) => l.includes("alpha-2 [alpha]"))).toBe(true);
		expect(lines.some((l) => l.includes("beta-1"))).toBe(false);

		// Enter selects the current model.
		selector.handleInput("\r");
		expect(selected).toBe("alpha-1");
		selector.dispose();
		expect(cancelled).toBe(false);
	});

	it("Esc returns from a provider's models to the provider list; Backspace does too", async () => {
		const { runtime, tempDir } = await runtimeWithModels({
			alpha: [{ id: "alpha-1", name: "Alpha One" }],
			beta: [{ id: "beta-1", name: "Beta One" }],
		});
		tempDirs.push(tempDir);

		let cancelled = false;
		const selector = new ModelSelectorComponent(
			createFakeTui(),
			undefined,
			runtime,
			[],
			() => {},
			() => {
				cancelled = true;
			},
		);

		// Move down to beta and drill in.
		selector.handleInput("\x1b[B");
		selector.handleInput("\r");
		expect(renderLines(selector).some((l) => l.includes("beta-1 [beta]"))).toBe(true);

		// Esc while browsing a provider's models returns to the provider list.
		selector.handleInput("\x1b");
		expect(renderLines(selector).some((l) => l.includes("beta (1)"))).toBe(true);
		expect(cancelled).toBe(false);

		// Drill into beta again, then Backspace on the empty search returns.
		selector.handleInput("\r");
		expect(renderLines(selector).some((l) => l.includes("beta-1 [beta]"))).toBe(true);
		selector.handleInput("\x7f");
		expect(renderLines(selector).some((l) => l.includes("beta (1)"))).toBe(true);
		expect(cancelled).toBe(false);

		// Esc on the provider list closes the selector.
		selector.handleInput("\x1b");
		expect(cancelled).toBe(true);
	});

	it("typing in the provider list switches to a global model search", async () => {
		const { runtime, tempDir } = await runtimeWithModels({
			alpha: [
				{ id: "alpha-1", name: "Alpha One" },
				{ id: "alpha-2", name: "Alpha Two" },
			],
			beta: [{ id: "beta-1", name: "Beta One" }],
		});
		tempDirs.push(tempDir);

		const selector = new ModelSelectorComponent(
			createFakeTui(),
			undefined,
			runtime,
			[],
			() => {},
			() => {},
		);

		// Start from the provider list and type a model id: results cross providers.
		expect(renderLines(selector).some((l) => l.includes("alpha (2)"))).toBe(true);
		for (const char of "alpha-2") {
			selector.handleInput(char);
		}
		let lines = renderLines(selector);
		expect(lines.some((l) => l.includes("alpha-2 [alpha]"))).toBe(true);
		expect(lines.some((l) => l.includes("beta-1"))).toBe(false);

		// Clearing the query with Esc returns to the provider list.
		selector.handleInput("\x1b");
		lines = renderLines(selector);
		expect(lines.some((l) => l.includes("alpha (2)"))).toBe(true);
		expect(lines.some((l) => l.includes("alpha-2 [alpha]"))).toBe(false);
		selector.dispose();
	});

	it("skips the provider list when only one provider is available", async () => {
		const { runtime, tempDir } = await runtimeWithModels({
			solo: [
				{ id: "model-1", name: "One" },
				{ id: "model-2", name: "Two" },
			],
		});
		tempDirs.push(tempDir);

		let cancelled = false;
		const selector = new ModelSelectorComponent(
			createFakeTui(),
			runtime.getModel("solo", "model-1"),
			runtime,
			[],
			() => {},
			() => {
				cancelled = true;
			},
		);

		let lines = renderLines(selector);
		// Models are listed immediately, with no provider-list row in between.
		expect(lines.some((l) => l.includes("model-1 [solo]"))).toBe(true);
		expect(lines.some((l) => l.includes("solo (2)"))).toBe(false);

		// Backspace on the empty search stays on the model list (no hidden
		// one-provider list to step back to).
		selector.handleInput("\x7f");
		lines = renderLines(selector);
		expect(lines.some((l) => l.includes("model-1 [solo]"))).toBe(true);
		expect(lines.some((l) => l.includes("solo (2)"))).toBe(false);

		// Esc closes directly instead of stepping back to a skipped provider list.
		selector.handleInput("\x1b");
		expect(cancelled).toBe(true);
		selector.dispose();
	});
});
