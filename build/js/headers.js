/* Email header parsing. Pure: no DOM, no network.
 *
 * Almost everything in a header block is extractable. Almost nothing in it is
 * verifiable, and the gap between those two is the whole design of this module.
 * Every field it returns carries how far it can be trusted, because a header
 * analyser that presents a forged Received line with the same confidence as a
 * real one is worse than no analyser.
 */

/** RFC 5322 section 2.2.3: unfolding removes a CRLF that is followed by
 *  whitespace. The whitespace itself stays - stripping it concatenates
 *  Authentication-Results tokens into nonsense. Bare LF is accepted because
 *  pasted headers have almost always lost their carriage returns, and parsing
 *  stops at the first empty line because message bodies contain text that looks
 *  exactly like headers. */
export function unfold(raw) {
  const lines = raw.replace(/\r\n/g, '\n').split('\n');
  const out = [];
  for (const line of lines) {
    if (line === '') break;                       // end of the header block
    if (/^[ \t]/.test(line) && out.length) {
      out[out.length - 1] += line;                // keep the leading WSP
    } else {
      out.push(line);
    }
  }
  // Order and duplicates are both information: multiple Received and multiple
  // Authentication-Results headers are normal, and the ordering is the evidence.
  return out.map(l => {
    const i = l.indexOf(':');
    return i < 0 ? null : [l.slice(0, i).trim(), l.slice(i + 1).trim()];
  }).filter(Boolean);
}

export const pick = (h, name) =>
  h.filter(([k]) => k.toLowerCase() === name.toLowerCase()).map(([, v]) => v);

/* RFC 5322 section 4.3: obsolete alphabetic zones other than UT and GMT must be
   treated as -0000, which means "offset unknown" rather than UTC. A literal
   -0000 says the same thing. Without this, new Date() silently invents an offset
   and every delay computed across that hop is fiction. */
const NAMED = { ut: 0, gmt: 0, z: 0 };
const MONTH = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
                jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

export function parseDate(str) {
  if (!str) return { ts: null, offsetKnown: false };
  const s = str.replace(/\([^)]*\)/g, ' ').trim();   // drop (CEST) style comments
  const m = s.match(/(?:[A-Za-z]{3},\s*)?(\d{1,2})\s+([A-Za-z]{3})\s+(\d{2,4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([+-]\d{4}|[A-Za-z]{1,5})?/);
  if (!m) return { ts: null, offsetKnown: false };
  const [, d, mon, yr, hh, mm, ss, zone] = m;
  const month = MONTH[mon.toLowerCase()];
  if (month === undefined) return { ts: null, offsetKnown: false };
  let year = Number(yr);
  if (year < 50) year += 2000; else if (year < 100) year += 1900;   // obs-year

  let offsetMin = 0, offsetKnown = false;
  if (zone && /^[+-]\d{4}$/.test(zone)) {
    if (zone !== '-0000') {
      offsetKnown = true;
      const sign = zone[0] === '-' ? -1 : 1;
      offsetMin = sign * (Number(zone.slice(1, 3)) * 60 + Number(zone.slice(3, 5)));
    }
  } else if (zone && NAMED[zone.toLowerCase()] !== undefined) {
    offsetKnown = true;
  }
  const utc = Date.UTC(year, month, Number(d), Number(hh), Number(mm), Number(ss || 0));
  return { ts: utc - offsetMin * 60000, offsetKnown, raw: str.trim() };
}

/* Received is defined by RFC 5321 4.4 and honoured loosely by every MTA. The one
   dependable anchor is that the timestamp follows the FINAL semicolon; everything
   before it is best effort and is marked as such. */
export function parseReceived(value) {
  const semi = value.lastIndexOf(';');
  const datePart = semi >= 0 ? value.slice(semi + 1) : '';
  const head = semi >= 0 ? value.slice(0, semi) : value;

  const ips = [...head.matchAll(/\[([0-9a-fA-F:.]{3,45})\]/g)].map(m => m[1]);
  const by = (head.match(/\bby\s+([A-Za-z0-9._-]+)/i) || [])[1] || null;
  const from = (head.match(/\bfrom\s+([A-Za-z0-9._-]+)/i) || [])[1] || null;
  const proto = (head.match(/\bwith\s+([A-Za-z0-9-]+)/i) || [])[1] || null;
  const id = (head.match(/\bid\s+([A-Za-z0-9._@<>+-]+)/i) || [])[1] || null;
  const forWhom = (head.match(/\bfor\s+<?([^\s;>]+@[^\s;>]+)>?/i) || [])[1] || null;

  return {
    raw: value,
    from, by, id, for: forWhom,
    ip: ips[0] || null,
    proto,
    tls: proto ? /^E?SMTPS|TLS/i.test(proto) : null,
    authenticated: proto ? /SA$|AUTH/i.test(proto) : null,
    date: parseDate(datePart),
    // A failed sub-parse degrades to "raw shown, fields not extracted" rather
    // than to silently empty fields that read as facts.
    parsed: Boolean(by || from || ips.length),
  };
}

/** RFC 8601 Authentication-Results: authserv-id; method=result (comment) prop=value */
export function parseAuthResults(value) {
  const parts = value.split(';');
  const authserv = parts.shift().trim().split(/\s+/)[0];
  const methods = [];
  for (const p of parts) {
    const t = p.trim();
    if (!t) continue;
    const m = t.match(/^([a-z][a-z0-9-]*)\s*=\s*([a-z]+)/i);
    if (!m) continue;
    const props = {};
    for (const pm of t.matchAll(/\b([a-z]+)\.([a-z-]+)\s*=\s*([^\s;()]+)/gi)) {
      props[`${pm[1]}.${pm[2]}`] = pm[3];
    }
    methods.push({ method: m[1].toLowerCase(), result: m[2].toLowerCase(), props,
                   raw: t });
  }
  return { authserv, methods };
}

const tagsOf = (v) => {
  const out = {};
  for (const part of v.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim().toLowerCase()] = part.slice(i + 1).trim();
  }
  return out;
};

export function parseDkim(value, fromDomain, now) {
  const t = tagsOf(value);
  const notes = [];
  if (t.a && /sha1/i.test(t.a)) {
    notes.push(['warn', `Signed with ${t.a}. SHA-1 is deprecated for DKIM and some `
      + 'receivers no longer accept it.']);
  }
  if (t.x) {
    const exp = Number(t.x) * 1000;
    if (isFinite(exp) && now && exp < now) {
      notes.push(['fail', 'The signature expired (x= is in the past). It cannot verify '
        + 'now even if it did when it was sent.']);
    }
  }
  if (t.l !== undefined) {
    notes.push(['warn', `Body-length limit set (l=${t.l}). Only the first ${t.l} bytes `
      + 'are signed, so content can be appended below the signed part without breaking '
      + 'the signature.']);
  }
  if (t.h && !/(^|:)\s*from\s*(:|$)/i.test(t.h)) {
    notes.push(['fail', 'The h= list does not cover From:, which RFC 6376 requires. '
      + 'The signature is invalid.']);
  }
  if (t.d && fromDomain) {
    const strict = t.d.toLowerCase() === fromDomain.toLowerCase();
    const relaxed = strict
      || t.d.toLowerCase().endsWith('.' + fromDomain.toLowerCase())
      || fromDomain.toLowerCase().endsWith('.' + t.d.toLowerCase());
    if (!relaxed) {
      notes.push(['warn', `Signed by ${t.d}, which does not align with the From: domain `
        + `${fromDomain}. Valid, but it will not satisfy DMARC on its own.`]);
    } else if (!strict) {
      notes.push(['info', `Signed by ${t.d}: aligns with ${fromDomain} under relaxed `
        + 'alignment, but not under strict.']);
    }
  }
  return { tags: t, notes };
}

/** ARC chains, structurally. Cryptographic validation is impossible from headers
 *  alone, same reason as DKIM, and this says so rather than implying otherwise. */
export function parseArc(h) {
  const inst = new Map();
  for (const [k, v] of h) {
    const kl = k.toLowerCase();
    if (!kl.startsWith('arc-')) continue;
    const i = Number(tagsOf(v).i || 0);
    if (!inst.has(i)) inst.set(i, {});
    inst.get(i)[kl] = v;
  }
  const seals = [...inst.entries()].sort((a, b) => a[0] - b[0]);
  const problems = [];
  seals.forEach(([i, set], idx) => {
    const cv = (tagsOf(set['arc-seal'] || '').cv || '').toLowerCase();
    if (i !== idx + 1) problems.push(`Instance numbering jumps at i=${i}.`);
    if (idx === 0 && cv && cv !== 'none') {
      problems.push(`The first seal has cv=${cv}; RFC 8617 requires cv=none at i=1.`);
    }
    if (idx > 0 && cv && cv !== 'pass') {
      problems.push(`Seal i=${i} has cv=${cv}, so the chain was already broken there.`);
    }
    if (!set['arc-seal'] || !set['arc-message-signature']) {
      problems.push(`Instance i=${i} is missing a seal or a message signature.`);
    }
  });
  return { count: seals.length, instances: seals, problems };
}

const addrDomain = (v) => {
  const m = (v || '').match(/@\s*([A-Za-z0-9.-]+)/);
  return m ? m[1].toLowerCase().replace(/[>.,;]+$/, '') : null;
};

/** The whole analysis. `now` is injected so the result is deterministic in tests. */
export function analyse(raw, opts = {}) {
  const h = unfold(raw);
  if (!h.length) throw new Error('No headers found. Paste the full header block, '
    + 'including the Received lines.');

  const from = pick(h, 'from')[0] || null;
  const fromDomain = addrDomain(from);

  // Received headers are prepended by each hop, so the list is newest first.
  const received = pick(h, 'received').map(parseReceived).reverse();
  let prev = null;
  for (const r of received) {
    r.delaySec = null;
    r.delayKnown = false;
    if (prev && prev.date.ts && r.date.ts && prev.date.offsetKnown && r.date.offsetKnown) {
      r.delaySec = Math.round((r.date.ts - prev.date.ts) / 1000);
      r.delayKnown = true;
    }
    prev = r;
  }
  const slowest = received
    .filter(r => r.delayKnown && r.delaySec > 0)
    .sort((a, b) => b.delaySec - a.delaySec)[0] || null;

  return {
    headers: h,
    subject: pick(h, 'subject')[0] || null,
    from, fromDomain,
    to: pick(h, 'to')[0] || null,
    date: parseDate(pick(h, 'date')[0]),
    messageId: pick(h, 'message-id')[0] || null,
    returnPath: pick(h, 'return-path')[0] || null,
    envelopeDomain: addrDomain(pick(h, 'return-path')[0]),
    listUnsubscribe: pick(h, 'list-unsubscribe')[0] || null,
    listUnsubscribePost: pick(h, 'list-unsubscribe-post')[0] || null,
    received,
    slowest,
    authResults: pick(h, 'authentication-results').map(parseAuthResults),
    receivedSpf: pick(h, 'received-spf'),
    dkim: pick(h, 'dkim-signature').map(v => parseDkim(v, fromDomain, opts.now)),
    arc: parseArc(h),
    // Stated rather than assumed: from a pasted block there is no way to know
    // which Authentication-Results header was written by a trusted boundary.
    boundary: opts.boundary || null,
  };
}
