/* Email header analysis. Pure: no DOM, no network, no clock of its own.
 *
 * Almost everything in a header block is extractable. Almost nothing in it is
 * verifiable, and the distance between those two is the whole design of this
 * module. Every finding carries an owner, because "SPF failed on hop 3" is
 * useless and "SPF failed because this was forwarded, which is normal and not
 * yours to fix" is the answer.
 *
 * Alignment is imported from rua.js rather than reimplemented. Two answers to
 * one question inside one repository is how a tool starts contradicting itself.
 */
import { finding } from './findings.js';
import { aligns, organisational } from './rua.js';

/** RFC 5322 section 2.2.3: unfolding removes a CRLF followed by whitespace. The
 *  whitespace itself stays, because stripping it concatenates
 *  Authentication-Results tokens into nonsense.
 *
 *  Three details everything else depends on:
 *    - bare LF is accepted, because a pasted block has usually lost its CRs;
 *    - leading blank lines are skipped rather than ending the block, because
 *      copying from "Show original" routinely produces one and stopping there
 *      tells the user their input is missing content that is visibly present;
 *    - a whitespace-only line ends the block. It is not a continuation: clients
 *      that soft-wrap emit exactly that, and folding it in drags the entire
 *      message body into the last header. */
export function unfold(raw) {
  const lines = String(raw).replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let started = false;
  for (const line of lines) {
    if (!line.trim()) {
      if (!started) continue;
      break;
    }
    started = true;
    if (/^[ \t]/.test(line) && out.length) {
      out[out.length - 1] += line;
    } else {
      out.push(line);
    }
  }
  // Order and duplicates are both evidence: several Received and several
  // Authentication-Results headers are normal and the ordering is the point.
  return out.map(l => {
    const i = l.indexOf(':');
    return i < 0 ? null : [l.slice(0, i).trim(), l.slice(i + 1).trim()];
  }).filter(Boolean);
}

export const pick = (h, name) =>
  h.filter(([k]) => k.toLowerCase() === name.toLowerCase()).map(([, v]) => v);

/* ------------------------------------------------------------------- dates */
/* RFC 5322 section 4.3: obsolete alphabetic zones other than UT and GMT must be
   treated as -0000, which means "offset unknown" and not "UTC". A literal -0000
   says the same. Without this a delay computed across such a timestamp is
   invention, and the two biggest header tools both sell on delay detection
   while documenting none of it. */
const NAMED_ZONE = { ut: 0, gmt: 0, z: 0 };
const MONTH = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
                jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

export function parseDate(str) {
  const none = { ts: null, offsetKnown: false, raw: str ? String(str).trim() : '' };
  if (!str) return none;
  const s = String(str).replace(/\([^)]*\)/g, ' ').trim();
  const m = s.match(
    /(?:[A-Za-z]{3},\s*)?(\d{1,2})\s+([A-Za-z]{3})\s+(\d{2,4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([+-]\d{4}|[A-Za-z]{1,5})?/);
  if (!m) return none;
  const [, d, mon, yr, hh, mm, ss, zone] = m;
  const month = MONTH[mon.toLowerCase()];
  if (month === undefined) return none;

  // Ranges are checked rather than left to Date.UTC's silent rollover, which
  // turns a garbage timestamp into a plausible one that then drives a delay.
  const day = Number(d), hour = Number(hh), min = Number(mm), sec = Number(ss || 0);
  if (day < 1 || day > 31 || hour > 23 || min > 59 || sec > 60) return none;

  let year = Number(yr);
  if (yr.length <= 2) year += year < 50 ? 2000 : 1900;
  if (year < 1970 || year > 2200) return none;

  let offsetMin = 0;
  let offsetKnown = false;
  if (zone && /^[+-]\d{4}$/.test(zone)) {
    if (zone !== '-0000') {
      const hrs = Number(zone.slice(1, 3));
      const mins = Number(zone.slice(3, 5));
      if (hrs <= 14 && mins <= 59) {
        offsetKnown = true;
        offsetMin = (zone[0] === '-' ? -1 : 1) * (hrs * 60 + mins);
      }
    }
  } else if (zone && NAMED_ZONE[zone.toLowerCase()] !== undefined) {
    offsetKnown = true;
  }
  return {
    ts: Date.UTC(year, month, day, hour, min, sec) - offsetMin * 60000,
    offsetKnown,
    raw: String(str).trim(),
  };
}

/* ---------------------------------------------------------------- Received */
/* Defined by RFC 5321 4.4 and honoured loosely by every MTA. The one dependable
   anchor is that the timestamp follows the final semicolon; everything before it
   is best effort and is marked as such. */
export function parseReceived(value) {
  const semi = value.lastIndexOf(';');
  const head = semi >= 0 ? value.slice(0, semi) : value;
  const date = parseDate(semi >= 0 ? value.slice(semi + 1) : '');

  // Postfix and Exchange write [IPv6:2001:db8::1]. Matching only hex and colons
  // missed every one of them, so every IPv6 hop showed no address at all.
  const ips = [...head.matchAll(/\[(?:IPv6:)?([0-9a-fA-F:.]{3,45})\]/gi)].map(m => m[1]);
  const by = (head.match(/\bby\s+([A-Za-z0-9._-]+)/i) || [])[1] || null;
  const from = (head.match(/\bfrom\s+([A-Za-z0-9._-]+)/i) || [])[1] || null;
  const proto = (head.match(/\bwith\s+([A-Za-z0-9-]+)/i) || [])[1] || null;
  const id = (head.match(/\bid\s+([A-Za-z0-9._@<>+-]+)/i) || [])[1] || null;
  const forWhom = (head.match(/\bfor\s+<?([^\s;>]+@[^\s;>]+)>?/i) || [])[1] || null;

  // ESMTPS and ESMTPSA are TLS. ESMTPA is authenticated WITHOUT TLS, which is
  // its own problem and was previously detected as neither.
  const p = (proto || '').toUpperCase();
  return {
    raw: value,
    from, by, id, for: forWhom,
    ip: ips[0] || null,
    allIps: ips,
    proto,
    tls: proto ? (/^E?SMTPS/.test(p) || /TLS/.test(p)) : null,
    authenticated: proto ? (/A$/.test(p) || /AUTH/.test(p)) : null,
    date,
    // A failed sub-parse degrades to "raw shown, fields not extracted" rather
    // than to empty fields that read as facts.
    parsed: Boolean(by || from || ips.length),
  };
}

/* ------------------------------------------------- Authentication-Results */
/** RFC 8601: authserv-id; method=result (comment) ptype.property=value
 *
 *  Splitting on ";" naively destroys Gmail's real output, which contains
 *  "(2048-bit key; unprotected)" inside a comment. That semicolon ends the dkim
 *  entry early and header.d - the signing domain, the one value alignment
 *  depends on - is silently lost on the most common input there is. Comments are
 *  stripped before splitting. */
export function parseAuthResults(value) {
  const stripped = String(value).replace(/\([^()]*\)/g, ' ');
  const parts = stripped.split(';');
  const authserv = (parts.shift() || '').trim().split(/\s+/)[0] || '';
  const methods = [];
  for (const part of parts) {
    const t = part.trim();
    if (!t) continue;
    const m = t.match(/^([a-z][a-z0-9-]*)\s*=\s*([a-z]+)/i);
    if (!m) continue;
    const props = {};
    for (const pm of t.matchAll(/\b([a-z]+)\.([a-z-]+)\s*=\s*([^\s;]+)/gi)) {
      props[`${pm[1]}.${pm[2]}`.toLowerCase()] = pm[3];
    }
    methods.push({ method: m[1].toLowerCase(), result: m[2].toLowerCase(), props, raw: t });
  }
  return { authserv, methods, raw: value };
}

/* An Authentication-Results property value is a mailbox, not a domain. RFC 8601
   section 2.2 allows it quoted, and a bounce address carries a local part that
   is often longer than the domain: SendGrid's VERP return path is
   "bounces+35448233-8a4a-recipient=gmail.com@em5167.store.example.com". Comparing
   that whole string against the From: domain reports a record that aligns
   perfectly as not aligning, which is worse than saying nothing. */
export function domainOf(value) {
  let v = String(value || '').trim();
  v = v.replace(/^["'<]+|["'>]+$/g, '');          // quoting and angle brackets
  if (!v || v === '<>') return '';                // the null sender
  const at = v.lastIndexOf('@');
  if (at !== -1) v = v.slice(at + 1);
  return v.toLowerCase().replace(/\.+$/, '');
}

const tagsOf = (v) => {
  const out = {};
  for (const part of String(v).split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim().toLowerCase()] = part.slice(i + 1).trim();
  }
  return out;
};

export const parseDkimSignature = (v) => tagsOf(v);

/* ----------------------------------------------------------------- the ARC */
/** Structural only. Validating an ARC chain cryptographically is impossible from
 *  headers alone, for the same reason DKIM is, and this says so rather than
 *  implying otherwise. */
export function parseArc(h) {
  const inst = new Map();
  for (const [k, v] of h) {
    const kl = k.toLowerCase();
    if (!kl.startsWith('arc-')) continue;
    const i = Number(tagsOf(v).i || 0);
    if (!inst.has(i)) inst.set(i, {});
    inst.get(i)[kl] = v;
  }
  const instances = [...inst.entries()].sort((a, b) => a[0] - b[0]);
  const problems = [];
  instances.forEach(([i, set], idx) => {
    const cv = (tagsOf(set['arc-seal'] || '').cv || '').toLowerCase();
    if (i !== idx + 1) problems.push(`Instance numbering jumps at i=${i}.`);
    if (idx === 0 && cv && cv !== 'none') {
      problems.push(`The first seal has cv=${cv}; RFC 8617 requires cv=none at i=1.`);
    }
    if (idx > 0 && cv && cv !== 'pass') {
      problems.push(`Seal i=${i} has cv=${cv}, so the chain was already broken there.`);
    }
    const REQUIRED = {
      'arc-seal': 'ARC-Seal',
      'arc-message-signature': 'ARC-Message-Signature',
      'arc-authentication-results': 'ARC-Authentication-Results',
    };
    for (const [key, name] of Object.entries(REQUIRED)) {
      if (!set[key]) problems.push(`Instance i=${i} has no ${name} header.`);
    }
  });
  return { count: instances.length, instances, problems };
}

const addrDomain = (v) => {
  const m = String(v || '').match(/@\s*([A-Za-z0-9.-]+)/);
  return m ? m[1].toLowerCase().replace(/[>.,;\s]+$/, '') : null;
};

/* -------------------------------------------------------------- the facts */
export function extract(raw, opts = {}) {
  const h = unfold(raw);
  if (!h.length) {
    throw new Error('No headers found. Paste the block that starts with Received: or '
      + 'Delivered-To: and ends at the blank line before the message body.');
  }
  const from = pick(h, 'from')[0] || null;
  const fromDomain = addrDomain(from);

  // Received headers are prepended by each hop, so the raw list is newest first.
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

  return {
    headers: h,
    subject: pick(h, 'subject')[0] || null,
    from,
    fromDomain,
    to: pick(h, 'to')[0] || null,
    replyTo: pick(h, 'reply-to')[0] || null,
    date: parseDate(pick(h, 'date')[0]),
    messageId: pick(h, 'message-id')[0] || null,
    returnPath: pick(h, 'return-path')[0] || null,
    envelopeDomain: addrDomain(pick(h, 'return-path')[0]),
    listId: pick(h, 'list-id')[0] || null,
    listUnsubscribe: pick(h, 'list-unsubscribe')[0] || null,
    listUnsubscribePost: pick(h, 'list-unsubscribe-post')[0] || null,
    received,
    authResults: pick(h, 'authentication-results').map(parseAuthResults),
    receivedSpf: pick(h, 'received-spf'),
    dkimSigs: pick(h, 'dkim-signature').map(parseDkimSignature),
    arc: parseArc(h),
    boundary: opts.boundary || null,
  };
}

/* -------------------------------------------------------- the DMARC verdict */
/** The alignment arithmetic, shown as arithmetic.
 *
 *  Which domain authenticated, which domain is in From:, which alignment mode
 *  applies, and therefore what a receiver would have done at each policy level.
 *  LearnDMARC does this for a live test send of your own mail; nothing does it
 *  for an arbitrary pasted message. */
export function dmarcOutcome(f, opts = {}) {
  const adkim = String(opts.adkim || 'r').toLowerCase();
  const aspf = String(opts.aspf || 'r').toLowerCase();
  const fromDomain = f.fromDomain;
  const steps = [];
  let spfAligned = false;
  let dkimAligned = false;
  let undetermined = false;

  if (!fromDomain) {
    return { determinable: false, steps, spfAligned, dkimAligned, pass: false,
             reason: 'There is no From: header to align anything against.' };
  }

  const ar = f.authResults[0];
  // SPF authenticates the envelope sender, so it is the Return-Path domain that
  // has to align, not the one the recipient sees.
  const spfMethod = ar && ar.methods.find(m => m.method === 'spf');
  const spfDomain = (spfMethod && (domainOf(spfMethod.props['smtp.mailfrom'])
    || domainOf(spfMethod.props['smtp.helo']))) || f.envelopeDomain;

  if (spfMethod || f.receivedSpf.length) {
    const result = spfMethod
      ? spfMethod.result
      : ((f.receivedSpf[0].match(/^\s*(\w+)/) || [])[1] || 'unknown').toLowerCase();
    if (result === 'pass' && spfDomain) {
      const a = aligns(spfDomain, fromDomain, aspf);
      if (a === null) undetermined = true; else spfAligned = a;
      steps.push({
        mech: 'SPF', result, authDomain: spfDomain, fromDomain, mode: aspf, aligned: a,
        note: a === null
          ? 'the organisational domain could not be determined'
          : a
            ? `${organisational(spfDomain) || spfDomain} matches `
              + `${organisational(fromDomain) || fromDomain}`
            : `${spfDomain} does not align with ${fromDomain}`,
      });
    } else {
      steps.push({
        mech: 'SPF', result, authDomain: spfDomain, fromDomain, mode: aspf, aligned: false,
        note: 'SPF did not pass, so there is nothing to align',
      });
    }
  }

  for (const m of (ar ? ar.methods : []).filter(x => x.method === 'dkim')) {
    const d = String(m.props['header.d'] || m.props['header.i'] || '').replace(/^@/, '');
    if (m.result === 'pass' && d) {
      const a = aligns(d, fromDomain, adkim);
      if (a === null) undetermined = true; else if (a) dkimAligned = true;
      steps.push({
        mech: 'DKIM', result: m.result, authDomain: d, fromDomain, mode: adkim,
        aligned: a, selector: m.props['header.s'] || null,
        note: a === null
          ? 'the organisational domain could not be determined'
          : a ? `d=${d} aligns with ${fromDomain}` : `d=${d} does not align with ${fromDomain}`,
      });
    } else {
      steps.push({
        mech: 'DKIM', result: m.result, authDomain: d || null, fromDomain, mode: adkim,
        aligned: false, note: 'DKIM did not pass, so there is nothing to align',
      });
    }
  }

  const pass = spfAligned || dkimAligned;
  return {
    determinable: steps.length > 0,
    reason: steps.length ? '' : 'No Authentication-Results or Received-SPF header, so '
      + 'nothing here records what authentication actually did.',
    steps, spfAligned, dkimAligned, undetermined, pass,
    disposition: {
      none: pass ? 'delivered' : 'delivered anyway, because p=none takes no action',
      quarantine: pass ? 'delivered' : 'spam folder',
      reject: pass ? 'delivered' : 'refused at the door',
    },
  };
}

/* ------------------------------------------------------ forwarded or broken */
/** One of several verdicts, each with its evidence. Other tools dump the ARC
 *  headers and leave the inference to the reader, and that inference is what
 *  decides whether they go and "fix" something that is working correctly. */
export function classifyFailure(f, outcome) {
  if (!outcome.determinable) return { kind: 'unknown', evidence: [] };
  if (outcome.pass) return { kind: 'pass', evidence: [] };

  const evidence = [];
  const spfStep = outcome.steps.find(s => s.mech === 'SPF');
  const dkimPassed = outcome.steps.some(s => s.mech === 'DKIM' && s.result === 'pass');
  const spfFailed = Boolean(spfStep) && spfStep.result !== 'pass';

  if (f.arc.count) {
    evidence.push(`An ARC chain with ${f.arc.count} instance(s) is present, and only an `
      + 'intermediary adds one.');
  }
  if (f.listId) evidence.push('A List-Id header is present, so a list handled this.');
  if (f.received.length > 3) evidence.push(`${f.received.length} hops.`);
  if (f.envelopeDomain && f.fromDomain && f.envelopeDomain !== f.fromDomain) {
    evidence.push(`The envelope sender is ${f.envelopeDomain} while From: is `
      + `${f.fromDomain}, which is what a forwarder rewriting the envelope looks like.`);
  }

  // An intermediary rewrote the envelope, breaking SPF, and probably the body,
  // breaking the signature. Two independent signs of one are required, so a
  // plain SPF failure on a direct send is never excused as forwarding.
  if (spfFailed && evidence.length >= 2) return { kind: 'forwarded', evidence };
  if (dkimPassed && !outcome.dkimAligned) {
    return { kind: 'unaligned-signer', evidence: ['DKIM verified, but the signing domain '
      + 'is not the From: domain, so it does not satisfy DMARC on its own.'] };
  }
  if (!dkimPassed && f.dkimSigs.length) {
    return { kind: 'signature-broken', evidence: [`${f.dkimSigs.length} DKIM signature(s) `
      + 'present and none verified. Either something between signing and delivery altered '
      + 'the message, or the key is no longer published.'] };
  }
  return { kind: 'unauthenticated', evidence };
}

/* -------------------------------------------------------------- findings */
/* ------------------------------------------------------------------ platform

   Naming the sending platform changes what the rest of the report can say. An
   ESP signs with its own domain as well as yours, and that signature never
   aligns, which reads as a failure to anybody who does not already know it is
   normal. Saying "this is SendGrid's platform signature" turns a frightening
   red row into a fact. */
const PLATFORMS = [
  { name: 'SendGrid', ownDomains: ['sendgrid.info', 'sendgrid.net'],
    test: f => /sendgrid|smtpapi|\bSG\b|geopod-ismtpd/i.test(f.rawish) },
  { name: 'Mailchimp', ownDomains: ['mailchimpapp.net', 'rsgsv.net', 'mcsv.net'],
    test: f => /mailchimp|mcsv\.net|rsgsv\.net|\bmc\.us\d/i.test(f.rawish) },
  { name: 'Amazon SES', ownDomains: ['amazonses.com'],
    test: f => /amazonses\.com|\bSES\b/i.test(f.rawish) },
  { name: 'Mailgun', ownDomains: ['mailgun.org', 'mailgun.net'],
    test: f => /mailgun/i.test(f.rawish) },
  { name: 'Postmark', ownDomains: ['pm-bounces.net', 'postmarkapp.com'],
    test: f => /postmark/i.test(f.rawish) },
  { name: 'Klaviyo', ownDomains: ['klaviyomail.com'],
    test: f => /klaviyo/i.test(f.rawish) },
  { name: 'Braze', ownDomains: ['braze.com', 'sparkpostmail.com'],
    test: f => /braze|sparkpost/i.test(f.rawish) },
  { name: 'HubSpot', ownDomains: ['hubspotemail.net'],
    test: f => /hubspot/i.test(f.rawish) },
  { name: 'Salesforce Marketing Cloud', ownDomains: ['exacttarget.com', 'et.email'],
    test: f => /exacttarget|marketingcloud/i.test(f.rawish) },
  { name: 'Zoho', ownDomains: ['zoho.com', 'zohomail.com'],
    test: f => /zoho/i.test(f.rawish) },
];

/** Which platform sent this, and which domains are its own rather than yours. */
export function platformOf(f) {
  const rawish = f.headers.map(h => h[0] + ':' + h[1]).join('\n');
  const probe = { ...f, rawish };
  for (const p of PLATFORMS) {
    if (p.test(probe)) return { name: p.name, ownDomains: p.ownDomains };
  }
  return null;
}

/* The receiving server reports the policy it applied, in the comment beside its
   dmarc= result: "dmarc=pass (p=NONE sp=NONE dis=NONE)". That is the sending
   domain's own published policy as the receiver read it moments ago, which is
   better evidence than anything the sender remembers publishing. The method
   parser strips comments, so read it off the raw line. */
export function policyFromAR(ar) {
  if (!ar || !ar.raw) return null;
  const m = String(ar.raw).match(/dmarc\s*=\s*\w+\s*\(([^)]*)\)/i);
  if (!m) return null;
  const t = {};
  for (const kv of m[1].matchAll(/\b(p|sp|dis|adkim|aspf|pct)\s*=\s*([\w.]+)/gi)) {
    t[kv[1].toLowerCase()] = kv[2].toLowerCase();
  }
  return Object.keys(t).length ? t : null;
}

/** RFC 2047 encoded-words, decoded, so the reader sees the subject as sent. */
export function decodeWords(s) {
  if (!s) return s;
  return String(s).replace(/=\?([\w-]+)\?([BbQq])\?([^?]*)\?=/g, (all, cs, enc, txt) => {
    try {
      let bytes;
      if (enc.toUpperCase() === 'B') {
        const bin = atob(txt);
        bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
      } else {
        const fixed = txt.replace(/_/g, ' ')
          .replace(/=([0-9A-Fa-f]{2})/g, (x, h) => String.fromCharCode(parseInt(h, 16)));
        bytes = Uint8Array.from(fixed, c => c.charCodeAt(0));
      }
      return new TextDecoder(cs.toLowerCase()).decode(bytes);
    } catch { return all; }
  });
}

/* RFC 5322 section 3.6: these appear once, or not at all. More than one From is
   how a message shows a reader one sender while a filter reads another, and the
   two do not have to agree. */
const ONCE_ONLY = ['from', 'sender', 'reply-to', 'to', 'cc', 'bcc', 'message-id',
                   'in-reply-to', 'references', 'subject', 'date'];


export function findingsFor(f, opts = {}) {
  const out = [];
  const fromDomain = f.fromDomain;
  const now = opts.now || null;
  const outcome = dmarcOutcome(f, opts);
  const failure = classifyFailure(f, outcome);
  const ref = (url, label) => ({ url, label });

  // ---- the DMARC answer, which is why most people are here
  if (!outcome.determinable) {
    out.push(finding({
      severity: 'info', owner: 'unknown', scope: 'DMARC',
      title: 'No authentication results in this header block',
      detail: outcome.reason,
      fix: 'Paste the complete headers, including the Authentication-Results line the '
        + 'receiving server added. In Gmail that is "Show original".',
    }));
  } else if (outcome.pass) {
    out.push(finding({
      severity: 'ok', owner: 'you', scope: 'DMARC',
      title: 'This message passes DMARC',
      detail: [outcome.dkimAligned ? 'DKIM aligns' : '', outcome.spfAligned ? 'SPF aligns' : '']
        .filter(Boolean).join(' and ') + ' with the From: domain, so a receiver delivers '
        + 'it at any policy level.',
    }));
    const spfStep = outcome.steps.find(s => s.mech === 'SPF');
    if (spfStep && spfStep.result !== 'pass' && outcome.dkimAligned) {
      // Anyone reading headers for a message that passed is usually here because
      // SPF failed and they want to know whether it matters.
      out.push(finding({
        severity: 'info', owner: 'intermediary', scope: 'SPF',
        title: 'SPF failed, and it did not matter',
        detail: 'Aligned DKIM carried this message on its own, which is exactly what '
          + 'DKIM is for. SPF breaks whenever something forwards mail, because the '
          + 'forwarder becomes the envelope sender.',
        fix: 'Nothing to change. This is the mechanism working as designed.',
      }));
    }
  } else if (failure.kind === 'forwarded') {
    out.push(finding({
      severity: 'info', owner: 'intermediary', scope: 'DMARC',
      title: 'This failed DMARC because it was forwarded, not because you broke anything',
      detail: 'SPF broke in transit and the evidence points at a forwarder. '
        + failure.evidence.join(' '),
      fix: 'Nothing in your configuration caused this. Aligned DKIM is what carries mail '
        + 'through a forward, so the work here is DKIM, never SPF.',
    }));
  } else if (failure.kind === 'unaligned-signer') {
    const d = outcome.steps.find(s => s.mech === 'DKIM' && s.result === 'pass');
    out.push(finding({
      severity: 'critical', owner: 'you', scope: 'DMARC',
      title: `DKIM verifies but signs as ${d ? d.authDomain : 'another domain'}, so DMARC `
        + 'still fails',
      detail: 'A valid signature by the wrong domain does not satisfy DMARC. This is the '
        + 'most common misconfiguration when sending through a provider: the mail is '
        + 'signed by them rather than by you.',
      fix: `Set up DKIM signing with a key published on ${f.fromDomain}, usually by adding `
        + `the CNAME records your provider gives you. The signature has to say `
        + `d=${f.fromDomain}.`,
      evidence: d ? `d=${d.authDomain} against From: ${f.fromDomain}, adkim=${d.mode}` : '',
      ref: ref('/check/', 'Check what your domain publishes'),
    }));
  } else if (failure.kind === 'signature-broken') {
    out.push(finding({
      severity: 'critical', owner: 'you', scope: 'DKIM',
      title: 'A DKIM signature is present and did not verify',
      detail: failure.evidence.join(' '),
      fix: 'Check whether anything rewrites the message after signing: a footer appender, '
        + 'a disclaimer gateway, a list manager. Then confirm the key at the selector is '
        + 'still published.',
      ref: ref('/check/', 'Check whether the key is still published'),
    }));
  } else {
    out.push(finding({
      severity: 'critical', owner: 'you', scope: 'DMARC',
      title: 'This message authenticates as nothing',
      detail: 'Neither SPF nor DKIM aligned with the From: domain. A receiver at p=reject '
        + 'refuses it outright; at p=quarantine it lands in spam.',
      fix: `Publish SPF covering whatever sent this, and set up DKIM signing as `
        + `${f.fromDomain || 'your domain'}.`,
      ref: ref('/check/', 'Find out which of the two is missing'),
    }));
  }

  // ---- the trust boundary, which nothing else draws
  if (f.authResults.length > 1 && !f.boundary) {
    out.push(finding({
      severity: 'warn', owner: 'unknown', scope: 'Trust',
      title: `${f.authResults.length} Authentication-Results headers, and no way to tell `
        + 'which one to believe',
      detail: 'These headers are plain text. Anything upstream of your own mail server can '
        + 'write one, including the sender. Only the header your own inbound gateway added '
        + 'means anything, and a pasted block carries no proof of which that is.',
      fix: 'Enter your receiving domain above and the matching header gets marked. '
        + 'Everything below it should be read as a claim rather than a result.',
      evidence: f.authResults.map(a => a.authserv).filter(Boolean).join(', '),
    }));
  }
  if (f.boundary) {
    const at = f.authResults.findIndex(a =>
      a.authserv && a.authserv.toLowerCase() === String(f.boundary).toLowerCase());
    if (at > 0) {
      out.push(finding({
        severity: 'critical', owner: 'you', scope: 'Trust',
        title: `An Authentication-Results header claiming ${f.boundary} appears below your `
          + 'boundary',
        detail: 'RFC 8601 requires a receiver to strip inbound headers bearing its own '
          + 'authserv-id. One survived, which means either an upstream relay is not '
          + 'stripping them or the sender forged one.',
        fix: 'Configure your inbound gateway to delete Authentication-Results headers '
          + 'carrying its own authserv-id before it adds its own.',
      }));
    }
  }

  // ---- DKIM signature forensics.
  // Every "DKIM checker" on the market reads the DNS record, and l=, x=, a= and
  // h= are signature header tags, not record tags. A DNS checker structurally
  // cannot see them, and the header tools that can do not parse them.
  f.dkimSigs.forEach((t, i) => {
    const scope = `DKIM ${t.s ? 's=' + t.s : '#' + (i + 1)}`;
    if (t.l !== undefined) {
      out.push(finding({
        severity: 'critical', owner: 'you', scope,
        title: `The signature sets a body-length limit (l=${t.l})`,
        detail: `Only the first ${t.l} bytes of the body are signed. Anyone can append `
          + 'content below that point and the signature still verifies, so a DKIM pass '
          + 'stops meaning the message is intact. RFC 6376 has a section titled "Misuse '
          + 'of Body Length Limits".',
        fix: 'Remove the l= tag from your signing configuration. There is no case where a '
          + 'sender benefits from it.',
        evidence: `l=${t.l}`,
      }));
    }
    if (t.a && /sha1/i.test(t.a)) {
      out.push(finding({
        severity: 'warn', owner: 'you', scope,
        title: `Signed with ${t.a}`,
        detail: 'SHA-1 is deprecated for DKIM and several receivers now treat an rsa-sha1 '
          + 'signature as no signature at all.',
        fix: 'Reconfigure signing to rsa-sha256 and rotate the key.',
        evidence: `a=${t.a}`,
      }));
    }
    if (t.x && now) {
      const exp = Number(t.x) * 1000;
      if (Number.isFinite(exp) && exp > 0) {
        if (exp < now) {
          out.push(finding({
            severity: 'critical', owner: 'you', scope,
            title: 'The signature has already expired',
            detail: `x= is ${new Date(exp).toISOString().slice(0, 16).replace('T', ' ')} `
              + 'UTC, which has passed. Nothing can verify this signature now, including '
              + 'a receiver that accepted the message before it expired but evaluated it '
              + 'afterwards.',
            fix: 'Either stop setting x=, or set it far enough ahead that normal queueing '
              + 'and retry cannot outlive it. Days, not hours.',
            evidence: `x=${t.x}`,
          }));
        } else if (t.t && (exp - Number(t.t) * 1000) < 72 * 3600 * 1000) {
          out.push(finding({
            severity: 'warn', owner: 'you', scope,
            title: 'The signature expires less than 72 hours after signing',
            detail: 'A deferred message can sit in a queue for days. If it arrives after '
              + 'x= passes, DKIM fails on mail that was perfectly valid when sent.',
            fix: 'Widen the gap between t= and x=, or drop x= entirely.',
            evidence: `t=${t.t} x=${t.x}`,
          }));
        }
      }
    }
    if (t.h && !/(^|:)\s*from\s*(:|$)/i.test(t.h)) {
      out.push(finding({
        severity: 'critical', owner: 'you', scope,
        title: 'The signed header list does not cover From:',
        detail: 'RFC 6376 requires From: to be signed. A verifier following the spec treats '
          + 'this signature as invalid, and one that does not is verifying a message whose '
          + 'sender can be rewritten freely.',
        fix: 'Add from to the h= list in your signing configuration.',
        evidence: `h=${t.h}`,
      }));
    } else if (t.h && !/(^|:)\s*subject\s*(:|$)/i.test(t.h)) {
      out.push(finding({
        severity: 'warn', owner: 'you', scope,
        title: 'Subject is not covered by the signature',
        detail: 'An unsigned Subject can be rewritten in transit without breaking DKIM, '
          + 'which is enough for most phishing.',
        fix: 'Add subject to the h= list.',
        evidence: `h=${t.h}`,
      }));
    }
    if (t.p === '') {
      out.push(finding({
        severity: 'critical', owner: 'you', scope,
        title: 'The signature carries an empty public key',
        detail: 'An empty p= means the key has been revoked.',
        fix: 'Publish a real key at the selector, or stop signing with it.',
      }));
    }
  });

  // ---- TLS across the path.
  // A hop inside one provider's own estate is not an exposed leg. A platform
  // that accepts over its HTTP API and moves the message between its own nodes
  // shows several hops with no TLS marker, and calling those "in the clear"
  // reports a risk that is not there. Only a hop that crosses between
  // organisations is worth raising, and the one that matters most is the final
  // delivery to the recipient's server.
  const crossesOrgs = (r) => {
    const a = organisational(String(r.from || '').toLowerCase());
    const b = organisational(String(r.by || '').toLowerCase());
    return Boolean(a && b && a !== b);
  };
  const cleartext = f.received.filter(r => r.proto && r.tls === false && crossesOrgs(r));
  const internal = f.received.filter(r => r.proto && r.tls === false && !crossesOrgs(r));
  if (cleartext.length) {
    out.push(finding({
      severity: 'warn', owner: 'intermediary', scope: 'TLS',
      title: `${cleartext.length} hop(s) between organisations carried this without TLS`,
      detail: 'At least one leg between separate estates was in the clear, so the '
        + 'contents were readable by anything on the path for that leg.',
      fix: 'You cannot force a third party to use TLS, but MTA-STS stops a downgrade on '
        + 'mail coming to you and TLS-RPT tells you when one is attempted.',
      evidence: cleartext.map(r => `${r.from || '?'} to ${r.by || '?'} (${r.proto})`).join(', '),
      ref: ref('/check/', 'Check whether your domain publishes MTA-STS'),
    }));
  }
  if (internal.length && !cleartext.length) {
    out.push(finding({
      severity: 'ok', owner: 'intermediary', scope: 'TLS',
      title: 'Every hop that left the sending platform used TLS',
      detail: `${internal.length} hop(s) inside the platform's own estate show no TLS `
        + 'marker, which is normal: an API submission and the moves between its own '
        + 'nodes do not cross a network anybody else is on. The legs that did cross '
        + 'were encrypted.',
      evidence: internal.map(r => r.by || '?').slice(0, 3).join(', '),
    }));
  }
  const plainAuth = f.received.filter(r => r.authenticated && r.tls === false);
  if (plainAuth.length) {
    out.push(finding({
      severity: 'critical', owner: 'intermediary', scope: 'TLS',
      title: 'A hop authenticated over an unencrypted connection',
      detail: 'ESMTPA without TLS means SMTP AUTH credentials crossed the network in the '
        + 'clear, and they are reusable.',
      fix: 'If this hop is yours, require STARTTLS on the submission port and disable '
        + 'plaintext authentication.',
      evidence: plainAuth.map(r => `${r.by || '?'} (${r.proto})`).join(', '),
    }));
  }

  // ---- the ARC chain
  for (const p of f.arc.problems) {
    out.push(finding({
      severity: 'warn', owner: 'intermediary', scope: 'ARC',
      title: 'The ARC chain is not structurally intact',
      detail: p,
      fix: 'Nothing you can change from the sending side. A receiver that trusts ARC will '
        + 'ignore a broken chain and fall back to the DMARC result.',
    }));
  }

  // ---- bulk sending hygiene, which the headers do show
  if (f.listUnsubscribe && !f.listUnsubscribePost) {
    out.push(finding({
      severity: 'warn', owner: 'you', scope: 'Bulk',
      title: 'List-Unsubscribe is present but not one-click',
      detail: 'Gmail and Yahoo require one-click unsubscribe for senders above 5,000 '
        + 'messages a day, and that needs List-Unsubscribe-Post alongside an https URL.',
      fix: 'Add List-Unsubscribe-Post: List-Unsubscribe=One-Click, and make sure '
        + 'List-Unsubscribe carries an https URL that accepts a POST.',
      evidence: f.listUnsubscribe.slice(0, 120),
    }));
  }

  // ---- what the receiver says the sending domain's policy actually is.
  // The comment beside dmarc= carries the policy as the receiver read it, which
  // beats asking the sender what they think they published.
  const arPolicy = policyFromAR(f.authResults[0]);
  const plat = platformOf(f);

  if (arPolicy && arPolicy.p === 'none') {
    out.push(finding({
      severity: 'warn', owner: 'you', scope: 'DMARC',
      title: 'The sending domain publishes DMARC but enforces nothing',
      detail: `The receiver applied p=none${arPolicy.sp ? ' and sp=' + arPolicy.sp : ''}, `
        + 'which means it was asked to take no action whatever authentication said. '
        + 'Anyone can send as this domain today and it will still be delivered. '
        + (outcome.pass
           ? 'This message authenticates correctly, so the work is already done and '
             + 'only the policy is missing.'
           : 'Fix the authentication first, then move the policy.'),
      fix: outcome.pass
        ? `Move to enforcement in two steps. First p=quarantine with pct=, raising it `
          + `over a few weeks while reading the aggregate reports, then p=reject. `
          + `A record to start from: v=DMARC1; p=quarantine; pct=25; `
          + `rua=mailto:dmarc@${fromDomain}; fo=1`
        : 'Get an aligned SPF or DKIM pass first. Enforcing now would reject your own mail.',
      evidence: `_dmarc.${fromDomain}  p=${arPolicy.p}`
        + (arPolicy.sp ? ` sp=${arPolicy.sp}` : ''),
      ref: ref('/rfc/9989/', 'RFC 9989, DMARC'),
    }));
  }

  // ---- would it survive strict alignment? Nothing else answers this, and it is
  // the question that decides whether tightening the policy is safe.
  if (outcome.determinable && outcome.pass) {
    const strictSurvivors = outcome.steps.filter(s =>
      s.result === 'pass' && s.authDomain && s.authDomain === fromDomain);
    const relaxedOnly = outcome.steps.filter(s =>
      s.aligned && s.authDomain && s.authDomain !== fromDomain);
    if (!strictSurvivors.length && relaxedOnly.length) {
      out.push(finding({
        severity: 'info', owner: 'you', scope: 'DMARC',
        title: 'This passes under relaxed alignment only',
        detail: 'Every mechanism that aligns does so through a subdomain, not through '
          + `${fromDomain} exactly. Relaxed alignment is the default and is fine, but `
          + 'setting adkim=s or aspf=s would make this message fail DMARC outright.',
        fix: 'Leave alignment relaxed. If strict alignment is a requirement, sign with '
          + `d=${fromDomain} and use a bounce domain that is ${fromDomain} itself.`,
        evidence: relaxedOnly.map(s => `${s.mech}: ${s.authDomain}`).join(', ')
          + ` vs From: ${fromDomain}`,
      }));
    }
  }

  // ---- a platform signature that does not align is not a fault
  if (plat) {
    const theirs = outcome.steps.filter(s => s.mech === 'DKIM' && !s.aligned
      && s.authDomain && plat.ownDomains.some(d => s.authDomain === d
        || s.authDomain.endsWith('.' + d)));
    if (theirs.length && outcome.dkimAligned) {
      out.push(finding({
        severity: 'ok', owner: 'you', scope: 'DKIM',
        title: `The second signature is ${plat.name}'s own, and is meant not to align`,
        detail: `${plat.name} signs every message it sends with its own domain as well `
          + 'as yours. That signature is not supposed to match your From: domain and '
          + 'costs you nothing, because DMARC needs only one aligned pass and yours '
          + 'already provides it.',
        evidence: theirs.map(s => `d=${s.authDomain}`).join(', ')
          + ' (platform), alongside your aligned signature',
      }));
    }
  }

  // ---- the bounce domain, which is what decides whether SPF can ever align
  if (f.envelopeDomain && fromDomain) {
    const org = organisational(f.envelopeDomain);
    const fromOrg = organisational(fromDomain);
    if (org === fromOrg && f.envelopeDomain !== fromDomain) {
      out.push(finding({
        severity: 'ok', owner: 'you', scope: 'SPF',
        title: 'The bounce domain is under your own domain',
        detail: 'The Return-Path is a subdomain of the From: domain, which is what lets '
          + 'SPF align. Senders who leave the platform default here get an SPF pass that '
          + 'never aligns, and then depend entirely on DKIM.',
        evidence: `Return-Path: ${f.envelopeDomain}`,
      }));
    } else if (plat && org !== fromOrg) {
      out.push(finding({
        severity: 'warn', owner: 'you', scope: 'SPF',
        title: 'The bounce domain belongs to the platform, not to you',
        detail: `SPF authenticates ${f.envelopeDomain}, which is ${plat.name}'s domain `
          + `rather than yours, so an SPF pass can never align with ${fromDomain}. `
          + 'DMARC is carried by DKIM alone, and it fails the moment a signature breaks.',
        fix: `Configure a custom bounce domain under ${fromDomain}, usually a CNAME the `
          + 'platform gives you, so the Return-Path is yours.',
        evidence: `Return-Path: ${f.envelopeDomain}`,
      }));
    }
  }

  // ---- VERP, worth naming because it is what makes a bounce attributable
  if (f.returnPath && /[+=]/.test(f.returnPath.split('@')[0] || '')) {
    out.push(finding({
      severity: 'ok', owner: 'you', scope: 'Bounce',
      title: 'The return path is per-recipient',
      detail: 'The bounce address encodes the recipient, so a bounce arriving later can '
        + 'be attributed to the exact message and address without parsing the body. '
        + 'This is what makes automated suppression reliable.',
      evidence: f.returnPath.slice(0, 90),
    }));
  }

  // ---- duplicate headers that RFC 5322 says appear once. This is a spoofing
  // technique: a reader shows one, a filter reads the other.
  {
    const seen = {};
    for (const [k] of f.headers) {
      const key = k.toLowerCase();
      if (ONCE_ONLY.includes(key)) seen[key] = (seen[key] || 0) + 1;
    }
    const dup = Object.entries(seen).filter(([, n]) => n > 1);
    for (const [name, count] of dup) {
      out.push(finding({
        severity: name === 'from' ? 'critical' : 'warn',
        owner: 'unknown', scope: 'Structure',
        title: `${count} ${name.replace(/^./, c => c.toUpperCase())} headers`,
        detail: 'RFC 5322 section 3.6 allows this field at most once. Clients and '
          + 'filters disagree about which copy wins, and a duplicated From: is how a '
          + 'message shows the reader one sender while authentication reads another.',
        fix: 'Treat this message as suspect and find which hop added the second copy.',
        ref: ref('/rfc/5322/', 'RFC 5322, message format'),
      }));
    }
  }

  // ---- the Message-ID, which filters do look at
  if (f.messageId) {
    const rhs = (f.messageId.replace(/^<|>$/g, '').split('@')[1] || '');
    if (rhs && !rhs.includes('.')) {
      out.push(finding({
        severity: 'info', owner: 'you', scope: 'Hygiene',
        title: 'The Message-ID is not anchored to a domain',
        detail: 'The right hand side is an internal hostname rather than a domain name. '
          + 'RFC 5322 asks for a globally unique identifier, and several filters treat a '
          + 'non-domain right hand side as a weak signal.',
        fix: `Generate Message-IDs ending in @${fromDomain}.`,
        evidence: f.messageId.slice(0, 80),
      }));
    }
  }

  // ---- body shape, from the headers alone
  {
    const ct = (f.headers.find(h => h[0].toLowerCase() === 'content-type') || [])[1] || '';
    if (/^\s*text\/html/i.test(ct)) {
      out.push(finding({
        severity: 'warn', owner: 'you', scope: 'Content',
        title: 'HTML only, with no plain text alternative',
        detail: 'The top level content type is text/html rather than '
          + 'multipart/alternative, so this message carries no text part. Filters read '
          + 'the text part, some clients prefer it, and its absence is a long standing '
          + 'signal of bulk mail assembled without care.',
        fix: 'Send multipart/alternative with a real text/plain part. A generated one '
          + 'that just strips tags is better than none, but a written one is better still.',
        evidence: `Content-Type: ${ct.slice(0, 70)}`,
      }));
    }
  }

  // ---- timing, stated honestly
  const unknownTz = f.received.filter(r => r.date.ts && !r.date.offsetKnown).length;
  if (unknownTz) {
    out.push(finding({
      severity: 'info', owner: 'unknown', scope: 'Timing',
      title: `${unknownTz} timestamp(s) carry no usable timezone`,
      detail: 'RFC 5322 defines -0000 and the obsolete alphabetic zones as "offset '
        + 'unknown". Delays across those hops are left blank, because a number computed '
        + 'from them would be invented.',
    }));
  }
  const skew = f.received.filter(r => r.delayKnown && r.delaySec < 0).length;
  if (skew) {
    out.push(finding({
      severity: 'info', owner: 'unknown', scope: 'Timing',
      title: `${skew} hop(s) show time running backwards`,
      detail: 'Each server stamps its own clock and those clocks are not synchronised. A '
        + 'negative gap is skew between two machines, not a delay.',
    }));
  }
  const slow = f.received.filter(r => r.delayKnown && r.delaySec > 600)
    .sort((a, b) => b.delaySec - a.delaySec);
  if (slow.length) {
    out.push(finding({
      severity: 'warn', owner: 'intermediary', scope: 'Timing',
      title: `A hop took ${Math.round(slow[0].delaySec / 60)} minutes`,
      detail: `The message waited before ${slow[0].by || 'the next hop'} accepted it, which `
        + 'usually means it was deferred and retried. Subject to clock skew between the '
        + 'two machines.',
      fix: 'Repeated deferrals at one provider are a reputation signal rather than a '
        + 'network problem. The response the sending server logged will say which.',
      ref: ref('/smtp/', 'Look up the response it logged'),
    }));
  }

  return { findings: out, outcome, failure };
}

/** Everything in one call. `now` is injected so results are deterministic. */
export function analyse(raw, opts = {}) {
  const f = extract(raw, opts);
  const { findings, outcome, failure } = findingsFor(f, opts);
  return { ...f, findings, outcome, failure };
}
