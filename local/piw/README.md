# piw

pi 重启循环 wrapper。

## piw

pi 重启循环 wrapper:让 `/restart` 扩展命令(`~/.pi/agent/extensions/restart.ts`)在 tmux 之外也能自重启。pi 是前台 TUI,进程退出后父 shell 会立刻回收终端,后台子进程无法干净抢回前台(作业控制竞争),所以 `/restart` 在非 tmux 环境下写标记文件(`~/.pi/agent/restart-pending`,每行一个重启参数)后优雅退出,由本 wrapper 读标记并以 `pi --session <file>` 恢复相同会话。典型用途:`npm run build` 后重启全局 `pi` 让新代码生效且不丢会话。在 tmux 里 `/restart` 直接走 `tmux respawn-pane -k`,不经过本 wrapper。

- 安装:`~/.local/bin/piw` 软链指向本文件。
- 用法:`piw [pi 参数...]`(首次参数原样传给 pi,重启参数来自 `/restart`)。
- 环境变量:`PI_BIN`(默认 PATH 中的 pi)、`PI_RESTART_MARKER`(默认 `~/.pi/agent/restart-pending.<wrapper-pid>`,带 PID 隔离多实例,由 wrapper 经同名环境变量传给扩展)。
- 注意:重启后不保留原命令行参数(如 `-n`),会话名/模型等状态由 session 文件恢复。
