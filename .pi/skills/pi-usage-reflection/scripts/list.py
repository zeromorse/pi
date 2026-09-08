#!/usr/bin/env python3
"""List pi sessions in a time window, sorted by activity (tool calls desc).

Usage: list.py [days] [--all] [--limit N] [--cwd SUBSTRING]
  days: lookback window in days (default 7).
  --all: entire history.
  --limit N: max sessions to print (default 20).
  --cwd SUBSTRING: only sessions whose project cwd contains SUBSTRING.

Output (one session per line):
  <date> <user_turns>u <tool_calls>t <model> <session-path>
Use the path to dig into a specific session with python/jq.
"""

import json
import os
import sys
from datetime import datetime, timedelta, timezone

SESSIONS_DIR = os.path.expanduser("~/.pi/agent/sessions")


def parse_args():
    days = 7
    scan_all = False
    limit = 20
    cwd_filter = None
    args = sys.argv[1:]
    if "--all" in args:
        scan_all = True
        args = [a for a in args if a != "--all"]
    if "--limit" in args:
        i = args.index("--limit")
        limit = int(args[i + 1])
        del args[i:i + 2]
    if "--cwd" in args:
        i = args.index("--cwd")
        cwd_filter = args[i + 1]
        del args[i:i + 2]
    if args:
        days = int(args[0])
    return days, scan_all, limit, cwd_filter


def scan_session(path: str):
    """Return (ts, cwd, model, user_turns, tool_calls, first_prompt)."""
    first_user = None
    user_turns = 0
    tool_calls = 0
    model = "?"
    cwd = "?"
    ts = None
    with open(path, encoding="utf-8", errors="replace") as fh:
        for line in fh:
            try:
                obj = json.loads(line)
            except (json.JSONDecodeError, ValueError):
                continue
            t = obj.get("type")
            if t == "session":
                ts = obj.get("timestamp")
                cwd = obj.get("cwd") or "?"
            elif t == "model_change":
                model = f"{obj.get('provider')}/{obj.get('modelId')}"
            elif t == "message":
                msg = obj.get("message") or {}
                if msg.get("role") == "user":
                    for c in msg.get("content") or []:
                        if isinstance(c, dict) and c.get("type") == "text":
                            user_turns += 1
                            if first_user is None:
                                first_prompt = " ".join(c.get("text", "").split())
                                first_user = first_prompt[:120]
                elif msg.get("role") == "assistant":
                    for c in msg.get("content") or []:
                        if isinstance(c, dict) and c.get("type") == "toolCall":
                            tool_calls += 1
    return ts, cwd, model, user_turns, tool_calls, first_user or ""


def main():
    days, scan_all, limit, cwd_filter = parse_args()
    cutoff = None if scan_all else datetime.now(timezone.utc) - timedelta(days=days)

    rows = []
    for entry in sorted(os.listdir(SESSIONS_DIR)):
        pdir = os.path.join(SESSIONS_DIR, entry)
        if not os.path.isdir(pdir):
            continue
        for fname in sorted(os.listdir(pdir)):
            if not fname.endswith(".jsonl"):
                continue
            path = os.path.join(pdir, fname)
            try:
                ts, cwd, model, turns, tools, prompt = scan_session(path)
            except OSError:
                continue
            if "pi-runtime-suite" in cwd or cwd.startswith(("/tmp/", "/var/folders/")):
                continue
            if cwd_filter and cwd_filter not in cwd:
                continue
            if cutoff and ts:
                try:
                    start = datetime.fromisoformat(ts.replace("Z", "+00:00"))
                except ValueError:
                    continue
                if start < cutoff:
                    continue
            rows.append((ts or "?", turns, tools, model, cwd, prompt, path))

    rows.sort(key=lambda r: -r[2])
    print(f"=== {len(rows)} sessions (last {days} day(s)) sorted by tool calls ===")
    for ts, turns, tools, model, cwd, prompt, path in rows[:limit]:
        day = ts[:10] if ts else "?"
        short_cwd = cwd.replace(os.path.expanduser("~"), "~")
        print(f"{day} {turns}u {tools}t [{model}] {short_cwd}")
        print(f"   prompt: {prompt}")
        print(f"   path:   {path}")


if __name__ == "__main__":
    main()
