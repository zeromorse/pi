#!/usr/bin/env bash
# pi-sync-ai-resolve.sh - resolve merge code conflicts with pi (headless).
#
# Called by pi-sync-rebuild.sh when `git merge main` into my-main leaves code
# conflicts that rerere and the CHANGELOG auto-resolver could not fix. Spawns
# `pi -p` in this repo to resolve the conflicts, then verifies the result:
# no unmerged paths, no conflict markers in the conflicted files, HEAD
# unchanged (the AI must not commit), `npm run check` passes, and ./test.sh
# passes. On success the resolved files are staged (git add) and the caller
# commits; on any failure this exits non-zero and the caller aborts the merge.
#
# All output is inherited from the caller (pi-sync.log), so the AI's answer
# and the verification logs are auditable. The full tool-call trace lives in
# the pi session files under ~/.pi/agent/sessions/.
#
# Environment:
#   PI_SYNC_AI_MODEL    override the model used for resolution
#   PI_SYNC_AI_TIMEOUT  seconds before pi is killed (default 1800; the run is
#                       daily, so a generous budget beats a flaky cutoff)
#
# Exit codes: 0 = conflicts resolved and staged, caller may commit;
#             1 = resolution failed or unverifiable, caller must abort.

set -uo pipefail

REPO="$(git rev-parse --show-toplevel 2>/dev/null)" || { echo "ERROR: not a git repo" >&2; exit 1; }
cd "$REPO"

TIMEOUT_S="${PI_SYNC_AI_TIMEOUT:-1800}"
NODE_BIN="/Users/duanyanlong/.nvm/versions/node/v22.22.3/bin"
export PATH="$NODE_BIN:$HOME/.local/bin:$HOME/.pi/agent/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

log() { printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }

conflicts="$(git diff --name-only --diff-filter=U)"
if [ -z "$conflicts" ]; then
    log "no unmerged paths, nothing for AI to resolve"
    exit 0
fi

# CHANGELOG conflicts are the caller's job (pi-sync-merge-changelog.py);
# refusing them here keeps the division of labor testable.
if grep -q 'CHANGELOG\.md$' <<<"$conflicts"; then
    log "refusing: CHANGELOG conflicts still present (caller resolves them first)"
    exit 1
fi

merge_head="$(git rev-parse HEAD)"
prompt_file="$(mktemp /tmp/pi-sync-ai-prompt.XXXXXX)"
trap 'rm -f "$prompt_file"' EXIT

{
    echo "You are resolving merge conflicts in this repository, a personal fork (zeromorse/pi) of earendil-works/pi."
    echo
    echo "A script is merging upstream branch \`main\` into \`my-main\` and the merge stopped with conflicts in:"
    echo
    while IFS= read -r f; do echo "  $f"; done <<<"$conflicts"
    echo "Context:"
    echo "- \`main\` (theirs) brings new upstream features and refactors."
    echo "- \`my-main\` (ours, HEAD) carries fork-only commits on top of upstream."
    echo "- CHANGELOG.md is handled elsewhere; do not modify it."
    echo "- Useful: \`git log --oneline main..my-main -- <file>\` lists the fork-only commits touching a file; \`git show :2:<file>\` / \`:3:<file>\` show the ours/theirs conflict stages."
    echo
    echo "Resolution principles:"
    echo "1. Prefer the upstream (\`main\`) architecture when it already covers fork behavior."
    echo "2. Fork-only feature semantics that upstream lacks MUST be preserved. Check carefully whether upstream absorbed them; if not, merge both sides by hand."
    echo "3. After resolving, run \`npm run check\` and fix every error it reports, including type adaptations in test files (e.g. branded types that need a constructor helper)."
    echo "4. Run the tests covering the files you touched and fix failures (repo rule: ./test.sh from the repo root for non-e2e tests, or specific vitest files per AGENTS.md)."
    echo "5. \`git add\` every resolved file."
    echo
    echo "Hard constraints:"
    echo "- NEVER run git commit, git push, git reset, git checkout, git rebase, or git switch. The calling script verifies and commits."
    echo "- Only modify files needed to resolve the conflicts and make checks and tests pass."
    echo "- The repo rules in AGENTS.md apply except where this prompt overrides them (you must not commit)."
    echo
    echo "Finish with a short summary: files resolved, fork semantics you preserved, and the verification commands you ran with their results."
} > "$prompt_file"

file_count="$(wc -l <<<"$conflicts" | tr -d ' ')"
log "starting pi headless conflict resolution ($file_count files, timeout ${TIMEOUT_S}s)"

pi_args=(-p)
[ -n "${PI_SYNC_AI_MODEL:-}" ] && pi_args+=(--model "$PI_SYNC_AI_MODEL")
pi_args+=("$(cat "$prompt_file")")

"$HOME/.local/bin/pi" "${pi_args[@]}" &
pi_pid=$!
( sleep "$TIMEOUT_S" && kill "$pi_pid" 2>/dev/null ) &
watchdog=$!
wait "$pi_pid"
pi_rc=$?
kill "$watchdog" 2>/dev/null
wait "$watchdog" 2>/dev/null
if [ "$pi_rc" -ne 0 ]; then
    log "ERROR: pi exited with code $pi_rc (timeout or API failure)"
    exit 1
fi

# --- verification gate: trust nothing the AI claims, only what we can check ---
log "verifying AI resolution"

if [ "$(git rev-parse HEAD)" != "$merge_head" ]; then
    log "ERROR: verification failed, HEAD moved (AI committed despite instructions)"
    exit 1
fi

remaining="$(git diff --name-only --diff-filter=U)"
if [ -n "$remaining" ]; then
    log "ERROR: verification failed, unmerged paths remain: $remaining"
    exit 1
fi

marker_files=""
while IFS= read -r f; do
    if grep -q '^<<<<<<<' "$f" 2>/dev/null; then
        marker_files="$marker_files $f"
    fi
done <<<"$conflicts"
if [ -n "$marker_files" ]; then
    log "ERROR: verification failed, conflict markers remain in:$marker_files"
    exit 1
fi

if ! npm run check; then
    log "ERROR: verification failed, npm run check reported errors"
    exit 1
fi

if ! ./test.sh; then
    log "ERROR: verification failed, ./test.sh reported failures"
    exit 1
fi

log "AI resolution verified: no conflicts, check and tests pass"
exit 0
