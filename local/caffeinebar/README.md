# caffeinebar

macOS 菜单栏防休眠开关(原生 Swift,零依赖)。

状态栏 ☕️/🔋/💤 图标,点击切换;拔电源自动暂停、插回自动恢复,开关状态持久化。作用:接电源时合盖保持 DarkWake,使 cron/launchd 无人值守任务(如 frontier-radar 每日采集)不因休眠中断。

- 登录自启:LaunchAgent `~/Library/LaunchAgents/com.user.caffeinebar.plist`(指向本目录的 .app)
- 修改源码后重新编译:`cd local/caffeinebar && swiftc -O -o CaffeineBar main.swift && cp CaffeineBar CaffeineBar.app/Contents/MacOS/ && pkill -x CaffeineBar`(KeepAlive 会自动拉起新二进制)
