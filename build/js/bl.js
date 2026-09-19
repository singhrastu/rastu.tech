/* Blocklist checking, with the answer gated on whether the list is actually
 * answering.
 *
 * Pure: no DOM, no network. Lookups are injected.
 *
 * The problem every other checker has is that a DNSBL cannot tell you it has
 * stopped working. All three of these look identical to software:
 *
 *   NXDOMAIN because the address is not listed        the normal case
 *   NXDOMAIN because the zone was decommissioned      SORBS, shut down in 2024
 *   an answer because the list refuses your resolver  Spamhaus, to public DNS
 *
 * The first is a result. The second reports every address on earth as clean.
 * The third reports every address on earth as listed, which is worse, because
 * 127.255.255.254 is an A record and a naive checker counts any A record as a
 * hit.
 *
 * RFC 5782 section 5 gives the way out, for both kinds of list:
 *
 *   IPv4      MUST contain 127.0.0.2,  MUST NOT contain 127.0.0.1
 *   domain    MUST contain "TEST",     MUST NOT contain "INVALID"
 *
 * Probing both before trusting a list separates all three cases, and no answer
 * about anybody's address or domain is reported from a list that failed its own
 * probe. The domain side is where this matters most: AHBL shut down in 2015 and
 * deliberately wildcarded its zone so that every query answers positive, to force
 * people to stop asking. A checker without the probe reports every domain on
 * earth as listed.
 */

/** Reverse an IPv4 address into DNSBL query order. */
export function reverseV4(ip) {
  const m = String(ip).trim().match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  if (parts.some(p => p > 255)) return null;
  return parts.reverse().join('.');
}

/* IPv6 is reversed nibble by nibble, which almost no list supports, so it is
   reported as unsupported rather than queried and silently misreported. */
export function isV6(ip) {
  return String(ip).includes(':');
}

/* Addresses that cannot meaningfully be listed. Querying them wastes a lookup
   and any answer would be noise. */
const PRIVATE_V4 = [
  [10, 0, 0, 0, 8], [172, 16, 0, 0, 12], [192, 168, 0, 0, 16],
  [127, 0, 0, 0, 8], [169, 254, 0, 0, 16], [100, 64, 0, 0, 10],
  [0, 0, 0, 0, 8], [224, 0, 0, 0, 4],
];

export function isReservedV4(ip) {
  const m = String(ip).trim().match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const oct = m.slice(1).map(Number);
  const v = ((oct[0] << 24) >>> 0) + (oct[1] << 16) + (oct[2] << 8) + oct[3];
  return PRIVATE_V4.some(([a, b, c, d, bits]) => {
    const base = ((a << 24) >>> 0) + (b << 16) + (c << 8) + d;
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (v & mask) >>> 0 === (base & mask) >>> 0;
  });
}

/* Every list here was probed against its own RFC 5782 entries before being
   included, and is probed again on every run. The delisting URL matters as much
   as the listing: a checker that tells you that you are listed and not how to
   get off is half a tool. */
export const LISTS = [
  { zone: 'bl.spamcop.net', name: 'SpamCop',
    delist: 'https://www.spamcop.net/bl.shtml',
    note: 'Fed by spam traps and user reports. Entries expire on their own, '
        + 'usually within a day of the last report.' },
  { zone: 'b.barracudacentral.org', name: 'Barracuda',
    delist: 'https://www.barracudacentral.org/rbl/removal-request',
    note: 'Requires a free registration to query from your own resolver, and a '
        + 'form for removal.' },
  { zone: 'psbl.surriel.com', name: 'PSBL',
    delist: 'https://psbl.org/remove',
    note: 'Passive spam block list, trap-driven. Removal is self-service and '
        + 'immediate, but it relists if the traps keep firing.' },
  { zone: 'bl.mailspike.net', name: 'Mailspike',
    delist: 'https://mailspike.org/iplookup.html',
    note: 'Reputation scored rather than a plain yes or no. The return code '
        + 'says which band you fell into.' },
  { zone: 'dnsbl-1.uceprotect.net', name: 'UCEPROTECT Level 1',
    delist: 'https://www.uceprotect.net/en/rblcheck.php',
    note: 'Level 1 lists single addresses. Expires by itself after seven days '
        + 'with no further spam; paid express removal exists and is not '
        + 'necessary.' },
  { zone: 'truncate.gbudb.net', name: 'GBUdb Truncate',
    delist: 'https://www.gbudb.com/truncate/index.jsp',
    note: 'Only lists addresses seen sending nothing but spam, so a listing '
        + 'here usually means a compromised host rather than a reputation dip.' },
  { zone: 'all.s5h.net', name: 's5h',
    delist: 'https://www.usenix.org.uk/content/rbl.html',
    note: 'Aggregate list. Small, and used by smaller receivers.' },
  { zone: 'dnsbl.dronebl.org', name: 'DroneBL',
    delist: 'https://dronebl.org/lookup',
    note: 'Compromised machines, proxies and drones. A listing points at the '
        + 'host being used by somebody else.' },
  { zone: 'rbl.interserver.net', name: 'InterServer',
    delist: 'https://rbl.interserver.net/index.php',
    note: 'Operator-run list with self-service removal.' },
  { zone: 'bl.blocklist.de', name: 'blocklist.de',
    delist: 'https://www.blocklist.de/en/delist.html',
    note: 'Built from fail2ban style abuse reports, so it often means SSH or '
        + 'web brute forcing rather than mail.' },
  { zone: 'bl.0spam.org', name: '0spam',
    delist: 'https://0spam.org/removal/',
    note: 'Trap-driven, with self-service removal. Smaller reach than the '
        + 'others here, so a listing on this alone rarely explains a delivery '
        + 'problem on its own.' },
];

/* Spamhaus through a Data Query Service key, which is the only way to reach it
   from infrastructure: the public zones answer 127.255.255.254 to every resolver
   anybody can use. The key lives as a Worker secret and never reaches the page.
   Without one this returns a row saying it was not checked, which is the honest
   state and is not the same as a clean result.

   The canary runs through the same path as the real query. A key that has been
   revoked or has run past its quota answers just like a working one until you
   test it, which is the failure this whole tool is about. */
export const DQS = {
  ipv4: { zone: 'zen.dq.spamhaus.net', name: 'Spamhaus ZEN',
          delist: 'https://check.spamhaus.org/',
          note: 'The list most receivers consult. Listings carry a return code '
              + 'saying which of SBL, XBL, CSS or PBL matched, and each has its '
              + 'own removal route.' },
  domain: { zone: 'dbl.dq.spamhaus.net', name: 'Spamhaus DBL',
            delist: 'https://check.spamhaus.org/',
            note: 'Domain reputation, and the one that most often explains a '
                + 'domain being refused outright rather than filtered.' },
};

export async function checkSpamhaus(subject, kind, dqs) {
  const cfg = kind === 'domain' ? DQS.domain : DQS.ipv4;
  if (typeof dqs !== 'function') {
    return { ...cfg, state: 'not-checked',
      canary: { ok: false, state: 'unconfigured',
        why: 'No Spamhaus Data Query Service key is configured on this '
           + 'deployment, and the public zones refuse every resolver a browser '
           + 'can use.' } };
  }
  const subjectQuery = kind === 'domain' ? subject : reverseV4(subject);
  const probeUp = kind === 'domain' ? 'TEST' : '2.0.0.127';
  const probeDown = kind === 'domain' ? 'INVALID' : '1.0.0.127';

  const [up, down, answer] = await Promise.all([
    dqs(probeUp, cfg.zone), dqs(probeDown, cfg.zone), dqs(subjectQuery, cfg.zone),
  ]);
  if (up === 'unconfigured') {
    return { ...cfg, state: 'not-checked',
      canary: { ok: false, state: 'unconfigured',
        why: 'No Spamhaus Data Query Service key is configured on this '
           + 'deployment, and the public zones refuse every resolver a browser '
           + 'can use.' } };
  }
  const canary = canaryVerdict(up, down);
  if (!canary.ok) return { ...cfg, state: 'undetermined', canary, codes: [] };
  if (answer === null) {
    return { ...cfg, state: 'undetermined', codes: [],
      canary: { ok: false, state: 'unreachable',
        why: 'The key answered its probes but the query for this subject did '
           + 'not complete.' } };
  }
  return { ...cfg, canary, codes: answer,
           state: answer.length ? 'listed' : 'clean' };
}

/* Not queried without a key, and said so rather than omitted. Leaving Spamhaus off the page
   without explanation is the same silence that lets other checkers get away
   with querying it wrongly. */
export const UNQUERYABLE = [
  { zone: 'zen.spamhaus.org', name: 'Spamhaus ZEN',
    reason: 'Spamhaus refuses queries arriving through public DNS resolvers and '
          + 'answers 127.255.255.254 to every one, including the address RFC 5782 '
          + 'says must never be listed. A checker that does not probe for that '
          + 'reports every address as listed.',
    delist: 'https://check.spamhaus.org/' },
];

/* Domain blocklists answer for the name itself rather than for a reversed
   address, and they are a different corpus from the IP lists: a domain appears
   here because it was seen in spam, not because a host was compromised. */
export const DOMAIN_LISTS = [
  { zone: 'black.uribl.com', name: 'URIBL black',
    delist: 'https://uribl.com/refresh.shtml',
    note: 'Domains seen in the body of spam. Listing is about where a message '
        + 'points a reader, not about who sent it, so a shared link shortener '
        + 'can put you here.' },
  { zone: 'dbl.nordspam.com', name: 'NordSpam DBL',
    delist: 'https://www.nordspam.com/removal/',
    note: 'Domain reputation list with self-service removal.' },
  { zone: 'dbl.suomispam.net', name: 'Suomispam DBL',
    delist: 'https://suomispam.net/removal.html',
    note: 'Smaller list with a regional focus. A listing here alone rarely '
        + 'explains a delivery problem on its own.' },
  { zone: 'rhsbl.rymsho.ru', name: 'Rymsho RHSBL',
    delist: 'https://rbl.rymsho.ru/',
    note: 'Right-hand-side list, meaning it matches the domain in an address '
        + 'rather than a link in the body.' },
  { zone: 'dob.sibl.support-intelligence.net', name: 'SIBL day-old',
    delist: 'https://www.support-intelligence.com/',
    note: 'Lists domains registered in the last day or so. Brand new domains '
        + 'are listed on age alone, which is why a fresh sending domain needs '
        + 'warming rather than volume.' },
  { zone: 'abuse.rfc-clueless.org', name: 'RFC-Clueless',
    delist: 'http://www.rfc-clueless.org/',
    note: 'Lists domains whose operators do not follow basic requirements, '
        + 'commonly a missing or bouncing abuse@ or postmaster@ mailbox.' },
];

/* Named rather than silently dropped, same as the IP side. */
export const UNQUERYABLE_DOMAIN = [
  { zone: 'dbl.spamhaus.org', name: 'Spamhaus DBL',
    reason: 'Spamhaus refuses queries from public DNS resolvers on its domain '
          + 'list as well, answering 127.255.255.254 to every one including the '
          + 'name RFC 5782 says must never be listed.',
    delist: 'https://check.spamhaus.org/' },
];

/** The RFC 5782 verdict for one list, from its two probe results. */
export function canaryVerdict(listedProbe, notListedProbe) {
  const up = Array.isArray(listedProbe) && listedProbe.length > 0;
  const down = Array.isArray(notListedProbe) && notListedProbe.length > 0;
  if (listedProbe === null || notListedProbe === null) {
    return { ok: false, state: 'unreachable',
      why: 'The probe queries did not complete, so nothing this list says can be '
         + 'trusted right now.' };
  }
  if (up && down) {
    return { ok: false, state: 'refusing',
      why: 'The list answered for 127.0.0.1, which RFC 5782 says must never be '
         + 'listed. It is answering something other than list data, usually a '
         + 'refusal aimed at the resolver being used.' };
  }
  if (!up && !down) {
    return { ok: false, state: 'silent',
      why: 'The list did not answer for 127.0.0.2, which RFC 5782 says every '
         + 'conformant list must contain. The zone is dead or refusing, and a '
         + 'dead zone reports every address as clean.' };
  }
  if (!up && down) {
    return { ok: false, state: 'inverted',
      why: 'The list answers for the address that must not be listed and not for '
         + 'the one that must. Its return codes do not mean what a blocklist '
         + 'query means.' };
  }
  return { ok: true, state: 'conformant', why: '' };
}

/* A domain, loosely. Anything that is not an address and has a dot in it goes
   to the domain lists and DNS decides whether it exists. */
export function classify(input) {
  const v = String(input || '').trim().toLowerCase()
    .replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^.*@/, '')
    .replace(/\.+$/, '');
  if (!v) return { kind: 'empty' };
  if (isV6(v)) return { kind: 'ipv6', value: v };
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(v)) {
    return reverseV4(v) ? { kind: 'ipv4', value: v } : { kind: 'bad', value: v };
  }
  if (!v.includes('.') || /[^a-z0-9.-]/.test(v)) return { kind: 'bad', value: v };
  return { kind: 'domain', value: v };
}

/**
 * Check a domain against the domain lists.
 *
 * The probe entries are the reserved names from RFC 2606 rather than loopback
 * addresses, and they catch a failure mode the IP side rarely sees: a zone that
 * was retired by wildcarding every answer to positive.
 */
export async function checkDomain(domain, lookup, lists = DOMAIN_LISTS, dqs) {
  const d = String(domain || '').trim().toLowerCase().replace(/\.+$/, '');
  const rows = await Promise.all(lists.map(async (l) => {
    const [listedProbe, notListedProbe, answer] = await Promise.all([
      lookup(`TEST.${l.zone}`),
      lookup(`INVALID.${l.zone}`),
      lookup(`${d}.${l.zone}`),
    ]);
    const canary = canaryVerdict(listedProbe, notListedProbe);
    if (!canary.ok) return { ...l, state: 'undetermined', canary, codes: [] };
    if (answer === null) {
      return { ...l, state: 'undetermined', codes: [],
        canary: { ok: false, state: 'unreachable',
          why: 'The list passed its probes but the query for this domain did '
             + 'not complete.' } };
    }
    return { ...l, canary, codes: answer,
             state: answer.length ? 'listed' : 'clean' };
  }));
  // Spamhaus sits at the top of the table whether or not it could be asked,
  // because a table of six green rows with the important one missing from the
  // page is how somebody concludes they are fine.
  const sh = await checkSpamhaus(d, 'domain', dqs);
  return summarise(d, [sh, ...rows], 'domain');
}

/* A verdict has to account for what was not asked, not only for what answered.
   Reporting "clean" while the list most receivers actually consult was never
   queried is the same false confidence this tool exists to refuse, arrived at
   from the other direction: the canary stops a broken list from speaking, and
   then the headline forgets it was ever there. Spamhaus is always in this
   position from a browser, so a clean result is never unqualified. */
function summarise(subject, rows, kind) {
  const listed = rows.filter(r => r.state === 'listed');
  const clean = rows.filter(r => r.state === 'clean');
  const undetermined = rows.filter(r => r.state === 'undetermined');
  const missing = rows.filter(r => r.state === 'not-checked');
  const names = missing.map(m => m.name);
  const gap = names.length
    ? ` ${names.join(' and ')} could not be queried from a browser and `
      + `${names.length === 1 ? 'is' : 'are'} not included in that, which matters `
      + `because it is the list most receivers actually consult.`
    : '';

  let verdict;
  if (listed.length) {
    verdict = { severity: 'critical', state: 'listed',
      text: `Listed on ${listed.length} of the ${clean.length + listed.length} `
          + `lists that answered.` };
  } else if (clean.length) {
    // Deliberately not the word "clean". Not listed on what answered is a
    // narrower claim, and the narrower claim is the true one.
    verdict = { severity: names.length ? 'warn' : 'ok',
      state: names.length ? 'partial' : 'not-listed',
      text: `Not listed on the ${clean.length} `
          + `${clean.length === 1 ? 'list' : 'lists'} that answered.${gap}` };
  } else {
    verdict = { severity: 'warn', state: 'none',
      text: 'No list answered reliably, so this is not a result.' };
  }
  return { ip: subject, subject, kind, supported: true, rows, listed, clean,
           undetermined, missing, verdict };
}

/**
 * Check one address against every list.
 *
 * @param {string} ip
 * @param {(name: string) => Promise<string[]|null>} lookup  A records, or null
 *        when the query could not be completed. Never throws.
 * @returns {Promise<Object>}
 */
export async function check(ip, lookup, lists = LISTS, dqs) {
  const addr = String(ip || '').trim();
  if (isV6(addr)) {
    return { ip: addr, supported: false,
      reason: 'IPv6 reverse lookups are defined, and almost no blocklist '
            + 'publishes them. Checking would produce a clean answer from lists '
            + 'that were never going to answer, which is exactly the false '
            + 'confidence this tool exists to avoid.' };
  }
  const rev = reverseV4(addr);
  if (!rev) {
    return { ip: addr, supported: false,
      reason: 'That is not an IPv4 address.' };
  }
  if (isReservedV4(addr)) {
    return { ip: addr, supported: false,
      reason: 'That address is private or reserved, so it never appears in a '
            + 'blocklist and never sends mail across the internet.' };
  }

  const rows = await Promise.all(lists.map(async (l) => {
    const [listedProbe, notListedProbe, answer] = await Promise.all([
      lookup(`2.0.0.127.${l.zone}`),
      lookup(`1.0.0.127.${l.zone}`),
      lookup(`${rev}.${l.zone}`),
    ]);
    const canary = canaryVerdict(listedProbe, notListedProbe);
    if (!canary.ok) {
      return { ...l, state: 'undetermined', canary, codes: [] };
    }
    if (answer === null) {
      return { ...l, state: 'undetermined', codes: [],
        canary: { ok: false, state: 'unreachable',
          why: 'The list passed its probes but the query for this address did '
             + 'not complete.' } };
    }
    return { ...l, canary, codes: answer,
             state: answer.length ? 'listed' : 'clean' };
  }));

  const sh = await checkSpamhaus(addr, 'ipv4', dqs);
  return summarise(addr, [sh, ...rows], 'ipv4');
}
