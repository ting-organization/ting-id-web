#!/bin/sh
# Assembles the wallet as it is published, in _site/: web/ at the top, the
# kit's page modules at kit/web/, where web/js/ imports them from
# (../../kit/web/ from /js/ is /kit/web/). Nothing else of the repository is
# published: not the program, the scripts, nor a development chain's ids.
set -e
cd "$(dirname "$0")/.."
rm -rf _site
mkdir -p _site/kit
cp -R web/. _site/
cp -R kit/web _site/kit/web
rm -f _site/dev-chain.json
node scripts/check-site.mjs _site
