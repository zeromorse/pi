# pi-sync

定时 fork 同步 + 条件重建。

## pi-sync-rebuild.sh

定时 fork 同步+重建:自动化 `.pi/skills/pi-fork-sync.md` 与 `.pi/skills/pi-rebuild-global.md` 两个 skill 的全流程(fetch upstream → main ff → push fork → merge 进 my-main → my-main 有新提交则用 Node 22 重新 `npm run build` 并验证 `pi --version`)。CHANGELOG 合并冲突由 `pi-sync-merge-changelog.py` 按规则自动解决(upstream 版本段原样 + fork 条目回插 `[Unreleased]`);代码冲突则 `git merge --abort` 并发 macOS 通知人工处理;working tree 脏/网络失败安全跳过,push 失败下次重试。

- 日志:`~/Library/Logs/pi-sync.log`
- 调度:LaunchAgent `~/Library/LaunchAgents/com.zeromorse.pi-sync.plist`(每天 10:00,睡眠错过唤醒后补跑)
- 手动触发:`launchctl kickstart gui/$(id -u)/com.zeromorse.pi-sync`

## pi-sync-merge-changelog.py

上面脚本配套的 CHANGELOG 冲突解决工具,也可单独使用:`python3 pi-sync-merge-changelog.py OURS THEIRS OUT`,入参为冲突双方(`git show :2:<path>` / `:3:<path>`)与输出路径;fork 侧 `[Unreleased]` 为空时输出与 upstream 侧完全一致,任一侧缺 `## [Unreleased]` 标题则退出码 1。失败/成功通知用 `pi-notify`(osascript 兜底)。
