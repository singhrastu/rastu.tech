# rastu.tech architecture

How the site is built, how it is hosted, and how every piece is configured.

Written to be read straight through. Terms are explained where they first appear, and
there is a glossary at the end. An engineer should be able to work on this after one
read; somebody who has never deployed anything should still follow what is going on.

| | |
|---|---|
| Pages | 127, all pre-built |
| Script modules | 21, no bundler |
| Server code | 229 lines, three endpoints |
| Dependencies | none, in either Python or JavaScript |
| Hosting cost | nothing |
| Deploy time | 30 to 50 seconds from `git push` |

---

## 1. The one idea that explains the hosting

There are two kinds of request, and only one of them can ever cost money.

```
A PAGE REQUEST                          A TOOL LOOKUP
free, unmetered                         counted against an allowance

browser asks for rastu.tech             tool calls /api/dnsbl
        |                                       |
Cloudflare DNS answers                  Worker wakes at the same edge
        |                                       |
nearest data centre                     rate limit, then challenge
        |                                       |
Static Assets returns the file          upstream query, cached
no code runs                            one billable invocation
```

Cloudflare charges for **programs that run**, not for **files that are served**. Every
page on this site is a finished file. Code runs only at three `/api/` addresses, and
only when a visitor deliberately presses a button.

That is the whole cost model. Everything below is a consequence of it.

---

## 2. Design constraints

These were decided first and everything else follows from them.

**It must cost nothing, with no path to a surprise bill.** Not "cheap". Nothing. This
rules out any always-on server, any managed database, and any design where traffic
growth translates into spend. It is also why the metered surface is three endpoints
rather than a general API.

**Nothing a visitor types may reach the server.** The tools audit production sending
domains. A domain someone checks here is commercially sensitive, so the honest
position is that there is nothing to log because the data never arrives. That forces
the tools to run in the browser rather than on a backend.

**No dependencies.** Not a preference, a security and maintenance position. A static
site with no package manager has no dependency updates, no supply-chain surface, and
nothing that breaks when a package changes underneath it. The cost is that some things
are written by hand that would otherwise be a library call.

**A wrong answer is worse than no answer.** In deliverability a false clean result gets
acted on. Every tool must be able to say "could not determine" and say why.

---

## 3. Component architecture

### 3.1 The split that matters

Every tool is two modules: pure logic, and a view. This is the central pattern in the
codebase.

| | Pure module | UI module |
|---|---|---|
| Example | `warmup.js` | `warmup-ui.js` |
| Touches the DOM | never | yes |
| Performs I/O | never | yes |
| Importable by Node | yes | no |
| Covered by tests | yes, directly | indirectly |

**Why.** A module that touches the DOM cannot be tested without a browser. Keeping the
logic free of both DOM and network means the test suite runs in plain Node in
milliseconds, and the thing being tested is exactly the code that ships. Twelve
modules are pure; nine are views.

```
PURE (no DOM, no network)        VIEWS (DOM + I/O)
audit.js                         check.js, spf.js
bl.js                            bl-ui.js
headers.js, headers-live.js      headers-ui.js
rua.js, unzip.js                 rua-ui.js
lookup.js                        lookup-ui.js
rfc.js                           rfc-ui.js, filter.js
warmup.js, warmup-pdf.js         warmup-ui.js
doh.js          <- I/O implementation, imported only by views
findings.js     <- shared output shape, imported by everything
```

### 3.2 The seam

Pure modules never import the thing that performs I/O. It is passed in as an argument.

```js
// bl.js, a pure module
export async function checkDomain(domain, lookup, lists, dqs, exists) { … }

// bl-ui.js, the view, supplies the real implementations
const r = resolver();                       // from doh.js
const lookup = async (n) => { try { return await r.a(n); } catch { return null; } };
await checkDomain(value, lookup, undefined, dqs, (d) => r.existence(d));
```

This is dependency injection, and it buys three things:

1. **Tests substitute a fake.** `parity-bl.mjs` passes a function returning canned DNS
   answers, so blocklist logic is tested against exact scenarios with no network.
2. **Failure is a value, not an exception.** The injected lookup returns `null` when a
   query could not be completed, which the logic treats as "could not determine"
   rather than as "not listed". The constraint in section 2 is enforced by the shape
   of the seam.
3. **Swapping the resolver is a one-line change**, because only the views know what a
   resolver is.

### 3.3 The shared output shape

`findings.js` defines one structure every tool emits:

```js
{ severity: 'critical' | 'warn' | 'info' | 'ok',
  owner:    'you' | 'intermediary' | 'receiver' | 'unknown',
  title, detail, fix, evidence, ref, scope }
```

It also owns the renderer, the ranking, the "fix these first" shortlist and the
plain-text serialiser. Before it existed, three tools had three different shapes for
the same idea and the phrasing drifted between them. `owner` is the unusual field: it
says whether a problem is the sender's, the receiver's, or an intermediary's.

---

## 4. Request lifecycle

### 4.1 A page

1. DNS resolves `rastu.tech` to a Cloudflare anycast address. **Anycast** means many
   machines worldwide share one address and the network routes each visitor to the
   nearest.
2. The visitor's connection terminates at that data centre. Cloudflare is **proxied**
   for this domain: it answers on the domain's behalf rather than forwarding to a
   server elsewhere. There is no server elsewhere.
3. Static Assets matches the path and returns the file. `html_handling` is
   `auto-trailing-slash`, so `/warmup` answers `307` redirecting to `/warmup/`, which
   serves `site/warmup/index.html`.
4. `_headers` rules are applied to the response.

The Worker does not run. This is configured explicitly: assets are matched before the
Worker is consulted.

### 4.2 A tool lookup

Most tools never reach step 2 below: DNS-over-HTTPS runs from the browser straight to
a public resolver, so a domain check or an SPF count involves this site not at all.
Only two operations require the Worker.

Guard chain for `/api/dnsbl`, in order. Each stage can end the request:

| # | Stage | Behaviour on failure |
|---|---|---|
| 1 | Rate limit, 12 per minute per address | `429`, wait a minute |
| 2 | Turnstile token verification | `403`, missing, reused or expired |
| 3 | Key present | reports "not configured" rather than guessing |
| 4 | Zone on the allow-list | `400`, unknown zone |
| 5 | Upstream query, batched | `null` means undetermined, never "clean" |

The ordering is deliberate: the cheapest rejection runs first, so an automated loop is
refused before any upstream work is done on its behalf.

### 4.3 Caching

Two layers, both configured in the Worker:

- **Response cache.** `cache-control: public, max-age=N`, defaulting to 300 seconds.
  Self-test probes use 3600 since a blocklist's own conformance changes rarely.
- **Upstream fetch cache.** Outgoing DNS queries carry
  `cf: { cacheTtl, cacheEverything: true }`, so Cloudflare caches the upstream answer
  at the edge. A popular domain is answered without a new query, which protects the
  Spamhaus allowance as much as it speeds anything up.

---

## 5. The Worker

229 lines. It exists because a browser refuses two specific things, both correctly.

| Endpoint | Purpose | Why the browser cannot |
|---|---|---|
| `/api/dnsbl` | Spamhaus blocklist queries | needs a private key, which would be readable if sent to the browser |
| `/api/mta-sts` | fetches a domain's mail security policy | cross-origin request, blocked by the same-origin policy |
| `/api/status` | reports which bindings are configured | diagnostic |

**Bindings** are resources Cloudflare hands the Worker at startup:

| Binding | Type | Value |
|---|---|---|
| `ASSETS` | static assets | the 266 built files |
| `DNSBL_LIMIT` | rate limiter | 12 requests per 60 seconds, per IP |
| `SPAMHAUS_DQS_KEY` | secret | Spamhaus query key, free tier, 100k/day |
| `TURNSTILE_SECRET` | secret | verifies the human challenge |

A **secret** is stored encrypted by Cloudflare, never appears in the repository, and is
never sent to a browser. Set with `npx wrangler secret put NAME`.

Two deliberate limitations worth knowing:

- **`/api/mta-sts` accepts a domain, never a URL.** It constructs the policy address
  itself. This is what stops the endpoint being used as an open proxy for arbitrary
  traffic, which is how a helpful public endpoint normally gets abused.
- **CORS is locked to one origin.** Responses carry
  `access-control-allow-origin: https://rastu.tech`, so another site cannot call these
  endpoints from a browser and spend the allowance.

---

## 6. Configuration

### 6.1 `wrangler.jsonc`

The whole hosting configuration is one file.

```jsonc
{
  "name": "rastu-tech",
  "main": "./worker/index.js",
  "compatibility_date": "2026-09-15",
  "ratelimits": [
    { "name": "DNSBL_LIMIT", "namespace_id": "1001",
      "simple": { "limit": 12, "period": 60 } }
  ],
  "assets": {
    "directory": "./site/",
    "binding": "ASSETS",
    "html_handling": "auto-trailing-slash",
    "not_found_handling": "404-page"
  }
}
```

| Field | What it does |
|---|---|
| `name` | the Worker's name on the Cloudflare account |
| `main` | entry point; the only server-side file |
| `compatibility_date` | pins runtime behaviour to that date, so Cloudflare changing a default later cannot silently alter behaviour |
| `ratelimits` | declares the limiter and its namespace; counted per colo and best-effort, not a global counter |
| `assets.directory` | what gets uploaded; the build's output directory |
| `assets.binding` | exposes the files to the Worker as `env.ASSETS` |
| `html_handling` | `/warmup` and `/warmup/` resolve to the same page |
| `not_found_handling` | unmatched paths serve `404.html`. This was declared long before a `404.html` was ever built, so until recently an unknown path returned a 404 with an empty body. The page now exists, carries `noindex,follow`, and is deliberately kept out of `sitemap.xml` |

The key consequence: **static assets are matched before the Worker runs.** Pages never
invoke it, which is what keeps page traffic off the metered path.

### 6.2 `site/_headers`

Generated by the build, not hand-written, because the Content Security Policy contains
hashes that change when inline scripts change.

```
/*
  Content-Security-Policy: default-src 'self'; script-src 'self'
    https://challenges.cloudflare.com 'sha256-…' 'sha256-…'; style-src 'self'
    'unsafe-inline'; img-src 'self'; connect-src 'self' https://cloudflare-dns.com
    https://dns.google https://challenges.cloudflare.com; frame-src 'self'
    https://challenges.cloudflare.com; font-src 'self'; object-src 'none';
    base-uri 'none'; form-action 'self'; frame-ancestors 'none';
    upgrade-insecure-requests
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
  X-Frame-Options: DENY
  Cross-Origin-Opener-Policy: same-origin
  Permissions-Policy: geolocation=(), microphone=(), camera=(), payment=(), …
  Strict-Transport-Security: max-age=31536000; includeSubDomains
```

| Directive | Effect |
|---|---|
| `default-src 'self'` | the fallback: anything not named below may load only from this site |
| `script-src` | scripts from this site plus Cloudflare's challenge; each inline script allowed by a hash of its exact contents, so altering one character stops it running |
| `connect-src` | outbound requests restricted to two public DNS resolvers and the challenge. This is the anti-exfiltration control: injected code would have nowhere to send data |
| `img-src 'self'` | no remote images, and no `data:` images |
| `object-src 'none'` | plugins forbidden entirely |
| `frame-ancestors 'none'` | the site cannot be embedded in another page, blocking clickjacking |
| `base-uri 'none'` | prevents rewriting the base address to redirect relative links |
| `Strict-Transport-Security` | browsers refuse an unencrypted connection to this domain for a year |

**A real consequence.** The warm-up planner's PDF is written by hand, roughly 400 lines,
because no external library can load under `script-src 'self'`, and the canvas route
those libraries use is blocked by `img-src 'self'`. The strictness is the point and the
hand-written PDF is the price.

### 6.3 `.github/workflows/rfc-refresh.yml`

One scheduled job, Mondays at 06:17 UTC, plus manual trigger.

```yaml
on:
  schedule:
    - cron: '17 6 * * 1'
  workflow_dispatch:
permissions:
  contents: write
```

Steps: snapshot the current index, rebuild from the RFC Editor's published index, diff,
rebuild the site (which runs every test), commit only if something moved, and report
new discovery candidates as a notice for a human to review.

**Why it exists.** An RFC being replaced is not announced to anyone. DMARC moved from
RFC 7489 to 9989, 9990 and 9991 and nothing anywhere said so; the site cited the
obsolete number until a build happened to notice. This job means the reference notices
on its own.

**Why it must not commit noise.** It briefly did: `rel_titles` was built by iterating a
Python set, whose order is not stable across processes, so identical content serialised
to different bytes every run and git saw a change. A job that cries wolf weekly is one
you stop reading. Sorting fixed it.

### 6.4 Domain and DNS

Three separate roles that are easy to conflate:

| Role | Who | What they do |
|---|---|---|
| Registrar | **Squarespace** | who the domain is bought from and renewed with |
| Registrar of record | **Tucows / OpenSRS** | Squarespace is not ICANN-accredited, so it resells through Tucows, which is what the public registry shows |
| DNS host | **Cloudflare** | the nameservers `megan.ns.cloudflare.com` and `reese.ns.cloudflare.com` |

At Squarespace the domain is pointed at Cloudflare's nameservers. From that point
Cloudflare controls where visitors are sent. The domain lives at Squarespace;
everything it does lives at Cloudflare.

Mail is separate again and does not touch this: MX records point at ProtonMail.

---

## 7. Build pipeline

One Python program produces everything. It uses only the standard library.

```
CONTENT GENERATORS                    ARTIFACT              CONSUMER
export_registry.py      ------>  registry.json (155 KB)  SMTP lookup
export_rfcs.py          ------>  rfcs.json (154 KB)      RFC pages
                        ------>  rfc/ (1.1 MB)           per-RFC requirements
export_rules.py         ------>  sift_rules.json         bounce classifier
export_career.py        ------>  career.json             about page, JSON-LD
export_audit_fixtures.py ----->  audit_fixtures.json     parity tests
ingest_logs.py          ------>  reference pages         from real bounce logs

                    build_site.py
                          |
                    site/  266 files
                    127 pages, 21 modules, _headers, sitemap.xml
```

The generators run rarely and their output is committed. `build_site.py` runs on every
change and is the only thing that has to pass before a deploy.

Two design points worth noting:

- **The RFC requirements are split out per document.** 3,600 requirement sentences are
  about a megabyte. Shipping them in the index would make every RFC page pay for data
  almost nobody opens, so the index stays small and each page fetches only its own.
- **The response registry is fetched, not inlined.** 155 KB that caches independently
  of the page and is only needed by one tool.

---

## 8. Quality gates

`build_site.py` refuses to produce a site it believes is wrong. Every gate exists
because something got through once.

| Gate | Enforces |
|---|---|
| Test suites | 595 assertions across ten suites, plus 37 recorded fixture scenarios |
| Module parsing | every shipped script parsed as the browser loads it, as a module |
| Entry point position | a module's `main()` call must be the last line, so nothing it reaches can be undeclared |
| Links | every internal link and script path resolves to a file that was built |
| Markup | no nested links or buttons; every class used in HTML exists in the stylesheet |
| Voice | fails on copy narrating its own method, on a competitor named as a source, and on em dashes |
| Navigation | the current-page marker may not change any link's size |
| CSP | recomputes inline script hashes so the policy cannot drift from the scripts |

The test strategy follows from section 3.1: because the logic is pure, the suites are
plain Node scripts that import the shipped module directly. There is no test framework
and no browser automation in the build.

---

## 9. Security model

Layered, each independent of the others.

**Nothing to steal.** The tools run client-side, so there is no user data at rest, no
sessions, no accounts, no database. The largest category of breach does not apply.

**Secrets never leave Cloudflare.** Held as encrypted bindings, absent from the
repository, never serialised into a response.

**Input is constrained by shape.** The Worker takes a domain, not a URL, and the zone
must be on an allow-list. There is no parameter that accepts an arbitrary destination.

**Abuse is controlled in depth.** Rate limit first, then a challenge whose token is
single-use, then a bounded upstream query. CORS locks the endpoints to this origin.

**The browser enforces the rest.** The CSP means that even if a script were somehow
injected, `connect-src` gives it nowhere to send what it found.

**Degradation is toward saying less.** A failed lookup returns `null`, which surfaces
as "could not determine". Nothing in the system converts a failure into a clean result.

---

## 10. Failure modes

| What fails | What happens | Visitor sees |
|---|---|---|
| Public DNS resolver unreachable | client-side lookups fail | "could not determine", never a verdict |
| Worker over its daily allowance | Cloudflare stops serving it | pages fine, blocklist says not checked |
| Spamhaus key missing or rejected | endpoint reports unconfigured | that list marked not checked, others still run |
| Turnstile unreachable | token empty, Worker returns 403 | Spamhaus row not checked, rest of the check completes |
| A blocklist zone dead or wildcarded | self-test catches it | that list reported unusable rather than clean |
| Build gate fails | deploy never starts | nothing changes; the live site is the last good build |
| Cloudflare edge outage | site unreachable | no fallback; accepted trade-off for a free single-provider design |

The last row is the honest one. There is no multi-provider failover, and adding one
would cost money and complexity out of proportion to what this is.

---

## 11. Limits and headroom

| Resource | Limit | Current use |
|---|---|---|
| Static asset requests | unlimited | all page traffic |
| Worker invocations | 100,000/day | three endpoints, button-triggered only |
| Worker CPU | 10 ms per invocation | DNS queries are I/O, not CPU |
| Rate limiter | 12/min per IP | ~17,280/day is one visitor's theoretical ceiling |
| Spamhaus DQS | 100,000 queries/day | one query per check, cached |
| Turnstile | unlimited | one widget |
| Workers Builds | 3,000 min/month | roughly one minute per deploy |

**The free plan does not auto-upgrade.** If the Worker exhausted its allowance,
Cloudflare stops serving it rather than billing. Pages keep working because pages do
not use it. That is the structural answer to "no surprise bills": the expensive path is
the narrow one.

---

## 12. Glossary

| Term | Meaning |
|---|---|
| anycast | one network address shared by machines worldwide, each visitor routed to the nearest |
| binding | a resource Cloudflare hands a Worker at startup: file store, rate limiter, secret |
| compatibility date | a pinned runtime version, so platform changes cannot silently alter behaviour |
| continuous deployment | publishing triggered by pushing a change rather than by a manual step |
| CORS | browser rules deciding which other sites may call an endpoint |
| CSP | Content Security Policy: a list, sent with every page, of what that page may load |
| dependency injection | passing a capability in as an argument instead of importing it, so tests can substitute a fake |
| DNS | the system turning a name into a network address |
| DNS-over-HTTPS | DNS queries sent as ordinary web requests, which is how a browser can make them at all |
| edge | Cloudflare's data centres near visitors, as opposed to one central server |
| ES module | the standard way of splitting JavaScript across files that import each other |
| hash | a fingerprint of a file's exact contents; one character changes it |
| HSTS | an instruction to refuse unencrypted connections to a domain in future |
| nameserver | the machine answering DNS questions for a domain |
| proxied | Cloudflare answering on the domain's behalf rather than forwarding elsewhere |
| pure module | code with no DOM and no I/O, therefore testable in plain Node |
| rate limit | a cap on requests per visitor per period |
| registrar | the company a domain is registered and renewed through |
| registry | the organisation running an ending such as `.tech` and keeping the official record |
| reseller | a company selling domains through an accredited registrar rather than being accredited itself |
| same-origin policy | the browser rule stopping a page reading another site's content |
| secret | a key stored encrypted by the platform, never in code, never sent to a browser |
| static site | every page a finished file prepared in advance |
| Turnstile | Cloudflare's human check, usually invisible |
| Worker | a small program Cloudflare runs at the edge, charged per invocation |

---

## Source of record

| Question | File |
|---|---|
| How is it hosted | `wrangler.jsonc` |
| What runs server-side | `worker/index.js` |
| What is served | `build/build_site.py` |
| What headers are sent | `site/_headers`, generated by the build |
| What runs on a schedule | `.github/workflows/rfc-refresh.yml` |
| What is tested | `build/parity-*.mjs` |
