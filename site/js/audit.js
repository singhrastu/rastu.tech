/* A port of dmarcsight's checks, with no DOM and no network of its own.
 *
 * Everything reaches DNS through the injected `r` (txt/mx/a, each async) and the
 * MTA-STS policy through the injected `fetchPolicy`. That is the same seam the
 * Python package uses for its fixture resolver, which is what makes the two
 * implementations testable against each other: build/parity.mjs runs this file
 * against fixtures generated from the Python tests and fails the build if any
 * finding differs.
 *
 * Source of truth for the logic: github.com/singhrastu/dmarcsight
 */
export const FAIL = 'fail', WARN = 'warn', INFO = 'info', OK = 'ok';

// Selectors worth probing when we have no better information, ordered roughly by
// how often they turn up. Absence proves nothing: selectors are arbitrary strings
// chosen by the sender, which is why DKIM is reported as inconclusive, never absent.
export const COMMON_SELECTORS = [
  // Microsoft, Google
  'selector1', 'selector2', 'google',
  // Proton and Fastmail publish fixed selectors via CNAME and are large enough
  // that omitting them means reporting "no DKIM found" for a correctly
  // configured domain: confident, and wrong about the thing the user came to
  // check. Mirrors dmarcsight/checks.py::COMMON_SELECTORS.
  'protonmail', 'protonmail2', 'protonmail3', 'fm1', 'fm2', 'fm3',
  // ESPs
  'k1', 'k2', 's1', 's2', 'mandrill', 'mailjet', 'sendgrid', 'smtpapi',
  'zoho', 'everlytickey1', 'pm', 'mte1', 'sig1', 'hs1', 'hs2', 'ctct1',
  // generic
  'default', 'mail', 'dkim', 'dkim1', 'dkim2', 'smtp', 'fd', 'key1', 'key2',
];

class Report {
  constructor(domain) { this.domain = domain; this.findings = []; }
  add(check, severity, finding, remediation = '', detail = '') {
    this.findings.push({ check, severity, finding, remediation, detail });
  }
  counts() {
    const c = { fail: 0, warn: 0, info: 0, ok: 0 };
    for (const f of this.findings) c[f.severity]++;
    return c;
  }
}

function tags(record, sep = ';') {
  const out = {};
  for (const part of record.split(sep)) {
    const p = part.trim();
    const i = p.indexOf('=');
    if (i > -1) out[p.slice(0, i).trim().toLowerCase()] = p.slice(i + 1).trim();
  }
  return out;
}

/* RFC 8461 policy files are `key: value` per line, not the `key=value` of the DNS
   records. Getting that wrong makes a perfectly good policy look malformed. */
function policyTags(body) {
  const out = {};
  for (const line of body.split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i < 0) continue;
    const k = line.slice(0, i).trim().toLowerCase();
    if (!(k in out)) out[k] = line.slice(i + 1).trim();
  }
  return out;
}

// ------------------------------------------------------------------------ SPF
/* RFC 7208 section 4.6.4: include, a, mx, ptr and exists each cost one DNS lookup,
   as does the redirect modifier. all, ip4, ip6 and exp cost nothing.

   Every mechanism may carry a qualifier (+ - ~ ?) and a and mx may carry a CIDR
   suffix (a/24, mx//64). Matching on bare 'a:' and 'a' misses '+a', '-a', 'a/24'
   and 'ptr:example.com', all legal and all costing a lookup. Undercounting here
   means telling someone their record is safe when it permerrors. Mirrors
   dmarcsight/checks.py::_mechanism, and build/parity.mjs holds the two together. */
const COSTS_A_LOOKUP = /^(include|a|mx|ptr|exists)(?:[:/]|$)/i;

function mechanism(token) {
  const t = '+-~?'.includes(token[0]) ? token.slice(1) : token;
  const low = t.toLowerCase();
  if (low.startsWith('redirect=')) return ['redirect', t.slice(t.indexOf('=') + 1).trim()];
  const m = COSTS_A_LOOKUP.exec(low);
  if (!m) return null;
  const name = m[1];
  const rest = t.slice(name.length);
  const target = rest[0] === ':' ? rest.slice(1).split('/')[0].trim() : '';
  return [name, target];
}

/* `out`, when passed, collects the include tree as a side effect. The return value
   and the walk order are untouched, so build/parity.mjs keeps passing against the
   Python implementation; /spf/ gets the tree for free rather than from a second,
   drifting copy of this logic. */
/* `path` is the include chain above this record, not every target ever seen. A
   global set was wrong twice over: it made a domain that includes the same
   provider from two branches cost one lookup instead of two, which is not what a
   receiver does, and it was doing cycle detection's job badly. Cycles are a
   property of the path. */
async function countLookups(spf, r, path, depth = 0, out = null) {
  let n = 0;
  // RFC 7208 section 6.1: a redirect modifier is ignored when the record also
  // has an all mechanism. Counting it inflates the total and can report a record
  // that passes as one that permerrors.
  const hasAll = spf.split(/\s+/).some(t => {
    const x = '+-~?'.includes(t[0]) ? t.slice(1) : t;
    return x.toLowerCase() === 'all';
  });
  for (const token of spf.split(/\s+/)) {
    if (!token) continue;
    const mech = mechanism(token);
    if (!mech) {
      // ip4/ip6/all/exp and the version tag cost nothing; shown so the record
      // reads as a whole in the tree.
      if (out && !token.toLowerCase().startsWith('v=spf1')) {
        out.push({ kind: 'free', target: token, cost: 0, record: null,
                   children: [], note: '' });
      }
      continue;
    }
    const [name, target] = mech;
    if (name === 'redirect' && hasAll) {
      if (out) {
        out.push({ kind: 'free', target: token, cost: 0, record: null, children: [],
                   note: 'ignored: the record has an all mechanism (RFC 7208 6.1)' });
      }
      continue;
    }
    n += 1;
    const expands = name === 'include' || name === 'redirect';
    const node = out ? {
      kind: expands ? name : 'mechanism',
      target: expands ? target : token,
      cost: 1, record: null, children: [], note: '',
    } : null;
    if (node) out.push(node);
    if (!expands) continue;
    if (!target) {
      if (node) node.note = 'empty target';
      continue;
    }
    if (path.has(target)) {
      if (node) node.note = 'already on this include chain, so it would loop';
      continue;
    }
    // Past ten levels the record has already spent more than ten lookups, so the
    // verdict cannot change. Stop walking and say so, rather than returning a
    // magic number that the caller adds to the running total and reports as 110.
    if (depth >= 10) {
      if (node) node.note = 'chain is deeper than the ten-lookup limit allows';
      continue;
    }
    const sub = (await r.txt(target)).filter(x => x.toLowerCase().startsWith('v=spf1'));
    if (node) node.record = sub[0] || null;
    if (sub.length) {
      const below = new Set(path);
      below.add(target);
      n += await countLookups(sub[0], r, below, depth + 1, node ? node.children : null);
    } else if (node) {
      node.note = 'no SPF record at this name, so it resolves to nothing';
    }
  }
  return n;
}

/* The public entry point for /spf/. Returns the record, the tree and the count. */
export async function spfTree(domain, r) {
  domain = domain.trim().toLowerCase().replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '').replace(/^.*@/, '').replace(/\.+$/, '');
  // Same reasoning as the audit: "no SPF record" is the wrong answer for a name
  // that does not exist, and the two are indistinguishable once the lookup has
  // returned an empty list.
  if (typeof r.existence === 'function' && await r.existence(domain) === 'nxdomain') {
    return { domain, record: null, records: [], tree: [], count: 0, nxdomain: true };
  }
  const records = (await r.txt(domain)).filter(t => t.toLowerCase().startsWith('v=spf1'));
  if (!records.length) return { domain, record: null, records, tree: [], count: 0 };
  if (records.length > 1) return { domain, record: null, records, tree: [], count: 0 };
  const tree = [];
  const count = await countLookups(records[0], r, new Set(), 0, tree);
  const m = records[0].match(/([-~+?])all\b/);
  return { domain, record: records[0], records, tree, count, all: m ? m[1] : null };
}

async function checkSpf(domain, r, rep) {
  const records = (await r.txt(domain)).filter(t => t.toLowerCase().startsWith('v=spf1'));
  if (!records.length) {
    rep.add('SPF', FAIL, 'No SPF record',
      'Publish a v=spf1 record listing every source that sends as this domain, ending in -all.');
    return;
  }
  if (records.length > 1) {
    rep.add('SPF', FAIL, `${records.length} SPF records published`,
      'Merge into one. Multiple SPF records are a permerror and receivers will ignore SPF entirely.',
      records.join(' | '));
    return;
  }
  const spf = records[0];
  rep.add('SPF', OK, 'SPF record present', '', spf);

  const m = spf.match(/([-~+?])all\b/);
  if (!m) {
    rep.add('SPF', WARN, "No 'all' mechanism",
      'Add -all (or ~all while testing). Without it the record has no default.');
  } else if (m[1] === '+') {
    rep.add('SPF', FAIL, 'SPF ends in +all',
      '+all authorises the entire internet to send as you. Change to -all.');
  } else if (m[1] === '?') {
    rep.add('SPF', WARN, 'SPF ends in ?all (neutral)',
      'Neutral tells receivers nothing. Move to ~all then -all.');
  } else if (m[1] === '~') {
    rep.add('SPF', INFO, 'SPF ends in ~all (softfail)',
      "Fine while you're validating sources. Tighten to -all once you're confident.");
  } else {
    rep.add('SPF', OK, 'SPF ends in -all');
  }

  /* The failure nobody sees coming: the record looks fine, resolves fine, and
     silently permerrors once someone adds one more vendor. */
  const count = await countLookups(spf, r, new Set());
  if (count > 10) {
    rep.add('SPF', FAIL, `SPF exceeds the 10 DNS-lookup limit (~${count})`,
      'Flatten or remove includes. Over 10 lookups is a permerror and SPF stops working ' +
      'even though the record still resolves.');
  } else if (count >= 8) {
    rep.add('SPF', WARN, `SPF is near the 10-lookup limit (~${count})`,
      'You have little headroom. Adding one more vendor will break SPF.');
  } else {
    rep.add('SPF', OK, `SPF uses about ${count} of 10 DNS lookups`);
  }

  const usesPtr = spf.split(/\s+/).some(t => {
    const m = mechanism(t);
    return m && m[0] === 'ptr';
  });
  if (usesPtr) {
    rep.add('SPF', WARN, 'SPF uses the ptr mechanism',
      'ptr is deprecated by RFC 7208 and some receivers ignore it. Remove it.');
  }
}

// ---------------------------------------------------------------------- DMARC
async function checkDmarc(domain, r, rep) {
  const records = (await r.txt(`_dmarc.${domain}`))
    .filter(t => t.toLowerCase().startsWith('v=dmarc1'));
  if (!records.length) {
    rep.add('DMARC', FAIL, 'No DMARC record',
      'Publish _dmarc TXT with p=none and rua= first, read the reports, then move to enforcement.');
    return;
  }
  if (records.length > 1) {
    rep.add('DMARC', FAIL, `${records.length} DMARC records published`,
      'Only one is allowed. Receivers will treat this as no DMARC.');
    return;
  }
  const rec = records[0], t = tags(rec);
  rep.add('DMARC', OK, 'DMARC record present', '', rec);

  const p = (t.p || '').toLowerCase();
  if (p === 'reject') rep.add('DMARC', OK, 'Policy is p=reject (full enforcement)');
  else if (p === 'quarantine') rep.add('DMARC', WARN, 'Policy is p=quarantine',
    'Partial protection. Spoofed mail lands in spam rather than being rejected. Move to p=reject.');
  else if (p === 'none') rep.add('DMARC', WARN, 'Policy is p=none (monitoring only)',
    'p=none blocks nothing. It satisfies the bulk-sender minimum but does not stop spoofing.');
  else rep.add('DMARC', FAIL, `Invalid or missing policy tag (p=${p || 'absent'})`,
    'p= is required and must be none, quarantine or reject.');

  if (t.pct && t.pct !== '100') {
    rep.add('DMARC', WARN, `pct=${t.pct}: policy applies to only ${t.pct}% of mail`,
      'The other portion is unprotected. Ramp pct to 100 once reports look clean.');
  }

  if (!t.rua) {
    rep.add('DMARC', WARN, 'No rua= aggregate reporting address',
      'Without rua you are enforcing blind. Add one and read the reports.');
  } else {
    rep.add('DMARC', OK, 'Aggregate reporting (rua) configured', '', t.rua);
  }

  const sp = t.sp;
  if (sp && sp.toLowerCase() === 'none' && (p === 'quarantine' || p === 'reject')) {
    rep.add('DMARC', FAIL, `Subdomains are unprotected (sp=none while p=${p})`,
      'Attackers will spoof a subdomain instead. Remove sp= so it inherits p, or set sp=reject.');
  } else if (!sp) {
    rep.add('DMARC', INFO, 'No sp= tag, so subdomains inherit the main policy');
  }

  const adkim = t.adkim || 'r', aspf = t.aspf || 'r';
  if (adkim === 'r' && aspf === 'r') {
    rep.add('DMARC', INFO, 'Relaxed alignment for both SPF and DKIM (the default)');
  }
  if (adkim === 's' || aspf === 's') {
    rep.add('DMARC', INFO, `Strict alignment in use (adkim=${adkim}, aspf=${aspf})`,
      'Strict alignment breaks subdomain and some ESP sending. Confirm that is intended.');
  }
}

// ----------------------------------------------------------------------- DKIM
async function checkDkim(domain, r, rep, selectors) {
  const sels = selectors && selectors.length ? selectors : COMMON_SELECTORS;
  const found = [];
  // allSettled, not all: this fans out over 35 selectors and a single DNS
  // hiccup was aborting the entire domain check.
  const settled = await Promise.allSettled(
    sels.map(s => r.txt(`${s}._domainkey.${domain}`).then(v => [s, v])));
  const results = settled.filter(x => x.status === 'fulfilled').map(x => x.value);
  const unreachable = settled.length - results.length;
  for (const [s, txts] of results) {
    for (const txt of txts) {
      if (txt.toLowerCase().includes('v=dkim1') || txt.includes('p=')) { found.push([s, txt]); break; }
    }
  }

  if (!found.length) {
    rep.add('DKIM', WARN, `No DKIM key found on ${sels.length} common selectors`,
      'This is inconclusive, not proof of absence - selectors are arbitrary. ' +
      'Pass --selector if you know yours.',
      'tried: ' + sels.slice(0, 8).join(', ') + '...');
    return;
  }

  if (unreachable) {
    rep.add('DKIM', INFO, `${unreachable} selector lookups did not resolve`,
      'Treat this result as partial. It is a resolver problem, not a finding '
      + 'about the domain.');
  }

  for (const [sel, txt] of found) {
    const t = tags(txt);
    const key = t.p || '';
    const alg = (t.k || 'rsa').toLowerCase();
    if (!key) {
      rep.add('DKIM', FAIL, `Selector '${sel}' has an empty p= (revoked key)`,
        'An empty p= means the key is revoked. Remove the record or publish a real key.');
      continue;
    }
    // RFC 8463 keys are Ed25519 and 32 bytes, which is 44 base64 characters.
    // Measuring one in RSA bits reports about 227 and fails a perfectly good
    // record, so read k= before judging length.
    if (alg === 'ed25519') {
      if (key.replace(/\s+/g, '').length >= 40) {
        rep.add('DKIM', OK, `Selector '${sel}' publishes an Ed25519 key`,
          '', 'k=ed25519');
      } else {
        rep.add('DKIM', FAIL, `Selector '${sel}' Ed25519 key looks truncated`,
          'An Ed25519 public key is 32 bytes, so 44 base64 characters. Republish it.');
      }
      continue;
    }
    // rough bit estimate from the base64 length
    const bits = Math.trunc(key.length * 6 / 8 * 8 / 1.16);
    if (bits < 1024) {
      rep.add('DKIM', FAIL, `Selector '${sel}' key looks shorter than 1024 bits`,
        'Keys under 1024 bits are rejected by several receivers. Rotate to 2048.');
    } else if (bits < 2000) {
      rep.add('DKIM', INFO, `Selector '${sel}' publishes roughly a 1024-bit key`,
        'Acceptable, but 2048 is the current norm.');
    } else {
      rep.add('DKIM', OK, `Selector '${sel}' publishes roughly a 2048-bit key`);
    }
  }
}

// -------------------------------------------------------------------- MTA-STS
function mxMatches(pattern, host) {
  if (pattern.startsWith('*.')) return host.endsWith(pattern.slice(1));
  return pattern === host;
}

async function checkMtaSts(domain, r, rep, fetchPolicy) {
  const txts = (await r.txt(`_mta-sts.${domain}`))
    .filter(t => t.toLowerCase().startsWith('v=stsv1'));
  if (!txts.length) {
    rep.add('MTA-STS', INFO, 'No MTA-STS record',
      'Optional, but it prevents TLS downgrade on inbound mail. Worth publishing.');
    return;
  }
  rep.add('MTA-STS', OK, 'MTA-STS DNS record present', '', txts[0]);

  const [status, body] = await fetchPolicy(`https://mta-sts.${domain}/.well-known/mta-sts.txt`);
  if (status !== 200) {
    rep.add('MTA-STS', FAIL, 'Policy file is not reachable',
      'The DNS record promises a policy at https://mta-sts.<domain>/.well-known/mta-sts.txt. ' +
      'If it 404s the whole mechanism is inert.',
      `result: ${status || body}`);
    return;
  }

  const mode = (policyTags(body).mode || '').toLowerCase();
  if (mode === 'enforce') rep.add('MTA-STS', OK, 'Policy mode is enforce');
  else if (mode === 'testing') rep.add('MTA-STS', WARN, 'Policy mode is testing',
    'Testing mode reports but does not enforce. Move to enforce once TLS-RPT looks clean.');
  else if (mode === 'none') rep.add('MTA-STS', WARN, 'Policy mode is none (disabled)');
  else rep.add('MTA-STS', FAIL, `Policy has an invalid mode (${mode || 'absent'})`);

  // the mismatch that quietly breaks inbound mail
  const listed = [...body.matchAll(/^mx:\s*(\S+)/gim)].map(m => m[1]);
  const actual = (await r.mx(domain)).map(([, h]) => h.toLowerCase());
  if (listed.length && actual.length) {
    const unmatched = actual.filter(h => !listed.some(pat => mxMatches(pat.toLowerCase(), h)));
    if (unmatched.length) {
      rep.add('MTA-STS', FAIL, 'Live MX hosts are not covered by the policy',
        'Under enforce, mail to an uncovered MX is refused. Add the missing hosts.',
        'uncovered: ' + unmatched.join(', '));
    } else {
      rep.add('MTA-STS', OK, `All ${actual.length} MX hosts are covered by the policy`);
    }
  }
}

// ----------------------------------------------------------------------- misc
async function checkTlsRpt(domain, r, rep) {
  const txts = (await r.txt(`_smtp._tls.${domain}`))
    .filter(t => t.toLowerCase().startsWith('v=tlsrptv1'));
  if (txts.length) rep.add('TLS-RPT', OK, 'TLS-RPT configured', '', txts[0]);
  else rep.add('TLS-RPT', INFO, 'No TLS-RPT record',
    'Add one to get reports on TLS negotiation failures against your MX.');
}

async function checkBimi(domain, r, rep, fetchPolicy) {
  const txts = (await r.txt(`default._bimi.${domain}`))
    .filter(t => t.toLowerCase().startsWith('v=bimi1'));
  if (!txts.length) {
    rep.add('BIMI', INFO, 'No BIMI record',
      'BIMI needs DMARC at enforcement first. Not worth attempting before then.');
    return;
  }
  const t = tags(txts[0]);
  rep.add('BIMI', OK, 'BIMI record present', '', txts[0]);
  if (!t.a) {
    rep.add('BIMI', WARN, 'BIMI has no VMC (a= tag)',
      'Gmail and Apple require a Verified Mark Certificate to display the logo.');
  }
  if (t.l) {
    const [status] = await fetchPolicy(t.l);
    if (status !== 200) {
      rep.add('BIMI', FAIL, 'BIMI logo URL is not reachable',
        'The SVG at l= must be publicly fetchable over HTTPS.', t.l);
    }
  }
}

async function checkMx(domain, r, rep) {
  const mx = await r.mx(domain);
  if (!mx.length) {
    rep.add('MX', WARN, 'No MX records',
      'Fine for a send-only domain, but it cannot receive replies, bounces or FBL mail.');
    return;
  }
  rep.add('MX', OK, `${mx.length} MX host(s)`, '', mx.map(([p, h]) => `${p} ${h}`).join(', '));
  for (const [, host] of mx) {
    if (!(await r.a(host)).length) {
      rep.add('MX', FAIL, `MX host ${host} does not resolve`,
        'An MX pointing at a name with no A/AAAA record silently blackholes inbound mail.');
    }
  }
}

function checkBulkSenderReadiness(rep) {
  const by = {};
  for (const f of rep.findings) (by[f.check] = by[f.check] || []).push(f);
  const failed = c => (by[c] || []).some(f => f.severity === FAIL);

  const problems = [];
  if (failed('SPF') || !by.SPF) problems.push('SPF');
  if (failed('DMARC') || !by.DMARC) problems.push('DMARC');
  if ((by.DMARC || []).some(f => f.finding.includes('No DMARC record'))) problems.push('DMARC (absent)');
  const dkimUnverified = (by.DKIM || []).some(f => f.finding.includes('No DKIM key found'));

  if (problems.length) {
    rep.add('BULK-SENDER', FAIL,
      'Not meeting the Gmail/Yahoo/Microsoft bulk sender requirements',
      'Senders over 5,000 messages/day need SPF, DKIM and DMARC (p=none minimum), ' +
      'one-click List-Unsubscribe, and a spam complaint rate under 0.3%.',
      'gaps: ' + problems.join(', '));
  } else if (dkimUnverified) {
    rep.add('BULK-SENDER', WARN,
      'SPF and DMARC meet the baseline, DKIM could not be verified',
      'Re-run with --selector once you know your selector. Also confirm one-click ' +
      'List-Unsubscribe and a complaint rate under 0.3% - neither is visible from DNS.');
  } else {
    rep.add('BULK-SENDER', OK,
      'Authentication meets the bulk sender baseline',
      'Still verify one-click List-Unsubscribe and complaint rate under 0.3% - ' +
      'neither is visible from DNS.');
  }
}

export async function audit(domain, r, fetchPolicy, selectors) {
  domain = domain.trim().toLowerCase().replace(/\.+$/, '');
  const rep = new Report(domain);

  /* Ask whether the name exists before reporting on what it publishes.
     Every check below reads an empty answer as "no record", which is the right
     reading for a domain somebody owns and the wrong one for a typo: a list of
     failures against blablablaxyz.com reads as findings about a real domain.
     Only claimed when two resolvers independently agree, so a rate limit or a
     filtered resolver cannot produce it. Skipped entirely when the resolver
     does not offer the check, which keeps the fixture harness unaffected. */
  if (typeof r.existence === 'function') {
    const state = await r.existence(domain);
    if (state === 'nxdomain') {
      rep.add('Domain', FAIL, `${domain} does not exist`,
        'Two independent resolvers returned NXDOMAIN for this name, so there is '
        + 'nothing published here and nothing to fix. Check the spelling, and if '
        + 'the domain was registered in the last few minutes give it time to '
        + 'appear.',
        'NXDOMAIN at the apex');
      return rep;
    }
  }

  await checkSpf(domain, r, rep);
  await checkDkim(domain, r, rep, selectors);
  await checkDmarc(domain, r, rep);
  await checkMtaSts(domain, r, rep, fetchPolicy);
  await checkTlsRpt(domain, r, rep);
  await checkBimi(domain, r, rep, fetchPolicy);
  await checkMx(domain, r, rep);
  checkBulkSenderReadiness(rep);   // must be last: it reads the findings above
  return rep;
}

/* Is this even shaped like a domain?
 *
 * Cheap, local, and deliberately permissive: the job is to catch an obvious
 * non-domain before spending two DNS round trips on it, not to police what is
 * registrable. Anything that might be real gets through and DNS decides.
 * Rejecting a valid name here would be the worst outcome, so the rules are only
 * the ones no hostname can break.
 */
export function looksLikeDomain(input) {
  const d = String(input || '').trim().toLowerCase()
    .replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^.*@/, '')
    .replace(/\.+$/, '');
  if (!d) return { ok: false, reason: 'Enter a domain.' };
  if (d.length > 253) {
    return { ok: false, reason: 'A domain name cannot be longer than 253 characters.' };
  }
  if (/\s/.test(d)) {
    return { ok: false, reason: 'A domain name has no spaces in it.' };
  }
  if (!d.includes('.')) {
    return { ok: false, reason: 'That has no dot in it, so it is a hostname or a '
      + 'word rather than a domain. Try example.com.' };
  }
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(d)) {
    return { ok: false, reason: 'That is an IP address. These records are published '
      + 'against a domain name, so check the domain that sends from it.' };
  }
  for (const label of d.split('.')) {
    if (!label) return { ok: false, reason: 'That has an empty label in it, which '
      + 'means two dots together or a leading dot.' };
    if (label.length > 63) {
      return { ok: false, reason: 'No part of a domain name can be longer than 63 '
        + 'characters.' };
    }
    if (/^-|-$/.test(label)) {
      return { ok: false, reason: 'No part of a domain name can start or end with a '
        + 'hyphen.' };
    }
    // Permissive on the character set on purpose: internationalised names arrive
    // here as punycode, and an unfamiliar but legal character should reach DNS
    // rather than be turned away by a guess made in the browser.
    if (/[^a-z0-9-]/.test(label)) {
      return { ok: false, reason: 'That contains a character a domain name cannot '
        + 'have. An internationalised domain needs its punycode form, which starts '
        + 'with xn--.' };
    }
  }
  return { ok: true, domain: d };
}
