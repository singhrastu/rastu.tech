# Deploying to Cloudflare Pages

The built site is committed under `site/`, so Pages needs **no build step**. That removes any
dependency on Cloudflare's Python build environment.

## One-time setup (dashboard, about two minutes)

1. Cloudflare dashboard → **Workers & Pages** → **Create** → **Pages** → **Connect to Git**
2. Authorise GitHub, pick **`singhrastu/rastu.tech`**
3. Settings:
   - Production branch: `main`
   - Framework preset: **None**
   - Build command: **leave empty**
   - Build output directory: **`site`**
4. Save and Deploy
5. Once it deploys → **Custom domains** → add `rastu.tech` and `www.rastu.tech`

DNS is already on Cloudflare (megan/reese.ns.cloudflare.com), so adding the custom domain
creates the records automatically. No manual A record, and no API token needed.

## Publishing changes afterwards

```sh
cd ~/Documents/Projects/rastu.tech
python3 build/build_site.py     # regenerate from build/codes.py
git add -A && git commit -m "..." && git push
```

Pages redeploys on push.

## Adding a new SMTP reference page

Append an entry to `build/codes.py` and rebuild. Every field is required except `note`
and `provider` (omit `provider` for RFC-generic responses).

## Feeding real bounce logs into the classifier

The classifier is an ordered list of regexes, first match wins. Nothing here is
trained and nothing should be: a classifier you cannot explain is worse than none
when its output decides whether to keep sending. What real logs buy is coverage.

```
python3 build/ingest_logs.py /var/log/maillog /path/to/acct-*.csv --out coverage.md
```

Reads PowerMTA accounting CSV, Postfix/maillog text, KumoMTA JSON lines, or any
text with SMTP responses in it. Everything stays local: addresses, IPs, message
and queue IDs are stripped before counting, and no raw log line reaches the
output. **Never commit logs to this repository.**

The report answers three questions:

1. **What share of responses matched a rule.** Anything under ~90% means the
   ruleset has real gaps.
2. **Which responses fell through to `unknown`,** ranked by frequency. That list
   is the next set of rules, in priority order. Add them to
   `smtpsift/rules.py`, add a test, then `python3 build/export_rules.py`.
3. **Which enhanced status codes have no reference page.** That list is the next
   set of pages for `build/codes.py`, ranked by how often operators actually see
   them, which is exactly the ranking search demand follows.

After changing rules or codes: `python3 build/export_rules.py && python3
build/build_site.py && npx wrangler deploy && python3 build/submit_indexnow.py`.

## Keeping the site and the tools in step

Three things are generated rather than retyped, because two copies of the same
fact always drift:

| Generated file | From | Regenerate with |
|---|---|---|
| `build/sift_rules.json` | `smtpsift/rules.py` | `python3 build/export_rules.py` |
| `build/career.json` | `~/Documents/Resume/resume_content.py` | `python3 build/export_career.py` |
| `build/audit_fixtures.json` | the `dmarcsight` test scenarios | `python3 build/export_audit_fixtures.py` |

`build/js/audit.js` is a hand port of `dmarcsight/checks.py`. It is not
generated, so `build/parity.mjs` replays every fixture scenario against it on
each build and fails the build if a single finding differs. If you change the
Python checks, re-export the fixtures and fix the port until parity passes.
