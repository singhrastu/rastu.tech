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
 * RFC 5782 section 5 gives the way out. A conformant list MUST contain
 * 127.0.0.2 and MUST NOT contain 127.0.0.1. Probing both before trusting a list
 * separates all three cases, and no answer about anybody's address is reported
 * from a list that failed its own probe.
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

/* Not queried, and said so rather than omitted. Leaving Spamhaus off the page
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

/**
 * Check one address against every list.
 *
 * @param {string} ip
 * @param {(name: string) => Promise<string[]|null>} lookup  A records, or null
 *        when the query could not be completed. Never throws.
 * @returns {Promise<Object>}
 */
export async function check(ip, lookup, lists = LISTS) {
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

  const listed = rows.filter(r => r.state === 'listed');
  const clean = rows.filter(r => r.state === 'clean');
  const undetermined = rows.filter(r => r.state === 'undetermined');

  return {
    ip: addr, supported: true, rows, listed, clean, undetermined,
    verdict: listed.length
      ? { severity: 'critical',
          text: `Listed on ${listed.length} of the ${clean.length + listed.length} `
              + `lists that answered.` }
      : clean.length
        ? { severity: 'ok',
            text: `Not listed on any of the ${clean.length} lists that answered.` }
        : { severity: 'warn',
            text: 'No list answered reliably, so this is not a result.' },
  };
}
