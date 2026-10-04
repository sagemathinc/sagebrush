"""Syntax errors: our parser vs CPython on every snippet in CPython's
Lib/test/test_syntax.py (its doctests and its _check_error/_check_noerror
calls), comparing (type, msg, lineno, offset, end_lineno, end_offset).
    python3 test/compare_errors.py [path/to/test_syntax.py] [--show N]"""
import ast, collections, doctest, json, os, subprocess, sys, tempfile
sys.path.insert(0, os.path.dirname(__file__))
import pydump

path = next((a for a in sys.argv[1:] if a.endswith(".py")), os.path.expanduser("~/data/cpython-src/Lib/test/test_syntax.py"))
show = int(sys.argv[sys.argv.index("--show") + 1]) if "--show" in sys.argv else 15
src = open(path).read()
tree = ast.parse(src)

snippets = []
# Doctests in the module docstring (each example is one compile unit).
doc = ast.get_docstring(tree, clean=False) or ""
for ex in doctest.DocTestParser().get_examples(doc):
    snippets.append(ex.source)
# self._check_error("...", ...) and friends with a literal first argument.
for node in ast.walk(tree):
    if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr in (
            "_check_error", "_check_noerror", "_check_warning") and node.args:
        a = node.args[0]
        if isinstance(a, ast.Constant) and isinstance(a.value, str):
            snippets.append(a.value)
snippets = list(dict.fromkeys(snippets))

tmp = tempfile.mkdtemp()
files, ref = [], {}
for i, s in enumerate(snippets):
    f = os.path.join(tmp, f"s{i:04d}.py")
    open(f, "w").write(s)
    files.append(f)
    try:
        ref[f] = pydump.error(s)
    except Exception as e:  # ValueError for null bytes etc.
        ref[f] = ("other", repr(e))

here = os.path.dirname(os.path.abspath(__file__))
out = subprocess.run(["node", os.path.join(here, "..", "dist", "test", "dump.js")], input="\n".join(files), capture_output=True, text=True)
stats, bad = collections.Counter(), []
for line in out.stdout.splitlines():
    r = json.loads(line)
    want = ref[r["file"]]
    if isinstance(want, tuple):
        stats["skipped"] += 1
        continue
    got = r.get("error") if not r.get("ok") else None
    if "crash" in r:
        stats["crash"] += 1; bad.append((r["file"], want, "CRASH " + r["crash"][:300])); continue
    if want is None:
        stats["valid: accepted" if got is None else "valid: rejected"] += 1
        if got is not None: bad.append((r["file"], want, got))
        continue
    if got is None:
        stats["invalid: accepted"] += 1; bad.append((r["file"], want, got)); continue
    if got == want: stats["error identical"] += 1
    elif got[:2] == want[:2]: stats["same message, location differs"] += 1; bad.append((r["file"], want, got))
    else: stats["message differs"] += 1; bad.append((r["file"], want, got))
print(f"{len(snippets)} snippets from {os.path.basename(path)}")
print(dict(stats))
for f, want, got in bad[:show]:
    print("--", open(f).read().strip().replace("\n", "\\n")[:120])
    print("   cpython:", want)
    print("   ours:   ", got)
