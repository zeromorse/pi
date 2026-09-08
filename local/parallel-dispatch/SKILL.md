---
name: parallel-dispatch
description: 将一组 TODO/任务并行分发给多个 clone 出的子 session 执行的工作流协议。当用户说"并行分发这些任务"、"clone 子 session 处理"、"开多个 session 并行"、"fork 出子 session 做 TODO"时激活。覆盖父 session 规划（写 PLAN.md）、自动分发、子 session 执行、进度回流、父 session 汇总五个阶段。适用于任务相互独立、文件范围不重叠、且执行过程需要用户人工判断介入的场景。
---

# Parallel Dispatch 工作流

把一个 session 规划出的任务列表分发给多个并行子 session 执行。核心机制：pi 的 session 树管上下文继承（父→子，通过 `/fork` / `pi --fork`），文件系统管协作回流（子→父，通过 PLAN.md 黑板 + git）。

## 适用判断

满足以下条件才用本工作流，否则建议直接用 subagent 并行：

- 任务相互独立，文件范围不重叠（两个 session 改同一文件必然冲突）
- 执行过程中需要用户人工判断（subagent 无法中途介入）
- 任务粒度较大（单个任务需要多轮交互）

## 阶段 0：规划（父 session）

用户确认任务列表后：

1. 写 `PLAN.md` 到仓库根目录，格式：

   ```markdown
   # Parallel Plan: <标题>

   - 父 session: <ID>（分发后勿再追加对话）

   ## 任务

   - [ ] task-1: <一句话描述>
     - 文件范围: <路径列表>
     - 结论: （完成后填写：做了什么、关键决策及理由、遗留问题）

   - [ ] task-2: <一句话描述>
     - 文件范围: <路径列表>
     - 结论: （完成后填写）
   ```

2. 执行 `/session` 获取父 session ID，然后按"阶段 1：分发"自动分发。

## 阶段 1：分发（环境自适应）

按优先级检测环境并执行，不要只输出命令清单：

### 路线 A：tmux 可用（`command -v tmux` 成功）→ 零键全自动

直接执行（`<cwd>` 为当前项目根目录）：

```bash
tmux has-session -t dispatch 2>/dev/null || tmux new-session -d -s dispatch -c <cwd>
tmux new-window -t dispatch -n task1 "pi --fork <父ID> --name task1"
tmux new-window -t dispatch -n task2 "pi --fork <父ID> --name task2"
```

然后告知用户：`tmux attach -t dispatch` 进入管理（VSCode 集成终端内 attach 亦可）。

### 路线 B：无 tmux 且在 VSCode（`$TERM_PROGRAM` = `vscode`）→ 扩展一键分发

优先使用 parallel-dispatch VSCode 扩展（已安装：`code --list-extensions` 含 `duanyanlong.parallel-dispatch`）。

1. 写 `.pi/dispatch.json` 到项目根目录：

   ```json
   {
   	"cwd": "<项目根绝对路径>",
   	"tasks": [
   		{ "label": "task1", "command": "pi --fork <父ID> --name task1" },
   		{ "label": "task2", "command": "pi --fork <父ID> --name task2" }
   	]
   }
   ```

2. 执行 `code --open-url "vscode://duanyanlong.parallel-dispatch/launch"`

   扩展注册了 URI handler（处理 `/launch` 路径），触发后自动读取 `.pi/dispatch.json`，为每个 task 开一个终端 tab 并自动执行命令，无需用户操作。

   ⚠️ 不要用 `code --command parallel-dispatch.launch`——VSCode CLI 没有 `--command` 选项，参数被静默丢弃（仅 Warning），分发不会发生。

   **执行后必须验证分发结果**：`ps aux | grep '[p]iw --fork'` 应看到每个 task 的进程（实际进程名是 `piw` 而非 `pi`），或运行 `~/.pi/agent/skills/parallel-dispatch/scripts/child-status.sh <父ID>` 确认子 session 已创建。失败时：
   - 无 `piw --fork` 进程且无新 session → 扩展可能刚安装尚未 reload，提示用户 `Cmd+Shift+P → Reload Window` 后重试；或 URI 路由到了其他 VSCode 窗口（错误通知只显示在那个窗口，agent 端看不到，需请用户查看）
   - 用户看到“读取失败 .pi/dispatch.json”或“没有打开的工作区” → URI 路由到了其他 VSCode 窗口，提示用户切到/聚焦项目窗口后重试
   - 重试仍失败 → 报告具体错误并停下等用户决定，**不要静默改用 subagent 或其他执行方式**。除非用户明确说“改用 subagent”或“直接做”，否则不得切换执行模式。

**扩展不可用时**（未安装或命令失败），降级为 tasks.json 方案：写 `.vscode/tasks.json` 到项目根目录（**若已存在，读取并合并 dispatch 条目，绝不覆盖用户已有任务**）：

```json
{
	"version": "2.0.0",
	"tasks": [
		{
			"label": "task1",
			"type": "shell",
			"command": "pi --fork <父ID> --name task1",
			"presentation": { "panel": "new", "reveal": "always", "focus": true, "close": false },
			"isBackground": true,
			"options": { "cwd": "${workspaceFolder}" }
		},
		{
			"label": "task2",
			"type": "shell",
			"command": "pi --fork <父ID> --name task2",
			"presentation": { "panel": "new", "reveal": "always", "focus": true, "close": false },
			"isBackground": true,
			"options": { "cwd": "${workspaceFolder}" }
		},
		{
			"label": "dispatch-all",
			"dependsOn": ["task1", "task2"],
			"dependsOrder": "parallel",
			"problemMatcher": [],
			"group": { "kind": "build", "isDefault": true }
		}
	]
}
```

然后告知用户：**按 `Ctrl+Shift+B`**（或 `Tasks: Run Task` → `dispatch-all`），每个子 session 会在独立终端 tab 中自动启动。

### 路线 C：其他环境 → 手动清单兜底

输出命令清单供用户逐个开终端执行：

```bash
pi --fork <父ID> --name task1
pi --fork <父ID> --name task2
```

### 分发后的提示

- parent 会话恢复：新开一个终端 tab，`pi --session <父ID>`（规划用的原 TUI 若还开着，先提醒用户 `/exit`，pi 无 session 文件锁，双开同一 session 会写乱树结构）
- 分发完成后 `.vscode/tasks.json` 的 dispatch 条目可删除或留存复用

## 阶段 2：子 session 首条指令

每个子 session 由用户手动发首条指令（或用 `/dispatch <task-id>` 模板展开）。指令必须包含三要素：

1. **限定文件范围**：只执行 PLAN.md 中指定任务，不碰其他任务的文件
2. **决策点停顿**：关键方案确定后先停下向用户说明，确认后再动手
3. **回写义务**：完成后 (1) PLAN.md 勾选该任务并在"结论"区追加：做了什么、关键决策及理由、遗留问题；(2) 只 git add 自己改动的文件并 commit，message 用 "<task-id>: " 前缀

## 阶段 3：子 session 执行中的规则

- 遇到方案分歧即停，等用户判断
- git 操作：只 add 自己文件范围里的改动，绝不 `git add -A` / `git add .`
- 跑偏时用户可用 `/tree` 回退该子 session 到分叉点重来，不影响其他子

## 阶段 4：监控（兜底）

子 session 忘记回写 PLAN.md 时，无需其配合，直接反查：

```bash
~/.pi/agent/skills/parallel-dispatch/scripts/child-status.sh <父ID>
```

列出所有子 session 及各自最新 assistant 消息。

## 阶段 5：汇总（父 session）

全部子 session 完成后，用户回到 parent 终端发汇总指令（或用 `/aggregate` 模板展开）：

> 读 PLAN.md 和 git log，逐任务核对结论与实际提交是否一致，运行集成检查，报告差异和遗留问题，然后规划下一步。

汇总时注意：

- PLAN.md 结论与 git log 不一致的任务，用 child-status.sh 反查该子 session 对话核实
- 汇总完成后建议 `/compact` 压掉 fork 前的探索细节，父 session 轻装进入下一轮

## 清理

- PLAN.md 确认后删除，或随成果提交
- 完成的子 session 在 `/resume` 里 Ctrl+D 删除（走 trash，可恢复）
- tmux 会话：`tmux kill-session -t dispatch`；tasks.json dispatch 条目按需删除
