---
name: pi-usage-reflection
description: 反思用户对 pi 的使用习惯。扫描近 1/7/30 天的 pi 会话日志（~/.pi/agent/sessions/），按业界最佳实践对照框架（Anthropic agentic coding best practices 及社区共识）评估：项目分布、会话深度、指令质量、探索-计划-编码工作流、git 检查点、验证闭环、危险操作、模型分级、重复工作沉淀，输出"好习惯 + 不足 + 改进建议"的反思报告。当用户说"反思我的 pi 使用"、"复盘 pi 用法"、"分析我最近的会话"、"我 pi 用得怎么样"、"使用习惯分析"时使用。
---

# pi 使用反思

分析用户过去的 pi 会话，按业界最佳实践对照，产出基于证据的使用习惯反思报告。所有结论必须引用具体数据（会话数、prompt 原文、指标），禁止空泛套话。

## 数据源

pi 会话日志：`~/.pi/agent/sessions/<cwd-编码目录>/<时间戳>_<id>.jsonl`

每行一个 JSON 事件（`type` 字段区分）：
- `session`：首行，含 `timestamp`、`cwd`
- `message`：`message.role` = `user`/`assistant`，content 数组内 `type` = `text`/`thinking`/`toolCall`
- `model_change` / `thinking_level_change`：模型与思考级别切换

## 业界最佳实践对照框架

反思的判断基准来自业界公认实践，主要参考：Anthropic 官方《Claude Code: Best practices for agentic coding》与《Effective context engineering for AI agents》、各 agent 工具（Codex/Cursor）官方指南的共识。注：本清单为静态整理，若环境可联网，先检索最新版本再执行。

| # | 实践 | 日志可检测方式 |
|---|------|--------------|
| 1 | 维护项目上下文文件（AGENTS.md/CLAUDE.md），随项目演进更新 | 活跃项目根目录是否存在该文件 + git 最近修改时间 |
| 2 | 指令具体化：给路径、约束、验收标准，而非模糊描述 | 首条 prompt 是否含路径/URL/明确产出物；纠偏率 |
| 3 | 探索→计划→编码→提交：先让 agent 读代码出方案，确认后再写 | 深挖会话看前几轮是否有"方案确认"轮次 |
| 4 | 小步提交：commit early/often，diff 保持可审查 | `git_commits` vs `edit_calls` 比例 |
| 5 | 验证闭环：agent 自己跑测试/lint/typecheck，不靠肉眼审查 | `verification_runs` vs `edit_calls` |
| 6 | 重复工作沉淀为 skill / prompt 模板，而非重复提问 | skill 加载事件；跨会话重复首条 prompt |
| 7 | 任务模式匹配：一次性任务用 headless（`pi -p`），不开交互会话 | 单轮会话占比及其 prompt 性质 |
| 8 | 上下文管理：长会话及时压缩/收尾；相似工作复用会话 | 超长会话数；跨会话重复提问 |
| 9 | 危险操作有意识：rm -rf / reset --hard / force push 值得审视 | `dangerous_cmds`（区分 /tmp 清理与工作区操作；--force-with-lease 是安全变体） |
| 10 | 模型与思考分级：重任务强模型+high，轻任务 flash 省 token | 模型/thinking 分布与任务复杂度的匹配 |

## 步骤

### 1. 采集统计

对用户要求的时间窗口分别跑（默认 1、7、30 天三个都跑，除非用户指定）：

```bash
python3 <skill-dir>/scripts/analyze.py 1
python3 <skill-dir>/scripts/analyze.py 7
python3 <skill-dir>/scripts/analyze.py 30
```

脚本自动排除 pi 自身的 faux 测试会话。输出含：按项目分组的会话数/轮次/工具调用/活跃时长/模型/thinking 级别/git 提交数/验证命令数/危险命令/首条 prompt 样本/纠偏信号数，以及按天分布和总量日均值（`daily_avg`，分母为窗口天数，无会话的日期也计入）。

### 2. 检查项目上下文文件

对活跃度前 3 的项目，检查上下文文件是否存在与新鲜度：

```bash
ls -la <项目>/AGENTS.md <项目>/CLAUDE.md 2>/dev/null
cd <项目> && git log -1 --format=%ci -- AGENTS.md CLAUDE.md 2>/dev/null
```

存在且近期更新 = 实践 #1 达标；不存在 = 首条指令需要重复交代背景的根因之一。

### 3. 定位值得深挖的会话

```bash
python3 <skill-dir>/scripts/list.py <days> --limit 15          # 按工具调用排序
python3 <skill-dir>/scripts/list.py <days> --cwd <项目路径片段>  # 过滤项目
```

挑选深挖对象（各选 1-3 个）：
- 工具调用最多的会话（长任务）
- `correction_signals` 高的项目里的会话（频繁返工）
- 重复出现相同首条 prompt 的会话组
- `dangerous_cmds` 命中的会话（确认是否有用户投意）

### 4. 深挖会话内容

提取某个会话的全部用户指令，看指令质量：

```bash
python3 -c "
import json, sys
for line in open('<会话文件路径>'):
    obj = json.loads(line)
    if obj.get('type') == 'message' and obj['message'].get('role') == 'user':
        for c in obj['message'].get('content', []):
            if c.get('type') == 'text':
                print('USER:', c['text'][:300].replace(chr(10), ' '))
"
```

关注：指令是否给了足够上下文（实践 #2）？前几轮是否先出方案再动手（实践 #3）？纠偏消息具体是什么（描述不清？方向错？模型能力不足）？

### 5. 输出反思报告

按最佳实践对照框架逐项评估，输出报告。

## 报告格式

```markdown
# pi 使用反思报告

## 总览
- 时间窗口：近 1 / 7 / 30 天（关键数字对比）
- 会话数、活跃时长、项目分布（前 3）
- 多天窗口（近 7 / 30 天）除总量外，必须给出核心指标的日均值：日均会话数、日均用户消息数、日均工具调用数、日均活跃时长（总量 ÷ 窗口天数；从 `analyze.py` 的 `daily_avg` 取数）

## 最佳实践对照

| 实践 | 状态 | 证据 |
|------|------|------|
| （逐项列框架里的 10 条，状态用 达标/部分/缺失/不适用） |

## 好习惯
（每条：结论 + 数据证据 + 引用具体 prompt）

## 不足
（每条：结论 + 数据证据 + 具体改进建议，可执行）

## 改进行动清单
- [ ] 具体可执行的下一步（如"把 X 沉淀成 skill"、"告警类任务用 -p 模式"）
```

## 边界

- 只读分析，不修改任何会话文件。
- 报告里引用 prompt 时注意脱敏（内部系统名、URL 可保留，密钥/token 一律不引用）。
- 时间窗口内无会话时如实说明，不编造。
- 启发式信号不是定罪证据：发现信号后必须深挖原始 prompt 验证，再下结论（如 reset --hard 可能是用户投意的回退）。
