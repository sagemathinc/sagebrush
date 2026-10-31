"""webview-badging.py BADGING MAX_MIN_SDK: is `aapt2 dump badging` of the pinned
WebView APK (app-mobile-selftest.yml's current-WebView leg) the build we
expect: package com.android.webview, x86_64 native code, a minimum SDK at or
below MAX_MIN_SDK (the emulator's API level), and a versionName?

Exit 0: prints "VERSION=<versionName>" (the workflow passes it on as the
expected provider version) and a summary line; 1: the APK is not what we
expect (a named reason); 2: the badging can't be read or a field is missing (a
named reason).  On 1 and 2 it prints the badging's package and sdk lines, so
the cause shows in the log.  The minimum SDK line is `sdkVersion:'N'` (aapt)
or `minSdkVersion:'N'`; both are accepted, nothing else.
app/selftest/test-webview-badging.sh runs it on fixed badgings."""
import re
import sys

PACKAGE = re.compile(r"^package: name='([^']+)' versionCode='([0-9]+)' versionName='([^']*)'")
MIN_SDK = re.compile(r"^(?:min)?[sS]dkVersion:'([0-9]+)'\s*$")
NATIVE = re.compile(r"^native-code:(.*)$")
VERSION = re.compile(r"^[0-9]+(\.[0-9]+){1,3}$")


def show(lines):
    print("--- the badging's package, sdk and native-code lines:")
    for line in lines:
        if line.startswith("package:") or "dk" in line.split(":", 1)[0] or line.startswith("native-code"):
            print("  " + line)


def main(path, max_min):
    try:
        lines = open(path, encoding="utf-8", errors="replace").read().replace("\r", "").split("\n")
    except OSError as e:
        print(f"webview-badging: can't read {path}: {e}")
        return 2
    if not max_min.isdigit():
        print(f"webview-badging: MAX_MIN_SDK {max_min!r} is not a number")
        return 2
    pkg = [m for m in map(PACKAGE.match, lines) if m]
    mins = [m for m in map(MIN_SDK.match, lines) if m]
    natives = [m for m in map(NATIVE.match, lines) if m]

    def fail(code, why):
        print(f"FAIL: {why}")
        show(lines)
        return code

    if len(pkg) != 1:
        return fail(2, f"{len(pkg)} 'package:' lines in the badging, need exactly 1")
    name, _, version = pkg[0].groups()
    if name != "com.android.webview":
        return fail(1, f"the APK's package is {name}, not com.android.webview")
    if not VERSION.match(version):
        return fail(2, f"no usable versionName in the badging ({version!r})")
    if len(mins) != 1:
        return fail(2, f"{len(mins)} minimum-SDK lines (sdkVersion/minSdkVersion) in the badging, need exactly 1")
    min_sdk = int(mins[0].group(1))
    if min_sdk > int(max_min):
        return fail(1, f"the APK's minSdk {min_sdk} is above {max_min}")
    if len(natives) != 1:
        return fail(2, f"{len(natives)} 'native-code:' lines in the badging, need exactly 1")
    if "'x86_64'" not in natives[0].group(1).split():
        return fail(1, f"the APK has no x86_64 code ({natives[0].group(1).strip()})")
    print(f"VERSION={version}")
    print(f"ok: com.android.webview {version}, minSdk {min_sdk}, native-code:{natives[0].group(1)}")
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print("usage: webview-badging.py BADGING MAX_MIN_SDK")
        sys.exit(2)
    sys.exit(main(*sys.argv[1:]))
