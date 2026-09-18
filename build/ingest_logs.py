#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Turn real bounce logs into the list of rules and reference pages to write next.

    python3 build/ingest_logs.py /path/to/maillog /path/to/acct-*.csv
    python3 build/ingest_logs.py --out coverage.md logs/*.log

WHAT THIS IS FOR
The classifier is not a model and nothing here trains one. It is an ordered list
of regexes, first match wins, and that is deliberate: a classifier you cannot
explain is worse than none when the output decides whether to keep sending. What
real logs buy is coverage. They say which responses arrive often enough to be
worth a rule, which ones currently fall through to "unknown", and which codes are
common enough to deserve their own reference page.

WHAT LEAVES YOUR MACHINE: nothing. This reads logs locally and prints aggregates.
Recipient addresses, sending IPs, message IDs and queue IDs are stripped before
anything is counted, and raw log lines are never written to the output. Do not
commit logs to this repository; point this at wherever they already live.

READS
  PowerMTA accounting CSV, Postfix/maillog text, KumoMTA JSON lines, or any text
  file with SMTP responses in it. Format is detected per line, so a directory of
  mixed logs is fine.
"""
import argparse
import json
import os
import re
import sys
from collections import Counter

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.expanduser("~/Documents/Projects/smtpsift"))

try:
    from smtpsift import rules as R
except ImportError:
    sys.exit("smtpsift not importable; clone it to ~/Documents/Projects/smtpsift")

from codes import CODES

KNOWN_CODES = {c["code"].lower() for c in CODES}

# Anything that could identify a recipient, a sender or a message. Stripped before
# counting, so the aggregate cannot carry PII even by accident.
SCRUB = [
    (re.compile(r"[\w.+-]+@[\w.-]+\.\w+"), "<addr>"),
    (re.compile(r"\b(?:\d{1,3}\.){3}\d{1,3}\b"), "<ip>"),
    (re.compile(r"\b[0-9a-f]{2}(?::[0-9a-f]{2}){5}\b", re.I), "<mac>"),
    (re.compile(r"\b[0-9a-f]{16,}\b", re.I), "<id>"),
    (re.compile(r"\b[A-Za-z0-9_-]{20,}\b"), "<id>"),
    (re.compile(r"\b\d{9,}\b"), "<n>"),
]

# The response itself, wherever it turns up. Postfix wraps it in said:/status=,
# PowerMTA puts it in a CSV column, KumoMTA in a JSON field.
PATTERNS = [
    re.compile(r"said:\s*(\d{3}[ -][^)]+)"),
    re.compile(r"status=\w+\s*\((.+)\)\s*$"),
    re.compile(r"\b([45]\d\d[ -][^\"',]{8,})"),
]


def scrub(s):
    for rx, rep in SCRUB:
        s = rx.sub(rep, s)
    return re.sub(r"\s+", " ", s).strip()


def responses(path):
    """Yield one SMTP response per log line, whatever the log format is."""
    with open(path, errors="replace") as fh:
        for line in fh:
            line = line.rstrip("\n")
            if not line:
                continue
            if line.lstrip().startswith("{"):          # KumoMTA / JSON lines
                try:
                    d = json.loads(line)
                except Exception:
                    continue
                v = d.get("response") or d.get("bounce_details") or d.get("reason") or ""
                if isinstance(v, dict):
                    v = " ".join(str(x) for x in (v.get("enhanced_code"),
                                                  v.get("content")) if x)
                if v:
                    yield str(v)
                continue
            for rx in PATTERNS:                         # text and CSV
                m = rx.search(line)
                if m:
                    yield m.group(1)
                    break


def classify(text):
    for cat, prov, rx, note in R.RULES:
        if rx.search(text):
            return cat, note
    return "unknown", None


def enhanced_codes(text):
    return set(m.group(0) for m in re.finditer(r"\b[45]\.\d{1,3}\.\d{1,3}\b", text))


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("logs", nargs="+")
    ap.add_argument("--top", type=int, default=30,
                    help="how many unmatched responses to list (default 30)")
    ap.add_argument("--out", help="write the report here instead of stdout")
    a = ap.parse_args()

    total = 0
    by_cat = Counter()
    unmatched = Counter()
    codes = Counter()
    matched_examples = {}

    for path in a.logs:
        if not os.path.isfile(path):
            print(f"  skip (not a file): {path}", file=sys.stderr)
            continue
        for raw in responses(path):
            text = scrub(raw)
            if len(text) < 8:
                continue
            total += 1
            cat, note = classify(text)
            by_cat[cat] += 1
            for c in enhanced_codes(text):
                codes[c] += 1
            if cat == "unknown":
                # collapse near-identical wording so the list is actionable
                unmatched[re.sub(r"\d+", "#", text)[:120]] += 1
            else:
                matched_examples.setdefault(cat, text[:110])

    if not total:
        sys.exit("no SMTP responses found. Check the paths, or tell me the log format.")

    L = []
    w = L.append
    w(f"# Classifier coverage\n")
    w(f"{total:,} responses read from {len(a.logs)} file(s).\n")

    known = total - by_cat["unknown"]
    w(f"## Coverage\n")
    w(f"- matched a rule: **{known:,} ({100*known/total:.1f}%)**")
    w(f"- fell through to unknown: **{by_cat['unknown']:,} "
      f"({100*by_cat['unknown']/total:.1f}%)**\n")

    w(f"## By category\n")
    w(f"| category | share | example |")
    w(f"|---|---:|---|")
    for cat, n in by_cat.most_common():
        ex = matched_examples.get(cat, "")
        w(f"| {cat} | {100*n/total:.1f}% | `{ex}` |")
    w("")

    w(f"## Responses with no rule (the list of rules to write)\n")
    if unmatched:
        w(f"| count | response (digits collapsed to #) |")
        w(f"|---:|---|")
        for text, n in unmatched.most_common(a.top):
            w(f"| {n:,} | `{text}` |")
    else:
        w("None. Every response matched a rule.")
    w("")

    w(f"## Enhanced status codes seen, and whether they have a page\n")
    w(f"| code | count | reference page |")
    w(f"|---|---:|---|")
    for code, n in codes.most_common(40):
        w(f"| {code} | {n:,} | {'yes' if code.lower() in KNOWN_CODES else '**missing**'} |")

    report = "\n".join(L)
    if a.out:
        open(a.out, "w").write(report)
        print(f"  wrote {a.out}")
    else:
        print(report)


if __name__ == "__main__":
    main()
