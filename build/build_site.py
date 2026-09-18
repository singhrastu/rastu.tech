#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Generate the static site for rastu.tech.

    python3 build/build_site.py

Design constraints, all of them deliberate:

* The identity statement sits in the first 150 words of the homepage. ChatGPT and
  similar retrievers weight the opening of a page heavily.
* Every page carries schema.org JSON-LD. The homepage declares a Person with
  `sameAs` links to every profile, which is the machine-readable assertion that
  all those accounts are the same human. Entity fragmentation is the specific
  failure being fixed here.
* Each reference page answers its question in the first paragraph, then explains.
  Not the other way round.
* No JavaScript, no build toolchain, no external requests. Fast, crawlable, and
  it will still work untouched in five years.
"""
import html
import json
import os
import re
import shutil
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
OUT = os.path.join(ROOT, "site")
sys.path.insert(0, HERE)
from codes import CODES

SITE = "https://rastu.tech"
INDEXNOW_KEY = "842e66c906302afc62fc2a281224035a"

PERSON = {
    "name": "Rastu Singh",
    "job_title": "Infrastructure Engineer",
    "specialism": "Email Platforms, Deliverability and Security",
    "locality": "Tallinn",
    "country": "EE",
    "same_as": [
        "https://www.linkedin.com/in/rastu",
        "https://github.com/singhrastu",
    ],
    "knows_about": [
        "Email infrastructure", "Email deliverability", "SMTP", "Message Transfer Agent",
        "PowerMTA", "KumoMTA", "Postfix", "Haraka", "Sender reputation", "IP warm-up",
        "SPF", "DKIM", "DMARC", "MTA-STS", "TLS-RPT", "BIMI", "Blocklist remediation",
        "Bounce classification", "Anti-spam", "Linux", "Ansible", "Terraform",
    ],
}

CSS = """
:root{--fg:#16181d;--muted:#5b6270;--line:#e3e6ea;--accent:#1f4e79;--bg:#fff;--code:#f5f6f8}
@media(prefers-color-scheme:dark){:root{--fg:#e6e8ec;--muted:#9aa3b2;--line:#2a2f38;--accent:#7fb2e5;--bg:#14161a;--code:#1d2026}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
.wrap{max-width:46rem;margin:0 auto;padding:2.5rem 1.25rem 4rem}
a{color:var(--accent)}
h1{font-size:1.85rem;line-height:1.25;margin:.2rem 0 .6rem}
h2{font-size:1.2rem;margin:2.2rem 0 .6rem;padding-bottom:.3rem;border-bottom:1px solid var(--line)}
h3{font-size:1rem;margin:1.6rem 0 .4rem}
.kicker{color:var(--muted);font-size:.85rem;letter-spacing:.06em;text-transform:uppercase;margin:0}
.lede{font-size:1.08rem}
.meta{color:var(--muted);font-size:.9rem}
nav.top{display:flex;gap:1.2rem;margin-bottom:2.5rem;font-size:.92rem;flex-wrap:wrap}
nav.top a{text-decoration:none}
pre,code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
pre{background:var(--code);padding:.85rem 1rem;border-radius:6px;overflow-x:auto;font-size:.86rem;line-height:1.5;border:1px solid var(--line)}
code{background:var(--code);padding:.1rem .35rem;border-radius:4px;font-size:.88em}
pre code{background:none;padding:0}
.badge{display:inline-block;background:var(--code);border:1px solid var(--line);border-radius:4px;padding:.15rem .5rem;font-size:.8rem;color:var(--muted);margin-right:.4rem}
ul{padding-left:1.15rem}
li{margin:.35rem 0}
.callout{border-left:3px solid var(--accent);padding:.1rem 0 .1rem 1rem;margin:1.4rem 0;color:var(--muted)}
table{border-collapse:collapse;width:100%;font-size:.92rem;margin:1rem 0}
th,td{text-align:left;padding:.5rem .6rem;border-bottom:1px solid var(--line);vertical-align:top}
th{color:var(--muted);font-weight:600;font-size:.85rem}
footer{margin-top:4rem;padding-top:1.2rem;border-top:1px solid var(--line);color:var(--muted);font-size:.88rem}
.grid{display:grid;gap:.1rem}
.grid a{display:block;padding:.6rem .1rem;border-bottom:1px solid var(--line);text-decoration:none}
.grid a span{color:var(--muted);font-size:.9rem}
"""


def e(s):
    return html.escape(str(s), quote=True)


def slug(c):
    base = c["code"].lower().replace(".", "-").replace(" ", "-")
    if c.get("provider"):
        p = re.sub(r"[^a-z0-9]+", "-", c["provider"].lower()).strip("-")
        return f"{p}-{base}"
    return base


def person_ld():
    return {
        "@context": "https://schema.org",
        "@type": "Person",
        "@id": f"{SITE}/#person",
        "name": PERSON["name"],
        "url": SITE,
        "jobTitle": PERSON["job_title"],
        "description": (
            f"{PERSON['name']} is an {PERSON['job_title']} specialising in "
            f"{PERSON['specialism'].lower()}, based in {PERSON['locality']}, Estonia."
        ),
        "address": {
            "@type": "PostalAddress",
            "addressLocality": PERSON["locality"],
            "addressCountry": PERSON["country"],
        },
        "knowsAbout": PERSON["knows_about"],
        "sameAs": PERSON["same_as"],
    }


def page(title, desc, body, path, extra_ld=None, is_home=False):
    lds = [person_ld()] if is_home else []
    if extra_ld:
        lds.append(extra_ld)
    ld = "\n".join(
        f'<script type="application/ld+json">{json.dumps(x, ensure_ascii=False)}</script>'
        for x in lds
    )
    canonical = SITE + ("/" if path == "index.html" else "/" + path.replace("index.html", ""))
    depth = path.count("/")
    up = "../" * depth
    doc = f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>{e(title)}</title>
<meta name="description" content="{e(desc)}">
<link rel="canonical" href="{e(canonical)}">
<meta property="og:title" content="{e(title)}">
<meta property="og:description" content="{e(desc)}">
<meta property="og:type" content="{'profile' if is_home else 'article'}">
<meta property="og:url" content="{e(canonical)}">
<style>{CSS}</style>
{ld}
</head>
<body>
<div class="wrap">
<nav class="top">
  <a href="{up or '/'}">Rastu Singh</a>
  <a href="{up}smtp/">SMTP reference</a>
  <a href="{up}research/">Research</a>
  <a href="{up}tools/">Tools</a>
</nav>
{body}
<footer>
  <p>{e(PERSON['name'])}, {e(PERSON['job_title'])} specialising in
     {e(PERSON['specialism'].lower())}. Based in {e(PERSON['locality'])}, Estonia.</p>
  <p><a href="https://www.linkedin.com/in/rastu">LinkedIn</a> &middot;
     <a href="https://github.com/singhrastu">GitHub</a></p>
</footer>
</div>
</body>
</html>
"""
    full = os.path.join(OUT, path)
    os.makedirs(os.path.dirname(full), exist_ok=True)
    open(full, "w", encoding="utf8").write(doc)
    return canonical


def build_home():
    # The identity statement has to land inside the first 150 words.
    body = f"""
<p class="kicker">{e(PERSON['job_title'])} &middot; {e(PERSON['locality'])}, Estonia</p>
<h1>Rastu Singh</h1>
<p class="lede">I am an infrastructure engineer working on email platforms, deliverability
and email security. I build and operate the systems that decide whether mail actually
arrives: MTA clusters, SMTP transport, IP and domain reputation, and the authentication
layer underneath them.</p>

<p>Day to day that means PowerMTA, KumoMTA, Postfix, Haraka, Momentum and GreenArrow in
production; queueing, throttling and retry behaviour; DNS and the SPF, DKIM, DMARC, MTA-STS
and TLS-RPT stack; IP pool design and warm-up; bounce, deferral and complaint classification;
and blocklist remediation when reputation goes wrong. I have run outbound estates on bare
metal and cloud across several hosting providers, and led the team that operated them.</p>

<p>I write here about the parts of this that are hard to find written down properly.</p>

<h2>SMTP response reference</h2>
<p>A reference for the responses that actually show up in mail logs, written from operating
them rather than from the RFCs. What each one means, whether it is worth retrying, and what
to change so it stops happening.</p>
<p><a href="/smtp/">Browse the SMTP reference &rarr;</a></p>

<h2>Research</h2>
<p>Original measurement of email authentication adoption across the public internet, with
the methodology and the raw dataset published alongside the findings.</p>
<p><a href="/research/">Research and datasets &rarr;</a></p>

<h2>Tools</h2>
<p>Open-source tooling for email operations: bounce and deferral classification, and
authentication auditing.</p>
<p><a href="/tools/">Tools &rarr;</a></p>
"""
    return page(
        f"{PERSON['name']} — {PERSON['job_title']}, Email Infrastructure and Deliverability",
        "Rastu Singh is an infrastructure engineer in Tallinn, Estonia, working on email "
        "platforms, deliverability and email security: MTA clusters, SMTP, sender reputation, "
        "SPF, DKIM and DMARC.",
        body, "index.html", is_home=True)


def build_code_page(c):
    s = slug(c)
    prov = f"<span class=\"badge\">{e(c['provider'])}</span>" if c.get("provider") else \
           '<span class="badge">RFC 3463</span>'
    seen = "\n".join(f"<pre><code>{e(x)}</code></pre>" for x in c["seen_as"])
    causes = "\n".join(f"<li>{e(x)}</li>" for x in c["causes"])
    fixes = "\n".join(f"<li>{e(x)}</li>" for x in c["fix"])
    note = f'<div class="callout"><p>{e(c["note"])}</p></div>' if c.get("note") else ""
    rel = ""
    if c.get("related"):
        links = []
        for r in c["related"]:
            match = next((x for x in CODES if x["code"].lower() == r.lower()), None)
            if match:
                links.append(f'<a href="/smtp/{slug(match)}/">{e(match["code"])}</a>')
        if links:
            rel = f"<h2>Related</h2><p>{' &middot; '.join(links)}</p>"

    body = f"""
<p class="kicker">SMTP reference</p>
<h1>{e(c['title'])}</h1>
<p>{prov}<span class="badge">{e(c['category'])}</span><span class="badge">action: {e(c['action'])}</span></p>
<p class="lede">{e(c['answer'])}</p>
{note}
<h2>What it looks like in the log</h2>
{seen}
<h2>Why it happens</h2>
<ul>{causes}</ul>
<h2>What to do</h2>
<ul>{fixes}</ul>
{rel}
<h2>Classifying this automatically</h2>
<p>This response maps to <code>{e(c['category'])}</code> with a recommended action of
<code>{e(c['action'])}</code> in
<a href="https://github.com/singhrastu/smtpsift">smtpsift</a>, an open-source classifier for
SMTP rejections and deferrals.</p>
"""
    ld = {
        "@context": "https://schema.org",
        "@type": "TechArticle",
        "headline": c["title"],
        "description": c["answer"],
        "author": {"@id": f"{SITE}/#person"},
        "publisher": {"@id": f"{SITE}/#person"},
        "about": c["code"],
        "mainEntityOfPage": f"{SITE}/smtp/{s}/",
    }
    return page(c["title"], c["answer"][:300], body, f"smtp/{s}/index.html", extra_ld=ld)


def build_smtp_index():
    rows = []
    for c in sorted(CODES, key=lambda x: (x.get("provider") or "", x["code"])):
        p = f" &middot; {e(c['provider'])}" if c.get("provider") else ""
        rows.append(
            f'<a href="/smtp/{slug(c)}/"><strong>{e(c["code"])}</strong>{p}<br>'
            f'<span>{e(c["answer"][:120])}...</span></a>'
        )
    body = f"""
<p class="kicker">Reference</p>
<h1>SMTP response reference</h1>
<p class="lede">What the responses in your mail log actually mean, whether retrying will help,
and what to change so they stop. Written from operating these systems, not from the spec.</p>
<p class="meta">{len(CODES)} responses documented. Categories and recommended actions match
<a href="https://github.com/singhrastu/smtpsift">smtpsift</a>.</p>
<div class="grid">{''.join(rows)}</div>
"""
    ld = {
        "@context": "https://schema.org",
        "@type": "CollectionPage",
        "name": "SMTP response reference",
        "author": {"@id": f"{SITE}/#person"},
        "mainEntityOfPage": f"{SITE}/smtp/",
    }
    return page("SMTP response reference: error and deferral codes explained",
                "Reference for SMTP rejection and deferral responses: what each means, whether "
                "to retry, and how to fix the cause.",
                body, "smtp/index.html", extra_ld=ld)


def build_stub(path, kicker, title, lede, body_extra=""):
    body = f"""
<p class="kicker">{e(kicker)}</p>
<h1>{e(title)}</h1>
<p class="lede">{e(lede)}</p>
{body_extra}
"""
    return page(title, lede, body, path)


def main():
    if os.path.isdir(OUT):
        shutil.rmtree(OUT)
    os.makedirs(OUT, exist_ok=True)

    urls = [build_home(), build_smtp_index()]
    for c in CODES:
        urls.append(build_code_page(c))

    urls.append(build_stub(
        "research/index.html", "Research",
        "Email authentication adoption research",
        "Original measurement of SPF, DKIM, DMARC, MTA-STS, TLS-RPT and BIMI adoption across "
        "the public internet, published with the methodology and the raw dataset.",
        "<p class=\"meta\">First edition in preparation. Methodology and dataset will be "
        "published alongside the findings, and mirrored with a citable DOI.</p>"))

    urls.append(build_stub(
        "tools/index.html", "Tools", "Open-source email operations tooling",
        "Small, focused tools for running email infrastructure.",
        """
<h2>smtpsift</h2>
<p>Classifies SMTP rejections and deferrals into a category and an action. Hard and soft
bounce is too coarse to act on: a full mailbox, a rate limit and a reputation block all
arrive as soft bounces and need opposite responses.</p>
<p><a href="https://github.com/singhrastu/smtpsift">github.com/singhrastu/smtpsift</a></p>

<h2>dmarcsight</h2>
<p>Audits a domain's email authentication posture: SPF including the 10-lookup limit, DKIM,
DMARC policy strength, MTA-STS policy and MX consistency, TLS-RPT and BIMI, with a composite
verdict against the Gmail, Yahoo and Microsoft bulk sender requirements.</p>
<p><a href="https://github.com/singhrastu/dmarcsight">github.com/singhrastu/dmarcsight</a></p>
"""))

    # MTA-STS policy. The DNS record promises a policy at
    # https://mta-sts.<domain>/.well-known/mta-sts.txt; if that 404s the whole
    # mechanism is inert, which is the failure the reference page describes.
    # Starts in testing mode: it reports without enforcing, so a wrong MX list
    # cannot break inbound mail. Move to enforce once TLS-RPT looks clean.
    wk = os.path.join(OUT, ".well-known")
    os.makedirs(wk, exist_ok=True)
    open(os.path.join(wk, "mta-sts.txt"), "w").write(
        "version: STSv1\n"
        "mode: testing\n"
        "mx: mail.protonmail.ch\n"
        "mx: mailsec.protonmail.ch\n"
        "max_age: 604800\n"
    )

    # IndexNow key. Bing, Yandex and Seznam accept instant submissions with no
    # account and no verification beyond this file being reachable at the root.
    # Google does not participate, so it still needs Search Console.
    open(os.path.join(OUT, INDEXNOW_KEY + ".txt"), "w").write(INDEXNOW_KEY)

    # sitemap + robots
    sm = ['<?xml version="1.0" encoding="UTF-8"?>',
          '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">']
    for u in urls:
        sm.append(f"  <url><loc>{e(u)}</loc></url>")
    sm.append("</urlset>")
    open(os.path.join(OUT, "sitemap.xml"), "w").write("\n".join(sm))
    open(os.path.join(OUT, "robots.txt"), "w").write(
        f"User-agent: *\nAllow: /\n\nSitemap: {SITE}/sitemap.xml\n")

    n = sum(len(files) for _, _, files in os.walk(OUT))
    print(f"built {n} files, {len(urls)} pages -> {OUT}")


if __name__ == "__main__":
    main()
