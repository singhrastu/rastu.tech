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
/* Design tokens. Light is the base; dark redefines only the tokens. */
:root{
  --ink:#14171c; --ink-2:#3d4450; --ink-3:#6b7280;
  --line:#e4e7ec; --line-2:#f1f3f6;
  --bg:#fff; --surface:#f8f9fb; --code:#f4f6f8;
  --accent:#1f4e79; --accent-2:#2d6ca8; --accent-soft:#eaf1f8;
  --hex:#1f4e79;
  --radius:10px;
  --measure:44rem;
}
@media(prefers-color-scheme:dark){:root{
  --ink:#e8eaee; --ink-2:#b4bcc8; --ink-3:#8а93a1; --ink-3:#8b93a1;
  --line:#272c34; --line-2:#1e222a;
  --bg:#101318; --surface:#161a21; --code:#1a1f27;
  --accent:#7fb2e5; --accent-2:#9cc6f0; --accent-soft:#18222e;
  --hex:#7fb2e5;
}}

*{box-sizing:border-box}
html{scroll-behavior:smooth}
body{
  margin:0;background:var(--bg);color:var(--ink);
  font:16.5px/1.68 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
  -webkit-font-smoothing:antialiased;
}

/* ---- honeycomb field -------------------------------------------------
   Fixed behind everything, drifting slowly as the page scrolls. Pure CSS
   background + one transform driven by a custom property, so it costs one
   compositor layer and no layout. Hidden entirely under reduced-motion. */
#hexcanvas{position:fixed;inset:0;z-index:0;pointer-events:none;display:block}
.hexveil{position:fixed;inset:0;z-index:0;pointer-events:none;
  background:linear-gradient(180deg,transparent 0%,transparent 42%,var(--bg) 94%)}

.wrap{position:relative;z-index:1;max-width:var(--measure);margin:0 auto;padding:0 1.35rem 5rem}

/* ---- nav -------------------------------------------------------------- */
nav.top{
  display:flex;gap:1.5rem;align-items:center;flex-wrap:wrap;
  padding:1.4rem 0 2.6rem;font-size:.93rem;
}
nav.top a{color:var(--ink-2);text-decoration:none;transition:color .15s}
nav.top a:hover{color:var(--accent)}
nav.top a:first-child{font-weight:650;color:var(--ink)}

/* ---- type ------------------------------------------------------------- */
a{color:var(--accent);text-underline-offset:2px}
h1{font-size:clamp(1.9rem,4.5vw,2.5rem);line-height:1.16;letter-spacing:-.021em;margin:.3rem 0 .7rem;font-weight:680}
h2{font-size:1.24rem;letter-spacing:-.01em;margin:2.9rem 0 .85rem;padding-bottom:.45rem;border-bottom:1px solid var(--line);font-weight:650}
h3{font-size:1.02rem;margin:1.9rem 0 .45rem;font-weight:650}
p{margin:0 0 1.05rem}
.kicker{color:var(--ink-3);font-size:.76rem;letter-spacing:.11em;text-transform:uppercase;margin:0 0 .2rem;font-weight:600}
.lede{font-size:1.14rem;line-height:1.6;color:var(--ink);margin-bottom:1.3rem}
.meta{color:var(--ink-3);font-size:.9rem}
ul{padding-left:1.15rem}
li{margin:.4rem 0}
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

/* ---- timeline ---------------------------------------------------------- */
.tl{position:relative;margin:1.2rem 0;padding-left:1.55rem}
.tl::before{content:"";position:absolute;left:5px;top:.6rem;bottom:.6rem;width:1px;background:var(--line)}
.tl .e{position:relative;padding:.5rem 0 .95rem}
.tl .e::before{content:"";position:absolute;left:-1.55rem;top:.95rem;width:9px;height:9px;
   border-radius:50%;background:var(--bg);border:2px solid var(--line);transition:border-color .25s}
.tl .e:hover::before{border-color:var(--accent)}
.tl .e:first-child::before{border-color:var(--accent);background:var(--accent)}
.tl .role{font-weight:650;font-size:.97rem}
.tl .org{color:var(--ink-2);font-size:.895rem}
.tl .yr{color:var(--ink-3);font-size:.795rem;font-variant-numeric:tabular-nums;margin-top:.1rem}

/* ---- footer ----------------------------------------------------------- */
footer{margin-top:4.5rem;padding-top:1.4rem;border-top:1px solid var(--line);
       color:var(--ink-3);font-size:.885rem}

/* ---- scroll reveal ---------------------------------------------------- */
.r{opacity:0;transform:translateY(16px);transition:opacity .7s ease,transform .7s cubic-bezier(.22,.7,.3,1)}
.r.reveal{opacity:1;transform:none}
.strip.reveal div,.bento.reveal .card{animation:pop .55s cubic-bezier(.22,.9,.3,1) both}
.strip.reveal div:nth-child(2),.bento.reveal .card:nth-child(2){animation-delay:.07s}
.strip.reveal div:nth-child(3),.bento.reveal .card:nth-child(3){animation-delay:.14s}
.strip.reveal div:nth-child(4){animation-delay:.21s}
@keyframes pop{from{opacity:0;transform:translateY(12px) scale(.97)}to{opacity:1;transform:none}}
h1{animation:rise .85s cubic-bezier(.22,.8,.3,1) both}
.lede{animation:rise .85s cubic-bezier(.22,.8,.3,1) .1s both}
.hero img{animation:rise .85s cubic-bezier(.22,.8,.3,1) .18s both}
@keyframes rise{from{opacity:0;transform:translateY(18px)}to{opacity:1;transform:none}}

@media(prefers-reduced-motion:reduce){
  html{scroll-behavior:auto}
  #hexcanvas{display:none}
  h1,.lede,.hero img,.strip.reveal div,.bento.reveal .card{animation:none;opacity:1;transform:none}
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

  var targets = document.querySelectorAll('.r,.bars,.strip,.bento,.grid,.stats');
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
<script>{JS}</script>
</body>
</html>
"""
    # wrap tables so wide data scrolls inside its own container rather than
    # forcing the page to scroll sideways
    doc = doc.replace("<table>", '<div class="scroll-x r"><table>').replace(
        "</table>", "</table></div>")
    doc = doc.replace("<h2>", '<h2 class="r">')

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

<h2>The gaps, which are the interesting part</h2>

<p>Adoption rates are the least useful thing a survey like this produces. The gap between
publishing a record and being protected by it is where the real picture is. All figures below
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
