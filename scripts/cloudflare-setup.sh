#!/usr/bin/env bash
# One-time Cloudflare setup for Sagebrush releases, using the `cf` CLI
# (logged in with `cf auth login`, scopes as in the PR/chat).
#
#   bash scripts/cloudflare-setup.sh            # dry run: print every API request
#   bash scripts/cloudflare-setup.sh --apply    # do it
#
# Creates:
#   1. R2 bucket sagebrush-releases (location hint: western North America)
#   2. https://get.sagebrush.space -> that bucket (public read, TLS >= 1.2)
#   3. CORS on the bucket: GET/HEAD from any origin (browsers may load
#      the bundles and WASM directly), and a lifecycle rule deleting dev/
#      builds after 30 days
#   4. An account API token that can only read/write objects in that one
#      bucket, stored as GitHub Actions secrets R2_ACCOUNT_ID,
#      R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY for sagemathinc/sagebrush.
#      The token value is never printed or written to disk: the S3 secret
#      is its SHA-256, piped straight into `gh secret set`.
set -euo pipefail
export NO_COLOR=1 CF_SEND_TELEMETRY=false

ACCOUNT=bf59ea74a28f5bf3c2679e78f6db1205 # Office@sagemath.com's Account
ZONE=c4bc91ee14008bcbfaf61d1116fc066f    # sagebrush.space
BUCKET=sagebrush-releases
DOMAIN=get.sagebrush.space
REPO=sagemathinc/sagebrush
# Permission groups "Workers R2 Storage Bucket Item Write" and "... Read".
PG_WRITE=2efd5506f9c8494dacb1fa10a3e7d5b6
PG_READ=6a018a9f2fc74eb6b293b0c548f38b39

apply=false
[ "${1:-}" = "--apply" ] && apply=true
dry=(--dry-run)
$apply && dry=()
quiet() { grep -v '^--\|^Telemetry\|^Saving to cache' || true; }

echo "== 1. bucket $BUCKET"
if cf r2 buckets get "$BUCKET" >/dev/null 2>&1; then
  echo "exists"
else
  cf r2 buckets create --name "$BUCKET" --location-hint wnam "${dry[@]}" 2>&1 | quiet
fi

echo "== 2. custom domain $DOMAIN"
cf r2 buckets domains custom create "$BUCKET" --domain "$DOMAIN" --zone-id "$ZONE" --enabled --min-tls 1.2 "${dry[@]}" 2>&1 | quiet

echo "== 3. CORS"
cf r2 buckets cors update "$BUCKET" --force "${dry[@]}" \
  --rules '[{"allowed":{"origins":["*"],"methods":["GET","HEAD"],"headers":["*"]},"maxAgeSeconds":86400}]' 2>&1 | quiet

echo "== 3b. lifecycle: dev/ builds expire after 30 days (keeps Cloudflare's multipart rule)"
cf r2 buckets lifecycle update "$BUCKET" --force "${dry[@]}" \
  --rules '[{"id":"Default Multipart Abort Rule","enabled":true,"conditions":{},"abortMultipartUploadsTransition":{"condition":{"type":"Age","maxAge":604800}}},{"id":"Expire dev builds after 30 days","enabled":true,"conditions":{"prefix":"dev/"},"deleteObjectsTransition":{"condition":{"type":"Age","maxAge":2592000}}}]' 2>&1 | quiet

echo "== 4. bucket-scoped token -> GitHub Actions secrets"
policies="[{\"effect\":\"allow\",\"resources\":{\"com.cloudflare.edge.r2.bucket.${ACCOUNT}_default_${BUCKET}\":\"*\"},\"permission_groups\":[{\"id\":\"$PG_WRITE\"},{\"id\":\"$PG_READ\"}]}]"
if ! $apply; then
  cf accounts tokens create --name "sagebrush-releases CI (R2 $BUCKET only)" --policies "$policies" --dry-run 2>&1 | quiet
  echo "(then: gh secret set R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY --repo $REPO, values never printed)"
  exit 0
fi
out=$(cf accounts tokens create --name "sagebrush-releases CI (R2 $BUCKET only)" --policies "$policies" 2>/dev/null | quiet)
id=$(printf '%s' "$out" | python3 -c 'import sys,json; d=json.load(sys.stdin); d=d.get("result",d); print(d["id"])')
printf '%s' "$out" | python3 -c 'import sys,json,hashlib; d=json.load(sys.stdin); d=d.get("result",d); sys.stdout.write(hashlib.sha256(d["value"].encode()).hexdigest())' | gh secret set R2_SECRET_ACCESS_KEY --repo "$REPO"
unset out
printf '%s' "$id" | gh secret set R2_ACCESS_KEY_ID --repo "$REPO"
printf '%s' "$ACCOUNT" | gh secret set R2_ACCOUNT_ID --repo "$REPO"
echo "token created and stored as GitHub secrets (access key id ends ...${id: -4})"
