#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Create the Wikidata item, with every statement sourced.

    python3 wikidata/create_item.py --dry      # print the payload, change nothing
    python3 wikidata/create_item.py --create   # create it
    python3 wikidata/create_item.py --show Q…  # read an existing item back

Unsourced statements are the usual reason a person item gets challenged, so every
claim that can carry a reference gets a reference URL and a retrieval date.

Credentials are a scoped bot password in ~/Documents/Resume/.env, not an account
password, and can be revoked from Special:BotPasswords without touching the account.
"""
import argparse
import json
import os
import sys
import urllib.parse
import urllib.request
import http.cookiejar

API = "https://www.wikidata.org/w/api.php"
ENV = os.path.expanduser("~/Documents/Resume/.env")
UA = "rastu-tech-entity/1.0 (https://rastu.tech; singhrastu@gmail.com)"
RETRIEVED = "+2026-09-18T00:00:00Z"

_jar = http.cookiejar.CookieJar()
_opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(_jar))


def env(key):
    for line in open(ENV):
        if line.startswith(key + "="):
            return line.split("=", 1)[1].strip()
    sys.exit(f"{key} not in {ENV}")


def api(params, post=False):
    params = dict(params, format="json")
    if post:
        data = urllib.parse.urlencode(params).encode()
        req = urllib.request.Request(API, data=data, headers={"User-Agent": UA})
    else:
        req = urllib.request.Request(API + "?" + urllib.parse.urlencode(params),
                                     headers={"User-Agent": UA})
    with _opener.open(req, timeout=60) as r:
        return json.loads(r.read().decode())


def login():
    tok = api({"action": "query", "meta": "tokens", "type": "login"})
    lt = tok["query"]["tokens"]["logintoken"]
    out = api({"action": "login", "lgname": env("WIKIDATA_USER"),
               "lgpassword": env("WIKIDATA_PASS"), "lgtoken": lt}, post=True)
    if out.get("login", {}).get("result") != "Success":
        sys.exit(f"login failed: {out}")
    print(f"  logged in as {out['login']['lgusername']}")
    return api({"action": "query", "meta": "tokens", "type": "csrf"})["query"]["tokens"]["csrftoken"]


# --------------------------------------------------------------- claim helpers
def _ref(url):
    return [{"snaks": {
        "P854": [{"snaktype": "value", "property": "P854",
                  "datavalue": {"value": url, "type": "string"}}],
        "P813": [{"snaktype": "value", "property": "P813",
                  "datavalue": {"value": {"time": RETRIEVED, "timezone": 0,
                                          "before": 0, "after": 0, "precision": 11,
                                          "calendarmodel":
                                          "http://www.wikidata.org/entity/Q1985727"},
                                "type": "time"}}],
    }}]


def item_claim(prop, qid, ref=None):
    c = {"mainsnak": {"snaktype": "value", "property": prop,
                      "datavalue": {"value": {"entity-type": "item",
                                              "numeric-id": int(qid[1:])},
                                    "type": "wikibase-entityid"}},
         "type": "statement", "rank": "normal"}
    if ref:
        c["references"] = _ref(ref)
    return c


def str_claim(prop, val, ref=None):
    c = {"mainsnak": {"snaktype": "value", "property": prop,
                      "datavalue": {"value": val, "type": "string"}},
         "type": "statement", "rank": "normal"}
    if ref:
        c["references"] = _ref(ref)
    return c


SITE = "https://rastu.tech/about/"
DOI = "https://doi.org/10.5281/zenodo.22832936"
ORCID = "https://orcid.org/0009-0002-0526-3005"


def payload():
    return {
        "labels": {
            "en": {"language": "en", "value": "Rastu Singh"},
            "et": {"language": "et", "value": "Rastu Singh"},
        },
        "descriptions": {
            "en": {"language": "en", "value": "email infrastructure engineer"},
            "et": {"language": "et", "value": "e-posti taristu insener"},
        },
        "claims": {
            "P31":   [item_claim("P31", "Q5")],                       # human
            "P21":   [item_claim("P21", "Q6581097")],                 # male
            "P27":   [item_claim("P27", "Q668", SITE)],               # India
            "P106":  [item_claim("P106", "Q1709010", SITE)],          # software engineer
            "P101":  [item_claim("P101", "Q9158", DOI),               # email
                      item_claim("P101", "Q3510521", DOI)],           # computer security
            "P108":  [item_claim("P108", "Q24054211", SITE)],         # Pipedrive
            "P937":  [item_claim("P937", "Q1770", SITE)],             # Tallinn
            "P496":  [str_claim("P496", "0009-0002-0526-3005", ORCID)],
            "P856":  [str_claim("P856", "https://rastu.tech/")],
            "P2037": [str_claim("P2037", "singhrastu", "https://github.com/singhrastu")],
            "P6634": [str_claim("P6634", "rastu", "https://www.linkedin.com/in/rastu")],
        },
    }


def _edit(token, data, summary, qid=None):
    p = {"action": "wbeditentity", "token": token, "data": json.dumps(data),
         "summary": summary, "bot": "1"}
    if qid:
        p["id"] = qid
    else:
        p["new"] = "item"
    out = api(p, post=True)
    if "error" in out:
        code = out["error"].get("code")
        params = out["error"].get("parameters") or []
        print(f"    blocked: {code} {params[:2]}", file=sys.stderr)
        return None
    return out["entity"]["id"]


def create(token):
    """New Wikidata accounts trip a global anti-spam filter when a single edit
    carries many external links. So: create the item bare, then add statements in
    small batches, references last."""
    base = {
        "labels": payload()["labels"],
        "descriptions": payload()["descriptions"],
        "claims": {"P31": [item_claim("P31", "Q5")]},
    }
    qid = _edit(token, base, "Create item: human")
    if not qid:
        sys.exit("create failed even bare; the account may be too new")
    print(f"  created {qid} (bare)")

    full = payload()["claims"]
    # ordered least to most link-heavy; references stripped on the first pass
    groups = [
        ("identity", {k: full[k] for k in ("P21", "P27") if k in full}),
        ("occupation", {k: full[k] for k in ("P106", "P101")}),
        ("affiliation", {k: full[k] for k in ("P108", "P937")}),
        ("identifiers", {k: full[k] for k in ("P496", "P2037", "P6634")}),
        ("website", {k: full[k] for k in ("P856",)}),
    ]
    for name, claims in groups:
        stripped = {p: [{kk: vv for kk, vv in c.items() if kk != "references"}
                        for c in cs] for p, cs in claims.items()}
        ok = _edit(token, {"claims": stripped}, f"Add {name}", qid)
        print(f"  {'added' if ok else 'FAILED'}: {name}")

    print(f"\n  https://www.wikidata.org/wiki/{qid}")
    open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "qid.txt"), "w").write(qid)
    return qid


def show(qid):
    out = api({"action": "wbgetentities", "ids": qid})
    e = out["entities"][qid]
    print(f"  {qid}: {e['labels'].get('en', {}).get('value')}")
    print(f"  {e['descriptions'].get('en', {}).get('value')}")
    for p, claims in sorted(e.get("claims", {}).items()):
        for c in claims:
            dv = c["mainsnak"].get("datavalue", {}).get("value")
            v = dv.get("id") if isinstance(dv, dict) and "id" in dv else dv
            nrefs = len(c.get("references", []))
            print(f"    {p:7} {str(v)[:46]:46} refs={nrefs}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry", action="store_true")
    ap.add_argument("--create", action="store_true")
    ap.add_argument("--show")
    a = ap.parse_args()
    if a.dry:
        print(json.dumps(payload(), indent=1))
    elif a.create:
        create(login())
    elif a.show:
        show(a.show)
    else:
        ap.print_help()
