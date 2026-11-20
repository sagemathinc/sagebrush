#!/usr/bin/env bash
# The whitespace's rough alpha as a static site: the whole Sagebrush site (the Agents page, its workspace, the engine)
# with the space viewer at /space/, built into web/dist, ready for a static host such as Cloudflare Pages. Run from
# anywhere in a checkout of space-prototype; needs node, pnpm and bun (1.3 or later). Nothing is deployed here.
#   space/build-alpha.sh
set -euo pipefail
cd "$(dirname "$0")/.."

pnpm install --frozen-lockfile
node scripts/wasm-fetch.mjs          # the engine's WebAssembly, by its pins
pnpm run build                       # dist/ (TypeScript), which the CLI's bundle and the site need
node scripts/build-cli.mjs           # build/cli, which web/build.ts checks it is current
rm -rf web/dist                      # (from clean: nothing of an older build is deployed)
bun web/build.ts                     # the site, into web/dist
(cd space && npm ci && node build.mjs --site ../web/dist)
bun web/csp.ts                       # web/dist/_headers: COOP/COEP everywhere, each page's CSP, /space/ included

# an alpha isn't for search engines
printf 'User-agent: *\nDisallow: /\n' > web/dist/robots.txt
rm -f web/dist/sitemap.xml

# checks: the parts the alpha needs, and a static host's limits (Cloudflare Pages: 25 MiB a file, 20,000 files)
fail() { echo "build-alpha: $*" >&2; exit 1; }
grep -q space-frame web/dist/agents/agents.js || fail "the Agents page was built without the space"
[ -f web/dist/space/index.html ] && [ -f web/dist/space/space.js ] && [ -f web/dist/space/format.md ] || fail "web/dist/space is incomplete"
[ -f web/dist/sagebrush-worker.js ] && [ -f web/dist/sagebrush-notebook.js ] && [ -f web/dist/sagebrush-math.js ] || fail "the engine's scripts are missing"
ls web/dist/engine/*/ >/dev/null 2>&1 || fail "web/dist/engine has no engine"
grep -q '^/space/\*' web/dist/_headers || fail "_headers has no rule for /space/"
grep -q 'Cross-Origin-Embedder-Policy: require-corp' web/dist/_headers || fail "_headers lacks COEP"
big=$(find web/dist -type f -size +25M | head -1)
[ -z "$big" ] || fail "$big is over 25 MiB"
n=$(find web/dist -type f | wc -l)
[ "$n" -le 20000 ] || fail "$n files (over 20,000)"
echo "build-alpha: web/dist ready: $n files, $(du -sh web/dist | cut -f1), commit $(git rev-parse --short HEAD)"
