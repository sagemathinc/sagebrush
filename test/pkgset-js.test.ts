import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

// js packages in a package set (src/pkgset.ts; plan-modular-packages r4
// addendum A1, for plan-bash-shell r3 §1.3): a set of format v2, a js
// package's index entry {dir, js: {sha256, size, host_req}} and nothing of a
// Python package's, a chunk with exactly one module that is its entry, and
// A1.2's caps, each at its value and one past.  A1.6's tests that belong to
// the validator.
const DIST = __dirname + "/..";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const P = require(DIST + "/src/pkgset.js");
const sha = (b: string | Uint8Array) => createHash("sha256").update(b).digest("hex");
const enc = (s: string) => new TextEncoder().encode(s);
const BUILD = "0123456789abcdef";
const MiB = 1024 * 1024;
const L = P.PKGSET_LIMITS;

function canon(v: any): string {
  if (Array.isArray(v)) return "[" + v.map(canon).join(",") + "]";
  if (v !== null && typeof v === "object") return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + canon(v[k])).join(",") + "}";
  return JSON.stringify(v);
}
const reserved = { isCoreModule: (n: string) => ["json", "sys"].includes(n), bundledDirs: new Set(["pypi-sortedcontainers"]) };
const refused = (f: () => unknown, re: RegExp) => assert.throws(f, (e: any) => e.name === "PkgsetError" && re.test(e.message));

type Js = { name: string; version?: string; entry?: string; text: string; host_req?: number };
// A set (index bytes, its id and the chunks by id) with these js packages and,
// optionally, one Python package; `mutate` edits the index or a chunk object
// before it is serialized, so hostile sets still have the right hashes.
function makeSet(js: Js[], opts: { python?: boolean; v?: number; index?: (ix: any) => void; chunk?: (c: any) => void } = {}) {
  const chunks = new Map<string, Uint8Array>();
  const ix: any = { format: "sagebrush-pkgset", v: opts.v ?? 2, core_api: 1, packages: {} };
  for (const j of js) {
    const id = `@sagebrush/${j.name}@${j.version ?? "0.1.0"}`;
    const entry = j.entry ?? "shell.js";
    const c: any = { format: "sagebrush-pkg-chunk", v: 1, kind: "js", package: id, entry, modules: { [entry]: j.text } };
    opts.chunk?.(c);
    const b = enc(canon(c));
    chunks.set(id, b);
    ix.packages[id] = { dir: j.name, js: { sha256: sha(b), size: b.length, host_req: j.host_req ?? 1 } };
  }
  if (opts.python) {
    const files = { "py/hello/__init__.py": "X = 1\n" };
    const src = enc(canon({ format: "sagebrush-pkg-chunk", v: 1, kind: "src", package: "@sagebrush/hello@0.1.0", files }));
    ix.packages["@sagebrush/hello@0.1.0"] = {
      dir: "hello", root: "py", files: { "py/hello/__init__.py": sha(enc(files["py/hello/__init__.py"])) }, modules: ["hello"], requires: [],
      core_req: { api: 1, level: 1 }, src: { sha256: sha(src), size: src.length }, pre: {}, cost: { [BUILD]: { src: { cpu_ms: 1, peak_mb: 1 } } },
    };
  }
  opts.index?.(ix);
  const index = enc(canon(ix));
  return { S: sha(index), index, chunks, admit: () => P.admitIndex(sha(index), index, BUILD, reserved) };
}
const shell: Js = { name: "bash", text: "export const ok = 1;\n" };

test("a v2 set with a js package is admitted; its chunk gives the one module's text", () => {
  const s = makeSet([shell], { python: true });
  const plan = s.admit();
  assert.deepEqual([...plan.js.keys()], ["@sagebrush/bash@0.1.0"]);
  assert.deepEqual([...plan.packages.keys()], ["@sagebrush/hello@0.1.0"], "the Python package is admitted beside it, as before");
  assert.equal(plan.js.get("@sagebrush/bash@0.1.0").js.host_req, 1);
  assert.deepEqual(P.checkJsChunk(plan, "@sagebrush/bash@0.1.0", s.chunks.get("@sagebrush/bash@0.1.0")), { kind: "js", entry: "shell.js", text: shell.text });
});

test("the format: js only in v2, and every v2 set has one (A1.1)", () => {
  refused(() => makeSet([shell], { v: 1 }).admit(), /a v1 index has no js packages/);
  refused(() => makeSet([], { v: 2, python: true }).admit(), /a v2 index has js packages/);
  refused(() => makeSet([shell], { v: 3 }).admit(), /needs a newer Sagebrush/);
  // (a v1 set without js is unchanged)
  assert.equal(makeSet([], { v: 1, python: true }).admit().js.size, 0);
});

test("a js package's index entry is {dir, js: {sha256, size, host_req}} and nothing else (A1.1)", () => {
  const id = "@sagebrush/bash@0.1.0";
  for (const field of ["files", "modules", "src", "pre", "requires", "core_req", "cost", "root", "provides"]) {
    refused(() => makeSet([shell], { index: (ix) => (ix.packages[id][field] = field === "requires" ? [] : {}) }).admit(), /unknown field/);
  }
  refused(() => makeSet([shell], { index: (ix) => (ix.packages[id].js.extra = 1) }).admit(), /unknown field/);
  refused(() => makeSet([shell], { index: (ix) => delete ix.packages[id].js.host_req }).admit(), /missing host_req/);
  refused(() => makeSet([shell], { index: (ix) => (ix.packages[id].dir = "other") }).admit(), /dir must be its id's name/);
  refused(() => makeSet([shell], { index: (ix) => (ix.packages[id].js.host_req = -1) }).admit(), /host_req must be an integer/);
  refused(() => makeSet([shell], { index: (ix) => (ix.packages[id].js.sha256 = "X".repeat(64)) }).admit(), /64 lowercase hex/);
  // (one name, one version: a js package and a Python one can't share a name or directory)
  refused(() => makeSet([shell, { ...shell, version: "0.2.0" }]).admit(), /one version of a package/);
  refused(() => makeSet([{ ...shell, name: "hello", version: "0.2.0" }], { python: true }).admit(), /one version of a package/);
  refused(() => makeSet([{ ...shell, name: "pypi-sortedcontainers" }]).admit(), /bundled package's directory/);
  // (a Python package can't require a js package)
  refused(() => makeSet([shell], { python: true, index: (ix) => (ix.packages["@sagebrush/hello@0.1.0"].requires = [id]) }).admit(), /a js package/);
});

test("the chunk: the pinned bytes, its header, exactly one module that is its entry (A1.1)", () => {
  const id = "@sagebrush/bash@0.1.0";
  const s = makeSet([shell]);
  const plan = s.admit();
  const bytes = s.chunks.get(id)!;
  const flipped = bytes.slice();
  flipped[flipped.length - 5] ^= 1;
  refused(() => P.checkJsChunk(plan, id, flipped), /not the one the index pins/);
  refused(() => P.checkJsChunk(plan, id, bytes.slice(0, -1)), /not the size the index pins/);
  refused(() => P.checkJsChunk(plan, "@sagebrush/nope@0.1.0", bytes), /has no js package/);
  const bad = (chunk: (c: any) => void, re: RegExp) => {
    const t = makeSet([shell], { chunk });
    refused(() => P.checkJsChunk(t.admit(), id, t.chunks.get(id)), re);
  };
  bad((c) => (c.modules["other.js"] = "x"), /exactly one module/);
  bad((c) => (c.entry = "other.js"), /exactly one module/);
  bad((c) => (c.entry = "../shell.js"), /entry is a file name/);
  bad((c) => (c.build = BUILD), /unknown field/);
  bad((c) => (c.kind = "src"), /not @sagebrush\/bash@0\.1\.0's js/);
  bad((c) => (c.package = "@sagebrush/other@0.1.0"), /not @sagebrush\/bash@0\.1\.0's js/);
  bad((c) => (c.modules["shell.js"] = 42), /not text/);
});

test("A1.2's caps, each at its value and one past", () => {
  // one module's text: at most jsModuleBytes of UTF-8 (a multibyte character counts its bytes)
  assert.equal(L.jsModuleBytes, 4 * MiB);
  const at = "x".repeat(L.jsModuleBytes);
  const okSet = makeSet([{ ...shell, text: at }]);
  assert.equal(P.checkJsChunk(okSet.admit(), "@sagebrush/bash@0.1.0", okSet.chunks.get("@sagebrush/bash@0.1.0")).text.length, L.jsModuleBytes);
  const over = makeSet([{ ...shell, text: "é" + "x".repeat(L.jsModuleBytes - 1) }]);
  refused(() => P.checkJsChunk(over.admit(), "@sagebrush/bash@0.1.0", over.chunks.get("@sagebrush/bash@0.1.0")), /over 4194304 bytes/);
  // one chunk: at most chunkBytes (8 MiB), checked on the declared size, before any fetch
  refused(() => makeSet([shell], { index: (ix) => (ix.packages["@sagebrush/bash@0.1.0"].js.size = L.chunkBytes + 1) }).admit(), /size must be an integer in 0\.\.8388608/);
  // js packages per set: at most jsPackages
  assert.equal(L.jsPackages, 4);
  const four = ["a", "b", "c", "d"].map((n) => ({ ...shell, name: n }));
  assert.equal(makeSet(four).admit().js.size, 4);
  refused(() => makeSet([...four, { ...shell, name: "e" }]).admit(), /at most 4 js packages/);
  // their chunks together: at most jsBytes (declared sizes)
  assert.equal(L.jsBytes, 8 * MiB);
  const sized = (sizes: number[]) => makeSet(sizes.map((_, k) => ({ ...shell, name: "abcd"[k] })), { index: (ix) => sizes.forEach((n, k) => (ix.packages[`@sagebrush/${"abcd"[k]}@0.1.0`].js.size = n)) });
  assert.equal(sized([4 * MiB, 4 * MiB]).admit().js.size, 2);
  refused(() => sized([4 * MiB, 4 * MiB + 1]).admit(), /js chunks total at most 8388608 bytes/);
});

test("js bytes aren't in the Python closure or its resident estimate (A1.2)", () => {
  // (a set whose js chunks are at the aggregate cap still admits its Python package)
  const s = makeSet([shell, { ...shell, name: "b" }], { python: true, index: (ix) => {
    ix.packages["@sagebrush/bash@0.1.0"].js.size = 4 * MiB;
    ix.packages["@sagebrush/b@0.1.0"].js.size = 4 * MiB;
  } });
  const plan = s.admit();
  assert.deepEqual(plan.closure.get("@sagebrush/hello@0.1.0"), ["@sagebrush/hello@0.1.0"]);
  assert.equal(plan.modules.has("bash"), false);
});
