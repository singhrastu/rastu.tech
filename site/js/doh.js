/* A resolver that speaks DNS-over-HTTPS from the visitor's browser.
 *
 * This is the reason the audit can be offered at all without a backend, and the
 * reason it can be offered without asking anyone to trust us: the lookups leave
 * the visitor's own browser and go to a public resolver. No domain anyone checks
 * is ever sent to rastu.tech.
 *
 * Two resolvers, because one rate-limits and a rate-limited lookup looks exactly
 * like "no record", which would silently report a domain as broken when it is not.
 */
const ENDPOINTS = [
  'https://cloudflare-dns.com/dns-query',
  'https://dns.google/resolve',
];
const TYPE = { TXT: 16, MX: 15, A: 1, AAAA: 28, PTR: 12 };

/* Thrown when every resolver failed. This is NOT the same as a domain having no
   record, and conflating the two is how a checker tells someone their SPF is
   missing when the truth is that their network blocked DNS-over-HTTPS. An
   NXDOMAIN is a real answer and returns normally; only a transport failure
   throws. */
export class DnsUnavailable extends Error {
  constructor(name, type) {
    super(`DNS lookup for ${type} ${name} could not be completed. Every resolver `
        + `failed, so this is not a result: the record may well exist.`);
    this.name = 'DnsUnavailable';
    this.qname = name;
    this.qtype = type;
  }
}

export function resolver() {
  const cache = new Map();          // one audit re-asks for the same name a lot
  let endpoint = 0;

  async function query(name, type) {
    const key = type + ':' + name;
    if (cache.has(key)) return cache.get(key);
    const p = (async () => {
      for (let attempt = 0; attempt < ENDPOINTS.length; attempt++) {
        const url = ENDPOINTS[(endpoint + attempt) % ENDPOINTS.length]
          + '?name=' + encodeURIComponent(name) + '&type=' + type;
        try {
          const r = await fetch(url, { headers: { accept: 'application/dns-json' } });
          if (!r.ok) continue;
          const d = await r.json();
          endpoint = (endpoint + attempt) % ENDPOINTS.length;
          // NXDOMAIN (3) and NOERROR-with-no-answer are real answers meaning
          // "no record here". Only a transport failure falls through below.
          return { ok: true, status: d.Status,
                   answers: (d.Answer || []).filter(a => a.type === TYPE[type]) };
        } catch (e) { /* try the other resolver */ }
      }
      return { ok: false, answers: [] };
    })();
    cache.set(key, p);
    return p;
  }

  async function answers(name, type) {
    const res = await query(name, type);
    if (!res.ok) throw new DnsUnavailable(name, type);
    return res.answers;
  }

  return {
    async txt(name) {
      const rows = await answers(name, 'TXT');
      // DNS splits long TXT into 255-byte chunks and the JSON API hands them back
      // as several quoted strings. They must be rejoined before parsing or a long
      // SPF record or DKIM key looks malformed.
      return rows.map(a => (a.data.match(/"([^"]*)"/g) || [a.data])
        .map(s => s.replace(/^"|"$/g, '')).join(''));
    },
    async mx(name) {
      const rows = await answers(name, 'MX');
      return rows
        .map(a => {
          const m = a.data.trim().match(/^(\d+)\s+(\S+?)\.?$/);
          return m ? [parseInt(m[1], 10), m[2]] : null;
        })
        .filter(Boolean)
        .sort((x, y) => x[0] - y[0]);
    },
    async a(name) {
      const [v4, v6] = await Promise.all([answers(name, 'A'), answers(name, 'AAAA')]);
      return [...v4, ...v6].map(x => x.data);
    },
    /* Reverse lookup, for naming the source IPs in a DMARC aggregate report.
       Returns [] for an IP with no PTR, which is common and not an error. */
    async ptr(ip) {
      const name = ip.includes(':')
        ? expandV6(ip)
        : ip.split('.').reverse().join('.') + '.in-addr.arpa';
      const rows = await answers(name, 'PTR');
      return rows.map(x => x.data.replace(/\.$/, ''));
    },
  };
}

/* IPv6 reverse names are the address in nibbles, reversed, under ip6.arpa. */
function expandV6(ip) {
  const [head, tail] = ip.split('::');
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const fill = new Array(8 - h.length - t.length).fill('0');
  const groups = (ip.includes('::') ? [...h, ...fill, ...t] : ip.split(':'))
    .map(g => g.padStart(4, '0'));
  return groups.join('').split('').reverse().join('.') + '.ip6.arpa';
}

/* The two fetches a page cannot make for itself, proxied by worker/index.js.
   The MTA-STS endpoint takes a domain rather than a URL, so nothing here can
   choose what gets fetched. */
export function policyFetcher(origin = '') {
  return async function fetchPolicy(url) {
    try {
      const mta = url.match(/^https:\/\/mta-sts\.([^/]+)\/\.well-known\/mta-sts\.txt$/);
      if (mta) {
        const r = await fetch(`${origin}/api/mta-sts?d=${encodeURIComponent(mta[1])}`);
        const d = await r.json();
        return [d.status, d.body || ''];
      }
      const r = await fetch(`${origin}/api/status?u=${encodeURIComponent(url)}`);
      const d = await r.json();
      return [d.status, ''];
    } catch (e) {
      return [null, String(e && e.message || e)];
    }
  };
}
