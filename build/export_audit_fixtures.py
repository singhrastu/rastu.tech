#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Generate parity fixtures for the in-browser auditor.

    python3 build/export_audit_fixtures.py

The site runs a JavaScript port of dmarcsight so the audit happens in the
visitor's browser and no domain is ever sent to this server. Two implementations
of the same logic will drift, so this pins them together: each scenario below is
run through the real Python package, and the findings it produces become the
expected output. build/parity.mjs replays the same scenarios against the JS port
and fails the build on any difference.

Add a scenario here whenever a check gains a branch.
"""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "audit_fixtures.json")
sys.path.insert(0, os.path.expanduser("~/Documents/Projects/dmarcsight"))

try:
    from dmarcsight import audit
    from dmarcsight.dnsq import FixtureResolver
except ImportError:
    sys.exit("dmarcsight not found; the fixture snapshot at " + OUT + " stands")

D = "example.com"
KEY2048 = "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA" + "a" * 348
KEY1024 = "MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQ" + "b" * 180
KEYSHORT = "MIGfMA0GCSqGSIb3DQ" + "c" * 30

MANY_INCLUDES = {D: ["v=spf1 " + " ".join(f"include:i{n}.test" for n in range(11)) + " -all"]}
for n in range(11):
    MANY_INCLUDES[f"i{n}.test"] = ["v=spf1 ip4:10.0.0.1 -all"]

SCENARIOS = [
    ("bare domain, nothing published", {}, {}, {}, None),
    ("spf plus all", {D: ["v=spf1 +all"]}, {}, {}, None),
    ("spf neutral", {D: ["v=spf1 ?all"]}, {}, {}, None),
    ("spf softfail", {D: ["v=spf1 ip4:1.2.3.4 ~all"]}, {}, {}, None),
    ("spf no all mechanism", {D: ["v=spf1 ip4:1.2.3.4"]}, {}, {}, None),
    ("spf with ptr", {D: ["v=spf1 ptr -all"]}, {}, {}, None),
    ("two spf records", {D: ["v=spf1 -all", "v=spf1 ip4:1.2.3.4 -all"]}, {}, {}, None),
    ("spf over the lookup limit", MANY_INCLUDES, {}, {}, None),
    ("spf include loop", {D: ["v=spf1 include:a.test -all"],
                          "a.test": ["v=spf1 include:b.test -all"],
                          "b.test": ["v=spf1 include:a.test -all"]}, {}, {}, None),
    ("dmarc reject with rua", {D: ["v=spf1 -all"],
        f"_dmarc.{D}": ["v=DMARC1; p=reject; rua=mailto:d@example.com"]}, {}, {}, None),
    ("dmarc quarantine, sp=none", {D: ["v=spf1 -all"],
        f"_dmarc.{D}": ["v=DMARC1; p=quarantine; sp=none; rua=mailto:d@example.com"]}, {}, {}, None),
    ("dmarc none, no rua, partial pct", {D: ["v=spf1 -all"],
        f"_dmarc.{D}": ["v=DMARC1; p=none; pct=20"]}, {}, {}, None),
    ("dmarc strict alignment", {D: ["v=spf1 -all"],
        f"_dmarc.{D}": ["v=DMARC1; p=reject; adkim=s; aspf=s; rua=mailto:d@example.com"]}, {}, {}, None),
    ("dmarc bad policy tag", {D: ["v=spf1 -all"],
        f"_dmarc.{D}": ["v=DMARC1; rua=mailto:d@example.com"]}, {}, {}, None),
    ("two dmarc records", {D: ["v=spf1 -all"],
        f"_dmarc.{D}": ["v=DMARC1; p=none", "v=DMARC1; p=reject"]}, {}, {}, None),
    ("dkim 2048", {f"default._domainkey.{D}": [f"v=DKIM1; k=rsa; p={KEY2048}"]}, {}, {}, None),
    ("dkim 1024", {f"selector1._domainkey.{D}": [f"v=DKIM1; k=rsa; p={KEY1024}"]}, {}, {}, None),
    ("dkim short key", {f"k1._domainkey.{D}": [f"v=DKIM1; k=rsa; p={KEYSHORT}"]}, {}, {}, None),
    ("dkim revoked", {f"google._domainkey.{D}": ["v=DKIM1; k=rsa; p="]}, {}, {}, None),
    ("mta-sts dns only, policy unreachable",
     {f"_mta-sts.{D}": ["v=STSv1; id=20260101"]}, {}, {}, None),
    ("tls-rpt and bimi present",
     {f"_smtp._tls.{D}": ["v=TLSRPTv1; rua=mailto:t@example.com"],
      f"default._bimi.{D}": ["v=BIMI1; l=https://example.com/logo.svg"]}, {}, {}, None),
    ("bimi with vmc",
     {f"default._bimi.{D}": ["v=BIMI1; l=https://example.com/logo.svg; a=https://example.com/vmc.pem"]},
     {}, {}, None),
    ("mx present and resolving", {}, {D: [(10, "mx1.example.net")]},
     {"mx1.example.net": ["192.0.2.1"]}, None),
    ("mx pointing nowhere", {}, {D: [(10, "dead.example.net")]}, {}, None),
    ("fully compliant sender",
     {D: ["v=spf1 ip4:192.0.2.0/24 -all"],
      f"_dmarc.{D}": ["v=DMARC1; p=reject; rua=mailto:d@example.com"],
      f"default._domainkey.{D}": [f"v=DKIM1; k=rsa; p={KEY2048}"],
      f"_smtp._tls.{D}": ["v=TLSRPTv1; rua=mailto:t@example.com"]},
     {D: [(10, "mx1.example.net")]}, {"mx1.example.net": ["192.0.2.1"]}, None),
    ("explicit selector", {f"mysel._domainkey.{D}": [f"v=DKIM1; k=rsa; p={KEY2048}"]},
     {}, {}, ["mysel"]),
]


def no_fetch(url, timeout=6):
    # Parity is about the check logic, not the network. The JS harness stubs the
    # same way, so both sides take the "policy unreachable" branch identically.
    return None, "fetch disabled in fixtures"


out = []
for name, txt, mx, a, selectors in SCENARIOS:
    rep = audit(D, resolver=FixtureResolver(txt=txt, mx=mx, a=a),
                fetch=no_fetch, selectors=selectors)
    out.append({
        "name": name,
        "txt": txt,
        "mx": {k: [list(p) for p in v] for k, v in mx.items()},
        "a": a,
        "selectors": selectors,
        "expected": [[f.check, f.severity, f.finding, f.remediation, f.detail]
                     for f in rep.findings],
    })

json.dump(out, open(OUT, "w", encoding="utf8"), indent=1, ensure_ascii=False)
print(f"{len(out)} scenarios, {sum(len(s['expected']) for s in out)} findings -> {OUT}")
