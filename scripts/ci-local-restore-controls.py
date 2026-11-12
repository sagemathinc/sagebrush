"""Controls for scripts/ci-local.py's module ownership (its preflight and restore_modules), run by
scripts/test-ci-local-restore.mjs: the functions from ci-local.py itself, in a scratch root with a local directory as
the bucket.  Usage: python3 -I scripts/ci-local-restore-controls.py <checkout>"""
import ast, hashlib, json, os, pathlib, shutil, subprocess, sys, tempfile
wt = sys.argv[1]
src = open(f"{wt}/scripts/ci-local.py").read()
names = {"module_shas", "pin_shas", "fetch_pinned", "unpinned", "restore_modules"}
tree = ast.parse(src)
body = [n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name in names]
mods_node = [n for n in tree.body if isinstance(n, ast.Assign) and getattr(n.targets[0], "id", "") == "MODULES"]
MODULES = ["sagebrush-engine.wasm", "sagebrush-raster.wasm", "sagebrush-mp.wasm", "sagebrush-nd.wasm"]
sha = lambda b: hashlib.sha256(b).hexdigest()
results = []

def setup(td):
    p = pathlib.Path(td)
    (p / "scripts").mkdir(); (p / "wasm").mkdir(); (p / "bucket").mkdir()
    for f in ["wasm-modules.mjs", "wasm-fetch.mjs"]:
        shutil.copy(f"{wt}/scripts/{f}", p / "scripts" / f)
    pins = {}
    for n in MODULES:
        b = b"\0asm\x01\0\0\0" + n.encode()
        pins[n] = {"sha256": sha(b), "bytes": len(b)}
        (p / "bucket" / (sha(b) + ".wasm")).write_bytes(b)
        (p / "wasm" / n).write_bytes(b)
    (p / "wasm" / "pins.json").write_text(json.dumps({"v": 1, "modules": pins}))
    g = {"os": os, "hashlib": hashlib, "json": json, "subprocess": subprocess, "shutil": shutil, "tempfile": tempfile, "ROOT": td}
    exec(compile(ast.Module(body=mods_node + body, type_ignores=[]), "ci-local", "exec"), g)
    os.environ["SAGEBRUSH_WASM_BASE"] = str(p / "bucket")
    os.environ["SAGEBRUSH_WASM_CACHE"] = str(p / "cache")
    return p, pins, g

def row(name, fn):
    with tempfile.TemporaryDirectory(prefix="restore-probe-") as td:
        p, pins, g = setup(td)
        ok, detail = fn(p, pins, g)
        results.append(f"{'ok  ' if ok else 'FAIL'} {name}: {detail}")

def build_all(p):
    for n in MODULES:
        (p / "wasm" / n).write_bytes(b"built here " + n.encode())

def r1(p, pins, g):
    start = g["module_shas"](); build_all(p); built = g["module_shas"]()
    other = b"another writer changed mp after the build"
    (p / "wasm" / MODULES[2]).write_bytes(other)
    failed = g["restore_modules"]({"built": built}, start)
    now = g["module_shas"]()
    untouched = all(now[m] == built[m] for m in MODULES if m != MODULES[2])
    kept = (p / "wasm" / MODULES[2]).read_bytes() == other
    return failed and untouched and kept, f"failure reported {failed}, nothing restored {untouched}, the mp edit kept {kept}"

def r2(p, pins, g):
    start = g["module_shas"](); build_all(p); built = g["module_shas"]()
    failed = g["restore_modules"]({"built": built}, start)
    now = g["module_shas"]()
    return (not failed) and all(now[m] == pins[m]["sha256"] for m in MODULES), f"failure {failed}, all four pinned again"

def r3(p, pins, g):
    start = g["module_shas"]()
    (p / "wasm" / MODULES[0]).write_bytes(b"changed with no build of this run's")
    failed = g["restore_modules"]({"built": None}, start)
    kept = (p / "wasm" / MODULES[0]).read_bytes() == b"changed with no build of this run's"
    return failed and kept, f"failure reported {failed}, left as it is {kept}"

def r4(p, pins, g):
    # the build ran, then the engine was edited again: not the build's bytes, so not this run's to restore
    start = g["module_shas"](); build_all(p); built = g["module_shas"]()
    (p / "wasm" / MODULES[0]).write_bytes(b"edited after the build")
    failed = g["restore_modules"]({"built": built}, start)
    now = g["module_shas"]()
    kept = (p / "wasm" / MODULES[0]).read_bytes() == b"edited after the build"
    rest = all(now[m] == built[m] for m in MODULES[1:])
    return failed and kept and rest, f"failure reported {failed}, the edited engine kept {kept}, nothing else restored {rest}"

def r5(p, pins, g):
    # a local build of a module other than the engine, before the run: the preflight names it, so no rebuild starts
    (p / "wasm" / MODULES[3]).write_bytes(b"a local nd build")
    local = g["unpinned"](g["module_shas"](), g["pin_shas"]())
    return local == [MODULES[3]], f"refused for {local}"

def r6(p, pins, g):
    # a module missing at the start counts as not its pin
    (p / "wasm" / MODULES[1]).unlink()
    local = g["unpinned"](g["module_shas"](), g["pin_shas"]())
    return local == [MODULES[1]], f"refused for {local}"

def r7(p, pins, g):
    # mp edited while the pinned modules are being fetched (after the fetch returns, before any rename)
    start = g["module_shas"](); build_all(p); built = g["module_shas"]()
    edit = b"changed while the fetch ran"
    real = g["subprocess"]
    class During:
        @staticmethod
        def run(*a, **k):
            r = real.run(*a, **k)
            (p / "wasm" / MODULES[2]).write_bytes(edit)
            return r
    g["subprocess"] = During
    try:
        failed = g["restore_modules"]({"built": built}, start)
    finally:
        g["subprocess"] = real
    now = g["module_shas"]()
    kept = (p / "wasm" / MODULES[2]).read_bytes() == edit
    untouched = all(now[m] == built[m] for m in MODULES if m != MODULES[2])
    return failed and kept and untouched, f"failure reported {failed}, the edit kept {kept}, nothing restored {untouched}"

class Proxy:
    """A module whose attributes are the real one's, except those given."""
    def __init__(self, real, **over):
        self._real, self._over = real, over
    def __getattr__(self, k):
        return self._over.get(k, getattr(self._real, k))

def r8(p, pins, g):
    # mp edited after every pinned file was staged, before the first rename: nothing replaced, no staged file left
    start = g["module_shas"](); build_all(p); built = g["module_shas"]()
    edit = b"changed after the staging"
    real, staged = g["shutil"], []
    def copyfile(src, dst, *a, **k):
        r = real.copyfile(src, dst, *a, **k)
        staged.append(dst)
        if len(staged) == len(MODULES):
            (p / "wasm" / MODULES[2]).write_bytes(edit)
        return r
    g["shutil"] = Proxy(real, copyfile=copyfile)
    try:
        failed = g["restore_modules"]({"built": built}, start)
    finally:
        g["shutil"] = real
    now = g["module_shas"]()
    kept = (p / "wasm" / MODULES[2]).read_bytes() == edit
    untouched = all(now[m] == built[m] for m in MODULES if m != MODULES[2])
    leftover = sorted(x.name for x in (p / "wasm").glob("*.part"))
    return failed and kept and untouched and not leftover and len(staged) == 4, \
        f"failure reported {failed}, the edit kept {kept}, nothing replaced {untouched}, staged {len(staged)}, parts left {leftover}"

def r9(p, pins, g):
    # the second rename fails: the first module is the pin, the rest still this run's build, reported; no part left
    start = g["module_shas"](); build_all(p); built = g["module_shas"]()
    real, calls = g["os"], []
    def replace(a, b):
        calls.append(b)
        if len(calls) == 2:
            raise OSError("planted rename failure")
        return real.replace(a, b)
    g["os"] = Proxy(real, replace=replace)
    try:
        failed = g["restore_modules"]({"built": built}, start)
    finally:
        g["os"] = real
    now = g["module_shas"]()
    first = now[MODULES[0]] == pins[MODULES[0]]["sha256"]
    rest = all(now[m] == built[m] for m in MODULES[1:])
    leftover = sorted(x.name for x in (p / "wasm").glob("*.part"))
    return failed and first and rest and not leftover, f"failure reported {failed}, first replaced {first}, the rest still the build {rest}, parts left {leftover}"

for n, f in [("a module edited after the staging", r8), ("a rename that fails partway", r9), ("a module edited during the fetch", r7), ("a local build of another module before the run", r5), ("a missing module before the run", r6), ("a module changed by someone else after the build", r1), ("an ordinary run", r2),
             ("a change with no build of this run's", r3), ("the engine edited after the build", r4)]:
    row(n, f)
print("\n".join(results))
sys.exit(1 if any(r.startswith("FAIL") for r in results) else 0)
