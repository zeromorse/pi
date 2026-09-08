# parallel-dispatch-vscode

VSCode 扩展：为 pi 的 parallel-dispatch 工作流一键启动子 session 终端。

工作方式：父 session 的 agent 写 `.pi/dispatch.json` 到项目根，然后执行
`code --open-url "vscode://duanyanlong.parallel-dispatch/launch"`（扩展注册了
URI handler，处理 `/launch` 路径），扩展为每个任务开一个终端 tab
并执行 fork 命令。

> ⚠️ 不要用 `code --command parallel-dispatch.launch`——VSCode CLI 没有
> `--command` 选项，参数被静默丢弃（仅 Warning），分发不会发生。

## 清单格式（.pi/dispatch.json）

```json
{
	"cwd": "/absolute/path/to/project",
	"tasks": [
		{ "label": "task1", "command": "pi --fork <父ID> --name task1" },
		{ "label": "task2", "command": "pi --fork <父ID> --name task2" }
	]
}
```

## 构建 / 安装 / 更新

```bash
cd local/parallel-dispatch-vscode
npm install --ignore-scripts
npm run compile
npx --yes @vscode/vsce package --allow-missing-repository --skip-license
code --install-extension parallel-dispatch-0.1.0.vsix
```

改代码后重新 package + install（版本号递增可避免缓存）。
