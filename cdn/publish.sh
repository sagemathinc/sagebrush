#!/usr/bin/env bash
# Publish cdn/ to npm as sagebrush-web, using the NPM_TOKEN project secret
# (a file under $COCALC_SECRETS; the token is never printed or written to
# disk outside a temporary npmrc that is deleted on exit).
#   bash cdn/publish.sh            # publish the version in package.json
#   bash cdn/publish.sh --dry-run
set -euo pipefail
cd "$(dirname "$0")"
secret="${COCALC_SECRETS:-/run/secrets/cocalc}/NPM_TOKEN"
[ -r "$secret" ] || { echo "missing project secret NPM_TOKEN ($secret)"; exit 1; }
rc=$(mktemp)
trap 'rm -f "$rc"' EXIT
printf '//registry.npmjs.org/:_authToken=%s\n' "$(tr -d '[:space:]' < "$secret")" > "$rc"
chmod 600 "$rc"
npm --userconfig "$rc" whoami
npm --userconfig "$rc" publish "$@"
