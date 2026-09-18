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
