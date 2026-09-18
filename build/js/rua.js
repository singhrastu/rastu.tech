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
  // Reporters emit xmlns and xsi attributes inconsistently, and RFC 7489 declares
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
      count: Number(text(kid(row, 'count'))) || 0,
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

function verdictFor(row) {
  const forwarded = row.reasons.some(r =>
    ['forwarded', 'mailing_list', 'local_policy', 'trusted_forwarder'].includes(r.type));
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
  let total = 0, failing = 0, aligned = 0, disagreements = 0;

  for (const rep of reports) {
    for (const row of rep.rows) {
      total += row.count;
      const v = verdictFor(row);
      if (v === 'none') failing += row.count;
      if (v === 'both' || v === 'dkim') aligned += row.count;

      // Where the reporter's own policy_evaluated disagrees with what the auth
      // results actually support. Rare, but real, and worth surfacing.
      const claimed = row.reported.dkim === 'pass' || row.reported.spf === 'pass';
      const ours = row.computed.dkim || row.computed.spf;
      if (claimed !== ours && !row.computed.undetermined) disagreements += row.count;

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
    totals: { total, failing, aligned, disagreements, sources: sources.length },
    sources,
  };
}
