#!/usr/bin/env python3
"""Push every URL in the sitemap to IndexNow.

Bing, Yandex and Seznam pick this up within minutes and no account is needed:
the only proof of ownership is that <key>.txt is reachable at the site root.
Google does not participate in IndexNow, so it still needs Search Console.

    python3 build/submit_indexnow.py
"""
import json, os, re, sys, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from build_site import SITE, INDEXNOW_KEY

sm = open(os.path.join(os.path.dirname(HERE), "site", "sitemap.xml")).read()
urls = re.findall(r"<loc>(.*?)</loc>", sm)

payload = json.dumps({
    "host": SITE.replace("https://", ""),
    "key": INDEXNOW_KEY,
    "keyLocation": f"{SITE}/{INDEXNOW_KEY}.txt",
    "urlList": urls,
}).encode()

req = urllib.request.Request(
    "https://api.indexnow.org/IndexNow", data=payload,
    headers={"Content-Type": "application/json; charset=utf-8"})
try:
    with urllib.request.urlopen(req, timeout=30) as r:
        print(f"submitted {len(urls)} urls -> HTTP {r.status}")
except urllib.error.HTTPError as ex:
    print(f"submitted {len(urls)} urls -> HTTP {ex.code} {ex.read().decode()[:200]}")
