#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Deposit the survey dataset to Zenodo and mint a DOI.

    python3 research/zenodo.py --prepare     # create draft, upload files, set metadata
    python3 research/zenodo.py --show        # show the current draft
    python3 research/zenodo.py --publish     # IRREVERSIBLE: mints the DOI, public forever

Publishing is deliberately a separate command. A published Zenodo record cannot be
deleted, only superseded by a new version, so it should never happen as a side
effect of running a script.

Re-running the survey later: use --new-version against the concept DOI rather than
creating a fresh record, so all editions stay linked under one citable identifier.
"""
import argparse
import json
import os
import sys
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
ENV = os.path.expanduser("~/Documents/Resume/.env")
API = "https://zenodo.org/api"
STATE = os.path.join(HERE, "zenodo-state.json")

FILES = [
    (os.path.join(ROOT, "assets", "scan-100000.jsonl.gz"), "scan-100000.jsonl.gz"),
    (os.path.join(ROOT, "assets", "findings.json"), "findings.json"),
    (os.path.join(HERE, "scan.py"), "scan.py"),
    (os.path.join(HERE, "analyse.py"), "analyse.py"),
]


def token():
    for line in open(ENV):
        if line.startswith("ZENODO_TOKEN"):
            return line.split("=", 1)[1].strip()
    sys.exit("no ZENODO_TOKEN in " + ENV)


def call(method, path, data=None, raw=None, ctype="application/json"):
    url = f"{API}{path}{'&' if '?' in path else '?'}access_token={token()}"
    body = raw if raw is not None else (json.dumps(data).encode() if data else None)
    req = urllib.request.Request(url, data=body, method=method,
                                 headers={"Content-Type": ctype})
    try:
        with urllib.request.urlopen(req, timeout=300) as r:
            txt = r.read().decode()
            return json.loads(txt) if txt else {}
    except urllib.error.HTTPError as e:
        detail = e.read().decode()[:600]
        print(f"  HTTP {e.code}: {detail}", file=sys.stderr)
        return None


def metadata(n_domains=100000):
    return {"metadata": {
        "upload_type": "dataset",
        "title": "The State of Email Authentication 2026: SPF, DMARC, MTA-STS, "
                 "TLS-RPT and BIMI adoption across 100,000 domains",
        "creators": [{"name": "Singh, Rastu", "affiliation": "Independent",
                      "orcid": "0009-0002-0526-3005"}],
        "description": (
            "<p>A measurement of email authentication adoption across "
            f"{n_domains:,} domains sampled from the Tranco top-1M list "
            "(list ID V3YPN, generated 2026-09-17).</p>"
            "<p>The survey records, per domain: presence of MX; SPF including the "
            "RFC 7208 ten-lookup count and the all-qualifier; DMARC including policy "
            "strength, subdomain policy, pct and whether aggregate reporting is "
            "configured; MTA-STS; TLS-RPT; and BIMI.</p>"
            "<p><strong>Principal findings.</strong> 58.7% of domains publish a DMARC "
            "record but only 20.9% reach p=reject. 35.8% of those that publish DMARC "
            "leave it at p=none, where it blocks nothing. 20.8% of domains at "
            "enforcement publish no rua address and therefore enforce without "
            "visibility. 7.0% of enforcing domains set sp=none, leaving every "
            "subdomain unprotected. 3.4% of published SPF records exceed the ten "
            "DNS-lookup limit and therefore permerror, meaning they resolve correctly "
            "but no longer function. MTA-STS adoption is 2.0% and TLS-RPT 2.4%.</p>"
            "<p><strong>DKIM is deliberately not reported.</strong> DKIM selectors are "
            "arbitrary strings chosen by the sender, so probing a list of common "
            "selectors and finding nothing proves nothing. Any DKIM adoption figure "
            "derived that way is a lower bound at best and misleading at worst.</p>"
            "<p><strong>Limitations.</strong> DNS presence is not correctness: a "
            "published record may still be misconfigured in ways DNS cannot reveal. "
            "MTA-STS is counted on the DNS record alone; the policy file was not "
            "fetched for every domain, so the true enforcing figure is lower. "
            "Regional cuts are grouped by country-code TLD, which is a proxy for "
            "geography rather than a measurement of it.</p>"
            "<p>Includes the raw per-domain dataset as JSON Lines, the computed "
            "findings, and the scanning and analysis code so the work can be "
            "reproduced against the same Tranco list.</p>"
        ),
        "keywords": [
            "email authentication", "DMARC", "SPF", "MTA-STS", "TLS-RPT", "BIMI",
            "email security", "email deliverability", "DNS", "SMTP",
            "internet measurement", "Tranco",
        ],
        "license": "cc-by-4.0",
        "access_right": "open",
        "language": "eng",
        "related_identifiers": [
            {"relation": "isSupplementTo",
             "identifier": "https://rastu.tech/research/"},
            {"relation": "isCompiledBy",
             "identifier": "https://github.com/singhrastu/dmarcsight",
             "resource_type": "software"},
        ],
        "notes": "Sample derived from the Tranco list, ID V3YPN "
                 "(https://tranco-list.eu/list/V3YPN), generated 2026-09-17.",
    }}


def load_state():
    if os.path.exists(STATE):
        return json.load(open(STATE))
    return {}


def save_state(s):
    json.dump(s, open(STATE, "w"), indent=1)


def prepare(dep_id=None):
    st = load_state()
    dep_id = dep_id or st.get("draft_id")
    if dep_id:
        dep = call("GET", f"/deposit/depositions/{dep_id}")
        if not dep:
            dep_id = None
    if not dep_id:
        dep = call("POST", "/deposit/depositions", data={})
        if not dep:
            sys.exit("could not create draft")
        dep_id = dep["id"]
        print(f"  created draft {dep_id}")

    bucket = dep["links"]["bucket"]
    existing = {f["filename"] for f in dep.get("files", [])}
    for path, name in FILES:
        if not os.path.exists(path):
            print(f"  skip (missing): {name}")
            continue
        if name in existing:
            print(f"  already uploaded: {name}")
            continue
        with open(path, "rb") as fh:
            body = fh.read()
        url = f"{bucket}/{name}?access_token={token()}"
        req = urllib.request.Request(url, data=body, method="PUT",
                                     headers={"Content-Type": "application/octet-stream"})
        try:
            with urllib.request.urlopen(req, timeout=600) as r:
                r.read()
            print(f"  uploaded {name} ({len(body):,} bytes)")
        except urllib.error.HTTPError as e:
            print(f"  FAILED {name}: {e.code} {e.read().decode()[:200]}", file=sys.stderr)

    out = call("PUT", f"/deposit/depositions/{dep_id}", data=metadata())
    if out:
        print("  metadata set")
        st["draft_id"] = dep_id
        st["draft_url"] = out["links"].get("html")
        st["reserved_doi"] = (out.get("metadata", {}).get("prereserve_doi") or {}).get("doi")
        save_state(st)
        print(f"  draft: {st['draft_url']}")
    return dep_id


def show():
    st = load_state()
    if not st.get("draft_id"):
        sys.exit("no draft; run --prepare")
    dep = call("GET", f"/deposit/depositions/{st['draft_id']}")
    if not dep:
        sys.exit("could not fetch draft")
    m = dep.get("metadata", {})
    print(f"  id:        {dep['id']}")
    print(f"  state:     {dep.get('state')}  submitted={dep.get('submitted')}")
    print(f"  title:     {m.get('title','')[:80]}")
    print(f"  license:   {m.get('license')}")
    print(f"  doi:       {dep.get('doi') or (m.get('prereserve_doi') or {}).get('doi','(on publish)')}")
    print(f"  html:      {dep['links'].get('html')}")
    print(f"  files:     {len(dep.get('files', []))}")
    for f in dep.get("files", []):
        print(f"    {f['filename']}  {f.get('filesize', 0):,} bytes")


def publish():
    st = load_state()
    if not st.get("draft_id"):
        sys.exit("no draft; run --prepare")
    out = call("POST", f"/deposit/depositions/{st['draft_id']}/actions/publish")
    if not out:
        sys.exit("publish failed")
    st["doi"] = out.get("doi")
    st["published_url"] = out["links"].get("html")
    save_state(st)
    print(f"  PUBLISHED")
    print(f"  DOI: {st['doi']}")
    print(f"  URL: {st['published_url']}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--prepare", action="store_true")
    ap.add_argument("--show", action="store_true")
    ap.add_argument("--publish", action="store_true")
    a = ap.parse_args()
    if a.prepare:
        prepare()
    elif a.show:
        show()
    elif a.publish:
        publish()
    else:
        ap.print_help()
