#!/usr/bin/env bash
# webview-badging.py on fixed `aapt2 dump badging` texts (app/selftest/badging-fixtures,
# their package line taken from CI run 41084241458), with MAX_MIN_SDK 34: each must
# give its exit code, so a parse that finds nothing can't pass as "above 34" or as ok.
#   bash app/selftest/test-webview-badging.sh
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
F="$HERE/badging-fixtures"
bad=0
check() {
  local want=$1 file=$2 grepfor=$3 rc=0
  python3 -I "$HERE/webview-badging.py" "$F/$file" 34 > /tmp/webview-badging-test.out 2>&1 || rc=$?
  if [ "$rc" = "$want" ] && grep -q -F -- "$grepfor" /tmp/webview-badging-test.out; then echo "ok   $file -> $rc ($grepfor)"
  else echo "FAIL $file -> $rc, expected $want with '$grepfor':"; cat /tmp/webview-badging-test.out; bad=1; fi
}
check 0 min-sdk-version.txt "VERSION=158.0.8127.0"
check 0 sdk-version.txt "VERSION=158.0.8127.0"
check 2 no-min-sdk.txt "0 minimum-SDK lines"
check 1 min-sdk-35.txt "minSdk 35 is above 34"
check 1 no-x86-64.txt "no x86_64 code"
check 1 other-package.txt "not com.android.webview"
check 2 no-version.txt "no usable versionName"
check 2 two-min-sdk.txt "2 minimum-SDK lines"
check 2 empty.txt "0 'package:' lines"
check 2 no-such-file.txt "can't read"
[ "$bad" = 0 ] || { echo "FAIL: the WebView badging parser"; exit 1; }
echo "ok: the WebView badging parser gives every fixture its expected result"
