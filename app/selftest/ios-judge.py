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
    python3 -I app/selftest/ios-judge.py tree STATUS
        After a build, STATUS is `git status --porcelain --untracked-files=all
        -- app/src-tauri/gen/apple`: it must be EMPTY.  The committed tree is
        what the Tauri CLI's build leaves (its project sync and plist merge
        included), so any change or new file fails.
    python3 -I app/selftest/ios-judge.py bundle PLIST EXTRA CONF
        PLIST is the BUILT app's Info.plist (what the app will run with):
        every key of EXTRA (Info.ios.plist) must be in it with exactly
        EXTRA's value (typed, nested); CFBundleDocumentTypes must be exactly
        the file types CONF (tauri.conf.json bundle.fileAssociations) declares,
        as the Tauri CLI writes them (extensions, name, role, LSHandlerRank
        Default), in order; and it must not declare
        ITSAppUsesNonExemptEncryption (William's answer at the first upload,
        not the simulator build's).
Values are compared with their types (a boolean true is not the integer 1).

Each prints one outcome line, "ok: …", "FAIL: …" or "ERROR: …" (udid's
"ok" is the UDID itself).  Exit 2: unreadable or malformed input; exit 3:
the judge itself broke (an unexpected exception), never mistaken for a FAIL.
"""
import json
import plistlib
import re
import sys

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


def same(a, b):
    """Equal with the same types all the way down (plistlib gives True and 1
    as bool and int, which == alone does not tell apart)."""
    if type(a) is not type(b):
        return False
    if isinstance(a, dict):
        return a.keys() == b.keys() and all(same(a[k], b[k]) for k in a)
    if isinstance(a, list):
        return len(a) == len(b) and all(same(x, y) for x, y in zip(a, b))
    return a == b


def udid(text):
    t = text.strip()
    if not UDID.fullmatch(t):
        fail(1, f"not one UDID: {t[:120]!r}")
    print(t)


def codesign(path):
    """Closed alternatives: (a) unsigned: one line, "<path>: code object is
    not signed at all", and nothing else; (b) ad hoc: "Signature=adhoc" and
    "TeamIdentifier=not set" each exactly once, no "Authority=" line and no
    "not signed" line.  Anything else, including a mix, fails."""
    lines = [l for l in read(path).splitlines() if l.strip()]
    if not lines:
        fail(2, "empty codesign output")
    unsigned = [l for l in lines if l.endswith(": code object is not signed at all")]
    if unsigned:
        if len(lines) == 1:
            print("ok: not signed")
            return
        fail(1, f"'not signed' together with {len(lines) - 1} other lines (contradictory)")
    authority = [l for l in lines if l.startswith("Authority=")]
    sig = [l for l in lines if l.startswith("Signature=")]
    team = [l for l in lines if l.startswith("TeamIdentifier=")]
    if authority or sig != ["Signature=adhoc"] or team != ["TeamIdentifier=not set"]:
        fail(1, f"not an ad hoc signature without a team (signature={sig}, team={team}, authority={authority})")
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


def tree(status_path):
    changed = [l for l in read(status_path).splitlines() if l.strip()]
    if changed:
        fail(1, f"the build changed gen/apple ({len(changed)}): " + "; ".join(changed[:10]))
    print("ok: gen/apple is exactly as committed after the build")


def doc_types(conf):
    try:
        with open(conf, encoding="utf-8") as f:
            assoc = json.load(f)["bundle"]["fileAssociations"]
    except (OSError, ValueError, KeyError, TypeError) as e:
        fail(2, f"no bundle.fileAssociations in {conf}: {e}")
    return [{"CFBundleTypeExtensions": list(a["ext"]), "CFBundleTypeName": a["name"],
             "CFBundleTypeRole": a["role"], "LSHandlerRank": "Default"} for a in assoc]


def bundle(plist, extra, conf):
    b, e, want = load_plist(plist), load_plist(extra), doc_types(conf)
    bad = [k for k in e if k not in b or not same(b[k], e[k])]
    if bad:
        fail(1, f"the built app's Info.plist lacks Info.ios.plist's {bad} (or has other values)")
    if not same(b.get("CFBundleDocumentTypes"), want):
        fail(1, f"the built app's CFBundleDocumentTypes is not tauri.conf.json's file types ({[t['CFBundleTypeExtensions'] for t in want]})")
    if "ITSAppUsesNonExemptEncryption" in b:
        fail(1, "the built app's Info.plist declares ITSAppUsesNonExemptEncryption")
    print(f"ok: the built app's Info.plist has {sorted(e)} as in Info.ios.plist, the file types {[t['CFBundleTypeExtensions'][0] for t in want]}, and no encryption declaration")


def main(argv):
    if len(argv) == 2 and argv[0] == "udid":
        udid(argv[1])
    elif len(argv) == 2 and argv[0] == "codesign":
        codesign(argv[1])
    elif len(argv) == 3 and argv[0] == "running":
        running(argv[1], argv[2])
    elif len(argv) == 2 and argv[0] == "tree":
        tree(argv[1])
    elif len(argv) == 4 and argv[0] == "bundle":
        bundle(argv[1], argv[2], argv[3])
    else:
        fail(2, "usage: ios-judge.py udid TEXT | codesign FILE | running FILE BUNDLE_ID | tree STATUS | bundle PLIST EXTRA CONF")


try:
    main(sys.argv[1:])
except SystemExit:
    raise
except Exception as e:  # (a bug in the judge, not a verdict)
    print(f"ERROR: internal: {type(e).__name__}: {e}")
    sys.exit(3)
