# caffeinebar

macOS 菜单栏防休眠开关(原生 Swift,零依赖)。

状态栏 ☕️/🔋/💤 图标,点击切换;拔电源自动暂停、插回自动恢复,开关状态持久化。作用:接电源时合盖保持 DarkWake,使 cron/launchd 无人值守任务(如 frontier-radar 每日采集)不因休眠中断。

## 构建

`./build.sh`(产物 `~/Applications/CaffeineBar.app`,ad-hoc 签名;仓库只留源码,产物是本机构建输出)

## 安装(登录自启)

`~/Library/LaunchAgents/com.zeromorse.caffeinebar.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>com.zeromorse.caffeinebar</string>
	<key>ProgramArguments</key>
	<array>
		<string>/Users/duanyanlong/Applications/CaffeineBar.app/Contents/MacOS/CaffeineBar</string>
	</array>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<dict>
		<key>SuccessfulExit</key>
		<false/>
	</dict>
	<key>ProcessType</key>
	<string>Background</string>
	<key>StandardOutPath</key>
	<string>/Users/duanyanlong/Library/Logs/caffeinebar.log</string>
	<key>StandardErrorPath</key>
	<string>/Users/duanyanlong/Library/Logs/caffeinebar.log</string>
</dict>
</plist>
```

`launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.zeromorse.caffeinebar.plist`

卸载:`launchctl bootout gui/$(id -u)/com.zeromorse.caffeinebar && rm ~/Library/LaunchAgents/com.zeromorse.caffeinebar.plist`

## 行为说明

- KeepAlive 条件式 `SuccessfulExit = false`:崩溃/被杀时 launchd 自动拉起;菜单点"退出"(正常退出,exit 0)不会被拉起,可正常退出
- 产物在 `~/Applications`,Spotlight/Launchpad 天然可搜到
- 修改源码后重新编译:`./build.sh && pkill -x CaffeineBar`(pkill 属异常退出,KeepAlive 会自动拉起新二进制)
