"""The iOS simulator self-test's judgments on host-side text
(app/selftest/ios-selftest.sh, .github/workflows/app-ios-selftest.yml), each
a closed grammar, fixture-tested (test-ios-judge.sh):

    python3 -I app/selftest/ios-judge.py udid TEXT
        TEXT (simctl create's output) is exactly one UDID: print it, exit 0.
    python3 -I app/selftest/ios-judge.py codesign FILE
        FILE is `codesign -dv <app>`'s output: exit 0 if the app is unsigned
        or ad hoc signed (no team, no certificate authority), else 1.
    python3 -I app/selftest/ios-judge.py running FILE BUNDLE_ID
        FILE is `simctl spawn <udid> launchctl list`: exit 0 if BUNDLE_ID's
        app has a running process (a PID), 1 if it has none.
    python3 -I app/selftest/ios-judge.py tree STATUS GENERATED BUILT EXTRA
        After the build, STATUS is `git status --porcelain
        --untracked-files=all -- app/src-tauri/gen/apple`.  The one change
        allowed is the Tauri CLI's merge of EXTRA (app/src-tauri/Info.ios.plist)
        into gen/apple/sagebrush-app_iOS/Info.plist: BUILT (that file now)
        must parse as exactly GENERATED (the committed one) with EXTRA's keys
        set.  Any other change under gen/apple, or any other difference,
        fails.  (It may also be unchanged.)

Exit 2: unreadable or malformed input.
"""
import plistlib
import re
import sys

INFO_PLIST = "app/src-tauri/gen/apple/sagebrush-app_iOS/Info.plist"
UDID = re.compile(r"[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}")


def fail(code, msg):
    print(("FAIL: " if code == 1 else "ERROR: ") + msg)
    sys.exit(code)


def read(path):
    try:
        with open(path, encoding="utf-8") as f:
            return f.read()
    except OSError as e:
        fail(2, f"can't read {path}: {e}")


def load_plist(path):
    try:
        with open(path, "rb") as f:
            d = plistlib.load(f)
    except (OSError, plistlib.InvalidFileException, ValueError) as e:
        fail(2, f"{path} is not a property list: {e}")
    if not isinstance(d, dict):
        fail(2, f"{path} is not a dictionary property list")
    return d


def udid(text):
    t = text.strip()
    if not UDID.fullmatch(t):
        fail(1, f"not one UDID: {t[:120]!r}")
    print(t)


def codesign(path):
    lines = read(path).splitlines()
    if not lines:
        fail(2, "empty codesign output")
    if any("code object is not signed at all" in l for l in lines):
        print("ok: not signed")
        return
    authority = [l for l in lines if l.startswith("Authority=")]
    team = [l.split("=", 1)[1] for l in lines if l.startswith("TeamIdentifier=")]
    adhoc = any(l.strip() == "Signature=adhoc" for l in lines)
    if authority or any(t != "not set" for t in team) or not adhoc:
        fail(1, f"signed with an identity (adhoc={adhoc}, team={team}, authority={authority})")
    print("ok: ad hoc signature, no team, no authority")


def running(path, bundle):
    lines = read(path).splitlines()
    if not lines or not re.match(r"PID\s+Status\s+Label", lines[0]):
        fail(2, "not `launchctl list` output (no PID Status Label header)")
    label = re.compile(r"UIKitApplication:" + re.escape(bundle) + r"\[")
    rows = [l.split(None, 2) for l in lines[1:] if l.strip()]
    mine = [r for r in rows if len(r) == 3 and label.match(r[2])]
    if any(r[0].isdigit() for r in mine):
        print(f"ok: {bundle} is running (pid {[r[0] for r in mine if r[0].isdigit()][0]})")
        return
    fail(1, f"{bundle} has no running process ({len(mine)} entries)")


def tree(status_path, generated, built, extra):
    changed = [l for l in read(status_path).splitlines() if l.strip()]
    other = [l for l in changed if l != f" M {INFO_PLIST}"]
    if other:
        fail(1, "the build changed gen/apple beyond Info.plist: " + "; ".join(other[:10]))
    g, b, e = load_plist(generated), load_plist(built), load_plist(extra)
    want = dict(g)
    want.update(e)
    if b == g and not changed:
        print("ok: gen/apple unchanged by the build")
        return
    if b != want:
        diffs = sorted(k for k in set(want) | set(b) if want.get(k) != b.get(k))
        fail(1, f"Info.plist after the build is not the generated one plus Info.ios.plist's keys; keys differing: {diffs}")
    print(f"ok: the only change is Info.plist = generated + Info.ios.plist ({sorted(e)})")


def main(argv):
    if len(argv) == 2 and argv[0] == "udid":
        udid(argv[1])
    elif len(argv) == 2 and argv[0] == "codesign":
        codesign(argv[1])
    elif len(argv) == 3 and argv[0] == "running":
        running(argv[1], argv[2])
    elif len(argv) == 5 and argv[0] == "tree":
        tree(*argv[1:])
    else:
        print("usage: ios-judge.py udid TEXT | codesign FILE | running FILE BUNDLE_ID | tree STATUS GENERATED BUILT EXTRA", file=sys.stderr)
        sys.exit(2)


main(sys.argv[1:])
