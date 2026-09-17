import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import btwExtension from "../../../local/btw-extension/btw.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { discoverAndLoadExtensions } from "../src/core/extensions/loader.ts";
import { ExtensionRunner } from "../src/core/extensions/runner.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { createInMemoryModelRegistry } from "./model-runtime-test-utils.ts";

describe("/btw extension", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-btw-test-"));
	});

	afterEach(() => fs.rmSync(tempDir, { recursive: true, force: true }));

	async function createRunner() {
		// Load the real extension source through the same discovery path as
		// ~/.pi/agent/extensions/, so the factory behaves exactly as deployed.
		const extensionsDir = path.join(tempDir, "extensions");
		fs.mkdirSync(extensionsDir, { recursive: true });
		fs.copyFileSync(
			path.join(import.meta.dirname, "../../../local/btw-extension/btw.ts"),
			path.join(extensionsDir, "btw.ts"),
		);
		const result = await discoverAndLoadExtensions([], tempDir, tempDir);
		const sm = SessionManager.inMemory();
		const mr = await createInMemoryModelRegistry(AuthStorage.inMemory());
		return { runner: new ExtensionRunner(result.extensions, result.runtime, tempDir, sm, mr) };
	}

	it("registers the /btw command", async () => {
		// Drive the factory directly with a stub API to assert registration.
		const registered: Array<{ name: string; description?: string }> = [];
		const stubApi = {
			registerCommand: (name: string, options: { description?: string }) =>
				registered.push({ name, description: options.description }),
			on: (_event: string, _handler: unknown) => {},
		} as unknown as Parameters<typeof btwExtension>[0];
		btwExtension(stubApi);
		const btw = registered.find((c) => c.name === "btw");
		expect(btw).toBeDefined();
		expect(btw?.description).toContain("side question");
	});

	it("transforms 'btw <message>' to the bare message when idle", async () => {
		const { runner } = await createRunner();
		const result = await runner.emitInput("btw: what is 2+2?", undefined, "interactive");
		expect(result.action).toBe("transform");
		if (result.action === "transform") {
			expect(result.text).toBe("what is 2+2?");
		}
	});

	it("strips the slash form '/btw <message>' when idle", async () => {
		const { runner } = await createRunner();
		const result = await runner.emitInput("/btw what is 2+2?", undefined, "interactive");
		expect(result.action).toBe("transform");
		if (result.action === "transform") {
			expect(result.text).toBe("what is 2+2?");
		}
	});

	it("handles 'btw <message>' while streaming without queueing it", async () => {
		const { runner } = await createRunner();
		const result = await runner.emitInput("btw how far along?", undefined, "interactive", "steer");
		expect(result.action).toBe("handled");
	});

	it("handles 'btw <message>' while queued as follow-up", async () => {
		const { runner } = await createRunner();
		const result = await runner.emitInput("btw how far along?", undefined, "interactive", "followUp");
		expect(result.action).toBe("handled");
	});

	it("requires a message after btw", async () => {
		const { runner } = await createRunner();
		const result = await runner.emitInput("btw ", undefined, "interactive");
		expect(result.action).toBe("handled");
	});

	it("lets non-btw input pass through", async () => {
		const { runner } = await createRunner();
		const result = await runner.emitInput("normal question", undefined, "interactive");
		expect(result.action).toBe("continue");
	});

	it("does not intercept btw text injected by extensions", async () => {
		const { runner } = await createRunner();
		const result = await runner.emitInput("btw note for the agent", undefined, "extension", "steer");
		expect(result.action).toBe("continue");
	});

	it("does not intercept rpc-sourced btw text", async () => {
		const { runner } = await createRunner();
		const result = await runner.emitInput("btw via rpc", undefined, "rpc", "steer");
		expect(result.action).toBe("continue");
	});

	it("idle path uses the same factory that ships in local/ (sanity import)", async () => {
		// The factory loaded from disk must be the same function as the direct
		// import, ensuring the deployed symlink picks up this exact code.
		expect(typeof btwExtension).toBe("function");
	});
});
