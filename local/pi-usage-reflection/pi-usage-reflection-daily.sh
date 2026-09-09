#!/usr/bin/env bash
# pi-usage-reflection-daily.sh - scheduled pi usage reflection report.
#
# Invokes the pi-usage-reflection skill (this repo's
# .pi/skills/pi-usage-reflection/) via `pi -p`, restricted to 1-day and
# 7-day windows (the skill's default 30-day window is skipped). The skill
# is exposed as a user-level skill via symlink
# ~/.pi/agent/skills/pi-usage-reflection (created idempotently below) so it
# resolves from the neutral cwd; the neutral cwd also avoids project trust
# prompts (an empty dir has no trust-requiring project resources).
#
# Output: ~/.pi-usage-reflection/reports/pi-usage-reflection-YYYYMMDD.md
# Run log: ~/.pi-usage-reflection/logs/YYYYMMDD.log (pi -p stderr)
# Notify: pi-notify send with openPath — clicking the notification opens
# the day's report (success) or the run log (failure) in its default app
# Scheduled daily at 10:00 by
# ~/Library/LaunchAgents/com.zeromorse.pi-usage-reflection.plist.
# launchd log: ~/Library/Logs/pi-usage-reflection.log

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$SCRIPT_DIR/../.." && pwd)"
SKILL_SRC="$REPO/.pi/skills/pi-usage-reflection"
SKILL_LINK="$HOME/.pi/agent/skills/pi-usage-reflection"
PI_BIN="$HOME/.local/bin/pi"
# pi-notify: send <title> <body> <activateBundleId> <identifier> <openPath>
# 点击通知时打开 openPath 指向的文件（成功=当日报告,失败=运行日志）
PI_NOTIFY="$SCRIPT_DIR/../pi-notify/build/pi-notify.app/Contents/MacOS/pi-notify"

REPORT_DIR="$HOME/.pi-usage-reflection/reports"
LOG_DIR="$HOME/.pi-usage-reflection/logs"
mkdir -p "$REPORT_DIR" "$LOG_DIR" "$HOME/.pi-usage-reflection"
DATE=$(date +%Y%m%d)
REPORT="$REPORT_DIR/pi-usage-reflection-$DATE.md"
RUN_LOG="$LOG_DIR/$DATE.log"

# launchd PATH is minimal; python3 (/usr/bin) and homebrew tools for the
# skill's analyze scripts. ~/.local/bin/pi is self-contained (absolute node).
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

log() { printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }

notify() {
    # title body openPath; osascript fallback when pi-notify is missing
    if [ -x "$PI_NOTIFY" ]; then
        # same identifier replaces previous notifications instead of piling up
        "$PI_NOTIFY" send "$1" "$2" "" "pi-usage-reflection" "$3" >/dev/null 2>&1 || true
    else
        osascript -e "display notification \"$2\" with title \"$1\"" \
            >/dev/null 2>&1 || true
    fi
}

# ---- expose the skill user-level so pi finds it from the neutral cwd ----
if [ -e "$SKILL_LINK" ] && [ ! -L "$SKILL_LINK" ]; then
    log "ERROR: $SKILL_LINK exists and is not a symlink, refusing to overwrite"
    exit 1
fi
mkdir -p "$HOME/.pi/agent/skills"
ln -sfn "$SKILL_SRC" "$SKILL_LINK"

# ---- guard against overlapping runs (manual kickstart while scheduled) ----
LOCK_DIR="/tmp/pi-usage-reflection.lock"
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
    log "another instance is running, skip"
    exit 0
fi
trap 'rmdir "$LOCK_DIR" 2>/dev/null' EXIT

# ---- neutral cwd: no repo trust prompts, no project skill shadowing ----
cd "$HOME/.pi-usage-reflection" || exit 1

# ---- generate report ----
log "start: windows=1d,7d report=$REPORT"

"$PI_BIN" -p "使用 pi-usage-reflection skill 复盘我的 pi 使用习惯：只分析近 1 天和近 7 天两个时间窗口（不要分析 30 天），两个窗口都完整执行 skill 的采集统计、项目上下文检查与深挖步骤。按 skill 中定义的报告格式输出完整反思报告（含总览、最佳实践对照、好习惯、不足、改进行动清单）。" \
    > "$REPORT" \
    2> "$RUN_LOG"
EXIT=$?

if [[ $EXIT -eq 0 && -s "$REPORT" ]]; then
    log "exit=0 report=$REPORT"
    notify "pi 使用反思完成 $(date +%m-%d)" "今日报告已生成（近 1 天 + 近 7 天），点击查看" "$REPORT"
else
    log "exit=$EXIT report generation failed; run log: $RUN_LOG"
    notify "pi 使用反思失败 $(date +%m-%d)" "exit=$EXIT，报告未生成；点击查看运行日志" "$RUN_LOG"
fi
