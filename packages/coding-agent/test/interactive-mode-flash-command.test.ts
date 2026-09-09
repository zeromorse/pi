import type { Model } from "@earendil-works/pi-ai/compat";
import { describe, expect, it, type Mock, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

type TestModel = Model<any>;

type SettingsManagerMock = {
	getDefaultProvider: () => string | undefined;
	getDefaultModel: () => string | undefined;
	getDefaultFlashProvider: () => string | undefined;
	getDefaultFlashModel: () => string | undefined;
};

type SessionMock = {
	model: TestModel | undefined;
	scopedModels: Array<{ model: TestModel }>;
	modelRuntime: {
		getModel: (provider: string, modelId: string) => TestModel | undefined;
		getAvailableSnapshot: () => TestModel[];
	};
	setModel: (model: TestModel, options: { persist: boolean }) => Promise<void>;
};

type FlashCommandContext = {
	session: SessionMock;
	settingsManager: SettingsManagerMock;
	footer: { invalidate: () => void };
	showStatus: Mock;
	showWarning: Mock;
	showError: Mock;
	updateEditorBorderColor: () => void;
	maybeWarnAboutAnthropicSubscriptionAuth: (model?: TestModel) => Promise<void>;
	checkDaxnutsEasterEgg: (model: TestModel) => void;
	applyModelSwitch: (model: TestModel, statusMessage: string) => Promise<void>;
};

const flashCommandPrototype = InteractiveMode.prototype as unknown as {
	handleFlashCommand(this: FlashCommandContext, searchTerm?: string): Promise<void>;
	applyModelSwitch(this: FlashCommandContext, model: TestModel, statusMessage: string): Promise<void>;
};

function createModel(provider: string, id: string): TestModel {
	return { provider, id } as TestModel;
}

function createContext(options: {
	currentModel?: TestModel;
	defaultModel?: TestModel;
	flashModel?: TestModel;
	availableModels?: TestModel[];
}): FlashCommandContext {
	const availableModels = options.availableModels ?? [];
	const settingsValues = {
		defaultProvider: options.defaultModel?.provider,
		defaultModel: options.defaultModel?.id,
		defaultFlashProvider: options.flashModel?.provider,
		defaultFlashModel: options.flashModel?.id,
	};
	const setModel = vi.fn<(model: TestModel, options: { persist: boolean }) => Promise<void>>();
	if (options.currentModel) {
		setModel.mockImplementation(async (model) => {
			context.session.model = model;
		});
	}
	const context: FlashCommandContext = {
		session: {
			model: options.currentModel,
			scopedModels: [],
			modelRuntime: {
				getModel: (provider, modelId) => availableModels.find((m) => m.provider === provider && m.id === modelId),
				getAvailableSnapshot: () => availableModels,
			},
			setModel,
		},
		settingsManager: {
			getDefaultProvider: () => settingsValues.defaultProvider,
			getDefaultModel: () => settingsValues.defaultModel,
			getDefaultFlashProvider: () => settingsValues.defaultFlashProvider,
			getDefaultFlashModel: () => settingsValues.defaultFlashModel,
		},
		footer: { invalidate: vi.fn() },
		showStatus: vi.fn(),
		showWarning: vi.fn(),
		showError: vi.fn(),
		updateEditorBorderColor: vi.fn(),
		maybeWarnAboutAnthropicSubscriptionAuth: vi.fn().mockResolvedValue(undefined),
		checkDaxnutsEasterEgg: vi.fn(),
		applyModelSwitch: undefined as unknown as (model: TestModel, statusMessage: string) => Promise<void>,
	};
	context.applyModelSwitch = (model, statusMessage) =>
		flashCommandPrototype.applyModelSwitch.call(context, model, statusMessage);
	return context;
}

describe("InteractiveMode /flash command", () => {
	const defaultModel = createModel("anthropic", "claude-sonnet-4-5");
	const flashModel = createModel("anthropic", "claude-haiku-4-5");
	const availableModels = [defaultModel, flashModel];

	it("warns when no flash model is configured", async () => {
		const context = createContext({ currentModel: defaultModel, availableModels });

		await flashCommandPrototype.handleFlashCommand.call(context);

		expect(context.showWarning).toHaveBeenCalledOnce();
		expect(context.showWarning.mock.calls[0]![0]).toContain("No flash model configured");
		expect(context.session.setModel).not.toHaveBeenCalled();
	});

	it("warns about usage when called with a search term instead of toggling", async () => {
		const context = createContext({
			currentModel: defaultModel,
			defaultModel,
			flashModel,
			availableModels,
		});

		await flashCommandPrototype.handleFlashCommand.call(context, "claude-haiku-4-5");

		expect(context.showWarning).toHaveBeenCalledOnce();
		expect(context.showWarning.mock.calls[0]![0]).toContain("Usage: /flash");
		expect(context.session.setModel).not.toHaveBeenCalled();
	});

	it("switches to the flash model when not on it", async () => {
		const context = createContext({
			currentModel: defaultModel,
			defaultModel,
			flashModel,
			availableModels,
		});

		await flashCommandPrototype.handleFlashCommand.call(context);

		expect(context.session.setModel).toHaveBeenCalledOnce();
		expect(context.session.setModel).toHaveBeenCalledWith(flashModel, { persist: false });
		expect(context.showStatus).toHaveBeenCalledWith("Model: claude-haiku-4-5 · flash");
	});

	it("switches back to the default model when on flash", async () => {
		const context = createContext({
			currentModel: flashModel,
			defaultModel,
			flashModel,
			availableModels,
		});

		await flashCommandPrototype.handleFlashCommand.call(context);

		expect(context.session.setModel).toHaveBeenCalledOnce();
		expect(context.session.setModel).toHaveBeenCalledWith(defaultModel, { persist: false });
		expect(context.showStatus).toHaveBeenCalledWith("Model: claude-sonnet-4-5 · default");
	});

	it("warns when on flash but no default model is configured", async () => {
		const context = createContext({
			currentModel: flashModel,
			flashModel,
			availableModels,
		});

		await flashCommandPrototype.handleFlashCommand.call(context);

		expect(context.showWarning).toHaveBeenCalledOnce();
		expect(context.showWarning.mock.calls[0]![0]).toContain("No default model configured");
		expect(context.session.setModel).not.toHaveBeenCalled();
	});

	it("warns when the configured flash model is not available", async () => {
		const context = createContext({
			currentModel: defaultModel,
			defaultModel,
			flashModel: createModel("anthropic", "gone-model"),
			availableModels,
		});

		await flashCommandPrototype.handleFlashCommand.call(context);

		expect(context.showWarning).toHaveBeenCalledOnce();
		expect(context.showWarning.mock.calls[0]![0]).toContain("not found");
		expect(context.session.setModel).not.toHaveBeenCalled();
	});

	it("does not persist the switch into global default settings", async () => {
		const context = createContext({
			currentModel: defaultModel,
			defaultModel,
			flashModel,
			availableModels,
		});

		await flashCommandPrototype.handleFlashCommand.call(context);

		expect(context.session.setModel).toHaveBeenCalledWith(flashModel, { persist: false });
		expect(context.settingsManager.getDefaultModel()).toBe("claude-sonnet-4-5");
	});
});
