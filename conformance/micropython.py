"""MicroPython tests/basics (vendored in sagejs) against the pyjs spike:
each program's stdout and exit status must equal CPython's.  Tests with an
.exp file (MicroPython-specific) are skipped, as in sagejs.
    python3 conformance/micropython.py   (after `npx tsc -p .` in ~/sagebrush)"""
import os, subprocess, json, sys, collections
D = os.path.expanduser('~/sagejs/upstream-tests/micropython/basics')
files = sorted(f for f in os.listdir(D) if f.endswith('.py') and not os.path.exists(os.path.join(D, f[:-3] + '.exp')))
res = {}
def run(cmd, f):
    try:
        p = subprocess.run(cmd + [f], cwd=D, capture_output=True, timeout=20)
        return p.returncode, p.stdout
    except subprocess.TimeoutExpired:
        return 'timeout', b''
from concurrent.futures import ThreadPoolExecutor
def one(f):
    ref = run(['python3'], f)
    if ref[0] != 0:
        return f, 'skip(cpython fails)', ''
    got = run(['node', os.path.expanduser('~/sagebrush/dist/src/cli.js')], f)
    if got[0] == 'timeout': return f, 'timeout', ''
    if got == ref: return f, 'pass', ''
    if got[0] != 0: return f, 'error', got[1][-200:].decode(errors='replace')
    return f, 'mismatch', ''
with ThreadPoolExecutor(16) as ex:
    out = list(ex.map(one, files))
c = collections.Counter(s for _, s, _ in out)
print(len(files), 'tests;', dict(c))
json.dump(out, open('/tmp/micropython-results.json', 'w'))
