#!/usr/bin/env python3
"""Tests of scripts/numbl-ratchet.py: its verdict (judge), pass rule (passed), discovery (discover) and whole run (a fake CLI).
  python3 scripts/test-numbl-ratchet.py"""
import importlib.util, os, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("numbl_ratchet", os.path.join(HERE, "numbl-ratchet.py"))
R = importlib.util.module_from_spec(spec)
spec.loader.exec_module(R)
failed = 0


def check(name, cond, detail=""):
    global failed
    print(("ok   " if cond else "FAIL ") + name + ("" if cond else " :: " + detail))
    failed += not cond


M = ["a/one.m", "a/two.m", "b/three.m"]
E = ["a/one.m", "b/three.m"]

# R1: everything as expected: green, no new passes
err, new = R.judge(M, E, M, {"a/one.m": True, "a/two.m": False, "b/three.m": True})
check("R1 as expected: green", err == [] and new == [], f"{err} {new}")
# R2: an expected script fails: red, named
err, new = R.judge(M, E, M, {"a/one.m": True, "a/two.m": False, "b/three.m": False})
check("R2 regression: red", err == ["REGRESSION: expected to pass, failed: b/three.m"], str(err))
# R3: a new pass is reported and stays green
err, new = R.judge(M, E, M, {"a/one.m": True, "a/two.m": True, "b/three.m": True})
check("R3 new pass: reported, green", err == [] and new == ["a/two.m"], f"{err} {new}")
# R4: a FAILING script dropped from the run (the grader's mutant): red
err, new = R.judge(M, E, M, {"a/one.m": True, "b/three.m": True})
check("R4 dropped failing script: red", err == ["no result (dropped from the run): a/two.m"], str(err))
# R5: an expected script dropped from the run: red too
err, new = R.judge(M, E, M, {"a/one.m": True, "a/two.m": False})
check("R5 dropped expected script: red", err == ["no result (dropped from the run): b/three.m"], str(err))
# R6: discovery finds a script the manifest lacks, and misses one it has: red, both named
err, new = R.judge(M, E, ["a/one.m", "a/two.m", "c/four.m"], {"a/one.m": True, "a/two.m": False, "b/three.m": True})
check("R6 manifest drift: red", err == ["found but not in scripts.txt: c/four.m", "in scripts.txt but not found: b/three.m"], str(err))
# R7: expected-pass names a script outside the manifest: red
err, new = R.judge(M, E + ["z/gone.m"], M, {"a/one.m": True, "a/two.m": False, "b/three.m": True})
check("R7 expected outside manifest: red", err == ["expected-pass.txt names a script not in scripts.txt: z/gone.m"], str(err))
# R8: a duplicate manifest line: red
err, new = R.judge(M + ["a/one.m"], E, M, {"a/one.m": True, "a/two.m": False, "b/three.m": True})
check("R8 duplicate manifest entry: red", "scripts.txt lists a script twice" in err, str(err))
# R9: an expected entry that is only a prefix of a script (names match exactly, never by prefix): red
err, new = R.judge(M, ["a/one", "b/three.m"], M, {"a/one.m": True, "a/two.m": False, "b/three.m": True})
check("R9 expected entry a prefix of a script: red", err == ["expected-pass.txt names a script not in scripts.txt: a/one"], str(err))
# R10: a duplicate expected-pass line: red
err, new = R.judge(M, E + ["a/one.m"], M, {"a/one.m": True, "a/two.m": False, "b/three.m": True})
check("R10 duplicate expected entry: red", err == ["expected-pass.txt lists a script twice"], str(err))
# R11: a result for a script outside the manifest (a script run that shouldn't be): red
err, new = R.judge(M, E, M, {"a/one.m": True, "a/two.m": False, "b/three.m": True, "a/@C/C.m": True})
check("R11 a result outside the manifest: red", err == ["a result for a script not in scripts.txt: a/@C/C.m"], str(err))

# P1-P4: the pass rule
check("P1 SUCCESS last", R.passed("x\nSUCCESS\n"))
check("P2 SUCCESS then the figure epilogue", R.passed("SUCCESS\nPlot: line through 3 points\nSaved /tmp/sagebrush-figures-1-a/figure-1.svg (Plot)\n(figures are removed when sagebrush exits; sagebrush --figures DIR keeps them)\n"))
check("P3 script output after SUCCESS", not R.passed("SUCCESS\nmore\n"))
check("P4 nothing", not R.passed(""))
check("P5 a last line that contains SUCCESS without being it", not R.passed("x\nNOT SUCCESS\n") and not R.passed("SUCCESS!\n"))
check("P6 only the CLI's own epilogue lines are set aside", not R.passed("SUCCESS\nSaved results to out.mat\n"))

# D1-D3: discovery (numbl's rule) on a small tree
with tempfile.TemporaryDirectory() as d:
    for rel, text in [("a/t1.m", "disp('SUCCESS')"), ("a/helper.m", "function y = helper(x)\ny = x;\nend"),
                      ("a/@C/C.m", "disp('SUCCESS')"), ("+p/f.m", "disp('SUCCESS')"), ("wasm/w.m", "disp('SUCCESS')"),
                      ("b/c/t2.m", "x = 1;\ndisp('SUCCESS')"), ("b/note.txt", "SUCCESS")]:
        os.makedirs(os.path.join(d, os.path.dirname(rel)), exist_ok=True)
        open(os.path.join(d, rel), "w").write(text)
    got = R.discover(d)
    check("D1 discovery: .m with SUCCESS, not under @/+/wasm", got == ["a/t1.m", "b/c/t2.m"], str(got))

# M1: the real lists: expected-pass is a subset of scripts.txt, and scripts.txt equals the vendored tree's discovery
manifest, expected = R.read_list(R.MANIFEST), R.read_list(R.EXPECTED)
err, _ = R.judge(manifest, expected, R.discover(R.SCRIPTS_DIR), {s: s in set(expected) for s in manifest})
check(f"M1 the committed lists agree with the vendored tree ({len(manifest)} scripts, {len(expected)} expected)", err == [], "; ".join(err[:5]))

# I1-I8: the whole ratchet (discovery, the run, the verdict, the exit status) on the real corpus, with a fake engine.
# A JSON map says how each script behaves: "ok" prints SUCCESS and exits 0, "exit1" prints SUCCESS and exits 1, "hang"
# prints SUCCESS and then outlives the timeout, "slow" logs its start and end around a 0.5 s sleep and prints SUCCESS;
# any other script prints "nope". The fake logs every script it was run on, with the environment it saw. (The ratchet gives each run a minimal environment, so the map's path travels as the --cli argument: node's
# script argument, the fake's argv[1].)
import json, subprocess
FAKE = r'''
import os, sys, time
rel = os.path.join(os.getcwd(), sys.argv[3]).rsplit(os.sep + "tree" + os.sep, 1)[1].replace(os.sep, "/")
d = os.path.dirname(sys.argv[1])
with open(os.path.join(d, "ran.log"), "a") as f:
    f.write("\t".join([rel, os.environ.get("NUMBL_LEAK", "-"), os.environ.get("HOME", "-"), os.environ.get("TMPDIR", "-")]) + "\n")
mode = __import__("json").load(open(sys.argv[1])).get(rel)
if mode == "slow":
    t0 = time.time()
    time.sleep(0.5)
    with open(os.path.join(d, "slow.log"), "a") as f:
        f.write(f"{rel} {t0} {time.time()}\n")
print("SUCCESS" if mode else "nope", flush=True)
if mode == "hang":
    time.sleep(30)
sys.exit(1 if mode == "exit1" else 0)
'''
def ratchet(modes):
    with tempfile.TemporaryDirectory() as d:
        fake, cfg = os.path.join(d, "fake-node"), os.path.join(d, "modes.json")
        open(fake, "w").write(f"#!{sys.executable} -IS" + FAKE)
        os.chmod(fake, 0o755)
        json.dump(modes, open(cfg, "w"))
        env = {**os.environ, "NUMBL_LEAK": "1", "HOME": PARENT_HOME, "TMPDIR": PARENT_TMP}
        p = subprocess.run([sys.executable, os.path.join(HERE, "numbl-ratchet.py"), "--node", fake, "--cli", cfg, "--jobs", "8", "--timeout", "3"],
                           capture_output=True, text=True, env=env)
        rows = [l.split("\t") for l in open(os.path.join(d, "ran.log")).read().splitlines()] if os.path.exists(os.path.join(d, "ran.log")) else []
        slow = [l.split() for l in open(os.path.join(d, "slow.log")).read().splitlines()] if os.path.exists(os.path.join(d, "slow.log")) else []
        return p.returncode, p.stdout, rows, slow
PARENT_HOME, PARENT_TMP = tempfile.gettempdir() + "/numbl-parent-home", tempfile.gettempdir() + "/numbl-parent-tmp"
# (two scripts of one directory, both expected to pass: "slow" there must not overlap)
by_dir = {}
for s in expected:
    by_dir.setdefault(os.path.dirname(s), []).append(s)
slow2 = next(v[:2] for k, v in sorted(by_dir.items()) if len(v) >= 2)
modes = {s: "ok" for s in expected}
modes.update({s: "slow" for s in slow2})
rc, out, rows, slow = ratchet(modes)
ran = [r[0] for r in rows]
check("I1 the run with exactly the expected passes: green, no NEW PASS", rc == 0 and "NEW PASS" not in out and "ERROR" not in out, out[-400:])
bad_env = [r for r in rows if r[1] != "-" or r[2] in ("-", PARENT_HOME) or r[3] in ("-", PARENT_TMP)]
check("I7 each script ran in the minimal environment (no parent variable, its own HOME and TMPDIR)", rows and not bad_env, str(bad_env[:2]))
iv = sorted((float(a), float(b)) for _, a, b in slow)
check(f"I8 one directory's scripts run one at a time ({slow2[0]} and {slow2[1]} at --jobs 8 don't overlap)",
      len(iv) == 2 and iv[0][1] <= iv[1][0], str(iv))
excluded = [s for s in ran if any(c.startswith(("@", "+")) or c == "wasm" for c in s.split("/")[:-1])]
check("I2 the run ran every script of scripts.txt once, and nothing else (no @/+/wasm file)",
      sorted(ran) == sorted(manifest) and not excluded, f"{len(ran)} runs, {len(set(ran))} distinct, {len(manifest)} listed, excluded {excluded[:3]}")
extra = next(s for s in manifest if s not in set(expected))
modes = {s: "ok" for s in expected[3:] + [extra]}
modes[expected[1]], modes[expected[2]] = "exit1", "hang"
rc, out, rows, slow = ratchet(modes)
check("I3 an expected script failing: red, named", rc == 1 and f"REGRESSION: expected to pass, failed: {expected[0]}" in out, out[-600:])
check("I4 an expected script that printed SUCCESS and exited 1: a regression", f"REGRESSION: expected to pass, failed: {expected[1]}" in out, out[-600:])
check("I5 an expected script that printed SUCCESS and timed out: a regression", f"REGRESSION: expected to pass, failed: {expected[2]}" in out, out[-600:])
check("I6 one more script passing: NEW PASS named", f"NEW PASS (add to expected-pass.txt): {extra}" in out, out[-600:])

print(("all ok" if not failed else f"{failed} FAILED"))
sys.exit(1 if failed else 0)
