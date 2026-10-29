#!/usr/bin/env bash
# No build or publication occurs unless this script is explicitly invoked.
set +x
set -euo pipefail
preview_script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
exec node "$preview_script_dir/preview/publish.mjs" "$@"
