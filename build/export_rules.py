#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Export the smtpsift ruleset to JSON for the in-browser classifier.

    python3 build/export_rules.py

The site's classifier and the smtpsift CLI must never disagree about what a
response means, so the rules are exported from the package rather than retyped.
Run this after changing smtpsift/rules.py, then rebuild the site.

The patterns are written for Python's re but are deliberately kept to the subset
JavaScript also understands: no lookbehind, no named groups, no inline comments.
This script fails rather than exporting a pattern the browser cannot compile.
"""
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SMTPSIFT = os.path.expanduser("~/Documents/Projects/smtpsift")
OUT = os.path.join(HERE, "sift_rules.json")

sys.path.insert(0, SMTPSIFT)
try:
    from smtpsift import rules as R
except ImportError:
    sys.exit(f"smtpsift not found at {SMTPSIFT}; clone it or fix the path")

PY_ONLY = re.compile(r"\(\?P<|\(\?<|\(\?#|\\Z|\(\?\(")

data = {
    "actions": {k: {"action": v[0], "advice": v[1]} for k, v in R.ACTIONS.items()},
    "rules": [{"category": c, "provider": p, "pattern": rx.pattern, "note": n}
              for c, p, rx, n in R.RULES],
    "providers": {k: v.pattern for k, v in R.PROVIDERS.items()},
}

bad = [r["pattern"] for r in data["rules"] if PY_ONLY.search(r["pattern"])]
bad += [v for v in data["providers"].values() if PY_ONLY.search(v)]
if bad:
    sys.exit("patterns use Python-only regex syntax and will not run in a browser:\n  "
             + "\n  ".join(bad))

with open(OUT, "w", encoding="utf8") as fh:
    json.dump(data, fh, indent=1)
print(f"{len(data['rules'])} rules, {len(data['actions'])} actions, "
      f"{len(data['providers'])} providers -> {OUT}")
