#!/usr/bin/env bash
# pi-sync-rebuild.sh - scheduled pi fork sync + conditional rebuild.
#
# Automates two skills from this repo's .pi/skills/:
# - pi-fork-sync: sync zeromorse/pi fork with upstream earendil-works/pi,
#   fast-forward main, mirror it to fork/main, merge main into my-main,
#   push both branches. CHANGELOG conflicts are auto-resolved by
#   pi-sync-merge-changelog.py (upstream verbatim + fork entries back under
#   [Unreleased]); rerere-applied resolutions are accepted; remaining code
#   conflicts are delegated to pi-sync-ai-resolve.sh (headless pi + check +
#   tests verification), and only fall back to abort + notify on failure.
# - pi-rebuild-global: when my-main advanced or the last build is stale,
#   refresh node_modules from the merged lockfile (upstream dep bumps leave
#   it stale) and rebuild dist/ with Node 22 so the globally linked `pi`
#   command picks up the changes.
#
# Scheduled daily at 10:00 by ~/Library/LaunchAgents/com.zeromorse.pi-sync.plist.
# Log: ~/Library/Logs/pi-sync.log
# Escape hatch: PI_SYNC_NO_AI=1 disables AI conflict resolution.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$SCRIPT_DIR/../.." && pwd)"
NODE_BIN="/Users/duanyanlong/.nvm/versions/node/v22.22.3/bin"
PI_BIN="$HOME/.local/bin/pi"
MERGE_TOOL="$SCRIPT_DIR/pi-sync-merge-changelog.py"
PI_NOTIFY="$HOME/Applications/pi-notify.app/Contents/MacOS/pi-notify"
LOG_FILE="$HOME/Library/Logs/pi-sync.log"
LOCK_DIR="/tmp/pi-sync.lock"
TMP_DIR="$(mktemp -d /tmp/pi-sync.XXXXXX)"
# Records the my-main commit of the last successful rebuild, so a run after a
# manual merge (or a previously failed build) still rebuilds instead of
# exiting "up to date" with a stale global pi binary.
STATE_DIR="$HOME/Library/Application Support/com.zeromorse.pi-sync"
LAST_BUILT_FILE="$STATE_DIR/last-built"

export PATH="$NODE_BIN:$HOME/.local/bin:$HOME/.pi/agent/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export GIT_TERMINAL_PROMPT=0

log() { printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }

last_built() { cat "$LAST_BUILT_FILE" 2>/dev/null || true; }

notify() {
    if [ -x "$PI_NOTIFY" ]; then
        # same identifier replaces previous notifications instead of piling up
        "$PI_NOTIFY" send "pi-sync" "$1" "" "pi-sync" >/dev/null 2>&1 || true
    else
        osascript -e "display notification \"$1\" with title \"pi-sync\"" \
            >/dev/null 2>&1 || true
    fi
}

cleanup() { rm -rf "$LOCK_DIR" "$TMP_DIR"; }
trap cleanup EXIT

restore_branch() {
    if [ -n "${start_branch:-}" ] && [ "${start_branch:-}" != "my-main" ]; then
        git checkout "$start_branch" || log "WARNING: cannot restore branch $start_branch"
    fi
}

die() {
    log "ERROR: $1"
    notify "pi-sync failed: $1"
    restore_branch
    exit 1
}

if ! mkdir "$LOCK_DIR" 2>/dev/null; then
    log "ERROR: another run holds $LOCK_DIR, exiting"
    exit 1
fi

# rotate: keep the tail when the log grows past 1 MB
if [ -f "$LOG_FILE" ] && [ "$(stat -f%z "$LOG_FILE")" -gt 1048576 ]; then
    tail -n 2000 "$LOG_FILE" > "$LOG_FILE.tmp" && mv "$LOG_FILE.tmp" "$LOG_FILE"
fi

exec >> "$LOG_FILE" 2>&1
log "=== pi-sync-rebuild start ==="

cd "$REPO" || { log "ERROR: cannot cd $REPO"; exit 1; }

# --- 1. preflight: clean working tree (never stash or reset)
if [ -n "$(git status --short)" ]; then
    log "ERROR: working tree dirty, resolve manually (never stashed/reset by this script):"
    git status --short | sed 's/^/    /'
    notify "pi-sync skipped: dirty working tree"
    exit 1
fi
start_branch="$(git branch --show-current)"
log "start branch: ${start_branch:-<detached>}"

# --- 2. fetch upstream
git fetch origin main || die "git fetch origin main failed (network?)"

# --- 3. nothing to do when main is current, my-main contains it, and it is built
if [ "$(git rev-parse main)" = "$(git rev-parse origin/main)" ] \
    && git merge-base --is-ancestor main my-main; then
    # local my-main commits (e.g. manual fixes) still need mirroring even
    # when upstream is quiet; push is idempotent when nothing changed
    if [ "$(git rev-parse my-main)" != "$(git rev-parse fork/my-main 2>/dev/null)" ]; then
        log "my-main ahead of fork, pushing before exit"
        git push fork my-main \
            || log "WARNING: git push fork my-main failed, will retry next run"
    fi
    if [ "$(last_built)" = "$(git rev-parse my-main)" ]; then
        log "up to date, nothing to do"
        exit 0
    fi
    # my-main advanced outside this script (manual merge) or the last build
    # failed; fall through - steps 4-7 become no-ops and step 8 rebuilds
    log "my-main not built yet (manual merge or failed build), falling through to rebuild"
fi

# --- 4. fast-forward local main (stray local commits need manual fix)
git checkout main || die "git checkout main failed"
git merge --ff-only origin/main \
    || die "local main diverged from upstream, manual fix required"
log "main fast-forwarded to $(git rev-parse --short main)"

# --- 5. mirror main to the fork (non-fatal: retried next run)
if ! git push fork main; then
    log "WARNING: git push fork main failed, will retry next run"
fi

# --- 6. merge main into my-main
git checkout my-main || die "git checkout my-main failed"
old_head="$(git rev-parse HEAD)"
ai_merged=0
if ! git merge main --no-edit; then
    # rerere may have auto-applied recorded resolutions into the working tree
    # while the index still reports the paths as unmerged; accept those.
    while IFS= read -r -d '' f; do
        if ! grep -q '^<<<<<<<' "$f" 2>/dev/null; then
            git add "$f"
            log "rerere already resolved $f"
        fi
    done < <(git diff --name-only --diff-filter=U -z)

    # Split what rerere could not fix: CHANGELOG conflicts are auto-resolved
    # (upstream verbatim + fork entries back under [Unreleased], the pattern
    # from the pi-fork-sync skill); code conflicts abort together with the
    # full list so the notification shows every file that needs attention.
    code_conflicts=""
    while IFS= read -r -d '' f; do
        case "$f" in
        */CHANGELOG.md | CHANGELOG.md)
            if git show ":2:$f" > "$TMP_DIR/ours" \
                && git show ":3:$f" > "$TMP_DIR/theirs" \
                && python3 "$MERGE_TOOL" "$TMP_DIR/ours" "$TMP_DIR/theirs" "$f"; then
                git add "$f"
                log "auto-resolved CHANGELOG conflict in $f"
            else
                git merge --abort
                die "cannot auto-resolve CHANGELOG conflict in $f"
            fi
            ;;
        *)
            code_conflicts="$code_conflicts $f"
            ;;
        esac
    done < <(git diff --name-only --diff-filter=U -z)
    if [ -n "$code_conflicts" ]; then
        # Code conflicts: let pi (headless) try first; PI_SYNC_NO_AI=1 skips it.
        # On failure fall back to the original behavior: abort + notify. The
        # reset fallback only triggers when the AI committed despite the prompt
        # (merge --abort then fails); preflight guaranteed a clean tree at the
        # old head, so this discards only the AI's own work.
        if [ "${PI_SYNC_NO_AI:-}" = "1" ]; then
            git merge --abort 2>/dev/null || git reset --hard "$old_head"
            die "code conflicts need manual merge (AI resolution disabled):$code_conflicts"
        fi
        if "$SCRIPT_DIR/pi-sync-ai-resolve.sh"; then
            log "AI resolved code conflicts:$code_conflicts"
            ai_merged=1
        else
            git merge --abort 2>/dev/null || git reset --hard "$old_head"
            die "code conflicts need manual merge (AI resolution failed):$code_conflicts"
        fi
    fi
    git commit --no-edit || { git merge --abort; die "commit after conflict resolution failed"; }
fi
new_head="$(git rev-parse HEAD)"
log "my-main: $(git rev-parse --short "$old_head") -> $(git rev-parse --short "$new_head")"

# --- 7. push my-main to the fork (non-fatal: retried next run)
if ! git push fork my-main; then
    log "WARNING: git push fork my-main failed, will retry next run"
fi

# --- 8. rebuild when the merge advanced my-main or the last build is stale
if [ "$old_head" != "$new_head" ] || [ "$(last_built)" != "$new_head" ]; then
    log "rebuilding (node $(node --version))"
    # upstream dep bumps leave node_modules stale; align it with the merged
    # lockfile before building (never runs lifecycle scripts)
    npm install --ignore-scripts \
        || die "npm install failed, run pi-rebuild-global manually"
    if [ -n "$(git status --porcelain)" ]; then
        log "npm install modified the working tree, manual fix required:"
        git status --porcelain | sed 's/^/    /'
        die "unexpected changes after npm install (lockfile drift?)"
    fi
    # the packages/ai build step regenerates provider data (models.dev et al);
    # a missing network source fails the build loudly, retried next run
    if npm run build && "$PI_BIN" --version; then
        log "rebuild OK"
        mkdir -p "$STATE_DIR" && echo "$new_head" > "$LAST_BUILT_FILE"
        ai_note=""
        [ "$ai_merged" = "1" ] && ai_note=" (AI-resolved merge)"
        notify "pi synced to $(git rev-parse --short "$new_head") and rebuilt$ai_note"
    else
        die "npm run build failed, run pi-rebuild-global manually"
    fi
else
    log "merge was a no-op and build is current, skipping rebuild"
fi

# --- 9. restore the branch we started on
restore_branch

log "=== pi-sync-rebuild done ==="
