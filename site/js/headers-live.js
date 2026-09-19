/* What the sending domain publishes right now.
 *
 * Everything above this point is read out of the pasted text. This looks the
 * sending domain up in DNS, which answers the question the headers cannot: the
 * receiver reported a policy at the moment it accepted the message, but what is
 * published today, and does the selector that signed this message still resolve?
 *
 * A selector that has been rotated away leaves every message it signed
 * unverifiable, and nothing in a header tells you that. Checking it is the whole
 * reason this section exists.
 */
import { resolver, DnsUnavailable } from './doh.js';
import { finding } from './findings.js';
import { organisational } from './rua.js';

const tags = (rec) => {
  const out = {};
  for (const part of String(rec).split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim().toLowerCase()] = part.slice(i + 1).trim();
  }
  return out;
};

/** Look up the DMARC record for a domain, falling back to the organisational one. */
async function dmarcOf(domain, r) {
  const at = async (d) => (await r.txt(`_dmarc.${d}`))
    .filter(t => t.toLowerCase().replace(/\s/g, '').startsWith('v=dmarc1'));
  let recs = await at(domain);
  if (recs.length) return { at: domain, record: recs[0], inherited: false, count: recs.length };
  const org = organisational(domain);
  if (org && org !== domain) {
    recs = await at(org);
    // A record on the organisational domain governs a subdomain through sp=,
    // which is a different policy from p= and is the one people forget.
    if (recs.length) return { at: org, record: recs[0], inherited: true, count: recs.length };
  }
  return null;
}

/**
 * @param {Object} a   the offline analysis from analyse()
 * @param {Object} r   a resolver; defaults to the live DoH one
 * @returns {{findings: Array, dmarc: Object|null, selectors: Array, unavailable: boolean}}
 */
export async function liveCheck(a, r = resolver()) {
  const out = { findings: [], dmarc: null, selectors: [], unavailable: false };
  const domain = a.fromDomain;
  if (!domain) return out;

  try {
    out.dmarc = await dmarcOf(domain, r);

    // Every selector that signed this message, checked where it was signed from.
    for (const sig of a.dkimSigs) {
      if (!sig.s || !sig.d) continue;
      const name = `${sig.s}._domainkey.${sig.d}`;
      const txts = await r.txt(name);
      const rec = txts.find(t => /(^|;)\s*(v=DKIM1|p=)/i.test(t)) || null;
      const t = rec ? tags(rec) : {};
      out.selectors.push({
        selector: sig.s, d: sig.d, name,
        published: Boolean(rec),
        revoked: Boolean(rec) && t.p === '',
        keyType: (t.k || 'rsa').toLowerCase(),
        bits: t.p ? Math.trunc(t.p.length * 6 / 8 * 8 / 1.16) : 0,
      });
    }
  } catch (e) {
    if (e instanceof DnsUnavailable) {
      out.unavailable = true;
      out.findings.push(finding({
        severity: 'info', owner: 'unknown', scope: 'DNS',
        title: 'The sending domain could not be looked up',
        detail: 'DNS-over-HTTPS did not answer, so everything below is read from the '
          + 'pasted headers alone. This is a network problem here, not a finding about '
          + 'the domain.',
      }));
      return out;
    }
    throw e;
  }

  // ---- the published policy, which is the thing a sender can actually change
  if (!out.dmarc) {
    out.findings.push(finding({
      severity: 'critical', owner: 'you', scope: 'DMARC',
      title: `${domain} publishes no DMARC record`,
      detail: 'Without one, a receiver has no instruction and no way to report back, so '
        + 'anyone can send as this domain and you will never hear about it.',
      fix: `Publish a TXT record at _dmarc.${domain} to start listening: `
        + `v=DMARC1; p=none; rua=mailto:dmarc@${domain}; fo=1. Read the reports for a `
        + 'few weeks, then move to quarantine and on to reject.',
      evidence: `_dmarc.${domain}  NXDOMAIN`,
      ref: { url: '/rfc/9989/', label: 'RFC 9989, DMARC' },
    }));
  } else {
    const t = tags(out.dmarc.record);
    const p = (t.p || '').toLowerCase();
    const sp = (t.sp || '').toLowerCase();

    if (out.dmarc.count > 1) {
      out.findings.push(finding({
        severity: 'critical', owner: 'you', scope: 'DMARC',
        title: 'More than one DMARC record is published',
        detail: 'A domain with two DMARC records has none: receivers treat it as a '
          + 'permanent error and skip DMARC entirely.',
        fix: 'Merge them into a single TXT record.',
        evidence: `_dmarc.${out.dmarc.at}  ${out.dmarc.count} records`,
      }));
    }
    if (out.dmarc.inherited) {
      out.findings.push(finding({
        severity: 'info', owner: 'you', scope: 'DMARC',
        title: `The policy comes from ${out.dmarc.at}, not from ${domain}`,
        detail: `${domain} publishes no record of its own, so it inherits the `
          + `organisational one. That means sp= governs it, not p=`
          + (sp ? `, and sp=${sp}.` : ', and no sp= is set so p= applies.'),
        evidence: out.dmarc.record.slice(0, 120),
      }));
    }
    if (p === 'none') {
      out.findings.push(finding({
        severity: 'warn', owner: 'you', scope: 'DMARC',
        title: `${out.dmarc.at} is published at p=none today`,
        detail: 'Confirmed in DNS just now, not inferred from the headers. At p=none a '
          + 'receiver is asked to take no action however badly a message authenticates.'
          + (t.rua ? '' : ' There is also no rua address, so no reports are being sent '
             + 'anywhere and there is nothing to base a move on.'),
        fix: t.rua
          ? `Move to v=DMARC1; p=quarantine; pct=25; rua=${t.rua}; fo=1 and raise pct as `
            + 'the reports stay clean.'
          : `Add reporting first: v=DMARC1; p=none; rua=mailto:dmarc@${domain}; fo=1. `
            + 'Read a month of reports, then move the policy.',
        evidence: out.dmarc.record.slice(0, 150),
      }));
    } else if (p === 'quarantine' || p === 'reject') {
      out.findings.push(finding({
        severity: 'ok', owner: 'you', scope: 'DMARC',
        title: `${out.dmarc.at} enforces at p=${p}`,
        detail: sp && sp !== p
          ? `Note that subdomains are governed by sp=${sp}, which is weaker than p=${p}.`
          : 'Both the domain and its subdomains are covered.',
        evidence: out.dmarc.record.slice(0, 150),
      }));
    }
    if (p && p !== 'none' && sp === 'none') {
      out.findings.push(finding({
        severity: 'warn', owner: 'you', scope: 'DMARC',
        title: `The domain enforces but its subdomains do not (sp=none)`,
        detail: 'A forger does not need your exact domain. Any subdomain that has never '
          + 'existed inherits sp=none and passes straight through.',
        fix: 'Set sp= to match p=, or remove sp= so subdomains inherit p= automatically.',
        evidence: out.dmarc.record.slice(0, 150),
      }));
    }
    if (!t.rua && p) {
      out.findings.push(finding({
        severity: 'warn', owner: 'you', scope: 'DMARC',
        title: 'No aggregate report address',
        detail: 'Without rua= you get no feedback, so you cannot see which senders would '
          + 'break before you tighten the policy.',
        fix: `Add rua=mailto:dmarc@${domain} to the record.`,
        evidence: out.dmarc.record.slice(0, 150),
      }));
    }
  }

  // ---- the selectors that signed this exact message
  for (const s of out.selectors) {
    if (!s.published) {
      out.findings.push(finding({
        severity: 'critical', owner: 'you', scope: `DKIM s=${s.selector}`,
        title: `The selector that signed this message no longer resolves`,
        detail: 'The signature is in the message but there is no key at that name in DNS '
          + 'today, so this message can no longer be verified by anyone who receives or '
          + 'forwards it now. A rotation that removed the old selector too early does '
          + 'exactly this.',
        fix: `Republish the key at ${s.name} until every message signed with it has aged `
          + 'out of the world, which is usually a week or more.',
        evidence: `${s.name}  no key`,
      }));
    } else if (s.revoked) {
      out.findings.push(finding({
        severity: 'critical', owner: 'you', scope: `DKIM s=${s.selector}`,
        title: 'The selector is published with an empty key',
        detail: 'An empty p= is the revocation marker. Every signature made with this '
          + 'selector now fails deliberately.',
        fix: `Either publish a real key at ${s.name} or stop signing with this selector.`,
        evidence: `${s.name}  p=`,
      }));
    } else if (s.keyType === 'rsa' && s.bits && s.bits < 1024) {
      out.findings.push(finding({
        severity: 'critical', owner: 'you', scope: `DKIM s=${s.selector}`,
        title: `The key is roughly ${s.bits} bits`,
        detail: 'RFC 8301 sets the floor at 1024 and several receivers reject below it.',
        fix: 'Rotate to a 2048-bit key.',
        evidence: `${s.name}  k=${s.keyType}`,
      }));
    } else {
      out.findings.push(finding({
        severity: 'ok', owner: 'you', scope: `DKIM s=${s.selector}`,
        title: `The signing key is still published`,
        detail: s.keyType === 'ed25519'
          ? 'An Ed25519 key, per RFC 8463.'
          : `Roughly ${s.bits} bits, which verifies today and will keep verifying.`,
        evidence: s.name,
      }));
    }
  }

  return out;
}
