#!/usr/bin/env python3
"""Resolve a CHANGELOG.md merge conflict for the pi fork sync.

Usage: pi-sync-merge-changelog.py OURS THEIRS OUT

Per the pi-fork-sync skill rule:
- Take upstream (theirs, "main") verbatim for released sections.
- Re-add the fork-only entries from ours (my-main) under ## [Unreleased].

Subsection-aware: fork entries merge into matching `### <Section>`
subsections of theirs (fork entries first); ours-only subsections are
appended at the end of the [Unreleased] section. Duplicate entry lines are
dropped.

Exit codes: 0 = resolved, 1 = cannot resolve (caller must abort the merge).
"""

import sys

UNRELEASED = "## [Unreleased]"


def unreleased_range(lines):
    """Return (start, end) line indexes of the [Unreleased] section.

    start points at the '## [Unreleased]' header, end at the next '## '
    header or len(lines) when the section runs to EOF.
    """
    try:
        start = next(i for i, line in enumerate(lines) if line.startswith(UNRELEASED))
    except StopIteration:
        return None
    end = len(lines)
    for i in range(start + 1, len(lines)):
        if lines[i].startswith("## "):
            end = i
            break
    return start, end


def parse_section(lines, start, end):
    """Split section body lines[start+1:end] into (subs, order).

    subs maps subsection header (without newline) to entry lines; lines
    before the first ### collect under "". Blank padding around entries is
    trimmed.
    """
    subs = {}
    order = []
    current = ""
    for line in lines[start + 1 : end]:
        if line.startswith("### "):
            current = line.rstrip("\n")
            if current not in subs:
                subs[current] = []
                order.append(current)
            continue
        if not line.strip():
            continue
        subs.setdefault(current, []).append(line)
    return subs, order


def main():
    ours_path, theirs_path, out_path = sys.argv[1:4]
    with open(ours_path) as f:
        ours = f.readlines()
    with open(theirs_path) as f:
        theirs = f.readlines()

    for name, lines in (("ours", ours), ("theirs", theirs)):
        if unreleased_range(lines) is None:
            print(f"no {UNRELEASED} header in {name}", file=sys.stderr)
            sys.exit(1)

    o_start, o_end = unreleased_range(ours)
    ours_subs, ours_order = parse_section(ours, o_start, o_end)
    if not any(ours_subs.get(k) for k in ours_order):
        # fork side has no [Unreleased] entries: upstream verbatim
        with open(out_path, "w") as f:
            f.writelines(theirs)
        return

    t_start, t_end = unreleased_range(theirs)
    theirs_subs, theirs_order = parse_section(theirs, t_start, t_end)

    # merged subsections: theirs order first, ours-only ones appended;
    # fork entries come before upstream entries within a subsection
    merged = {}
    order = []
    for key in theirs_order + [k for k in ours_order if k not in theirs_subs]:
        entries = []
        seen = set()
        for entry in ours_subs.get(key, []) + theirs_subs.get(key, []):
            if entry not in seen:
                seen.add(entry)
                entries.append(entry)
        if entries:
            merged[key] = entries
            order.append(key)

    out = theirs[: t_start + 1]
    out.append("\n")
    for key in order:
        if key:
            out.append(key + "\n")
            out.append("\n")
        out.extend(merged[key])
        out.append("\n")
    out.extend(theirs[t_end:])

    with open(out_path, "w") as f:
        f.writelines(out)


if __name__ == "__main__":
    main()
