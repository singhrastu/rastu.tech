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
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
OUT = os.path.join(ROOT, "site")
sys.path.insert(0, HERE)
from codes import CODES

SITE = "https://rastu.tech"
TRANCO_LIST_ID = "V3YPN"
DOI = "10.5281/zenodo.22832936"
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
        "https://www.wikidata.org/wiki/Q141496706",
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
/* Design tokens.

   Dark is the base here rather than an alternative. A near-black surface with a
   terminal green is what a mail log looks like, and this site is about mail
   logs; the honeycomb drifting behind it is the routing metaphor made literal.

   The status colours are reserved for state (suppress, throttle, retry) and are
   deliberately not green, because green is the accent and a status must never
   read as branding. Each one ships with its word, so state is never carried by
   colour alone either. */
:root{
  --ink:#e7eeea; --ink-2:#a8b6af; --ink-3:#77867f;
  --line:#1f2926; --line-2:#161e1b;
  --bg:#0a0e0d; --surface:#111816; --code:#0d1412;
  --accent:#3ddc84; --accent-2:#74f0ac; --accent-soft:#0f2019;
  --hex:#3ddc84;
  --ok:#3ddc84; --warn:#e6b25c; --bad:#ff7a7a; --info:#5db8ff;
  --radius:10px;
  --measure:44rem;
  /* The readable band is 45-75 characters a line. Before this, list items on the
     wide pages ran to 115 and headings to 93, which is where a reader starts
     losing their place on the return sweep. Tools, tables and card grids opt out
     and use the full container. */
  --measure-text:42rem;
  /* Spacing and type scales. Before these, every size in the sheet was a bare
     rem literal, which is survivable at six pages and is not at fifteen. */
  --s1:.25rem; --s2:.5rem; --s3:.85rem; --s4:1.3rem; --s5:2.2rem; --s6:3.6rem;
  --t0:.72rem; --t1:.8rem; --t2:.885rem; --t3:.95rem; --t4:1.14rem;
  --t5:1.5rem; --t6:2.4rem;
}
::selection{background:var(--accent-soft);color:var(--accent-2)}

*{box-sizing:border-box}
html{scroll-behavior:smooth}
body{
  margin:0;background:var(--bg);color:var(--ink);
  font:17px/1.72 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
  -webkit-font-smoothing:antialiased;
  text-rendering:optimizeLegibility;
}

/* ---- honeycomb field -------------------------------------------------
   Fixed behind everything, drifting slowly as the page scrolls. Pure CSS
   background + one transform driven by a custom property, so it costs one
   compositor layer and no layout. Hidden entirely under reduced-motion. */
#hexcanvas{position:fixed;inset:0;z-index:0;pointer-events:none;display:block}
.hexveil{position:fixed;inset:0;z-index:0;pointer-events:none;
  background:radial-gradient(120% 85% at 50% 0%,transparent 0%,
    color-mix(in srgb,var(--bg) 72%,transparent) 58%,
    color-mix(in srgb,var(--bg) 92%,transparent) 100%)}

.wrap{position:relative;z-index:1;max-width:var(--measure);margin:0 auto;padding:0 1.35rem 5rem}
.wrap.wide{max-width:64rem}
/* Prose gets the readable measure; anything that is a layout opts out by not
   being in this list. */
.wrap.wide main > p,
.wrap.wide main > ul,
.wrap.wide main > ol,
.wrap.wide main > dl,
.wrap.wide main > h2,
.wrap.wide main > h3,
.wrap.wide main > pre,
.wrap.wide main > .callout,
.wrap.wide main > .sechead{max-width:var(--measure-text)}
.wrap.wide main > .full{max-width:none}
.wrap.wide main > h2{margin-top:var(--s6)}

/* ---- nav ---------------------------------------------------------------- */
.skip{position:absolute;left:-9999px;top:0;z-index:9;background:var(--accent);
  color:#08140d;padding:.6rem 1rem;border-radius:0 0 8px 0;font-weight:650}
.skip:focus{left:0}
nav.top{display:flex;gap:.35rem;align-items:center;flex-wrap:wrap;
  padding:1.25rem 0 var(--s5);font-size:1.02rem}
nav.top a{color:var(--ink-2);text-decoration:none;position:relative;font-weight:500;
  padding:.5rem .85rem;border-radius:9px;border:1px solid transparent;
  transition:color .18s,background .18s,border-color .18s,transform .18s}
nav.top a:hover{color:var(--ink);background:var(--surface);border-color:var(--line);
  transform:translateY(-2px)}
nav.top a:active{transform:translateY(0)}
nav.top a:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
/* The page you are on, and the one you just clicked, both read as accent. */
nav.top a[aria-current]{color:var(--accent);background:var(--accent-soft);
  border-color:color-mix(in srgb,var(--accent) 35%,transparent);font-weight:650}
nav.top a[aria-current]:hover{color:var(--accent-2);transform:translateY(-2px)}
nav.top .mark{margin-right:auto;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;
  font-weight:700;color:var(--ink);font-size:1.12rem;letter-spacing:-.02em;
  padding-left:0;border:0}
nav.top .mark span{color:var(--accent)}
nav.top .mark:hover{background:none;border-color:transparent;color:var(--accent-2)}

@media(max-width:34rem){
  nav.top{gap:.25rem;padding-bottom:var(--s4);font-size:.95rem}
  nav.top .mark{margin-right:0;width:100%;margin-bottom:.4rem}
  nav.top a{padding:.45rem .7rem}
}

/* ---- type ------------------------------------------------------------- */
a{color:var(--accent);text-underline-offset:2px}
h1{font-size:clamp(1.9rem,4.5vw,2.5rem);line-height:1.16;letter-spacing:-.021em;margin:.3rem 0 .7rem;font-weight:680}
h2{font-size:1.3rem;letter-spacing:-.012em;margin:3rem 0 1rem;padding-bottom:.5rem;
   border-bottom:1px solid var(--line);font-weight:650;line-height:1.3}
h3{font-size:1.06rem;margin:2.1rem 0 .55rem;font-weight:650;line-height:1.4}
p{margin:0 0 1.15rem}
.kicker{color:var(--ink-3);font-size:.76rem;letter-spacing:.11em;text-transform:uppercase;margin:0 0 .2rem;font-weight:600}
.lede{font-size:1.14rem;line-height:1.6;color:var(--ink);margin-bottom:1.3rem}
.meta{color:var(--ink-3);font-size:.9rem}
ul,ol{padding-left:1.3rem}
li{margin:.55rem 0;line-height:1.7}
li::marker{color:var(--ink-3)}
main ul li strong:first-child{color:var(--ink)}
strong{font-weight:650}

/* ---- code ------------------------------------------------------------- */
pre,code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
pre{background:var(--code);padding:.9rem 1.05rem;border-radius:var(--radius);overflow-x:auto;
    font-size:.845rem;line-height:1.55;border:1px solid var(--line);margin:.9rem 0}
code{background:var(--code);padding:.12rem .38rem;border-radius:5px;font-size:.88em}
pre code{background:none;padding:0}

/* ---- badges ----------------------------------------------------------- */
.badge{display:inline-block;background:var(--surface);border:1px solid var(--line);
       border-radius:100px;padding:.2rem .68rem;font-size:.775rem;color:var(--ink-2);
       margin:0 .4rem .4rem 0;font-weight:500}

/* ---- callout ---------------------------------------------------------- */
.callout{border-left:3px solid var(--accent);background:var(--accent-soft);
         padding:.9rem 1.1rem;margin:1.5rem 0;border-radius:0 var(--radius) var(--radius) 0;
         color:var(--ink-2);font-size:.96rem}
.callout p{margin:0}

/* ---- tables ----------------------------------------------------------- */
.scroll-x{overflow-x:auto;margin:1.1rem 0;-webkit-overflow-scrolling:touch}
table{border-collapse:collapse;width:100%;font-size:.93rem;min-width:30rem}
th,td{text-align:left;padding:.58rem .7rem;border-bottom:1px solid var(--line);vertical-align:top}
th{color:var(--ink-3);font-weight:600;font-size:.79rem;letter-spacing:.045em;
   text-transform:uppercase;border-bottom:1px solid var(--line)}
tbody tr:hover{background:var(--surface)}
td:not(:first-child){font-variant-numeric:tabular-nums}

/* ---- stat tiles: the right form for a single headline number ---------- */
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(9.5rem,1fr));gap:.7rem;margin:1.4rem 0 1.8rem}
.stat{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);padding:1rem 1.05rem}
.stat .n{font-size:1.85rem;line-height:1.1;font-weight:680;letter-spacing:-.025em;
         font-variant-numeric:tabular-nums;color:var(--ink)}
.stat .l{font-size:.815rem;color:var(--ink-3);margin-top:.3rem;line-height:1.35}

/* ---- single-series magnitude bars ------------------------------------- */
.bars{margin:1.3rem 0 1.8rem}
.bar-row{display:grid;grid-template-columns:1fr 3.2rem;gap:.85rem;align-items:center;margin:.55rem 0}
.bar-label{font-size:.885rem;color:var(--ink-2);line-height:1.35}
.bar-track{grid-column:1/-1;height:7px;background:var(--line-2);border-radius:4px;overflow:hidden}
.bar-fill{height:100%;background:var(--accent);border-radius:4px;
          width:0;transition:width .9s cubic-bezier(.22,.7,.3,1)}
.reveal .bar-fill{width:var(--w)}
.bar-val{font-size:.885rem;color:var(--ink);text-align:right;font-variant-numeric:tabular-nums;font-weight:600}

/* ---- card grid for the reference index -------------------------------- */
.grid{display:grid;gap:.55rem;margin-top:1.2rem}
.grid a{display:block;padding:.85rem 1rem;border:1px solid var(--line);border-radius:var(--radius);
        text-decoration:none;background:var(--bg);transition:border-color .16s,transform .16s,background .16s}
.grid a:hover{border-color:var(--accent);background:var(--surface);transform:translateY(-1px)}
.grid a strong{color:var(--ink);font-size:.97rem}
.grid a .p{color:var(--ink-3);font-size:.79rem;margin-left:.45rem}
.grid a span.d{display:block;color:var(--ink-3);font-size:.865rem;margin-top:.22rem;line-height:1.45}

/* ---- portrait --------------------------------------------------------- */
.portrait{border-radius:var(--radius);float:right;margin:.2rem 0 1rem 1.6rem;
          max-width:32%;border:1px solid var(--line)}

/* ---- hero -------------------------------------------------------------- */
.hero{display:grid;grid-template-columns:1fr auto;gap:2.2rem;align-items:start;padding:.4rem 0}
.hero-copy{min-width:0}
.hero img{width:152px;height:152px;border-radius:14px;border:1px solid var(--line);
          box-shadow:0 12px 36px -14px rgba(0,0,0,.5);display:block}
@media(max-width:44rem){.hero{grid-template-columns:1fr;gap:1.1rem}
  .hero img{width:104px;height:104px}}

/* ---- credential strip -------------------------------------------------- */
.strip{display:grid;grid-template-columns:repeat(auto-fit,minmax(8rem,1fr));gap:.55rem;margin:1.7rem 0 1.4rem}
.strip div{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);
           padding:.82rem .9rem;transition:transform .3s cubic-bezier(.22,.8,.3,1),border-color .3s}
.strip div:hover{transform:translateY(-3px);border-color:var(--accent)}
.strip b{display:block;font-size:1.34rem;font-weight:680;letter-spacing:-.022em;
         font-variant-numeric:tabular-nums;line-height:1.15}
.strip span{display:block;font-size:.755rem;color:var(--ink-3);margin-top:.22rem;line-height:1.3}

/* ---- bento ------------------------------------------------------------- */
.bento{display:grid;grid-template-columns:repeat(auto-fit,minmax(15rem,1fr));gap:.8rem;margin:1.3rem 0}
@media(min-width:56rem){
  .bento{grid-template-columns:repeat(8,1fr)}
  .bento .card:nth-child(1){grid-column:span 5}
  .bento .card:nth-child(2){grid-column:span 3}
  .bento .card:nth-child(n+3){grid-column:span 2}
  .bento .card:nth-child(1) h3{font-size:1.2rem}
  .bento .card:nth-child(1) p{font-size:.93rem}
  .bento .card:nth-child(n+3) p{font-size:.845rem}
}
.bento .card{position:relative;overflow:hidden;background:var(--surface);
     border:1px solid var(--line);border-radius:14px;padding:1.2rem 1.25rem;
     text-decoration:none;color:inherit;display:block;
     transition:transform .3s cubic-bezier(.22,.8,.3,1),border-color .3s,box-shadow .3s}
.bento .card:hover{transform:translateY(-4px);border-color:var(--accent);
     box-shadow:0 16px 38px -20px rgba(0,0,0,.5)}
.bento .card::before{content:"";position:absolute;inset:0 0 auto 0;height:2px;
     background:linear-gradient(90deg,var(--accent),transparent);opacity:0;transition:opacity .3s}
.bento .card:hover::before{opacity:1}
.bento h3{margin:.1rem 0 .4rem;font-size:1.05rem;color:var(--ink)}
.bento p{margin:0;font-size:.885rem;color:var(--ink-3);line-height:1.52}
.bento .tag{display:inline-block;font-size:.695rem;letter-spacing:.09em;text-transform:uppercase;
     color:var(--accent);font-weight:650;margin-bottom:.35rem}
.bento .go{display:inline-block;margin-top:.75rem;font-size:.85rem;color:var(--accent);font-weight:600}

.bento .codes{display:flex;flex-wrap:wrap;gap:.3rem;margin:.85rem 0 0}
.bento .codes code{background:var(--code);border:1px solid var(--line);color:var(--ink-3);
  font-size:.735rem;padding:.16rem .45rem;border-radius:5px;transition:color .22s,border-color .22s}
.bento .card:hover .codes code{color:var(--accent-2);border-color:var(--accent-soft)}

/* ---- findings: the shared result shape every tool emits -------------------- */
.findings{display:grid;gap:var(--s2);margin:var(--s3) 0 0}
.fnd{border:1px solid var(--line);border-left-width:3px;border-radius:0 10px 10px 0;
  background:var(--surface);padding:var(--s3) var(--s4) var(--s3) 1rem}
.fnd.s-critical{border-left-color:var(--bad)}
.fnd.s-warn{border-left-color:var(--warn)}
.fnd.s-info{border-left-color:var(--info)}
.fnd.s-ok{border-left-color:var(--ok)}
.fnd header{display:flex;gap:.5rem;align-items:center;flex-wrap:wrap;margin-bottom:.4rem}
.fnd .pill{font-size:.64rem;letter-spacing:.09em;text-transform:uppercase;font-weight:700;
  padding:.14rem .5rem;border-radius:100px;border:1px solid currentColor}
.fnd.s-critical .pill{color:var(--bad)}
.fnd.s-warn .pill{color:var(--warn)}
.fnd.s-info .pill{color:var(--info)}
.fnd.s-ok .pill{color:var(--ok)}
.fnd .scope{font-family:ui-monospace,Menlo,monospace;font-size:var(--t1);color:var(--ink-3)}
/* Ownership is the thing no other tool in this category tells you, so it gets
   its own visual slot rather than being buried in the prose. */
.fnd .owner{margin-left:auto;font-size:.66rem;letter-spacing:.07em;text-transform:uppercase;
  font-weight:650;padding:.16rem .55rem;border-radius:6px;cursor:help;
  background:var(--code);border:1px solid var(--line);color:var(--ink-3)}
.fnd.o-you .owner{color:var(--accent);border-color:color-mix(in srgb,var(--accent) 40%,transparent);
  background:var(--accent-soft)}
.fnd h4{margin:0 0 .3rem;font-size:var(--t3);font-weight:650;color:var(--ink);line-height:1.45}
.fnd .d{margin:0;font-size:var(--t2);color:var(--ink-3);line-height:1.6;max-width:44rem}
.fnd .fix{margin:.55rem 0 0;font-size:var(--t2);color:var(--ink-2);line-height:1.6;
  max-width:44rem}
.fnd .fix b{color:var(--accent);font-weight:650;margin-right:.35rem;
  font-size:.66rem;letter-spacing:.09em;text-transform:uppercase}
.fnd .ev{display:block;margin:.55rem 0 0;font-size:.72rem;color:var(--ink-3);
  background:var(--code);border:1px solid var(--line);border-radius:6px;
  padding:.4rem .55rem;overflow-x:auto;white-space:pre-wrap;word-break:break-word}
.fnd .ref{margin:.5rem 0 0;font-size:var(--t1)}

/* ---- fix these first ------------------------------------------------------ */
.shortlist{counter-reset:fx;list-style:none;padding:0;margin:var(--s2) 0 var(--s4);
  border:1px solid color-mix(in srgb,var(--accent) 30%,transparent);border-radius:12px;
  background:linear-gradient(140deg,var(--accent-soft),transparent 75%);
  padding:var(--s3) var(--s4)}
.shortlist li{counter-increment:fx;position:relative;padding-left:1.9rem;margin:.55rem 0;
  font-size:var(--t2);color:var(--ink-2);line-height:1.6}
.shortlist li::before{content:counter(fx);position:absolute;left:0;top:.05rem;
  width:1.35rem;height:1.35rem;border-radius:50%;background:var(--accent);color:#08140d;
  font-size:.72rem;font-weight:700;display:grid;place-items:center}
.shortlist li strong{color:var(--ink);display:block;margin-bottom:.1rem}

/* ---- drop zone ----------------------------------------------------------- */
.drop{display:block;border:1.5px dashed var(--line);border-radius:12px;
  padding:var(--s5) var(--s4);text-align:center;cursor:pointer;background:var(--bg);
  transition:border-color .2s,background .2s,transform .2s}
.drop:hover{border-color:var(--accent);background:var(--accent-soft)}
.drop.over{border-color:var(--accent);background:var(--accent-soft);transform:scale(1.005)}
.drop b{display:block;font-size:var(--t4);color:var(--ink);margin-bottom:.3rem}
.drop span{display:block;font-size:var(--t2);color:var(--ink-3)}
.drop input{position:absolute;width:1px;height:1px;opacity:0;pointer-events:none}
.paste{margin-top:var(--s3)}
.paste summary{cursor:pointer;font-size:var(--t2);color:var(--ink-3);
  list-style:none;display:inline-block;padding:.25rem 0}
.paste summary::-webkit-details-marker{display:none}
.paste summary::before{content:"+ ";color:var(--accent)}
.paste[open] summary::before{content:"- "}
.paste summary:hover{color:var(--accent)}
.paste textarea{margin:.6rem 0;min-height:8rem}

/* ---- report table -------------------------------------------------------- */
table.rua{min-width:46rem}
table.rua td{vertical-align:top}
table.rua .ip{display:block;font-family:ui-monospace,Menlo,monospace;
  font-size:var(--t1);color:var(--ink-3);margin-top:.15rem}
table.rua .ptr{display:block;font-family:ui-monospace,Menlo,monospace;
  font-size:.72rem;color:var(--ink-3);opacity:.7;word-break:break-all;margin-top:.1rem}
table.rua .ptr em{font-style:normal;color:var(--warn)}
table.rua .unk{color:var(--ink-3);font-weight:500}
table.rua .num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
table.rua .why{color:var(--ink-3);font-size:var(--t2);max-width:22rem}
table.rua .tags{display:block;margin-top:.3rem}
table.rua .tags code{font-size:.68rem;margin-right:.25rem}
table.rua tr.s-fail .pill{color:var(--bad)}
table.rua tr.s-warn .pill{color:var(--warn)}
table.rua tr.s-ok .pill{color:var(--ok)}
table.rua tr.s-info .pill{color:var(--info)}

/* ---- assurances: three trust signals, glanceable ------------------------- */
.assure{display:grid;grid-template-columns:repeat(auto-fit,minmax(13rem,1fr));
  gap:var(--s2);list-style:none;padding:0;margin:var(--s4) 0 var(--s3)}
.assure li{margin:0;border:1px solid var(--line);border-left:2px solid var(--accent);
  border-radius:0 10px 10px 0;padding:.7rem .95rem;background:var(--surface)}
.assure b{display:block;font-size:var(--t3);font-weight:650;color:var(--ink)}
.assure span{display:block;font-size:var(--t1);color:var(--ink-3);margin-top:.15rem;
  line-height:1.5}
.byline{font-size:var(--t2);color:var(--ink-3);margin:0 0 var(--s5)}

/* ---- cost table ---------------------------------------------------------- */
table.cost td:first-child{white-space:nowrap}
table.cost .num{text-align:right;white-space:nowrap;color:var(--ink);font-weight:600}
table.cost tr.s-ok .num{color:var(--ok)}
table.cost tr.s-warn .num{color:var(--warn)}
table.cost tr.s-fail .num{color:var(--bad)}
table.cost td:last-child{color:var(--ink-3);font-size:var(--t2)}

/* ---- tool cards ---------------------------------------------------------- */
.bento.tools{grid-template-columns:repeat(auto-fit,minmax(20rem,1fr))}
@media(min-width:56rem){.bento.tools .card{grid-column:span 1}}
.bento .card .q{color:var(--ink);font-size:var(--t3);font-weight:600;
  margin:0 0 .5rem;line-height:1.45}
.bento .card .q::before{content:"";display:inline-block;width:6px;height:6px;
  border-radius:50%;background:var(--accent);margin-right:.5rem;vertical-align:.18em}

/* ---- chip row (reference shortcuts on the home page) --------------------- */
.chips-row{display:flex;gap:.45rem;flex-wrap:wrap;margin:var(--s3) 0 0;align-items:center}
.chips-row a{text-decoration:none}
.chip.more{border-color:var(--accent-soft);color:var(--accent)}

/* ---- reference index rows ------------------------------------------------ */
.grid a{position:relative}
.grid a .act{position:absolute;right:1rem;top:.9rem;font-size:.66rem;letter-spacing:.09em;
  text-transform:uppercase;font-weight:700;border:1px solid currentColor;
  border-radius:100px;padding:.14rem .5rem}
.grid a .d{padding-right:5.5rem}
@media(max-width:34rem){
  .grid a .act{position:static;display:inline-block;margin-top:.5rem}
  .grid a .d{padding-right:0}
}

/* ---- SPF include tree ---------------------------------------------------- */
.tree{margin:var(--s4) 0 0}
.tree ul{list-style:none;padding:0;margin:0}
.tree li{position:relative;padding:.3rem 0 .3rem calc(2.6rem + var(--d) * 1.15rem);
  font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:var(--t1);
  line-height:1.5;border-left:1px solid var(--line-2)}
.tree li .at{position:absolute;left:0;top:.28rem;width:1.7rem;text-align:right;
  color:var(--ink-3);font-variant-numeric:tabular-nums;font-size:.7rem;
  border-right:1px solid var(--line);padding-right:.4rem}
.tree li .at.over{color:var(--bad);font-weight:700}
.tree li code{background:none;padding:0;color:var(--ink-2);font-size:inherit}
.tree li.s-fail code{color:var(--bad)}
.tree li.free code{color:var(--ink-3);opacity:.55;font-size:.74rem}
.tree li .n{display:block;color:var(--warn);font-size:.72rem;
  font-family:inherit;margin-top:.1rem}
.tree li .rec{display:block;color:var(--ink-3);font-size:.68rem;opacity:.65;
  margin-top:.12rem;word-break:break-all}

/* ---- steps under the session -------------------------------------------- */
.steps{display:grid;grid-template-columns:repeat(auto-fit,minmax(16rem,1fr));
  gap:var(--s3);margin:var(--s4) 0}
.steps .step{border:1px solid var(--line);border-radius:12px;background:var(--surface);
  padding:var(--s3) 1rem;transition:border-color .25s}
.steps .step:hover{border-color:var(--accent)}
.steps .step h3{margin:0 0 .4rem;font-size:var(--t3)}
.steps .step code{display:block;background:var(--code);border:1px solid var(--line);
  border-radius:6px;padding:.4rem .55rem;font-size:.72rem;color:var(--ink-2);
  margin-bottom:.55rem;white-space:pre-wrap;word-break:break-word}
.steps .step p{margin:0;font-size:var(--t2);color:var(--ink-3);line-height:1.6}
.term .bar em{margin-left:auto;font-style:normal;font-size:.7rem;color:var(--ink-3);
  opacity:.6;transition:opacity .2s}
.term:hover .bar em{opacity:1;color:var(--accent)}

/* ---- annotated session --------------------------------------------------- */
.session{border:1px solid var(--line);border-radius:14px;background:var(--code);
  padding:var(--s3) 0;margin:var(--s4) 0}
.session .ln{padding:.05rem var(--s4);position:relative}
.session .ln code{background:none;padding:0;font-size:.79rem;line-height:1.75;
  white-space:pre-wrap;word-break:break-word;display:block}
.session .ln.has-note{background:color-mix(in srgb,var(--accent) 5%,transparent);
  border-left:2px solid var(--accent-soft);padding-top:.35rem;padding-bottom:.45rem;
  margin:.25rem 0}
.session .an{margin:.25rem 0 0;font-size:var(--t1);color:var(--ink-3);
  line-height:1.55;max-width:46rem}
.session .cmd{color:var(--accent);font-weight:600}
.session .info{color:var(--ink-3);opacity:.8}
.session .c{color:var(--ink)}
.session .s{color:var(--ink-3)}
.session .ok{color:var(--ok);font-weight:600}
@media(max-width:34rem){.session .ln code{font-size:.7rem}}

/* ---- highlight panel --------------------------------------------------- */
.panel{border:1px solid var(--line);border-radius:14px;padding:1.3rem 1.4rem;margin:1.6rem 0;
   background:linear-gradient(140deg,var(--accent-soft),transparent 72%)}
.panel h3{margin:0 0 .45rem;font-size:1.06rem}
.panel p{margin:0 0 .55rem;font-size:.93rem;color:var(--ink-2)}
.panel .doi{font-family:ui-monospace,Menlo,monospace;font-size:.805rem;color:var(--ink-3)}

/* ---- stack chips ------------------------------------------------------- */
.stack .row{display:flex;gap:.45rem;flex-wrap:wrap;margin:.45rem 0 1rem}
.stack .lbl{font-size:.735rem;letter-spacing:.09em;text-transform:uppercase;color:var(--ink-3);
   font-weight:650;width:100%;margin-bottom:.15rem}
.chip{font-size:.815rem;padding:.3rem .68rem;border:1px solid var(--line);border-radius:7px;
   background:var(--bg);color:var(--ink-2);transition:border-color .22s,color .22s,transform .22s}
.chip:hover{border-color:var(--accent);color:var(--accent);transform:translateY(-2px)}
.chip.on{border-color:var(--accent);color:var(--accent);background:var(--accent-soft);font-weight:600}

/* ---- timeline, as disclosures ------------------------------------------ */
.tl{position:relative;margin:1.2rem 0;padding-left:1.55rem}
.tl::before{content:"";position:absolute;left:5px;top:.9rem;bottom:.9rem;width:1px;background:var(--line)}
.tl .e{position:relative;padding:.15rem 0 .35rem;border-bottom:1px solid var(--line-2)}
.tl .e:last-child{border-bottom:0}
.tl .e::before{content:"";position:absolute;left:-1.55rem;top:1.05rem;width:9px;height:9px;
   border-radius:50%;background:var(--bg);border:2px solid var(--line);
   transition:border-color .25s,background .25s;z-index:1}
.tl .e:first-child::before{border-color:var(--accent);background:var(--accent)}
.tl .e[open]::before,.tl .e:hover::before{border-color:var(--accent)}
.tl summary{list-style:none;cursor:pointer;padding:.55rem 1.6rem .55rem 0;position:relative;
   border-radius:8px;transition:background .2s}
.tl summary::-webkit-details-marker{display:none}
.tl summary:hover{background:var(--surface)}
.tl summary:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.tl summary::after{content:"";position:absolute;right:.45rem;top:1.15rem;width:7px;height:7px;
   border-right:1.6px solid var(--ink-3);border-bottom:1.6px solid var(--ink-3);
   transform:rotate(45deg);transition:transform .25s,border-color .25s}
.tl .e[open] summary::after{transform:rotate(-135deg);border-color:var(--accent)}
.tl .role{display:block;font-weight:650;font-size:.97rem;color:var(--ink)}
.tl .org{display:block;color:var(--ink-2);font-size:.895rem}
.tl .yr{display:block;color:var(--ink-3);font-size:.795rem;font-variant-numeric:tabular-nums;margin-top:.1rem}
.tl .yr .n{margin-left:.6rem;color:var(--accent);opacity:.75;font-variant-numeric:normal}
.tl .e[open] .yr .n{opacity:0}
.tl .ach{margin:.2rem 0 .95rem;padding-left:1.05rem}
.tl .ach li{margin:.42rem 0;font-size:.915rem;line-height:1.6;color:var(--ink-2)}
.tl .ach li::marker{color:var(--accent)}
.tl .e[open] .ach li{animation:rise .5s cubic-bezier(.22,.8,.3,1) both}
.tl .e[open] .ach li:nth-child(2){animation-delay:.03s}
.tl .e[open] .ach li:nth-child(3){animation-delay:.06s}
.tl .e[open] .ach li:nth-child(4){animation-delay:.09s}
.tl .e[open] .ach li:nth-child(n+5){animation-delay:.12s}

/* ---- section heading with a lede --------------------------------------- */
.sechead{margin:3.4rem 0 1rem}
.sechead h2{margin:.15rem 0 .5rem;border:0;padding:0;font-size:1.5rem;letter-spacing:-.018em}
.sechead p{margin:0;color:var(--ink-3);font-size:.95rem;max-width:40rem}
.sechead.reveal h2.r{opacity:1;transform:none}

/* ---- SMTP session panel ------------------------------------------------
   A real handshake, typed out. It is the one thing on the page that says what
   this work actually is without a sentence of explanation. */
.term{border:1px solid var(--line);border-radius:14px;background:var(--code);
  overflow:hidden;margin:1.2rem 0 0;box-shadow:0 18px 44px -28px rgba(0,0,0,.55)}
.term .bar{display:flex;align-items:center;gap:.45rem;padding:.6rem .9rem;
  border-bottom:1px solid var(--line);background:var(--surface)}
.term .bar i{width:9px;height:9px;border-radius:50%;background:var(--line);display:block}
.term .bar span{margin-left:.5rem;font-size:.74rem;color:var(--ink-3);
  font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.term pre{margin:0;border:0;border-radius:0;background:none;padding:1rem 1.1rem 1.15rem;
  font-size:.795rem;line-height:1.72;height:23rem;overflow-y:auto;overscroll-behavior:contain;
  white-space:pre-wrap;word-break:break-word;scrollbar-width:thin}
.term .c{color:var(--ink)}                       /* what we send */
.term .s{color:var(--ink-3)}                     /* what the server says */
.term .ok{color:var(--ok);font-weight:600}       /* a 2xx */
.term .cmd{color:var(--accent);font-weight:600}  /* the shell line */
.term .info{color:var(--ink-3);opacity:.8}       /* swaks talking, not the server */
.term .cur{display:inline-block;width:.5em;height:1.05em;vertical-align:-.16em;
  background:var(--accent);animation:blink 1.05s steps(1) infinite}
@keyframes blink{50%{opacity:0}}
@media(max-width:34rem){.term pre{font-size:.695rem;height:19rem}}

/* ---- buttons: one definition, three sizes -------------------------------- */
.btn{font:inherit;font-size:var(--t3);font-weight:650;cursor:pointer;
  padding:.72rem 1.4rem;border-radius:10px;border:1px solid var(--accent);
  background:var(--accent);color:#08140d;
  transition:transform .2s,opacity .2s,border-color .2s,color .2s,background .2s}
.btn:hover{transform:translateY(-1px)}
.btn:focus-visible{outline:2px solid var(--accent-2);outline-offset:2px}
.btn:disabled{opacity:.55;cursor:progress;transform:none}
.btn.ghost{background:var(--bg);color:var(--ink-2);border-color:var(--line);font-weight:500}
.btn.ghost:hover{border-color:var(--accent);color:var(--accent)}
.btn.sm{font-size:var(--t1);padding:.3rem .7rem;border-radius:7px}

/* ---- fields: one definition, one focus ring ------------------------------ */
.field{width:100%;background:var(--bg);color:var(--ink);
  border:1px solid var(--line);border-radius:10px;padding:.72rem .9rem;
  font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:var(--t3);
  line-height:1.55;transition:border-color .2s,box-shadow .2s}
.field:focus{outline:0;border-color:var(--accent);
  box-shadow:0 0 0 3px color-mix(in srgb,var(--accent) 18%,transparent)}
textarea.field{min-height:5.2rem;resize:vertical;font-size:var(--t2)}
.lbl-mi{display:block;font-size:.735rem;letter-spacing:.09em;text-transform:uppercase;
  color:var(--ink-3);font-weight:650;margin-bottom:var(--s2)}

/* ---- tool panel: the shell every tool sits in ---------------------------- */
.tool{border:1px solid var(--line);border-radius:16px;background:var(--surface);
  padding:var(--s4) var(--s4) 1.35rem;margin:var(--s4) 0 0;position:relative;overflow:hidden}
.tool::before{content:"";position:absolute;inset:0 0 auto 0;height:2px;
  background:linear-gradient(90deg,var(--accent),transparent 65%)}
.tool .row{display:flex;gap:var(--s2);flex-wrap:wrap}
.tool .row .field{flex:1 1 16rem;min-width:0;width:auto}
.tool .hint{display:flex;gap:.4rem;flex-wrap:wrap;margin:.75rem 0 0;
  font-size:var(--t1);color:var(--ink-3);align-items:center}
.tool .hint a,.tool .hint button{font:inherit;font-size:var(--t1);cursor:pointer;
  color:var(--ink-2);text-decoration:none;border:1px solid var(--line);
  border-radius:7px;padding:.2rem .55rem;background:var(--bg);
  transition:border-color .2s,color .2s}
.tool .hint a:hover,.tool .hint button:hover{border-color:var(--accent);color:var(--accent)}
.empty{color:var(--ink-3);font-size:var(--t2);line-height:1.6;margin:var(--s3) 0 0}

/* ---- filter: search field + chip row for the reference ------------------- */
.filter{margin:var(--s4) 0 var(--s3)}
.filter input{margin-bottom:.7rem}
.filter .chips{display:flex;gap:.4rem;flex-wrap:wrap;align-items:center}
.filter .count{font-size:var(--t1);color:var(--ink-3);margin-left:auto;
  font-variant-numeric:tabular-nums}
button.chip{font:inherit;cursor:pointer}
.hidden{display:none!important}

/* ---- breadcrumbs --------------------------------------------------------- */
.crumb{font-size:var(--t1);color:var(--ink-3);margin:0 0 var(--s3);display:flex;
  gap:.45rem;flex-wrap:wrap;align-items:center}
.crumb a{color:var(--ink-3);text-decoration:none}
.crumb a:hover{color:var(--accent)}
.crumb span{opacity:.5}

/* ---- classifier verdict --------------------------------------------------- */
.verdict{margin-top:1rem;border-top:1px solid var(--line);padding-top:1rem;
  opacity:0;transform:translateY(8px);transition:opacity .35s,transform .35s}
.verdict.on{opacity:1;transform:none}
.verdict .head{display:flex;gap:.55rem;align-items:center;flex-wrap:wrap}
.verdict .act{font-size:.72rem;letter-spacing:.09em;text-transform:uppercase;font-weight:700;
  padding:.24rem .6rem;border-radius:100px;border:1px solid currentColor}
.verdict .cat{font-weight:680;font-size:1.06rem;letter-spacing:-.012em}
.verdict .prov{font-size:.78rem;color:var(--ink-3)}
.verdict .why{margin:.6rem 0 0;font-size:.93rem;color:var(--ink-2)}
.verdict .lnk{margin:.7rem 0 0;font-size:.875rem}
/* Action colours are a status palette, reserved for state and never reused as
   series colours. Each ships with its word, so it is never colour alone. */
.a-suppress,.a-pause{color:var(--bad)}
.a-throttle,.a-review,.a-fix_config{color:var(--warn)}
.a-retry{color:var(--info)}

.sr{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;
  clip:rect(0,0,0,0);white-space:nowrap;border:0}

/* ---- tool result surfaces ------------------------------------------------ */
.report{opacity:0;transform:translateY(8px);transition:opacity .35s,transform .35s;margin-top:1.6rem}
.report.on{opacity:1;transform:none}
.report .head{display:flex;align-items:baseline;justify-content:space-between;gap:1rem;flex-wrap:wrap}
.report h2{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:1.15rem;
  border:0;padding:0;margin:0}
.report .verdict-line{margin:.7rem 0 0;font-size:.97rem;font-weight:600}
.report .tiles{display:grid;grid-template-columns:repeat(4,1fr);gap:.5rem;margin:1rem 0 1.6rem}
.report .t{background:var(--surface);border:1px solid var(--line);border-radius:10px;
  padding:.7rem .8rem;text-align:center}
.report .t b{display:block;font-size:1.5rem;font-weight:680;font-variant-numeric:tabular-nums;line-height:1.1}
.report .t span{display:block;font-size:.72rem;letter-spacing:.09em;text-transform:uppercase;
  color:var(--ink-3);margin-top:.2rem}
.report .grp{margin:0 0 1.5rem}
.report .grp h3{font-size:.76rem;letter-spacing:.11em;text-transform:uppercase;color:var(--ink-3);
  margin:0 0 .5rem;font-weight:650}
.report .grp ul{list-style:none;padding:0;margin:0}
.report .grp li{border-left:2px solid var(--line);padding:.5rem 0 .6rem .85rem;margin:0 0 .45rem}
.report .pill{display:inline-block;font-size:.66rem;letter-spacing:.09em;text-transform:uppercase;
  font-weight:700;padding:.16rem .5rem;border-radius:100px;border:1px solid currentColor;
  margin-right:.5rem;vertical-align:1px}
.report .f{font-size:.95rem;color:var(--ink)}
.report .rem{display:block;font-size:.875rem;color:var(--ink-3);margin-top:.3rem;line-height:1.55}
.report .det{display:block;font-size:.76rem;color:var(--ink-3);margin-top:.35rem;
  background:var(--code);border:1px solid var(--line);border-radius:6px;padding:.35rem .5rem;
  overflow-x:auto;white-space:pre-wrap;word-break:break-all}
.report .note{font-size:.855rem;color:var(--ink-3);line-height:1.6;margin:1.4rem 0 0;
  border-top:1px solid var(--line);padding-top:1rem}
/* Severity is a reserved status palette, never reused for anything decorative,
   and every one of them ships with its word so it is never colour alone. */
.s-fail{color:var(--bad)} .s-warn{color:var(--warn)}
.s-info{color:var(--info)} .s-ok{color:var(--ok)}
.report .grp li.s-fail{border-left-color:var(--bad)}
.report .grp li.s-warn{border-left-color:var(--warn)}
.report .grp li.s-ok{border-left-color:color-mix(in srgb,var(--ok) 45%,transparent)}
.report .t.s-fail b{color:var(--bad)} .report .t.s-warn b{color:var(--warn)}
.report .t.s-info b{color:var(--info)} .report .t.s-ok b{color:var(--ok)}
@media(max-width:34rem){.report .tiles{grid-template-columns:repeat(2,1fr)}}

/* ---- footer -------------------------------------------------------------- */
footer{margin-top:var(--s6);padding-top:var(--s4);border-top:1px solid var(--line);
  color:var(--ink-3);font-size:var(--t2)}
footer .cols{display:grid;grid-template-columns:repeat(auto-fit,minmax(10rem,1fr));
  gap:var(--s4) var(--s3);margin-bottom:var(--s4)}
footer h2{font-size:var(--t0);letter-spacing:.11em;text-transform:uppercase;
  color:var(--ink-3);margin:0 0 .55rem;padding:0;border:0;font-weight:650}
footer .cols a{display:block;color:var(--ink-2);text-decoration:none;
  padding:.16rem 0;font-size:var(--t2);transition:color .16s}
footer .cols a:hover{color:var(--accent)}
footer .by{margin:0;line-height:1.6;max-width:44rem}

/* ---- scroll reveal ---------------------------------------------------- */
.r{opacity:0;transform:translateY(16px);transition:opacity .7s ease,transform .7s cubic-bezier(.22,.7,.3,1)}
.r.reveal{opacity:1;transform:none}
.strip.reveal div,.bento.reveal .card{animation:pop .55s cubic-bezier(.22,.9,.3,1) both}
.strip.reveal div:nth-child(2),.bento.reveal .card:nth-child(2){animation-delay:.07s}
.strip.reveal div:nth-child(3),.bento.reveal .card:nth-child(3){animation-delay:.14s}
.strip.reveal div:nth-child(4),.bento.reveal .card:nth-child(4){animation-delay:.21s}
@keyframes pop{from{opacity:0;transform:translateY(12px) scale(.97)}to{opacity:1;transform:none}}
h1{animation:rise .85s cubic-bezier(.22,.8,.3,1) both}
.lede{animation:rise .85s cubic-bezier(.22,.8,.3,1) .1s both}
.hero img{animation:rise .85s cubic-bezier(.22,.8,.3,1) .18s both}
@keyframes rise{from{opacity:0;transform:translateY(18px)}to{opacity:1;transform:none}}

@media(prefers-reduced-motion:reduce){
  html{scroll-behavior:auto}
  #hexcanvas{display:none}
  h1,.lede,.hero img,.strip.reveal div,.bento.reveal .card{animation:none;opacity:1;transform:none}
  .verdict{transition:none}
  .tl .e[open] .ach li{animation:none}
  .term .cur{animation:none;opacity:0}
  .r{opacity:1;transform:none;transition:none}
  .bar-fill{transition:none;width:var(--w)}
  .grid a:hover{transform:none}
}
@media(max-width:34rem){
  .portrait{max-width:38%;margin-left:1rem}
  h2{margin-top:2.3rem}
}
"""

JS = """
(function(){
  var reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  var ticking=false, SY=0;
  function onScroll(){
    SY = scrollY/Math.max(1, document.body.scrollHeight-innerHeight);
    document.documentElement.style.setProperty('--sy', SY.toFixed(4));
    ticking=false;
  }
  addEventListener('scroll',function(){if(!ticking){ticking=true;requestAnimationFrame(onScroll);}},{passive:true});
  onScroll();

  var targets = document.querySelectorAll('.r,.bars,.strip,.bento,.grid,.stats,.tool,.tl,.sechead,.chips-row,.panel,.tree,.session');
  if(!('IntersectionObserver' in window) || reduce){
    targets.forEach(function(n){n.classList.add('reveal'); countUp(n);});
  } else {
    var io=new IntersectionObserver(function(es){
      es.forEach(function(e){
        if(!e.isIntersecting) return;
        e.target.classList.add('reveal'); io.unobserve(e.target); countUp(e.target);
      });
    },{rootMargin:'0px 0px -6% 0px',threshold:.06});
    targets.forEach(function(n){io.observe(n);});
  }

  function countUp(root){
    root.querySelectorAll('.n, .strip b, b').forEach(function(el){
      if(el.dataset.done) return;
      var raw=el.textContent, m=raw.match(/[\d][\d.,]*/);
      if(!m) return;
      el.dataset.done=1;
      var end=parseFloat(m[0].replace(/,/g,'')), dec=(m[0].split('.')[1]||'').length;
      var pre=raw.slice(0,m.index), post=raw.slice(m.index+m[0].length), t0=null;
      function f(ts){
        if(!t0)t0=ts;
        var p=Math.min(1,(ts-t0)/950), e=1-Math.pow(1-p,3), v=end*e;
        el.textContent = pre+(dec?v.toFixed(dec):Math.round(v).toLocaleString())+post;
        if(p<1) requestAnimationFrame(f);
      }
      el.textContent=pre+(dec?'0.0':'0')+post;
      requestAnimationFrame(f);
    });
  }

  /* The SMTP session types itself out once, when it comes into view.
     Client lines are typed a character at a time because that is what sending
     one feels like; server responses land whole, because that is what they do. */
  (function(){
    var term=document.getElementById('term'), out=document.getElementById('term-out');
    if(!term||!out) return;
    var lines;
    try{ lines=JSON.parse(term.getAttribute('data-session')); }catch(err){ return; }

    function esc(s){return String(s).replace(/[&<>]/g,function(c){
      return {'&':'&amp;','<':'&lt;','>':'&gt;'}[c];});}
    function whole(){
      out.innerHTML=lines.map(function(l){
        return '<span class="'+l.k+'">'+esc(l.t)+'</span>';}).join('\\n');
    }
    if(reduce){ whole(); return; }

    var playing=false;
    function play(){
      if(playing) return; playing=true;
      out.innerHTML=''; var i=0;
      function line(){
        if(i>=lines.length){ playing=false; return; }
        var l=lines[i++], sp=document.createElement('span');
        sp.className=l.k;
        out.appendChild(sp);
        out.appendChild(document.createTextNode('\\n'));
        out.parentNode.scrollTop = out.parentNode.scrollHeight;
        var typed = (l.k==='cmd');
        if(!typed){ sp.textContent=l.t;
          setTimeout(line, l.k==='info'?70:(l.k==='c'?150:95)); return; }
        var j=0;
        (function ch(){
          sp.textContent=l.t.slice(0,++j);
          if(j<l.t.length) setTimeout(ch, 15);
          else setTimeout(line, 260);
        })();
      }
      line();
    }
    if('IntersectionObserver' in window){
      var to=new IntersectionObserver(function(es){
        es.forEach(function(en){ if(en.isIntersecting){ play(); to.unobserve(en.target); } });
      },{threshold:.3});
      to.observe(term);
    } else { play(); }
    term.addEventListener('click',function(){ if(!playing) play(); });
    term.style.cursor='pointer';
    term.title='Replay';
  })();

  /* Living honeycomb: cells brighten near the pointer, and packets route from
     node to node, which is what this site is about. Pauses when tab is hidden. */
  if(reduce) return;
  var cv=document.createElement('canvas');
  cv.id='hexcanvas'; cv.setAttribute('aria-hidden','true');
  document.body.insertBefore(cv, document.body.firstChild);
  var veil=document.createElement('div');
  veil.className='hexveil'; veil.setAttribute('aria-hidden','true');
  document.body.insertBefore(veil, cv.nextSibling);

  var ctx=cv.getContext('2d'), DPR=Math.min(2,devicePixelRatio||1);
  var R=36, nodes=[], packets=[], mx=-1e4, my=-1e4, raf=null;
  function accent(){return (getComputedStyle(document.documentElement).getPropertyValue('--hex')||'#1f4e79').trim();}
  function rgb(h){h=h.replace('#','');if(h.length===3)h=h.split('').map(function(c){return c+c}).join('');
    var n=parseInt(h,16);return [n>>16&255,n>>8&255,n&255].join(',');}
  var C=rgb(accent());

  function build(){
    cv.width=innerWidth*DPR; cv.height=innerHeight*DPR;
    cv.style.width=innerWidth+'px'; cv.style.height=innerHeight+'px';
    var dx=R*Math.sqrt(3), dy=R*1.5; nodes=[];
    for(var row=-2,y=-dy*2; y<innerHeight+dy*3; row++,y+=dy)
      for(var x=(row%2?dx/2:0)-dx; x<innerWidth+dx; x+=dx) nodes.push({x:x,y:y,g:0});
    packets=[]; for(var i=0;i<16;i++) spawn();
  }
  function spawn(){ if(!nodes.length)return;
    var a=nodes[(Math.random()*nodes.length)|0];
    packets.push({x:a.x,y:a.y,tx:a.x,ty:a.y,t:1,sp:.007+Math.random()*.011,life:0}); }
  function hex(x,y,r){ctx.beginPath();
    for(var i=0;i<6;i++){var a=Math.PI/180*(60*i-30),px=x+r*Math.cos(a),py=y+r*Math.sin(a);
      i?ctx.lineTo(px,py):ctx.moveTo(px,py);} ctx.closePath();}

  function draw(){
    ctx.setTransform(DPR,0,0,DPR,0,0);
    ctx.clearRect(0,0,innerWidth,innerHeight);
    var drift=SY*-130;
    for(var i=0;i<nodes.length;i++){
      var n=nodes[i], y=n.y+drift;
      if(y<-R*2||y>innerHeight+R*2) continue;
      var d=Math.hypot(n.x-mx,y-my), near=d<210?(1-d/210):0;
      n.g+=(near-n.g)*.1;
      ctx.strokeStyle='rgba('+C+','+(.07+n.g*.5).toFixed(3)+')';
      ctx.lineWidth=1+n.g*1.1;
      hex(n.x,y,R*.9); ctx.stroke();
      if(n.g>.2){ctx.fillStyle='rgba('+C+','+(n.g*.075).toFixed(3)+')';ctx.fill();}
    }
    for(var j=packets.length-1;j>=0;j--){
      var p=packets[j]; p.t+=p.sp;
      if(p.t>=1){
        var fx=p.tx, fy=p.ty, cand=null, best=1e9;
        for(var k=0;k<26;k++){var q=nodes[(Math.random()*nodes.length)|0];
          var dd=Math.hypot(q.x-fx,q.y-fy);
          if(dd>R*1.3&&dd<R*2.3&&dd<best){best=dd;cand=q;}}
        if(!cand||p.life>28){packets.splice(j,1);spawn();continue;}
        p.x=fx;p.y=fy;p.tx=cand.x;p.ty=cand.y;p.t=0;p.life++;
      }
      var e=p.t<.5?2*p.t*p.t:1-Math.pow(-2*p.t+2,2)/2;
      var cx=p.x+(p.tx-p.x)*e, cy=p.y+(p.ty-p.y)*e+drift;
      if(cy<-40||cy>innerHeight+40) continue;
      var g=ctx.createLinearGradient(p.x,p.y+drift,cx,cy);
      g.addColorStop(0,'rgba('+C+',0)'); g.addColorStop(1,'rgba('+C+',.34)');
      ctx.strokeStyle=g; ctx.lineWidth=1.5;
      ctx.beginPath();ctx.moveTo(p.x,p.y+drift);ctx.lineTo(cx,cy);ctx.stroke();
      ctx.fillStyle='rgba('+C+',.6)';
      ctx.beginPath();ctx.arc(cx,cy,2,0,7);ctx.fill();
    }
    raf=requestAnimationFrame(draw);
  }
  addEventListener('pointermove',function(e){mx=e.clientX;my=e.clientY;},{passive:true});
  addEventListener('resize',build,{passive:true});
  document.addEventListener('visibilitychange',function(){
    if(document.hidden){cancelAnimationFrame(raf);raf=null;} else if(!raf){raf=requestAnimationFrame(draw);}});
  build(); draw();
})();
"""


FAVICON = (
    "data:image/svg+xml,"
    "%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E"
    "%3Crect width='32' height='32' rx='7' fill='%230a0e0d'/%3E"
    "%3Cpath d='M16 5l9.5 5.5v11L16 27l-9.5-5.5v-11z' fill='none' "
    "stroke='%233ddc84' stroke-width='2.4'/%3E"
    "%3Ccircle cx='16' cy='16' r='2.6' fill='%233ddc84'/%3E%3C/svg%3E"
)


# One registry, four consumers: the nav, the homepage grid, the /tools/ index and
# the footer. The audit found "Domain check" / "Check a domain" / "Check a domain's
# email authentication" all naming the same page; a single list is what stops that
# happening again. `q` is the question the tool answers, which is what a visitor is
# actually searching for.
TOOLS = [
    {
        "slug": "check", "name": "Domain check",
        "q": "Is this domain's email authentication set up correctly?",
        "blurb": "SPF, DKIM, DMARC, MTA-STS, TLS-RPT and BIMI for any domain, including "
                 "the RFC 7208 ten-lookup limit and whether an MTA-STS policy really "
                 "exists behind the record that promises one.",
        "tag": "DNS",
    },
    {
        "slug": "bounce", "name": "Bounce classifier",
        "q": "What is this bounce or deferral telling me?",
        "blurb": "Paste an SMTP response and get the category and the action it needs: "
                 "retry, back off, suppress, or stop and fix the sender. Hard and soft "
                 "bounce is too coarse to act on.",
        "tag": "Logs",
    },
    {
        "slug": "dmarc", "name": "DMARC report reader",
        "q": "Who is sending mail as my domain, and what is failing?",
        "blurb": "Drop in an aggregate (rua) report and read it: every source, what "
                 "aligned, what did not, and which ones to fix first. The file is "
                 "parsed in this tab and never uploaded.",
        "tag": "Reports",
    },
    {
        "slug": "spf", "name": "SPF lookup counter",
        "q": "How close is this SPF record to the ten-lookup limit?",
        "blurb": "The full include tree with a running DNS lookup count, and the exact "
                 "mechanism that tips a record over ten and turns it into a permerror.",
        "tag": "DNS",
    },
]

# Destinations, in nav order. The label here is the only name each section has: it is
# the nav link, the footer link, and the head of the destination's h1.
NAV = [
    ("Tools", "tools/"),
    ("Reference", "smtp/"),
    ("Research", "research/"),
    ("About", "about/"),
]


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


def page(title, desc, body, path, extra_ld=None, is_home=False, wide=False,
         scripts=(), modules=(), nav_key=None, crumbs=()):
    """Every page carries the Person node, not just the home page.

    Pages all over the site point their author and publisher at {SITE}/#person by
    @id. If the node itself is only defined on one page, every other page hands a
    crawler a dangling reference and no identity at all. Emitting it everywhere is
    what makes twenty-three pages resolve to one entity instead of one page doing
    the work and twenty-two pointing at nothing.

    The cost is about 1.2 KB of gzipped JSON per page. The benefit is that a
    reference page someone lands on from a search for 550 5.7.606 still says, in
    machine-readable form, who wrote it.
    """
    graph = [person_ld(), {
        "@type": "WebSite", "@id": f"{SITE}/#website", "url": SITE + "/",
        "name": "rastu.tech", "publisher": {"@id": f"{SITE}/#person"},
        "inLanguage": "en",
    }]
    if crumbs:
        trail = [("Home", "")] + list(crumbs)
        graph.append({
            "@type": "BreadcrumbList",
            "itemListElement": [
                dict({"@type": "ListItem", "position": i + 1, "name": label},
                     **({"item": SITE + "/" + href} if href else {}))
                for i, (label, href) in enumerate(trail)],
        })
    if extra_ld:
        # A page's own node joins the graph rather than sitting in its own script,
        # so @id references resolve inside one document.
        for node in extra_ld.get("@graph", [extra_ld]):
            node = {k: v for k, v in node.items() if k != "@context"}
            node.setdefault("author", {"@id": f"{SITE}/#person"})
            node.setdefault("isPartOf", {"@id": f"{SITE}/#website"})
            graph.append(node)
    ld = ('<script type="application/ld+json">'
          + json.dumps({"@context": "https://schema.org", "@graph": graph},
                       ensure_ascii=False)
          + "</script>")
    canonical = SITE + ("/" if path == "index.html" else "/" + path.replace("index.html", ""))
    depth = path.count("/")
    up = "../" * depth

    # Python 3.9 f-strings cannot carry a backslash, so the attribute is built first.
    def nav_link(label, href):
        cur = ' aria-current="page"' if nav_key == label else ""
        return '<a href="' + up + href + '"' + cur + ">" + label + "</a>"

    nav_links = "\n  ".join(nav_link(lbl, href) for lbl, href in NAV)

    # Breadcrumbs are for the reader who landed from a search on one code page and
    # has no idea the rest of the site exists. They also emit BreadcrumbList.
    crumb_html = ""
    if crumbs:
        parts = ['<a href="' + up + '">Home</a>']
        for label, href in crumbs:
            parts.append("<span>/</span>")
            parts.append(f'<a href="{up}{href}">{e(label)}</a>' if href else e(label))
        crumb_html = '<nav class="crumb" aria-label="Breadcrumb">' + "".join(parts) + "</nav>"
    doc = f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>{e(title)}</title>
<meta name="description" content="{e(desc)}">
<meta name="author" content="{e(PERSON['name'])}">
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
<link rel="icon" href="{FAVICON}">
<link rel="apple-touch-icon" href="/rastu-singh-180.jpg">
<meta name="theme-color" content="#0a0e0d">
<style>{CSS}</style>
{ld}
</head>
<body>
<div class="wrap{' wide' if wide else ''}">
<a class="skip" href="#main">Skip to content</a>
<nav class="top" aria-label="Primary">
  <a class="mark" href="{up or '/'}">rastu<span>.tech</span></a>
  {nav_links}
</nav>
{crumb_html}
<main id="main">
{body}
</main>
<footer>
  <div class="cols">
    <div>
      <h2>Tools</h2>
      {chr(10).join(f'      <a href="{up}{t["slug"]}/">{e(t["name"])}</a>' for t in TOOLS)}
      <a href="{up}tools/">All tools</a>
    </div>
    <div>
      <h2>Reference</h2>
      <a href="{up}smtp/">SMTP responses</a>
      <a href="{up}smtp/session/">Anatomy of a session</a>
    </div>
    <div>
      <h2>Research</h2>
      <a href="{up}research/">State of email authentication</a>
      <a href="{SITE}/scan-100000.jsonl.gz">Raw dataset</a>
    </div>
    <div>
      <h2>Elsewhere</h2>
      <a href="https://github.com/singhrastu">GitHub</a>
      <a href="https://www.linkedin.com/in/rastu">LinkedIn</a>
      <a href="https://orcid.org/{PERSON['orcid']}">ORCID</a>
    </div>
  </div>
  <p class="by">Built and maintained by <a href="{up}about/">{e(PERSON['name'])}</a>,
     {e(PERSON['job_title'])}, {e(PERSON['locality'])}.
     Everything here runs in your browser.</p>
</footer>
</div>
<script>{JS}</script>
{chr(10).join(f'<script src="{x if x.startswith("/") else up+x}" defer></script>' for x in scripts)}
{chr(10).join(f'<script type="module" src="{x}"></script>' for x in modules)}
</body>
</html>
"""
    # wrap tables so wide data scrolls inside its own container rather than
    # forcing the page to scroll sideways
    doc = doc.replace("<table>", '<div class="scroll-x r"><table>').replace(
        "</table>", "</table></div>")
    # Scroll-reveal only inside <main>. The footer's column headings are <h2> too,
    # and the observer never reaches them, so a blanket replace hid them for good.
    head, sep, rest = doc.partition('<main id="main">')
    body_part, sep2, tail = rest.partition("</main>")
    doc = head + sep + body_part.replace("<h2>", '<h2 class="r">') + sep2 + tail

    full = os.path.join(OUT, path)
    os.makedirs(os.path.dirname(full), exist_ok=True)
    open(full, "w", encoding="utf8").write(doc)
    return canonical


# Human labels for the smtpsift categories. The category names are machine keys;
# these are what a person reads.
CATEGORY_LABEL = {
    "invalid_recipient": "Invalid recipient",
    "mailbox_full": "Mailbox full",
    "mailbox_inactive": "Mailbox inactive",
    "reputation_block": "Reputation block",
    "content_block": "Content block",
    "blocklist": "Blocklist listing",
    "rate_limited": "Rate limited",
    "greylisted": "Greylisted",
    "auth_failure": "Authentication failure",
    "policy_block": "Recipient policy",
    "connection": "Connection failure",
    "transient": "Transient failure",
    "unknown": "Unrecognised",
}

# The stack, shown as chips on the About page where the prose gives it context.
STACK = [
    ("MTAs", ["PowerMTA", "KumoMTA", "Postfix", "Haraka", "Momentum", "GreenArrow"]),
    ("Authentication", ["SPF", "DKIM", "DMARC", "MTA-STS", "TLS-RPT", "BIMI", "ARC"]),
    ("Reputation", ["IP warm-up", "Pool design", "Spamhaus", "Postmaster Tools", "SNDS",
                    "Complaint feedback loops"]),
    ("Filtering", ["Rspamd", "SpamAssassin", "Milter", "Content policy"]),
    ("Platform", ["Linux", "Terraform", "Ansible", "Python", "Bash", "Prometheus",
                  "Grafana", "AWS", "Azure"]),
]

# Career comes from the resume, via build/export_career.py. The resume is the
# source of truth about what he has done; a site that disagrees with the CV is
# worse than no site.
with open(os.path.join(HERE, "career.json"), encoding="utf8") as _fh:
    CAREER = json.load(_fh)["roles"]


def stack_html():
    return '<div class="stack r">' + "".join(
        '<div class="row"><span class="lbl">' + e(lbl) + "</span>"
        + "".join(f'<span class="chip">{e(c)}</span>' for c in items) + "</div>"
        for lbl, items in STACK) + "</div>"


def career_html():
    """The career as a set of disclosures.

    <details> rather than JavaScript, for two reasons: it works with no script and
    it keeps every achievement in the DOM, so search engines and LLM retrievers
    read all of it whether or not a human ever clicks. A tab widget would hide the
    content from exactly the readers this page exists for.
    """
    out = ['<div class="tl">']
    for r in CAREER:
        ach = "".join(f"<li>{e(a)}</li>" for a in r["achievements"])
        loc = f" &middot; {e(r['location'])}" if r.get("location") else ""
        out.append(
            f'<details class="e">'
            f'<summary>'
            f'<span class="role">{e(r["title"])}</span>'
            f'<span class="org">{e(r["company"])}{loc}</span>'
            f'<span class="yr">{e(r["years"])}'
            f'<span class="n">{len(r["achievements"])} achievements</span></span>'
            f'</summary>'
            f'<ul class="ach">{ach}</ul>'
            f"</details>")
    out.append("</div>")
    return "".join(out)


# A real swaks session, captured against Gmail's MX on 2026-09-18 with
# --quit-after RCPT, so the handshake completes and no message is ever sent:
#
#   swaks --to postmaster@gmail.com --from rastu@rastu.tech \
#         --server gmail-smtp-in.l.google.com --ehlo rastu.tech --tls \
#         --quit-after RCPT
#
# The only edit is the client IP, replaced with an RFC 5737 documentation
# address. Every server response is verbatim.
#
# swaks prefixes are worth knowing if you are reading this off the page:
#   ===  swaks talking to you        ->  sent in the clear    <-  received in the clear
#                                    ~>  sent over TLS        <~  received over TLS
# The second EHLO is not a mistake. STARTTLS resets the session, so the
# capabilities have to be asked for again inside the encrypted channel.
SMTP_SESSION = [
    ("cmd",  "$ swaks --to postmaster@gmail.com --from rastu@rastu.tech \\"),
    ("cmd",  "        --server gmail-smtp-in.l.google.com --ehlo rastu.tech \\"),
    ("cmd",  "        --tls --quit-after RCPT"),
    ("info", "=== Trying gmail-smtp-in.l.google.com:25..."),
    ("info", "=== Connected to gmail-smtp-in.l.google.com."),
    ("ok",   "<-  220 mx.google.com ESMTP 4fb4d7f45d1cf-6aa67d1108csi.33 - gsmtp"),
    ("c",    " -> EHLO rastu.tech"),
    ("s",    "<-  250-mx.google.com at your service, [198.51.100.24]"),
    ("s",    "<-  250-SIZE 157286400"),
    ("s",    "<-  250-STARTTLS"),
    ("s",    "<-  250-ENHANCEDSTATUSCODES"),
    ("s",    "<-  250 SMTPUTF8"),
    ("c",    " -> STARTTLS"),
    ("ok",   "<-  220 2.0.0 Ready to start TLS"),
    ("info", "=== TLS started with cipher TLSv1.3:AEAD-CHACHA20-POLY1305-SHA256:256"),
    ("info", "=== TLS peer[0]   subject=[/CN=mx.google.com]"),
    ("info", "=== TLS peer certificate passed CA verification, passed host verification"),
    ("c",    " ~> EHLO rastu.tech"),
    ("s",    "<~  250-mx.google.com at your service, [198.51.100.24]"),
    ("s",    "<~  250 SMTPUTF8"),
    ("c",    " ~> MAIL FROM:<rastu@rastu.tech>"),
    ("ok",   "<~  250 2.1.0 OK 4fb4d7f45d1cf-6aa67d1108csi.33 - gsmtp"),
    ("c",    " ~> RCPT TO:<postmaster@gmail.com>"),
    ("ok",   "<~  250 2.1.5 OK 4fb4d7f45d1cf-6aa67d1108csi.33 - gsmtp"),
    ("c",    " ~> QUIT"),
    ("ok",   "<~  221 2.0.0 closing connection 4fb4d7f45d1cf-6aa67d1108csi.33 - gsmtp"),
    ("info", "=== Connection closed with remote host."),
]

# Shown under the box so the tool is usable without a log to hand.
SIFT_EXAMPLES = [
    ("Gmail throttle",
     "421-4.7.28 Our system has detected an unusual rate of unsolicited mail "
     "originating from your IP address. gsmtp"),
    ("Outlook block",
     "550 5.7.606 Access denied, banned sending IP [203.0.113.9] "
     "(S3140) protection.outlook.com"),
    ("Spamhaus",
     "554 5.7.1 Service unavailable; Client host [203.0.113.9] blocked using "
     "zen.spamhaus.org"),
    ("DMARC",
     "550 5.7.26 Unauthenticated email from example.com is not accepted due to "
     "domain's DMARC policy."),
    ("Dead address",
     "550 5.1.1 The email account that you tried to reach does not exist."),
]


def build_sift():
    """Emit the classifier as a standalone script.

    The ruleset is exported from smtpsift at build time rather than retyped, so
    the page and the CLI cannot drift apart. Regenerate with:
        python3 build/export_rules.py
    """
    with open(os.path.join(HERE, "sift_rules.json"), encoding="utf8") as fh:
        rules = json.load(fh)

    # Every response that has its own reference page, longest code first so
    # "5.7.26" is preferred over a bare "5.7.2" prefix match.
    pages = sorted(
        [{"code": c["code"], "provider": c.get("provider"), "url": "/smtp/" + slug(c) + "/",
          "title": c["title"]} for c in CODES],
        key=lambda x: -len(x["code"]))

    data = {
        "rules": rules["rules"],
        "actions": rules["actions"],
        "providers": rules["providers"],
        "labels": CATEGORY_LABEL,
        "pages": pages,
    }

    js = "/* Bounce classifier. Ruleset exported from github.com/singhrastu/smtpsift. */\n"
    js += "(function(){\nvar D=" + json.dumps(data, ensure_ascii=False) + ";\n" + r"""
var box=document.getElementById('sift-in'), out=document.getElementById('sift-out');
if(!box||!out) return;

var RX=D.rules.map(function(r){return {c:r.category,p:r.provider,n:r.note,
  rx:new RegExp(r.pattern,'i')};});
var PRX=Object.keys(D.providers).map(function(k){
  return {k:k,rx:new RegExp(D.providers[k],'i')};});

function esc(s){return String(s).replace(/[&<>"]/g,function(c){
  return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];});}

function classify(t){
  for(var i=0;i<RX.length;i++) if(RX[i].rx.test(t)) return RX[i];
  return {c:'unknown',p:null,n:'No rule matched this response.'};
}
function provider(t,hint){
  if(hint) return hint;
  for(var i=0;i<PRX.length;i++) if(PRX[i].rx.test(t)) return PRX[i].k;
  return null;
}
function refpage(t){
  for(var i=0;i<D.pages.length;i++){
    var p=D.pages[i];
    if(t.toLowerCase().indexOf(p.code.toLowerCase())>-1) return p;
  }
  return null;
}

var t0=null;
function run(){
  var t=box.value.trim();
  if(!t){out.className='verdict';out.innerHTML='';return;}
  var hit=classify(t), prov=provider(t,hit.p),
      act=D.actions[hit.c]||D.actions.unknown, page=refpage(t);
  var h='<div class="head">'
      + '<span class="act a-'+esc(act.action)+'">'+esc(act.action.replace('_',' '))+'</span>'
      + '<span class="cat">'+esc(D.labels[hit.c]||hit.c)+'</span>'
      + (prov?'<span class="prov">'+esc(prov)+'</span>':'')
      + '</div>'
      + '<p class="why">'+esc(hit.n)+'. '+esc(act.advice)+'</p>';
  if(page) h+='<p class="lnk"><a href="'+esc(page.url)+'">Read the '
           +esc((page.provider?page.provider+' ':'')+page.code)+' page &rarr;</a></p>';
  else h+='<p class="lnk"><a href="/smtp/">Browse the SMTP reference &rarr;</a></p>';
  out.innerHTML=h;
  out.className='verdict on';
}
box.addEventListener('input',function(){clearTimeout(t0);t0=setTimeout(run,140);});
Array.prototype.forEach.call(document.querySelectorAll('[data-ex]'),function(b){
  b.addEventListener('click',function(){box.value=b.getAttribute('data-ex');run();box.focus();});
});
run();
})();
"""
    open(os.path.join(OUT, "sift.js"), "w", encoding="utf8").write(js)


def tool_ld(tool, extra=None):
    """Every tool page declares itself a free SoftwareApplication authored by the
    same #person node, which is what ties the toolkit to the entity."""
    d = {
        "@context": "https://schema.org",
        "@type": "SoftwareApplication",
        "name": tool["name"],
        "url": f"{SITE}/{tool['slug']}/",
        "applicationCategory": "SecurityApplication",
        "operatingSystem": "Any",
        "description": tool["blurb"],
        "offers": {"@type": "Offer", "price": "0", "priceCurrency": "EUR"},
        "author": {"@id": f"{SITE}/#person"},
        "isAccessibleForFree": True,
    }
    if extra:
        d.update(extra)
    return d


def tool(slug):
    for t in TOOLS:
        if t["slug"] == slug:
            return t
    raise KeyError(slug)


def build_bounce():
    """The classifier, off the homepage and onto a page of its own.

    It was buried below a personal hero, which meant the one thing on the site a
    stranger could use immediately was the hardest thing to find.
    """
    t = tool("bounce")
    ex = "".join(
        f'<button type="button" data-ex="{e(v)}">{e(k)}</button>' for k, v in SIFT_EXAMPLES)

    body = f"""
<h1>Bounce classifier</h1>
<p class="lede">{e(t["q"])} Paste the response out of your mail log and get the category
and the action it needs.</p>

<div class="tool" id="sift">
  <label class="lbl-mi" for="sift-in">SMTP response</label>
  <textarea class="field" id="sift-in" spellcheck="false" autocomplete="off"
    placeholder="550 5.7.1 Service unavailable; Client host [203.0.113.9] blocked using zen.spamhaus.org"></textarea>
  <div class="hint">{ex}</div>
  <div class="verdict" id="sift-out" aria-live="polite"></div>
</div>

<h2>Why hard and soft bounce is not enough</h2>
<p>A full mailbox, a rate limit and a reputation block all arrive as soft bounces, and
they need opposite responses. Retry the full mailbox and it may clear. Retry the rate
limit and you make it worse. Retry the reputation block and you damage the sending IP
further while the underlying problem goes unfixed.</p>
<p>So the classifier answers with an action rather than a severity:</p>
<ul>
  <li><strong>retry</strong> &mdash; temporary at the receiving end. The normal schedule handles it.</li>
  <li><strong>throttle</strong> &mdash; you are sending faster than this provider will accept. Drop
      concurrency for that provider only, not globally.</li>
  <li><strong>suppress</strong> &mdash; permanent. Remove the address. Retrying costs reputation and
      dormant addresses turn into spam traps.</li>
  <li><strong>pause</strong> &mdash; a reputation or blocklist problem. Stop sending to this provider
      from this IP and fix the cause before resuming.</li>
  <li><strong>review</strong> &mdash; a content or recipient-side policy rule. Change the message, not
      the rate.</li>
  <li><strong>fix_config</strong> &mdash; an authentication failure. No amount of retrying helps.</li>
</ul>

<h2>Where the ruleset comes from</h2>
<p>The same ordered ruleset as <a href="https://github.com/singhrastu/smtpsift">smtpsift</a>,
exported at build time rather than retyped, so this page and the command-line tool cannot
disagree about what a response means. Nothing is trained: it is regular expressions matched
in order, first match wins, because a classifier you cannot explain is the wrong thing to put
in front of a decision about whether to keep sending.</p>
<p>Recognised a response the classifier did not? That is a missing rule, and worth telling me
about.</p>
"""
    return page(
        "SMTP bounce classifier: what a bounce or deferral actually means",
        "Paste an SMTP bounce or deferral and get the category and the action it needs: "
        "retry, throttle, suppress, pause, review or fix config. Runs in your browser.",
        body, "bounce/index.html", extra_ld=tool_ld(t), wide=True,
        nav_key="Tools", crumbs=(("Tools", "tools/"), ("Bounce classifier", None)),
        scripts=("/sift.js",))


def build_spf():
    t = tool("spf")
    body = """
<h1>SPF lookup counter</h1>
<p class="lede">RFC 7208 caps an SPF evaluation at ten DNS lookups. Over the cap it is a
permerror, and most receivers treat a permerror as no SPF at all. This walks the whole
include tree and shows you exactly where the count goes.</p>

<div class="tool">
  <form id="spf-form" autocomplete="off" class="row">
    <label class="sr" for="spf-domain">Domain</label>
    <input class="field" id="spf-domain" type="text" spellcheck="false"
           placeholder="example.com" aria-label="Domain to check">
    <button class="btn" type="submit" id="spf-run">Count lookups</button>
  </form>
  <p class="hint">Try:
    <a href="?d=box.com">box.com</a>
    <a href="?d=hubspot.com">hubspot.com</a>
    <a href="?d=salesforce.com">salesforce.com</a>
    <a href="?d=rastu.tech">rastu.tech</a>
  </p>
  <div class="report" id="spf-out" aria-live="polite"></div>
</div>

<h2>What counts against the ten</h2>
<div class="full"><table class="cost">
<tr><th>Mechanism</th><th>Cost</th><th>Notes</th></tr>
<tr class="s-warn"><td><code>include:</code></td><td class="num">1 + its own</td>
    <td>Recursive. An include that itself has four includes costs you five.</td></tr>
<tr class="s-warn"><td><code>redirect=</code></td><td class="num">1 + its own</td>
    <td>Same as include, and it replaces the rest of the record.</td></tr>
<tr class="s-warn"><td><code>a</code> <code>a:</code></td><td class="num">1</td>
    <td>Including the CIDR forms, <code>a/24</code> and <code>a:host/24</code>.</td></tr>
<tr class="s-warn"><td><code>mx</code> <code>mx:</code></td><td class="num">1</td>
    <td>And capped separately at ten address records per evaluation.</td></tr>
<tr class="s-warn"><td><code>exists:</code></td><td class="num">1</td>
    <td>Often carries a macro, so the cost can depend on the sending IP.</td></tr>
<tr class="s-fail"><td><code>ptr</code></td><td class="num">1</td>
    <td>Deprecated by RFC 7208. Some receivers ignore it. Remove it.</td></tr>
<tr class="s-ok"><td><code>ip4:</code> <code>ip6:</code></td><td class="num">0</td>
    <td>No DNS query, so unlimited.</td></tr>
<tr class="s-ok"><td><code>all</code> <code>exp=</code></td><td class="num">0</td>
    <td><code>exp=</code> is only fetched on a fail, and never counts.</td></tr>
</table></div>
<p>Every mechanism can carry a qualifier, so <code>+include:</code>, <code>-a</code> and
<code>~mx</code> cost exactly what the unqualified form costs. Tools that match on the bare
token miss them and report a broken record as healthy.</p>

<h2>Why this is worth checking</h2>
<p>It is the failure nobody sees coming. The record resolves. It reads correctly. It passes a
visual inspection. It has simply stopped authenticating, usually because somebody added one
more vendor to a record that was already at nine. Across
<a href="/research/">100,000 domains</a>, 3.4% of every published SPF record had already
crossed the line.</p>

<h2>On flattening</h2>
<p>Flattening means replacing an <code>include:</code> with the IP ranges it currently
resolves to. It fixes the count today and creates a slower problem: when the provider adds a
sending range, your record does not know, and mail from the new range fails SPF with no error
anywhere to tell you. If you flatten, you own a record that has to be re-generated on a
schedule, and somebody has to still be doing that in a year.</p>
<p>Cheaper answers first: remove vendors that no longer send, move mail to a subdomain with
its own record, and collapse two ESPs into one.</p>
"""
    return page(
        "SPF lookup counter: find the mechanism that breaks your SPF record",
        "Walk a domain's full SPF include tree with a running RFC 7208 DNS lookup count, "
        "and find the exact mechanism that pushes it past ten and into permerror.",
        body, "spf/index.html", extra_ld=tool_ld(t), wide=True,
        nav_key="Tools", crumbs=(("Tools", "tools/"), ("SPF lookup counter", None)),
        modules=("/js/spf.js",))


def build_dmarc():
    """The DMARC aggregate report reader.

    An aggregate report is a list of every system that sends mail as a domain,
    which is exactly the map an attacker would want and exactly the thing people
    upload to a stranger's website without thinking about it. Parsing it in the
    tab is the whole product, not a footnote.
    """
    t = tool("dmarc")
    body = """
<h1>DMARC report reader</h1>
<p class="lede">Aggregate reports arrive as XML nobody wants to read, usually zipped, from
a dozen receivers a week. Drop one in and see who is sending as your domain, what
authenticated, and what to fix first.</p>

<ul class="assure full">
  <li><b>Parsed in this tab</b><span>The file never leaves your machine</span></li>
  <li><b>.xml, .gz and .zip</b><span>Straight from the mail attachment</span></li>
  <li><b>Alignment computed here</b><span>Not taken from the reporter's own verdict</span></li>
</ul>

<div class="tool">
  <label class="drop" id="rua-drop" for="rua-file">
    <b>Drop a report here</b>
    <span>or choose a file &mdash; .xml, .xml.gz or .zip, and several at once is fine</span>
    <input id="rua-file" type="file" multiple accept=".xml,.gz,.zip,text/xml,application/gzip,application/zip">
  </label>
  <details class="paste">
    <summary>or paste the XML</summary>
    <textarea class="field" id="rua-paste" spellcheck="false"
      placeholder="&lt;?xml version=&quot;1.0&quot;?&gt;&#10;&lt;feedback&gt;..."></textarea>
    <button type="button" class="btn sm" id="rua-paste-run">Read it</button>
  </details>
  <div class="report" id="rua-out" aria-live="polite"></div>
</div>

<h2>The distinction most readers get wrong</h2>
<p>A DMARC report carries two different results for SPF and two for DKIM, and they are
routinely different:</p>
<div class="full"><table>
<tr><th>Field</th><th>What it is</th></tr>
<tr><td><code>auth_results/spf/result</code></td>
    <td>The <strong>raw</strong> result. Did SPF pass for the envelope sender?</td></tr>
<tr><td><code>policy_evaluated/spf</code></td>
    <td>The <strong>aligned</strong> result. Did the domain that passed also match the
        <code>From:</code> header domain?</td></tr>
</table></div>
<p>A source can show <code>auth_results/spf/result = pass</code> and
<code>policy_evaluated/spf = fail</code> at the same time. SPF authenticated correctly; the
<code>MAIL FROM</code> domain just does not align with what the recipient sees. That is a
completely different fix from "SPF is broken", and reading the wrong field sends you to fix
the wrong thing.</p>
<p>This tool computes alignment itself from <code>auth_results</code>, the
<code>From:</code> domain and the published <code>adkim</code> and <code>aspf</code> modes,
then compares that to what the reporter claimed. When the two disagree, it says so.</p>

<h2>What each result means</h2>
<div class="full"><table>
<tr><th>Result</th><th>What to do</th></tr>
<tr class="s-ok"><td><strong>Aligned</strong></td>
    <td>SPF and DKIM both align. Nothing to do.</td></tr>
<tr class="s-ok"><td><strong>DKIM aligned</strong></td>
    <td>Fine. DKIM survives forwarding, which is the one that matters.</td></tr>
<tr class="s-warn"><td><strong>SPF only</strong></td>
    <td>Passes today and fails the moment someone forwards it. Get DKIM signing and
        aligning for this source.</td></tr>
<tr class="s-info"><td><strong>Forwarded</strong></td>
    <td>SPF broke in transit and DKIM carried it, or the receiver said so outright.
        Expected behaviour, not a problem to solve.</td></tr>
<tr class="s-fail"><td><strong>Unauthenticated</strong></td>
    <td>Neither aligned. Either the source needs configuring or it is not yours.
        Identify it before you change policy.</td></tr>
</table></div>

<h2>What a report cannot tell you</h2>
<ul>
  <li><strong>It is not your pass rate.</strong> One report is one receiver over one
      window. Gmail's view of your mail is not the internet's view of your mail.</li>
  <li><strong>An unrecognised source is not a spoofer.</strong> It is far more often a
      vendor somebody set up and forgot about. This tool will never label a source as
      spoofing, because the data cannot support it.</li>
  <li><strong>DKIM validity is the receiver's verdict, not a check.</strong> Aggregate
      reports carry no message content, so nothing here re-verifies a signature.</li>
  <li><strong>Sender names are a courtesy.</strong> They come from reverse DNS, which is
      set by whoever controls the IP block and is not authenticated. A name that could not
      be forward-confirmed is marked.</li>
</ul>

<h2>Where to get your reports</h2>
<p>They arrive at whatever address is in the <code>rua=</code> tag of your DMARC record.
If you do not have one, that is worth fixing first: enforcing a policy with no aggregate
reporting means enforcing without being able to see what you are enforcing, which
<a href="/research/">20.8% of enforcing domains are doing right now</a>. The
<a href="/check/">domain check</a> will tell you whether yours is set.</p>
"""
    return page(
        "DMARC report reader: read an aggregate rua report in your browser",
        "Drop in a DMARC aggregate (rua) report as .xml, .gz or .zip and read it: every "
        "sending source, SPF and DKIM alignment computed from the auth results, and what "
        "to fix first. Parsed in your browser, never uploaded.",
        body, "dmarc/index.html", extra_ld=tool_ld(t), wide=True,
        nav_key="Tools", crumbs=(("Tools", "tools/"), ("DMARC report reader", None)),
        modules=("/js/rua-ui.js",))


def build_check():
    """The domain auditor.

    This is dmarcsight, running in the visitor's browser rather than on a server.
    That is a deliberate choice and worth stating on the page: the lookups go from
    their browser to a public DNS-over-HTTPS resolver, so no domain anyone checks
    is ever sent here. There is nothing to log and nothing to leak, which matters
    when the thing being audited is someone's production sending domain.

    The logic is a port of the Python package, and build/parity.mjs replays the
    Python test scenarios against it on every build. If they ever disagree, the
    build fails rather than the page quietly telling someone something the tool
    would not.
    """
    ld = {
        "@context": "https://schema.org",
        "@type": "WebApplication",
        "name": "Email authentication checker",
        "url": f"{SITE}/check/",
        "applicationCategory": "SecurityApplication",
        "operatingSystem": "Any",
        "offers": {"@type": "Offer", "price": "0", "priceCurrency": "EUR"},
        "description": (
            "Audits a domain's SPF, DKIM, DMARC, MTA-STS, TLS-RPT and BIMI "
            "configuration in the browser, including the RFC 7208 ten-lookup "
            "limit and MTA-STS policy and MX consistency."
        ),
        "author": {"@id": f"{SITE}/#person"},
        "isBasedOn": "https://github.com/singhrastu/dmarcsight",
    }

    body = """
<h1>Check a domain's email authentication</h1>
<p class="lede">SPF, DKIM, DMARC, MTA-STS, TLS-RPT and BIMI, with the things generic
checkers miss: the RFC 7208 ten-lookup limit, whether an MTA-STS policy actually
exists behind the DNS record that promises it, and whether the policy covers the MX
hosts that are live right now.</p>

<div class="tool">
  <form id="check-form" autocomplete="off" class="row">
    <label class="sr" for="check-domain">Domain</label>
    <input class="field" id="check-domain" name="d" type="text" spellcheck="false"
           placeholder="example.com" aria-label="Domain to check">
    <button class="btn" type="submit" id="check-run">Check</button>
  </form>
  <p class="hint">Try:
    <a href="?d=gov.uk">gov.uk</a>
    <a href="?d=paypal.com">paypal.com</a>
    <a href="?d=github.com">github.com</a>
    <a href="?d=rastu.tech">rastu.tech</a>
  </p>
  <div class="report" id="check-out" aria-live="polite"></div>
</div>

<h2>What it checks</h2>

<h3>SPF</h3>
<p>Beyond whether a record exists: the qualifier it ends on, whether more than one is
published (which is a permerror, not a merge), and the RFC 7208 lookup count. For the
full include tree and the mechanism that tips a record over the limit, use the
<a href="/spf/">SPF lookup counter</a>.</p>

<h3>DMARC</h3>
<p>Policy strength, subdomain policy, pct, and whether an aggregate reporting address
is set. The common failures are a policy left at p=none where it blocks nothing,
enforcement with no rua so there is no way to see what is being enforced, and sp=none
under an enforcing p, which leaves every subdomain spoofable while the main domain
looks protected.</p>

<h3>DKIM</h3>
<p>Selectors are arbitrary strings chosen by the sender. Probing a list of common ones
and finding nothing proves nothing, so a miss is reported as inconclusive rather than
as absent. Where a key is found, the approximate key length is reported, because keys
under 1024 bits are rejected outright by several receivers.</p>

<h3>MTA-STS</h3>
<p>The DNS record is a promise that a policy exists at
<code>https://mta-sts.&lt;domain&gt;/.well-known/mta-sts.txt</code>. If that URL 404s
the entire mechanism is inert while appearing configured, and a DNS-only checker will
call it enabled. This one fetches the policy, parses it as the
<code>key: value</code> format RFC 8461 actually specifies, and compares the MX hosts
it lists against the MX records that are live. Under enforce, mail to an uncovered MX
host is refused.</p>

<h3>Bulk sender readiness</h3>
<p>A composite verdict against the Gmail, Yahoo and Microsoft requirements for senders
over 5,000 messages a day. Two of those requirements, one-click List-Unsubscribe and a
complaint rate under 0.3%, are not visible from DNS, so the report says so rather than
guessing.</p>

<h2>Your domain is never sent to this site</h2>
<p>In your browser. The DNS lookups go from your machine to a public DNS-over-HTTPS
resolver, not through this site, so the domain you type is never sent here and there
is nothing to log. The one exception is the MTA-STS policy file: a page cannot fetch
a URL on another origin, so that single request is proxied, and the endpoint takes a
domain rather than a URL so it cannot be used to fetch anything else.</p>

<p>Same logic as <a href="https://github.com/singhrastu/dmarcsight">dmarcsight</a>,
the command-line version, checked against it on every build.</p>
"""
    return page(
        "Email authentication checker: SPF, DKIM, DMARC, MTA-STS and BIMI",
        "Free in-browser audit of a domain's SPF, DKIM, DMARC, MTA-STS, TLS-RPT and BIMI "
        "configuration, including the SPF ten-lookup limit and MTA-STS policy and MX "
        "consistency. Nothing is sent to the server.",
        body, "check/index.html", extra_ld=ld, wide=True,
        nav_key="Tools", crumbs=(("Tools", "tools/"), ("Domain check", None)),
        modules=("/js/check.js",))


def build_tools():
    """The tools hub.

    The old page listed two GitHub repos and asserted they existed; it also linked
    the smtpsift section at the dmarcsight tool. This one leads with the question
    each tool answers, because that is the form the visitor's problem arrives in.
    """
    cards = "".join(
        f'<a class="card" href="/{t["slug"]}/">'
        f'<span class="tag">{e(t["tag"])}</span>'
        f'<h3>{e(t["name"])}</h3>'
        f'<p class="q">{e(t["q"])}</p>'
        f'<p>{e(t["blurb"])}</p>'
        f'<span class="go">Open &rarr;</span></a>'
        for t in TOOLS)

    body = f"""
<h1>Tools</h1>
<p class="lede">Each one answers a question that turns up in a real incident. They run in
your browser: nothing you paste or upload is sent anywhere, and there is no account to
make.</p>

<div class="bento tools">{cards}</div>

<div class="sechead r">
  <h2>On the command line</h2>
  <p>Two of these started as command-line tools and still are. The hosted versions run the
  same logic, checked against the originals on every build.</p>
</div>

<div class="grid r">
  <a href="https://github.com/singhrastu/smtpsift">
    <strong>smtpsift</strong><span class="p">Python</span>
    <span class="d">Classifies SMTP rejections and deferrals into a category and an
    action. Powers the <a href="/bounce/">bounce classifier</a>.</span></a>
  <a href="https://github.com/singhrastu/dmarcsight">
    <strong>dmarcsight</strong><span class="p">Python</span>
    <span class="d">Audits a domain's authentication posture end to end. Powers the
    <a href="/check/">domain check</a> and the <a href="/spf/">SPF counter</a>.</span></a>
</div>

<div class="sechead r">
  <h2>Being built</h2>
  <p>In order, and shipped when each one is trustworthy rather than when it is
  demonstrable.</p>
</div>
<ul>
  <li><strong>DMARC report reader</strong> &mdash; drop in an aggregate (rua) report and see
      which sources are sending as you, what aligned and what did not. Entirely offline:
      the file never leaves the page, which matters because an aggregate report names every
      system that sends for a domain.</li>
  <li><strong>Header analyser</strong> &mdash; paste raw headers for authentication results
      and hop-by-hop timing, with the parts that cannot be trusted marked as such.</li>
  <li><strong>Warm-up planner</strong> &mdash; a day-by-day ramp schedule with the
      reputation checkpoints that gate each step.</li>
</ul>
"""
    return page(
        "Email infrastructure tools: bounce classifier, domain check, SPF counter",
        "Browser-based tools for email operations: classify a bounce, audit a domain's "
        "SPF, DKIM, DMARC and MTA-STS, and count SPF DNS lookups. Nothing is uploaded.",
        body, "tools/index.html", wide=True, nav_key="Tools")


def build_home():
    """The homepage is the toolkit, not the CV.

    Someone arriving here came from a search for a bounce code or a broken SPF
    record, not for a person. So the tools come first and the biography is one
    byline line pointing at /about/, which is where the entity signal lives.

    That byline is deliberate rather than vestigial: it sits inside the first 200
    words, which is the slice retrievers weight, and the JSON-LD below ties every
    tool on the page back to the same #person node. The footprint is larger than
    the old personal homepage, not smaller.
    """
    cards = "".join(
        f'<a class="card" href="/{t["slug"]}/">'
        f'<span class="tag">{e(t["tag"])}</span>'
        f'<h3>{e(t["name"])}</h3>'
        f'<p class="q">{e(t["q"])}</p>'
        f'<p>{e(t["blurb"])}</p>'
        f'<span class="go">Open &rarr;</span></a>'
        for t in TOOLS)

    # The responses people actually arrive on, as a way in to the reference.
    picks = ["4.7.28", "5.7.1", "5.7.606", "5.1.1", "TS03", "spamhaus"]
    chips = "".join(
        f'<a class="chip" href="/smtp/{slug(c)}/">{e(c.get("label") or c["code"])}</a>'
        for code in picks for c in CODES if c["code"] == code)

    ld = {
        "@context": "https://schema.org",
        "@graph": [
            {"@type": "ItemList", "@id": f"{SITE}/#tools",
             "name": "Email infrastructure tools",
             "itemListElement": [
                 {"@type": "ListItem", "position": i + 1,
                  "item": {"@type": "SoftwareApplication",
                           "name": t["name"],
                           "url": f"{SITE}/{t['slug']}/",
                           "applicationCategory": "SecurityApplication",
                           "operatingSystem": "Any",
                           "description": t["blurb"],
                           "offers": {"@type": "Offer", "price": "0",
                                      "priceCurrency": "EUR"},
                           "author": {"@id": f"{SITE}/#person"}}}
                 for i, t in enumerate(TOOLS)]},
        ],
    }

    body = f"""
<h1>Tools for running email infrastructure</h1>
<p class="lede">Work out what a bounce is telling you, audit a domain's authentication,
or find the mechanism that quietly switched off an SPF record.</p>

<ul class="assure full">
  <li><b>Runs in your browser</b><span>DNS and parsing happen on your machine</span></li>
  <li><b>Nothing is uploaded</b><span>No file or domain reaches this server</span></li>
  <li><b>No account</b><span>No signup, no limits, no email address</span></li>
</ul>

<p class="byline">Built and maintained by <a href="/about/">Rastu Singh</a>, an
infrastructure engineer in Tallinn who runs these systems for a living.</p>

<div class="bento tools">{cards}</div>

<div class="sechead r">
  <h2>SMTP response reference</h2>
  <p>One page per response you actually see in a mail log: what it means, whether
  retrying helps, and what to change so it stops. Written from operating these
  systems, not from the spec.</p>
</div>
<div class="chips-row r">{chips}
  <a class="chip more" href="/smtp/">All {len(CODES)} responses &rarr;</a>
</div>

<div class="panel r">
  <h3>58.7% publish DMARC. 20.9% reach p=reject.</h3>
  <p>Original measurement across 100,000 domains from the Tranco list. Of those that
  publish DMARC at all, 35.8% leave it at p=none where it blocks nothing, and 20.8%
  enforce with no rua address, so they cannot see what they are enforcing. Methodology
  and the raw dataset are published alongside the findings.</p>
  <p class="doi">doi:{e(DOI)} &middot; CC BY 4.0</p>
  <p><a href="/research/">Read the research &rarr;</a></p>
</div>
"""
    return page(
        "Email infrastructure tools: bounce classifier, domain check, SPF counter",
        "Browser-based tools for email operations: classify an SMTP bounce, audit a "
        "domain's SPF, DKIM, DMARC and MTA-STS, and count SPF DNS lookups. No signup, "
        "nothing uploaded. Plus an SMTP response reference and original research.",
        body, "index.html", extra_ld=ld, is_home=True, wide=True)


def build_code_page(c):
    s = slug(c)
    prov = '<span class="badge">' + e(c.get("provider") or c.get("badge") or "RFC 3463") \
           + "</span>"
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
<p class="meta">Classified as <code>{e(c['category'])}</code>, action
<code>{e(c['action'])}</code>. Paste a response into the
<a href="/bounce/">bounce classifier</a> to check one against the same ruleset.</p>
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
    return page(c["title"], c["answer"][:300], body, f"smtp/{s}/index.html",
                extra_ld=ld, nav_key="Reference",
                crumbs=(("Reference", "smtp/"), (c.get("label") or c["code"], None)))


def build_smtp_index():
    """The reference, searchable.

    Everything stays in the DOM and is only hidden by the filter, so a crawler and a
    reader without JavaScript still get all of it. Grouping is by provider because
    that is how the question arrives: "why is Microsoft rejecting this", not "show me
    the 5.7.x family".
    """
    groups, seen = [], set()
    for c in sorted(CODES, key=lambda x: (x.get("provider") or "", x["code"])):
        g = c.get("provider") or "Generic"
        if g not in seen:
            seen.add(g)
            groups.append(g)

    chips = '<button class="chip on" data-group="all" type="button">All</button>' + "".join(
        f'<button class="chip" data-group="{e(g)}" type="button">{e(g)}</button>'
        for g in groups)

    items = []
    for c in sorted(CODES, key=lambda x: (x.get("provider") or "", x["code"])):
        g = c.get("provider") or "Generic"
        label = c.get("label") or c["code"]
        badge = c.get("badge") or c.get("provider") or "RFC 3463"
        # Everything worth typing into the box: the code, the provider, the category,
        # the action, and the words in the summary.
        terms = " ".join([label, c["code"], g, c["category"].replace("_", " "),
                          c["action"], c["summary"]]).lower()
        items.append(
            f'<a href="/smtp/{slug(c)}/" data-terms="{e(terms)}" data-group="{e(g)}">'
            f'<strong>{e(label)}</strong>'
            f'<span class="p">{e(badge)}</span>'
            f'<span class="d">{e(c["summary"])}</span>'
            f'<span class="act a-{e(c["action"])}">{e(c["action"].replace("_", " "))}</span>'
            f"</a>")

    body = f"""
<h1>SMTP response reference</h1>
<p class="lede">What the responses in your mail log actually mean, whether retrying will
help, and what to change so they stop. Written from operating these systems, not from the
spec.</p>

<div class="filter" data-filter>
  <input class="field" type="search" id="ref-q" autocomplete="off" spellcheck="false"
         placeholder="Paste a code or search: 4.7.28, blocked, quota, reputation"
         aria-label="Search the reference">
  <div class="chips">{chips}<span class="count"></span></div>
  <div class="grid">{"".join(items)}</div>
  <p class="empty noresult hidden">Nothing matches that. The reference covers
  {len(CODES)} responses so far and grows from real mail logs; if you have hit
  something that is missing, it is worth reporting.</p>
</div>

<h2>How to read an entry</h2>
<p>Each page states the answer first, then what the response looks like in a log, why it
happens, and what to do. The action on each card is the same vocabulary the
<a href="/bounce/">bounce classifier</a> uses, so a rule in your bounce handling and a page
here always agree.</p>
"""
    ld = {
        "@context": "https://schema.org",
        "@type": "CollectionPage",
        "name": "SMTP response reference",
        "url": f"{SITE}/smtp/",
        "author": {"@id": f"{SITE}/#person"},
        "hasPart": [{"@type": "TechArticle", "headline": c["title"],
                     "url": f"{SITE}/smtp/{slug(c)}/"} for c in CODES],
    }
    return page(
        "SMTP response reference: error and deferral codes explained",
        "Searchable reference for SMTP rejection and deferral responses: what each means, "
        "whether to retry, and how to fix the cause.",
        body, "smtp/index.html", extra_ld=ld, wide=True,
        nav_key="Reference", modules=("/js/filter.js",))


def build_session():
    """The swaks transcript, live and then annotated.

    It plays out as the terminal it came from, because watching a session happen
    line by line is how the shape of it lands. The annotated breakdown underneath
    is the part you come back to, and it covers only the lines worth stopping on
    rather than repeating all twenty-eight.
    """
    ann = [
        (3, "Connect",
         "swaks resolves the MX and opens a TCP connection on port 25. A refusal or a "
         "timeout here is a network problem, not a mail problem, and it is the cheapest "
         "failure to misdiagnose."),
        (5, "220 greeting",
         "The receiver announces itself. Anything other than 220 and you never get to "
         "send: some receivers return a 421 here when they are shedding load, and a few "
         "return a 554 when the connecting IP is blocked outright."),
        (6, "EHLO",
         "You announce who you claim to be. Receivers check this name against the reverse "
         "DNS of your connecting IP, and a mismatch costs reputation at several providers "
         "even though nothing rejects on it directly."),
        (7, "Capabilities",
         "Everything after 250- is something the receiver supports. The last line uses "
         "250 with a space rather than a hyphen, which is how you know the list ended. "
         "If STARTTLS is absent here, the session cannot be encrypted at all."),
        (12, "STARTTLS",
         "Upgrades the connection already open rather than dialling a new one. This is "
         "the step MTA-STS and DANE exist to protect, because an attacker who can strip "
         "this line downgrades the whole session to cleartext."),
        (17, "The second EHLO",
         "Not a mistake. STARTTLS resets the session state, so the capability list has "
         "to be asked for again inside the encrypted channel, and it can legitimately "
         "differ from the first one."),
        (20, "MAIL FROM",
         "The envelope sender, and the domain SPF is actually checked against. It is not "
         "the From: header the recipient sees, and the gap between those two is what "
         "DMARC alignment is about."),
        (22, "RCPT TO",
         "Where most rejections land: unknown user, mailbox full, recipient policy. A "
         "550 here is about one address. A 550 at MAIL FROM or at connect is about you."),
        (25, "QUIT",
         "Because --quit-after RCPT stopped before DATA. The route is proven end to end "
         "and no message was ever transmitted."),
    ]
    by_line = {i: (t, txt) for i, t, txt in ann}

    session = json.dumps([{"k": k, "t": t} for k, t in SMTP_SESSION], ensure_ascii=False)

    steps = "".join(
        f'<div class="step"><h3>{e(title)}</h3>'
        f'<code>{e(SMTP_SESSION[i][1].strip())}</code>'
        f"<p>{e(text)}</p></div>"
        for i, title, text in ann)

    body = f"""
<h1>Anatomy of an SMTP session</h1>
<p class="lede">A real delivery, captured with swaks against Gmail's MX. Every server
response is verbatim; only the client IP is replaced. <code>--quit-after RCPT</code> stops
before DATA, so the handshake completes and no message is ever sent, which is how you test
a route without touching a recipient.</p>

<div class="term" id="term" data-session='{e(session)}'>
  <div class="bar"><i></i><i></i><i></i>
    <span>swaks &mdash; gmail-smtp-in.l.google.com:25</span>
    <em>click to replay</em></div>
  <pre><code id="term-out"></code><span class="cur"></span></pre>
</div>

<div class="callout"><p>Reading the prefixes: <code>===</code> is swaks talking to you,
<code>-&gt;</code> and <code>&lt;-</code> are sent and received in the clear, and
<code>~&gt;</code> and <code>&lt;~</code> are the same two inside TLS.</p></div>

<h2>What each step is doing</h2>
<p>Every line is a place delivery can fail, and most of the work is knowing which one it
failed at. These are the ones worth stopping on.</p>
<div class="steps">{steps}</div>

<h2>When a line comes back wrong</h2>
<p>A connection refused at the 220 is a different problem from a 550 at RCPT TO, which is
a different problem again from a 250 at DATA followed by silence. That is the reason to
read a clean session before reading a broken one: it tells you which question to ask.</p>
<p>The <a href="/smtp/">response reference</a> covers what each response means, and the
<a href="/bounce/">bounce classifier</a> will tell you which action it needs.</p>

<h2>Reproducing this</h2>
<p>swaks is the tool worth having installed, and <code>--quit-after RCPT</code> is the flag
worth remembering: it proves a full route, including TLS and recipient acceptance, without
delivering anything to a real person.</p>
<pre><code>swaks --to postmaster@gmail.com --from you@example.com \\
      --server gmail-smtp-in.l.google.com --ehlo example.com \\
      --tls --quit-after RCPT</code></pre>
<p>Drop <code>--quit-after RCPT</code> and it delivers. Add <code>--tlso</code> instead of
<code>--tls</code> for implicit TLS on port 465, and <code>-au</code> / <code>-ap</code>
when you are testing a submission endpoint that requires authentication.</p>
"""
    ld = {
        "@context": "https://schema.org",
        "@type": "TechArticle",
        "headline": "Anatomy of an SMTP session",
        "description": "A real swaks SMTP session against Gmail's MX, annotated line by line.",
        "author": {"@id": f"{SITE}/#person"},
        "publisher": {"@id": f"{SITE}/#person"},
        "mainEntityOfPage": f"{SITE}/smtp/session/",
    }
    return page(
        "Anatomy of an SMTP session: a real delivery, line by line",
        "A real swaks SMTP session against Gmail's MX, annotated line by line: the 220 "
        "greeting, EHLO, STARTTLS, MAIL FROM, RCPT TO, and where each one can fail.",
        body, "smtp/session/index.html", extra_ld=ld, wide=True, nav_key="Reference",
        crumbs=(("Reference", "smtp/"), ("Anatomy of a session", None)))


def build_about():
    """The definitive "who is Rastu Singh" page.

    Everything here is verifiable against his employment history. The opening
    paragraph is written to be lifted directly as an answer, because that is what
    both Google snippets and LLM retrievers do with a page like this.

    This is the biography page and the home page is not. Home states the identity
    in its first 150 words and then gets on with the tools; the depth lives here,
    once, so the two pages reinforce one entity instead of competing for it.
    """
    body = f"""
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
<p><strong>Email infrastructure.</strong> Building and operating the transport layer at scale:
estates running to over a thousand sending IPs and delivering millions of messages a day. Six
MTAs in production across his career: PowerMTA, KumoMTA, Momentum, Postfix, Haraka and
GreenArrow. Queue policy, per-domain and per-provider throttling, connection and concurrency
limits, retry and backoff strategy, multi-datacenter routing, and the DNS underneath it. He has
built sending estates from nothing on bare metal and cloud, and automated them with Ansible,
Terraform, Python and Bash.</p>

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
{career_html()}

<p>At Experiture he built the platform's SMTP sending infrastructure from scratch, established
the authentication layer across all sending domains, and led the IT team and a group of junior
deliverability consultants. At IntraSoft he ran campaign deployment and queue management at
300,000 to 400,000 messages per day across US, UK, AU, CA and ROW regions.</p>

<h2>Stack</h2>
{stack_html()}

<h2>Open-source work</h2>
<p><a href="https://github.com/singhrastu/smtpsift">smtpsift</a> classifies SMTP rejections and
deferrals into a category and an action, on the argument that hard and soft bounce is too coarse
to act on. <a href="https://github.com/singhrastu/dmarcsight">dmarcsight</a> audits a domain's
email authentication posture, including the SPF ten-lookup limit and MTA-STS policy and MX
consistency, which generic checkers miss.</p>

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
        body, "about/index.html", extra_ld=ld, nav_key="About")



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

    gaps = [
        ("DMARC left at p=none, blocking nothing", g["of_dmarc_still_p_none"]),
        ("DMARC enforcing with no rua, no visibility", g["of_dmarc_no_rua"]),
        ("Enforcing but sp=none, subdomains unprotected", g["of_enforcing_with_sp_none"]),
        ("SPF over the 10-lookup limit, permerror", g["of_spf_over_lookup_limit"]),
        ("DMARC with pct below 100, partially applied", g["of_dmarc_partial_pct"]),
        ("SPF with no all mechanism", g["of_spf_no_all"]),
    ]
    top = max(v for _, v in gaps)
    bars = "".join(
        f'<div class="bar-row"><div class="bar-label">{lab}</div>'
        f'<div class="bar-val">{v}%</div>'
        f'<div class="bar-track"><div class="bar-fill" style="--w:{round(100*v/top)}%"></div></div>'
        f'</div>' for lab, v in gaps)

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

<div class="stats">
  <div class="stat"><div class="n">{g['dmarc']}%</div><div class="l">publish DMARC</div></div>
  <div class="stat"><div class="n">{g['dmarc_reject']}%</div><div class="l">actually reject</div></div>
  <div class="stat"><div class="n">{g['mta_sts']}%</div><div class="l">MTA-STS</div></div>
  <div class="stat"><div class="n">{n:,}</div><div class="l">domains measured</div></div>
</div>

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

<h2>The gaps</h2>

<p>The gap between publishing a record and being protected by it is where the real
picture is. All figures below
are shares of the domains that publish the record at all, so they describe people who have
already done most of the work.</p>

<div class="bars">{bars}</div>

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
<h2>Citing this</h2>
<p>The dataset is archived at Zenodo with a permanent DOI, so it stays citable and
resolvable independently of this site.</p>
<pre><code>Singh, R. (2026). The State of Email Authentication 2026: SPF, DMARC,
MTA-STS, TLS-RPT and BIMI adoption across 100,000 domains [Data set].
Zenodo. https://doi.org/{DOI}</code></pre>
<p><strong>DOI:</strong> <a href="https://doi.org/{DOI}">{DOI}</a> &middot;
   <a href="https://zenodo.org/records/22832936">Zenodo record</a> &middot;
   <a href="https://orcid.org/0009-0002-0526-3005">ORCID</a></p>
<p class="meta">Licensed CC BY 4.0. Free to reuse with attribution. If you cite it,
I would like to know.</p>
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
        "identifier": f"https://doi.org/{DOI}",
        "sameAs": "https://zenodo.org/records/22832936",
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
                body, "research/index.html", extra_ld=ld, nav_key="Research")


def build_stub(path, kicker, title, lede, body_extra=""):
    body = f"""
<p class="kicker">{e(kicker)}</p>
<h1>{e(title)}</h1>
<p class="lede">{e(lede)}</p>
{body_extra}
"""
    return page(title, lede, body, path)


def check_copy():
    """Two rules the audit showed the site had drifted away from.

    1. A nav label must be findable on the page it leads to. The audit found six
       nav labels and not one matched its destination, with "Domain check" going
       by three different names across the site.
    2. A kicker is a category label or it is nothing. "Everything else here",
       "When it works" and "When it does not" were filing labels that told a
       reader nothing and could not be searched for.

    Cheap to assert, and the kind of thing that silently comes back otherwise.
    """
    allowed = {label for label, _ in NAV}
    problems = []

    for label, href in NAV:
        path = os.path.join(OUT, href, "index.html")
        html_src = open(path, encoding="utf8").read()
        found = re.findall(r"<h1>(.*?)</h1>|<title>(.*?)</title>"
                           r"|class=\"kicker\">(.*?)<", html_src, re.S)
        hay = " ".join(part for groups in found for part in groups)
        if label.lower() not in hay.lower():
            problems.append(f"nav label {label!r} appears nowhere on /{href}")

    for root, _, files in os.walk(OUT):
        for name in files:
            if not name.endswith(".html"):
                continue
            full = os.path.join(root, name)
            for k in re.findall(r'class="kicker">([^<]*)<', open(full, encoding="utf8").read()):
                if k.strip() not in allowed:
                    rel = os.path.relpath(full, OUT)
                    problems.append(f"kicker {k.strip()!r} on {rel} is not a category label")

    if problems:
        sys.exit("copy rules broken:\n  " + "\n  ".join(problems))
    print(f"  copy ok ({len(NAV)} nav labels resolve, kickers are category labels)")


def check_js():
    """Parse every script the site ships.

    JS lives inside a Python triple-quoted string, so a backslash escape that is
    right for JavaScript can be silently eaten by Python. That failure is invisible
    until a browser refuses the file, so it is worth catching here. Skipped without
    complaint if node is not installed; it is a convenience, not a dependency.
    """
    if not shutil.which("node"):
        return
    home = open(os.path.join(OUT, "index.html"), encoding="utf8").read()
    m = re.search(r"<script>(.*?)</script>", home, re.S)
    blobs = {"inline": m.group(1) if m else ""}
    for root, _, files in os.walk(OUT):
        for name in files:
            if name.endswith(".js"):
                full = os.path.join(root, name)
                blobs[os.path.relpath(full, OUT)] = open(full, encoding="utf8").read()
    for name, label in (("parity-findings.mjs", "the findings layer is wrong"),
                        ("parity.mjs", "the in-browser auditor has drifted from dmarcsight"),
                        ("parity-rua.mjs", "the DMARC report reader is wrong")):
        path = os.path.join(HERE, name)
        if not os.path.exists(path):
            continue
        rc = subprocess.run(["node", path], capture_output=True, text=True,
                            cwd=os.path.dirname(HERE))
        if rc.returncode:
            sys.exit(f"{label}:\n" + rc.stdout + rc.stderr)
        print(rc.stdout.rstrip())

    for name, src in blobs.items():
        if not src.strip():
            continue
        tmp = os.path.join(OUT, "._check.mjs")
        open(tmp, "w", encoding="utf8").write(src)
        rc = subprocess.run(["node", "--check", tmp],
                            capture_output=True, text=True)
        os.remove(tmp)
        if rc.returncode:
            sys.exit(f"JS syntax error in {name}:\n{rc.stderr}")
    print(f"  js ok ({', '.join(sorted(blobs))})")


def main():
    if os.path.isdir(OUT):
        shutil.rmtree(OUT)
    os.makedirs(OUT, exist_ok=True)

    build_sift()
    urls = [build_home(), build_tools(), build_about(),
            build_check(), build_bounce(), build_dmarc(), build_spf(),
            build_smtp_index(), build_session()]
    for c in CODES:
        urls.append(build_code_page(c))

    urls.append(build_research())

    # the auditor's modules, copied rather than inlined so the browser can cache
    # them and so build/parity.mjs can import exactly what ships
    jsdir = os.path.join(OUT, "js")
    os.makedirs(jsdir, exist_ok=True)
    for name in ("audit.js", "doh.js", "check.js", "spf.js", "filter.js",
                 "unzip.js", "rua.js", "rua-ui.js", "findings.js"):
        shutil.copy2(os.path.join(HERE, "js", name), os.path.join(jsdir, name))

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

    check_js()
    check_copy()

    n = sum(len(files) for _, _, files in os.walk(OUT))
    print(f"built {n} files, {len(urls)} pages -> {OUT}")


if __name__ == "__main__":
    main()
