# pi-usage-reflection

定时 pi 使用反思。

## pi-usage-reflection-daily.sh

定时 pi 使用反思：每天 10:00 由 LaunchAgent `~/Library/LaunchAgents/com.zeromorse.pi-usage-reflection.plist` 触发，`cd` 中性目录 `~/.pi-usage-reflection/` 后 `pi -p` 调用本仓库 `.pi/skills/pi-usage-reflection/` skill（幂等软链到 `~/.pi/agent/skills/` 使中性目录可发现；空目录无 `.pi/` 资源不触发项目信任弹窗），只复盘近 1 天与近 7 天两个窗口（跳过 skill 默认的 30 天）。

- 报告:`~/.pi-usage-reflection/reports/pi-usage-reflection-YYYYMMDD.md`
- 运行日志:`~/.pi-usage-reflection/logs/`（pi stderr）与 `~/Library/Logs/pi-usage-reflection.log`（launchd）
- `/tmp` 下 mkdir 锁防手动 kickstart 与定时运行重叠，完成后经 pi-notify 发通知（openPath 指向当日报告/运行日志，点击通知直接打开）
- 手动触发:`launchctl kickstart gui/$(id -u)/com.zeromorse.pi-usage-reflection`
