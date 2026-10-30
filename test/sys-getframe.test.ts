import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// sys._getframe and sys._getframemodulename (src/runtime/index.ts): the
// chains of frames compared with CPython's, then the controls of what can't
// be compared: a stack that can't be shown complete (the engine's limit, a
// site that can't be placed, code run outside any Python execution, an
// engine other than V8) is refused, not guessed; the capture restores the
// engine's settings; an execution's globals are held weakly by the runtime
// and strongly by a frame; the entry marker survives full minification.
const ROOT = __dirname + "/../..";
const CASES = ROOT + "/test/sys_getframe_cases.py";
const CLI = __dirname + "/../src/cli.js";
const cli = (args: string[]) => execFileSync(process.execPath, [CLI, ...args], { encoding: "utf8" });
const has = (cmd: string) => {
  try {
    execFileSync(cmd, ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

const { R } = require("../src/compile");
const { frameState, scripts } = require("../src/runtime/index");
const { initParser } = require("../src/parse");

// Run Python in this process: the namespace's `r` afterwards
function py(src: string): any {
  const m = R.newModule("__main__");
  R.loader.exec(src, m, "exec", "<frames>");
  return m.r;
}
// (a Python statement's outcome as text: its value's repr or its exception)
const OUTCOME = `
def outcome(f):
    try:
        return repr(f())
    except Exception as e:
        return type(e).__name__ + ": " + str(e)
`;
// Each hook set for one call, and put back however it ends
function hooked<X>(set: Partial<typeof frameState>, f: () => X): X {
  const saved: any = {};
  for (const k of Object.keys(set)) saved[k] = (frameState as any)[k];
  Object.assign(frameState, set);
  try {
    return f();
  } finally {
    Object.assign(frameState, saved);
  }
}

test.before(async () => {
  await initParser();
});

test("every frame chain, depth and message as CPython's", () => {
  const want = execFileSync("python3", [CASES], { encoding: "utf8" });
  assert.equal(cli([CASES]), want);
});

test("what differs from CPython, as documented: no f_locals, the repr, __module__ read from the globals, a frame's code can't run", () => {
  const r = py(`${OUTCOME}
import sys, re
def f():
    return sys._getframe(0)
def named():
    return sys._getframemodulename(0)
named.__module__ = "elsewhere"
fr = f()
r = [outcome(lambda: fr.f_locals), outcome(lambda: fr.f_trace), re.sub("line [0-9]+", "line N", repr(fr)),
     named(), outcome(lambda: exec(fr.f_code)), fr.f_code.co_filename]
`);
  assert.deepEqual(R.toArray(r), [
    "AttributeError: 'frame' object has no attribute 'f_locals'",
    "AttributeError: 'frame' object has no attribute 'f_trace'",
    "<frame file '<frames>', line N, code f>",
    // (CPython's answer is 'elsewhere', the function's __module__)
    "__main__",
    "NotImplementedError: exec() of a frame's code object: sys._getframe's frames have no code to run",
    "<frames>",
  ]);
});

test("the engine is verified as V8, by a frame that returns a call staying on the stack", () => {
  py("import sys\nr = sys._getframe(0)");
  assert.equal(frameState.v8, true);
});

test("a stack cut by the engine's limit: the known frames right, then RuntimeError, never ValueError or None", () => {
  const src = `${OUTCOME}
import sys
def chain():
    out, f = [], sys._getframe(0)
    while True:
        out.append(f.f_code.co_name)
        try:
            f = f.f_back
        except RuntimeError as e:
            return out, "RuntimeError: " + str(e)
        if f is None:
            return out, None
def deep(n):
    return chain() if n == 0 else deep(n - 1)
known, end = deep(30)
r = [known[:4], len(known), end, outcome(lambda: deep_at(30, 200)), outcome(lambda: deep_name(30, 200))]
`;
  const tail = `
def deep_at(n, d):
    return sys._getframe(d) if n == 0 else deep_at(n - 1, d)
def deep_name(n, d):
    return sys._getframemodulename(d) if n == 0 else deep_name(n - 1, d)
`;
  const whole = R.toArray(py(src.replace("known, end", tail + "known, end")));
  // (complete: the whole chain, then None; past it ValueError and None)
  assert.deepEqual(R.toArray(whole[0]), ["chain", "deep", "deep", "deep"]);
  assert.equal(whole[2], null);
  assert.equal(whole[3], "ValueError: call stack is not deep enough");
  assert.equal(whole[4], "None");
  const cut = R.toArray(hooked({ captureLimit: 25 }, () => py(src.replace("known, end", tail + "known, end"))));
  assert.deepEqual(R.toArray(cut[0]), ["chain", "deep", "deep", "deep"]);
  assert.ok(cut[1] < whole[1], `${cut[1]} known frames of ${whole[1]}`);
  assert.match(cut[2], /^RuntimeError: sys\._getframe: the call stack is incomplete .*; frames past \d+ are unknown$/);
  assert.match(cut[3], /^RuntimeError: sys\._getframe: the call stack is incomplete/);
  assert.match(cut[4], /^RuntimeError: sys\._getframemodulename: the call stack is incomplete/);
});

test("the capture restores the engine's stack limit and site format, when its reading throws too", () => {
  const limit = Error.stackTraceLimit;
  const prep = (Error as any).prepareStackTrace;
  py("import sys\nr = sys._getframe(0)");
  assert.equal(Error.stackTraceLimit, limit);
  assert.equal((Error as any).prepareStackTrace, prep);
  let seen: any;
  const r = hooked({ captureLimit: 7, testSites: () => {
    seen = Error.stackTraceLimit;
    throw new Error("forced");
  } }, () => {
    try {
      py("import sys\nr = sys._getframe(0)");
      return "no error";
    } catch (e: any) {
      return String(e?.message ?? e);
    }
  });
  assert.equal(seen, 7);
  assert.equal(r, "forced");
  assert.equal(Error.stackTraceLimit, limit);
  assert.equal((Error as any).prepareStackTrace, prep);
});

test("an engine giving stack text, not V8's call sites (JavaScriptCore's, with a frame lost to a tail call): AttributeError, as without the names", () => {
  // (Bun's text for f -> g -> chain, where g's `return chain()` replaced its frame)
  const text = "Error\n    at chain (py:/t.py:9:20)\n    at f (py:/t.py:14:12)\n    at $module$$ (py:/t.py:16:1)\n    at $pyEntry$$ (py:$entry:1:80)";
  const r = hooked({ testSites: () => text }, () => R.toArray(py(`${OUTCOME}
import sys
r = [outcome(lambda: sys._getframe(0)), outcome(lambda: sys._getframemodulename(0))]
`)));
  assert.deepEqual(r, [
    "AttributeError: sys._getframe is not available on this JavaScript engine (frames can't be verified)",
    "AttributeError: sys._getframemodulename is not available on this JavaScript engine (frames can't be verified)",
  ]);
});

// (one fake site among the real ones, just inside the innermost Python frame)
function withSite(fake: any) {
  return (sites: any[]) => {
    const i = sites.findIndex((cs) => String(cs.getFileName() ?? "").startsWith("py:<exec-"));
    return [...sites.slice(0, i + 1), fake, ...sites.slice(i + 1)];
  };
}
const site = (o: any) => ({ getFunctionName: () => "x", getFileName: () => undefined, getScriptNameOrSourceURL: () => undefined, getLineNumber: () => 3, isEval: () => false, isAsync: () => false, ...o });

test("a site between the entry markers that can't be placed, or an async one, ends the known frames: RuntimeError past them", () => {
  const src = `${OUTCOME}
import sys
def f():
    return [outcome(lambda: sys._getframe(0).f_code.co_name), outcome(lambda: sys._getframe(2).f_code.co_name), outcome(lambda: sys._getframe(3)), outcome(lambda: sys._getframemodulename(3))]
r = f()
`;
  for (const fake of [site({}), site({ isAsync: () => true, getFileName: () => "/x.js" })]) {
    const r = R.toArray(hooked({ testSites: withSite(fake) }, () => py(src)));
    // (the frame inside the fake site, the lambda's, is known; f and the
    // module's, past it, are not)
    assert.equal(r[0], "'<lambda>'");
    assert.match(r[1], /^RuntimeError: sys\._getframe: the call stack is incomplete .*; frames past 1 are unknown$/);
    assert.match(r[2], /^RuntimeError: sys\._getframe: the call stack is incomplete .*; frames past 1 are unknown$/);
    assert.match(r[3], /^RuntimeError: sys\._getframemodulename: the call stack is incomplete .*; frames past 1 are unknown$/);
  }
  // (a site made by eval or new Function, the runtime's call wrappers', is placed)
  const placed = R.toArray(hooked({ testSites: withSite(site({ isEval: () => true, getEvalOrigin: () => "eval at checkArity (/r/object.js:1:1)" })) }, () => py(src)));
  // (the lambda, outcome, f, the module's: all four, the stack complete)
  assert.equal(placed[1], "'f'");
  assert.match(placed[2], /, code <module>>$/);
  assert.equal(placed[3], "'__main__'");
});

test("Python called back from JavaScript after its execution returned: its own frames, then RuntimeError", () => {
  const m = R.newModule("__main__");
  R.loader.exec(`${OUTCOME}
import sys
def later():
    # (from the lambdas: the lambda, outcome, later; then the unknown)
    return [sys._getframe(0).f_code.co_name, outcome(lambda: sys._getframe(2).f_code.co_name), outcome(lambda: sys._getframe(3)), outcome(lambda: sys._getframemodulename(3)), outcome(lambda: sys._getframe(2).f_back)]
`, m, "exec", "<frames>");
  assert.equal(frameState.entryDepth, 0);
  const r = R.toArray(R.callObj(m.later, []));
  assert.equal(r[0], "later");
  assert.equal(r[1], "'later'");
  assert.match(r[2], /^RuntimeError: sys\._getframe: the call stack is incomplete .*frames past 3 are unknown$/);
  assert.match(r[3], /^RuntimeError: sys\._getframemodulename: the call stack is incomplete .*frames past 3 are unknown$/);
  assert.match(r[4], /^RuntimeError: sys\._getframe: the call stack is incomplete .*frames past 3 are unknown$/);
});

test("a frame whose globals are gone reports them unknown, never None", () => {
  const r = hooked({ testLostGlobals: true }, () => R.toArray(py(`${OUTCOME}
import sys
r = [outcome(lambda: sys._getframe(0).f_globals), outcome(lambda: sys._getframemodulename(0)), outcome(lambda: sys._getframe(0).f_code.co_name)]
`)));
  assert.match(r[0], /^RuntimeError: sys\._getframe: the globals of this frame \(<lambda>, in <frames>\) are unknown$/);
  assert.match(r[1], /^RuntimeError: sys\._getframe: the globals of this frame/);
  assert.equal(r[2], "'<lambda>'");
});

test("an exec's namespace is held weakly: collected once its functions are gone, kept by a live function or a frame", () => {
  const prog = `
const { R } = require(${JSON.stringify(__dirname + "/../src/compile")});
const { scripts } = require(${JSON.stringify(__dirname + "/../src/runtime/index")});
const { initParser } = require(${JSON.stringify(__dirname + "/../src/parse")});
const { dictGet } = require(${JSON.stringify(__dirname + "/../src/runtime/object")});
const run = (src) => { const ns = R.newModule("__main__"); R.loader.exec(src, ns, "exec", "<gc>"); return ns; };
const last = () => [...scripts.values()].pop();
const tick = () => new Promise((r) => setTimeout(r, 0));
(async () => {
  await initParser();
  const fired = [];
  const reg = new FinalizationRegistry((k) => fired.push(k));
  let ns = run("import sys\\ndef f(): return sys._getframe(0).f_globals\\nbig = [0] * 1000");
  const dead = last();
  reg.register(ns, "dead");
  let keep = run("import sys\\ndef f(): return sys._getframe(0).f_globals\\ntag = 'kept'");
  const kept = keep.f, keptInfo = last();
  let framed = run("import sys\\nx = 'framed'\\nfr = sys._getframe(0)");
  const fr = framed.fr, framedInfo = last();
  reg.register(framed, "framed");
  // (no reference left here but the function's and the frame's)
  ns = keep = framed = null;
  for (let i = 0; i < 6 && fired.length < 1; i++) { global.gc(); await tick(); }
  const g = R.callObj(kept, []);
  console.log(JSON.stringify({
    deadCleared: dead.globals.deref() === undefined,
    fired,
    keptAlive: keptInfo.globals.deref() !== undefined,
    keptTag: dictGet(g, "tag"),
    frameGlobals: dictGet(R.getattr(fr, "f_globals"), "x"),
  }));
})();
`;
  const dir = mkdtempSync(join(require("node:os").tmpdir(), "frames-gc-"));
  try {
    const file = join(dir, "gc.js");
    writeFileSync(file, prog);
    const out = JSON.parse(execFileSync(process.execPath, ["--expose-gc", file], { encoding: "utf8" }));
    assert.equal(out.deadCleared, true);
    assert.ok(out.fired.includes("dead"), JSON.stringify(out.fired));
    assert.equal(out.keptAlive, true);
    assert.equal(out.keptTag, "kept");
    assert.equal(out.frameGlobals, "framed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a notebook's cells: frames with the session's namespace, namedtuple and Enum made in cells pickle", async () => {
  const { notebookSession } = require("../src/notebook-session");
  const msgs: any[] = [];
  const s = notebookSession((m: any) => msgs.push(m), { captureStreams: true });
  await s.ready;
  const cells = [
    "import sys, pickle, enum\nfrom collections import namedtuple\nP = namedtuple('P', 'x')\nE = enum.Enum('E', 'A')",
    "def where():\n    f = sys._getframe(0)\n    return f.f_code.co_name, f.f_back.f_code.co_name, f.f_globals['__name__'], sys._getframemodulename(1)\nprint(where())",
    "print(P.__module__, E.__module__, pickle.loads(pickle.dumps(P(1))), pickle.loads(pickle.dumps(E.A)))",
  ];
  let id = 0;
  const outs: string[] = [];
  for (const code of cells) {
    const n = ++id;
    await s.handle({ id: n, code });
    const err = msgs.filter((m) => m.id === n && m.stream === "stderr").map((m) => m.text).join("");
    assert.equal(err, "", code);
    outs.push(msgs.filter((m) => m.id === n && m.stream === "stdout").map((m) => m.text).join(""));
  }
  assert.deepEqual(outs, ["", "('where', '<module>', '__main__', '__main__')\n", "__main__ __main__ P(x=1) E.A\n"]);
});

// (namedtuple's and Enum's module, the standard library's callers, where
// the frames are refused: as without the names, today's results)
const CALLERS = `
import sys, enum
from collections import namedtuple
if len(sys.argv) > 1:
    del sys._getframe, sys._getframemodulename
print(namedtuple("P", "x").__module__, enum.Enum("E", "A").__module__)
`;

test("fully minified (bun build --minify), with Node's vm and with the browser worker's eval: the marker and frames as unminified, on V8; refused under JavaScriptCore, the callers as without the names", { skip: !has("bun") && "no bun here" }, () => {
  // (in dist/, two levels under the library's parent)
  const dir = mkdtempSync(join(ROOT, "dist", "frames-min-"));
  try {
    const bundle = join(dir, "cli.cjs");
    // (bun writes in the source's own __dirname: the bundle's instead, so
    // that its ../../lib is the library)
    execFileSync("bun", ["build", join(ROOT, "src", "cli.ts"), "--target=node", "--format=cjs", "--minify", `--define=__dirname=${JSON.stringify(dir)}`, "--outfile", bundle], { stdio: "ignore" });
    const want = execFileSync("python3", [CASES], { encoding: "utf8" });
    assert.equal(execFileSync(process.execPath, [bundle, CASES], { encoding: "utf8" }), want);
    // (the browser worker's way to run compiled code, web/shims/vm.ts: eval
    // with a //# sourceURL, so sites have no file name, only that URL)
    const shimmed = join(dir, "shimmed.cjs");
    writeFileSync(join(dir, "build.ts"), `const [src, shim, out, dir] = process.argv.slice(2);
const r = await Bun.build({ entrypoints: [src], target: "node", format: "cjs", minify: true, define: { __dirname: JSON.stringify(dir) },
  plugins: [{ name: "vm-shim", setup(b) { b.onResolve({ filter: /^(node:)?vm$/ }, () => ({ path: shim })); } }] });
if (!r.success) throw new Error(r.logs.join("\\n"));
await Bun.write(out, r.outputs[0]);
`);
    execFileSync("bun", [join(dir, "build.ts"), join(ROOT, "src", "cli.ts"), join(ROOT, "web", "shims", "vm.ts"), shimmed, dir], { stdio: "ignore" });
    assert.match(readFileSync(shimmed, "utf8"), /sourceURL=/);
    assert.equal(execFileSync(process.execPath, [shimmed, CASES], { encoding: "utf8" }), want);
    const callers = join(dir, "callers.py");
    writeFileSync(callers, CALLERS);
    const without = execFileSync(process.execPath, [bundle, callers, "without"], { encoding: "utf8" });
    const jsc = execFileSync("bun", [bundle, "-c", "import sys\ntry:\n    sys._getframe(0)\nexcept AttributeError as e:\n    print(e)\n"], { encoding: "utf8" });
    assert.equal(jsc, "sys._getframe is not available on this JavaScript engine (frames can't be verified)\n");
    assert.equal(execFileSync("bun", [bundle, callers], { encoding: "utf8" }), without);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the scripts registry: a module's file run twice is two scripts, each with its own globals", () => {
  const names = [...scripts.keys()].filter((k: string) => k.includes("%run"));
  for (const k of names) assert.match(k, /^py:[^%]*(%[0-9A-F]{2}[^%]*)*%run\d+$/);
});
