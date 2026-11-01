// Optional package sets (design: /scratch/sagebrush-reviews/plan-modular-packages-r4.md,
// approved Oct 23 2026): packages kept outside the core (optional/<name>/),
// published as content-addressed sets, and loaded into a runtime only from
// bytes that have the pinned SHA-256s.  This module is the one validator that
// every host uses (the browser's worker, the CLI and the grader's Dynamic
// Worker child): it parses and checks a set's index before anything changes
// (admitIndex), and checks each chunk before any of it is used (checkChunk).
// src/compile.ts mounts what passes.  Nothing here touches the network or a
// file: the hosts fetch, and hand over bytes.
//
// The trust chain (§3.1): a set's id S is the SHA-256 of its index's exact
// bytes; the index pins every chunk by its full SHA-256 and size, and every
// file by its SHA-256; a chunk's own header must name the package and kind
// the index gives it.  The id comes from the document's pin (or, once, the
// site's /pkgset/latest.json), never from anything a set says about itself.
//
// Optional packages are reviewed first-party code (§5.1): this is a loader's
// integrity and ownership check, not a sandbox for the Python they contain.
import { sha256Hex } from "./runtime/sha256";

/** The Core API contract (§6): the major version, and the feature level, which rises with every addition. */
export const CORE_API = 1;
export const CORE_API_LEVEL = 15;

const KiB = 1024, MiB = 1024 * KiB;
/** Hard limits of set format v1 (§3.4), the same in every host and in the publisher. */
export const PKGSET_LIMITS = Object.freeze({
  setsPerRuntime: 1,
  indexBytes: 256 * KiB,
  chunkBytes: 8 * MiB,
  packages: 32,
  filesPerPackage: 512,
  fileBytes: 1 * MiB,
  modules: 1024,
  requiresDepth: 4,
  requiresEdges: 64,
  preBuilds: 4,
  srcBytes: 16 * MiB,
  preBytes: 24 * MiB,
  // (decoded, resident: every source and selected pre kept as JS strings, 2
  // bytes a character at most, plus the transient copies of the largest one
  // being admitted: raw (1x), decoded (2x at most) and its parse (at most
  // jsonHeapPerByte x + slack, enforced by strictJson): 6x + slack)
  residentBytes: 48 * MiB,
  jsonDepth: 32,
  // (a parse's own work: values, and an estimate of the heap its tree takes,
  // charged before each allocation: daybreak3's LIMIT-PR68-1.  A real
  // chunk's tree is about 2.1x its bytes, mostly its code's strings; a wide
  // array of small numbers is about 12x)
  jsonValues: 1_000_000,
  jsonHeapPerByte: 3,
  jsonHeapSlack: 1 * MiB,
  errorChars: 1024,
  // js packages (addendum A1.2: a set of format v2): at most 4, one module
  // each of at most 4 MiB of UTF-8 text, and their chunks at most 8 MiB
  // together (each chunk is at most chunkBytes, the one-chunk cap).  Not in
  // the Python closure or residentBytes: js never enters an engine worker.
  jsPackages: 4,
  jsModuleBytes: 4 * MiB,
  jsBytes: 8 * MiB,
  // (a js chunk's "notices", the license texts of what its module bundles
  // (A1.1a): plain text, at most this much UTF-8, inside the chunk's own cap)
  jsNoticesBytes: 256 * KiB,
});

export class PkgsetError extends Error {
  constructor(message: string) {
    super(message.length > PKGSET_LIMITS.errorChars ? message.slice(0, PKGSET_LIMITS.errorChars - 1) + "…" : message);
    this.name = "PkgsetError";
  }
}
const fail = (m: string): never => {
  throw new PkgsetError(m);
};

// ---------------------------------------------------------------------------
// Strict JSON (RFC 8259): no duplicate keys, no __proto__/constructor/prototype
// keys, bounded depth; objects have no prototype.  JSON.parse can't refuse
// duplicates, and the first or last of two would silently win.

const BAD_KEYS = new Set(["__proto__", "constructor", "prototype"]);
export function strictJson(text: string, maxDepth: number = PKGSET_LIMITS.jsonDepth, heapBytes: number = PKGSET_LIMITS.jsonHeapPerByte * text.length + PKGSET_LIMITS.jsonHeapSlack): any {
  let i = 0;
  const n = text.length;
  // the work budget: a value costs 16 (its slot), an array or object 176 more
  // (V8 keeps about 186 bytes for a one-element array or a prototype-less
  // object, measured), an array element 8 more, an object member 112 more
  // (a dictionary's slots, up to 4 per member just after it grows, and its
  // key), a string 2 a code unit and 8 more; charged before the allocation it
  // pays for, so a refused parse never built the excess
  let heap = 0, values = 0;
  const charge = (b: number) => {
    heap += b;
    if (heap > heapBytes) fail(`not admitted: parsing would take more than ${heapBytes} bytes`);
  };
  const value1 = () => {
    if (++values > PKGSET_LIMITS.jsonValues) fail(`not admitted: more than ${PKGSET_LIMITS.jsonValues} JSON values`);
    charge(16);
  };
  const ws = () => {
    while (i < n) {
      const c = text.charCodeAt(i);
      if (c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09) i++;
      else break;
    }
  };
  const err = (what: string): never => fail(`not valid JSON: ${what} at offset ${i}`);
  const str = (): string => {
    // (at the opening quote)
    i++;
    let out = "";
    let start = i;
    for (;;) {
      if (i >= n) err("unterminated string");
      const c = text.charCodeAt(i);
      if (c === 0x22) {
        charge(2 * (i - start) + 8);
        out += text.slice(start, i);
        i++;
        return out;
      }
      if (c < 0x20) err("control character in a string");
      if (c === 0x5c) {
        charge(2 * (i - start) + 2);
        out += text.slice(start, i);
        const e = text[i + 1];
        if (e === undefined) err("unterminated escape");
        if (e === "u") {
          const h = text.slice(i + 2, i + 6);
          if (!/^[0-9a-fA-F]{4}$/.test(h)) err("bad \\u escape");
          out += String.fromCharCode(parseInt(h, 16));
          i += 6;
        } else {
          const m: Record<string, string> = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
          if (!Object.hasOwn(m, e)) err("bad escape");
          out += m[e];
          i += 2;
        }
        start = i;
      } else i++;
    }
  };
  const num = (): number => {
    const m = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(text.slice(i, i + 64));
    if (!m) err("bad number");
    i += m![0].length;
    const v = Number(m![0]);
    if (!Number.isFinite(v)) err("number out of range");
    return v;
  };
  const value = (depth: number): any => {
    if (depth > maxDepth) err(`nested deeper than ${maxDepth}`);
    value1();
    ws();
    const c = text[i];
    if (c === "{") {
      i++;
      charge(176);
      const o: any = Object.create(null);
      ws();
      if (text[i] === "}") {
        i++;
        return o;
      }
      for (;;) {
        ws();
        if (text[i] !== '"') err("expected a key");
        const k = str();
        if (BAD_KEYS.has(k)) err(`forbidden key ${JSON.stringify(k)}`);
        if (Object.hasOwn(o, k)) err(`duplicate key ${JSON.stringify(k.slice(0, 64))}`);
        charge(112);
        ws();
        if (text[i] !== ":") err("expected :");
        i++;
        o[k] = value(depth + 1);
        ws();
        if (text[i] === ",") {
          i++;
          continue;
        }
        if (text[i] === "}") {
          i++;
          return o;
        }
        err("expected , or }");
      }
    }
    if (c === "[") {
      i++;
      charge(176);
      const a: any[] = [];
      ws();
      if (text[i] === "]") {
        i++;
        return a;
      }
      for (;;) {
        charge(8);
        a.push(value(depth + 1));
        ws();
        if (text[i] === ",") {
          i++;
          continue;
        }
        if (text[i] === "]") {
          i++;
          return a;
        }
        err("expected , or ]");
      }
    }
    if (c === '"') return str();
    if (c === "t" && text.startsWith("true", i)) return (i += 4), true;
    if (c === "f" && text.startsWith("false", i)) return (i += 5), false;
    if (c === "n" && text.startsWith("null", i)) return (i += 4), null;
    if (c === "-" || (c !== undefined && c >= "0" && c <= "9")) return num();
    return err("unexpected character");
  };
  const v = value(1);
  ws();
  if (i !== n) err("trailing characters");
  return v;
}

// (UTF-8, refusing invalid sequences: a pinned file is exact bytes)
function utf8(bytes: Uint8Array, what: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return fail(`${what} is not valid UTF-8`);
  }
}
const utf8Bytes = (s: string) => new TextEncoder().encode(s);

// ---------------------------------------------------------------------------
// Grammars (§4.1 rule 3)

const HEX64 = /^[0-9a-f]{64}$/;
const DIR = /^[a-z0-9][a-z0-9-]{0,63}$/;
const ID = /^@sagebrush\/([a-z0-9][a-z0-9-]{0,63})@(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const BUILD = /^[0-9a-f]{16}$/;
/** A path inside a package: no "..", no absolute or empty parts, plain characters (scripts/packages.mjs's rule). */
export const safePath = (p: unknown): p is string =>
  typeof p === "string" && p !== "" && p.length <= 512 && !p.startsWith("/") && p.split("/").every((s) => s !== "" && s !== "." && s !== ".." && /^[A-Za-z0-9_.-]+$/.test(s));
const isModule = (m: unknown): m is string => typeof m === "string" && m.length <= 256 && m.split(".").every((s) => IDENT.test(s));

const isObj = (v: unknown): v is Record<string, any> => v !== null && typeof v === "object" && !Array.isArray(v);
function exactKeys(o: Record<string, any>, required: string[], optional: string[], what: string) {
  for (const k of required) if (!Object.hasOwn(o, k)) fail(`${what}: missing ${k}`);
  const allowed = new Set([...required, ...optional]);
  for (const k of Object.keys(o)) if (!allowed.has(k)) fail(`${what}: unknown field ${JSON.stringify(k.slice(0, 64))}`);
}
const nat = (v: unknown, what: string, max = Number.MAX_SAFE_INTEGER): number =>
  typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= max ? v : fail(`${what} must be an integer in 0..${max}`);

// ---------------------------------------------------------------------------
// The index

export interface ChunkRef {
  sha256: string;
  size: number;
}
export interface Cost {
  cpu_ms: number;
  peak_mb: number;
}
export interface PackagePlan {
  id: string;
  dir: string;
  root: string;
  files: Record<string, string>; // path -> sha256
  modules: string[];
  requires: string[];
  core_req: { api: number; level: number };
  provides: Record<string, Record<string, string[]>>;
  src: ChunkRef;
  pre: Record<string, ChunkRef>; // core build id -> chunk
  cost: Record<string, { src: Cost; pre?: Cost }>; // core build id -> measured costs
}
/** A js package (addendum A1.1): one self-contained module, run only in its own worker by a host that loads it. */
export interface JsPlan {
  id: string;
  dir: string;
  js: ChunkRef & { host_req: number };
}
export interface SetPlan {
  S: string;
  /** the Python packages */
  packages: Map<string, PackagePlan>;
  /** the js packages (format v2); never mounted in an engine */
  js: Map<string, JsPlan>;
  /** module name -> package id */
  modules: Map<string, string>;
  /** each package's dependency closure, dependencies first, itself last */
  closure: Map<string, string[]>;
}

/** What the core reserves: names an optional package may not take (§4.1 rule 4). */
export interface Reserved {
  /** a module the core library or a bundled package has (exactly this dotted name) */
  isCoreModule(name: string): boolean;
  /** the bundled packages' directory names */
  bundledDirs: Set<string>;
}

function chunkRef(v: unknown, what: string): ChunkRef {
  if (!isObj(v)) fail(`${what} must be {sha256, size}`);
  const o = v as Record<string, any>;
  exactKeys(o, ["sha256", "size"], [], what);
  if (typeof o.sha256 !== "string" || !HEX64.test(o.sha256)) fail(`${what}.sha256 must be 64 lowercase hex digits`);
  return { sha256: o.sha256, size: nat(o.size, `${what}.size`, PKGSET_LIMITS.chunkBytes) };
}
function cost(v: unknown, what: string): Cost {
  if (!isObj(v)) fail(`${what} must be {cpu_ms, peak_mb}`);
  const o = v as Record<string, any>;
  exactKeys(o, ["cpu_ms", "peak_mb"], [], what);
  return { cpu_ms: nat(o.cpu_ms, `${what}.cpu_ms`, 600_000), peak_mb: nat(o.peak_mb, `${what}.peak_mb`, 4096) };
}

/**
 * Admit set `S` (its id: 64 hex digits) from its index's exact bytes, for a
 * core of build `build` with `reserved` names.  Everything about the set is
 * checked here, before any runtime state changes: an error is a PkgsetError
 * and nothing has happened (§4.1).
 */
export function admitIndex(S: string, bytes: Uint8Array, build: string, reserved: Reserved): SetPlan {
  const L = PKGSET_LIMITS;
  if (typeof S !== "string" || !HEX64.test(S)) fail("a package set id is 64 lowercase hex digits");
  if (!(bytes instanceof Uint8Array)) fail("the index must be bytes");
  if (bytes.length > L.indexBytes) fail(`package set ${S.slice(0, 12)}: its index is over ${L.indexBytes} bytes`);
  if (sha256Hex(bytes) !== S) fail(`package set ${S.slice(0, 12)}: the index is not the one its id names`);
  const ix = strictJson(utf8(bytes, "the index"));
  if (!isObj(ix)) fail("the index must be an object");
  exactKeys(ix, ["format", "v", "core_api", "packages"], [], "the index");
  // (v 2: a set with js packages, A1.1; a host before A1 refuses it whole)
  if (ix.format !== "sagebrush-pkgset" || (ix.v !== 1 && ix.v !== 2)) fail("this package set needs a newer Sagebrush (not a v1 or v2 package set index)");
  if (ix.core_api !== CORE_API) fail(`package set ${S.slice(0, 12)} is for Sagebrush core API ${String(ix.core_api).slice(0, 8)}; this is core API ${CORE_API}`);
  if (!isObj(ix.packages)) fail("the index's packages must be an object");
  const ids = Object.keys(ix.packages);
  if (ids.length > L.packages) fail(`a package set has at most ${L.packages} packages`);
  const packages = new Map<string, PackagePlan>();
  const js = new Map<string, JsPlan>();
  const modules = new Map<string, string>();
  const dirs = new Set<string>();
  const names = new Set<string>();
  let edges = 0;
  for (const id of ids.sort()) {
    const what = `package ${id.slice(0, 80)}`;
    const m = ID.exec(id);
    if (!m) fail(`${what}: an id is @sagebrush/<dir>@MAJOR.MINOR.PATCH`);
    const p = ix.packages[id];
    if (!isObj(p)) fail(`${what} must be an object`);
    if (Object.hasOwn(p, "js")) {
      // a js package: {dir, js: {sha256, size, host_req}} and nothing of a
      // Python package's (a package that is both is refused: A1.1)
      exactKeys(p, ["dir", "js"], [], what);
      if (p.dir !== m![1] || !DIR.test(p.dir)) fail(`${what}: dir must be its id's name`);
      const name = id.slice(0, id.lastIndexOf("@"));
      if (names.has(name)) fail(`${what}: a set has one version of a package`);
      names.add(name);
      if (dirs.has(p.dir)) fail(`${what}: two packages share the directory ${p.dir}`);
      dirs.add(p.dir);
      if (reserved.bundledDirs.has(p.dir)) fail(`${what}: ${p.dir} is a bundled package's directory`);
      if (!isObj(p.js)) fail(`${what}: js must be {sha256, size, host_req}`);
      exactKeys(p.js, ["sha256", "size", "host_req"], [], `${what}.js`);
      const ref = chunkRef({ sha256: p.js.sha256, size: p.js.size }, `${what}.js`);
      js.set(id, { id, dir: p.dir, js: { ...ref, host_req: nat(p.js.host_req, `${what}.js.host_req`, 1_000_000) } });
      continue;
    }
    exactKeys(p, ["dir", "root", "files", "modules", "requires", "core_req", "src", "pre", "cost"], ["provides"], what);
    // (one version per package name, distinct directories: rule 5)
    if (p.dir !== m![1] || !DIR.test(p.dir)) fail(`${what}: dir must be its id's name`);
    const name = id.slice(0, id.lastIndexOf("@"));
    if (names.has(name)) fail(`${what}: a set has one version of a package`);
    names.add(name);
    if (dirs.has(p.dir)) fail(`${what}: two packages share the directory ${p.dir}`);
    dirs.add(p.dir);
    if (reserved.bundledDirs.has(p.dir)) fail(`${what}: ${p.dir} is a bundled package's directory`);
    if (!safePath(p.root)) fail(`${what}: root must be a directory inside the package`);
    // files
    if (!isObj(p.files)) fail(`${what}: files must map paths to SHA-256s`);
    const fileKeys = Object.keys(p.files);
    if (!fileKeys.length || fileKeys.length > L.filesPerPackage) fail(`${what}: 1..${L.filesPerPackage} files`);
    for (const f of fileKeys) {
      if (!safePath(f) || !f.startsWith(p.root + "/") || !f.endsWith(".py")) fail(`${what}: ${JSON.stringify(f.slice(0, 80))} is not a .py path under its root`);
      if (typeof p.files[f] !== "string" || !HEX64.test(p.files[f])) fail(`${what}: ${f}'s pin must be 64 lowercase hex digits`);
    }
    // modules: own, unreserved, each with its file (rules 4 and 5)
    if (!Array.isArray(p.modules) || !p.modules.length) fail(`${what}: modules must be a non-empty list`);
    for (const mod of p.modules) {
      if (!isModule(mod)) fail(`${what}: ${JSON.stringify(String(mod).slice(0, 80))} is not a module name`);
      const parts = mod.split(".");
      for (let k = 1; k <= parts.length; k++) {
        const prefix = parts.slice(0, k).join(".");
        if (reserved.isCoreModule(prefix)) fail(`${what}: ${mod} would replace or extend the core's ${prefix}`);
      }
      if (modules.has(mod)) fail(`${what}: module ${mod} is also ${modules.get(mod)}'s`);
      const rel = p.root + "/" + mod.split(".").join("/");
      if (!Object.hasOwn(p.files, rel + ".py") && !Object.hasOwn(p.files, rel + "/__init__.py")) fail(`${what}: no file for module ${mod}`);
      modules.set(mod, id);
      if (modules.size > L.modules) fail(`a package set has at most ${L.modules} modules`);
    }
    // (a submodule belongs to the package that has its parent: a set can't
    // add submodules to another package's module)
    for (const mod of p.modules) {
      const dot = mod.lastIndexOf(".");
      if (dot > 0) {
        const parent = mod.slice(0, dot);
        if (!p.modules.includes(parent)) fail(`${what}: ${mod}'s parent ${parent} is not one of its modules`);
      }
    }
    if (!Array.isArray(p.requires)) fail(`${what}: requires must be a list of ids`);
    for (const r of p.requires) if (typeof r !== "string" || !ID.test(r)) fail(`${what}: requires names package ids`);
    if (new Set(p.requires).size !== p.requires.length) fail(`${what}: requires lists a package twice`);
    edges += p.requires.length;
    if (!isObj(p.core_req)) fail(`${what}: core_req must be {api, level}`);
    exactKeys(p.core_req, ["api", "level"], [], `${what}.core_req`);
    const api = nat(p.core_req.api, `${what}.core_req.api`, 1000), level = nat(p.core_req.level, `${what}.core_req.level`, 1_000_000);
    if (api !== CORE_API || level > CORE_API_LEVEL) fail(`package ${name} needs Sagebrush core API ${api} level ${level}; this engine is core API ${CORE_API} level ${CORE_API_LEVEL}`);
    const provides: Record<string, Record<string, string[]>> = Object.create(null);
    if (p.provides !== undefined) {
      if (!isObj(p.provides)) fail(`${what}: provides must be {class: {method: [argument]}}`);
      for (const [cls, ms] of Object.entries(p.provides)) {
        if (!isModule(cls) || !isObj(ms)) fail(`${what}: provides is keyed by class qualname`);
        provides[cls] = Object.create(null);
        for (const [meth, args] of Object.entries(ms as Record<string, any>)) {
          if (!IDENT.test(meth) || !Array.isArray(args) || !args.every((a) => typeof a === "string" && IDENT.test(a))) fail(`${what}: provides.${cls} maps methods to argument names`);
          provides[cls][meth] = [...args];
        }
      }
    }
    const src = chunkRef(p.src, `${what}.src`);
    if (!isObj(p.pre)) fail(`${what}: pre must map build ids to chunks`);
    const pre: Record<string, ChunkRef> = Object.create(null);
    const builds = Object.keys(p.pre);
    if (builds.length > L.preBuilds) fail(`${what}: pre for at most ${L.preBuilds} builds`);
    for (const b of builds) {
      if (!BUILD.test(b)) fail(`${what}: pre is keyed by 16-hex build ids`);
      pre[b] = chunkRef(p.pre[b], `${what}.pre.${b}`);
    }
    if (!isObj(p.cost)) fail(`${what}: cost must map build ids to measured costs`);
    const costs: PackagePlan["cost"] = Object.create(null);
    for (const [b, c] of Object.entries(p.cost)) {
      if (!BUILD.test(b) || !isObj(c)) fail(`${what}: cost is keyed by 16-hex build ids`);
      exactKeys(c as any, ["src"], ["pre"], `${what}.cost.${b}`);
      costs[b] = { src: cost((c as any).src, `${what}.cost.${b}.src`), ...((c as any).pre !== undefined ? { pre: cost((c as any).pre, `${what}.cost.${b}.pre`) } : {}) };
    }
    packages.set(id, {
      id, dir: p.dir, root: p.root, files: Object.assign(Object.create(null), p.files), modules: [...p.modules], requires: [...p.requires],
      core_req: { api, level }, provides, src, pre, cost: costs,
    });
  }
  if (edges > L.requiresEdges) fail(`a package set has at most ${L.requiresEdges} requires edges`);
  // js packages: only in v2, and every v2 set has one (A1.1); bounded (A1.2)
  if (ix.v === 1 && js.size) fail(`package set ${S.slice(0, 12)}: a v1 index has no js packages`);
  if (ix.v === 2 && !js.size) fail(`package set ${S.slice(0, 12)}: a v2 index has js packages`);
  if (js.size > L.jsPackages) fail(`a package set has at most ${L.jsPackages} js packages`);
  let jsBytes = 0;
  for (const j of js.values()) jsBytes += j.js.size;
  if (jsBytes > L.jsBytes) fail(`a package set's js chunks total at most ${L.jsBytes} bytes`);
  for (const p of packages.values()) for (const r of p.requires) if (js.has(r)) fail(`${p.id} requires ${r}, a js package: Python packages require Python packages`);
  // the dependency closure: exact ids in this set, acyclic, bounded depth (rule 6)
  // (the depth is each package's height, its longest requires path, kept with
  // its closure: a closure reused from the cache still counts its whole
  // height, so the order packages are visited in can't matter: astra's
  // CORR-PR68-1)
  const closure = new Map<string, string[]>();
  const height = new Map<string, number>();
  const deep = () => fail(`requires is deeper than ${L.requiresDepth}`);
  const visit = (id: string, stack: string[]): string[] => {
    const done = closure.get(id);
    if (done) {
      if (stack.length + height.get(id)! > L.requiresDepth) deep();
      return done;
    }
    if (stack.includes(id)) fail(`requires has a cycle: ${[...stack, id].map((s) => s.slice(11)).join(" -> ")}`);
    if (stack.length > L.requiresDepth) deep();
    const p = packages.get(id);
    if (!p) fail(`${stack[stack.length - 1]} requires ${id}, which is not in this set`);
    const order: string[] = [];
    let h = 0;
    for (const r of p!.requires) {
      for (const x of visit(r, [...stack, id])) if (!order.includes(x)) order.push(x);
      h = Math.max(h, height.get(r)! + 1);
    }
    if (stack.length + h > L.requiresDepth) deep();
    order.push(id);
    closure.set(id, order);
    height.set(id, h);
    return order;
  };
  for (const id of packages.keys()) visit(id, []);
  // aggregate bytes, over everything this set could make resident in this
  // build (declared sizes; the chunks are checked against them as they come)
  let srcBytes = 0, preBytes = 0, largest = bytes.length;
  for (const p of packages.values()) {
    srcBytes += p.src.size;
    largest = Math.max(largest, p.src.size);
    const mine = p.pre[build];
    if (mine) {
      preBytes += mine.size;
      largest = Math.max(largest, mine.size);
    }
  }
  if (srcBytes > L.srcBytes) fail(`a package set's sources total at most ${L.srcBytes} bytes`);
  if (preBytes > L.preBytes) fail(`a package set's precompiled code for one build totals at most ${L.preBytes} bytes`);
  const resident = 2 * (srcBytes + preBytes) + (1 + 2 + L.jsonHeapPerByte) * largest + L.jsonHeapSlack;
  if (resident > L.residentBytes) fail(`package set ${S.slice(0, 12)} would hold about ${resident} bytes in memory; at most ${L.residentBytes}`);
  return { S, packages, js, modules, closure };
}

// ---------------------------------------------------------------------------
// Chunks

export interface SrcChunk {
  kind: "src";
  files: Map<string, string>; // path -> text
}
export interface PreEntry {
  key: string; // "py|<module>" or "sage|<module>"
  module: string;
  sage: boolean;
  path: string;
  code: string;
  lineMap: unknown[];
}
export interface PreChunk {
  kind: "pre";
  entries: PreEntry[];
}

/**
 * Check a chunk's bytes against the index's pin and its own header, and its
 * contents against the package (a src chunk: exactly the package's files,
 * each with its pin; a pre chunk: only the package's own modules and files,
 * for this core build).  Throws a PkgsetError; returns the parsed chunk.
 */
export function checkChunk(plan: SetPlan, id: string, kind: "src" | "pre", build: string, bytes: Uint8Array): SrcChunk | PreChunk {
  const p = plan.packages.get(id);
  if (!p) return fail(`package set ${plan.S.slice(0, 12)} has no package ${id}`);
  const ref = kind === "src" ? p.src : p.pre[build];
  if (!ref) return fail(`${id} has no precompiled code for build ${build}`);
  if (!(bytes instanceof Uint8Array) || bytes.length !== ref.size) fail(`${id}: its ${kind} chunk is not the size the index pins`);
  if (sha256Hex(bytes) !== ref.sha256) fail(`${id}: its ${kind} chunk is not the one the index pins`);
  const c = strictJson(utf8(bytes, `${id}'s ${kind} chunk`));
  if (!isObj(c)) fail(`${id}: a chunk is an object`);
  if (kind === "src") {
    exactKeys(c, ["format", "v", "kind", "package", "files"], [], `${id}'s src chunk`);
  } else {
    exactKeys(c, ["format", "v", "kind", "package", "build", "modules"], [], `${id}'s pre chunk`);
  }
  if (c.format !== "sagebrush-pkg-chunk" || c.v !== 1) fail(`${id}: not a v1 package chunk`);
  if (c.kind !== kind || c.package !== id) fail(`${id}: the chunk says it is ${String(c.package).slice(0, 80)}'s ${String(c.kind).slice(0, 8)}, not ${id}'s ${kind}`);
  if (kind === "src") {
    if (!isObj(c.files)) fail(`${id}: a src chunk's files is an object`);
    const want = Object.keys(p.files).sort(), got = Object.keys(c.files).sort();
    if (want.length !== got.length || want.some((f, k) => f !== got[k])) fail(`${id}: its src chunk's files are not exactly the package's`);
    const files = new Map<string, string>();
    for (const f of want) {
      const text = c.files[f];
      if (typeof text !== "string") fail(`${id}: ${f} is not text`);
      const b = utf8Bytes(text);
      if (b.length > PKGSET_LIMITS.fileBytes) fail(`${id}: ${f} is over ${PKGSET_LIMITS.fileBytes} bytes`);
      if (sha256Hex(b) !== p.files[f]) fail(`${id}: ${f} is not the file the index pins`);
      files.set(f, text);
    }
    return { kind: "src", files };
  }
  if (c.build !== build) fail(`${id}: its pre chunk is for build ${String(c.build).slice(0, 16)}, not ${build}`);
  if (!isObj(c.modules)) fail(`${id}: a pre chunk's modules is an object`);
  const entries: PreEntry[] = [];
  for (const [key, e] of Object.entries(c.modules)) {
    const m = /^(py|sage)\|(.+)$/.exec(key);
    if (!m || !p.modules.includes(m[2])) fail(`${id}: pre entry ${JSON.stringify(key.slice(0, 80))} is not one of its modules`);
    if (!isObj(e)) fail(`${id}: pre entry ${key} is an object`);
    exactKeys(e as any, ["code", "lineMap", "path"], [], `${id}'s pre entry ${key}`);
    const ee = e as any;
    if (typeof ee.code !== "string" || !Array.isArray(ee.lineMap)) fail(`${id}: pre entry ${key} has code and lineMap`);
    // (its own file, by its path in the package: never a core path)
    if (typeof ee.path !== "string" || !Object.hasOwn(p.files, ee.path)) fail(`${id}: pre entry ${key}'s path is not one of its files`);
    const rel = p.root + "/" + m![2].split(".").join("/");
    if (ee.path !== rel + ".py" && ee.path !== rel + "/__init__.py") fail(`${id}: pre entry ${key}'s path is not its module's file`);
    entries.push({ key, module: m![2], sage: m![1] === "sage", path: ee.path, code: ee.code, lineMap: ee.lineMap });
  }
  return { kind: "pre", entries };
}

/** A js chunk's one module and its notices (A1.1, A1.1a). */
export interface JsChunk {
  kind: "js";
  entry: string;
  text: string;
  notices: string;
}
const JS_ENTRY = /^[a-z0-9][a-z0-9._-]{0,63}\.js$/;

/**
 * Check a js package's chunk (addendum A1.1, A1.1a, A1.2): the bytes the index
 * pins, its header naming this package and kind, exactly one module, which is
 * its entry, that module's text at most jsModuleBytes of UTF-8, and its
 * notices, plain text of at most jsNoticesBytes.  Throws a PkgsetError;
 * returns the module's text and the notices.  The host runs it only in its own
 * worker (bash plan §6), never in the page's realm.
 */
export function checkJsChunk(plan: SetPlan, id: string, bytes: Uint8Array): JsChunk {
  const j = plan.js.get(id);
  if (!j) return fail(`package set ${plan.S.slice(0, 12)} has no js package ${id}`);
  if (!(bytes instanceof Uint8Array) || bytes.length !== j.js.size) fail(`${id}: its js chunk is not the size the index pins`);
  if (sha256Hex(bytes) !== j.js.sha256) fail(`${id}: its js chunk is not the one the index pins`);
  const c = strictJson(utf8(bytes, `${id}'s js chunk`));
  if (!isObj(c)) fail(`${id}: a chunk is an object`);
  exactKeys(c, ["format", "v", "kind", "package", "entry", "modules", "notices"], [], `${id}'s js chunk`);
  if (c.format !== "sagebrush-pkg-chunk" || c.v !== 1) fail(`${id}: not a v1 package chunk`);
  if (c.kind !== "js" || c.package !== id) fail(`${id}: the chunk says it is ${String(c.package).slice(0, 80)}'s ${String(c.kind).slice(0, 8)}, not ${id}'s js`);
  if (typeof c.entry !== "string" || !JS_ENTRY.test(c.entry)) fail(`${id}: a js chunk's entry is a file name like shell.js`);
  if (!isObj(c.modules)) fail(`${id}: a js chunk's modules is an object`);
  const keys = Object.keys(c.modules);
  if (keys.length !== 1 || keys[0] !== c.entry) fail(`${id}: a js chunk has exactly one module, its entry`);
  const text = c.modules[c.entry];
  if (typeof text !== "string") fail(`${id}: ${c.entry} is not text`);
  if (utf8Bytes(text).length > PKGSET_LIMITS.jsModuleBytes) fail(`${id}: ${c.entry} is over ${PKGSET_LIMITS.jsModuleBytes} bytes`);
  // (the notices: required, plain text: no control characters but \n and \t)
  const notices = c.notices;
  if (typeof notices !== "string" || notices === "") fail(`${id}: a js chunk carries its notices (the license texts of what it bundles)`);
  if (utf8Bytes(notices).length > PKGSET_LIMITS.jsNoticesBytes) fail(`${id}: its notices are over ${PKGSET_LIMITS.jsNoticesBytes} bytes`);
  if (/[\u0000-\u0008\u000b-\u001f\u007f]/.test(notices)) fail(`${id}: its notices are plain text (no control characters but newline and tab)`);
  return { kind: "js", entry: c.entry, text, notices };
}

// ---------------------------------------------------------------------------
// The grader's aggregate admission (§4.5): measured costs only, for this
// exact build; unknown costs are refused, never borrowed from another build.

export const GRADER_BUDGET = Object.freeze({ cpuMs: 4000, mb: 72, prodFactor: 1.5 });
export interface GraderBaseline {
  cpu_ms: number;
  peak_mb: number;
}
/** The fast path's verdict for importing `roots` (package ids) from `plan` in core build `build`. */
export function graderAdmission(plan: SetPlan, roots: string[], build: string, base: GraderBaseline): { ok: true; closure: string[] } | { ok: false; reason: string } {
  const closure: string[] = [];
  for (const r of roots) {
    const c = plan.closure.get(r);
    if (!c) return { ok: false, reason: `the set has no package ${r}` };
    for (const x of c) if (!closure.includes(x)) closure.push(x);
  }
  let cpu = base.cpu_ms, mb = base.peak_mb;
  for (const id of closure) {
    const p = plan.packages.get(id)!;
    const c = p.cost[build];
    if (!c) return { ok: false, reason: `${id} has no measured cost for build ${build}` };
    const use = p.pre[build] ? c.pre : c.src;
    if (!use) return { ok: false, reason: `${id} has no measured cost with precompiled code for build ${build}` };
    cpu += use.cpu_ms;
    mb += use.peak_mb;
  }
  if (GRADER_BUDGET.prodFactor * cpu > GRADER_BUDGET.cpuMs) return { ok: false, reason: `this assignment's packages need about ${Math.round(GRADER_BUDGET.prodFactor * cpu)} ms to start, over ${GRADER_BUDGET.cpuMs} ms` };
  if (mb > GRADER_BUDGET.mb) return { ok: false, reason: `this assignment's packages need about ${mb} MB, over ${GRADER_BUDGET.mb} MB` };
  return { ok: true, closure };
}

// ---------------------------------------------------------------------------
// Protocol calls the core makes on a package's methods (§6.4): an argument
// added to a protocol is passed only to a method that implements it, by its
// own signature or by its package's validated `provides`; never because of
// what the package requires.

/**
 * The parameters a function's own metadata gives it, as a keyword could name
 * them (positional-or-keyword and keyword-only; not positional-only), and
 * whether it has **kwargs; null if it has none to read.  This is the compiled
 * function's $sig (src/runtime/object.ts, what bindArgs binds by; the same
 * __code__ reports); a bound method's is its function's.
 */
export function signatureOf(fn: any): { names: Set<string>; varkw: boolean } | null {
  const f = fn !== null && (typeof fn === "object" || typeof fn === "function") && fn.$func !== undefined ? fn.$func : fn;
  const s = typeof f === "function" ? f.$sig : undefined;
  if (s === undefined || s === null || !Array.isArray(s.args) || !Array.isArray(s.kwonly)) return null;
  const posonly = typeof s.posonly === "number" ? s.posonly : 0;
  return { names: new Set([...s.args.slice(posonly), ...s.kwonly].map(String)), varkw: typeof s.kwarg === "string" && s.kwarg !== "" };
}
/**
 * Does `method` (of class `qualname` in a package with `provides`) implement
 * protocol argument `arg`?  By its own signature naming it, or by a validated
 * declaration (for **kwargs).  Unknown or opaque: no, and the core uses the
 * oldest call form.
 */
export function implementsArgument(method: any, arg: string, qualname: string | null, methodName: string, provides: Record<string, Record<string, string[]>> | null): boolean {
  const sig = signatureOf(method);
  if (sig === null) return false;
  if (sig.names.has(arg)) return true;
  if (sig.varkw && qualname !== null && provides !== null && Object.hasOwn(provides, qualname)) {
    const ms = provides[qualname];
    return Object.hasOwn(ms, methodName) && ms[methodName].includes(arg);
  }
  return false;
}
