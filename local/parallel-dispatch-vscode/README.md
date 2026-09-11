# parallel-dispatch-vscode

VSCode 扩展：为 pi 的 parallel-dispatch 工作流一键启动子 session 终端。

工作方式：父 session 的 agent 写 `dispatch.json` 到 `<项目根>/.pi/dispatch/<组名>/`，然后执行
`code --open-url "vscode://duanyanlong.parallel-dispatch/launch/<组名>"`（扩展注册了
URI handler），扩展定位组清单后为每个任务开一个终端 tab 并执行命令。

清单定位（0.2.0 起）：

* 带 `<组名>`：先查 `<工作区根>/.pi/dispatch/<组名>/dispatch.json`，不存在则全工作区
  搜索 `**/.pi/dispatch/<组名>/dispatch.json`（submodule/monorepo 场景项目根在工作区
  子目录下也能发现）；多个命中时报错。
* 不带组名（`/launch`）：兼容 0.1.0 布局，读 `<工作区根>/.pi/dispatch.json`。

终端 cwd 优先级：清单 `cwd` 字段（存在时）> 组目录向上三级推断的项目根 > 工作区根。
组布局下 `cwd` 字段可省略。

> ⚠️ 不要用 `code --command parallel-dispatch.launch`——VSCode CLI 没有
> `--command` 选项，参数被静默丢弃（仅 Warning），分发不会发生。

## 清单格式（.pi/dispatch/<组名>/dispatch.json）

```json
{
	"cwd": "/absolute/path/to/project",
	"tasks": [
		{ "label": "task1", "command": "pi --name \"<组名>-task1\" @.pi/dispatch/<组名>/brief.md @.pi/dispatch/<组名>/task-1.md" },
		{ "label": "task2", "command": "pi --name \"<组名>-task2\" @.pi/dispatch/<组名>/brief.md @.pi/dispatch/<组名>/task-2.md" }
	]
}
```

## 构建 / 安装 / 更新

构建产物(`out/`、`*.vsix`)不入库,本仓库只留源码:

```bash
cd local/parallel-dispatch-vscode
npm install --ignore-scripts
npm run compile
npx --yes @vscode/vsce package --allow-missing-repository --skip-license
code --install-extension parallel-dispatch-<版本号>.vsix
```

改代码后重新 package + install(版本号递增可避免缓存),Reload Window 生效。
