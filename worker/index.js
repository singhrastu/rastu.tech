/* Two narrow endpoints, and then out of the way.
 *
 * The domain audit runs entirely in the visitor's browser over DNS-over-HTTPS,
 * so no domain anyone checks is ever sent to this server. Two things a browser
 * genuinely cannot do are proxied here, and only those two:
 *
 *   /api/mta-sts?d=<domain>   fetch the MTA-STS policy file. Same-origin policy
 *                             blocks this from a page, and it is the check that
 *                             makes the audit worth running: the DNS record
 *                             promises a policy, and a policy that 404s makes
 *                             the whole mechanism inert.
 *   /api/status?u=<https url> the HTTP status of a BIMI logo, and nothing else.
 *
 * Deliberately NOT a general fetch proxy. /api/mta-sts takes a domain, not a
 * URL, so the caller cannot choose what gets fetched at all; /api/status returns
 * a status code and never a body, so it is worth nothing to anyone wanting to
 * launder a request. Everything else falls through to the static assets.
 */
const HOSTNAME = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/i;
/* The only zones /api/dnsbl will assemble a query for. */
const DQS_ZONES = ['zen.dq.spamhaus.net', 'dbl.dq.spamhaus.net'];
/* A sequence of DNS labels and nothing else: no empty labels, no leading or
   trailing dot, nothing that could alter where the assembled name points. */
const LABELS = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;
const MAX_BYTES = 64 * 1024;
const TIMEOUT_MS = 8000;

const json = (obj, status = 200, maxAge = 300) => new Response(JSON.stringify(obj), {
  status,
  headers: {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': `public, max-age=${maxAge}`,
    'access-control-allow-origin': 'https://rastu.tech',
  },
});

/* Cloudflare's own edge errors (52x/53x) come back as HTTP statuses, which would
   be reported as if the origin had answered with them. It did not answer at all,
   so say that instead of showing a number nobody can act on. */
const EDGE_ERROR = {
  520: 'origin returned an invalid response', 521: 'origin refused the connection',
  522: 'connection timed out', 523: 'origin is unreachable',
  524: 'origin timed out', 525: 'TLS handshake failed', 526: 'invalid origin certificate',
  530: 'hostname does not resolve',
};

function normalise(res) {
  if (res.status && EDGE_ERROR[res.status] && /error code: \d+/.test(res.body || '')) {
    return { status: null, body: EDGE_ERROR[res.status] };
  }
  return res;
}

/* An IP literal is not a hostname. The regex below accepts one, because every
   label of 127.0.0.1 is alphanumeric, and a BIMI logo is never served from a
   bare address. Rejecting them closes the one path by which a caller could aim
   a subrequest at an address rather than at a name. */
const IP_LITERAL = /^\d{1,3}(\.\d{1,3}){3}$|^\[?[0-9a-f:]+\]?$/i;

async function get(url, { bodyWanted }) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      method: 'GET',
      /* Not 'follow'. RFC 8461 section 3.3 is explicit that 3xx redirects MUST
         NOT be followed when fetching a policy, so following one would report a
         policy as valid that a conformant sender would refuse. It would also
         step around the scheme and hostname checks above, which are applied to
         the URL given and not to wherever it points. */
      redirect: 'manual',
      signal: ctl.signal,
      headers: { 'user-agent': 'dmarcsight/rastu.tech (+https://rastu.tech/check/)' },
    });
    if (!bodyWanted) return { status: r.status };
    const buf = await r.arrayBuffer();
    const body = new TextDecoder().decode(buf.slice(0, MAX_BYTES));
    return { status: r.status, body };
  } catch (e) {
    return { status: null, body: String(e && e.message || e) };
  } finally {
    clearTimeout(t);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api/mta-sts') {
      const d = (url.searchParams.get('d') || '').trim().toLowerCase().replace(/\.+$/, '');
      if (!HOSTNAME.test(d) || d.length > 253) return json({ error: 'bad domain' }, 400);
      /* Our own zone is a special case: a Worker subrequest to a hostname it
         already serves loops back on itself and times out as a 522. The policy
         is a static asset, so read it from the binding instead of the network. */
      if (d === 'rastu.tech' || d.endsWith('.rastu.tech')) {
        const r = await env.ASSETS.fetch(new URL('/.well-known/mta-sts.txt', request.url));
        return json({ status: r.status, body: r.status === 200 ? await r.text() : '' });
      }
      // Otherwise the URL is built here, never supplied by the caller.
      const r = normalise(
        await get(`https://mta-sts.${d}/.well-known/mta-sts.txt`, { bodyWanted: true }));
      if (r.status >= 300 && r.status < 400) {
        return json({ status: r.status, body: '',
          note: 'The policy is served through a redirect. RFC 8461 section 3.3 '
              + 'says redirects must not be followed, so a conformant sender '
              + 'treats this as no policy at all.' });
      }
      return json(r);
    }

    /* Spamhaus refuses every public DNS resolver and answers 127.255.255.254
       to all of them, so a browser cannot ask it anything true. A Data Query
       Service key moves the query to a private zone that does answer. The key
       is a secret and never reaches the page.

       Deliberately not a DNS proxy. The caller supplies a reversed IPv4 address
       and a zone name from a fixed list; the query is assembled here, so there
       is no name a caller can reach that is not a Spamhaus DQS lookup. */
    if (url.pathname === '/api/dnsbl') {
      /* A public endpoint backed by somebody's personal query allowance is an
         invitation, so it is rationed before it is used. Keyed on the caller's
         address: a person checking a handful of domains never notices, a script
         in a loop stops at the first minute. */
      /* Surfaced rather than silent. A rate limit that failed to deploy looks
         exactly like one that is working until somebody counts, and a guard you
         cannot see the absence of is not a guard. */
      const guarded = Boolean(env.DNSBL_LIMIT);
      if (url.searchParams.get('diag') === '1') {
        return json({ rateLimiter: guarded,
                      challenge: Boolean(env.TURNSTILE_SECRET),
                      dqs: Boolean(env.SPAMHAUS_DQS_KEY) }, 200, 0);
      }
      if (env.DNSBL_LIMIT) {
        const who = request.headers.get('cf-connecting-ip') || 'unknown';
        const { success } = await env.DNSBL_LIMIT.limit({ key: who });
        if (!success) {
          return json({ error: 'rate limited',
            reason: 'Too many blocklist checks from this address in the last '
                  + 'minute. This endpoint runs on a personal Spamhaus query '
                  + 'allowance, so it is rationed.' }, 429);
        }
      }

      /* Turnstile, when it is configured. A rate limit slows one address down;
         a challenge stops the whole category of unattended traffic, which is
         what actually threatens a fair-use allowance. Gated on the secret being
         present so the endpoint keeps working before the keys exist. */
      if (env.TURNSTILE_SECRET) {
        const token = url.searchParams.get('t') || '';
        if (!token) return json({ error: 'challenge required' }, 403);
        const body = new FormData();
        body.append('secret', env.TURNSTILE_SECRET);
        body.append('response', token);
        const ip = request.headers.get('cf-connecting-ip');
        if (ip) body.append('remoteip', ip);
        let ok = false;
        try {
          const v = await fetch(
            'https://challenges.cloudflare.com/turnstile/v0/siteverify',
            { method: 'POST', body });
          ok = v.ok && ((await v.json()).success === true);
        } catch { ok = false; }
        if (!ok) {
          return json({ error: 'challenge failed',
            reason: 'The challenge token was missing, reused or expired. '
                  + 'Reload the page and try the check again.' }, 403);
        }
      }

      const key = env.SPAMHAUS_DQS_KEY;
      if (!key) {
        return json({ configured: false,
          reason: 'No Spamhaus DQS key is configured on this deployment.' });
      }
      /* One request per check, not three.
         A Turnstile token is spent the first time siteverify sees it, so sending
         the same one with three separate lookups meant the first passed and the
         other two were rejected as replays. The probes and the subject are
         resolved together here: the challenge is verified once, the rate limiter
         counts one check as one, and the caller cannot ask for the probes and
         the subject separately and get an inconsistent pair. */
      const subject = (url.searchParams.get('q') || '').trim().toLowerCase()
        .replace(/\.+$/, '');
      const zone = (url.searchParams.get('zone') || '').trim().toLowerCase();
      if (!DQS_ZONES.includes(zone)) return json({ error: 'unknown zone' }, 400);
      if (!subject || subject.length > 253 || !LABELS.test(subject)) {
        return json({ error: 'bad query' }, 400);
      }

      // RFC 5782 gives domain lists reserved names and address lists reserved
      // addresses. The zone decides which pair applies, so the caller cannot
      // pick the wrong one.
      const domainZone = zone.startsWith('dbl.');
      const probeUp = domainZone ? 'TEST' : '2.0.0.127';
      const probeDown = domainZone ? 'INVALID' : '1.0.0.127';

      const ask = async (label, ttl) => {
        try {
          const r = await fetch('https://cloudflare-dns.com/dns-query?type=A&name='
            + encodeURIComponent(`${label}.${key}.${zone}`),
            { headers: { accept: 'application/dns-json' },
              cf: { cacheTtl: ttl, cacheEverything: true } });
          if (!r.ok) return null;
          const d = await r.json();
          return (d.Answer || []).filter(a => a.type === 1).map(a => a.data);
        } catch { return null; }
      };

      // The probes are the same for every visitor and every subject, so they are
      // cached for an hour and shared; the subject gets five minutes.
      const [up, down, answers] = await Promise.all([
        ask(probeUp, 3600), ask(probeDown, 3600), ask(subject, 300),
      ]);
      return json({ configured: true, ok: true, up, down, answers }, 200, 300);
    }

    if (url.pathname === '/api/status') {
      const u = url.searchParams.get('u') || '';
      let parsed;
      try { parsed = new URL(u); } catch { return json({ error: 'bad url' }, 400); }
      if (parsed.protocol !== 'https:') return json({ error: 'https only' }, 400);
      if (!HOSTNAME.test(parsed.hostname)) return json({ error: 'bad host' }, 400);
      if (IP_LITERAL.test(parsed.hostname)) return json({ error: 'host must be a name' }, 400);
      return json(normalise(await get(parsed.toString(), { bodyWanted: false })));  // status only
    }

    return env.ASSETS.fetch(request);
  },
};
