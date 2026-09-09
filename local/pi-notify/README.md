# pi-notify

自建 macOS 通知小工具(Swift,UNUserNotification,零依赖)。

## 命令

- `send <title> <body> [activateBundleId] [identifier] [openPath] [sound]` — 发通知后退出;同 identifier 新通知替换旧通知不堆积
- `status` — 查看通知权限

点击通知时按优先级执行:openPath(第 6 参)非空则用系统默认应用打开该文件/URL,否则激活 activateBundleId 对应 app,都不传则无动作(用于跳回 pi 所在终端或直接打开产物文件)。sound(第 7 参)为系统提示音名(如 Glass/Sosumi/Basso)。

## 构建

源码 `main.swift` + `Info.plist` + `build.sh`(构建到 `build/pi-notify.app`,ad-hoc 签名)。注意:重新编译后 ad-hoc 重签可能重置通知权限,通知不弹时到系统设置重新允许 "pi"。

## 消费方

- `~/.pi/agent/extensions/agent-done-notify.ts`(pi 运行结束触达,优先查本目录,`~/.pi/agent/pi-notify/` 为备用路径)
- `pi-sync/pi-sync-rebuild.sh`(定时同步失败/成功通知)
- `pi-usage-reflection/pi-usage-reflection-daily.sh`(每日反思报告通知,点击打开报告/运行日志)
- catpaw 侧的 `~/catpaw-desk-workspace/task/scripts/cron_ccmp_cost.sh`(成本巡检通知,点击打开当日报告/运行日志,取代了原 CCMP-Report.app applet)
