#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Turn a scan into the findings and the cuts.

    python3 research/analyse.py research/data/scan-100000.jsonl

Produces the global headline numbers plus the regional and sector slices, so one
scan answers "DMARC adoption worldwide", "in the Baltics" and "in India" from the
same population rather than three separate pieces of work.

The interesting findings are rarely the headline adoption rate. They are the gaps:
domains that publish DMARC but leave it at p=none and so block nothing; SPF records
that have quietly gone over the ten-lookup limit and therefore no longer work;
enforcement policies undermined by sp=none leaving every subdomain spoofable.
"""
import argparse
import json
import os
import sys
from collections import Counter, defaultdict

# ccTLD groupings for the regional cuts. Imperfect (a .com can be anywhere) but
# honest if stated: these are ccTLD-based, not geolocation-based.
REGIONS = {
    "Baltics": {"ee", "lv", "lt"},
    "Nordics": {"se", "no", "dk", "fi", "is"},
    "DACH": {"de", "at", "ch"},
    "India": {"in"},
    "UK": {"uk"},
    "France": {"fr"},
    "Benelux": {"nl", "be", "lu"},
    "Southern Europe": {"es", "it", "pt", "gr"},
    "CEE": {"pl", "cz", "sk", "hu", "ro", "bg", "si", "hr"},
    "Brazil": {"br"},
    "Japan": {"jp"},
    "Australia": {"au"},
}


def pct(n, d):
    return round(100.0 * n / d, 1) if d else 0.0


def summarise(rows, label):
    n = len(rows)
    if not n:
        return None
    spf = [r for r in rows if r.get("spf")]
    dmarc = [r for r in rows if r.get("dmarc")]
    enforcing = [r for r in dmarc if r.get("dmarc_p") in ("quarantine", "reject")]
    reject = [r for r in dmarc if r.get("dmarc_p") == "reject"]

    s = {
        "label": label,
        "domains": n,
        "with_mx": pct(sum(1 for r in rows if r.get("mx")), n),
        "spf": pct(len(spf), n),
        "dmarc": pct(len(dmarc), n),
        "dmarc_enforcing": pct(len(enforcing), n),
        "dmarc_reject": pct(len(reject), n),
        "mta_sts": pct(sum(1 for r in rows if r.get("mta_sts")), n),
        "tls_rpt": pct(sum(1 for r in rows if r.get("tls_rpt")), n),
        "bimi": pct(sum(1 for r in rows if r.get("bimi")), n),
    }

    # The failure modes, which are the actually interesting part.
    if dmarc:
        s["of_dmarc_still_p_none"] = pct(
            sum(1 for r in dmarc if r.get("dmarc_p") == "none"), len(dmarc))
        s["of_dmarc_no_rua"] = pct(
            sum(1 for r in dmarc if not r.get("dmarc_rua")), len(dmarc))
        s["of_dmarc_partial_pct"] = pct(
            sum(1 for r in dmarc if str(r.get("dmarc_pct", "100")) != "100"), len(dmarc))
        s["of_enforcing_with_sp_none"] = pct(
            sum(1 for r in enforcing if r.get("dmarc_sp") == "none"), len(enforcing))
    if spf:
        s["of_spf_over_lookup_limit"] = pct(
            sum(1 for r in spf if r.get("spf_over_limit")), len(spf))
        s["of_spf_plus_all"] = pct(
            sum(1 for r in spf if r.get("spf_all") == "+"), len(spf))
        s["of_spf_hard_fail"] = pct(
            sum(1 for r in spf if r.get("spf_all") == "-"), len(spf))
        s["of_spf_no_all"] = pct(
            sum(1 for r in spf if r.get("spf_all") is None), len(spf))
    return s


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("scan")
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args()

    rows = []
    for line in open(a.scan):
        try:
            rows.append(json.loads(line))
        except Exception:
            pass
    rows = [r for r in rows if not r.get("error")]

    out = {"global": summarise(rows, "Global")}

    # rank bands: the top of the list behaves very differently from the tail
    bands = [(1, 1000), (1001, 10000), (10001, 100000), (100001, 1000000)]
    out["by_rank"] = []
    for lo, hi in bands:
        sub = [r for r in rows if lo <= r.get("rank", 0) <= hi]
        s = summarise(sub, f"Rank {lo}-{hi}")
        if s:
            out["by_rank"].append(s)

    out["by_region"] = []
    for name, tlds in REGIONS.items():
        sub = [r for r in rows if r.get("tld") in tlds]
        s = summarise(sub, name)
        if s and s["domains"] >= 30:
            out["by_region"].append(s)
    out["by_region"].sort(key=lambda x: -x["dmarc"])

    if a.json:
        print(json.dumps(out, indent=1))
        return 0

    g = out["global"]
    print(f"\nEMAIL AUTHENTICATION ADOPTION")
    print(f"Sample: {g['domains']:,} domains from the Tranco top-1M list\n")
    print(f"  {'has MX':<26} {g['with_mx']:>6}%")
    print(f"  {'SPF published':<26} {g['spf']:>6}%")
    print(f"  {'DMARC published':<26} {g['dmarc']:>6}%")
    print(f"  {'DMARC at enforcement':<26} {g['dmarc_enforcing']:>6}%   (quarantine or reject)")
    print(f"  {'DMARC at p=reject':<26} {g['dmarc_reject']:>6}%")
    print(f"  {'MTA-STS':<26} {g['mta_sts']:>6}%")
    print(f"  {'TLS-RPT':<26} {g['tls_rpt']:>6}%")
    print(f"  {'BIMI':<26} {g['bimi']:>6}%")

    print(f"\nTHE GAPS (share of domains that publish the record at all)")
    for k, lab in [
        ("of_dmarc_still_p_none", "DMARC left at p=none, blocking nothing"),
        ("of_dmarc_no_rua", "DMARC with no rua, enforcing blind"),
        ("of_dmarc_partial_pct", "DMARC with pct below 100"),
        ("of_enforcing_with_sp_none", "enforcing but sp=none, subdomains open"),
        ("of_spf_over_lookup_limit", "SPF over the 10-lookup limit, permerror"),
        ("of_spf_plus_all", "SPF ending +all, authorising everyone"),
        ("of_spf_no_all", "SPF with no all mechanism"),
    ]:
        if k in g:
            print(f"  {lab:<48} {g[k]:>6}%")

    print(f"\nBY RANK BAND")
    print(f"  {'band':<22}{'domains':>9}{'SPF':>7}{'DMARC':>8}{'enforce':>9}{'MTA-STS':>9}")
    for s in out["by_rank"]:
        print(f"  {s['label']:<22}{s['domains']:>9,}{s['spf']:>7}{s['dmarc']:>8}"
              f"{s['dmarc_enforcing']:>9}{s['mta_sts']:>9}")

    print(f"\nBY REGION (ccTLD based)")
    print(f"  {'region':<20}{'domains':>9}{'SPF':>7}{'DMARC':>8}{'enforce':>9}{'MTA-STS':>9}")
    for s in out["by_region"]:
        print(f"  {s['label']:<20}{s['domains']:>9,}{s['spf']:>7}{s['dmarc']:>8}"
              f"{s['dmarc_enforcing']:>9}{s['mta_sts']:>9}")
    print()
    return 0


if __name__ == "__main__":
    sys.exit(main())
