"""Refuse to deploy a build that has lost the private operator pages.

The pages under private/ are gitignored (their paths are the first gate and the
repo is public), so a deploy from a clean checkout or another machine publishes
a site without them and nothing else notices: every public page still answers
200. Wrangler runs this before every deploy (wrangler.jsonc "build"), so a bare
`npx wrangler deploy` is covered too, not only deploy.sh.
"""
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PRIV = os.path.join(ROOT, "private")
SITE = os.path.join(ROOT, "site")


def fail(msg):
    print("check_private: " + msg, file=sys.stderr)
    print("check_private: deploy only from the working copy that holds private/.",
          file=sys.stderr)
    sys.exit(1)


pages = []
if os.path.isdir(PRIV):
    pages = [d for d in sorted(os.listdir(PRIV))
             if os.path.isfile(os.path.join(PRIV, d, "index.html"))]
if not pages:
    fail("private/ is missing or empty, so this deploy would drop the private pages.")

for d in pages:
    if not os.path.isfile(os.path.join(SITE, d, "index.html")):
        fail("site/ lacks a private page; run python3 build/build_site.py first.")

print("check_private: %d private page(s) present" % len(pages))
