# local/

个人工具脚本,与 pi 仓库的构建/发布无关,不参与 CI 与 npm scripts。

- `pi-dashboard.mjs` — 多 pi 进程全局看板(扫描 `~/.pi/agent/sessions` 会话文件,监控各进程运行/等待状态)。用法:`node local/pi-dashboard.mjs [-w] [--all]`。
