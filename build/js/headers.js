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
    for (const req of ['arc-seal', 'arc-message-signature', 'arc-authentication-results']) {
      if (!set[req]) {
        problems.push(`Instance i=${i} has no ${req.replace(/^arc-/, 'ARC-')} header.`);
      }
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
  const spfDomain = (spfMethod && (spfMethod.props['smtp.mailfrom']
    || spfMethod.props['smtp.helo'])) || f.envelopeDomain;

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

  // DKIM surviving while SPF broke, plus a sign of an intermediary, is the
  // signature of forwarding rather than of a misconfiguration.
  if (dkimPassed && spfFailed && evidence.length) return { kind: 'forwarded', evidence };
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
export function findingsFor(f, opts = {}) {
  const out = [];
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

  // ---- TLS across the path
  const cleartext = f.received.filter(r => r.proto && r.tls === false);
  if (cleartext.length) {
    out.push(finding({
      severity: 'warn', owner: 'intermediary', scope: 'TLS',
      title: `${cleartext.length} hop(s) carried this message without TLS`,
      detail: 'At least one leg of the journey was in the clear, so the contents were '
        + 'readable by anything on the path for that leg.',
      fix: 'You cannot force a third party to use TLS, but MTA-STS stops a downgrade on '
        + 'mail coming to you and TLS-RPT tells you when one is attempted.',
      evidence: cleartext.map(r => `${r.by || '?'} (${r.proto})`).join(', '),
      ref: ref('/check/', 'Check whether your domain publishes MTA-STS'),
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
