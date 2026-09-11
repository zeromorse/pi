#!/usr/bin/env python3
"""Scan pi session logs and emit a compact usage-statistics report.

Usage:
  analyze.py [days] [--all] [--include-self-test]
  days: lookback window in days (default 7). 1 = today only.
  --all: scan the entire history (ignores days).
  --include-self-test: include pi's own faux-provider test sessions
  (they are excluded by default).

Reads session JSONL files under ~/.pi/agent/sessions/, groups them by
project cwd, and prints per-project, per-day, and total metrics.
Output is designed for an LLM to interpret, not for humans.
"""

import json
import os
import re
import sys
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone

SESSIONS_DIR = os.path.expanduser("~/.pi/agent/sessions")

CORRECTION_KEYWORDS = (
    "不对", "错了", "重新", "回滚", "不要", "停下", "取消",
    "wrong", "revert", "undo", "try again", "not what",
)

# commands that industry guidance says deserve conscious review before running
DANGEROUS_PATTERNS = (
    "rm -rf", "rm -fr", "git push --force", "git push -f ",
    "git reset --hard", "git checkout .", "git clean",
    "sudo ", "chmod -r", ">/dev/sda", "dd if=",
)

# verification loop: tests, type checks, linters (industry guidance: close the
# loop by having the agent run verification itself instead of eyeballing diffs)
VERIFICATION_PATTERNS = (
    "npm test", "vitest", "node --test", "test.sh", "pytest",
    "mvn test", "gradle test", "npm run check", "tsc ", "eslint", "sonar",
)


def parse_args():
    days = 7
    scan_all = False
    include_self_test = False
    args = sys.argv[1:]
    if "--all" in args:
        scan_all = True
        args = [a for a in args if a != "--all"]
    if "--include-self-test" in args:
        include_self_test = True
        args = [a for a in args if a != "--include-self-test"]
    if args:
        try:
            days = int(args[0])
        except ValueError:
            print(f"error: invalid days value {args[0]!r}", file=sys.stderr)
            sys.exit(2)
    return days, scan_all, include_self_test


def proj_name_from_cwd(cwd: str) -> str:
    """/Users/x/agent/pi -> ~/agent/pi"""
    home = os.path.expanduser("~")
    if cwd == home:
        return "~"
    if cwd.startswith(home + "/"):
        return "~" + cwd[len(home):]
    return cwd


def new_stats():
    return {
        "sessions": 0, "user_msgs": 0, "assistant_msgs": 0, "tool_calls": 0,
        "tool_counts": Counter(), "models": set(), "thinking_levels": set(),
        "prompt_samples": [], "edit_calls": 0, "active_seconds": 0,
        "correction_signals": 0, "git_commits": 0, "dangerous_cmds": [],
        "verification_runs": 0,
    }


def extract_file_stats(path: str, stats: dict) -> dict:
    """Parse one session JSONL file, update project-level `stats` in place,
    and return per-session metrics for the daily distribution."""
    first_user_ts = None
    last_event_ts = None
    user_texts = []
    models = set()
    thinking_levels = set()
    n_user = n_assistant = n_tool_calls = n_edit = 0
    n_commits = 0
    n_verifications = 0
    dangerous_cmds = []
    tool_counts = Counter()
    active_seconds = 0
    correction_signals = 0

    with open(path, encoding="utf-8", errors="replace") as fh:
        for line in fh:
            try:
                obj = json.loads(line)
            except (json.JSONDecodeError, ValueError):
                continue
            ts = obj.get("timestamp")
            if ts:
                last_event_ts = ts
            t = obj.get("type")
            if t == "model_change":
                models.add(f"{obj.get('provider')}/{obj.get('modelId')}")
            elif t == "thinking_level_change":
                thinking_levels.add(str(obj.get("thinkingLevel")))
            elif t == "message":
                msg = obj.get("message") or {}
                role = msg.get("role")
                if role == "user":
                    for c in msg.get("content") or []:
                        if isinstance(c, dict) and c.get("type") == "text":
                            n_user += 1
                            user_texts.append(c.get("text", ""))
                            if first_user_ts is None:
                                first_user_ts = ts
                elif role == "assistant":
                    for c in msg.get("content") or []:
                        if not isinstance(c, dict):
                            continue
                        ct = c.get("type")
                        if ct == "text":
                            n_assistant += 1
                        elif ct == "toolCall":
                            n_tool_calls += 1
                            name = c.get("name") or "unknown"
                            tool_counts[name] += 1
                            if name == "edit":
                                n_edit += 1
                            elif name == "bash":
                                cmd = ((c.get("arguments") or {}).get("command") or "")
                                if "git commit" in cmd or "git-cz" in cmd:
                                    n_commits += 1
                                for seg in re.split(r"&&|;|\|", cmd.lower()):
                                    seg = seg.strip()
                                    # skip segments that merely reference patterns as text
                                    if seg.startswith(("grep", "rg ", "echo", "sed", "cat ", "awk")):
                                        continue
                                    for pat in DANGEROUS_PATTERNS:
                                        if pat in seg:
                                            dangerous_cmds.append(cmd.strip()[:120])
                                            break
                                    else:
                                        for pat in VERIFICATION_PATTERNS:
                                            if pat in seg:
                                                n_verifications += 1
                                                break
                                        continue
                                    break

    if first_user_ts and last_event_ts:
        try:
            t0 = datetime.fromisoformat(first_user_ts.replace("Z", "+00:00"))
            t1 = datetime.fromisoformat(last_event_ts.replace("Z", "+00:00"))
            dur = (t1 - t0).total_seconds()
            if 0 <= dur < 24 * 3600:
                active_seconds = dur
        except ValueError:
            pass

    for text in user_texts:
        # skip injected content (skill loads, slash-command expansions)
        if text.lstrip().startswith("<"):
            continue
        low = text.lower()
        for kw in CORRECTION_KEYWORDS:
            if kw in low:
                correction_signals += 1
                break

    stats["sessions"] += 1
    stats["user_msgs"] += n_user
    stats["assistant_msgs"] += n_assistant
    stats["tool_calls"] += n_tool_calls
    stats["edit_calls"] += n_edit
    stats["git_commits"] += n_commits
    stats["verification_runs"] += n_verifications
    stats["active_seconds"] += active_seconds
    stats["correction_signals"] += correction_signals
    stats["models"].update(models)
    stats["thinking_levels"].update(thinking_levels)
    for k, v in tool_counts.items():
        stats["tool_counts"][k] += v
    stats["dangerous_cmds"].extend(dangerous_cmds[:3])
    if user_texts:
        # first real prompt: skip injected skill/command content
        for t in user_texts:
            stripped = t.strip()
            if stripped and not stripped.startswith("<"):
                stats["prompt_samples"].append(stripped[:300])
                break

    return {
        "user_msgs": n_user, "tool_calls": n_tool_calls,
        "active_seconds": active_seconds,
    }


def fmt_secs(s):
    if s >= 3600:
        return f"{s / 3600:.1f}h"
    if s >= 60:
        return f"{s / 60:.0f}m"
    return f"{s:.0f}s"


def merge(dst: dict, src: dict):
    for k in ("sessions", "user_msgs", "assistant_msgs", "tool_calls",
              "edit_calls", "git_commits", "verification_runs",
              "active_seconds", "correction_signals"):
        dst[k] += src[k]
    dst["models"].update(src["models"])
    dst["thinking_levels"].update(src["thinking_levels"])
    dst["tool_counts"].update(src["tool_counts"])
    dst["prompt_samples"].extend(src["prompt_samples"])
    dst["dangerous_cmds"].extend(src["dangerous_cmds"])


def main():
    days, scan_all, include_self_test = parse_args()
    if not os.path.isdir(SESSIONS_DIR):
        print(f"error: sessions dir not found: {SESSIONS_DIR}", file=sys.stderr)
        sys.exit(1)

    cutoff = None
    if not scan_all:
        cutoff = datetime.now(timezone.utc) - timedelta(days=days)

    proj_stats = {}
    daily = defaultdict(lambda: {"sessions": 0, "tool_calls": 0, "active_seconds": 0})
    total_sessions = 0
    skipped = 0
    self_test_skipped = 0

    for entry in sorted(os.listdir(SESSIONS_DIR)):
        pdir = os.path.join(SESSIONS_DIR, entry)
        if not os.path.isdir(pdir):
            continue
        for fname in sorted(os.listdir(pdir)):
            if not fname.endswith(".jsonl"):
                continue
            path = os.path.join(pdir, fname)
            try:
                with open(path, encoding="utf-8", errors="replace") as fh:
                    meta = json.loads(fh.readline())
            except (OSError, json.JSONDecodeError):
                skipped += 1
                continue
            ts = meta.get("timestamp")
            if cutoff is not None:
                try:
                    start = datetime.fromisoformat((ts or "").replace("Z", "+00:00"))
                except ValueError:
                    skipped += 1
                    continue
                if start < cutoff:
                    skipped += 1
                    continue
            cwd = meta.get("cwd") or entry
            # pi's own faux-provider test suites run in temp dirs; skip them
            if "pi-runtime-suite" in cwd or cwd.startswith(("/tmp/", "/var/folders/")):
                self_test_skipped += 1
                if not include_self_test:
                    continue
                proj_label = "(pi self-test sessions, faux provider)"
            else:
                proj_label = proj_name_from_cwd(cwd)
            total_sessions += 1
            stats = proj_stats.setdefault(proj_label, new_stats())
            try:
                per_session = extract_file_stats(path, stats)
            except OSError:
                skipped += 1
                continue
            if ts:
                d = daily[ts[:10]]
                d["sessions"] += 1
                d["tool_calls"] += per_session["tool_calls"]
                d["active_seconds"] += per_session["active_seconds"]

    if total_sessions == 0:
        print(f"No sessions found in the last {days} day(s).")
        return

    print(f"=== pi session usage report (last {days} day(s), {total_sessions} sessions, "
          f"{skipped} unreadable, {self_test_skipped} self-test sessions "
          f"{'included' if include_self_test else 'excluded'}) ===")
    print()

    grand = new_stats()
    for proj, s in sorted(proj_stats.items(), key=lambda kv: -kv[1]["tool_calls"]):
        avg_turns = s["user_msgs"] / s["sessions"] if s["sessions"] else 0
        print(f"## {proj}")
        print(f"sessions={s['sessions']} user_msgs={s['user_msgs']} assistant_msgs={s['assistant_msgs']} "
              f"tool_calls={s['tool_calls']} (avg {s['tool_calls'] / s['sessions']:.0f}/session) "
              f"avg_user_turns/session={avg_turns:.1f}")
        print(f"active_time≈{fmt_secs(s['active_seconds'])} edit_calls={s['edit_calls']} "
              f"git_commits={s['git_commits']} verification_runs={s['verification_runs']} "
              f"correction_signals={s['correction_signals']}")
        if s["dangerous_cmds"]:
            print(f"dangerous_cmds (sample): {s['dangerous_cmds'][:3]}")
        if s["models"]:
            print(f"models: {', '.join(sorted(s['models']))}")
        if s["thinking_levels"]:
            print(f"thinking levels: {', '.join(sorted(s['thinking_levels']))}")
        if s["tool_counts"]:
            top_tools = ", ".join(f"{k}×{v}" for k, v in s["tool_counts"].most_common(8))
            print(f"top tools: {top_tools}")
        if s["prompt_samples"]:
            seen = set()
            uniq = []
            for p in s["prompt_samples"]:
                key = p[:80]
                if key not in seen:
                    seen.add(key)
                    uniq.append(p)
            print("first prompts (deduped, truncated):")
            for p in uniq[:5]:
                one_line = " ".join(p.split())
                print(f"  - {one_line}")
        print()
        merge(grand, s)

    print("## Daily distribution")
    for day in sorted(daily):
        d = daily[day]
        print(f"{day}: sessions={d['sessions']} tool_calls={d['tool_calls']} "
              f"active≈{fmt_secs(d['active_seconds'])}")
    print()

    print("## Totals")
    print(f"sessions={grand['sessions']} user_msgs={grand['user_msgs']} "
          f"assistant_msgs={grand['assistant_msgs']} tool_calls={grand['tool_calls']}")
    print(f"active_time≈{fmt_secs(grand['active_seconds'])} edit_calls={grand['edit_calls']} "
          f"git_commits={grand['git_commits']} verification_runs={grand['verification_runs']} "
          f"correction_signals={grand['correction_signals']}")

    # daily averages over the window; days without sessions still count in the
    # denominator, so the average reflects usage intensity per calendar day
    if daily:
        if scan_all:
            span = ((datetime.strptime(max(daily), "%Y-%m-%d")
                     - datetime.strptime(min(daily), "%Y-%m-%d")).days + 1)
        else:
            span = days
    else:
        span = days
    print(f"daily_avg over {span}d: sessions={grand['sessions'] / span:.1f} "
          f"user_msgs={grand['user_msgs'] / span:.1f} "
          f"assistant_msgs={grand['assistant_msgs'] / span:.1f} "
          f"tool_calls={grand['tool_calls'] / span:.1f} "
          f"active≈{fmt_secs(grand['active_seconds'] / span)}")
    if grand["dangerous_cmds"]:
        print(f"dangerous_cmds total: {len(grand['dangerous_cmds'])} (samples: {grand['dangerous_cmds'][:5]})")
    if grand["models"]:
        print(f"models: {', '.join(sorted(grand['models']))}")
    if grand["thinking_levels"]:
        print(f"thinking levels: {', '.join(sorted(grand['thinking_levels']))}")
    if grand["tool_counts"]:
        print("top tools: " + ", ".join(f"{k}×{v}" for k, v in grand["tool_counts"].most_common(10)))
    print()
    print("## Interpretation hints (for the agent, not the user)")
    print("- correction_signals counts user messages containing stop/redo/revert keywords "
          "(不对/错了/重新/回滚/wrong/revert...). High values relative to user_msgs suggest "
          "frequent mid-task course corrections.")
    print("- avg_user_turns/session < 2 with many sessions suggests many short one-shot sessions.")
    print("- Long active_time with few user_msgs suggests long autonomous runs.")
    print("- bash-heavy tool usage with low read/edit ratio may indicate exploratory sessions; "
          "edit-heavy sessions indicate implementation work.")
    print("- Duplicate first prompts across sessions suggest restarting similar work instead of "
          "continuing one session (check whether resuming would have been better).")
    print("- git_commits vs edit_calls: commits while editing indicates a checkpoint habit "
          "(industry guidance: commit early, commit often, keep diffs reviewable).")
    print("- dangerous_cmds lists bash commands matching risky patterns (rm -rf, force push, "
          "reset --hard...). Frequent use without user confirmation in the transcript is a "
          "review-habit signal. Note: rm -rf under /tmp is low risk; git reset --hard / "
          "force push on working repos deserves scrutiny; --force-with-lease is the safer "
          "variant.")
    print("- verification_runs vs edit_calls: agents closing the loop (tests/lint/typecheck "
          "run by the agent) is an industry best practice; near-zero verification with many "
          "edits means changes were not self-checked.")


if __name__ == "__main__":
    main()
