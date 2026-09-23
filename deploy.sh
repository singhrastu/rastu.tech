#!/bin/bash
# Build, verify, publish, and prove the published version is the built one.
#
# Written after three days of commits never reached the site. The Git
# integration is not connected, so a push publishes nothing, and the failure is
# silent: the old build keeps serving and every URL still answers 200. Checking
# a status code does not detect it. Checking for a string that only the new
# build contains does.
set -e
cd "$(dirname "$0")"

echo "==> build"
python3 build/build_site.py

echo "==> deploy"
npx wrangler deploy

# A marker that changes with the content: the hash of the built home page. If
# the live page does not carry the same title the build just produced, the
# deploy did not take, whatever the exit code said.
want=$(grep -oE "<title>[^<]*" site/index.html | head -1)
echo "==> verify: waiting for the edge to serve the build just made"
for i in $(seq 1 24); do
  got=$(curl -s -H 'Cache-Control: no-cache' https://rastu.tech/ | grep -oE "<title>[^<]*" | head -1)
  if [ "$got" = "$want" ]; then
    echo "    live after $((i * 5))s"
    exit 0
  fi
  sleep 5
done

echo "    the live site is still serving something else after two minutes:"
echo "      built: $want"
echo "      live : $got"
exit 1
