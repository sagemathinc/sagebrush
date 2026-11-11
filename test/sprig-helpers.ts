import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

// Shared by Sprig's host pins (test/sprig-host.test.ts, sprig-stack.test.ts, sprig-memory.test.ts): S1.1's first host
// exposure, the hidden `--sprig -c` (design/sprig-mvp.md §8, §9; the S1 plan, with ENGINE's E1/E2 and SEC's literal
// staging, Nov 9).  The corpus (test/sprig-corpus-*.test.ts) pins the language; these pin Sprig's boundary.  Nothing in
// them asserts a time or this host's stack depth.
export const ROOT = join(__dirname, "..", "..");
export const CLI = join(__dirname, "..", "src", "cli.js");

export function sprig(src: string, cwd: string) {
  const r = spawnSync(process.execPath, [CLI, "--sprig", "-c", src], { cwd, encoding: "utf8", timeout: 300000, maxBuffer: 1 << 26 });
  return { stdout: r.stdout, stderr: r.stderr, status: r.status };
}

/** Python run in the engine (Sprig's modules in-process), its stdout's last line parsed as JSON. */
export function py(src: string, cwd = ROOT) {
  const r = spawnSync(process.execPath, [CLI, "-c", src], { cwd, encoding: "utf8", timeout: 300000, maxBuffer: 1 << 26 });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout.trim().split("\n").pop()!);
}

export const HOST_DETAIL = /Traceback|File "|\.py"|RecursionError|RangeError|Maximum call stack/;

/** Python for the ledger's pins (§8.4), put before a py() program: boundary(run) finds, through the ledger itself
 * (never a copy of its formulas), the least allowance at which run() is admitted, by bisection; program(src) runs a
 * Sprig program as the CLI does, raising Refused(name) for its General::memory; probe(name) is a builtin recording
 * what is open each time it is called. */
export const LEDGER_PY = `
import json, re, _sprig
from _sprig import mem, base
from _sprig.eval import Session
from _sprig.expr import Expr, Sym, size_of

class Refused(Exception):
    pass

def program(src):
    def run():
        out = []
        _sprig.run(src, out.append, out.append)
        text = "".join(out)
        m = re.search(r"^(\\w+)::memory:", text, re.M)
        if m:
            raise Refused(m.group(1))
        return text
    return run

seen = {}
def probe(name, value=None):
    seen[name] = []
    def f(sess, e):
        seen[name].append(mem.open_bytes())
        return value
    base.BUILTINS[name] = f

def at(run, G, unmeasured=False, pad=True):
    """run() with G bytes allowed open at once (a fixed cap of G with no memory figure, if unmeasured); with pad, a
    reservation of SMALL_BYTES is held first, so every admission is checked under the shipped SMALL_BYTES.  Returns
    ["ok", result] or ["refused", name], with what is left open after, beyond what was open before."""
    base0 = mem.open_bytes()
    if unmeasured:
        mem._allowance = lambda: (None, "no memory figure")
        mem.UNMEASURED_OPERATION_BYTES = G
    else:
        mem._allowance = lambda: (G - mem.open_bytes(), None)
    p = mem.reserve(mem.SMALL_BYTES if pad else 0, "A pad", "Test")
    try:
        p.held = True
        mem._open[0] += p.nbytes
        try:
            got = ["ok", run()]
        except mem.SprigMemoryError as e:
            got = ["refused", e.sprig_name]
        except Refused as e:
            got = ["refused", str(e)]
    finally:
        p.release()
        mem._allowance = lambda: (1 << 50, None)
        mem.UNMEASURED_OPERATION_BYTES = UNMEASURED0
    return got + [mem.open_bytes() - base0]

UNMEASURED0 = mem.UNMEASURED_OPERATION_BYTES

def boundary(run, unmeasured=False, pad=True):
    """(A, at A - 1, at A): A the most the ledger had open at once while run() ran with no limit (its admissions'
    high-water mark, read from the ledger's own admission), so run() is admitted at A and refused at A - 1."""
    real = mem._admit
    top = [0]
    def admit(need, what, name):
        real(need, what, name)
        top[0] = max(top[0], mem._open[0])
    mem._admit = admit
    try:
        assert at(run, 1 << 50, unmeasured, pad)[0] == "ok"
    finally:
        mem._admit = real
    A = top[0]
    return A, at(run, A - 1, unmeasured, pad), at(run, A, unmeasured, pad)
`;
