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
TRANCO_LIST_ID = "V3YPN"
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
        "https://orcid.org/0009-0002-0526-3005",
    ],
    "orcid": "0009-0002-0526-3005",
    "knows_about": [
        "Email infrastructure", "Email deliverability", "Email security", "SMTP",
        "Message Transfer Agent", "MTA", "PowerMTA", "KumoMTA", "Postfix", "Haraka",
        "Momentum", "GreenArrow", "Sender reputation", "IP reputation", "IP warm-up",
        "Domain warm-up", "Inbox placement", "SPF", "DKIM", "DMARC", "ARC", "MTA-STS",
        "TLS-RPT", "BIMI", "Blocklist remediation", "Spamhaus", "Bounce classification",
        "Deferral handling", "Feedback loops", "Anti-spam", "SpamAssassin", "Rspamd",
        "Email authentication", "Bulk email", "High-volume email sending",
        "Mail relay", "DNS", "Linux", "Ansible", "Terraform", "Prometheus",
    ],
    # Job titles he should surface for. schema.org accepts a list here.
    "titles": [
        "Infrastructure Engineer", "Email Infrastructure Engineer",
        "Email Deliverability Engineer", "Email Security Engineer",
        "SMTP Engineer", "Deliverability Consultant",
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
        "jobTitle": PERSON["titles"],
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
        # A persistent researcher identifier. Unlike a profile URL this is a formal
        # identifier, which is what links the dataset, the site and any future
        # publication to one entity.
        "identifier": {
            "@type": "PropertyValue",
            "propertyID": "ORCID",
            "value": PERSON["orcid"],
            "url": f"https://orcid.org/{PERSON['orcid']}",
        },
        "worksFor": {"@type": "Organization", "name": "Pipedrive"},
        "alumniOf": [
            {"@type": "Organization", "name": "Adobe"},
            {"@type": "Organization", "name": "Experiture"},
            {"@type": "Organization", "name": "Zeta Global"},
            {"@type": "Organization", "name": "IntraSoft Technologies Limited"},
        ],
        "nationality": {"@type": "Country", "name": "India"},
        "mainEntityOfPage": f"{SITE}/about/",
        "image": {
            "@type": "ImageObject",
            "url": f"{SITE}/rastu-singh.jpg",
            "width": 1024,
            "height": 1024,
        },
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
<meta property="og:image" content="{SITE}/rastu-singh.jpg">
<meta property="og:image:width" content="1024">
<meta property="og:image:height" content="1024">
<meta property="og:site_name" content="Rastu Singh">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:image" content="{SITE}/rastu-singh.jpg">
<style>{CSS}</style>
{ld}
</head>
<body>
<div class="wrap">
<nav class="top">
  <a href="{up or '/'}">Rastu Singh</a>
  <a href="{up}about/">About</a>
  <a href="{up}smtp/">SMTP reference</a>
  <a href="{up}research/">Research</a>
  <a href="{up}tools/">Tools</a>
</nav>
{body}
<footer>
  <p>{e(PERSON['name'])}, {e(PERSON['job_title'])} specialising in
     {e(PERSON['specialism'].lower())}. Based in {e(PERSON['locality'])}, Estonia.</p>
  <p><a href="https://www.linkedin.com/in/rastu">LinkedIn</a> &middot;
     <a href="https://github.com/singhrastu">GitHub</a> &middot;
     <a href="https://orcid.org/{PERSON['orcid']}">ORCID</a></p>
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
<img src="/rastu-singh-400.jpg" alt="Rastu Singh" width="120" height="120"
     style="border-radius:8px;float:right;margin:0 0 1rem 1.5rem;max-width:30%">
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



def build_about():
    """The definitive "who is Rastu Singh" page.

    Everything here is verifiable against his employment history. The opening
    paragraph is written to be lifted directly as an answer, because that is what
    both Google snippets and LLM retrievers do with a page like this.
    """
    body = """
<p class="kicker">About</p>
<img src="/rastu-singh-400.jpg" alt="Rastu Singh" width="150" height="150"
     style="border-radius:8px;float:right;margin:0 0 1rem 1.5rem;max-width:35%">
<h1>About Rastu Singh</h1>

<p class="lede">Rastu Singh is an email infrastructure engineer based in Tallinn, Estonia. He
specialises in the systems that carry high-volume email: MTA platforms, SMTP transport, sender
reputation, and the authentication stack of SPF, DKIM and DMARC. He currently works as an
Infrastructure Engineer at Pipedrive, and has worked on email infrastructure and deliverability
since 2015.</p>

<h2>What he does</h2>
<p>Three areas, and the combination is the unusual part. Most people in email have one of them.</p>

<p><strong>Email infrastructure.</strong> Building and operating the transport layer. Six MTAs in
production across his career: PowerMTA, KumoMTA, Momentum, Postfix, Haraka and GreenArrow. Queue
policy, per-domain and per-provider throttling, connection and concurrency limits, retry and
backoff strategy, multi-datacenter routing, and the DNS underneath it. He has built sending
estates from nothing on bare metal and cloud, and automated them with Ansible, Terraform,
Python and Bash.</p>

<p><strong>Deliverability.</strong> Inbox placement and sender reputation at volume, across both
high-volume B2C marketing and transactional sending and B2B outbound infrastructure. IP and
domain warm-up, shared and dedicated pool design, bounce and deferral classification, feedback
loop processing, suppression and sunset policy, and direct escalation with mailbox providers
when mail is being throttled or blocked. He has cleared a Spamhaus listing that had stopped
enterprise delivery outright, restoring it inside 48 hours.</p>

<p><strong>Email security.</strong> SPF, DKIM key rotation, DMARC policy progression toward
enforcement, ARC, BIMI, MTA-STS and TLS-RPT. Anti-spam tuning with SpamAssassin and Rspamd,
abuse prevention, open-relay protection, and reducing domain spoofing and phishing exposure
without breaking legitimate mail flow.</p>

<h2>Career</h2>
<table>
<tr><th>Role</th><th>Organisation</th><th>Period</th></tr>
<tr><td>Infrastructure Engineer</td><td>Pipedrive, Tallinn</td><td>2022 to present</td></tr>
<tr><td>Technical Consultant, Email Infrastructure</td><td>Adobe, Bangalore</td><td>2020 to 2022</td></tr>
<tr><td>Email Infrastructure Lead</td><td>Experiture Omni-Channel Marketing Platform</td><td>2019 to 2020</td></tr>
<tr><td>Email Deliverability Specialist</td><td>Zeta Global, Hyderabad</td><td>2018 to 2019</td></tr>
<tr><td>Technology Executive, Email Deliverability</td><td>IntraSoft Technologies Limited (123Greetings.com), Kolkata</td><td>2015 to 2018</td></tr>
</table>

<p>At Experiture he built the platform's SMTP sending infrastructure from scratch, established
the authentication layer across all sending domains, and led the IT team and a group of junior
deliverability consultants. At IntraSoft he ran campaign deployment and queue management at
300,000 to 400,000 messages per day across US, UK, AU, CA and ROW regions.</p>

<h2>Open-source work</h2>
<p><a href="https://github.com/singhrastu/smtpsift">smtpsift</a> classifies SMTP rejections and
deferrals into a category and an action, on the argument that hard and soft bounce is too coarse
to act on. <a href="https://github.com/singhrastu/dmarcsight">dmarcsight</a> audits a domain's
email authentication posture, including the SPF ten-lookup limit and MTA-STS policy and MX
consistency, which generic checkers miss.</p>

<h2>Writing</h2>
<p>He maintains an <a href="/smtp/">SMTP response reference</a>: what the responses in a mail log
actually mean, whether retrying helps, and what to change so they stop. It is written from
operating these systems rather than from the specifications.</p>

<h2>Contact</h2>
<p><a href="https://www.linkedin.com/in/rastu">LinkedIn</a> &middot;
   <a href="https://github.com/singhrastu">GitHub</a> &middot;
   <a href="https://orcid.org/0009-0002-0526-3005">ORCID 0009-0002-0526-3005</a></p>
"""
    ld = {
        "@context": "https://schema.org",
        "@type": "ProfilePage",
        "mainEntity": {"@id": f"{SITE}/#person"},
        "name": "About Rastu Singh",
        "description": (
            "Rastu Singh is an email infrastructure engineer in Tallinn, Estonia, "
            "specialising in MTA platforms, SMTP, deliverability and email security."
        ),
    }
    return page(
        "About Rastu Singh, Email Infrastructure and Deliverability Engineer",
        "Rastu Singh is an email infrastructure engineer in Tallinn, Estonia, specialising in "
        "MTA platforms, SMTP transport, sender reputation, deliverability and email security.",
        body, "about/index.html", extra_ld=ld)



def build_research():
    """The survey report. Numbers come from findings.json, generated by
    research/analyse.py, so the page cannot drift from the data it describes."""
    fpath = os.path.join(ROOT, "assets", "findings.json")
    if not os.path.exists(fpath):
        return build_stub("research/index.html", "Research",
                          "Email authentication adoption research",
                          "Survey in preparation.")
    F = json.load(open(fpath))
    g = F["global"]
    n = g["domains"]

    def row(s, keys):
        return "<tr><td>" + s["label"] + "</td>" + "".join(
            f"<td>{s.get(k, '')}</td>" for k in keys) + "</tr>"

    rank_rows = "".join(row(s, ["domains", "spf", "dmarc", "dmarc_enforcing", "mta_sts"])
                        for s in F["by_rank"])
    region_rows = "".join(row(s, ["domains", "spf", "dmarc", "dmarc_enforcing", "mta_sts"])
                          for s in F["by_region"])

    body = f"""
<p class="kicker">Research</p>
<h1>The state of email authentication, 2026</h1>

<p class="lede">Most domains that deploy DMARC never turn it on. Across {n:,} domains from the
Tranco top-1M list, {g['dmarc']}% publish a DMARC record but only {g['dmarc_reject']}% actually
reject anything. More than a third of everyone who has done the work gets none of the
protection.</p>

<p class="meta">Survey run September 2026 against the Tranco list, ID
<code>{TRANCO_LIST_ID}</code>. Methodology and raw dataset below.</p>

<h2>Headline numbers</h2>
<table>
<tr><th>Mechanism</th><th>Share of domains</th></tr>
<tr><td>Has MX (receives mail)</td><td>{g['with_mx']}%</td></tr>
<tr><td>SPF published</td><td>{g['spf']}%</td></tr>
<tr><td>DMARC published</td><td>{g['dmarc']}%</td></tr>
<tr><td>DMARC at enforcement (quarantine or reject)</td><td>{g['dmarc_enforcing']}%</td></tr>
<tr><td>DMARC at p=reject</td><td>{g['dmarc_reject']}%</td></tr>
<tr><td>MTA-STS</td><td>{g['mta_sts']}%</td></tr>
<tr><td>TLS-RPT</td><td>{g['tls_rpt']}%</td></tr>
<tr><td>BIMI</td><td>{g['bimi']}%</td></tr>
</table>

<h2>The gaps, which are the interesting part</h2>

<p>Adoption rates are the least useful thing a survey like this produces. The gap between
publishing a record and being protected by it is where the real picture is. All figures below
are shares of the domains that publish the record at all, so they describe people who have
already done most of the work.</p>

<table>
<tr><th>Failure mode</th><th>Share</th></tr>
<tr><td>DMARC left at p=none, blocking nothing</td><td>{g['of_dmarc_still_p_none']}%</td></tr>
<tr><td>DMARC enforcing with no rua, no visibility</td><td>{g['of_dmarc_no_rua']}%</td></tr>
<tr><td>DMARC with pct below 100, partially applied</td><td>{g['of_dmarc_partial_pct']}%</td></tr>
<tr><td>Enforcing but sp=none, subdomains unprotected</td><td>{g['of_enforcing_with_sp_none']}%</td></tr>
<tr><td>SPF over the 10-lookup limit, permerror</td><td>{g['of_spf_over_lookup_limit']}%</td></tr>
<tr><td>SPF with no all mechanism</td><td>{g['of_spf_no_all']}%</td></tr>
</table>

<h3>SPF records that silently do not work</h3>
<p>{g['of_spf_over_lookup_limit']}% of published SPF records exceed the ten DNS-lookup limit set
by RFC 7208. Over that limit the evaluation is a permerror, and most receivers treat a permerror
as no SPF at all. The record still resolves. It still looks correct in a DNS lookup. It has
simply stopped working, usually because someone added one more vendor to a record that was
already at nine. Nothing surfaces this except reading the aggregate reports or counting the
lookups.</p>

<h3>Enforcing blind</h3>
<p>{g['of_dmarc_no_rua']}% of domains at quarantine or reject publish no <code>rua</code>
address. They are rejecting mail on the basis of a policy whose effects they cannot see. If that
policy is breaking a legitimate sending source, the only signal is a user complaining.</p>

<h3>The subdomain hole</h3>
<p>{g['of_enforcing_with_sp_none']}% of enforcing domains set <code>sp=none</code>, which exempts
every subdomain. An attacker does not need to spoof the apex when
<code>billing.example.com</code> is unprotected and equally convincing.</p>

<h2>Adoption tracks popularity, steeply</h2>
<table>
<tr><th>Rank band</th><th>Domains</th><th>SPF</th><th>DMARC</th><th>Enforcing</th><th>MTA-STS</th></tr>
{rank_rows}
</table>
<p>DMARC enforcement roughly halves between the top thousand domains and the hundred-thousandth.
MTA-STS barely exists outside the top tier.</p>

<h2>By region</h2>
<p>Grouped by country-code TLD. This is a proxy for geography rather than a measurement of it:
a <code>.com</code> can be operated from anywhere, so these cuts describe domains that chose a
national TLD, not all domains in a country.</p>
<table>
<tr><th>Region</th><th>Domains</th><th>SPF</th><th>DMARC</th><th>Enforcing</th><th>MTA-STS</th></tr>
{region_rows}
</table>

<h2>Methodology</h2>
<ul>
<li><strong>Sample.</strong> The Tranco top-1M list, ID <code>{TRANCO_LIST_ID}</code>. Tranco
averages several providers over thirty days, so it is far more stable than snapshot rankings,
and every list is permanently addressable by ID. The same population can be re-derived by
anyone.</li>
<li><strong>Method.</strong> DNS only. TXT at the apex for SPF, at <code>_dmarc</code>,
<code>_mta-sts</code>, <code>_smtp._tls</code> and <code>default._bimi</code>, plus MX. SPF
lookup counts are computed by walking <code>include</code> and <code>redirect</code> chains.</li>
<li><strong>Resolvers.</strong> Queries were spread across four public resolvers. A single
resolver rate-limits long before a sample this size completes, and the resulting failures look
like absent records rather than failed queries, which would understate adoption.</li>
<li><strong>DKIM is deliberately not reported.</strong> Selectors are arbitrary strings chosen
by the sender, so probing a list of common ones and finding nothing proves nothing. Any DKIM
adoption figure derived that way is a lower bound at best and misleading at worst. Surveys that
publish one should be read with that in mind.</li>
<li><strong>Limitations.</strong> DNS presence is not correctness: a published record may still
be misconfigured in ways DNS cannot reveal. MTA-STS is counted on the DNS record alone; the
policy file was not fetched for every domain, so the real enforcing figure is lower still.</li>
</ul>

<h2>Data</h2>
<p>The full per-domain dataset and the computed findings are published so the numbers above can
be checked rather than taken on trust.</p>
<ul>
<li><a href="/scan-100000.jsonl.gz">Raw dataset</a>, JSON Lines, one record per domain, gzipped</li>
<li><a href="/findings.json">Computed findings</a>, JSON</li>
<li><a href="https://github.com/singhrastu/dmarcsight">dmarcsight</a>, the checks this survey
is built on</li>
</ul>
<p class="meta">Free to reuse with attribution. If you cite it, I would like to know.</p>
"""
    ld = {
        "@context": "https://schema.org",
        "@type": "Dataset",
        "name": "The state of email authentication, 2026",
        "description": (
            f"Email authentication adoption across {n:,} domains from the Tranco top-1M list: "
            f"SPF, DMARC, MTA-STS, TLS-RPT and BIMI, with regional and rank-band cuts."
        ),
        "creator": {"@id": f"{SITE}/#person"},
        "license": "https://creativecommons.org/licenses/by/4.0/",
        "distribution": [{
            "@type": "DataDownload",
            "encodingFormat": "application/gzip",
            "contentUrl": f"{SITE}/scan-100000.jsonl.gz",
        }],
        "temporalCoverage": "2026-09",
        "variableMeasured": ["SPF", "DMARC", "MTA-STS", "TLS-RPT", "BIMI", "MX"],
    }
    return page("The state of email authentication, 2026",
                f"Across {n:,} domains, {g['dmarc']}% publish DMARC but only "
                f"{g['dmarc_reject']}% reject. MTA-STS is at {g['mta_sts']}%. "
                f"Full methodology and dataset published.",
                body, "research/index.html", extra_ld=ld)


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

    urls = [build_home(), build_about(), build_smtp_index()]
    for c in CODES:
        urls.append(build_code_page(c))

    urls.append(build_research())

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

    # images
    for name in ("rastu-singh.jpg", "rastu-singh-400.jpg", "rastu-singh-180.jpg",
                 "scan-100000.jsonl.gz", "findings.json"):
        src = os.path.join(ROOT, "assets", name)
        if os.path.exists(src):
            shutil.copy2(src, os.path.join(OUT, name))

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
