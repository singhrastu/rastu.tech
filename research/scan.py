#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Survey email authentication adoption across the public internet.

    python3 research/scan.py --limit 10000            # pilot
    python3 research/scan.py --limit 1000000          # full run
    python3 research/scan.py --limit 10000 --resume   # continue an interrupted run

Sample: the Tranco top-1M list. Tranco is used because it is the list built for
research: it averages several providers over 30 days, so it is far more stable than
Alexa-style snapshots, and every list is permanently addressable by ID. Anyone can
re-run this against the same list and get the same population.

WHAT IS MEASURED, per domain:
    MX        does it receive mail at all
    SPF       TXT at the apex starting v=spf1, plus the RFC 7208 lookup count
    DMARC     TXT at _dmarc, plus policy strength and whether rua is set
    MTA-STS   TXT at _mta-sts (the DNS half; the policy file is checked separately)
    TLS-RPT   TXT at _smtp._tls
    BIMI      TXT at default._bimi

WHAT IS NOT, and why it matters for honesty:
    DKIM cannot be surveyed at scale. Selectors are arbitrary strings chosen by the
    sender, so absence of a key at a guessed selector proves nothing. Any published
    figure for "DKIM adoption" derived from probing common selectors is a lower
    bound at best and misleading at worst. This survey does not report one.

Output is JSONL, one record per domain, written as it goes so a run can be resumed
or interrupted without loss.
"""
import argparse
import csv
import json
import os
import re
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor

import dns.resolver
import dns.exception

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "data")
TRANCO_LIST_ID = "V3YPN"          # created 2026-09-17, for citation

# Spread queries across several public resolvers. A single resolver rate-limits
# long before a million domains are done, and the failures look like "no record"
# rather than "no answer", which would silently understate adoption.
RESOLVERS = [
    ["1.1.1.1", "1.0.0.1"],
    ["8.8.8.8", "8.8.4.4"],
    ["9.9.9.9", "149.112.112.112"],
    ["208.67.222.222", "208.67.220.220"],
]
_local = threading.local()
_counter = {"done": 0, "err": 0}
_lock = threading.Lock()


def resolver():
    if not hasattr(_local, "r"):
        idx = threading.get_ident() % len(RESOLVERS)
        r = dns.resolver.Resolver(configure=False)
        r.nameservers = RESOLVERS[idx]
        r.timeout = 4.0
        r.lifetime = 6.0
        _local.r = r
    return _local.r


def txt(name):
    try:
        ans = resolver().resolve(name, "TXT")
    except (dns.resolver.NXDOMAIN, dns.resolver.NoAnswer,
            dns.resolver.NoNameservers, dns.exception.Timeout):
        return []
    except Exception:
        return []
    out = []
    for rd in ans:
        # DNS splits long TXT into 255-byte chunks; they must be rejoined before
        # parsing or a long SPF record looks malformed.
        out.append("".join(s.decode("utf8", "replace") for s in rd.strings))
    return out


def has_mx(domain):
    try:
        return len(resolver().resolve(domain, "MX")) > 0
    except Exception:
        return False


LOOKUP = re.compile(r"\b(include:|a:|mx:|ptr\b|exists:|redirect=)", re.I)


def spf_lookups(record, depth=0, seen=None):
    """Approximate the RFC 7208 lookup count. Over 10 is a permerror, which most
    receivers treat as no SPF at all, even though the record still resolves."""
    if seen is None:
        seen = set()
    if depth > 5:
        return 99
    n = 0
    for tok in record.split():
        t = tok.lower()
        if t.startswith(("include:", "redirect=")):
            n += 1
            target = tok.split(":", 1)[-1] if t.startswith("include:") else tok.split("=", 1)[-1]
            target = target.strip().rstrip(".")
            if not target or target in seen:
                continue
            seen.add(target)
            sub = [x for x in txt(target) if x.lower().startswith("v=spf1")]
            if sub:
                n += spf_lookups(sub[0], depth + 1, seen)
        elif t.startswith(("a:", "mx:", "exists:")) or t in ("a", "mx", "ptr"):
            n += 1
    return n


def tags(record, sep=";"):
    out = {}
    for part in record.split(sep):
        part = part.strip()
        if "=" in part:
            k, v = part.split("=", 1)
            out[k.strip().lower()] = v.strip()
    return out


def scan(entry):
    rank, domain = entry
    rec = {"rank": rank, "domain": domain, "tld": domain.rsplit(".", 1)[-1]}
    try:
        rec["mx"] = has_mx(domain)

        spf = [t for t in txt(domain) if t.lower().startswith("v=spf1")]
        rec["spf"] = bool(spf)
        rec["spf_multiple"] = len(spf) > 1
        if spf:
            r = spf[0]
            m = re.search(r"([-~+?])all\b", r)
            rec["spf_all"] = m.group(1) if m else None
            rec["spf_lookups"] = spf_lookups(r)
            rec["spf_over_limit"] = rec["spf_lookups"] > 10

        dm = [t for t in txt(f"_dmarc.{domain}") if t.lower().startswith("v=dmarc1")]
        rec["dmarc"] = bool(dm)
        if dm:
            t = tags(dm[0])
            rec["dmarc_p"] = (t.get("p") or "").lower() or None
            rec["dmarc_sp"] = (t.get("sp") or "").lower() or None
            rec["dmarc_rua"] = bool(t.get("rua"))
            rec["dmarc_pct"] = t.get("pct", "100")

        rec["mta_sts"] = any(t.lower().startswith("v=stsv1")
                             for t in txt(f"_mta-sts.{domain}"))
        rec["tls_rpt"] = any(t.lower().startswith("v=tlsrptv1")
                             for t in txt(f"_smtp._tls.{domain}"))
        rec["bimi"] = any(t.lower().startswith("v=bimi1")
                          for t in txt(f"default._bimi.{domain}"))
    except Exception as ex:
        rec["error"] = type(ex).__name__

    with _lock:
        _counter["done"] += 1
        if rec.get("error"):
            _counter["err"] += 1
        if _counter["done"] % 500 == 0:
            print(f"  {_counter['done']} scanned, {_counter['err']} errors",
                  file=sys.stderr, flush=True)
    return rec


def load_tranco(path, limit):
    rows = []
    with open(path, newline="") as f:
        for i, row in enumerate(csv.reader(f)):
            if i >= limit:
                break
            if len(row) >= 2:
                rows.append((int(row[0]), row[1].strip().lower()))
    return rows


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tranco", default="/tmp/tranco.csv")
    ap.add_argument("--limit", type=int, default=10000)
    ap.add_argument("--workers", type=int, default=60)
    ap.add_argument("--resume", action="store_true")
    a = ap.parse_args()

    os.makedirs(OUT, exist_ok=True)
    outfile = os.path.join(OUT, f"scan-{a.limit}.jsonl")

    done = set()
    if a.resume and os.path.exists(outfile):
        for line in open(outfile):
            try:
                done.add(json.loads(line)["domain"])
            except Exception:
                pass
        print(f"resuming, {len(done)} already scanned", file=sys.stderr)

    targets = [t for t in load_tranco(a.tranco, a.limit) if t[1] not in done]
    print(f"scanning {len(targets)} domains with {a.workers} workers",
          file=sys.stderr, flush=True)

    t0 = time.time()
    with open(outfile, "a") as fh, ThreadPoolExecutor(max_workers=a.workers) as ex:
        for rec in ex.map(scan, targets):
            fh.write(json.dumps(rec) + "\n")
            fh.flush()

    dt = time.time() - t0
    print(f"done in {dt/60:.1f} min -> {outfile}", file=sys.stderr)


if __name__ == "__main__":
    sys.exit(main())
