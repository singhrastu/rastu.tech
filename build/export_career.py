#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Export the career history from the resume so the site cannot contradict it.

    python3 build/export_career.py

The resume at ~/Documents/Resume/resume_content.py is the single source of truth
about what Rastu has done. Retyping any of it here would guarantee the two drift,
and a site that disagrees with the CV in an interview is worse than no site. So the
site imports it, strips the resume-only machinery (the D/I/S emphasis tags and the
'*' pin markers), and writes a JSON snapshot that the build reads.

The snapshot is committed so a clean checkout still builds without the resume
directory present. Re-run this whenever the resume changes.
"""
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
RESUME = os.path.expanduser("~/Documents/Resume")
OUT = os.path.join(HERE, "career.json")

sys.path.insert(0, RESUME)
try:
    import resume_content as R
except ImportError:
    sys.exit(f"resume_content.py not found in {RESUME}; the snapshot at {OUT} stands")


def year_range(dates):
    """'Jul 2022 - Present' -> '2022 - present'. The site shows years; the resume
    shows months, and months on a public page invite date-arithmetic questions."""
    years = re.findall(r"\b(19|20)\d{2}\b", dates)
    spans = re.findall(r"\b((?:19|20)\d{2})\b", dates)
    end = "present" if re.search(r"present", dates, re.I) else (spans[-1] if spans else "")
    start = spans[0] if spans else ""
    return f"{start} – {end}" if start and end else dates


roles = []
for e in R.EXPERIENCE:
    roles.append({
        "title": e["title"],
        "company": e["company"],
        "location": e.get("location", ""),
        "dates": e["dates"],
        "years": year_range(e["dates"]),
        # bullets are (tag, text); the tag drives resume emphasis and means
        # nothing here. '*' pins a bullet in the resume, also irrelevant.
        "achievements": [t for _, t in e["bullets"]],
    })

json.dump({"roles": roles}, open(OUT, "w", encoding="utf8"), indent=1, ensure_ascii=False)
n = sum(len(r["achievements"]) for r in roles)
print(f"{len(roles)} roles, {n} achievements -> {OUT}")
