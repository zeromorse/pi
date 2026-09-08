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

export function activate(context: vscode.ExtensionContext): void {
	async function launch(): Promise<void> {
		const folders = vscode.workspace.workspaceFolders;
		if (!folders || folders.length === 0) {
			vscode.window.showErrorMessage("parallel-dispatch: 没有打开的工作区，无法定位 .pi/dispatch.json");
			return;
		}

		const root = folders[0].uri.fsPath;
		const manifestPath = path.join(root, ".pi", "dispatch.json");

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

		const cwd = manifest.cwd && fs.existsSync(manifest.cwd) ? manifest.cwd : root;

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
				if (uri.path === "/launch" || uri.path === "" || uri.path === "/") {
					return launch();
				}
			},
		}),
	);
}

export function deactivate(): void {}
