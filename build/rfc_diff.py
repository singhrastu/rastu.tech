#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""What changed between two builds of the RFC index.

    python3 build/rfc_diff.py old.json new.json

Run by the weekly refresh so the commit message says what moved rather than
"update data". A document entering or leaving this index is not housekeeping:
it means the answer the site gives has changed. DMARC moving from RFC 7489 to
9989, 9990 and 9991 is the case worth catching, and it is the kind of change
that otherwise goes unnoticed for a year.
"""
import json
import sys


def load(p):
    with open(p, encoding="utf8") as fh:
        d = json.load(fh)
    return {x["num"]: x for x in d["rfcs"]}, d.get("aliases", {})


def main():
    if len(sys.argv) != 3:
        sys.exit("usage: rfc_diff.py old.json new.json")
    try:
        old, oldal = load(sys.argv[1])
    except (OSError, ValueError):
        print("No previous index to compare against.")
        return
    new, newal = load(sys.argv[2])

    added = sorted(set(new) - set(old))
    gone = sorted(set(old) - set(new))
    lines = []

    for n in added:
        x = new[n]
        lines.append(f"  + RFC {n}  {x['title']}")
        lines.append(f"      {x['status'].title()}, published {x['published']}")

    for n in gone:
        x = old[n]
        # A document leaves this index when something replaced it. The alias map
        # records what, so the reason is always available rather than guessed.
        now = newal.get(str(n), {}).get("now") or newal.get(n, {}).get("now") or []
        why = (", replaced by " + ", ".join(str(r) for r in now)) if now else \
              ", no longer current"
        lines.append(f"  - RFC {n}  {x['title']}{why}")

    for n in sorted(set(new) & set(old)):
        a, b = old[n], new[n]
        if a.get("status") != b.get("status"):
            lines.append(f"  ~ RFC {n} status: {a['status']} -> {b['status']}")
        au, bu = set(a.get("updated_by", [])), set(b.get("updated_by", []))
        for u in sorted(bu - au):
            lines.append(f"  ~ RFC {n} is now amended by {u}: "
                         f"{b.get('rel_titles', {}).get(u, '')}")

    if not lines:
        print("No change to the RFC index.")
        return

    print(f"{len(added)} added, {len(gone)} no longer current, "
          f"{len(lines) - 2 * len(added) - len(gone)} amended or reclassified")
    print()
    print("\n".join(lines))


if __name__ == "__main__":
    main()
