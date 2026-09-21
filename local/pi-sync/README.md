# pi-sync

定时 fork 同步 + 条件重建。

## pi-sync-rebuild.sh

定时 fork 同步+重建:自动化 `.pi/skills/pi-fork-sync.md` 与 `.pi/skills/pi-rebuild-global.md` 两个 skill 的全流程(fetch upstream → main ff → push fork → merge 进 my-main → my-main 有新提交或上次构建落后则用 Node 22 重新 `npm run build` 并验证 `pi --version`)。合并冲突分级处理:CHANGELOG 冲突由 `pi-sync-merge-changelog.py` 按规则自动解决(upstream 版本段原样 + fork 条目回插 `[Unreleased]`);rerere 已自动应用解法的文件直接采纳;剩余代码冲突交给 `pi-sync-ai-resolve.sh` 用 headless pi 解决并以 `npm run check` + `./test.sh` 为验收闭环,失败才 `git merge --abort` 并发 macOS 通知(含完整冲突文件清单)人工处理;working tree 脏/网络失败安全跳过,push 失败下次重试。

构建状态记录在 `~/Library/Application Support/com.zeromorse.pi-sync/last-built`(最后一次成功 rebuild 的 my-main commit):手动解冲突后 my-main 领先于已构建版本时,脚本会补跑 rebuild 而不是误判"无事可做";build 失败不写状态,次日重试。

- 日志:`~/Library/Logs/pi-sync.log`(AI 解决过程与验证输出全量留存;完整工具调用轨迹在 pi session 文件里)
- 调度:LaunchAgent `~/Library/LaunchAgents/com.zeromorse.pi-sync.plist`(每天 10:00,睡眠错过唤醒后补跑)
- 手动触发:`launchctl kickstart gui/$(id -u)/com.zeromorse.pi-sync`
- 逃生门:`PI_SYNC_NO_AI=1` 跳过 AI 解决直接人工;`PI_SYNC_AI_MODEL`/`PI_SYNC_AI_TIMEOUT` 可覆盖模型与超时(默认 1800s)

## pi-sync-ai-resolve.sh

在 merge 冲突中间态由主脚本调用,也可单独使用(在冲突状态下直接执行)。spawn `pi -p` 解决非 CHANGELOG 代码冲突,然后验证:无 unmerged 路径、冲突文件无残留标记、HEAD 未移动(AI 禁止 commit)、`npm run check` 与 `./test.sh` 全过。验证全过 exit 0(文件已 staged,由调用方 commit);任一失败 exit 1(由调用方 abort)。验收只认脚本自查结果,不认 AI 自述。

## pi-sync-merge-changelog.py

上面脚本配套的 CHANGELOG 冲突解决工具,也可单独使用:`python3 pi-sync-merge-changelog.py OURS THEIRS OUT`,入参为冲突双方(`git show :2:<path>` / `:3:<path>`)与输出路径;fork 侧 `[Unreleased]` 为空时输出与 upstream 侧完全一致,任一侧缺 `## [Unreleased]` 标题则退出码 1。失败/成功通知用 `pi-notify`(osascript 兜底)。
