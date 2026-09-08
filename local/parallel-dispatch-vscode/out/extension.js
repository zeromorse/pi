"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const vscode = __importStar(require("vscode"));
function activate(context) {
    async function launch() {
        const folders = vscode.workspace.workspaceFolders;
        if (!folders || folders.length === 0) {
            vscode.window.showErrorMessage("parallel-dispatch: 没有打开的工作区，无法定位 .pi/dispatch.json");
            return;
        }
        const root = folders[0].uri.fsPath;
        const manifestPath = path.join(root, ".pi", "dispatch.json");
        let raw;
        try {
            raw = fs.readFileSync(manifestPath, "utf8");
        }
        catch {
            vscode.window.showErrorMessage(`parallel-dispatch: 读取失败 ${manifestPath}（父 session 是否已写清单?）`);
            return;
        }
        let manifest;
        try {
            manifest = JSON.parse(raw);
        }
        catch (err) {
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
        let last;
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
    context.subscriptions.push(vscode.window.registerUriHandler({
        handleUri(uri) {
            if (uri.path === "/launch" || uri.path === "" || uri.path === "/") {
                return launch();
            }
        },
    }));
}
function deactivate() { }
