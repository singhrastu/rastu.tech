/* DMARC aggregate (rua) report parsing and analysis. Pure: no DOM, no network.
 *
 * The distinction this tool exists to make:
 *
 *   auth_results/{spf,dkim}/result  is the RAW authentication result
 *   policy_evaluated/{spf,dkim}     is the ALIGNED DMARC result
 *
 * They are routinely different and conflating them is the most common way a DMARC
 * report gets misread. A source can show auth_results/spf/result = pass while
 * policy_evaluated/spf = fail: SPF authenticated correctly, but the MAIL FROM
 * domain does not align with the From: header domain. "SPF is broken" and "SPF
 * passes but does not align" need completely different fixes.
 *
 * So alignment is computed here from auth_results + identifiers/header_from +
 * policy_published/{adkim,aspf}, and compared against what the reporter claimed.
 * When they disagree the report says so, because some reporters populate
 * policy_evaluated incorrectly.
 */

/* Multi-label public suffixes, for relaxed alignment. Deliberately NOT the full
   Public Suffix List: ten thousand lines that go stale is worse than a short list
   plus an honest "could not determine" for anything outside it. */
const MULTI_SUFFIX = new Set([
  'co.uk', 'org.uk', 'me.uk', 'ltd.uk', 'plc.uk', 'net.uk', 'sch.uk', 'ac.uk', 'gov.uk',
  'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au', 'id.au', 'asn.au',
  'co.nz', 'net.nz', 'org.nz', 'govt.nz', 'ac.nz', 'school.nz',
  'com.br', 'net.br', 'org.br', 'gov.br', 'edu.br',
  'co.jp', 'or.jp', 'ne.jp', 'ac.jp', 'go.jp', 'lg.jp',
  'com.cn', 'net.cn', 'org.cn', 'gov.cn', 'edu.cn', 'ac.cn',
  'co.in', 'net.in', 'org.in', 'gov.in', 'edu.in', 'ac.in', 'res.in', 'firm.in', 'gen.in',
  'co.za', 'net.za', 'org.za', 'gov.za', 'ac.za', 'web.za',
  'com.mx', 'org.mx', 'net.mx', 'gob.mx', 'edu.mx',
  'com.ar', 'net.ar', 'org.ar', 'gob.ar', 'edu.ar',
  'com.tr', 'net.tr', 'org.tr', 'gov.tr', 'edu.tr',
  'com.sg', 'net.sg', 'org.sg', 'gov.sg', 'edu.sg',
  'com.hk', 'net.hk', 'org.hk', 'gov.hk', 'edu.hk',
  'com.tw', 'net.tw', 'org.tw', 'gov.tw', 'edu.tw',
  'com.my', 'net.my', 'org.my', 'gov.my', 'edu.my',
  'co.kr', 'or.kr', 'ne.kr', 'go.kr', 'ac.kr',
  'co.il', 'net.il', 'org.il', 'gov.il', 'ac.il',
  'co.th', 'in.th', 'or.th', 'go.th', 'ac.th',
  'com.ua', 'net.ua', 'org.ua', 'gov.ua', 'edu.ua',
  'com.pl', 'net.pl', 'org.pl', 'gov.pl', 'edu.pl',
  'co.id', 'net.id', 'or.id', 'go.id', 'ac.id', 'web.id',
  'com.ph', 'net.ph', 'org.ph', 'gov.ph', 'edu.ph',
  'com.vn', 'net.vn', 'org.vn', 'gov.vn', 'edu.vn',
  'com.pk', 'net.pk', 'org.pk', 'gov.pk', 'edu.pk',
  'com.ng', 'net.ng', 'org.ng', 'gov.ng', 'edu.ng',
  'com.eg', 'net.eg', 'org.eg', 'gov.eg', 'edu.eg',
  'com.sa', 'net.sa', 'org.sa', 'gov.sa', 'edu.sa',
  'co.ke', 'or.ke', 'ne.ke', 'go.ke', 'ac.ke',
  'com.co', 'net.co', 'org.co', 'gov.co', 'edu.co',
  'com.pe', 'com.ve', 'com.ec', 'com.uy', 'com.py', 'com.bo',
  'com.cy', 'com.mt', 'com.gr', 'com.pt', 'com.es', 'com.ru', 'net.ru', 'org.ru',
]);

/** The registrable domain, or null when the suffix is outside the shipped table
 *  and guessing would be dishonest. */
export function organisational(domain) {
  if (!domain) return null;
  const parts = domain.toLowerCase().replace(/\.+$/, '').split('.');
  if (parts.length < 2) return null;
  const last2 = parts.slice(-2).join('.');
  if (MULTI_SUFFIX.has(last2)) {
    // The name is a public suffix itself, so there is no organisation under it.
    return parts.length >= 3 ? parts.slice(-3).join('.') : null;
  }
  // Otherwise last-two-labels, which is right for every single-label TLD and is
  // the documented limit of this tool: a multi-label suffix outside the table
  // above will be treated as registrable. The table covers the common ones.
  return last2;
}

/** DMARC alignment. mode 'r' is relaxed (organisational domain), 's' is strict
 *  (exact). Returns true, false, or null when it could not be determined. */
export function aligns(authDomain, fromDomain, mode) {
  if (!authDomain || !fromDomain) return false;
  const a = authDomain.toLowerCase().replace(/\.+$/, '');
  const f = fromDomain.toLowerCase().replace(/\.+$/, '');
  if (mode === 's') return a === f;
  if (a === f) return true;
  const oa = organisational(a), of = organisational(f);
  if (!oa || !of) return null;          // unknown public suffix: say so, do not guess
  return oa === of;
}

const text = (el) => (el && el.textContent ? el.textContent.trim() : '');

function kids(el, name) {
  if (!el) return [];
  // Reporters emit xmlns and xsi attributes inconsistently, and the schema declares
  // no target namespace, so match on localName rather than a namespaced lookup.
  return [...el.children].filter(c => c.localName === name);
}
const kid = (el, name) => kids(el, name)[0] || null;

/** Parse one aggregate report document. Throws on anything it cannot trust.
 *
 *  `Parser` is injectable for the same reason the resolver is elsewhere here: the
 *  parity harness runs this file in node, which has no DOMParser, and testing the
 *  parse path is the whole point of the harness. Browsers pass nothing and get the
 *  real one. */
export function parseReport(xmlText, Parser) {
  const P = Parser || (typeof DOMParser !== 'undefined' ? DOMParser : null);
  if (!P) throw new Error('No XML parser available in this environment.');
  const doc = new P().parseFromString(xmlText, 'application/xml');
  // DOMParser does not throw on malformed XML; it returns a document containing a
  // parsererror element. Without this check a broken file renders as "0 records".
  if (doc.getElementsByTagName('parsererror').length) {
    throw new Error('This file is not valid XML. If it came out of a mail client, '
      + 'check the attachment downloaded completely.');
  }
  const root = doc.documentElement;
  if (!root || root.localName !== 'feedback') {
    throw new Error('This is XML, but not a DMARC aggregate report: the root element '
      + `is <${root ? root.localName : '?'}> rather than <feedback>.`);
  }

  const meta = kid(root, 'report_metadata');
  const pub = kid(root, 'policy_published');
  const range = kid(meta, 'date_range');

  const report = {
    org: text(kid(meta, 'org_name')),
    email: text(kid(meta, 'email')),
    id: text(kid(meta, 'report_id')),
    begin: Number(text(kid(range, 'begin'))) || null,
    end: Number(text(kid(range, 'end'))) || null,
    policy: {
      domain: text(kid(pub, 'domain')),
      p: text(kid(pub, 'p')).toLowerCase() || null,
      sp: text(kid(pub, 'sp')).toLowerCase() || null,
      pct: text(kid(pub, 'pct')) || '100',
      adkim: (text(kid(pub, 'adkim')) || 'r').toLowerCase(),
      aspf: (text(kid(pub, 'aspf')) || 'r').toLowerCase(),
    },
    rows: [],
  };

  for (const rec of kids(root, 'record')) {
    const row = kid(rec, 'row');
    const pe = kid(row, 'policy_evaluated');
    const ids = kid(rec, 'identifiers');
    const auth = kid(rec, 'auth_results');
    const headerFrom = text(kid(ids, 'header_from')).toLowerCase();

    const dkimResults = kids(auth, 'dkim').map(d => ({
      domain: text(kid(d, 'domain')).toLowerCase(),
      selector: text(kid(d, 'selector')),
      result: text(kid(d, 'result')).toLowerCase(),
    }));
    const spfResults = kids(auth, 'spf').map(sp => ({
      domain: text(kid(sp, 'domain')).toLowerCase(),
      scope: text(kid(sp, 'scope')).toLowerCase(),
      result: text(kid(sp, 'result')).toLowerCase(),
    }));

    // Computed here rather than trusted from the reporter, then compared below.
    const dkimOk = dkimResults.filter(d => d.result === 'pass');
    const spfOk = spfResults.filter(sp => sp.result === 'pass');
    let dkimAligned = false, spfAligned = false, undetermined = false;
    for (const d of dkimOk) {
      const a = aligns(d.domain, headerFrom, report.policy.adkim);
      if (a === null) undetermined = true; else if (a) dkimAligned = true;
    }
    for (const sp of spfOk) {
      const a = aligns(sp.domain, headerFrom, report.policy.aspf);
      if (a === null) undetermined = true; else if (a) spfAligned = true;
    }

    report.rows.push({
      ip: text(kid(row, 'source_ip')),
      count: (() => {
        const raw = text(kid(row, 'count'));
        const n = Number(raw);
        if (raw === '' || !Number.isFinite(n) || n < 0) {
          throw new Error('A record in this report has a missing or unreadable '
            + '<count>, so any total computed from it would be wrong.');
        }
        return n;
      })(),
      headerFrom,
      envelopeFrom: text(kid(ids, 'envelope_from')).toLowerCase(),
      disposition: text(kid(pe, 'disposition')).toLowerCase() || 'none',
      reported: {
        dkim: text(kid(pe, 'dkim')).toLowerCase(),
        spf: text(kid(pe, 'spf')).toLowerCase(),
      },
      reasons: kids(pe, 'reason').map(r => ({
        type: text(kid(r, 'type')).toLowerCase(),
        comment: text(kid(r, 'comment')),
      })),
      dkimResults,
      spfResults,
      computed: { dkim: dkimAligned, spf: spfAligned, undetermined },
    });
  }
  return report;
}

/* Five states, phrased to stay inside what an aggregate report can support.
   "Spoofing" is deliberately absent: a report cannot tell a spoofer from a
   forgotten vendor, and saying otherwise sends people to block their own
   invoicing system. */
export const VERDICT = {
  both: ['ok', 'Aligned', 'SPF and DKIM both align. Nothing to do.'],
  dkim: ['ok', 'DKIM aligned', 'Survives forwarding, which is what matters. Fine.'],
  spf: ['warn', 'SPF only', 'Passes today and fails the moment mail is forwarded. '
      + 'Get DKIM signing and aligning for this source.'],
  forward: ['info', 'Forwarded', 'SPF broke in transit and DKIM carried it, or the '
      + 'receiver said so outright. Expected, not a problem.'],
  none: ['fail', 'Unauthenticated', 'Neither SPF nor DKIM aligned. Either this source '
      + 'needs configuring, or it is not yours. Identify it before changing policy.'],
  unknown: ['info', 'Undetermined', 'Alignment could not be determined: the domain uses '
      + 'a public suffix outside the table shipped with this tool.'],
};

/* The policy override reasons, now defined in RFC 9990 where RFC 7489 used to
   carry them, split into two groups that mean opposite
   things, and conflating them is how an unauthenticated source gets presented as
   fine. Only these three say "a forwarder broke SPF and that is expected": */
const FORWARDING = ['forwarded', 'mailing_list', 'trusted_forwarder'];
/* These say "the receiver decided not to apply your policy", for reasons of its
   own. They are not evidence that anything is working. */
const OVERRIDE = ['local_policy', 'sampled_out', 'other', 'arc'];

function verdictFor(row) {
  const forwarded = row.reasons.some(r => FORWARDING.includes(r.type));
  if (row.computed.dkim && row.computed.spf) return 'both';
  if (row.computed.dkim) return forwarded ? 'forward' : 'dkim';
  if (row.computed.spf) return 'spf';
  if (row.computed.undetermined) return 'unknown';
  return forwarded ? 'forward' : 'none';
}

/** Collapse rows to one per (source ip, header_from), which is the unit a person
 *  acts on. Sorted by failing volume, not total volume: the biggest sender is
 *  rarely the problem, the biggest failing sender always is. */
export function aggregate(reports) {
  const policy = reports[0] ? reports[0].policy : null;
  const by = new Map();
  let total = 0, failing = 0, aligned = 0, disagreements = 0, overridden = 0;

  for (const rep of reports) {
    for (const row of rep.rows) {
      total += row.count;
      const v = verdictFor(row);
      // DMARC passes if SPF aligns OR DKIM aligns. Anything else fails it,
      // whatever the reason. aligned + failing must equal total, or the headline
      // is a number with an unexplained remainder.
      const passes = row.computed.dkim || row.computed.spf;
      if (passes) aligned += row.count; else failing += row.count;

      // Where the reporter's own policy_evaluated disagrees with what the auth
      // results it published alongside actually support. Compared per mechanism:
      // collapsing both sides to one boolean hides the case where the reporter
      // and the evidence disagree about both, in opposite directions.
      if (!row.computed.undetermined) {
        const dkimSaid = row.reported.dkim === 'pass';
        const spfSaid = row.reported.spf === 'pass';
        if (dkimSaid !== row.computed.dkim || spfSaid !== row.computed.spf) {
          disagreements += row.count;
        }
      }

      const key = row.ip + '|' + row.headerFrom;
      let g = by.get(key);
      if (!g) {
        g = { ip: row.ip, headerFrom: row.headerFrom, count: 0, verdict: v,
              dispositions: new Set(), selectors: new Set(), spfDomains: new Set(),
              dkimDomains: new Set(), reasons: new Set(), rows: [], orgs: new Set() };
        by.set(key, g);
      }
      g.count += row.count;
      g.rows.push(row);
      g.orgs.add(rep.org);
      g.dispositions.add(row.disposition);
      row.dkimResults.forEach(d => {
        if (d.selector) g.selectors.add(d.selector);
        if (d.domain) g.dkimDomains.add(`${d.domain} (${d.result})`);
      });
      row.spfResults.forEach(sp => {
        if (sp.domain) g.spfDomains.add(`${sp.domain} (${sp.result})`);
      });
      row.reasons.forEach(r => r.type && g.reasons.add(r.type));
      if (row.reasons.some(r => OVERRIDE.includes(r.type))) overridden += row.count;
      // The worst verdict across the group wins, so a mostly-fine source with a
      // failing tail does not read as clean.
      const rank = { none: 0, spf: 1, unknown: 2, forward: 3, dkim: 4, both: 5 };
      if (rank[v] < rank[g.verdict]) g.verdict = v;
    }
  }

  const sources = [...by.values()].sort((a, b) => {
    const fa = a.verdict === 'none' ? 1 : 0, fb = b.verdict === 'none' ? 1 : 0;
    return (fb - fa) || (b.count - a.count);
  });

  return {
    policy,
    reporters: [...new Set(reports.map(r => r.org).filter(Boolean))],
    window: {
      begin: Math.min(...reports.map(r => r.begin || Infinity)),
      end: Math.max(...reports.map(r => r.end || 0)),
    },
    totals: { total, failing, aligned, disagreements, overridden,
              sources: sources.length },
    sources,
  };
}

// ---------------------------------------------------------------------------
// From here down: turning an aggregate report into a list of things to do.
//
// A table of sources is data. The question a reader actually arrived with is
// "what is broken and what do I change", and for DMARC the question underneath
// that is almost always "can I move to p=reject without breaking my own mail".
// ---------------------------------------------------------------------------

import { finding } from './findings.js';

/** What moving to p=reject would do, from this report's own evidence.
 *
 *  Precise about a thing most write-ups blur: at p=reject a receiver is
 *  *entitled* to reject everything that fails DMARC, forwarded or not. Many
 *  apply a local override for forwarders they recognise, which is why the
 *  report marks some rows as forwarded. So the honest answer is a range, not a
 *  number, and both ends are given. */
export function simulateReject(agg) {
  let failing = 0, failingForwarded = 0;
  const bySource = [];
  for (const s of agg.sources) {
    if (s.verdict !== 'none' && s.verdict !== 'forward') continue;
    const forwarded = s.verdict === 'forward';
    // A forwarded row that kept DKIM alignment still passes DMARC; only the
    // ones that align on nothing are at risk.
    const atRisk = s.rows.reduce((n, r) =>
      n + ((r.computed.dkim || r.computed.spf) ? 0 : r.count), 0);
    if (!atRisk) continue;
    failing += atRisk;
    if (forwarded) failingForwarded += atRisk;
    bySource.push({ ...s, atRisk, forwarded });
  }
  bySource.sort((a, b) => b.atRisk - a.atRisk);
  const total = agg.totals.total || 1;
  return {
    total: agg.totals.total,
    certain: failing - failingForwarded,   // no plausible override
    possible: failing,                     // if no receiver overrides at all
    forwarded: failingForwarded,
    pctCertain: Math.round(1000 * (failing - failingForwarded) / total) / 10,
    pctPossible: Math.round(1000 * failing / total) / 10,
    sources: bySource,
    alreadyEnforcing: agg.policy && agg.policy.p === 'reject',
  };
}

const plural = (n, w) => `${n.toLocaleString()} ${w}${n === 1 ? '' : 's'}`;

/** Ranked, owned findings for a parsed report set.
 *
 *  `known` is a Set of "ip|header_from" keys the user has previously marked as
 *  theirs. It lives in the browser and never leaves it; its only job is to make
 *  next month's report show what changed rather than the whole list again. */
export function findingsFor(agg, opts = {}) {
  const out = [];
  const pol = agg.policy || {};
  const known = opts.known || new Set();
  const sim = simulateReject(agg);
  const ref = { url: '/research/', label: 'How common this is, across 100,000 domains' };

  // ---- the published policy itself
  if (pol.p === 'none') {
    out.push(finding({
      severity: 'warn', owner: 'you', scope: 'Policy',
      title: 'Your policy is p=none, so nothing is being blocked',
      detail: 'You are collecting reports, which is the right first step, but a '
        + 'receiver reading p=none takes no action on mail that fails. Nobody is '
        + 'protected yet.',
      fix: sim.certain === 0
        ? 'Nothing in this report would break at p=reject. You can move straight to '
          + 'quarantine, and then to reject.'
        : `Fix the ${plural(sim.sources.length, 'source')} below first, then move to `
          + 'p=quarantine with pct ramping up, then to p=reject.',
      evidence: `p=none; adkim=${pol.adkim}; aspf=${pol.aspf}`,
      ref,
    }));
  } else if (pol.p === 'quarantine') {
    out.push(finding({
      severity: 'info', owner: 'you', scope: 'Policy',
      title: 'Your policy is p=quarantine, which is partial protection',
      detail: 'Spoofed mail lands in spam rather than being refused, so it still '
        + 'reaches the recipient and can still be opened.',
      fix: sim.certain === 0
        ? 'Nothing in this report would break at p=reject. Move to it.'
        : 'Resolve the failing sources below, then move to p=reject.',
    }));
  }

  if (pol.sp === 'none' && (pol.p === 'quarantine' || pol.p === 'reject')) {
    out.push(finding({
      severity: 'critical', owner: 'you', scope: 'Policy',
      title: `Subdomains are unprotected (sp=none while p=${pol.p})`,
      detail: 'Your main domain enforces and every subdomain of it does not. An '
        + 'attacker simply spoofs a subdomain instead, and most recipients cannot '
        + 'tell the difference at a glance.',
      fix: 'Remove the sp= tag so subdomains inherit p, or set sp=reject explicitly.',
      evidence: `p=${pol.p}; sp=none`,
    }));
  }

  if (pol.pct && pol.pct !== '100') {
    out.push(finding({
      severity: 'warn', owner: 'you', scope: 'Policy',
      title: `pct=${pol.pct}, so the policy applies to only ${pol.pct}% of your mail`,
      detail: `The other ${100 - Number(pol.pct)}% is evaluated as if your policy were `
        + 'p=none, which means a spoofer only has to try more than once.',
      fix: 'Ramp pct to 100 once the reports look clean. It is a deployment aid, not '
        + 'a setting to leave in place.',
    }));
  }

  // ---- the sources, worst first, one finding each for anything substantial
  for (const s of sim.sources) {
    const share = Math.round(1000 * s.atRisk / (agg.totals.total || 1)) / 10;
    const name = s.esp || s.ptr || s.ip;
    const isKnown = known.has(`${s.ip}|${s.headerFrom}`);
    if (s.forwarded) continue;             // handled as one finding below
    out.push(finding({
      severity: share >= 1 ? 'critical' : 'warn',
      owner: 'you',
      scope: 'Source',
      title: `${name} sends as ${s.headerFrom} and authenticates as neither`,
      detail: `${plural(s.atRisk, 'message')} (${share}% of everything in this report) `
        + 'aligned on neither SPF nor DKIM. At p=reject this is the mail that stops '
        + `arriving.${isKnown ? ' You have marked this source as yours.' : ''}`,
      fix: isKnown
        ? 'This is a sender you own, so it needs configuring: publish its sending '
          + 'IPs in your SPF record, or get it DKIM-signing with a key on your domain. '
          + 'DKIM is the one to prefer, because it survives forwarding.'
        : 'Work out whether this is yours. If it is a vendor you set up and forgot, '
          + 'get it authenticating. If you cannot identify it at all, that is worth '
          + 'knowing before you enforce, not after.',
      evidence: `${s.ip}  from=${s.headerFrom}`
        + (s.spfDomains.size ? `  spf: ${[...s.spfDomains].join(', ')}` : '')
        + (s.dkimDomains.size ? `  dkim: ${[...s.dkimDomains].join(', ')}` : ''),
    }));
  }

  const spfOnly = agg.sources.filter(s => s.verdict === 'spf');
  if (spfOnly.length) {
    const vol = spfOnly.reduce((n, s) => n + s.count, 0);
    out.push(finding({
      severity: 'warn', owner: 'you', scope: 'DKIM',
      title: `${plural(spfOnly.length, 'source')} pass on SPF alone, with no aligned DKIM`,
      detail: `${plural(vol, 'message')} authenticate today and will fail the moment `
        + 'someone forwards them, because forwarding rewrites the envelope sender and '
        + 'breaks SPF while leaving DKIM intact.',
      fix: 'Get DKIM signing with a key on your own domain for: '
        + spfOnly.slice(0, 4).map(s => s.esp || s.ptr || s.ip).join(', ')
        + (spfOnly.length > 4 ? `, and ${spfOnly.length - 4} more.` : '.'),
    }));
  }

  if (sim.forwarded) {
    out.push(finding({
      severity: 'info', owner: 'intermediary', scope: 'Forwarding',
      title: `${plural(sim.forwarded, 'message')} failed because they were forwarded`,
      detail: 'A forwarder rewrote the envelope and broke SPF. The receiver told us '
        + 'so explicitly. This is how forwarding works and it is not a fault in your '
        + 'configuration.',
      fix: 'Nothing to change. Aligned DKIM is what carries mail through a forward, '
        + 'so the fix for this category is the DKIM work above, not anything aimed at '
        + 'the forwarder.',
    }));
  }

  const undetermined = agg.sources.filter(s => s.verdict === 'unknown');
  if (undetermined.length) {
    out.push(finding({
      severity: 'info', owner: 'unknown', scope: 'Alignment',
      title: `Alignment could not be determined for ${plural(undetermined.length, 'source')}`,
      detail: 'These use a public suffix outside the table this tool ships, so working '
        + 'out the organisational domain would be a guess.',
      fix: '',
    }));
  }

  // Now that local_policy and sampled_out are no longer miscounted as forwarding,
  // they need saying out loud: a receiver declining to apply your policy is not
  // evidence that anything is working.
  if (agg.totals.overridden) {
    out.push(finding({
      severity: 'info', owner: 'receiver', scope: 'Override',
      title: `${plural(agg.totals.overridden, 'message')} had your policy overridden `
        + 'by the receiver',
      detail: 'The receiver recorded that it chose not to apply your published policy: '
        + 'a local rule, a sampling decision, or a reason it did not name. It is not a '
        + 'forwarding artefact and it is not a sign the mail authenticated.',
      fix: 'Nothing directly. Treat these as unauthenticated when deciding whether to '
        + 'enforce, because a different receiver will not make the same exception.',
    }));
  }

  if (agg.totals.disagreements) {
    out.push(finding({
      severity: 'info', owner: 'unknown', scope: 'Report quality',
      title: `The reporter's own verdict disagrees with its auth results on `
        + `${plural(agg.totals.disagreements, 'message')}`,
      detail: 'Its policy_evaluated says one thing and the auth_results it published '
        + 'alongside support another. The alignment shown here is computed from the '
        + 'auth results, which are the evidence.',
      fix: '',
    }));
  }

  // ---- what changed since last time, which is the whole point of the memory
  if (opts.known && known.size) {
    const fresh = agg.sources.filter(s =>
      !known.has(`${s.ip}|${s.headerFrom}`) && s.verdict !== 'both' && s.verdict !== 'dkim');
    if (fresh.length) {
      out.push(finding({
        severity: 'warn', owner: 'you', scope: 'New',
        title: `${plural(fresh.length, 'source')} in this report you have not seen before`,
        detail: 'Not previously marked as yours: '
          + fresh.slice(0, 5).map(s => s.esp || s.ip).join(', ')
          + (fresh.length > 5 ? `, and ${fresh.length - 5} more.` : '.'),
        fix: 'Check each one. A new source is either a vendor somebody onboarded '
          + 'without telling you, or somebody sending as you.',
      }));
    }
  }

  if (!out.length) {
    out.push(finding({
      severity: 'ok', owner: 'you', scope: 'DMARC',
      title: 'Everything in this report authenticated and aligned',
      detail: 'Every source in this window passed. One report is one receiver over '
        + 'one window, so keep reading them, but there is nothing here to fix.',
    }));
  }
  return out;
}

/* Source memory. Local to the browser, cleared by the user, never transmitted.
   The key is ip|header_from because the same IP sending as two of your domains
   is two different decisions. */
const MEM_KEY = 'rastu.dmarc.known';

export function loadKnown(storage) {
  try {
    return new Set(JSON.parse(storage.getItem(MEM_KEY) || '[]'));
  } catch { return new Set(); }
}
export function saveKnown(storage, set) {
  try { storage.setItem(MEM_KEY, JSON.stringify([...set])); } catch { /* full or blocked */ }
}
