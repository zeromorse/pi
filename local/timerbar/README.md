# timerbar

macOS 菜单栏倒计时器(原生 Swift,零依赖)。

状态栏只放图标:`⌛️`(未开始/已暂停) / `⏳`(运行中,每 5 秒缓慢淡出淡入一次) / `✅`(结束闪 5 秒);剩余时间不上状态栏,展示在点开菜单的状态行与悬停 tooltip 中(菜单打开期间实时跳动)。

- 时长默认 5 分钟,菜单选预设(1/5/10/15/25/30/45/60 分钟)或自定义(0.1–600 分钟),选择后立即开始
- 时长持久化(UserDefaults),重启保留
- 时间到调用 [pi-notify](../pi-notify/) 发系统通知(Glass 提示音,identifier 固定 `timerbar`,重复到点不堆积);pi-notify 不可用时回退 osascript
- 计时用绝对结束时刻,菜单打开期间不停摆

## 构建

`./build.sh`(产物 `~/Applications/TimerBar.app`,ad-hoc 签名;仓库只留源码,产物是本机构建输出)

## 使用

- 常驻:菜单栏点开可开始/暂停/继续/重置、选时长、退出
- 命令行启动即倒计时:`~/Applications/TimerBar.app/Contents/MacOS/TimerBar --start <秒>`(时长仅本次生效,不落盘)

## 登录自启

`~/Library/LaunchAgents/com.zeromorse.timerbar.plist`:

```bash
cat > ~/Library/LaunchAgents/com.zeromorse.timerbar.plist <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>com.zeromorse.timerbar</string>
	<key>ProgramArguments</key>
	<array>
		<string>/Users/duanyanlong/Applications/TimerBar.app/Contents/MacOS/TimerBar</string>
	</array>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<dict>
		<key>SuccessfulExit</key>
		<false/>
	</dict>
	<key>StandardOutPath</key>
	<string>/Users/duanyanlong/Library/Logs/timerbar.log</string>
	<key>StandardErrorPath</key>
	<string>/Users/duanyanlong/Library/Logs/timerbar.log</string>
</dict>
</plist>
EOF
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.zeromorse.timerbar.plist
```

卸载自启:`launchctl bootout gui/$(id -u)/com.zeromorse.timerbar && rm ~/Library/LaunchAgents/com.zeromorse.timerbar.plist`

KeepAlive 用条件式 `SuccessfulExit = false`:崩溃/被杀时 launchd 自动拉起;菜单点"退出"(正常退出,exit 0)不会被拉起,可正常退出。产物在 `~/Applications`,Spotlight/Launchpad 天然可搜到。

## 修改源码后重新编译

`cd local/timerbar && ./build.sh && pkill -x TimerBar`
