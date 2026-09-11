---
name: parallel-dispatch
description: 将一组 TODO/任务并行分发给多个全新子 session（零历史继承，任务简报自动注入）执行的工作流协议。当用户说"并行分发这些任务"、"clone 子 session 处理"、"开多个 session 并行"、"fork 出子 session 做 TODO"时激活。覆盖父 session 规划（写 PLAN.md + 任务简报）、自动分发、子 session 执行、进度回流、父 session 汇总五个阶段。适用于任务相互独立、文件范围不重叠、执行过程需要用户人工判断介入的场景。
---

# Parallel Dispatch 工作流

把一个 session 规划出的任务列表分发给多个并行子 session 执行。核心机制：**子 session 全新启动、零历史继承**——每个子 session 只带一份任务简报（父 session ID + 概要 + 自己的任务），通过 pi 交互模式的 `@file` 初始消息在启动时自动注入；父子关联靠命名约定（`<父名>-task<N>`）；文件系统管协作回流（子→父，通过 PLAN.md 黑板 + git）。

> 全组协作文件统一放在 `<项目根>/.pi/dispatch/<组名>/` 下（`PLAN.md` 黑板、`brief.md` 共享简报、`task-<N>.md` 任务简报、`dispatch.json` 启动清单），不散落在项目根，同一工程多组分派时各组目录互不冲突。

> 禁止用 `pi --fork` 分发任务：fork 会把父 session 的全部历史复制给子 session，探索细节污染上下文，且子 session 不知道自己的任务身份。

## 适用判断

满足以下条件才用本工作流，否则建议直接用 subagent 并行：

- 任务相互独立，文件范围不重叠（两个 session 改同一文件必然冲突）
- 执行过程中需要用户人工判断（subagent 无法中途介入）
- 任务粒度较大（单个任务需要多轮交互）

## 多组并存

同一工程可同时/先后发起多组分派：各组用独立组名，子 session 前缀（`<组名>-task<N>`）与组目录（`.pi/dispatch/<组名>/`）天然隔离，互不冲突。监控 `child-status.sh <组名>` 按前缀只列本组子 session。注意：同一父 session 发起第二组分派时不能复用旧组名（否则组目录、子 session 前缀都会撞），需换新组名（如 `pr224-fix`、`pr224-fix-ai`）。

## 阶段 0：规划（父 session）

用户确认任务列表后：

1. 确定分派组名：即父 session 的显示名。未命名则先 `/name <组名>`（只用小写字母、数字、短横线，不含空格）；已命名直接复用。子 session 将统一命名为 `<组名>-task<N>`，监控脚本按此前缀匹配。
2. 执行 `/session` 获取父 session ID。
3. 写 `PLAN.md` 到 `.pi/dispatch/<组名>/`，格式：

   ```markdown
   # Parallel Plan: <标题>

   - 分派组名: <组名>
   - 父 session: <ID>（分发后勿再追加对话）

   ## 任务

   - [ ] task-1: <一句话描述>
     - 文件范围: <路径列表>
     - 结论: （完成后填写：做了什么、关键决策及理由、遗留问题）

   - [ ] task-2: <一句话描述>
     - 文件范围: <路径列表>
     - 结论: （完成后填写）
   ```

4. 写分派简报到 `.pi/dispatch/<组名>/`：一个共享简报 `brief.md` + 每任务一个 `task-<N>.md`。子 session 的全部上下文就是这两个文件的拼接，必须自包含，不得出现"如前所述"之类对父 session 对话的引用。

   `.pi/dispatch/<组名>/brief.md`（共享，每个子 session 都注入）：

   ```markdown
   # 并行分派简报（<组名>）

   你是并行分发工作流中的子 session。本 session 全新启动，父 session 的对话历史不在你的上下文中——本简报就是全部背景，读完直接开始执行你的任务。

   - 分派组名: <组名>
   - 父 session ID: <父ID>（汇总由父 session 负责，你的成果通过 PLAN.md 与 git 回流；不要试图恢复或续接父 session 的对话）
   - 父上下文概要: <父 session 自己总结，一两百字：项目背景、本次并行任务的整体目标、关键约束>

   ## 执行规则

   1. 只执行分派给你的任务，不碰其他任务的文件范围
   2. 关键方案确定后先停下向用户说明，确认后再动手
   3. 完成后：(1) 在 `.pi/dispatch/<组名>/PLAN.md` 勾选你的任务，并在"结论"区追加：做了什么、关键决策及理由、遗留问题；(2) 只 git add 自己文件范围内的改动并 commit，message 用 "<task-id>: " 前缀（`.pi/` 协作目录保持未跟踪，不提交）
   ```

   `.pi/dispatch/<组名>/task-<N>.md`（任务专属）：

   ```markdown
   # task-<N>: <一句话描述>

   - 文件范围: <路径列表，只许改这些>
   - 任务详情: <具体要求与验收标准，自包含>
   ```

## 阶段 1：分发（环境自适应）

启动命令统一为（在项目根目录执行）：

```bash
pi --name "<组名>-task1" @.pi/dispatch/<组名>/brief.md @.pi/dispatch/<组名>/task-1.md
```

pi 交互模式会把 `@file` 内容拼成首条消息**自动发送**（不是预填编辑器），子 session 启动即开始执行，无需用户手动发首条指令。按优先级检测环境并执行，不要只输出命令清单：

### 路线 A：tmux 可用（`command -v tmux` 成功）→ 零键全自动

直接执行（`<cwd>` 为当前项目根目录）：

```bash
tmux has-session -t dispatch 2>/dev/null || tmux new-session -d -s dispatch -c <cwd>
tmux new-window -t dispatch -n task1 'pi --name "<组名>-task1" @.pi/dispatch/<组名>/brief.md @.pi/dispatch/<组名>/task-1.md'
tmux new-window -t dispatch -n task2 'pi --name "<组名>-task2" @.pi/dispatch/<组名>/brief.md @.pi/dispatch/<组名>/task-2.md'
```

然后告知用户：`tmux attach -t dispatch` 进入管理（VSCode 集成终端内 attach 亦可）。

### 路线 B：无 tmux 且在 VSCode（`$TERM_PROGRAM` = `vscode`）→ 扩展一键分发

优先使用 parallel-dispatch VSCode 扩展（已安装：`code --list-extensions` 含 `duanyanlong.parallel-dispatch`）。

1. 写 `dispatch.json` 到 `<项目根>/.pi/dispatch/<组名>/`（需扩展 ≥0.2.0；submodule/monorepo 场景下项目根在工作区子目录也能被自动发现）：

   ```json
   {
   	"cwd": "<项目根绝对路径>",
   	"tasks": [
   		{ "label": "task1", "command": "pi --name \"<组名>-task1\" @.pi/dispatch/<组名>/brief.md @.pi/dispatch/<组名>/task-1.md" },
   		{ "label": "task2", "command": "pi --name \"<组名>-task2\" @.pi/dispatch/<组名>/brief.md @.pi/dispatch/<组名>/task-2.md" }
   	]
   }
   ```

2. 执行 `code --open-url "vscode://duanyanlong.parallel-dispatch/launch/<组名>"`

   扩展注册了 URI handler（处理 `/launch/<组名>` 路径），触发后自动定位 `.pi/dispatch/<组名>/dispatch.json`，为每个 task 开一个终端 tab 并自动执行命令，无需用户操作。

   ⚠️ 不要用 `code --command parallel-dispatch.launch`——VSCode CLI 没有 `--command` 选项，参数被静默丢弃（仅 Warning），分发不会发生。

   **执行后必须验证分发结果**：`ps aux | grep '[p]iw --name'` 应看到每个 task 的进程（实际进程名是 `piw` 而非 `pi`），或运行 `~/.pi/agent/skills/parallel-dispatch/scripts/child-status.sh <组名>` 确认子 session 已创建（session 文件启动即落盘；刚启动查不到就等几秒重试）。失败时：
   - 无 `piw --name` 进程且无新 session → 扩展可能刚升级尚未 reload，提示用户 `Cmd+Shift+P → Reload Window` 后重试；或 URI 路由到了其他 VSCode 窗口（错误通知只显示在那个窗口，agent 端看不到，需请用户查看）
   - 用户看到“读取失败 .../dispatch.json”或“没有打开的工作区” → URI 路由到了其他 VSCode 窗口，提示用户切到/聚焦项目窗口后重试
   - 用户看到“未找到 .pi/dispatch/<组名>/dispatch.json”但文件确实存在 → 扩展版本 <0.2.0（只认工作区根旧路径），按扩展仓库 README 升级后重试
   - 重试仍失败 → 报告具体错误并停下等用户决定，**不要静默改用 subagent 或其他执行方式**。除非用户明确说“改用 subagent”或“直接做”，否则不得切换执行模式。

**扩展不可用时**（未安装或命令失败），降级为 tasks.json 方案：写 `.vscode/tasks.json` 到项目根目录（**若已存在，读取并合并 dispatch 条目，绝不覆盖用户已有任务**）：

```json
{
	"version": "2.0.0",
	"tasks": [
		{
			"label": "task1",
			"type": "shell",
			"command": "pi --name \"<组名>-task1\" @.pi/dispatch/<组名>/brief.md @.pi/dispatch/<组名>/task-1.md",
			"presentation": { "panel": "new", "reveal": "always", "focus": true, "close": false },
			"isBackground": true,
			"options": { "cwd": "<项目根绝对路径>" }
		},
		{
			"label": "task2",
			"type": "shell",
			"command": "pi --name \"<组名>-task2\" @.pi/dispatch/<组名>/brief.md @.pi/dispatch/<组名>/task-2.md",
			"presentation": { "panel": "new", "reveal": "always", "focus": true, "close": false },
			"isBackground": true,
			"options": { "cwd": "<项目根绝对路径>" }
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

输出命令清单供用户逐个开终端执行（项目根目录下）：

```bash
pi --name "<组名>-task1" @.pi/dispatch/<组名>/brief.md @.pi/dispatch/<组名>/task-1.md
pi --name "<组名>-task2" @.pi/dispatch/<组名>/brief.md @.pi/dispatch/<组名>/task-2.md
```

### 分发后的提示

- parent 会话恢复：新开一个终端 tab，`pi --session <父ID>`（规划用的原 TUI 若还开着，先提醒用户 `/exit`，pi 无 session 文件锁，双开同一 session 会写乱树结构）
- 分发完成后 `.vscode/tasks.json` 的 dispatch 条目可删除或留存复用

## 阶段 2：子 session 启动

首条指令即简报，随启动自动注入（`@file` 初始消息机制），用户无需手动发。子 session 的身份、任务、文件范围、决策停顿、回写义务都由简报三要素承载：

1. **限定文件范围**：只执行 task-<N>.md 指定任务，不碰其他任务的文件
2. **决策点停顿**：关键方案确定后先停下向用户说明，确认后再动手
3. **回写义务**：完成后 (1) 在 `.pi/dispatch/<组名>/PLAN.md` 勾选该任务并在"结论"区追加：做了什么、关键决策及理由、遗留问题；(2) 只 git add 自己改动的文件并 commit，message 用 "<task-id>: " 前缀

子 session 跑偏或遗忘规则时，用户可在该子 session 内用 `/dispatch <task-id>` 模板重申。

## 阶段 3：子 session 执行中的规则

- 遇到方案分歧即停，等用户判断
- git 操作：只 add 自己文件范围里的改动，绝不 `git add -A` / `git add .`
- 跑偏时用户可用 `/tree` 回退该子 session 到更早分叉点重来，不影响其他子

## 阶段 4：监控（兜底）

子 session 忘记回写 PLAN.md 时，无需其配合，直接反查：

```bash
~/.pi/agent/skills/parallel-dispatch/scripts/child-status.sh <组名>
```

列出当前项目下所有 `<组名>-task<N>` 子 session 及各自最新 assistant 消息。

## 阶段 5：汇总（父 session）

全部子 session 完成后，用户回到 parent 终端发汇总指令（或用 `/aggregate` 模板展开）：

> 读 `.pi/dispatch/<组名>/PLAN.md` 和 git log，逐任务核对结论与实际提交是否一致，运行集成检查，报告差异和遗留问题，然后规划下一步。

汇总时注意：

- PLAN.md 结论与 git log 不一致的任务，用 child-status.sh 反查该子 session 对话核实
- 汇总完成后建议父 session `/compact` 压掉规划期的探索细节，轻装进入下一轮

## 清理

- `.pi/dispatch/<组名>/` 整组目录（PLAN.md、简报、dispatch.json）确认后删除；多组并存时按组清理，`.pi/dispatch/` 清空后可连目录一并删除
- 完成的子 session 在 `/resume` 里 Ctrl+D 删除（走 trash，可恢复）
- tmux 会话：`tmux kill-session -t dispatch`；tasks.json dispatch 条目按需删除
