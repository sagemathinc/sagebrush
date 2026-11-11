import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

// (grader's T-a, astra's R1) each escape as written, with an assignment as its first argument, and with an output
// as its first argument: a refusal before any argument runs leaves x as it was and prints nothing
const effectful = (src: string) => [src, src.replace("(", "(x <- 2, "), src.replace("(", '(cat("out"), ')];
const VARIANTS = ESCAPES.flatMap(effectful).concat(['cat(x <- 2, file = "made-by-rill")', 'cat(cat("out"), file = "made-by-rill")']);

test("§9: no escape, in any variant, changes the session or prints anything", () => {
  const got = py(`
import json, _rill
from _rill.eval import Session, RError, NotSupported
from _rill.parse import parse
from _rill import mem
out = []
s = Session(out.append, out.append)
s.evaluate(parse("x <- 1")[0])
before = (sorted(s.globals), s.globals["x"].data)
results = []
for src in ${JSON.stringify(VARIANTS)}:
    try:
        s.evaluate(parse(src)[0])
        results.append("ran: " + src)
    except (RError, NotSupported):
        pass
    if (sorted(s.globals), s.globals["x"].data) != before:
        results.append("changed: " + src)
print(json.dumps({"problems": results, "printed": "".join(out), "open": mem.open_bytes(), "depth": s.depth}))
`);
  assert.deepEqual(got, { problems: [], printed: "", open: 0, depth: 0 });
});

test("§9: through the CLI too, each variant prints nothing to stdout and makes no file", () => {
  const dir = mkdtempSync(join(tmpdir(), "rill-variants-"));
  try {
    const hostRoutes = /cat\(|system|file|writeLines|sink|png|download|source|url\(|setwd|Sys\.setenv/;
    for (const src of VARIANTS.filter((v) => (v.includes("x <- 2") || v.includes('cat("out")')) && hostRoutes.test(v))) {
      const r = rill("x <- 1; " + src + "; x", dir);
      assert.equal(r.status, 1, `${src}: refused (${JSON.stringify(r)})`);
      assert.equal(r.stdout, "", `${src}: nothing printed`);
      assert.deepEqual(readdirSync(dir), [], `${src}: no file made`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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

// (grader's T-b, astra's and daybreak3's R2) each caller reserves its operation's whole peak (result, coerced
// operands, element strings) before allocating: the peak, exactly, from the measured costs written out here
// (integer 32, double 64, logical 8, string 136 bytes), admitted at the boundary and refused one byte short
test("§8.5: each builtin reserves its whole peak first: admitted at the boundary, refused one byte short", () => {
  const got = py(`
import json
from _rill import mem
from _rill.eval import Session, RError, NotSupported
from _rill.parse import parse
import _memguard
s = Session(lambda t: None, lambda t: None)
s.evaluate(parse("x <- 1:50")[0])
s.evaluate(parse("y <- 51:100")[0])
s.evaluate(parse("z <- x + 0.5")[0])
s.evaluate(parse("w <- c(a = z)")[0])
s.evaluate(parse("j <- 50:1")[0])
s.evaluate(parse("t10 <- 1:10")[0])
s.evaluate(parse("t100 <- 1:100")[0])
mem.SMALL_BYTES = 0
cases = {
  "1:100": 100 * 32,
  "c(x, y)": 100 * 32 + 50 * 32,
  "x + y": 50 * 32 * 3,
  'x == "a"': 50 * 8 + 50 * 136 + 136,
  "-x": 50 * 32 * 2,
  "!x": 50 * 8 * 2,
  "x & y": 50 * 8 * 3,
  "cat(x)": 50 * 136 + 24 * 50 + 50,
  "print(x)": 50 * 136 + 24 * 50 + 2 * (50 * (24 + 1) + 50 * len("[50] ")),
  # (grader's M5) doubles at their own cost: the result and both operands coerced
  "z + z": 50 * 64 * 3,
  "x + 0.5": 50 * 64 + 50 * 64 + 64,
  "-z": 50 * 64 * 2,
  "z < 1": 50 * 8 + 50 * 64 + 64,
  # A1.2's classes (daybreak3): a constructor; a coercion; [ (positions, result: max(length(x), length(i)) each);
  # c() with names (result, the largest coerced operand, names); a complex constructor (result and both parts);
  # an elementwise test; a named [ (positions, result, names)
  "numeric(50)": 50 * 64,
  "as.character(x)": 50 * 136,
  "x[j]": 50 * 32 * 2,
  # (astra's #999 SEC 1) c()'s names: n strings, one argument's list of them, and 4 bytes for each character of a
  # name built from a tag (tag1 ... tag50: 50 tags and 91 digits; T.a1 ... T.a50: 50 tags, 50 dots and w's
  # names, 141 characters)
  "c(a = x)": 50 * 32 * 2 + 50 * 136 * 2 + 4 * (50 + 91),
  "complex(50)": 50 * 128 + 50 * 64 * 2,
  "is.na(z)": 50 * 8,
  "w[x]": 50 * 64 + 50 * 32 + 50 * 136,
}
TAG = "t" * 1001
cases["c(%s = x)" % TAG] = 50 * 32 * 2 + 50 * 136 * 2 + 4 * (50 * 1001 + 91)
cases["c(%s = w)" % TAG] = 50 * 64 * 2 + 50 * 136 * 2 + 4 * (50 * 1002 + 141)
# (grader's #999 TESTS row 4) the digits' decades: a1 ... a10 has 9 + 2 = 11 digits; a1 ... a100 has 9 + 180 + 3 = 192
cases["c(a = t10)"] = 10 * 32 * 2 + 10 * 136 * 2 + 4 * (10 + 11)
cases["c(a = t100)"] = 100 * 32 * 2 + 100 * 136 * 2 + 4 * (100 + 192)
peak = [0]
real_enter = mem.Reservation.__enter__
def spy(self):
    r = real_enter(self)
    peak[0] = max(peak[0], mem.open_bytes())
    return r
mem.Reservation.__enter__ = spy
out = {}
for src, want in cases.items():
    peak[0] = 0
    mem._allowance = lambda: (want - mem.open_bytes(), None)
    s.evaluate(parse(src)[0])
    at = peak[0]
    mem._allowance = lambda: (want - 1 - mem.open_bytes(), None)
    try:
        s.evaluate(parse(src)[0])
        short = "admitted"
    except _memguard.SagebrushMemoryError as e:
        short = [e.need_bytes, e.limit_bytes]
    out[src] = [want, at, short, mem.open_bytes()]
print(json.dumps(out))
`);
  for (const [src, [want, at, short, open]] of Object.entries<any>(got)) {
    assert.equal(at, want, `${src}: the whole peak reserved (${at} of ${want})`);
    assert.deepEqual(short, [want, want - 1], `${src}: refused one byte short`);
    assert.equal(open, 0, `${src}: nothing left reserved`);
  }
});

// (astra's R2 residual) print pads every element to the widest: one long string among short ones must be reserved
// for the padded layout, not the strings' own lengths; and a string of control characters prints four characters
// for each (grader's R7b: "\001" prints as "\001")
for (const [what, long] of [["plain", '"a" * 1000'], ["escaped", '"\\\\001" * 250'], ["supplementary", '"\\\\U0001fffe" * 100']]) {
  test(`§8.5: print reserves its padded layout: a skewed-width vector's output fits its reservation (${what})`, () => {
    const got = py(`
import json
from _rill import mem
from _rill.eval import Session
from _rill.parse import parse
out = []
s = Session(out.append, out.append)
src = 'c("' + ${long} + '", ' + ", ".join(['"b"'] * 99) + ')'
s.evaluate(parse("x <- " + src)[0])
mem.SMALL_BYTES = 0
peak = [0]
real_enter = mem.Reservation.__enter__
def spy(self):
    r = real_enter(self)
    peak[0] = max(peak[0], mem.open_bytes())
    return r
mem.Reservation.__enter__ = spy
mem._allowance = lambda: (10 ** 9, None)
s.evaluate(parse("print(x)")[0])
print(json.dumps({"peak": peak[0], "printed": len("".join(out))}))
    `);
    assert.ok(got.printed > 100000, `the layout pads every row (${got.printed} characters)`);
    assert.ok(got.peak >= 2 * got.printed + 100 * 136, `reserved ${got.peak} for ${got.printed} characters of output, held twice, and 100 element strings`);
  });
}

// (grader's M4) R's size wording past 1 Gb, from a refusal under a small allowance: 402653184 integers are R's
// 1.5 Gb (1:2e8 is its 762.9 Mb, rill-tests/mem/)
test("§8.5: a refusal states R's size in Mb or Gb", () => {
  const got = py(`
import json, _rill
from _rill import mem
mem._allowance = lambda: (1 << 20, None)
r = {}
for src in ("x <- 1:2e8", "x <- 1:402653184"):
    err = []
    _rill.run(src, lambda t: None, err.append)
    r[src] = "".join(err).split("\\n")[0]
print(json.dumps(r))
`);
  assert.deepEqual(got, {
    "x <- 1:2e8": "Error: cannot allocate vector of size 762.9 Mb",
    "x <- 1:402653184": "Error: cannot allocate vector of size 1.5 Gb",
  });
});

// (astra's R4) a syntax error's quoted window is R's last 256 bytes, so its staging is bounded too: the parser copies
// at most 257 characters of the source for it (the window and the lexer's lookahead), whatever the statement's
// length, and gives the same message (or refusal, for a window that would cut a character) as the whole statement's
// bytes would
test("parse: a syntax error's window is staged in bounded work, with the whole statement's message", () => {
  const got = py(`
import json
from _rill.parse import Parser, ParseError, CONTEXT_BYTES, CONTEXT_LINE_BYTES
from _rill.eval import NotSupported
seen = []
class Rec(str):
    def __getitem__(self, k):
        if isinstance(k, slice):
            seen.append(len(range(*k.indices(len(self)))))
        return str.__getitem__(self, k)
def reference(src, end, la):
    w = src[:end + la].encode("utf-8")[-CONTEXT_BYTES:]
    if la:
        w = w[:len(w) - len(src[end:end + la].encode("utf-8"))]
    try:
        lines = [l[:CONTEXT_LINE_BYTES].decode("utf-8") for l in w.split(b"\\n")[-2:]]
    except UnicodeDecodeError:
        return "refused"
    return lines
out = []
for n in (1024, 4096, 65536):
    for name in ("v", "\\u00e9"):
        for pad in ("", " "):
            for tail, la in ((" )", 0), (" x", 1)):
                terms, size = [], 0
                while size < n:
                    terms.append(name + str(len(terms)))
                    size += len(terms[-1]) + 3
                src = " + ".join(terms) + pad + tail + "\\n"
                p = Parser(src)
                p.src = Rec(src)
                del seen[:]
                try:
                    p.statement()
                    msg = "parsed"
                except (ParseError, NotSupported) as e:
                    msg = "refused" if isinstance(e, NotSupported) else e.message
                end = len(src) - 1
                ref = reference(src, end, la)
                want = "refused" if ref == "refused" else 'unexpected %s in "%s"' % ("')'" if la == 0 else "symbol", ref[-1])
                out.append([len(src), max(seen or [0]), msg == want, msg == "refused"])
print(json.dumps(out))
`);
  for (const [n, staged, same] of got) {
    assert.ok(staged <= 257, `a ${n}-character statement staged ${staged} characters for its error`);
    assert.ok(same, `a ${n}-character statement's message matches the whole statement's window`);
  }
  assert.ok(got.some((r: any) => r[3]), "a window cutting a character is among the cases (the refusal)");
  assert.ok(got.some((r: any) => !r[3]), "and windows that don't are too");
});

// (grader's P7) at top level a newline ends `if (TRUE) 1`, so an `else` on the next line is R's error; in braces it
// continues the if.  A1.1 doesn't run `if` (parse/test_6.R#else-newline is known until A1.3), so the parser is
// pinned here, to R's recorded text
test("parse: an else after a newline is R's error at top level and continues the if inside braces", () => {
  const rec = JSON.parse(readFileSync(join(ROOT, "rill-tests", "parse", "test_6.out.json"), "utf8"));
  const want = rec.cases.find((c: any) => c.id === "else-newline").stderr.replace(/Execution halted\n$/, "");
  const got = py(`
import json
from _rill.parse import parse, ParseError
r = {}
try:
    parse("if (TRUE) 1\\nelse 2")
    r["top"] = "parsed"
except ParseError as e:
    r["top"] = "Error: " + e.message + "\\n"
r["brace"] = [len(parse("{ if (TRUE) 1\\nelse 2 }")[0].args[0][1].args)]
print(json.dumps(r))
`);
  assert.deepEqual(got, { top: want, brace: [3] });
});

// (astra's R2 admission order) a refused print never starts formatting: the reservation is admitted, or refused,
// before any element string or line exists
test("§8.5: a print refused for memory formats nothing first", () => {
  const got = py(`
import json
from _rill import mem, fmt
from _rill.eval import Session
from _rill.parse import parse
import _memguard
out = []
s = Session(out.append, out.append)
s.evaluate(parse("x <- 1:100")[0])
calls = [0]
real = fmt.format_elements
def counting(*a, **k):
    calls[0] += 1
    return real(*a, **k)
fmt.format_elements = counting
mem.SMALL_BYTES = 0
mem._allowance = lambda: (100 - mem.open_bytes(), None)
try:
    s.evaluate(parse("print(x)")[0])
    r = "printed"
except _memguard.SagebrushMemoryError:
    r = "refused"
print(json.dumps({"result": r, "formatted": calls[0], "printed": "".join(out), "open": mem.open_bytes()}))
`);
  assert.deepEqual(got, { result: "refused", formatted: 0, printed: "", open: 0 });
});

// (astra's R2 admission order, daybreak3) before an operation's reservation is admitted, nothing proportional to its
// operands is built: the bodies of the reservation helpers hold only running scalars (no comprehension, list
// repetition, list(), or append; a generator into sum() or max() is a scan); fails on a helper that builds widths
test("§8.5: the reservation helpers compute their figures in constant space, before admission", () => {
  const src = readFileSync(join(ROOT, "lib", "_rill", "base.py"), "utf8");
  for (const name of ["_print_reservation", "_cat_reservation"]) {
    const start = src.indexOf(`def ${name}(`);
    assert.ok(start >= 0, name);
    // (the body from its docstring to its last reservation, the one that admits the operation)
    const next = src.indexOf("\ndef ", start + 1);
    const fn = src.slice(start, next < 0 ? undefined : next);
    const body = fn.slice(fn.indexOf('"""', fn.indexOf('"""') + 3) + 3, fn.lastIndexOf("return mem.reserve("));
    assert.doesNotMatch(body, /\[[^\]\n]*\bfor\b/, `${name}: a list built by a comprehension before admission`);
    assert.doesNotMatch(body, /\]\s*\*\s*\w/, `${name}: a list repeated before admission`);
    assert.doesNotMatch(body, /\blist\(|\.append\(|\bsorted\(|\{[^}\n]*\bfor\b/, `${name}: a collection built before admission`);
  }
});

test("§8.5: the parser's tokens and tree are reserved for the source's size while a program runs", () => {
  const got = py(`
import json, _rill
from _rill import mem
import _memguard
mem.SMALL_BYTES = 0
src = "1 + 1\\n" * 100
need = len(src) * 256
mem._allowance = lambda: (need - 1 - mem.open_bytes(), None)
err = []
st = _rill.run(src, lambda t: None, err.append)
print(json.dumps({"status": st, "err": "".join(err).split("\\n")[0], "open": mem.open_bytes(), "need": need}))
`);
  assert.equal(got.status, 1);
  assert.match(got.err, /^Error: cannot allocate vector of size \d+\.\d Kb$/);
  assert.equal(got.open, 0);
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

// (astra's R3) the census fails closed: each mutant plants one spelling in a copy of lib/_rill, and the census must
// either list a new route or report a problem, never return the same 36 routes and no problem
test("§9: the gate census catches every planted route spelling (mutants)", async () => {
  const { census } = await import(join(ROOT, "scripts", "rill-gates.mjs"));
  const base = census(ROOT);
  assert.deepEqual(base.problems, []);
  const MUTANTS: [string, string, RegExp][] = [
    ["mem.py", "import sys as s\n", /import the census can't read|`as`/],
    ["mem.py", "from sys import stdout\n", /absolute `from … import`/],
    ["mem.py", "import sys\nout = sys\n", /host module sys used as a value/],
    ["mem.py", "import os\nos.system('x')\n", /^host:os\.system$|^import:os$/],
    ["base.py", "BUILTINS['evil'] = cat\n", /BUILTINS used in a form/],
    ["base.py", "BUILTINS.update(evil=cat)\n", /BUILTINS used in a form/],
    ["base.py", "VALUES.setdefault('x', 1)\n", /VALUES used in a form/],
    ["eval.py", "x = (1).__class__\n", /introspection attribute __class__/],
    ["eval.py", "g = run.__globals__\n", /introspection attribute __globals__/],
    ["eval.py", "f = open('x')\n", /^call:open$/],
    ["eval.py", "e = eval('1')\n", /^call:eval$/],
    ["base.py", 'BUILTINS["evil"] = cat\n', /^builtin:evil$/],
    ["base.py", 'BUILTINS = {"probe_print": print_}\n', /BUILTINS assigned more than once|^builtin:probe_print$/],
    ["base.py", 'VALUES = {"probe": 1}\n', /VALUES assigned more than once|^value:probe$/],
    ["base.py", 'PREFLIGHT = {"cat": print_}\n', /PREFLIGHT assigned more than once/],
    ["base.py", 'PREFLIGHT["probe"] = cat\n', /^preflight:probe$/],
    ["base.py", 'VALUES["probe"] = cat\n', /^value:probe$/],
  ];
  for (const [file, code, want] of MUTANTS) {
    const dir = mkdtempSync(join(tmpdir(), "rill-census-"));
    try {
      cpSync(join(ROOT, "lib", "_rill"), join(dir, "lib", "_rill"), { recursive: true });
      appendFileSync(join(dir, "lib", "_rill", file), "\n" + code);
      const got = census(dir);
      const newRoutes = [...got.routes.keys()].filter((k: string) => !base.routes.has(k));
      const caught = got.problems.some((p: string) => want.test(p)) || newRoutes.some((k: string) => want.test(k));
      assert.ok(caught, `${file} + ${JSON.stringify(code)}: not caught (problems ${JSON.stringify(got.problems)}, new routes ${JSON.stringify(newRoutes)})`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

// (daybreak3) Stop through the CLI launcher, for real: SIGINT during a long evaluation and during a long parse.
// What is asserted is the outcome, never a latency (@sagebrush, Nov 8: latency belongs in the PERF packet): each was
// still running at the signal; the process ends by SIGINT; the work after the signal is bounded, since the program's
// last step (a marker printed at its end, or the error its parse would lead to) never happens; nothing is printed
// and there is no host traceback.  The kill after 120 s only keeps a hang from stalling the suite; a hang fails it.
function interrupted(args: string[], cwd: string): Promise<{ alive: boolean; code: number | null; signal: string | null; stdout: string; stderr: string }> {
  const { spawn } = require("node:child_process");
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [CLI, ...args], { cwd });
    let stdout = "", stderr = "", exited = false;
    p.stdout.on("data", (d: Buffer) => (stdout += d));
    p.stderr.on("data", (d: Buffer) => (stderr += d));
    p.on("exit", () => (exited = true));
    setTimeout(() => {
      const alive = !exited;
      p.kill("SIGINT");
      const guard = setTimeout(() => p.kill("SIGKILL"), 120000);
      p.on("close", (code: number | null, signal: string | null) => (clearTimeout(guard), resolve({ alive, code, signal, stdout, stderr })));
    }, 2000);
  });
}

test("§8: Stop (SIGINT) ends a long evaluation and a long parse, and nothing after it runs, through the CLI", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rill-sigint-"));
  try {
    const ev = await interrupted(["--rill", "-c", "x <- 1:1000000\n" + "y <- x + x\n".repeat(400) + 'cat("finished")\n'], dir);
    assert.ok(ev.alive, "the evaluation was still running at the signal");
    assert.equal(ev.signal, "SIGINT", `ended by the interrupt (${ev.signal ?? ev.code})`);
    assert.equal(ev.stdout, "", "its last step never ran, and nothing was printed");
    assert.doesNotMatch(ev.stderr, /Traceback|File "/);
    writeFileSync(join(dir, "big.R"), new Array(2000000).fill("1").join(" + "));
    const pa = await interrupted(["-c", "import _rill\n_rill.run(open('big.R').read())\n"], dir);
    assert.ok(pa.alive, "the parse was still running at the signal");
    assert.equal(pa.signal, "SIGINT", `ended by the interrupt (${pa.signal ?? pa.code})`);
    assert.equal(pa.stdout + pa.stderr, "", "the parse never finished: no evaluation, no error, nothing printed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// (A1.2, daybreak3) R's matching happens before any argument is evaluated: an unused or doubly matched argument is
// R's error with no argument's effect (no output, no assignment), as a refusal is (args.py)
test("args: matching fails before any argument is evaluated, with R's errors", () => {
  const got = py(`
import json
from _rill.eval import Session, RError
from _rill.parse import parse
out = []
s = Session(out.append, out.append)
s.evaluate(parse("x <- 1")[0])
r = {}
for src in ('numeric(x <- 3, foo = 1)', 'numeric(cat("E"), foo = 1)', 'numeric(len = cat("E"), le = 2)', 'length(cat("E"), 2)'):
    try:
        s.evaluate(parse(src)[0])
        r[src] = "no error"
    except RError as e:
        r[src] = e.message
r["x"] = s.globals["x"].data
r["out"] = "".join(out)
print(json.dumps(r))
`);
  assert.deepEqual(got, {
    "numeric(x <- 3, foo = 1)": "unused argument (foo = 1)",
    'numeric(cat("E"), foo = 1)': "unused argument (foo = 1)",
    'numeric(len = cat("E"), le = 2)': 'formal argument "length" matched by multiple actual arguments',
    'length(cat("E"), 2)': "2 arguments passed to 'length' which requires 1",
    x: [1],
    out: "",
  });
});

// (astra's #999 SEC 2 and 3) a missing required argument and a refused route stop a call before any of its
// arguments runs: no output and no assignment; and a builtin reads each value by the formal it matched, so a
// reordered or named call is the same call (rill-tests/access/#print-x-after-digits and the rows after it)
test("args: a missing x and the raw refusal come before any argument runs; values by matched formal", () => {
  const got = py(`
import json
from _rill.eval import Session, RError, NotSupported
from _rill.parse import parse
out = []
s = Session(out.append, out.append)
r = {}
for src in ('is.vector(mode = cat("E"))', 'is.vector(mode = (a <- "any"))', 'print(digits = cat("E"))',
            'print(digits = (b <- 3))', 'raw(cat("E"))', 'raw(c <- 1)', 'as.raw(cat("E"))', 'as.raw(d <- 1)',
            'options(width = cat("E"))', 'options(cat("E"))', 'options(e <- 1)',
            'print(digits = 3, 1.23456)', 'print(digits = 3, x = c(a = 1.23456))', 'is.vector(mode = "numeric", 1L)',
            'is.vector(mode = "character", x = 1)', 'print(digits = 2, x = 1/3)'):
    out.clear()
    try:
        v = s.evaluate(parse(src)[0])
        r[src] = ["value", "".join(out), v.data if hasattr(v, "data") else None]
    except RError as e:
        r[src] = ["error", "".join(out), e.message]
    except NotSupported as e:
        r[src] = ["refused", "".join(out), str(e)]
r["assigned"] = sorted(k for k in "abcde" if k in s.globals)
print(json.dumps(r))
`);
  const missing = 'argument "x" is missing, with no default';
  assert.deepEqual(got, {
    'is.vector(mode = cat("E"))': ["error", "", missing],
    'is.vector(mode = (a <- "any"))': ["error", "", missing],
    'print(digits = cat("E"))': ["refused", "", "print() without x"],
    "print(digits = (b <- 3))": ["refused", "", "print() without x"],
    'raw(cat("E"))': ["refused", "", "raw vectors"],
    "raw(c <- 1)": ["refused", "", "raw vectors"],
    'as.raw(cat("E"))': ["refused", "", "raw vectors"],
    "as.raw(d <- 1)": ["refused", "", "raw vectors"],
    'options(width = cat("E"))': ["refused", "", "options(width =)"],
    'options(cat("E"))': ["refused", "", "options() with an unnamed argument"],
    "options(e <- 1)": ["refused", "", "options() with an unnamed argument"],
    "print(digits = 3, 1.23456)": ["value", "[1] 1.23\n", [1.23456]],
    "print(digits = 3, x = c(a = 1.23456))": ["value", "   a \n1.23 \n", [1.23456]],
    'is.vector(mode = "numeric", 1L)': ["value", "", [true]],
    'is.vector(mode = "character", x = 1)': ["value", "", [false]],
    // (daybreak3's FORMALS-1 probe: x printed with 2 digits, not digits printed)
    "print(digits = 2, x = 1/3)": ["value", "[1] 0.33\n", [1 / 3]],
    assigned: [],
  });
});

// (an engine review of #999) an infinite subscript, scipen, power or colon end reached Python's int(inf), and its
// OverflowError escaped as a host traceback.  Through the CLI each is R's own answer (rill-tests/access/, the
// index-inf, options-scipen, power- and colon- rows), and no Python error reaches stderr
test("args: infinities in a subscript, scipen, a power and a colon end give R's answers, never a host traceback", () => {
  const dir = mkdtempSync(join(tmpdir(), "rill-inf-"));
  try {
    const cases: [string, RegExp][] = [
      ["x <- 1:3; x[Inf]", /^\[1\] NA\n$/],
      ["x <- 1:3; x[-Inf]", /^\[1\] NA\n$/],
      ["x <- 1:3; x[c(1, Inf)]", /^\[1\]  1 NA\n$/],
      ["x <- 1:3; x[c(-1, -Inf)]", /only 0's may be mixed with negative subscripts/],
      ["options(scipen = Inf)", /setting scipen=inf is out of range/],
      ["options(scipen = -Inf)", /setting scipen=-inf is out of range/],
      ["c((-2)^Inf, (-0.5)^-Inf, (-1)^Inf)", /^\[1\] NaN NaN NaN\n$/],
      ["(1+1i)^Inf", /^\[1\] Inf\+NaNi\n$/],
      ["(2+0i)^complex(real = -Inf)", /^\[1\] 0\+0i\n$/],
      ["(10+1i)^400.5", /^\[1\] /],
      ["1:Inf", /result would be too long a vector/],
      ["-Inf:1", /result would be too long a vector/],
    ];
    for (const [src, want] of cases) {
      const r = rill(src, dir);
      const both = r.stdout + r.stderr;
      assert.match(both, want, src + ": " + JSON.stringify(both));
      assert.doesNotMatch(both, /Traceback|OverflowError|File "/, src + ": a host traceback: " + JSON.stringify(both));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// (A1.2, daybreak3) Stop inside a reservation gives it back, in each of A1.2's classes: a constructor, `[`, an
// escaped print; Stop is never caught on the way out
test("§8: Stop inside A1.2's reservations (a constructor, [, an escaped print) gives back what they held", () => {
  const got = py(`
import json
from _rill import mem, access, fmt
from _rill.eval import Session
from _rill.parse import parse
s = Session(lambda t: None, lambda t: None)
s.evaluate(parse('x <- c(a = 1, b = 2, c = 3)')[0])
s.evaluate(parse('y <- "' + chr(92) + 'U0001fffe"')[0])
mem.SMALL_BYTES = 0
mem._allowance = lambda: (10 ** 9, None)
def stop(*a, **k):
    raise KeyboardInterrupt
r = {}
for src, (mod, attr) in (("numeric(5)", (access, "ZERO")), ("x[2:3]", (access, "_positions")), ("print(y)", (fmt, "format_elements"))):
    saved = getattr(mod, attr)
    if attr == "ZERO":
        class Boom(dict):
            def __getitem__(self, k):
                raise KeyboardInterrupt
        setattr(mod, attr, Boom())
    else:
        setattr(mod, attr, stop)
    try:
        s.evaluate(parse(src)[0])
        r[src] = "no stop"
    except KeyboardInterrupt:
        r[src] = mem.open_bytes()
    finally:
        setattr(mod, attr, saved)
print(json.dumps(r))
`);
  assert.deepEqual(got, { "numeric(5)": 0, "x[2:3]": 0, "print(y)": 0 });
});

// (A1.2) lib/_rill/uchar.py is exactly what scripts/rill-uchar.py makes of R's recorded sweep
// (rill-tests/print/uchar-sweep.txt): no hand edit, no drift
test("uchar: Rill's character table is the one generated from R 4.5.3's recorded sweep", () => {
  const r = spawnSync("python3", [join(ROOT, "scripts", "rill-uchar.py"), "--check"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});
