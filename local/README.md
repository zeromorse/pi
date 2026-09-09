# local/

个人工具脚本,与 pi 仓库的构建/发布无关,不参与 CI 与 npm scripts。

结构:一个组件一个文件夹;脚本内跨组件引用按 `$SCRIPT_DIR/../<组件>` 定位;组件详情见各自目录内的 README。

| 组件 | 说明 | 文档 |
|---|---|---|
| `caffeinebar/` | macOS 菜单栏防休眠开关(原生 Swift) | [README.md](caffeinebar/README.md) |
| `parallel-dispatch/` | 并行分发工作流 skill(tmux/VSCode/清单三路线) | [SKILL.md](parallel-dispatch/SKILL.md) |
| `parallel-dispatch-vscode/` | 并行分发 VSCode 扩展(一键分发子 session) | [README.md](parallel-dispatch-vscode/README.md) |
| `pi-dashboard/` | 多 pi 进程全局看板 + pid 注册表扩展 | [README.md](pi-dashboard/README.md) |
| `pi-notify/` | macOS 通知小工具(Swift,UNUserNotification) | [README.md](pi-notify/README.md) |
| `pi-pacer/` | pi 会话配速员(停滞检测 + RPC 复活) | [README.md](pi-pacer/README.md) |
| `pi-sync/` | 定时 fork 同步 + 条件重建 | [README.md](pi-sync/README.md) |
| `pi-usage-reflection/` | 定时 pi 使用反思 | [README.md](pi-usage-reflection/README.md) |
| `piw/` | pi 重启循环 wrapper(让 `/restart` 在 tmux 外可用) | [README.md](piw/README.md) |
| `sp/` | 保存并推送:stage + pi 生成 commit message + push | [README.md](sp/README.md) |
| `timerbar/` | macOS 菜单栏倒计时器(默认 5 分钟,到点 pi-notify 通知) | [README.md](timerbar/README.md) |
