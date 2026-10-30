"""webview-provider.py DUMPSYS PACKAGE VERSION: does `adb shell dumpsys
webviewupdate` say the CURRENT WebView provider is exactly PACKAGE at exactly
VERSION?  For app-mobile-selftest.yml's current-WebView leg
(app/selftest/android-sideload-webview.sh), before the self-test and again
after it, so a run that silently fell back to the image's own WebView, or ran
on another version, can't count as the current engine's answer.

Exit 0: it is (prints "ok: ..."); 1: another package or version (prints both);
2: the dump has no "Current WebView package (name, version): (P, V)" line, or
VERSION/PACKAGE are malformed, so it can't be judged.
app/selftest/test-webview-provider.sh runs it on fixed dumps."""
import re
import sys

CURRENT = re.compile(r"Current WebView package \(name, version\): \(([A-Za-z0-9_.]+), ([0-9][0-9.]*)\)")
PKG = re.compile(r"^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)+$")
VER = re.compile(r"^[0-9]+(\.[0-9]+){1,3}$")


def main(path, package, version):
    if not PKG.match(package) or not VER.match(version):
        print(f"webview-provider: bad expectation {package!r} {version!r}")
        return 2
    try:
        text = open(path, encoding="utf-8", errors="replace").read().replace("\r", "")
    except OSError as e:
        print(f"webview-provider: can't read {path}: {e}")
        return 2
    found = CURRENT.findall(text)
    if len(found) != 1:
        print(f"webview-provider: {len(found)} 'Current WebView package' lines in {path}, need exactly 1")
        return 2
    got_pkg, got_ver = found[0]
    if (got_pkg, got_ver) != (package, version):
        print(f"FAIL: the current WebView is {got_pkg} {got_ver}, not {package} {version}")
        return 1
    print(f"ok: the current WebView is {package} {version}")
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 4:
        print("usage: webview-provider.py DUMPSYS PACKAGE VERSION")
        sys.exit(2)
    sys.exit(main(*sys.argv[1:]))
