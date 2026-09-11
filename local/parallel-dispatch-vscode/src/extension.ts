import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";

interface DispatchTask {
	label: string;
	command: string;
}

interface DispatchManifest {
	cwd?: string;
	tasks: DispatchTask[];
}

/** 组名规范：小写字母/数字/短横线（与 parallel-dispatch skill 的命名约束一致） */
const GROUP_RE = /^[a-z0-9][a-z0-9-]*$/;

/** 组布局相对路径：<项目根>/.pi/dispatch/<组名>/dispatch.json */
function groupManifestRel(group: string): string {
	return `.pi/dispatch/${group}/dispatch.json`;
}

/**
 * 定位组清单 dispatch.json。
 * 1. 工作区根下直查（工作区根 == 项目根的常见情形）
 * 2. 全工作区搜索（submodule/monorepo：项目根在工作区子目录下）
 * 多个命中视为异常（同名组目录不唯一，无法裁决）。
 */
async function locateGroupManifest(root: string, group: string): Promise<string> {
	const direct = path.join(root, ".pi", "dispatch", group, "dispatch.json");
	if (fs.existsSync(direct)) {
		return direct;
	}
	const rel = groupManifestRel(group);
	const uris = await vscode.workspace.findFiles(`**/${rel}`, null, 5);
	if (uris.length === 1) {
		return uris[0].fsPath;
	}
	if (uris.length > 1) {
		throw new Error(`工作区内存在多个 ${rel}，无法确定分发目标`);
	}
	throw new Error(`未找到 ${rel}（父 session 是否已写清单?）`);
}

export function activate(context: vscode.ExtensionContext): void {
	async function launch(group?: string): Promise<void> {
		const folders = vscode.workspace.workspaceFolders;
		if (!folders || folders.length === 0) {
			vscode.window.showErrorMessage("parallel-dispatch: 没有打开的工作区，无法定位 dispatch 清单");
			return;
		}
		const root = folders[0].uri.fsPath;

		let manifestPath: string;
		if (group !== undefined) {
			if (!GROUP_RE.test(group)) {
				vscode.window.showErrorMessage(
					`parallel-dispatch: 非法组名 '${group}'（只允许小写字母、数字、短横线）`,
				);
				return;
			}
			try {
				manifestPath = await locateGroupManifest(root, group);
			} catch (err) {
				vscode.window.showErrorMessage(`parallel-dispatch: ${err instanceof Error ? err.message : String(err)}`);
				return;
			}
		} else {
			// 兼容 0.1.0 布局：工作区根 .pi/dispatch.json
			manifestPath = path.join(root, ".pi", "dispatch.json");
		}

		let raw: string;
		try {
			raw = fs.readFileSync(manifestPath, "utf8");
		} catch {
			vscode.window.showErrorMessage(`parallel-dispatch: 读取失败 ${manifestPath}（父 session 是否已写清单?）`);
			return;
		}

		let manifest: DispatchManifest;
		try {
			manifest = JSON.parse(raw) as DispatchManifest;
		} catch (err) {
			vscode.window.showErrorMessage(`parallel-dispatch: dispatch.json 解析失败: ${err}`);
			return;
		}

		if (!Array.isArray(manifest.tasks) || manifest.tasks.length === 0) {
			vscode.window.showErrorMessage("parallel-dispatch: dispatch.json 的 tasks 为空");
			return;
		}

		for (const task of manifest.tasks) {
			if (typeof task.label !== "string" || typeof task.command !== "string" || !task.label || !task.command) {
				vscode.window.showErrorMessage("parallel-dispatch: task 条目缺少 label 或 command");
				return;
			}
		}

		// cwd 优先级：manifest.cwd（存在时）> 组目录向上三级推断的项目根 > 工作区根
		let cwd = root;
		if (manifest.cwd && fs.existsSync(manifest.cwd)) {
			cwd = manifest.cwd;
		} else if (group !== undefined) {
			const inferred = path.resolve(path.dirname(manifestPath), "..", "..", "..");
			if (fs.existsSync(inferred)) {
				cwd = inferred;
			}
		}

		let last: vscode.Terminal | undefined;
		for (const task of manifest.tasks) {
			const term = vscode.window.createTerminal({ name: task.label, cwd });
			term.sendText(task.command);
			term.show(false);
			last = term;
		}
		last?.show();
		vscode.window.showInformationMessage(`parallel-dispatch: 已启动 ${manifest.tasks.length} 个终端`);
	}

	context.subscriptions.push(vscode.commands.registerCommand("parallel-dispatch.launch", launch));
	context.subscriptions.push(
		vscode.window.registerUriHandler({
			handleUri(uri: vscode.Uri): vscode.ProviderResult<void> {
				// /launch          → 兼容 0.1.0：工作区根 .pi/dispatch.json
				// /launch/<组名>   → 组布局：.pi/dispatch/<组名>/dispatch.json（工作区内自动发现）
				const m = uri.path.match(/^\/launch(?:\/([^/]+))?\/?$/);
				if (m) {
					return launch(m[1]);
				}
			},
		}),
	);
}

export function deactivate(): void {}
