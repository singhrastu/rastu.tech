#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Build the email RFC index from the RFC Editor's own index and the RFC texts.

    python3 build/export_rfcs.py             # use the cached sources
    python3 build/export_rfcs.py --fetch     # re-download the index
    python3 build/export_rfcs.py --fetch-texts   # and every RFC body

WHY THIS EXISTS
Reading an RFC is not the hard part. Working out which one to read is. Three
things trip people up and none of them are visible on the document you land on:

  1. It has been replaced. Search for the SMTP RFC and you land on 821, which
     is still labelled INTERNET STANDARD while the document that replaced it,
     5321, is labelled DRAFT STANDARD. The status field actively misleads.
  2. It is current but amended. An RFC can be the right one and still have been
     changed by something published years later. RFC 5321 is amended by 7504.
     Nothing on the page tells you.
  3. What binds you is a few dozen sentences. The normative requirements, in
     the RFC 2119 sense, are what an implementation has to satisfy. Everything
     else is exposition.

So this emits, per RFC: the chain that leads to the current document, what
amends it, and every normative requirement with the section it came from.

SOURCES
  rfc-index.xml   the RFC Editor's machine-readable index: status, obsoletes,
                  obsoleted-by, updates, updated-by, abstract, errata, DOI
  rfcNNNN.txt     the document itself, for the normative requirements

Both are cached under build/sources/ so the build is reproducible offline and
every line on the page can be traced to a published document.
"""
import argparse
import json
import os
import re
import sys
import time
import urllib.request
# defusedxml would be the textbook answer and it is a dependency this project
# does not have and does not want. The exposure it addresses is entity
# expansion, and DOCTYPE below refuses any document declaring a DTD or an
# entity at all, which is a stricter rule than defusedxml applies. The only
# input is the RFC Editor index, fetched over https, which declares neither.
import xml.etree.ElementTree as ET  # nosemgrep: use-defused-xml

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
try:
    from rfc_notes import NOTES
except ImportError:          # the index still builds without the commentary
    NOTES = {}
SRC = os.path.join(HERE, "sources")
TXT = os.path.join(SRC, "rfc")
NS = {"r": "https://www.rfc-editor.org/rfc-index"}
INDEX_URL = "https://www.rfc-editor.org/rfc-index.xml"
UA = "rastu.tech RFC index builder (+https://rastu.tech/rfc/)"

# Topic anchors, not the published set. Historical numbers are deliberately in
# here: the resolver walks every chain forward to whatever is current today, so
# seeding 7489 yields the DMARC documents that replaced it and seeding 821
# yields 5321. Obsolete documents never become entries. They become aliases, so
# somebody who types "821" lands on the document they should be reading.
EMAIL = {
    "Transport": [
        821, 2821, 5321, 7504, 1869, 1870, 2920, 3030, 6152, 3461, 3464, 3462,
        6522, 3463, 2034, 5336, 4468, 4865, 6710, 7505,
    ],
    "Message format": [
        822, 2822, 5322, 2045, 2046, 2047, 2048, 2049, 2183, 2387, 2392, 2557,
        3676, 5536, 5537, 6854, 9057,
    ],
    "Authentication": [
        6376, 8301, 8463, 6377, 5863, 4871, 4870, 7208, 4408, 7372, 7489, 9989,
        9990, 9991, 9091, 8617, 8616, 8601, 7601, 5451, 6008, 7960, 6541, 5617,
    ],
    "Transport security": [
        3207, 8461, 8460, 7672, 7817, 8689, 8314,
    ],
    "Internationalization": [
        6530, 6531, 6532, 6533, 6855, 6856, 6857, 6858,
    ],
    "Submission and access": [
        6409, 4409, 2476, 4954, 2554, 1939, 3501, 9051, 6186, 8437,
    ],
    "Reporting and feedback": [
        5965, 6591, 6650, 6449, 8058, 2369, 2919,
    ],
    "Anti-abuse and operations": [
        5782, 6471, 2142, 6647, 5068,
    ],
    "Architecture": [
        5598, 1123, 974,
    ],
}

# Title and abstract signals used to spot an email RFC that no anchor reaches.
# These never auto-publish. They raise a candidate for review, because a keyword
# sweep of nine thousand documents drags in process and routing RFCs that merely
# mention mail.
DISCOVERY = re.compile(
    r"\b(SMTP|DKIM|DMARC|SPF|MIME|IMAP|POP3|mailbox|mail submission|message "
    r"submission|e-?mail|mail transfer|mail user agent|MTA|MUA|sender policy"
    r"|message/rfc822|bounce|non-delivery|mail server)\b", re.I)


def rfcid(n):
    return f"RFC{n}"


def _https(url):
    """urllib will happily open file:// and ftp://. These fetchers only ever
    want one scheme, so say so rather than trusting every future caller."""
    if not url.startswith("https://"):
        sys.exit(f"refusing to fetch a non-https URL: {url}")
    return url


def fetch_index():
    os.makedirs(SRC, exist_ok=True)
    req = urllib.request.Request(_https(INDEX_URL), headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=180) as r:
        data = r.read()
    with open(os.path.join(SRC, "rfc-index.xml"), "wb") as fh:
        fh.write(data)
    print(f"  rfc-index.xml  {len(data) // 1024}KB")


def fetch_texts(numbers):
    os.makedirs(TXT, exist_ok=True)
    got = new = 0
    for n in sorted(numbers):
        p = os.path.join(TXT, f"rfc{n}.txt")
        if os.path.exists(p) and os.path.getsize(p) > 500:
            got += 1
            continue
        url = f"https://www.rfc-editor.org/rfc/rfc{n}.txt"
        try:
            req = urllib.request.Request(_https(url), headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=90) as r:
                body = r.read()
            with open(p, "wb") as fh:
                fh.write(body)
            new += 1
            time.sleep(0.35)          # the RFC Editor is a volunteer service
        except Exception as e:        # noqa: BLE001 - reported, never fatal
            print(f"    rfc{n}: {e}")
    print(f"  texts: {got} cached, {new} downloaded")


# ElementTree expands internal entities, so a document carrying a nest of them
# can exhaust the machine parsing it. The RFC index has no DTD and never has, so
# refusing one outright removes the whole class without taking on a dependency
# this project does not otherwise need. A real index will never trip it; a
# substituted one will.
DOCTYPE = re.compile(rb"<!\s*(DOCTYPE|ENTITY)\b", re.I)


def load_index():
    p = os.path.join(SRC, "rfc-index.xml")
    if not os.path.exists(p):
        sys.exit("rfc-index.xml is not cached. Run with --fetch once.")
    with open(p, "rb") as fh:
        head = fh.read(65536)
    if DOCTYPE.search(head):
        sys.exit("rfc-index.xml declares a DTD or an entity. The published index "
                 "does not, so this copy is not the published index. Refusing it.")
    root = ET.parse(p).getroot()  # nosemgrep: use-defused-xml-parse
    out = {}
    for e in root.findall("r:rfc-entry", NS):
        i = e.findtext("r:doc-id", default="", namespaces=NS)

        def ids(tag):
            node = e.find("r:" + tag, NS)
            return [d.text for d in node.findall("r:doc-id", NS)] if node is not None else []

        authors = [a.findtext("r:name", default="", namespaces=NS)
                   for a in e.findall("r:author", NS)]
        out[i] = {
            "id": i,
            "num": int(i[3:]),
            "title": (e.findtext("r:title", default="", namespaces=NS) or "").strip(),
            "status": e.findtext("r:current-status", default="", namespaces=NS),
            "published": (e.findtext("r:date/r:month", default="", namespaces=NS) + " "
                          + e.findtext("r:date/r:year", default="", namespaces=NS)).strip(),
            "obsoletes": ids("obsoletes"),
            "obsoleted_by": ids("obsoleted-by"),
            "updates": ids("updates"),
            "updated_by": ids("updated-by"),
            "abstract": " ".join(" ".join("".join(p.itertext()).split())
                                 for p in e.findall("r:abstract/r:p", NS)).strip(),
            "errata": e.findtext("r:errata-url", default="", namespaces=NS),
            "doi": e.findtext("r:doi", default="", namespaces=NS),
            "authors": [a for a in authors if a],
            "stream": e.findtext("r:stream", default="", namespaces=NS),
        }
    return out


# ---------------------------------------------------------------- the text

PAGE_JUNK = re.compile(
    r"^\s*(RFC\s+\d+.{0,70}(19|20)\d\d\s*$|.{0,60}\[Page\s+\d+\]\s*$)", re.M)
SECTION = re.compile(r"^(\d+(?:\.\d+)*)\.?\s+([A-Z(\"'].{0,90})$")
# Longest first: "MUST NOT" must win over "MUST".
KEYWORD = re.compile(
    r"\b(MUST NOT|SHALL NOT|SHOULD NOT|NOT RECOMMENDED|MUST|SHALL|SHOULD"
    r"|REQUIRED|RECOMMENDED|OPTIONAL|MAY)\b")
LEVEL = {
    "MUST": "must", "MUST NOT": "must", "SHALL": "must", "SHALL NOT": "must",
    "REQUIRED": "must",
    "SHOULD": "should", "SHOULD NOT": "should", "RECOMMENDED": "should",
    "NOT RECOMMENDED": "should",
    "MAY": "may", "OPTIONAL": "may",
}
# RFC 2119 boilerplate. Every RFC contains it and none of it is a requirement:
# left in, it would put five fake obligations at the top of every document.
BOILER = re.compile(
    r"key words|are to be interpreted as described|BCP\s*14|RFC\s*2119|RFC\s*8174",
    re.I)
ABBREV = re.compile(r"\b(e\.g|i\.e|etc|cf|vs|resp|Sec|Fig|No|Mr|Dr|St|approx)\.$")


def sentences(par):
    """Split a paragraph, keeping abbreviations whole."""
    out, cur = [], ""
    for piece in re.split(r"(?<=[.!?])\s+", par):
        cur = (cur + " " + piece).strip() if cur else piece
        if not ABBREV.search(cur):
            out.append(cur)
            cur = ""
    if cur:
        out.append(cur)
    return out


# The sentence that adopts RFC 2119, in its several published spellings. A
# document without it is not using the convention, which is a different thing
# from having no requirements.
# Matching on proximity to "key words" fails: that phrase appears first in the
# table of contents, ten thousand characters before the real sentence. The
# adoption phrase itself is unambiguous and appears nowhere else.
ADOPTS = re.compile(
    r"are to be interpreted as described in|\bBCP\s*14\b", re.I)


def requirements(path):
    """Every normative sentence in an RFC, with the section it came from.

    Only the uppercase RFC 2119 keywords count. Lowercase "must" is prose and
    binds nobody, and treating the two alike is how a requirements list stops
    being trustworthy.

    Returns (uses_2119, requirements). The flag matters: RFC 6152 is Standards
    Track and contains no uppercase keyword anywhere, because it is a 2011
    republication of a 1994 document and never adopted the convention. An empty
    list there is a fact about the document. An empty list for something that
    does adopt 2119 would be a bug, and the two must not look alike.
    """
    try:
        with open(path, encoding="utf8", errors="replace") as fh:
            raw = fh.read()
    except OSError:
        return None, []
    uses = bool(ADOPTS.search(raw))

    raw = raw.replace("\f", "\n")
    raw = PAGE_JUNK.sub("", raw)

    out = []
    section = ("", "")
    para = []

    def flush():
        if not para:
            return
        text = " ".join(" ".join(para).split())
        if len(text) < 25 or BOILER.search(text):
            return
        for s in sentences(text):
            m = KEYWORD.search(s)
            if not m or BOILER.search(s):
                continue
            if len(s) > 600 or len(s) < 25:
                continue
            out.append({
                "section": section[0],
                "heading": section[1],
                "level": LEVEL[m.group(1)],
                "keyword": m.group(1),
                "text": s.strip(),
            })

    for line in raw.split("\n"):
        stripped = line.strip()
        head = SECTION.match(line) if not line.startswith(" ") else None
        if head:
            flush()
            para = []
            section = (head.group(1), head.group(2).strip())
            continue
        if not stripped:
            flush()
            para = []
            continue
        para.append(stripped)
    flush()

    # The same sentence is often restated verbatim in a summary section.
    seen, uniq = set(), []
    for r in out:
        k = r["text"].lower()
        if k in seen:
            continue
        seen.add(k)
        uniq.append(r)
    return uses, uniq


def successors(idx, rid):
    """Every current document that replaced this one.

    Not a walk but a search: a revision can split. RFC 7489 was replaced by
    three documents at once, so following only the first would lose two of
    them.
    """
    seen, queue, current = set(), [rid], []
    while queue:
        x = queue.pop()
        if x in seen or x not in idx:
            continue
        seen.add(x)
        if idx[x]["obsoleted_by"]:
            queue.extend(idx[x]["obsoleted_by"])
        elif x != rid or not idx[rid]["obsoleted_by"]:
            current.append(x)
    return sorted(set(current), key=lambda r: idx[r]["num"])


def ancestors(idx, rid):
    """Everything this document replaced, however far back."""
    seen, queue, out = set(), list(idx[rid]["obsoletes"]), []
    while queue:
        x = queue.pop()
        if x in seen or x not in idx:
            continue
        seen.add(x)
        out.append(x)
        queue.extend(idx[x]["obsoletes"])
    return sorted(out, key=lambda r: idx[r]["num"])


def resolve(idx, anchors):
    """Anchors in; the set that is current today out, with the aliases.

    An anchor is a topic, not a document. Seeding 7489 has to yield whatever
    DMARC is now, without anybody editing this file when that changes. That is
    the whole mechanism by which the index stays current: a revision is an edge
    in the index, and edges are followed on every build.
    """
    members = {}
    for n, cat in sorted(anchors.items()):
        rid = rfcid(n)
        if rid not in idx:
            continue
        for cur in (successors(idx, rid) if idx[rid]["obsoleted_by"] else [rid]):
            # HISTORIC is the IETF's own word for a document that is no longer
            # recommended. Nothing formally replaced RFC 5617, so it survives an
            # obsoletion check while being exactly what "not current" means.
            if idx[cur]["status"].upper() == "HISTORIC":
                continue
            members.setdefault(cur, cat)

    # Anything that amends a member is part of the same subject. High precision:
    # an RFC that updates RFC 7208 is about SPF whatever its title says.
    for rid in list(members):
        for up in idx[rid]["updated_by"]:
            if up in idx and not idx[up]["obsoleted_by"]:
                members.setdefault(up, members[rid])

    # Aliases: every replaced document points at what replaced it, so a search
    # for "821" lands on 5321 instead of nothing. The old documents are not
    # entries and are not listed. They are a redirect and a sentence of history.
    alias = {}
    for n in sorted(anchors):
        rid = rfcid(n)
        if rid in idx and idx[rid]["status"].upper() == "HISTORIC":
            alias[idx[rid]["num"]] = {
                "id": rid, "title": idx[rid]["title"], "status": idx[rid]["status"],
                "published": idx[rid]["published"], "now": [],
                "note": "Reclassified Historic by the IETF, which means it is no "
                        "longer recommended. Nothing formally replaced it.",
            }
    for rid in members:
        for old in ancestors(idx, rid):
            alias.setdefault(idx[old]["num"], {
                "id": old,
                "title": idx[old]["title"],
                "status": idx[old]["status"],
                "published": idx[old]["published"],
                "now": [],
            })
            if rid not in alias[idx[old]["num"]]["now"]:
                alias[idx[old]["num"]]["now"].append(rid)
    return members, alias


def candidates(idx, members):
    """Current email-looking RFCs that no anchor reaches.

    Reported, never published. A keyword sweep of nine thousand documents finds
    routing and process RFCs that merely mention mail, so this is a queue for a
    person to judge, not an input to the build.
    """
    out = []
    for rid, e in idx.items():
        if rid in members or e["obsoleted_by"]:
            continue
        if DISCOVERY.search(e["title"]) or DISCOVERY.search(e["abstract"][:400]):
            out.append({"id": rid, "num": e["num"], "title": e["title"],
                        "status": e["status"], "published": e["published"]})
    return sorted(out, key=lambda x: -x["num"])


def chain(idx, rid):
    """The path from an RFC to the document that is current today."""
    out, cur, guard = [], rid, 0
    while cur in idx and idx[cur]["obsoleted_by"] and guard < 12:
        nxt = idx[cur]["obsoleted_by"][0]
        out.append(nxt)
        cur = nxt
        guard += 1
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--fetch", action="store_true")
    ap.add_argument("--fetch-texts", action="store_true")
    a = ap.parse_args()

    if a.fetch or a.fetch_texts:
        fetch_index()

    idx = load_index()

    anchors = {}
    for cat, nums in EMAIL.items():
        for n in nums:
            anchors.setdefault(n, cat)

    missing = [n for n in anchors if rfcid(n) not in idx]
    if missing:
        sys.exit(f"anchor not in the RFC index: {sorted(missing)}")

    members, alias = resolve(idx, anchors)

    if a.fetch_texts:
        fetch_texts([idx[r]["num"] for r in members])

    entries = []
    for rid, cat in sorted(members.items(), key=lambda kv: idx[kv[0]]["num"]):
        e = dict(idx[rid])
        e["category"] = cat
        e["replaces"] = ancestors(idx, rid)
        # Written commentary, merged here rather than held in the page builder,
        # so the weekly refresh carries it forward and a new document that
        # replaces an old one simply has no note until one is written.
        if e["num"] in NOTES:
            e["note"] = NOTES[e["num"]]
        # Never show a bare number. Every reference carries its title.
        e["rel_titles"] = {
            r: idx[r]["title"] for r in
            set(e["obsoletes"] + e["updates"] + e["updated_by"] + e["replaces"])
            if r in idx
        }
        uses, reqs = requirements(os.path.join(TXT, f"rfc{e['num']}.txt"))
        e["uses_2119"] = uses
        e["requirements"] = reqs
        e["req_counts"] = {lv: sum(1 for r in reqs if r["level"] == lv)
                           for lv in ("must", "should", "may")}
        for k in ("obsoleted_by",):
            e.pop(k, None)
        entries.append(e)

    cand = candidates(idx, members)
    out = {
        "generated_from": {"index": INDEX_URL,
                           "texts": "https://www.rfc-editor.org/rfc/rfcNNNN.txt"},
        "categories": [c for c in EMAIL if any(e["category"] == c for e in entries)],
        "rfcs": entries,
        "aliases": alias,
    }
    total_reqs = sum(len(e["requirements"]) for e in entries)
    withreq = sum(1 for e in entries if e["requirements"])

    # Split. The index is what every visitor downloads, so the 3,660 requirement
    # sentences do not belong in it: they are a megabyte nobody has asked for
    # yet. One file per RFC, fetched when that RFC is opened. Both are static
    # assets, which is the part of Cloudflare that is free at any volume.
    reqdir = os.path.join(HERE, "rfc")
    os.makedirs(reqdir, exist_ok=True)
    for stale in os.listdir(reqdir):
        if stale.endswith(".json"):
            os.remove(os.path.join(reqdir, stale))
    for e in entries:
        with open(os.path.join(reqdir, f"{e['num']}.json"), "w", encoding="utf8") as fh:
            json.dump({"num": e["num"], "id": e["id"], "uses_2119": e["uses_2119"],
                       "requirements": e["requirements"]},
                      fh, separators=(",", ":"), ensure_ascii=False)
    for e in out["rfcs"]:
        e.pop("requirements", None)

    path = os.path.join(HERE, "rfcs.json")
    with open(path, "w", encoding="utf8") as fh:
        json.dump(out, fh, separators=(",", ":"), ensure_ascii=False)
    with open(os.path.join(HERE, "rfc-candidates.json"), "w", encoding="utf8") as fh:
        json.dump(cand, fh, indent=2, ensure_ascii=False)

    amended = sum(1 for e in entries if e["updated_by"])
    print(f"  {len(entries)} current email RFCs across {len(out['categories'])} categories")
    print(f"  {len(alias)} replaced documents kept as aliases only, never listed")
    print(f"  {amended} are current but amended by a later RFC")
    print(f"  requirements from {withreq}/{len(entries)}: "
          f"{total_reqs} normative sentences")
    written = sum(1 for e in entries if e.get("note"))
    print(f"  {written} have a written explanation")
    print(f"  {len(cand)} discovery candidates for review -> build/rfc-candidates.json")
    per = sum(os.path.getsize(os.path.join(reqdir, f))
              for f in os.listdir(reqdir) if f.endswith(".json"))
    noconv = sum(1 for e in entries if e["uses_2119"] is False)
    print(f"  {noconv} state requirements in prose without adopting RFC 2119")
    print(f"  -> {path}  {os.path.getsize(path) // 1024}KB index"
          f"  + build/rfc/*.json  {per // 1024}KB across {len(entries)} files")


if __name__ == "__main__":
    main()
