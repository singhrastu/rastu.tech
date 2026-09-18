#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Track whether any of this is actually working.

    python3 track/visibility.py            # run, record, email if anything changed
    python3 track/visibility.py --dry      # print only
    python3 track/visibility.py --report   # full history summary

Three questions, because they fail independently:

  1. Are the AI crawlers actually fetching the site? Cloudflare analytics knows.
     A crawler that never visits cannot cite you, and this is the only place that
     fact is visible.
  2. Is the site indexed and ranking for the target queries?
  3. Do the stale Adobe/Bengaluru pages still outrank it? That was the original
     diagnosis, so it is the thing that has to change.

Deliberately no LLM in the loop: this measures, it does not judge. Same pattern as
job_radar.py, for the same reason - a measurement you cannot trust is worse than none.
"""
import argparse
import datetime
import json
import os
import re
import ssl
import sys
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
STATE = os.path.join(HERE, "history.json")
ENV = os.path.expanduser("~/Documents/Resume/.env")
ZONE = "02f48e03164985e63919e01fae265c1f"
SITE = "rastu.tech"
TO = "singhrastu@gmail.com"
FROM = "jobs@zerosmtp.net"

# The crawlers that matter. If these never appear, nothing downstream can work.
AI_CRAWLERS = [
    "GPTBot", "OAI-SearchBot", "ChatGPT-User",      # OpenAI
    "ClaudeBot", "Claude-Web", "anthropic-ai",       # Anthropic
    "PerplexityBot", "Perplexity-User",              # Perplexity
    "Google-Extended", "Googlebot",                  # Google
    "bingbot",                                       # Microsoft / Copilot
    "Amazonbot", "Applebot", "meta-externalagent",
    "CCBot",                                         # Common Crawl, feeds training sets
]

# What he actually wants to rank for. Regional and unqualified, because the goal
# is global rather than Baltic.
QUERIES = [
    "email deliverability expert Estonia",
    "email infrastructure engineer Estonia",
    "email deliverability expert Baltics",
    "best email deliverability experts",
    "email infrastructure consultant Europe",
    "SMTP infrastructure expert",
    "email deliverability expert India",
    "Rastu Singh",
]

# Pages that currently outrank him and describe him as Adobe / Bengaluru.
STALE = ["peerspot.com", "rocketreach.co"]


def env(key):
    if os.path.exists(ENV):
        for line in open(ENV):
            if line.startswith(key):
                return line.split("=", 1)[1].strip()
    return ""


def get(url, headers=None, timeout=25, data=None):
    h = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                       "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36"}
    if headers:
        h.update(headers)
    req = urllib.request.Request(url, data=data, headers=h)
    try:
        with urllib.request.urlopen(req, timeout=timeout,
                                    context=ssl.create_default_context()) as r:
            return r.read().decode("utf8", "replace")
    except Exception:
        return ""


# ------------------------------------------------------------------ crawlers
def crawler_hits(days=7):
    """Which crawlers fetched the site, from Cloudflare analytics."""
    tok = env("CLOUDFLARE_TOKEN") or env("CLOUDFLARE_API_TOKEN")
    if not tok:
        return {}
    since = (datetime.datetime.utcnow()
             - datetime.timedelta(days=days)).strftime("%Y-%m-%dT%H:%M:%SZ")
    q = {
        "query": """query($zone:String!,$since:Time!){viewer{zones(filter:{zoneTag:$zone}){
             httpRequestsAdaptiveGroups(limit:200,filter:{datetime_geq:$since},
             orderBy:[count_DESC]){count dimensions{userAgent}}}}}""",
        "variables": {"zone": ZONE, "since": since},
    }
    raw = get("https://api.cloudflare.com/client/v4/graphql",
              headers={"Authorization": f"Bearer {tok}",
                       "Content-Type": "application/json"},
              data=json.dumps(q).encode(), timeout=40)
    try:
        d = json.loads(raw)
        rows = d["data"]["viewer"]["zones"][0]["httpRequestsAdaptiveGroups"]
    except Exception:
        return {}
    out = {}
    for r in rows:
        ua = r["dimensions"]["userAgent"] or ""
        for name in AI_CRAWLERS:
            if name.lower() in ua.lower():
                out[name] = out.get(name, 0) + r["count"]
    return out


# ------------------------------------------------------------------- ranking
def ddg_results(query, limit=30):
    """DuckDuckGo HTML endpoint. Not Google, but it is scriptable, stable, and
    good enough to see movement. Google rank needs Search Console, which is
    manual."""
    html = get("https://duckduckgo.com/html/?q=" + urllib.parse.quote(query))
    if not html:
        return []
    hits = re.findall(r'uddg=([^&"]+)', html)
    out = []
    for h in hits[:limit]:
        try:
            out.append(urllib.parse.unquote(h))
        except Exception:
            pass
    return out


def rank_of(results, needle):
    for i, u in enumerate(results, 1):
        if needle in u:
            return i
    return None


def check_queries():
    out = {}
    for q in QUERIES:
        res = ddg_results(q)
        out[q] = {
            "site_rank": rank_of(res, SITE),
            "linkedin_rank": rank_of(res, "linkedin.com/in/rastu"),
            "github_rank": rank_of(res, "github.com/singhrastu"),
            "stale": {s: rank_of(res, s) for s in STALE
                      if rank_of(res, s) is not None},
            "results": len(res),
        }
    return out


def indexed_pages():
    res = ddg_results(f"site:{SITE}", limit=50)
    return len([u for u in res if SITE in u])


# --------------------------------------------------------------------- email
def send(subject, text):
    tok = env("MAILTRAP_TOKEN")
    if not tok:
        print("no MAILTRAP_TOKEN, skipping email", file=sys.stderr)
        return False
    payload = json.dumps({
        "from": {"email": FROM, "name": "Visibility Tracker"},
        "to": [{"email": TO}], "subject": subject,
        "text": text, "category": "visibility",
    }).encode()
    raw = get("https://send.api.mailtrap.io/api/send",
              headers={"Authorization": f"Bearer {tok}",
                       "Content-Type": "application/json"},
              data=payload, timeout=30)
    return '"success":true' in raw.replace(" ", "")


# ---------------------------------------------------------------------- main
def snapshot():
    return {
        "date": datetime.date.today().isoformat(),
        "crawlers": crawler_hits(),
        "queries": check_queries(),
        "indexed": indexed_pages(),
    }


def render(cur, prev):
    L = [f"Visibility check, {cur['date']}", ""]

    L.append("AI CRAWLERS (last 7 days)")
    if cur["crawlers"]:
        for name, n in sorted(cur["crawlers"].items(), key=lambda x: -x[1]):
            was = (prev or {}).get("crawlers", {}).get(name)
            delta = f"  (was {was})" if was is not None and was != n else ""
            L.append(f"  {name:22} {n:6}{delta}")
    else:
        L.append("  none recorded")
    missing = [c for c in AI_CRAWLERS if c not in cur["crawlers"]]
    if missing:
        L.append(f"  not seen yet: {', '.join(missing)}")

    L += ["", f"INDEXED PAGES: {cur['indexed']}" +
          (f"  (was {prev['indexed']})" if prev else "")]

    L += ["", "QUERY RANKING (DuckDuckGo)"]
    for q, d in cur["queries"].items():
        r = d["site_rank"]
        pr = (prev or {}).get("queries", {}).get(q, {}).get("site_rank")
        arrow = ""
        if pr != r:
            arrow = f"  (was {pr if pr else 'unranked'})"
        L.append(f"  {q}")
        L.append(f"    rastu.tech: {r if r else 'not in top 30'}{arrow}"
                 f"   linkedin: {d['linkedin_rank'] or '-'}"
                 f"   github: {d['github_rank'] or '-'}")
        if d["stale"]:
            L.append(f"    STALE STILL RANKING: {d['stale']}")

    return "\n".join(L)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry", action="store_true")
    ap.add_argument("--report", action="store_true")
    a = ap.parse_args()

    hist = []
    if os.path.exists(STATE):
        try:
            hist = json.load(open(STATE))
        except Exception:
            pass

    if a.report:
        for h in hist:
            print(f"{h['date']}  indexed={h['indexed']:3}  "
                  f"crawlers={sum(h['crawlers'].values())}")
        return 0

    cur = snapshot()
    prev = hist[-1] if hist else None
    body = render(cur, prev)
    print(body)

    if a.dry:
        return 0

    hist.append(cur)
    json.dump(hist, open(STATE, "w"), indent=1)

    changed = (not prev or cur["indexed"] != prev["indexed"]
               or cur["crawlers"] != prev["crawlers"]
               or any(cur["queries"][q]["site_rank"] != prev["queries"].get(q, {}).get("site_rank")
                      for q in cur["queries"]))
    if changed:
        send(f"Visibility {cur['date']}: {cur['indexed']} indexed, "
             f"{len(cur['crawlers'])} crawlers", body)
    return 0


if __name__ == "__main__":
    sys.exit(main())
