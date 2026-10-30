#!/usr/bin/env bash
# webview-provider.py on fixed `dumpsys webviewupdate` texts (app/selftest/webview-fixtures),
# expecting com.android.webview 158.0.7500.0: each must give its exit code, so a
# checker that accepts a fallback, a near version or no data can't pass.
#   bash app/selftest/test-webview-provider.sh
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
F="$HERE/webview-fixtures"
bad=0
check() {
  local want=$1 file=$2 rc=0
  python3 -I "$HERE/webview-provider.py" "$F/$file" com.android.webview 158.0.7500.0 > /tmp/webview-provider-test.out 2>&1 || rc=$?
  if [ "$rc" = "$want" ]; then echo "ok   $file -> $rc"; else echo "FAIL $file -> $rc, expected $want:"; cat /tmp/webview-provider-test.out; bad=1; fi
}
check 0 selected.txt
check 0 crlf.txt
check 1 wrong-version.txt
check 1 fallback.txt
check 2 missing.txt
check 2 empty.txt
check 2 twice.txt
check 2 no-such-file.txt
rc=0; python3 -I "$HERE/webview-provider.py" "$F/selected.txt" com.android.webview 158 > /dev/null 2>&1 || rc=$?
if [ "$rc" = 2 ]; then echo "ok   a malformed expected version -> 2"; else echo "FAIL a malformed expected version -> $rc, expected 2"; bad=1; fi
[ "$bad" = 0 ] || { echo "FAIL: the WebView provider checker"; exit 1; }
echo "ok: the WebView provider checker gives every fixture its expected result"
