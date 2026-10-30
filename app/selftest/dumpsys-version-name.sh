#!/usr/bin/env bash
# The first versionName= in a `dumpsys package <pkg>` text (CR already removed);
# prints nothing when there is none, and the caller's version check names it.
#   bash app/selftest/dumpsys-version-name.sh /tmp/webview-package.txt
set -euo pipefail
sed -n '/^ *versionName=/{s///;p;q}' "${1:?dumpsys file}"
