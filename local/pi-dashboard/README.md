# pi-dashboard

多 pi 进程全局看板 + 进程↔会话注册表扩展。

## pi-dashboard.mjs

多 pi 进程全局看板(扫描 `~/.pi/agent/sessions` 会话文件,监控各进程运行/等待状态)。进程↔会话配对:第 0 轮读 `~/.pi/agent/runtime/<pid>.json` 注册表精确配对(见 `pid-registry.ts`),注册缺失回退 mtime/创建时间启发式。用法:`node local/pi-dashboard/pi-dashboard.mjs [-w] [--all]`。

定时任务视图(watch 按 `c` / `--cron`):自动发现 pi 相关的 launchd LaunchAgent 与 crontab 条目(判定:命令行含独立 pi 词,或命令行中任一 .sh 脚本的内容调 pi,覆盖 `/bin/zsh xxx.sh arg` 包装形态),展示调度/上次运行/上次结果(launchd 用 `launchctl list` 退出码 + 日志交叉验证——exit 0 但日志无记录视为"未运行过"而非 ok,cron 解析日志尾部最后时间戳窗口的 `ERROR`/`exit=[1-9]`);`r` 二次确认后 `launchctl kickstart` 立即执行 launchd 任务,`Enter` 看日志尾部;单次模式末尾自动追加摘要。命令行无重定向或共享日志的任务(如 ccmp 巡检、frontier-radar 的 cron.log)需在脚本内 `CRON_EVIDENCE` 里声明证据日志(可带 `filter` 子串按任务过滤行;launchd 与 cron 来源通用,frontier-radar 从 cron 迁到 launchd 后依旧生效),结果 60s 缓存。

## pid-registry.ts

pi 扩展(软链到 `~/.pi/agent/extensions/pid-registry.ts`,与 pi-dashboard 同目录):每次 session_start(startup/new/resume/fork/import)原子写 `~/.pi/agent/runtime/<pid>.json` = `{pid,file,ts}`,进程退出时自删。供 pi-dashboard 第 0 轮精确配对进程↔会话文件,解决启发式错配:进程 resume 后长期零写入时 mtime 停在旧值,而已退出进程留下的死会话可能因重命名(session_info 写入,如任务打勾 `[x]`)mtime 很新,纯 mtime 启发式会把死会话"顶活"、活会话丢失。SIGKILL/崩溃残留的注册文件由 dashboard 按进程存活兜底清理(含 pid 复用防御:注册 ts 早于进程启动时间则视为陈旧)。
