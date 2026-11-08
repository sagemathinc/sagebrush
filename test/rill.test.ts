import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Rill's host pins for A1.1, its first host exposure (the hidden `--rill -c`): design/rill.md §9's baseline (astra,
// plan r2) and §8 for what A1.1 makes reachable.  The corpus (test/rill-corpus-*.test.ts) pins R's behaviour; these
// pin Rill's boundary: no escape from R to the host, no file, network or process route, the memory discipline, and
// Stop never swallowed.
const ROOT = join(__dirname, "..", "..");
const CLI = join(__dirname, "..", "src", "cli.js");

function rill(src: string, cwd: string) {
  const r = spawnSync(process.execPath, [CLI, "--rill", "-c", src], { cwd, encoding: "utf8", timeout: 120000 });
  return { stdout: r.stdout, stderr: r.stderr, status: r.status };
}

/** Python run in the engine (Rill's modules in-process), its stdout's last line parsed as JSON. */
function py(src: string, cwd = ROOT) {
  const r = spawnSync(process.execPath, [CLI, "-c", src], { cwd, encoding: "utf8", timeout: 120000 });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout.trim().split("\n").pop()!);
}

// (§9: R calls shaped like escapes, foreign calls, introspection, and the file, network and process routes; A1.1
// has none of these functions, so each must be an R error before any effect)
const ESCAPES = [
  '.Call("x")', '.External("x")', '.C("x")', ".Internal(f())", '.Primitive("sum")', 'get("__import__")', 'mget("x")',
  'exists("x")', "as.environment(1)", "sys.function()", 'eval(parse(text = "1"))', "environment(sum)",
  'attr(1, "__class__")', "ls()", 'as.name("x")', '`__import__`("os")', '`getattr`(1, "x")', '`exec`("1")',
  '`open`("x")', 'source("x.R")', 'system("touch made-by-rill")', 'system2("touch", "made-by-rill")', 'shell("x")',
  'download.file("https://example.com", "made-by-rill")', 'url("https://example.com")', 'read.csv("x.csv")',
  'readLines("x")', 'file("made-by-rill", "w")', 'file.remove("x")', 'writeLines("a", "made-by-rill")',
  'cat("a", file = "made-by-rill")', 'sink("made-by-rill")', 'png("made-by-rill.png")', 'Sys.setenv(A = "1")',
  'Sys.getenv("HOME")', 'setwd("/")', 'install.packages("x")', "library(x)",
];

test("§9: every escape-shaped, file, network and process call is an R error before any effect", () => {
  const dir = mkdtempSync(join(tmpdir(), "rill-gates-"));
  try {
    for (const src of ESCAPES) {
      const r = rill(src, dir);
      assert.equal(r.status, 1, `${src}: exit status 1 (${JSON.stringify(r)})`);
      assert.equal(r.stdout, "", `${src}: nothing printed`);
      assert.match(r.stderr, /^Error/, `${src}: an R error: ${r.stderr}`);
      assert.doesNotMatch(r.stderr, /Traceback|File "|\.py"|RecursionError|RangeError/, `${src}: no host detail: ${r.stderr}`);
      assert.deepEqual(readdirSync(dir), [], `${src}: no file made`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("§9: names reach only R's variables and Rill's builtins, never the host's", () => {
  const dir = mkdtempSync(join(tmpdir(), "rill-names-"));
  try {
    for (const name of ["__import__", "__builtins__", "__class__", "os", "sys", "open", "eval", "exec", "getattr", "_rill", "Session", "globals", "math", "_memguard"]) {
      const r = rill("`" + name + "`", dir);
      assert.equal(r.stderr, `Error: object '${name}' not found\n`, name);
      assert.equal(r.status, 1);
    }
    // (a builtin's name is no host object either: Rill refuses it as a value until closures, A1.3)
    const r = rill("x <- print", dir);
    assert.match(r.stderr, /^Error: Rill doesn't support a function as a value yet\n$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("§9: an escape attempt leaves the session as it was", () => {
  const got = py(`
import json, _rill
from _rill.eval import Session, RError, NotSupported
from _rill.parse import parse
from _rill import mem
s = Session(lambda t: None, lambda t: None)
s.evaluate(parse("x <- c(1, 2)")[0])
before = (sorted(s.globals), s.globals["x"].data)
results = []
for src in ${JSON.stringify(ESCAPES.slice(0, 20))}:
    try:
        s.evaluate(parse(src)[0])
        results.append("ran")
    except (RError, NotSupported):
        results.append("refused")
print(json.dumps({"results": results, "same": (sorted(s.globals), s.globals["x"].data) == before, "open": mem.open_bytes(), "depth": s.depth}))
`);
  assert.ok(got.results.every((r: string) => r === "refused"), JSON.stringify(got.results));
  assert.deepEqual([got.same, got.open, got.depth], [true, 0, 0]);
});

test("§8.5: a vector past the allowance is refused with R's message and Sagebrush's sentence", () => {
  const dir = mkdtempSync(join(tmpdir(), "rill-mem-"));
  try {
    const big = rill("x <- 1:1e10", dir);
    assert.equal(big.status, 1);
    assert.match(big.stderr, /^Error: cannot allocate vector of size 74\.5 Gb\n(Not enough memory for this computation\.|This computation is larger than Sagebrush allows\.)\nA vector of 10000000000 numbers needs about /);
    // (a size past any host's limits is computed in Python integers, never an overflow or a host error)
    const huge = rill("1:1e300", dir);
    assert.equal(huge.status, 1);
    assert.match(huge.stderr, /^Error: cannot allocate vector of size \d+\.\d Gb\n/);
    assert.doesNotMatch(huge.stderr, /Traceback|OverflowError/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("§8.5: the boundary, one past it, the unmeasured cap, and Stop giving back its reservation", () => {
  const got = py(`
import json
from _rill import mem
import _memguard
G = 64 << 20
mem._allowance = lambda: (G, None)
r = {}
with mem.Reservation(G, G, "A test"):
    r["at"] = mem.open_bytes()
try:
    with mem.Reservation(G + 1, 1, "A test"):
        r["past"] = "admitted"
except _memguard.SagebrushMemoryError as e:
    r["past"] = [e.need_bytes, e.limit_bytes]
r["after"] = mem.open_bytes()
mem._allowance = lambda: (None, "no memory figure")
with mem.Reservation(mem.UNMEASURED_OPERATION_BYTES, 0, "A test"):
    pass
try:
    with mem.Reservation(mem.UNMEASURED_OPERATION_BYTES + 1, 0, "A test"):
        pass
except _memguard.SagebrushMemoryError as e:
    r["unmeasured"] = [e.fixed, e.unmeasured]
try:
    with mem.Reservation(G, G, "A test"):
        raise KeyboardInterrupt
except KeyboardInterrupt:
    r["stop"] = mem.open_bytes()
print(json.dumps(r))
`);
  assert.deepEqual(got, { at: 64 << 20, past: [(64 << 20) + 1, 64 << 20], after: 0, unmeasured: [true, "no memory figure"], stop: 0 });
});

test("§8: Stop propagates out of the evaluator and the parser, giving back what it held", () => {
  const got = py(`
import json, _rill
from _rill import mem, parse as P
from _rill.eval import Session
r = {}
def stop_c(sess, call, args):
    with mem.reserve(10, "double"):
        raise KeyboardInterrupt
s = Session(lambda t: None, lambda t: None)
s.builtins = dict(s.builtins, c=stop_c)
try:
    s.evaluate(P.parse("1 + c(1, 2)")[0])
    r["eval"] = "swallowed"
except KeyboardInterrupt:
    r["eval"] = ["propagated", mem.open_bytes(), s.depth]
real = P.Parser.statement
def stop_parse(self):
    raise KeyboardInterrupt
P.Parser.statement = stop_parse
try:
    _rill.run("1", lambda t: None, lambda t: None)
    r["parse"] = "swallowed"
except KeyboardInterrupt:
    r["parse"] = "propagated"
P.Parser.statement = real
print(json.dumps(r))
`);
  assert.deepEqual(got, { eval: ["propagated", 0, 0], parse: "propagated" });
});

test("§8.1 (A1.1's part): no bare except, no except BaseException or Exception in lib/_rill", () => {
  const dir = join(ROOT, "lib", "_rill");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".py"))) {
    const text = readFileSync(join(dir, f), "utf8");
    assert.doesNotMatch(text, /^\s*except\s*:/m, `${f}: a bare except`);
    assert.doesNotMatch(text, /^\s*except\s*\(?[^)\n]*\b(BaseException|Exception)\b/m, `${f}: except BaseException or Exception`);
  }
});

test("--rill runs only -c in this version (hidden until A1.7), and is not in --help", () => {
  const dir = mkdtempSync(join(tmpdir(), "rill-flag-"));
  try {
    for (const args of [["--rill", "x.R"], ["--rill"], ["--rill", "-i", "-c", "1"], ["--rill", "-m", "x"]]) {
      const r = spawnSync(process.execPath, [CLI, ...args], { cwd: dir, encoding: "utf8", input: "1\n", timeout: 60000 });
      assert.equal(r.status, 2, args.join(" "));
      assert.equal(r.stderr, "sagebrush: --rill runs only -c in this version of Sagebrush\n");
    }
    const help = spawnSync(process.execPath, [CLI, "--help"], { encoding: "utf8" });
    assert.doesNotMatch(help.stdout + help.stderr, /rill/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("§9: the gate inventory lists every route in lib/_rill, each with its decision (scripts/rill-gates.mjs)", () => {
  const r = spawnSync(process.execPath, [join(ROOT, "scripts", "rill-gates.mjs"), "--check"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  // (and no host builtin that reaches outside the session is called at all, whatever its listed decision)
  const inventory = JSON.parse(readFileSync(join(ROOT, "scripts", "rill-gates.json"), "utf8")).routes;
  for (const k of Object.keys(inventory)) assert.ok(!/^call:(open|exec|eval|compile|__import__|setattr|delattr|globals|locals|vars|input|breakpoint)$/.test(k), `${k}: Rill calls no such host builtin`);
  for (const k of Object.keys(inventory)) assert.ok(!/^import:(os|io|subprocess|socket|shutil|pathlib|builtins|importlib|ctypes|js)$/.test(k), `${k}: Rill imports no host module of files, processes or the network in A1.1`);
});
