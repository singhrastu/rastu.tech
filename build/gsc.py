#!/usr/bin/env python3
"""Read the Search Console API for rastu.tech.

    build/gsc.py sites                 what this account can see
    build/gsc.py queries [days]        top queries
    build/gsc.py pages [days]          top pages
    build/gsc.py near [days]           positions 5 to 20, the cheapest wins
    build/gsc.py inspect <url>         indexing state of one page

The key is read from a path and never printed. Set GSC_KEY to override the
default location; nothing here writes a credential anywhere.
"""
import datetime
import json
import os
import sys

from google.oauth2 import service_account
from googleapiclient.discovery import build as discovery

KEY = os.environ.get("GSC_KEY", os.path.expanduser("~/.config/gsc/rastu-tech-seo.json"))
# A domain property, not a URL prefix one: it covers every subdomain and both
# schemes, and the API needs it spelled this way or every call 403s.
SITE = os.environ.get("GSC_SITE", "sc-domain:rastu.tech")
SCOPE = ["https://www.googleapis.com/auth/webmasters.readonly"]


def service():
    if not os.path.exists(KEY):
        sys.exit(f"no credential at {KEY}. Set GSC_KEY to its path.")
    creds = service_account.Credentials.from_service_account_file(KEY, scopes=SCOPE)
    return discovery("searchconsole", "v1", credentials=creds, cache_discovery=False)


def window(days):
    end = datetime.date.today()
    return (end - datetime.timedelta(days=days)).isoformat(), end.isoformat()


def rows(svc, days, dimension, limit=200):
    start, end = window(days)
    body = {"startDate": start, "endDate": end,
            "dimensions": [dimension], "rowLimit": limit}
    res = svc.searchanalytics().query(siteUrl=SITE, body=body).execute()
    return res.get("rows", [])


def show(rs, label, limit=40):
    if not rs:
        print(f"  no {label} yet in this window")
        return
    print(f"  {'clicks':>6} {'impr':>6} {'ctr':>6} {'pos':>6}  {label}")
    for r in rs[:limit]:
        print(f"  {r['clicks']:>6.0f} {r['impressions']:>6.0f} "
              f"{r['ctr'] * 100:>5.1f}% {r['position']:>6.1f}  {r['keys'][0]}")


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else "queries"
    days = int(sys.argv[2]) if len(sys.argv) > 2 and sys.argv[2].isdigit() else 28
    svc = service()

    if cmd == "sites":
        for s in svc.sites().list().execute().get("siteEntry", []):
            print(f"  {s['permissionLevel']:<22} {s['siteUrl']}")
        return

    if cmd == "inspect":
        url = sys.argv[2]
        res = svc.urlInspection().index().inspect(body={
            "inspectionUrl": url, "siteUrl": SITE}).execute()
        r = res["inspectionResult"]["indexStatusResult"]
        print(f"  {url}")
        for k in ("verdict", "coverageState", "robotsTxtState", "indexingState",
                  "lastCrawlTime", "googleCanonical", "userCanonical"):
            if r.get(k):
                print(f"    {k:<18} {r[k]}")
        return

    if cmd == "pages":
        show(rows(svc, days, "page"), f"pages, last {days} days")
        return

    if cmd == "near":
        rs = [r for r in rows(svc, days, "query") if 5 <= r["position"] <= 20]
        rs.sort(key=lambda r: -r["impressions"])
        print(f"  queries ranking 5 to 20, last {days} days: the ones worth "
              f"a page or a better title")
        show(rs, "query")
        return

    show(rows(svc, days, "query"), f"queries, last {days} days")


if __name__ == "__main__":
    main()
