# pi-pacer

pi 会话配速员:盯着一个 pi session 持续自我改进。

## pi-pacer.sh

通用 pi 会话配速员(pacer):像马拉松配速员盯着一个 pi session,巡检自身零模型调用,会话停滞才出手续命,让 agent 以稳定节奏持续自我改进。判定逻辑(与 pi-dashboard 同源):会话 jsonl mtime 持续更新 → 只记心跳;停滞 ≥ 阈值(默认 300s)且宿主 TUI 存活 → 判异常停止,杀宿主进程(可 `--no-kill-host`)后发维持消息;停滞且无宿主 → 判已终止,首轮调 pi-pacer-revive.mjs 做 RPC 恢复,后续轮只发维持消息(默认「继续。」)。网络韧性:出手前探活 provider(HTTP 状态码 ≠000 即可达),连续失败 ≥3 轮指数退避(5→30min 封顶)并发 macOS 通知(每 30min 最多一条),成功即清零。

- 用法:`pi-pacer.sh start <session-file> [--hours N|--until "YYYY-MM-DD HH:MM"] [--stale N] [--provider X] [--model Y] [--revive-msg "..."] [--keep-msg "..."] [--no-confirm] [--no-kill-host] [--no-probe] [--probe-url URL]`(默认值班 8h)
- `stop <session-file>` 停止配速(不打断 agent 当前轮)
- `list` 看板;`log <session-file>` 尾随领跑日志
- 状态目录:`~/.pi/agent/pacer/`

## pi-pacer-revive.mjs

pi-pacer.sh 的「手」,也可单独使用:对已终止会话在单条 RPC 连接内完成 compact → 发复活消息(等 agent_settled)→ 发确认消息三步,复活消息默认引导 agent 读 AGENTS.md/任务书、结合 git log 自选下一个优化点小步迭代并逐项提交。

- 用法:`node pi-pacer-revive.mjs <session-file> [--no-confirm]`
- 行为由环境变量参数化:PROJECT_DIR、TIMEOUT_SEC(默认 14400=4h)、PI_BIN、PI_PROVIDER、PI_MODEL、REVIVE_MSG、CONFIRM_MSG
- 协议参考 `packages/coding-agent/docs/rpc.md`
