import { type Model, modelsAreEqual } from "@earendil-works/pi-ai";
import {
	Container,
	type Focusable,
	fuzzyFilter,
	getKeybindings,
	Input,
	matchesKey,
	Spacer,
	Text,
	type TUI,
} from "@earendil-works/pi-tui";
import type { ModelRuntime } from "../../../core/model-runtime.ts";
import { refreshModelCatalogs } from "../model-catalog-refresh.ts";
import { getModelSelectorSearchText } from "../model-search.ts";
import { theme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { keyHint } from "./keybinding-hints.ts";

interface ModelItem {
	provider: string;
	id: string;
	model: Model<any>;
}

interface ProviderItem {
	provider: string;
	count: number;
}

interface ScopedModelItem {
	model: Model<any>;
	thinkingLevel?: string;
}

interface DefaultModelReference {
	provider: string;
	id: string;
}

type ModelScope = "all" | "scoped";

/**
 * Component that renders a model selector with search.
 *
 * Navigation is two-level: the provider list is shown first and Enter drills
 * into that provider's models. Typing from the provider list immediately jumps
 * to a cross-provider model search; clearing the query returns to the provider
 * list. A single available provider is skipped straight to its models, as is
 * the current model's provider when it has a single model.
 */
export class ModelSelectorComponent extends Container implements Focusable {
	private searchInput: Input;

	// Focusable implementation - propagate to searchInput for IME cursor positioning
	private _focused = false;
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.searchInput.focused = value;
	}
	private listContainer: Container;
	private allModels: ModelItem[] = [];
	private scopedModelItems: ModelItem[] = [];
	private activeModels: ModelItem[] = [];
	private providerItems: ProviderItem[] = [];
	private filteredModels: ModelItem[] = [];
	private providerSelectedIndex: number = 0;
	private modelSelectedIndex: number = 0;
	private selectedProvider?: string;
	private currentModel?: Model<any>;
	private modelRuntime: ModelRuntime;
	private onSelectCallback: (model: Model<any>) => void;
	private onSelectAsDefaultCallback?: (model: Model<any>) => void;
	private onCancelCallback: () => void;
	private errorMessage?: string;
	private refreshStatusMessage = "Refreshing model catalogs…";
	private refreshStatusSuccess = false;
	private tui: TUI;
	private scopedModels: ReadonlyArray<ScopedModelItem>;
	private defaultModel?: DefaultModelReference;
	private scope: ModelScope = "all";
	private scopeText?: Text;
	private scopeHintText?: Text;
	private hintText?: Text;
	private readonly refreshAbortController = new AbortController();
	private refreshTimeout?: ReturnType<typeof setTimeout>;
	private closed = false;

	constructor(
		tui: TUI,
		currentModel: Model<any> | undefined,
		modelRuntime: ModelRuntime,
		scopedModels: ReadonlyArray<ScopedModelItem>,
		onSelect: (model: Model<any>) => void,
		onCancel: () => void,
		initialSearchInput?: string,
		onSelectAsDefault?: (model: Model<any>) => void,
		defaultModel?: DefaultModelReference,
	) {
		super();

		this.tui = tui;
		this.currentModel = currentModel;
		this.modelRuntime = modelRuntime;
		this.scopedModels = scopedModels;
		this.defaultModel = defaultModel;
		this.scope = scopedModels.length > 0 ? "scoped" : "all";
		this.onSelectCallback = onSelect;
		this.onSelectAsDefaultCallback = onSelectAsDefault;
		this.onCancelCallback = onCancel;

		// Add top border
		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));

		// Add hint about model filtering
		if (scopedModels.length > 0) {
			this.scopeText = new Text(this.getScopeText(), 0, 0);
			this.addChild(this.scopeText);
			this.scopeHintText = new Text(this.getScopeHintText(), 0, 0);
			this.addChild(this.scopeHintText);
		} else {
			const hintText = "Only showing models from configured providers. Use /login to add providers.";
			this.addChild(new Text(theme.fg("warning", hintText), 0, 0));
		}
		this.addChild(new Spacer(1));

		// Create search input
		this.searchInput = new Input();
		if (initialSearchInput) {
			this.searchInput.setValue(initialSearchInput);
		}
		this.searchInput.onSubmit = () => {
			if (this.isProviderView()) {
				const item = this.providerItems[this.providerSelectedIndex];
				if (item) {
					this.enterProvider(item.provider);
				}
			} else if (this.filteredModels[this.modelSelectedIndex]) {
				this.handleSelect(this.filteredModels[this.modelSelectedIndex]!.model);
			}
		};
		this.addChild(this.searchInput);

		this.addChild(new Spacer(1));

		// Create list container
		this.listContainer = new Container();
		this.addChild(this.listContainer);

		this.addChild(new Spacer(1));

		// Hint
		if (this.onSelectAsDefaultCallback) {
			this.hintText = new Text("", 0, 0);
			this.addChild(this.hintText);
		}

		// Add bottom border
		this.addChild(new DynamicBorder());

		// Render the current snapshot immediately, then refresh in the background.
		this.loadModelsFromSnapshot();
		this.tui.requestRender();
		void this.refreshModels();
	}

	private loadModelsFromSnapshot(): void {
		const models = this.modelRuntime.getAvailableSnapshot().map((model: Model<any>) => ({
			provider: model.provider,
			id: model.id,
			model,
		}));
		this.allModels = this.sortModels(models);
		this.scopedModels = this.scopedModels.map((scoped) => {
			const refreshed = this.modelRuntime.getModel(scoped.model.provider, scoped.model.id);
			return refreshed ? { ...scoped, model: refreshed } : scoped;
		});
		this.scopedModelItems = this.scopedModels.map((scoped) => ({
			provider: scoped.model.provider,
			id: scoped.model.id,
			model: scoped.model,
		}));
		this.activeModels = this.scope === "scoped" ? this.scopedModelItems : this.allModels;
		this.buildProviderItems();
		this.reconcile();
	}

	private buildProviderItems(): void {
		const counts = new Map<string, number>();
		for (const item of this.activeModels) {
			counts.set(item.provider, (counts.get(item.provider) ?? 0) + 1);
		}
		const items = [...counts.entries()].map(([provider, count]) => ({ provider, count }));
		// Sort: the provider of the current model first, then the default
		// model's provider, then by first appearance (which already reflects
		// alphabetical order for the full model list and the user's scoped
		// model order otherwise).
		items.sort((a, b) => {
			const aIsCurrent = a.provider === this.currentModel?.provider;
			const bIsCurrent = b.provider === this.currentModel?.provider;
			if (aIsCurrent && !bIsCurrent) return -1;
			if (!aIsCurrent && bIsCurrent) return 1;
			const aIsDefault = a.provider === this.defaultModel?.provider;
			const bIsDefault = b.provider === this.defaultModel?.provider;
			if (aIsDefault && !bIsDefault) return -1;
			if (!aIsDefault && bIsDefault) return 1;
			return 0;
		});
		this.providerItems = items;
	}

	private async refreshModels(): Promise<void> {
		const timeoutMs = 15_000;
		let timedOut = false;
		this.refreshTimeout = setTimeout(() => {
			timedOut = true;
			this.refreshAbortController.abort();
		}, timeoutMs);
		try {
			const result = await refreshModelCatalogs(this.modelRuntime, this.refreshAbortController.signal);
			if (this.closed) return;
			this.refreshStatusMessage = "";
			if (result.aborted && timedOut) {
				this.errorMessage = "Model refresh timed out; showing cached models.";
			} else if (result.errors.size === 1) {
				this.errorMessage = `Could not refresh ${result.errors.keys().next().value}; showing cached models.`;
			} else if (result.errors.size > 1) {
				this.errorMessage = `Could not refresh ${result.errors.size} model catalogs (${[...result.errors.keys()].join(", ")}); showing cached models.`;
			} else {
				this.errorMessage = this.modelRuntime.getError();
				if (!this.errorMessage) {
					this.refreshStatusMessage = "Model catalogs refreshed.";
					this.refreshStatusSuccess = true;
				}
			}
			this.loadModelsFromSnapshot();
			this.tui.requestRender();
		} catch (error) {
			if (this.closed) return;
			this.refreshStatusMessage = "";
			this.errorMessage = timedOut
				? "Model refresh timed out; showing cached models."
				: `Could not refresh model catalogs: ${error instanceof Error ? error.message : String(error)}`;
			this.updateList();
			this.tui.requestRender();
		} finally {
			if (this.refreshTimeout) clearTimeout(this.refreshTimeout);
		}
	}

	dispose(): void {
		if (this.closed) return;
		this.closed = true;
		if (this.refreshTimeout) clearTimeout(this.refreshTimeout);
		this.refreshAbortController.abort();
	}

	private sortModels(models: ModelItem[]): ModelItem[] {
		const sorted = [...models];
		// Sort: current model first, default model second, then by provider.
		sorted.sort((a, b) => {
			const aIsCurrent = modelsAreEqual(this.currentModel, a.model);
			const bIsCurrent = modelsAreEqual(this.currentModel, b.model);
			if (aIsCurrent && !bIsCurrent) return -1;
			if (!aIsCurrent && bIsCurrent) return 1;
			const aIsDefault = this.isDefaultModel(a.model);
			const bIsDefault = this.isDefaultModel(b.model);
			if (aIsDefault && !bIsDefault) return -1;
			if (!aIsDefault && bIsDefault) return 1;
			return a.provider.localeCompare(b.provider);
		});
		return sorted;
	}

	private getScopeText(): string {
		const allText = this.scope === "all" ? theme.fg("accent", "all") : theme.fg("muted", "all");
		const scopedText = this.scope === "scoped" ? theme.fg("accent", "scoped") : theme.fg("muted", "scoped");
		return `${theme.fg("muted", "Scope: ")}${allText}${theme.fg("muted", " | ")}${scopedText}`;
	}

	private getScopeHintText(): string {
		return keyHint("tui.input.tab", "scope") + theme.fg("muted", " (all/scoped)");
	}

	private isDefaultModel(model: Model<any>): boolean {
		return this.defaultModel?.provider === model.provider && this.defaultModel.id === model.id;
	}

	private isDefaultSearch(query: string): boolean {
		const normalized = query.trim().toLowerCase();
		return normalized.length > 0 && "default".startsWith(normalized);
	}

	private setScope(scope: ModelScope): void {
		if (this.scope === scope) return;
		this.scope = scope;
		this.loadModelsFromSnapshot();
		if (this.scopeText) {
			this.scopeText.setText(this.getScopeText());
		}
	}

	/**
	 * The provider list is shown whenever there is no search query and no
	 * provider has been drilled into yet.
	 */
	private isProviderView(): boolean {
		return this.selectedProvider === undefined && this.searchInput.getValue().trim().length === 0;
	}

	/** The search box contents, ignoring whitespace-only input. */
	private searchText(): string {
		return this.searchInput.getValue().trim();
	}

	/** Models that the model list shows: all of them or just the drilled provider. */
	private modelSource(): ModelItem[] {
		if (this.selectedProvider !== undefined) {
			return this.activeModels.filter((item) => item.provider === this.selectedProvider);
		}
		return this.activeModels;
	}

	/**
	 * After a snapshot reload: keep or restore a consistent view.
	 * - With a search query keep the global/provider-scoped search.
	 * - Otherwise validate the drilled provider, auto-enter the sole provider,
	 *   and restore a sensible selection for the current view.
	 */
	private reconcile(): void {
		const query = this.searchText();
		if (query) {
			this.filterModels(query);
			return;
		}
		if (
			this.selectedProvider !== undefined &&
			!this.providerItems.some((p) => p.provider === this.selectedProvider)
		) {
			this.selectedProvider = undefined;
		}
		if (this.selectedProvider === undefined) {
			if (this.providerItems.length === 1) {
				// Single available provider: go straight to its model list.
				this.selectedProvider = this.providerItems[0]!.provider;
			} else {
				// The current model's provider with a single model is shown
				// directly rather than requiring an extra provider step.
				const current = this.providerItems.find((p) => p.provider === this.currentModel?.provider);
				if (current && current.count === 1) {
					this.selectedProvider = current.provider;
				}
			}
		}
		if (this.isProviderView()) {
			if (this.providerSelectedIndex >= this.providerItems.length) {
				const currentIndex = this.providerItems.findIndex((p) => p.provider === this.currentModel?.provider);
				this.providerSelectedIndex = currentIndex >= 0 ? currentIndex : Math.max(0, this.providerItems.length - 1);
			}
			this.updateList();
			return;
		}
		const source = this.modelSource();
		const currentIndex = source.findIndex((item) => modelsAreEqual(this.currentModel, item.model));
		this.modelSelectedIndex =
			currentIndex >= 0 ? currentIndex : Math.min(this.modelSelectedIndex, Math.max(0, source.length - 1));
		this.filterModels("");
	}

	private enterProvider(provider: string): void {
		this.selectedProvider = provider;
		this.searchInput.setValue("");
		this.filterModels("");
	}

	private backToProviders(): void {
		const previous = this.selectedProvider;
		this.selectedProvider = undefined;
		if (previous !== undefined) {
			const index = this.providerItems.findIndex((p) => p.provider === previous);
			if (index >= 0) this.providerSelectedIndex = index;
		}
		this.updateList();
	}

	private filterModels(query: string): void {
		const effectiveQuery = query.trim();
		const source = this.modelSource();
		if (effectiveQuery) {
			const filtered = fuzzyFilter(source, effectiveQuery, (item) => {
				const defaultText = this.isDefaultModel(item.model) ? " default" : "";
				return `${getModelSelectorSearchText({ id: item.id, provider: item.provider, name: item.model.name })}${defaultText}`;
			});
			if (this.isDefaultSearch(effectiveQuery)) {
				const defaultItems = source.filter((item) => this.isDefaultModel(item.model));
				const defaultKeys = new Set(defaultItems.map((item) => `${item.provider}\0${item.id}`));
				this.filteredModels = [
					...defaultItems,
					...filtered.filter((item) => !defaultKeys.has(`${item.provider}\0${item.id}`)),
				];
			} else {
				this.filteredModels = filtered;
			}
		} else {
			this.filteredModels = source;
		}
		// When filtering by a query, move the selector to the top row so the best
		// match is highlighted. When the query is cleared, keep the current position
		// clamped to the (restored) list length.
		this.modelSelectedIndex = effectiveQuery
			? 0
			: Math.min(this.modelSelectedIndex, Math.max(0, this.filteredModels.length - 1));
		this.updateList();
	}

	private updateList(): void {
		if (this.isProviderView()) {
			this.renderProviderList();
		} else {
			this.renderModelList();
		}
	}

	private renderProviderList(): void {
		this.listContainer.clear();

		const maxVisible = 10;
		const startIndex = Math.max(
			0,
			Math.min(this.providerSelectedIndex - Math.floor(maxVisible / 2), this.providerItems.length - maxVisible),
		);
		const endIndex = Math.min(startIndex + maxVisible, this.providerItems.length);

		for (let i = startIndex; i < endIndex; i++) {
			const item = this.providerItems[i];
			if (!item) continue;

			const isSelected = i === this.providerSelectedIndex;
			const isCurrentProvider = this.currentModel?.provider === item.provider;
			const isDefaultProvider = this.defaultModel?.provider === item.provider;

			const cursor = isSelected ? theme.fg("accent", "→ ") : "  ";
			const currentMarker = isCurrentProvider ? theme.fg("accent", "✓ ") : "  ";
			const providerText = isSelected ? theme.fg("accent", item.provider) : item.provider;
			const countBadge = theme.fg("muted", ` (${item.count})`);
			const defaultBadge = isDefaultProvider ? theme.fg("muted", " · default") : "";
			const line = `${cursor}${currentMarker}${providerText}${countBadge}${defaultBadge}`;

			this.listContainer.addChild(new Text(line, 0, 0));
		}

		// Add scroll indicator if needed
		if (startIndex > 0 || endIndex < this.providerItems.length) {
			const scrollInfo = theme.fg("muted", `  (${this.providerSelectedIndex + 1}/${this.providerItems.length})`);
			this.listContainer.addChild(new Text(scrollInfo, 0, 0));
		}

		this.appendStatusLines(
			this.providerItems.length === 0,
			"No providers configured. Use /login to add providers.",
			undefined,
		);
	}

	private renderModelList(): void {
		this.listContainer.clear();

		const maxVisible = 10;
		const startIndex = Math.max(
			0,
			Math.min(this.modelSelectedIndex - Math.floor(maxVisible / 2), this.filteredModels.length - maxVisible),
		);
		const endIndex = Math.min(startIndex + maxVisible, this.filteredModels.length);

		// Show visible slice of filtered models
		for (let i = startIndex; i < endIndex; i++) {
			const item = this.filteredModels[i];
			if (!item) continue;

			const isSelected = i === this.modelSelectedIndex;
			const isCurrent = modelsAreEqual(this.currentModel, item.model);
			const isDefault = this.isDefaultModel(item.model);
			const defaultBadge = isDefault ? theme.fg("muted", " · default") : "";

			const cursor = isSelected ? theme.fg("accent", "→ ") : "  ";
			const currentMarker = isCurrent ? theme.fg("accent", "✓ ") : "  ";
			const modelText = isSelected ? theme.fg("accent", item.id) : item.id;
			const providerBadge = theme.fg("muted", `[${item.provider}]`);
			const line = `${cursor}${currentMarker}${modelText} ${providerBadge}${defaultBadge}`;

			this.listContainer.addChild(new Text(line, 0, 0));
		}

		// Add scroll indicator if needed
		if (startIndex > 0 || endIndex < this.filteredModels.length) {
			const scrollInfo = theme.fg("muted", `  (${this.modelSelectedIndex + 1}/${this.filteredModels.length})`);
			this.listContainer.addChild(new Text(scrollInfo, 0, 0));
		}

		const selected = this.filteredModels[this.modelSelectedIndex];
		this.appendStatusLines(
			this.filteredModels.length === 0,
			"No matching models",
			selected ? `  Model Name: ${selected.model.name}` : undefined,
		);
	}

	/** Error / empty-list / model-name / refresh messages shared by both lists. */
	private appendStatusLines(empty: boolean, noResultsText: string, modelNameLine?: string): void {
		if (this.errorMessage) {
			// Show error in red
			const errorLines = this.errorMessage.split("\n");
			for (const line of errorLines) {
				this.listContainer.addChild(new Text(theme.fg("error", line), 0, 0));
			}
		} else if (empty) {
			this.listContainer.addChild(new Text(theme.fg("muted", `  ${noResultsText}`), 0, 0));
		} else if (modelNameLine) {
			this.listContainer.addChild(new Spacer(1));
			this.listContainer.addChild(new Text(theme.fg("muted", modelNameLine), 0, 0));
		}
		if (this.refreshStatusMessage) {
			this.listContainer.addChild(new Spacer(1));
			this.listContainer.addChild(
				new Text(theme.fg(this.refreshStatusSuccess ? "success" : "muted", `  ${this.refreshStatusMessage}`), 0, 0),
			);
		}
		this.updateHintText();
	}

	private updateHintText(): void {
		if (!this.hintText) return;
		const query = this.searchText();
		let hint: string;
		if (this.isProviderView()) {
			hint = "Enter to browse models · Esc to cancel";
		} else if (query) {
			hint = "Enter to select · Ctrl+S sets as default · Esc to clear";
		} else {
			hint = "Enter to select · Ctrl+S sets as default · Esc or Backspace to pick another provider";
		}
		this.hintText.setText(theme.fg("dim", `  ${hint}`));
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();
		const providerView = this.isProviderView();

		if (kb.matches(keyData, "tui.input.tab")) {
			if (this.scopedModelItems.length > 0) {
				const nextScope: ModelScope = this.scope === "all" ? "scoped" : "all";
				this.setScope(nextScope);
				if (this.scopeHintText) {
					this.scopeHintText.setText(this.getScopeHintText());
				}
			}
			return;
		}

		if (kb.matches(keyData, "tui.select.cancel")) {
			// Ctrl+C always closes the whole selector. Escape closes from the
			// provider list; inside a model list it clears the query first and
			// otherwise steps back up to the provider list.
			if (matchesKey(keyData, "ctrl+c") || providerView) {
				this.dispose();
				this.onCancelCallback();
				return;
			}
			if (this.searchText()) {
				this.searchInput.setValue("");
				this.filterModels("");
				return;
			}
			// A single provider's list is skipped on entry, so there is no
			// provider list to step back to: Escape closes the selector.
			if (this.providerItems.length === 1) {
				this.dispose();
				this.onCancelCallback();
				return;
			}
			this.backToProviders();
			return;
		}

		// Up arrow - wrap to bottom when at top
		if (kb.matches(keyData, "tui.select.up")) {
			if (providerView) {
				if (this.providerItems.length === 0) return;
				this.providerSelectedIndex =
					this.providerSelectedIndex === 0 ? this.providerItems.length - 1 : this.providerSelectedIndex - 1;
			} else {
				if (this.filteredModels.length === 0) return;
				this.modelSelectedIndex =
					this.modelSelectedIndex === 0 ? this.filteredModels.length - 1 : this.modelSelectedIndex - 1;
			}
			this.updateList();
			return;
		}

		// Down arrow - wrap to top when at bottom
		if (kb.matches(keyData, "tui.select.down")) {
			if (providerView) {
				if (this.providerItems.length === 0) return;
				this.providerSelectedIndex =
					this.providerSelectedIndex === this.providerItems.length - 1 ? 0 : this.providerSelectedIndex + 1;
			} else {
				if (this.filteredModels.length === 0) return;
				this.modelSelectedIndex =
					this.modelSelectedIndex === this.filteredModels.length - 1 ? 0 : this.modelSelectedIndex + 1;
			}
			this.updateList();
			return;
		}

		// Enter
		if (kb.matches(keyData, "tui.select.confirm")) {
			if (providerView) {
				const item = this.providerItems[this.providerSelectedIndex];
				if (item) {
					this.enterProvider(item.provider);
				}
			} else {
				const selectedModel = this.filteredModels[this.modelSelectedIndex];
				if (selectedModel) {
					this.handleSelect(selectedModel.model);
				}
			}
			return;
		}

		// Ctrl+S — select and save as default
		if (matchesKey(keyData, "ctrl+s") && this.onSelectAsDefaultCallback) {
			if (!providerView) {
				const selectedModel = this.filteredModels[this.modelSelectedIndex];
				if (selectedModel) {
					this.dispose();
					this.onSelectAsDefaultCallback(selectedModel.model);
				}
			}
			return;
		}

		// Backspace on an empty search while browsing a provider returns to the
		// provider list (otherwise the key only edits the search box).
		if (
			!providerView &&
			this.searchInput.getValue().trim().length === 0 &&
			this.selectedProvider !== undefined &&
			kb.matches(keyData, "tui.editor.deleteCharBackward")
		) {
			// A single provider has no provider list to step back to; leave the
			// empty Backspace as a no-op.
			if (this.providerItems.length === 1) return;
			this.backToProviders();
			return;
		}

		// Pass everything else to search input
		this.searchInput.handleInput(keyData);
		this.filterModels(this.searchInput.getValue());
	}

	private handleSelect(model: Model<any>): void {
		this.dispose();
		this.onSelectCallback(model);
	}

	getSearchInput(): Input {
		return this.searchInput;
	}
}
