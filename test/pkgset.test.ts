import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Worker } from "node:worker_threads";

// Optional package sets (src/pkgset.ts, src/compile.ts installPackageSet;
// plan-modular-packages-r4 §4.1–4.2, §4.5, §6.4): a set is admitted only from
// the exact bytes its id names; every chunk and file is checked against the
// index's pins and ownership before any of it runs; nothing in a set can
// replace or extend the core's or a bundled package's modules, or the core's
// precompiled code; a failed admission changes nothing.
const DIST = __dirname + "/..";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const P = require(DIST + "/src/pkgset.js");
const sha = (b: string | Uint8Array) => createHash("sha256").update(b).digest("hex");
const enc = (s: string) => new TextEncoder().encode(s);
const BUILD = "0123456789abcdef";

// JSON with sorted keys (RFC 8785 for this data: strings, integers, objects, arrays)
function canon(v: any): string {
  if (Array.isArray(v)) return "[" + v.map(canon).join(",") + "]";
  if (v !== null && typeof v === "object") return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + canon(v[k])).join(",") + "}";
  return JSON.stringify(v);
}

type Pkg = { name: string; version?: string; root?: string; modules: string[]; files: Record<string, string>; requires?: string[]; level?: number; pre?: Record<string, any>; provides?: any };
// A set (index + chunks by sha256) for these packages; `mutate` edits the
// index object (or a chunk) before it is serialized, to build hostile sets
// whose hashes are still right.
function makeSet(pkgs: Pkg[], mutate?: { index?: (ix: any) => void; chunk?: (id: string, kind: string, c: any) => void }) {
  const chunks = new Map<string, Uint8Array>();
  const put = (obj: any) => {
    const b = enc(canon(obj));
    const h = sha(b);
    chunks.set(h, b);
    return { sha256: h, size: b.length };
  };
  const ix: any = { format: "sagebrush-pkgset", v: 1, core_api: 1, packages: {} };
  for (const p of pkgs) {
    const id = `@sagebrush/${p.name}@${p.version ?? "0.1.0"}`;
    const files: Record<string, string> = {};
    for (const [f, t] of Object.entries(p.files)) files[f] = sha(enc(t));
    const srcObj: any = { format: "sagebrush-pkg-chunk", v: 1, kind: "src", package: id, files: p.files };
    mutate?.chunk?.(id, "src", srcObj);
    const entry: any = {
      dir: p.name, root: p.root ?? "py", files, modules: p.modules, requires: p.requires ?? [],
      core_req: { api: 1, level: p.level ?? 1 }, src: put(srcObj), pre: {}, cost: { [BUILD]: { src: { cpu_ms: 100, peak_mb: 5 } } },
    };
    if (p.provides) entry.provides = p.provides;
    if (p.pre) {
      const preObj: any = { format: "sagebrush-pkg-chunk", v: 1, kind: "pre", package: id, build: BUILD, modules: p.pre };
      mutate?.chunk?.(id, "pre", preObj);
      entry.pre[BUILD] = put(preObj);
      entry.cost[BUILD].pre = { cpu_ms: 50, peak_mb: 5 };
    }
    ix.packages[id] = entry;
  }
  mutate?.index?.(ix);
  const index = enc(canon(ix));
  return { S: sha(index), index, chunks };
}
const reserved = { isCoreModule: (n: string) => ["json", "numpy", "sortedcontainers", "sys"].includes(n), bundledDirs: new Set(["pypi-sortedcontainers"]) };
const hello: Pkg = { name: "hello", modules: ["hello", "hello.sub"], files: { "py/hello/__init__.py": "GREETING = 'hi'\n", "py/hello/sub.py": "X = 2\n" } };
const refused = (f: () => unknown, re: RegExp) => assert.throws(f, (e: any) => e.name === "PkgsetError" && re.test(e.message));

test("a set is admitted only from the exact bytes its id names", () => {
  const s = makeSet([hello]);
  const plan = P.admitIndex(s.S, s.index, BUILD, reserved);
  assert.deepEqual([...plan.modules.keys()].sort(), ["hello", "hello.sub"]);
  refused(() => P.admitIndex("f".repeat(64), s.index, BUILD, reserved), /not the one its id names/);
  refused(() => P.admitIndex(s.S.slice(0, 20), s.index, BUILD, reserved), /64 lowercase hex/);
  const flipped = s.index.slice();
  flipped[10] ^= 1;
  refused(() => P.admitIndex(s.S, flipped, BUILD, reserved), /not the one its id names/);
});

test("strict JSON: duplicate keys, prototype keys, depth and trailing text are refused", () => {
  refused(() => P.strictJson('{"a":1,"a":2}'), /duplicate key/);
  refused(() => P.strictJson('{"__proto__":{}}'), /forbidden key/);
  refused(() => P.strictJson('{"x":{"constructor":1}}'), /forbidden key/);
  refused(() => P.strictJson("[".repeat(40) + "]".repeat(40)), /nested deeper/);
  refused(() => P.strictJson('{"a":1} x'), /trailing/);
  assert.equal(Object.getPrototypeOf(P.strictJson('{"a":{"b":[1,"x",true,null]}}')), null);
});

// (a hostile index with correct hashes: the S is its own bytes' digest)
test("hash-valid hostile sets are refused before anything changes (§4.2)", () => {
  const cases: [string, Pkg[], ((ix: any) => void) | undefined, RegExp][] = [
    ["replaces a core module", [{ ...hello, name: "evil", modules: ["json"], files: { "py/json.py": "" } }], undefined, /replace or extend the core's json/],
    ["extends a core module", [{ ...hello, name: "evil", modules: ["numpy", "numpy.evil"], files: { "py/numpy/__init__.py": "", "py/numpy/evil.py": "" } }], undefined, /core's numpy/],
    ["replaces a bundled module", [{ ...hello, name: "evil", modules: ["sortedcontainers"], files: { "py/sortedcontainers.py": "" } }], undefined, /core's sortedcontainers/],
    ["takes a bundled directory", [{ ...hello, name: "pypi-sortedcontainers" }], undefined, /bundled package's directory/],
    ["a path outside the package", [{ ...hello, files: { "py/hello/__init__.py": "", "py/../x.py": "" } }], undefined, /not a \.py path/],
    ["an absolute path", [{ ...hello, files: { "py/hello/__init__.py": "", "/etc/x.py": "" } }], undefined, /not a \.py path/],
    ["two versions of one package", [hello, { ...hello, version: "0.2.0" }], undefined, /one version of a package/],
    ["a module in two packages", [hello, { ...hello, name: "hello2" }], undefined, /module hello is also @sagebrush\/hello2?@0\.1\.0's/],
    ["a cycle", [{ ...hello, requires: ["@sagebrush/b@0.1.0"] }, { name: "b", modules: ["bb"], files: { "py/bb.py": "" }, requires: ["@sagebrush/hello@0.1.0"] }], undefined, /cycle/],
    ["a missing dependency", [{ ...hello, requires: ["@sagebrush/nope@1.0.0"] }], undefined, /not in this set/],
    ["needs a newer core", [{ ...hello, level: 2 }], undefined, /needs Sagebrush core API 1 level 2; this engine is core API 1 level 1/],
    ["an unknown field", [hello], (ix) => (ix.packages["@sagebrush/hello@0.1.0"].extra = 1), /unknown field/],
    ["a dir that isn't its id's", [hello], (ix) => (ix.packages["@sagebrush/hello@0.1.0"].dir = "other"), /dir must be its id's name/],
    ["another core API", [hello], (ix) => (ix.core_api = 2), /core API 2/],
  ];
  for (const [what, pkgs, mut, re] of cases) {
    const s = makeSet(pkgs, mut ? { index: mut } : undefined);
    assert.throws(() => P.admitIndex(s.S, s.index, BUILD, reserved), (e: any) => e.name === "PkgsetError" && re.test(e.message), what);
  }
  // depth 5: a -> b -> c -> d -> e -> f
  const chain: Pkg[] = ["a", "b", "c", "d", "e", "f"].map((n, i, all) => ({ name: n, modules: ["m" + n], files: { [`py/m${n}.py`]: "" }, requires: i + 1 < all.length ? [`@sagebrush/${all[i + 1]}@0.1.0`] : [] }));
  const deep = makeSet(chain);
  refused(() => P.admitIndex(deep.S, deep.index, BUILD, reserved), /deeper than 4/);
  // (and 5 levels is fine: a -> ... -> e)
  const ok = makeSet(chain.slice(1));
  assert.equal(P.admitIndex(ok.S, ok.index, BUILD, reserved).closure.get("@sagebrush/b@0.1.0").length, 5);
  // the same chain the other way round, the leaf visited first, so every
  // deeper visit reuses a cached closure (astra's CORR-PR68-1)
  const up: Pkg[] = ["a", "b", "c", "d", "e", "f"].map((n, i, all) => ({ name: n, modules: ["m" + n], files: { [`py/m${n}.py`]: "" }, requires: i ? [`@sagebrush/${all[i - 1]}@0.1.0`] : [] }));
  const upDeep = makeSet(up);
  refused(() => P.admitIndex(upDeep.S, upDeep.index, BUILD, reserved), /deeper than 4/);
  const upOk = makeSet(up.slice(0, 5));
  assert.equal(P.admitIndex(upOk.S, upOk.index, BUILD, reserved).closure.get("@sagebrush/e@0.1.0").length, 5);
  // a shared dependency reached first shallow (a -> z -> y), then deep
  // (b -> c -> d -> e -> z -> y): refused, and fine one level shorter
  const dep = (n: string, r: string[]): Pkg => ({ name: n, modules: ["m" + n], files: { [`py/m${n}.py`]: "" }, requires: r.map((x) => `@sagebrush/${x}@0.1.0`) });
  const shared = (leaf: boolean) => makeSet([dep("a", ["z"]), dep("b", ["c"]), dep("c", ["d"]), dep("d", ["e"]), dep("e", ["z"]), dep("z", leaf ? [] : ["y"]), ...(leaf ? [] : [dep("y", [])])]);
  const sd = shared(false);
  refused(() => P.admitIndex(sd.S, sd.index, BUILD, reserved), /deeper than 4/);
  const so = shared(true);
  assert.equal(P.admitIndex(so.S, so.index, BUILD, reserved).closure.get("@sagebrush/b@0.1.0").length, 5);
});

test("the limits: index bytes, packages and aggregate sources are checked from declared sizes", () => {
  const many: Pkg[] = Array.from({ length: 33 }, (_, i) => ({ name: "p" + i, modules: ["m" + i], files: { [`py/m${i}.py`]: "" } }));
  const s = makeSet(many);
  refused(() => P.admitIndex(s.S, s.index, BUILD, reserved), /at most 32 packages/);
  const big = makeSet([hello], { index: (ix) => (ix.packages["@sagebrush/hello@0.1.0"].src.size = 8 * 1024 * 1024 + 1) });
  refused(() => P.admitIndex(big.S, big.index, BUILD, reserved), /src\.size must be an integer/);
  const huge = new Uint8Array(256 * 1024 + 1);
  refused(() => P.admitIndex(sha(huge), huge, BUILD, reserved), /over 262144 bytes/);
  // each package within the chunk cap and the sources within theirs (14 MiB),
  // the set over the resident estimate: 2 x 14 + 3 x 7 = 49 MiB > 48 MiB
  const heavy = makeSet(Array.from({ length: 2 }, (_, i) => ({ name: "h" + i, modules: ["h" + i], files: { [`py/h${i}.py`]: "" } })), {
    index: (ix) => {
      for (const p of Object.values<any>(ix.packages)) p.src.size = 7 * 1024 * 1024;
    },
  });
  refused(() => P.admitIndex(heavy.S, heavy.index, BUILD, reserved), /in memory; at most/);
});

test("chunks: the pinned bytes, the right owner and kind, exactly the package's files", () => {
  const s = makeSet([hello, { name: "other", modules: ["other"], files: { "py/other.py": "Y = 1\n" } }]);
  const plan = P.admitIndex(s.S, s.index, BUILD, reserved);
  const ref = plan.packages.get("@sagebrush/hello@0.1.0").src;
  const ok = P.checkChunk(plan, "@sagebrush/hello@0.1.0", "src", BUILD, s.chunks.get(ref.sha256));
  assert.equal(ok.files.get("py/hello/sub.py"), "X = 2\n");
  // another package's chunk, presented as this one's
  const otherRef = plan.packages.get("@sagebrush/other@0.1.0").src;
  refused(() => P.checkChunk(plan, "@sagebrush/hello@0.1.0", "src", BUILD, s.chunks.get(otherRef.sha256)), /not the size|not the one the index pins/);
  // a chunk whose header names another package, with hashes made to match
  const lie = makeSet([hello], { chunk: (_id, kind, c) => kind === "src" && (c.package = "@sagebrush/other@0.1.0") });
  const lp = P.admitIndex(lie.S, lie.index, BUILD, reserved);
  const lr = lp.packages.get("@sagebrush/hello@0.1.0").src;
  refused(() => P.checkChunk(lp, "@sagebrush/hello@0.1.0", "src", BUILD, lie.chunks.get(lr.sha256)), /says it is @sagebrush\/other@0\.1\.0's src/);
  // a file that isn't the pinned one (the chunk's own hash matches the index)
  const swap = makeSet([hello], { chunk: (_id, kind, c) => kind === "src" && (c.files = { ...c.files, "py/hello/sub.py": "X = 3\n" }) });
  const sp = P.admitIndex(swap.S, swap.index, BUILD, reserved);
  refused(() => P.checkChunk(sp, "@sagebrush/hello@0.1.0", "src", BUILD, swap.chunks.get(sp.packages.get("@sagebrush/hello@0.1.0").src.sha256)), /sub\.py is not the file the index pins/);
  // an extra file
  const extra = makeSet([hello], { chunk: (_id, kind, c) => kind === "src" && (c.files = { ...c.files, "py/hello/x.py": "" }) });
  const ep = P.admitIndex(extra.S, extra.index, BUILD, reserved);
  refused(() => P.checkChunk(ep, "@sagebrush/hello@0.1.0", "src", BUILD, extra.chunks.get(ep.packages.get("@sagebrush/hello@0.1.0").src.sha256)), /not exactly the package's/);
});

test("precompiled entries: only the package's own modules and files, for this build", () => {
  const good = { "py|hello": { code: "(function(){})", lineMap: [], path: "py/hello/__init__.py" } };
  const cases: [string, any, RegExp][] = [
    ["a core module's entry", { "py|json": { code: "", lineMap: [], path: "py/hello/__init__.py" } }, /not one of its modules/],
    ["a core path", { "py|hello": { code: "", lineMap: [], path: "json/__init__.py" } }, /path is not one of its files/],
    ["another of its files", { "py|hello": { code: "", lineMap: [], path: "py/hello/sub.py" } }, /not its module's file/],
    ["a prototype key", null, /forbidden key/],
  ];
  for (const [what, modules, re] of cases) {
    const s = makeSet([{ ...hello, pre: modules ?? good }], modules === null ? { chunk: (_id, kind, c) => kind === "pre" && (c.modules = JSON.parse('{"__proto__":{"code":"","lineMap":[],"path":"py/hello/__init__.py"}}')) } : undefined);
    const plan = P.admitIndex(s.S, s.index, BUILD, reserved);
    const ref = plan.packages.get("@sagebrush/hello@0.1.0").pre[BUILD];
    assert.throws(() => P.checkChunk(plan, "@sagebrush/hello@0.1.0", "pre", BUILD, s.chunks.get(ref.sha256)), (e: any) => e.name === "PkgsetError" && re.test(e.message), what);
  }
  const s = makeSet([{ ...hello, pre: good }]);
  const plan = P.admitIndex(s.S, s.index, BUILD, reserved);
  refused(() => P.checkChunk(plan, "@sagebrush/hello@0.1.0", "pre", "fedcba9876543210", s.chunks.get(plan.packages.get("@sagebrush/hello@0.1.0").pre[BUILD].sha256)), /no precompiled code for build/);
});

test("the grader's admission: measured costs for this build only, summed over the closure", () => {
  const a: Pkg = { name: "a", modules: ["a"], files: { "py/a.py": "" }, requires: ["@sagebrush/b@0.1.0"] };
  const b: Pkg = { name: "b", modules: ["b"], files: { "py/b.py": "" } };
  const s = makeSet([a, b], {
    index: (ix) => {
      ix.packages["@sagebrush/a@0.1.0"].cost[BUILD].src = { cpu_ms: 1200, peak_mb: 20 };
      ix.packages["@sagebrush/b@0.1.0"].cost[BUILD].src = { cpu_ms: 1200, peak_mb: 20 };
    },
  });
  const plan = P.admitIndex(s.S, s.index, BUILD, reserved);
  const base = { cpu_ms: 680, peak_mb: 40 };
  // each alone passes: 1.5 x (680 + 1200) = 2820 ms
  assert.equal(P.graderAdmission(plan, ["@sagebrush/b@0.1.0"], BUILD, base).ok, true);
  // together they don't: 1.5 x (680 + 2400) = 4620 ms
  const both = P.graderAdmission(plan, ["@sagebrush/a@0.1.0"], BUILD, base);
  assert.equal(both.ok, false);
  assert.match(both.reason, /about 4620 ms to start, over 4000 ms/);
  // no measurement for this build: refused, never borrowed
  const other = P.graderAdmission(plan, ["@sagebrush/b@0.1.0"], "fedcba9876543210", base);
  assert.equal(other.ok, false);
  assert.match(other.reason, /no measured cost for build fedcba9876543210/);
});

// A fresh runtime with set `s` installed (chunks served from memory, counting
// fetches); the output of `code`, or the exception's last line
function run(code: string, s: { S: string; index: Uint8Array; chunks: Map<string, Uint8Array> }, opts: { build?: string; second?: { S: string; index: Uint8Array } } = {}): Promise<string> {
  const w = new Worker(
    `
    const { parentPort, workerData } = require("node:worker_threads");
    const c = require(workerData.dist + "/src/compile.js");
    Promise.resolve(c.initParser && c.initParser()).then(() => {
      if (workerData.build) globalThis.__SAGEBRUSH_BUILD_ID__ = workerData.build;
      const chunks = new Map(workerData.chunks);
      globalThis.__fetches = 0;
      c.installPackageSet(workerData.S, new Uint8Array(workerData.index), (ref) => {
        globalThis.__fetches++;
        const b = chunks.get(ref.sha256);
        if (!b) throw new Error("no such chunk " + ref.sha256.slice(0, 12));
        return new Uint8Array(b);
      });
      if (workerData.second) {
        try { c.installPackageSet(workerData.second.S, new Uint8Array(workerData.second.index), () => { throw new Error("no"); }); }
        catch (e) { parentPort.postMessage("second: " + e.message); return; }
      }
      const path = c.R.importModule("sys").path;
      path.push(c.libDir());
      const code = "import io as _io, sys as _sys\\n_buf = _sys.stdout = _io.StringIO()\\n" + workerData.code + "\\n_out = _buf.getvalue()\\n";
      try {
        parentPort.postMessage(c.execModule(code, "<test>", "__main__")._out);
      } catch (e) {
        parentPort.postMessage(c.R.formatException(e).trim().split("\\n").pop());
      }
    });
    `,
    { eval: true, workerData: { dist: DIST, code, S: s.S, index: s.index, chunks: [...s.chunks], build: opts.build, second: opts.second } },
  );
  return new Promise((resolve, reject) => {
    w.once("message", (m) => (w.terminate(), resolve(m)));
    w.once("error", reject);
  });
}

test("an optional package imports after sys.path, the library and bundled packages; its submodules too", async () => {
  const s = makeSet([hello]);
  assert.equal(await run("import hello, hello.sub\nprint(hello.GREETING, hello.sub.X, hello.__file__.startswith('/$pyjs/optional/'))", s), "hi 2 True\n");
});

test("dependencies mount first; a module the set doesn't have is not found", async () => {
  const s = makeSet([{ name: "a", modules: ["aa"], files: { "py/aa.py": "import bb\nV = bb.W + 1\n" }, requires: ["@sagebrush/b@0.1.0"] }, { name: "b", modules: ["bb"], files: { "py/bb.py": "W = 41\n" } }]);
  assert.equal(await run("import aa\nprint(aa.V)", s), "42\n");
  assert.equal(await run("import nothere", s), "ModuleNotFoundError: No module named 'nothere'");
});

test("a corrupt chunk is refused at import, and nothing of the package runs", async () => {
  const s = makeSet([{ ...hello, files: { "py/hello/__init__.py": "print('RAN')\n", "py/hello/sub.py": "" } }]);
  const [h] = [...s.chunks.keys()];
  const bad = new Map(s.chunks);
  const b = bad.get(h)!.slice();
  b[b.length - 3] ^= 1;
  bad.set(h, b);
  const out = await run("try:\n    import hello\nexcept ImportError as e:\n    print('refused:', 'not the one the index pins' in str(e))", { ...s, chunks: bad });
  assert.equal(out, "refused: True\n");
});

test("precompiled code of the set is used only for its own files, in this build; the core's table is untouched", async () => {
  // (code that says where it came from: the emitted module function, recognizably different)
  const s = makeSet([{ ...hello, files: { "py/hello/__init__.py": "WHO = 'source'\n", "py/hello/sub.py": "" }, pre: { "py|hello": { code: "(function module$$($g, R) { $g.WHO = 'pre'; })", lineMap: [], path: "py/hello/__init__.py" } } }]);
  assert.equal(await run("import hello\nprint(hello.WHO)", s, { build: BUILD }), "pre\n");
  // another build: the source
  assert.equal(await run("import hello\nprint(hello.WHO)", s, { build: "fedcba9876543210" }), "source\n");
  // (the bundled registry the core reports is the core's own: the set isn't in it)
  assert.equal(await run("import builtins\nprint('hello' in (builtins.__pyjs_package_registry__() or ''))", s), "False\n");
});

test("the grader's child: chunks from its own modules, mounted at startup, before any cell imports them", async () => {
  const s = makeSet([{ name: "a", modules: ["aa"], files: { "py/aa.py": "import bb\n" }, requires: ["@sagebrush/b@0.1.0"] }, { name: "b", modules: ["bb"], files: { "py/bb.py": "W = 1\n" } }]);
  const w = new Worker(
    `
    const { parentPort, workerData } = require("node:worker_threads");
    const c = require(workerData.dist + "/src/compile.js");
    Promise.resolve(c.initParser && c.initParser()).then(() => {
      let reads = 0;
      const fetch = c.chunksFrom(workerData.chunks.map(([h, b]) => [h, new Uint8Array(b)]));
      c.installPackageSet(workerData.S, new Uint8Array(workerData.index), (ref, what) => (reads++, fetch(ref, what)));
      const ids = c.premountPackages(["aa", "nothere"]);
      const before = reads;
      c.R.importModule("sys").path.push(c.libDir());
      const m = c.execModule("import aa, bb\\nx = bb.W", "<cell>", "__main__");
      parentPort.postMessage(JSON.stringify({ ids, before, after: reads, x: m.x }));
    });
    `,
    { eval: true, workerData: { dist: DIST, S: s.S, index: s.index, chunks: [...s.chunks] } },
  );
  const out = JSON.parse(await new Promise((resolve, reject) => (w.once("message", (m) => (w.terminate(), resolve(m))), w.once("error", reject))));
  assert.deepEqual(out, { ids: ["@sagebrush/b@0.1.0", "@sagebrush/a@0.1.0"], before: 2, after: 2, x: 1 });
});

test("one package set per runtime: another one is refused, the same again is a no-op", async () => {
  const s = makeSet([hello]);
  const t = makeSet([{ ...hello, version: "0.2.0" }]);
  assert.match(await run("", s, { second: t }), /^second: this session uses package set [0-9a-f]{12}; reopen it to use/);
  assert.equal(await run("import hello\nprint(hello.X if hasattr(hello, 'X') else 'ok')", s, { second: s }), "ok\n");
});

test("protocol calls: an added argument only for methods that implement it (§6.4)", async () => {
  // (run in the runtime: Python-defined methods, their real signatures)
  const s = makeSet([hello]);
  const code = [
    "class Old:",
    "    def __array__(self, dtype=None): pass",
    "class New:",
    "    def __array__(self, dtype=None, copy=None): pass",
    "class Kw:",
    "    def __array__(self, dtype=None, **kw): pass",
    "class Pos:",
    "    def __array__(self, dtype=None, copy=None, /): pass",
  ].join("\n");
  const w = new Worker(
    `
    const { parentPort, workerData } = require("node:worker_threads");
    const c = require(workerData.dist + "/src/compile.js");
    const P = require(workerData.dist + "/src/pkgset.js");
    Promise.resolve(c.initParser && c.initParser()).then(() => {
      const m = c.execModule(workerData.code, "<test>", "__main__");
      const get = (cls) => c.R.getattr(cls, "__array__");
      const inst = (cls) => c.R.getattr(c.R.callObj(cls, []), "__array__");
      const r = [];
      for (const [name, prov] of [["Old", null], ["New", null], ["Kw", null], ["Kw", { Kw: { __array__: ["copy"] } }], ["Pos", null]])
        r.push(name + (prov ? "+provides" : "") + ":" + P.implementsArgument(get(m[name]), "copy", name, "__array__", prov) + "/" + P.implementsArgument(inst(m[name]), "copy", name, "__array__", prov));
      r.push("opaque:" + P.implementsArgument(c.R.builtins.len, "copy", null, "__array__", null));
      parentPort.postMessage(r.join(" "));
    });
    `,
    { eval: true, workerData: { dist: DIST, code } },
  );
  const out: string = await new Promise((resolve, reject) => {
    w.once("message", (m) => (w.terminate(), resolve(m)));
    w.once("error", reject);
  });
  assert.equal(out, "Old:false/false New:true/true Kw:false/false Kw+provides:true/true Pos:false/false opaque:false");
  void s;
});

// LIMIT-PR68-1: the parse's own work is bounded, charged before allocation
test("strict JSON's work budget: values and estimated heap, at the cap and one over", () => {
  // (a real chunk: mostly a code string; about 2x its bytes)
  const code = "x".repeat(200_000);
  assert.equal(P.strictJson(JSON.stringify({ code, lineMap: [1, 2, 3] })).code.length, 200_000);
  // a wide array of small numbers: about 12x its bytes, refused once over budget
  const wide = "[" + "0,".repeat(400_000) + "0]";
  assert.throws(() => P.strictJson(wide), (e: any) => e.name === "PkgsetError" && /more than \d+ bytes/.test(e.message));
  // exactly at an explicit budget, and one byte under it
  const small = '{"a":[1,2]}';
  let need = 0;
  for (let b = 0; b < 4096; b++) {
    try {
      P.strictJson(small, 32, b);
      need = b;
      break;
    } catch {}
  }
  assert.ok(need > 0);
  assert.doesNotThrow(() => P.strictJson(small, 32, need));
  assert.throws(() => P.strictJson(small, 32, need - 1), /parsing would take more than/);
  // the value count cap
  const many = "[" + "1,".repeat(1_000_000) + "1]";
  assert.throws(() => P.strictJson(many, 32, Infinity), /more than 1000000 JSON values/);
});

test("a set whose largest chunk is too big for the resident estimate is refused before any fetch", () => {
  const s = makeSet([hello], { index: (ix) => (ix.packages["@sagebrush/hello@0.1.0"].src.size = 8 * 1024 * 1024) });
  refused(() => P.admitIndex(s.S, s.index, BUILD, reserved), /in memory; at most/);
});

test("a hostile hash-valid chunk can't take the heap: refused within a 64 MiB heap, where an unbudgeted parse runs out", () => {
  const { spawnSync } = require("node:child_process");
  const { mkdtempSync, writeFileSync } = require("node:fs");
  const { tmpdir } = require("node:os");
  const { join } = require("node:path");
  const dir = mkdtempSync(join(tmpdir(), "sb-pkgset-heap-"));
  // (about 5.5 MiB of [0], inner arrays: each costs an object, an element and a value)
  const script = join(dir, "heap.js");
  writeFileSync(script, `
    const P = require(${JSON.stringify(DIST + "/src/pkgset.js")});
    const text = '{"format":"sagebrush-pkg-chunk","files":{},"kind":"src","package":"@sagebrush/hello@0.1.0","v":1,"x":[' + "[0],".repeat(1_440_000) + '[0]]}';
    try {
      P.strictJson(text, 32, process.argv[2] === "unbudgeted" ? Infinity : undefined);
      console.log("parsed");
    } catch (e) {
      console.log(e.name + ": " + e.message);
    }
  `);
  const run = (mode: string) => spawnSync(process.execPath, ["--max-old-space-size=64", script, mode], { encoding: "utf8", timeout: 120_000 });
  const budgeted = run("budgeted");
  assert.equal(budgeted.status, 0, budgeted.stderr.slice(-500));
  assert.match(budgeted.stdout, /^PkgsetError: not admitted: parsing would take more than \d+ bytes/);
  // (the check bites: the same parse without the budget doesn't fit)
  const unbudgeted = run("unbudgeted");
  assert.notEqual(unbudgeted.status, 0, "an unbudgeted parse of this input should not fit in 64 MiB");
});
