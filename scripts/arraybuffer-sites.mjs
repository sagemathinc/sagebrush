// The js-arraybuffer census (plan-d0-browser-capacity r5 section 2.1, errata E1
// and E1r2, plan-d0-2-gate r3): every call and `new` in the browser worker's
// sources, classified by its resolved type with the TypeScript checker over the
// repository's tsconfig, and every place JS text becomes code.
//
// A record is one of:
//   store       the call's type graph contains an ArrayBuffer, a SharedArrayBuffer
//               or an ArrayBufferView;
//   opaque      the graph reaches `any` or `unknown` anywhere (E1r2.1: nested too);
//   unresolved  the graph couldn't be finished (an unresolvable type, or more
//               than VISIT_BUDGET types);
//   code-sink   text becomes code here (plan section 3.1), found by the callee's
//               resolved capability, not its spelling;
//   delegating  the call goes through a dynamic target (an any-typed callee, a
//               signature with no body, a computed or value callee: section 3.2),
//               whatever its result type.
// A clean call through a static target is not a record.  The type walk is the
// whole finite graph (unions, intersections, awaited types, type arguments,
// base types, properties, index signatures; a type parameter by its
// constraint), each type once, and fails closed.
//
//   node scripts/arraybuffer-sites.mjs [--root DIR] [--commit SHA] [--json]
//
// The checker is TypeScript 5's JavaScript API by the devDependency alias
// typescript-api (the repository's own tsc is TypeScript 7, which has none);
// SB_TS_API overrides the module for local runs.
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, readlinkSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
export const ts = require(process.env.SB_TS_API || "typescript-api");
const here = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(here, "..");

export const VISIT_BUDGET = 100_000;
// the store types, by their lib declaration's name
export const STORE_NAMES = new Set([
  "ArrayBuffer", "SharedArrayBuffer", "ArrayBufferView", "ArrayBufferLike", "DataView",
  "Int8Array", "Uint8Array", "Uint8ClampedArray", "Int16Array", "Uint16Array", "Int32Array", "Uint32Array",
  "Float16Array", "Float32Array", "Float64Array", "BigInt64Array", "BigUint64Array", "Buffer",
]);

const sha = (s) => createHash("sha256").update(s).digest("hex");

// a lib declaration (TypeScript's lib.*.d.ts, or @types/node), as opposed to a
// local name that happens to match
export function libFile(fileName) {
  const f = fileName.split(sep).join("/");
  let m = /\/typescript\/lib\/(lib\.[^/]+\.d\.ts)$/.exec(f);
  if (m) return "lib:" + m[1];
  m = /\/@types\/node\/(.+\.d\.ts)$/.exec(f);
  if (m) return "@types/node/" + m[1];
  return null;
}
const isLibSymbol = (sym) => (sym?.declarations ?? []).some((d) => libFile(d.getSourceFile().fileName) !== null);

// the kind of a type: {kind: "store", store} | {kind: "opaque", opaque} |
// {kind: "unresolved", reason} | {kind: "clean"}.  A store found anywhere wins
// over an opaque part (the record notes both).
export function kindOf(checker, t, at, budget = VISIT_BUDGET) {
  const seen = new Set();
  const work = [t];
  let visits = 0;
  let opaque = null;
  let store = null;
  while (work.length) {
    const x = work.pop();
    if (x == null) return { kind: "unresolved", reason: "a type the checker can't resolve" };
    if (seen.has(x)) continue;
    seen.add(x);
    if (++visits > budget) return { kind: "unresolved", reason: `more than ${budget} types in its graph` };
    const f = x.flags;
    if (f & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) {
      opaque ??= f & ts.TypeFlags.Any ? "any" : "unknown";
      continue;
    }
    if (f & ts.TypeFlags.Primitive && !(f & ts.TypeFlags.Object)) continue;
    // a type parameter (or an indexed, conditional or substituted type) is its
    // constraint; with none, it could be anything at run time: opaque
    if (f & ts.TypeFlags.Instantiable) {
      const c = checker.getBaseConstraintOfType(x);
      if (!c || c === x || c.flags & ts.TypeFlags.Unknown) opaque ??= "unknown";
      else work.push(c);
      continue;
    }
    for (const s of [x.getSymbol?.(), x.aliasSymbol]) {
      if (s && STORE_NAMES.has(s.getName()) && isLibSymbol(s)) store ??= s.getName();
    }
    if (f & ts.TypeFlags.UnionOrIntersection) {
      work.push(...x.types);
      continue;
    }
    const awaited = checker.getAwaitedType(x);
    if (awaited && awaited !== x) work.push(awaited);
    if (f & ts.TypeFlags.Object) {
      if (x.objectFlags & ts.ObjectFlags.Reference) work.push(...checker.getTypeArguments(x));
      if (x.objectFlags & (ts.ObjectFlags.Class | ts.ObjectFlags.Interface)) work.push(...(checker.getBaseTypes(x) ?? []));
      for (const p of checker.getPropertiesOfType(x)) work.push(checker.getTypeOfSymbolAtLocation(p, at));
      // index signatures: a Record<string, T> holds its Ts (found by tsc 7's parity check)
      for (const i of checker.getIndexInfosOfType(x)) work.push(i.type);
    }
  }
  if (store) return opaque ? { kind: "store", store, opaque } : { kind: "store", store };
  if (opaque) return { kind: "opaque", opaque };
  return { kind: "clean" };
}

// the normalized text of a node: its tokens, comments and whitespace dropped
export function norm(node, sf) {
  const out = [];
  const walk = (n) => {
    if (n.kind >= ts.SyntaxKind.FirstJSDocNode && n.kind <= ts.SyntaxKind.LastJSDocNode) return;
    const kids = n.getChildren(sf);
    if (kids.length === 0) {
      const t = n.getText(sf);
      if (t) out.push(t);
    } else for (const k of kids) walk(k);
  };
  walk(node);
  return out.join(" ");
}

const isFunctionLike = (n) =>
  ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n) || ts.isConstructorDeclaration(n) || ts.isGetAccessorDeclaration(n) ||
  ts.isSetAccessorDeclaration(n) || ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isClassStaticBlockDeclaration(n);

// the name of a function-like node if it is a declaration in its own right:
// a named function or member, or a function expression bound to a name
function declName(n, sf) {
  const cls = (c) => (c && (ts.isClassDeclaration(c) || ts.isClassExpression(c)) ? (c.name?.getText(sf) ?? "<class>") + "." : "");
  if (ts.isFunctionDeclaration(n)) return n.name ? n.name.getText(sf) : "default";
  if (ts.isMethodDeclaration(n) || ts.isGetAccessorDeclaration(n) || ts.isSetAccessorDeclaration(n)) {
    const pre = ts.isGetAccessorDeclaration(n) ? "get " : ts.isSetAccessorDeclaration(n) ? "set " : "";
    return pre + cls(n.parent) + n.name.getText(sf);
  }
  if (ts.isConstructorDeclaration(n)) return cls(n.parent) + "constructor";
  if (ts.isClassStaticBlockDeclaration(n)) return cls(n.parent) + "static{}";
  if (ts.isArrowFunction(n) || ts.isFunctionExpression(n)) {
    const p = n.parent;
    if (ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) return p.name.getText(sf);
    if (ts.isPropertyDeclaration(p)) return cls(p.parent) + p.name.getText(sf);
  }
  return null;
}

// a declaration's fingerprint: its file, name and normalized text
const fpCache = new WeakMap();
export function fingerprint(node, name, rel) {
  let h = fpCache.get(node);
  if (h === undefined) {
    h = sha(rel + "\n" + name + "\n" + norm(node, node.getSourceFile())).slice(0, 16);
    fpCache.set(node, h);
  }
  return h;
}

// the lib or source location of a declaration, as a stable key
function declKey(d, root) {
  const sf = d.getSourceFile();
  const lib = libFile(sf.fileName);
  const file = lib ?? relative(root, sf.fileName).split(sep).join("/");
  return { file, lib: lib !== null };
}

// a lib declaration's member name: Interface.member or the function's name
function libMemberName(d) {
  const nm = d.name ? d.name.getText(d.getSourceFile()) : ts.isConstructSignatureDeclaration(d) ? "new" : ts.isCallSignatureDeclaration(d) ? "call" : "<anon>";
  let p = d.parent;
  while (p && !(ts.isInterfaceDeclaration(p) || ts.isClassDeclaration(p) || ts.isModuleDeclaration(p) || ts.isSourceFile(p) || ts.isTypeLiteralNode(p))) p = p.parent;
  if (p && (ts.isInterfaceDeclaration(p) || ts.isClassDeclaration(p))) return p.name.getText(p.getSourceFile()) + "." + nm;
  if (p && ts.isTypeLiteralNode(p)) {
    let q = p.parent;
    while (q && !ts.isVariableDeclaration(q) && !ts.isInterfaceDeclaration(q) && !ts.isTypeAliasDeclaration(q) && !ts.isPropertySignature(q)) q = q.parent;
    return (q?.name ? q.name.getText(q.getSourceFile()) : "<type>") + "." + nm;
  }
  return nm;
}

// ---- code sinks (plan section 3.1): by the resolved capability of a value
const VM_FILE = "@types/node/vm.d.ts";
function sinkCapability(checker, expr) {
  while (ts.isParenthesizedExpression(expr) || (ts.isBinaryExpression(expr) && expr.operatorToken.kind === ts.SyntaxKind.CommaToken)) expr = ts.isParenthesizedExpression(expr) ? expr.expression : expr.right;
  const t = checker.getTypeAtLocation(expr);
  const syms = [t.getSymbol?.(), t.aliasSymbol, checker.getSymbolAtLocation(expr)].filter(Boolean);
  for (let s of syms) {
    if (s.flags & ts.SymbolFlags.Alias) s = checker.getAliasedSymbol(s);
    for (const d of s.declarations ?? []) {
      const lib = libFile(d.getSourceFile().fileName);
      if (lib === null) continue;
      const nm = s.getName();
      if (nm === "FunctionConstructor" && lib.startsWith("lib:")) return "Function";
      if (nm === "eval" && lib.startsWith("lib:")) return "eval";
      if (nm === "importScripts") return "importScripts";
      if (lib === VM_FILE && /^(runInThisContext|runInContext|runInNewContext|compileFunction|Script|SourceTextModule|SyntheticModule|measureMemory)$/.test(nm)) return "vm." + nm;
      if (lib === VM_FILE && /^(runInThisContext|runInContext|runInNewContext)$/.test(nm) && d.parent && ts.isClassDeclaration(d.parent)) return "vm.Script#" + nm;
    }
  }
  return null;
}

function hasStringTimer(checker, n) {
  // setTimeout/setInterval with a non-function first argument evaluate text
  const name = ts.isIdentifier(n.expression) ? n.expression.text : ts.isPropertyAccessExpression(n.expression) ? n.expression.name.text : null;
  if (name !== "setTimeout" && name !== "setInterval") return false;
  const a = n.arguments?.[0];
  if (!a) return false;
  const t = checker.getTypeAtLocation(a);
  return !(t.getCallSignatures().length > 0) || !!(t.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.StringLike));
}

// the names of the text-to-code operations: a dynamic call by one of these is a
// sink too (a supplement to the capability rule, for untyped values)
const SINK_NAMES = new Set(["eval", "Function", "runInThisContext", "runInContext", "runInNewContext", "compileFunction", "importScripts", "Script", "evaluate"]);

// the members implicit invocations run, by protocol (a member's name as declared)
export const PROTOCOL = {
  coerce: /^(valueOf|toString|\[Symbol\.toPrimitive\])$/,
  iterate: /^(\[Symbol\.(iterator|asyncIterator)\]|next|return|throw)$/,
  await: /^then$/,
  json: /^toJSON$/,
};

// the host's own modules (Node's builtins), which require() may name
const HOST_MODULE = /^(node:)?(fs|os|path|crypto|zlib|util|url|child_process|worker_threads|v8|perf_hooks|module|process|buffer|events|stream|tty|readline|assert)$/;

const isLiteralText = (a) => a && (ts.isStringLiteral(a) || ts.isNoSubstitutionTemplateLiteral(a));

// the function a symbol names: its body-bearing declaration (an overloaded
// function's implementation), or through a const binding (`const f = g`,
// `const {f} = ns`, `const f = () => ...`) to one; null if it names no single
// function with a body
const skipParens = (e) => (ts.isParenthesizedExpression(e) ? skipParens(e.expression) : e);
function isConstBinding(v) {
  let p = v;
  while (p && !ts.isVariableDeclarationList(p)) p = p.parent;
  return !!p && !!(p.flags & ts.NodeFlags.Const);
}
export function resolveFn(checker, s, depth = 0) {
  if (!s || depth > 8) return null;
  if (s.flags & ts.SymbolFlags.Alias) s = checker.getAliasedSymbol(s);
  const impl = (s.declarations ?? []).find((d) => isFunctionLike(d) && d.body);
  if (impl) return impl;
  const v = s.valueDeclaration;
  if (v && ts.isVariableDeclaration(v) && ts.isIdentifier(v.name) && v.initializer && isConstBinding(v)) {
    const init = skipParens(v.initializer);
    if (isFunctionLike(init) && init.body) return init;
    if (ts.isIdentifier(init) || ts.isPropertyAccessExpression(init)) return resolveFn(checker, checker.getSymbolAtLocation(init), depth + 1);
    return null;
  }
  if (v && ts.isBindingElement(v) && ts.isObjectBindingPattern(v.parent) && ts.isVariableDeclaration(v.parent.parent) && v.parent.parent.initializer && isConstBinding(v) && !v.dotDotDotToken) {
    const name = (v.propertyName ?? v.name).getText(v.getSourceFile());
    return resolveFn(checker, checker.getPropertyOfType(checker.getTypeAtLocation(v.parent.parent.initializer), name), depth + 1);
  }
  return null;
}

// a call the parity wrapper can't enclose without changing the program's meaning
// to the checker (E1r2.2): super calls, links inside an optional chain, and calls
// whose signature narrows (a type predicate, an assertion, a never return)
function parityskip(checker, n) {
  if (n.expression.kind === ts.SyntaxKind.SuperKeyword) return "super";
  if (n.expression.kind === ts.SyntaxKind.ImportKeyword) return null;
  const p = n.parent;
  if (p && (ts.isPropertyAccessExpression(p) || ts.isElementAccessExpression(p) || ts.isCallExpression(p)) && p.expression === n && (p.flags & ts.NodeFlags.OptionalChain)) return "optional-chain link";
  // a call ending an optional chain narrows its receiver where it's tested
  if (n.flags & ts.NodeFlags.OptionalChain) return "optional chain";
  // bind: its result is a function (clean), and wrapping it changes its `this` inference
  if (ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === "bind") return "bind";
  const sig = checker.getResolvedSignature(n);
  const pred = sig && checker.getTypePredicateOfSignature(sig);
  if (pred) return pred.kind === ts.TypePredicateKind.AssertsThis || pred.kind === ts.TypePredicateKind.AssertsIdentifier ? "asserts" : "type predicate";
  const rt = checker.getTypeAtLocation(n);
  if (rt.flags & ts.TypeFlags.Never) return "never";
  // a call, inside its own callee, of a function whose return type is inferred: the
  // wrapper would make that inference circular
  const d = sig?.getDeclaration?.();
  if (d && isFunctionLike(d) && !d.type && d.body) for (let q = n.parent; q; q = q.parent) if (q === d) return "recursive, inferred return";
  // a class field's (or object-literal property's) unannotated initializer: the wrapper's check
  // would walk the class while its field types are still being inferred (a circularity)
  for (let q = n.parent; q && !ts.isBlock(q) && !isFunctionLike(q); q = q.parent) {
    if ((ts.isPropertyDeclaration(q) && !q.type) || ts.isPropertyAssignment(q) || ts.isShorthandPropertyAssignment(q)) return "inferred field initializer";
    if (ts.isVariableDeclaration(q)) break;
  }
  return null;
}

// a reference to a scanned class (passing a class to Reflect.construct, say)
function refClass(checker, e) {
  let s = checker.getSymbolAtLocation(e);
  if (s && s.flags & ts.SymbolFlags.Alias) s = checker.getAliasedSymbol(s);
  return !!(s && s.flags & ts.SymbolFlags.Class);
}

// ---- the static target of a call or `new` (section 3.2): a declaration with
// a body that the callee expression names (resolveFn), a scanned class, or a
// lib declaration; anything else is dynamic
function target(checker, n, root) {
  if (n.expression.kind === ts.SyntaxKind.ImportKeyword) return { dynamic: "import()" };
  const callee = skipParens(n.expression);
  const ct = checker.getTypeAtLocation(callee);
  if (ct.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return { dynamic: "any-callee" };
  let s = ts.isIdentifier(callee) || ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee) ? checker.getSymbolAtLocation(callee) : undefined;
  if (s && s.flags & ts.SymbolFlags.Alias) s = checker.getAliasedSymbol(s);
  if (ts.isNewExpression(n) && s && s.flags & ts.SymbolFlags.Class) {
    const cd = s.valueDeclaration ?? s.declarations?.[0];
    if (cd) {
      const k = declKey(cd, root);
      if (k.lib) return { lib: k.file, member: s.getName() + ".new" };
      return { cls: cd, key: k.file };
    }
  }
  const sig = checker.getResolvedSignature(n);
  const d = sig?.getDeclaration?.() ?? sig?.declaration;
  if (d && !ts.isJSDocSignature?.(d)) {
    const k = declKey(d, root);
    if (k.lib) return { lib: k.file, member: libMemberName(d) };
  }
  const fn = resolveFn(checker, s);
  if (fn) return { decl: fn, key: declKey(fn, root).file };
  if (!d) return { dynamic: ct.getSymbol?.()?.getName() === "Function" && isLibSymbol(ct.getSymbol()) ? "Function-typed" : "no-declaration" };
  // an abstract method: its overrides run (the reference graph's override edges)
  if (ts.isMethodDeclaration(d) && !d.body && d.parent && ts.isClassLike(d.parent) && (ts.getCombinedModifierFlags(d) & ts.ModifierFlags.Abstract) && s && (s.declarations ?? []).includes(d)) return { decl: d, key: declKey(d, root).file };
  if (!d.body) return { dynamic: "signature-only" };
  return { dynamic: "value-callee" };
}

// ---- the census
const relOf = (root, sf) => relative(root, sf.fileName).split(sep).join("/");
const isSourceFile = (sf) => !sf.isDeclarationFile && !sf.fileName.includes(`${sep}node_modules${sep}`);
const className = (c, sf) => (c.name ? c.name.getText(sf) : "<class>");

// the typed-array, DataView and Buffer constructors and factories whose first
// argument decides between a view of an existing store and a new one
const VIEW_CTOR = /^(Int8|Uint8|Uint8Clamped|Int16|Uint16|Int32|Uint32|Float16|Float32|Float64|BigInt64|BigUint64)ArrayConstructor\.new$|^DataViewConstructor\.new$/;

// Generated modules: the repository's build output (build/, gitignored) isn't part of the tracked tree, so
// the census never reads it, whether or not a build ran (CI's engine jobs run scripts/build-cli.mjs first).
// The boundary covers every read the census makes: the tsconfig's (trackedConfig: its extends chain walked
// first, an excluded config refused, every parse diagnostic fatal) and the program's (trackedHost: exists,
// read, list), with symlinks resolved; a final check refuses a program holding an excluded file.  Every
// reference a program file or the tsconfig makes into an excluded path is listed in the header; one that
// isn't a reviewed generated module, or whose generator changed or breaks the contract, fails the gate
// (generatedProblems in arraybuffer-sites-check.mjs).
export const EXCLUDED_DIRS = ["build/"];
// A reviewed generated module: its tracked generator, and the sha256 of the generator's whole input closure
// (the generator and every tracked module it imports, statically or by a literal import(), transitively),
// renewed only by review (`node scripts/arraybuffer-sites-check.mjs --generated` prints it).  The contract,
// checked on those texts without a build, holds only together with the pin, never instead of it: the output
// is written once, by a template whose lines are `globalThis.NAME = ${JSON.stringify(...)};`; its file name
// appears in no other string of the closure; and nothing in the closure assigns to JSON.  What the pin and
// the contract assume (stated, reviewed with each renewal): the closure is all the JavaScript the generator
// process runs, Node's builtins are unpatched (the closure assigns none), and the tools it runs (bun build,
// deno compile, node --build-sea, git) write only the outputs named on their command lines, none of them this
// module.  So loading the module assigns JSON literals to globals and runs nothing else.
export const GENERATED = {
  "build/cli/lib-meta.gen.js": { generator: "scripts/build-cli.mjs", generator_sha256: "707a7432fb99b59b9b1db3a842655b8e9fbc0671275f7c94d0376c55b9718ad6" },
};
const toRel = (root, f) => relative(root, f).split(sep).join("/");
const excludedPath = (root, f) => EXCLUDED_DIRS.some((d) => `${toRel(root, f)}/`.startsWith(d));
// Symlinks are resolved as the OS does (component by component, `..` after the links before it), reading each
// link's text, so a dangling link resolves the same as a live one and the result doesn't depend on a build.
// `step` sees every directory or file the walk passes through.  A cycle, or more than MAX_LINK_HOPS links
// (Linux's MAXSYMLINKS: the OS refuses such a path with ELOOP), throws: never a path left unresolved.
export const MAX_LINK_HOPS = 40;
export function resolveLinks(p, step = () => {}) {
  const parts = (isAbsolute(p) ? p : join(process.cwd(), p)).split(sep);
  let cur = sep;
  let hops = 0;
  const seen = new Set();
  while (parts.length) {
    const part = parts.shift();
    if (part === "" || part === ".") continue;
    if (part === "..") {
      cur = dirname(cur);
      step(cur);
      continue;
    }
    const next = join(cur, part);
    step(next);
    let link = null;
    try {
      if (lstatSync(next).isSymbolicLink()) link = readlinkSync(next);
    } catch {}
    if (link === null) {
      cur = next;
      continue;
    }
    if (seen.has(next)) throw new Error(`a cycle of symbolic links at ${next}`);
    seen.add(next);
    if (++hops > MAX_LINK_HOPS) throw new Error(`more than ${MAX_LINK_HOPS} symbolic links resolving ${p}`);
    parts.unshift(...link.split(sep));
    if (isAbsolute(link)) cur = sep;
  }
  return cur;
}
// excluded: under build/ as written, or anywhere the resolution of its links passes through build/
export function hiddenPath(root, f) {
  if (excludedPath(root, f)) return true;
  const croot = resolveLinks(root);
  let through = false;
  const end = resolveLinks(f, (x) => {
    if (excludedPath(croot, x)) through = true;
  });
  return through || excludedPath(croot, end);
}
// the tsconfig, read on the boundary: its extends chain (relative entries; a package's resolves in
// node_modules) walked over tracked configs, any excluded one refused by name, then parsed with excluded
// paths missing; every diagnostic of the parse is fatal, never dropped
export function trackedConfig(root) {
  const bad = [];
  const seen = new Set();
  const walk = (file, from) => {
    if (hiddenPath(root, file)) return void bad.push(`${toRel(root, file)} (extended by ${from})`);
    if (seen.has(file)) return;
    seen.add(file);
    let text;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      return; // (missing: the parse reports it)
    }
    const ext = ts.parseConfigFileTextToJson(file, text).config?.extends;
    for (const e of [ext].flat()) {
      if (typeof e !== "string" || !(e.startsWith(".") || isAbsolute(e))) continue;
      const f = resolve(dirname(file), e);
      walk(f.endsWith(".json") ? f : `${f}.json`, toRel(root, file));
    }
  };
  walk(join(root, "tsconfig.json"), "the census");
  if (bad.length) throw new Error(`the census's tsconfig extends excluded configs: ${bad.join(", ")}`);
  const cfg = ts.getParsedCommandLineOfConfigFile(join(root, "tsconfig.json"), {}, trackedSys(root));
  if (cfg.errors.length) throw new Error(`the census's tsconfig: ${cfg.errors.map((d) => ts.flattenDiagnosticMessageText(d.messageText, " ")).join("; ")}`);
  return cfg;
}
// the config parse's system: ts.sys with every read of an excluded path answered as missing
export function trackedSys(root) {
  const hid = (f) => hiddenPath(root, f);
  const entries = (dir) => {
    const files = [];
    const directories = [];
    let es = [];
    try {
      es = readdirSync(dir || ".", { withFileTypes: true });
    } catch {}
    for (const e of es) {
      const f = join(dir, e.name);
      if (hid(f)) continue;
      let st = e;
      if (e.isSymbolicLink()) {
        try {
          st = statSync(f);
        } catch {
          continue;
        }
      }
      if (st.isFile()) files.push(e.name);
      else if (st.isDirectory()) directories.push(e.name);
    }
    return { files: files.sort(), directories: directories.sort() };
  };
  return {
    ...ts.sys,
    fileExists: (f) => !hid(f) && ts.sys.fileExists(f),
    readFile: (f) => (hid(f) ? undefined : ts.sys.readFile(f)),
    directoryExists: (d) => !hid(d) && ts.sys.directoryExists(d),
    // (TS's own walk, given entries without the hidden ones: it never enters a hidden directory, so its
    // realpath dedupe can't take a hidden alias of a tracked directory for the directory; the pinned 5.9's
    // matchFiles, the function ts.sys.readDirectory calls)
    readDirectory: (path, extensions, excludes, includes, depth) => ts.matchFiles(path, extensions, excludes, includes, ts.sys.useCaseSensitiveFileNames, process.cwd(), depth, entries, ts.sys.realpath),
    onUnRecoverableConfigFileDiagnostic: (d) => { throw new Error(ts.flattenDiagnosticMessageText(d.messageText, "\n")); },
  };
}
// the census program's host: the compiler's own, with every read of an excluded path answered as missing
export function trackedHost(root, options) {
  const host = ts.createCompilerHost(options);
  const hid = (f) => hiddenPath(root, f);
  const { fileExists, readFile, directoryExists, getDirectories } = host;
  host.fileExists = (f) => !hid(f) && fileExists.call(host, f);
  // (the source read: the compiler's getSourceFile reads through host.readFile, so this one denial covers
  // parsing too, a triple-slash reference's included; the tests pin that)
  host.readFile = (f) => (hid(f) ? undefined : readFile.call(host, f));
  host.directoryExists = (d) => !hid(d) && directoryExists.call(host, d);
  // (a hidden directory lists nothing, even a child whose links lead back out of build/)
  host.getDirectories = (d) => (hid(d) ? [] : getDirectories.call(host, d).filter((c) => !hid(join(d, c))));
  return host;
}
// the final check: a program holding an excluded file is refused, whatever path brought it in
export function assertTracked(root, fileNames) {
  const bad = fileNames.filter((f) => hiddenPath(root, f));
  if (bad.length) throw new Error(`the census program holds excluded files: ${bad.map((f) => toRel(root, f)).join(", ")}`);
}
// a generator's input closure: it and the tracked modules it imports (relative static imports, export
// froms and literal import()s), transitively: {inputs: [{path, text}], missing: [path]}
export function generatorClosure(root, generator) {
  const inputs = [];
  const missing = [];
  const seen = new Set();
  const visit = (rel) => {
    if (seen.has(rel)) return;
    seen.add(rel);
    const f = join(root, rel);
    let text = null;
    try {
      if (!hiddenPath(root, f)) text = readFileSync(f, "utf8");
    } catch {}
    if (text === null) return void missing.push(rel);
    inputs.push({ path: rel, text });
    const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true);
    const dep = (x) => {
      if (x && isLiteralText(x) && x.text.startsWith(".")) visit(toRel(root, join(dirname(f), x.text)));
    };
    const walk = (n) => {
      if (ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) dep(n.moduleSpecifier);
      else if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword && n.arguments.length >= 1) dep(n.arguments[0]);
      ts.forEachChild(n, walk);
    };
    walk(sf);
  };
  visit(generator);
  inputs.sort((a, b) => (a.path < b.path ? -1 : 1));
  return { inputs, missing: missing.sort() };
}
export const closureSha = (inputs) => sha(inputs.map((i) => `${i.path}\n${sha(i.text)}\n`).join(""));
// the contract, on the closure's texts: null when it holds, else why not
export function generatorContract(inputs, generator, path) {
  const name = path.split("/").pop();
  const dirParts = path.split("/").slice(0, -1);
  const main = inputs.find((i) => i.path === generator);
  if (!main) return `its generator ${generator} is missing`;
  const named = [];
  for (const i of inputs) {
    const sf = ts.createSourceFile(i.path, i.text, ts.ScriptTarget.Latest, true);
    let bad = null;
    const walk = (n) => {
      // its name in a string: only the one write may name the output
      if ((ts.isStringLiteralLike(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n)) && n.text.includes(name)) named.push(`${i.path}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}`);
      // JSON reassigned, or redefined: the contract reads JSON.stringify as the builtin
      if (ts.isBinaryExpression(n) && n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && n.operatorToken.kind <= ts.SyntaxKind.LastAssignment && /^(globalThis\s*\.\s*)?JSON\b/.test(n.left.getText(sf))) bad ??= `${i.path} assigns to JSON: ${n.getText(sf).slice(0, 80)}`;
      if (ts.isCallExpression(n) && /^(Object\.(defineProperty|defineProperties|assign|setPrototypeOf)|Reflect\.(set|defineProperty|setPrototypeOf))$/.test(n.expression.getText(sf)) && n.arguments[0] && /^(globalThis\s*\.\s*)?JSON\b/.test(n.arguments[0].getText(sf))) bad ??= `${i.path} redefines JSON: ${n.getText(sf).slice(0, 80)}`;
      ts.forEachChild(n, walk);
    };
    walk(sf);
    if (bad) return bad;
  }
  const sf = ts.createSourceFile(generator, main.text, ts.ScriptTarget.Latest, true);
  const writes = [];
  const outs = [];
  const walk = (n) => {
    if (ts.isCallExpression(n) && n.expression.getText(sf) === "writeFileSync" && n.arguments.length === 2) {
      const a = n.arguments[0];
      if (ts.isCallExpression(a) && a.expression.getText(sf) === "join" && a.arguments.length === 2 && isLiteralText(a.arguments[1]) && a.arguments[1].text === name) writes.push(n);
    }
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === "out") outs.push(n);
    ts.forEachChild(n, walk);
  };
  walk(sf);
  if (writes.length !== 1) return `${writes.length} writes of ${name}, not one`;
  if (named.length !== 1) return `${name} is named ${named.length} times in the closure's strings (${named.join(", ")}), not once`;
  const w = writes[0];
  const dir = w.arguments[0].arguments[0];
  if (!ts.isIdentifier(dir) || dir.text !== "out" || outs.length !== 1) return "its directory isn't the generator's one `out`";
  const o = outs[0].initializer;
  const oParts = o && ts.isCallExpression(o) && o.expression.getText(sf) === "join" ? o.arguments.map((x) => (isLiteralText(x) ? x.text : null)) : [];
  if (!(oParts.length === dirParts.length + 1 && o.arguments[0].getText(sf) === "root" && dirParts.every((d, i) => oParts[i + 1] === d)))
    return `\`out\` isn't join(root, ${dirParts.map((d) => JSON.stringify(d)).join(", ")})`;
  const t = w.arguments[1];
  if (!ts.isTemplateExpression(t)) return "its text isn't a template of globalThis assignments";
  let shape = t.head.text;
  for (const span of t.templateSpans) {
    const e = span.expression;
    if (!(ts.isCallExpression(e) && e.expression.getText(sf) === "JSON.stringify" && e.arguments.length === 1)) return `a value isn't JSON.stringify(...): ${e.getText(sf).slice(0, 80)}`;
    shape += "${}" + span.literal.text;
  }
  if (!/^(globalThis\.[A-Za-z_$][\w$]* = \$\{\};\n)+$/.test(shape)) return `its lines aren't each \`globalThis.NAME = \${JSON.stringify(...)};\`: ${JSON.stringify(shape.slice(0, 120))}`;
  return null;
}

export function census(root = ROOT, { commit = null } = {}) {
  const cfg = trackedConfig(root);
  // the roots: src/runtime/** and the worker; plus every scanned-repository module a
  // constant relative require() names (its code runs too), to a fixpoint
  // (every file the tsconfig names, its explicit `files` and inherited ones included, is checked before the
  // program exists: an excluded one is listed below and never a root, so the host's denial can't lose it silently)
  const excludedRoots = cfg.fileNames.filter((f) => hiddenPath(root, f));
  const rootNames = [...cfg.fileNames.filter((f) => !excludedRoots.includes(f) && f.includes(`${sep}src${sep}runtime${sep}`)), join(root, "web", "worker.ts")];
  let program;
  const options = { ...cfg.options, noEmit: true, allowJs: true };
  const host = trackedHost(root, options);
  for (;;) {
    program = ts.createProgram({ rootNames, options, host });
    const more = [];
    for (const sf of program.getSourceFiles().filter(isSourceFile)) {
      const scan = (n) => {
        if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "require" && n.arguments.length === 1 && isLiteralText(n.arguments[0]) && n.arguments[0].text.startsWith(".")) {
          const base = join(dirname(sf.fileName), n.arguments[0].text);
          const f = [base, base + ".ts", base + ".js", join(base, "index.ts")].find((x) => host.fileExists(x) && !ts.sys.directoryExists(x));
          if (f && !program.getSourceFile(f) && !rootNames.includes(f)) more.push(f);
        }
        ts.forEachChild(n, scan);
      };
      scan(sf);
    }
    if (!more.length) break;
    rootNames.push(...more);
  }
  const checker = program.getTypeChecker();
  const files = program.getSourceFiles().filter(isSourceFile);
  assertTracked(root, program.getSourceFiles().map((f) => f.fileName));
  // and every root is in the program: a tracked root it couldn't read (missing, unreadable) is an error, never dropped
  const lost = rootNames.filter((f) => !program.getSourceFile(f));
  if (lost.length) throw new Error(`the census program lost roots: ${lost.map((f) => toRel(root, f)).join(", ")}`);
  // every reference a program file (declarations too) or the tsconfig makes into an excluded path, present or not
  const generatedFrom = new Map();
  const note = (p0, from, module = false) => {
    // (a module specifier names a file by its stem too: a tracked link "./x" may be x.ts, pointing into build/)
    const p = (module ? [p0, ...[".ts", ".tsx", ".d.ts", ".js", ".mjs", ".cjs", "/index.ts", "/index.js"].map((e) => p0 + e)] : [p0]).find((x) => hiddenPath(root, x));
    if (p === undefined) return;
    // (by the path as the tree writes it, not where its links lead: that may depend on a build)
    const k = toRel(root, p);
    (generatedFrom.get(k) ?? generatedFrom.set(k, new Set()).get(k)).add(from);
  };
  // every tracked symlink under the tsconfig's include directories that resolves into an excluded path, its
  // target there or not (the config read drops what it would list, so it's listed here, the same built or not)
  const linksIn = (d) => {
    let es = [];
    try {
      es = readdirSync(d, { withFileTypes: true });
    } catch {}
    for (const e of es) {
      const f = join(d, e.name);
      if (e.isSymbolicLink()) note(f, "tsconfig.json include");
      else if (e.isDirectory() && e.name !== "node_modules" && !hiddenPath(root, f)) linksIn(f);
    }
  };
  for (const f of excludedRoots) note(f, "tsconfig.json files");
  for (const d of Object.keys(cfg.wildcardDirectories ?? {})) {
    if (hiddenPath(root, d)) note(d, "tsconfig.json include");
    else linksIn(d);
  }
  const paths = Object.entries(options.paths ?? {});
  const pathsBase = options.pathsBasePath ?? options.baseUrl ?? root;
  for (const [, targets] of paths) for (const t of targets) note(join(pathsBase, t.replace("*", "")), "tsconfig.json");
  for (const d of [...(options.typeRoots ?? []), ...(options.rootDirs ?? []), ...(options.baseUrl ? [options.baseUrl] : [])]) note(d, "tsconfig.json");
  for (const sf of program.getSourceFiles().filter((f) => !f.fileName.includes(`${sep}node_modules${sep}`))) {
    const from = relOf(root, sf);
    const spec = (x) => {
      if (!x || !isLiteralText(x)) return;
      if (x.text.startsWith(".")) return note(join(dirname(sf.fileName), x.text), from, true);
      // a path alias: each of its targets, the specifier substituted
      for (const [pat, targets] of paths) {
        const star = pat.indexOf("*");
        const m = star < 0 ? (x.text === pat ? "" : null) : x.text.startsWith(pat.slice(0, star)) && x.text.endsWith(pat.slice(star + 1)) ? x.text.slice(star, x.text.length - (pat.length - star - 1)) : null;
        if (m !== null) for (const t of targets) note(join(pathsBase, t.replace("*", m)), from, true);
      }
    };
    for (const r of sf.referencedFiles) note(join(dirname(sf.fileName), r.fileName), from);
    for (const r of sf.typeReferenceDirectives) if (r.fileName.startsWith(".")) note(join(dirname(sf.fileName), r.fileName), from);
    const scan = (n) => {
      if (ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) spec(n.moduleSpecifier);
      else if (ts.isImportEqualsDeclaration(n) && ts.isExternalModuleReference(n.moduleReference)) spec(n.moduleReference.expression);
      else if (ts.isCallExpression(n) && n.arguments.length === 1 && (n.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(n.expression) && n.expression.text === "require"))) spec(n.arguments[0]);
      else if (ts.isImportTypeNode(n) && ts.isLiteralTypeNode(n.argument)) spec(n.argument.literal);
      ts.forEachChild(n, scan);
    };
    scan(sf);
  }
  const generated = [...generatedFrom].sort(([a], [b]) => (a < b ? -1 : 1)).map(([path, from]) => {
    const g = GENERATED[path];
    if (!g) return { path, from: [...from].sort(), generator: null };
    const { inputs, missing } = generatorClosure(root, g.generator);
    const contract = missing.length ? `its generator's inputs are missing: ${missing.join(", ")}` : generatorContract(inputs, g.generator, path);
    return { path, from: [...from].sort(), generator: g.generator, inputs: [...inputs.map((i) => i.path), ...missing].sort(), generator_sha256: missing.length ? null : closureSha(inputs), contract };
  });
  const records = [];
  // the reference graph, by declaration fingerprint: {file, name, fp, refs, irefs, libs}
  // (refs: resolved references; irefs: the implicit-invocation and by-name accessor edges)
  const decls = new Map();
  const libs = new Map(); // lib member key -> {calls, kinds, fnParam}
  const classes = new Map(); // class fp -> {node, base: fp | lib key | null, ctor: fp | null, methods: Map<name, fp>}
  let calls = 0;
  const allSites = new Map(); // every site key -> its kind (records' kinds, or "clean")
  const spans = []; // every call and new: {file, start, end, kind (the type's), skip}
  const idOf = (node) => {
    const sf = node.getSourceFile();
    const rel = relOf(root, sf);
    const name = ts.isClassDeclaration(node) || ts.isClassExpression(node) ? className(node, sf) + ".class" : ts.isSourceFile(node) ? "<module>" : declName(node, sf) ?? "<module>";
    return { fp: fingerprint(node, name, rel), name, file: rel };
  };
  const declOf = (node) => {
    const id = idOf(node);
    let e = decls.get(id.fp);
    if (!e) decls.set(id.fp, (e = { ...id, refs: new Set(), irefs: new Set(), libs: new Set() }));
    return e;
  };
  // the protocol members and accessors scanned code declares, and who may run them
  const protocol = { coerce: new Set(), iterate: new Set(), await: new Set(), json: new Set() };
  const accessorsByName = new Map();
  const allAccessors = new Set();
  const uses = new Map(); // decl fp -> {kinds: Set, names: Set, all: boolean}
  const useOf = (encNode) => {
    const fp = declOf(encNode).fp;
    let u = uses.get(fp);
    if (!u) uses.set(fp, (u = { kinds: new Set(), names: new Set(), all: false, members: [], classes: [] }));
    return u;
  };
  // the runtime name of a property (astra2 C2b): an identifier, a quoted or numeric name,
  // or a computed one the checker resolves to a literal or a well-known symbol
  // ("[Symbol.iterator]"); undefined if it can't be named
  const keyOfExpr = (e, depth = 0) => {
    e = skipParens(e);
    if (ts.isStringLiteralLike(e) || ts.isNumericLiteral(e)) return e.text;
    const t = checker.getTypeAtLocation(e);
    if (t.isStringLiteral?.() || t.isNumberLiteral?.()) return String(t.value);
    if (t.flags & ts.TypeFlags.UniqueESSymbol) {
      // a well-known symbol: declared on lib's SymbolConstructor (Symbol.iterator, ...)
      const d = t.symbol?.valueDeclaration ?? t.symbol?.declarations?.[0];
      const owner = d?.parent && (ts.isInterfaceDeclaration(d.parent) ? d.parent.name.text : null);
      if (owner === "SymbolConstructor" && libFile(d.getSourceFile().fileName)) return `[Symbol.${t.symbol.getName()}]`;
      return "[symbol " + (t.symbol?.getName() ?? "?") + "]";
    }
    // a const alias: its initializer's name
    if (ts.isIdentifier(e) && depth < 8) {
      let sy = checker.getSymbolAtLocation(e);
      if (sy && sy.flags & ts.SymbolFlags.Alias) sy = checker.getAliasedSymbol(sy);
      const v = sy?.valueDeclaration;
      if (v && ts.isVariableDeclaration(v) && v.initializer && isConstBinding(v)) return keyOfExpr(v.initializer, depth + 1);
    }
    return undefined;
  };
  const memberName = (nm) => {
    if (!nm) return undefined;
    if (ts.isIdentifier(nm) || ts.isPrivateIdentifier(nm) || ts.isStringLiteralLike(nm) || ts.isNumericLiteral(nm)) return nm.text;
    if (ts.isComputedPropertyName(nm)) return keyOfExpr(nm.expression);
    return undefined;
  };
  const kindsOf = (name) => (name === undefined ? Object.keys(PROTOCOL) : Object.keys(PROTOCOL).filter((k) => PROTOCOL[k].test(name)));
  // the protocols a key expression can name: by its literal name; else by its type (a number
  // can't name a protocol member; a union of literals names only those); else all of them
  const kindsOfKey = (e) => {
    const name = keyOfExpr(e);
    if (name !== undefined) return kindsOf(name);
    const t = checker.getTypeAtLocation(e);
    const parts = t.isUnion?.() ? t.types : [t];
    if (parts.every((u) => u.isStringLiteral?.() || u.flags & (ts.TypeFlags.NumberLike | ts.TypeFlags.BigIntLike | ts.TypeFlags.BooleanLike | ts.TypeFlags.Undefined | ts.TypeFlags.Null))) return [...new Set(parts.filter((u) => u.isStringLiteral?.()).flatMap((u) => kindsOf(u.value)))];
    return Object.keys(PROTOCOL);
  };
  const unknownAccessors = new Set();
  const obligations = [];
  const oblBySite = new Map();
  const oblOcc = new Map();
  // ---- installs (astra2 R1, R2: one semantic rule).  Every way a value becomes a property
  // registers that property: assignment (= ??= ||= &&=), a destructuring or for-of target, a
  // class field, an object-literal property or shorthand, a method or accessor, an export,
  // Object.defineProperty / defineProperties / create, Reflect.defineProperty / set,
  // Object.assign and spread (copies), and a Proxy's get trap.  The value is classified:
  // a function (registered: its code is the member), provably not callable (exempt), or
  // anything else, which may be callable (an obligation, fail closed).
  const PRIM = ts.TypeFlags.StringLike | ts.TypeFlags.NumberLike | ts.TypeFlags.BigIntLike | ts.TypeFlags.BooleanLike | ts.TypeFlags.EnumLike | ts.TypeFlags.ESSymbolLike |
    ts.TypeFlags.Null | ts.TypeFlags.Undefined;
  // a type no function can have, a closed set (astra2 X1, X2, V1): primitives that hold a value
  // (string, number, bigint, boolean, symbol, undefined, null, their literal and enum types),
  // unions of these, and a type parameter constrained to one.  Every object-capable type (arrays
  // and tuples, structural and class-instance types, intersections) may be a function:
  // Object.assign(fn, []) is an array, and a constructor can return a function.  void is not
  // in the set: a () => void function may return a function (TypeScript accepts any return
  // there); nor is never (a never-typed value from a declare or a cast is unchecked)
  const notCallableType = (t, depth = 0) => {
    if (!t || depth > 8) return false;
    if (t.flags & PRIM) return true;
    if (t.isUnion?.()) return t.types.every((u) => notCallableType(u, depth + 1));
    // a type parameter: by its constraint (none: it may be anything, a function included)
    if (t.flags & ts.TypeFlags.Instantiable) {
      const c = checker.getBaseConstraintOfType(t);
      return !!c && c !== t && notCallableType(c, depth + 1);
    }
    return false;
  };
  const unwrap = (v) => {
    for (;;) {
      if (ts.isParenthesizedExpression(v) || ts.isAsExpression(v) || ts.isTypeAssertionExpression?.(v) || ts.isSatisfiesExpression?.(v) || ts.isNonNullExpression(v)) v = v.expression;
      else return v;
    }
  };
  // a value: {fns: [function nodes], obligation: why | null}; exempt when both are empty
  const classify = (v, depth = 0) => {
    const out = { fns: [], obligation: null };
    if (!v) return out;
    v = unwrap(v);
    if (depth > 8) return ((out.obligation = "too deep to resolve"), out);
    if (isFunctionLike(v)) return (out.fns.push(v), out);
    // provably not callable by its syntax, a closed set: object, array, template, string, numeric,
    // bigint, boolean, null and regular-expression literals (a literal makes a new non-function)
    if (ts.isObjectLiteralExpression(v) || ts.isArrayLiteralExpression(v) || ts.isTemplateExpression(v) || ts.isNoSubstitutionTemplateLiteral(v) || ts.isStringLiteralLike(v) ||
      ts.isNumericLiteral(v) || ts.isBigIntLiteral(v) || ts.isRegularExpressionLiteral(v) ||
      v.kind === ts.SyntaxKind.TrueKeyword || v.kind === ts.SyntaxKind.FalseKeyword || v.kind === ts.SyntaxKind.NullKeyword) return out;
    if (ts.isConditionalExpression(v)) return merge(classify(v.whenTrue, depth + 1), classify(v.whenFalse, depth + 1));
    if (ts.isBinaryExpression(v) && [ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.CommaToken].includes(v.operatorToken.kind)) {
      return v.operatorToken.kind === ts.SyntaxKind.CommaToken ? classify(v.right, depth + 1) : merge(classify(v.left, depth + 1), classify(v.right, depth + 1));
    }
    if (ts.isIdentifier(v) || ts.isPropertyAccessExpression(v) || ts.isShorthandPropertyAssignment(v)) {
      // (a shorthand property's value is the variable it names)
      let sy = ts.isShorthandPropertyAssignment(v) ? checker.getShorthandAssignmentValueSymbol(v) : checker.getSymbolAtLocation(v);
      const f = resolveFn(checker, sy);
      if (f && isSourceFile(f.getSourceFile())) return (out.fns.push(f), out);
      if (sy && sy.flags & ts.SymbolFlags.Alias) sy = checker.getAliasedSymbol(sy);
      const vd = sy?.valueDeclaration;
      // a const binding: its initializer decides
      if (vd && ts.isVariableDeclaration(vd) && vd.initializer && isConstBinding(vd) && ts.isIdentifier(vd.name)) return classify(vd.initializer, depth + 1);
      if (vd && (ts.isFunctionDeclaration(vd) || ts.isClassDeclaration(vd)) && isSourceFile(vd.getSourceFile())) return (out.fns.push(vd), out);
    }
    if (notCallableType(ts.isShorthandPropertyAssignment(v) ? checker.getTypeAtLocation(v.name) : checker.getTypeAtLocation(v))) return out;
    out.obligation = "its value may be callable and can't be resolved";
    return out;
  };
  const merge = (a, b) => ({ fns: [...a.fns, ...b.fns], obligation: a.obligation ?? b.obligation });
  const asTarget = (f) => (ts.isClassDeclaration(f) || ts.isClassExpression(f) ? f : declName(f, f.getSourceFile()) !== null ? f : enclosing(f, f.getSourceFile()));
  const obligation = (at, what, kinds, accessorName) => {
    const sf = at.getSourceFile();
    const rel = relOf(root, sf);
    const line = sf.getLineAndCharacterOfPosition(at.getStart(sf)).line + 1;
    const role = accessorName === null ? "" : ` accessor ${accessorName ?? "(any name)"}`;
    // one obligation per install site and role: keyed by its text and its occurrence in the file
    const site = `${rel}:${at.pos}:${at.end}${role}`;
    let fp = oblBySite.get(site);
    if (fp) return fp;
    const base = rel + ":" + norm(at, sf) + role;
    const k = oblOcc.get(base) ?? 0;
    oblOcc.set(base, k + 1);
    fp = "obligation:" + sha(base + "#" + k).slice(0, 16);
    oblBySite.set(site, fp);
    {
      const reason = `${what}: ${role ? "an accessor whose function" : "a value that"} may be callable and can't be resolved (${role ? "accessor " + (accessorName ?? "any name") : kinds.join(", ")})`;
      decls.set(fp, { file: rel, name: `obligation: ${norm(at, sf).slice(0, 60)}${role} #${k}`, fp, refs: new Set(), irefs: new Set(), libs: new Set(), obligation: reason });
      obligations.push({ fp, file: rel, line, kinds, accessor: accessorName === null ? null : accessorName ?? "*", reason });
    }
    return fp;
  };
  const addAccessor = (fp, name) => {
    if (name === undefined) unknownAccessors.add(fp);
    else (accessorsByName.get(name) ?? accessorsByName.set(name, new Set()).get(name)).add(fp);
    allAccessors.add(fp);
  };
  // a value installed under protocol kinds (a property that may be a protocol member)
  const install = (kinds, v, at, what) => {
    if (!kinds.length) return;
    const c = v === UNKNOWN ? { fns: [], obligation: "an unknown value" } : classify(v);
    for (const f of c.fns) for (const k of kinds) protocol[k].add(declOf(asTarget(f)).fp);
    if (c.obligation) {
      const fp = obligation(at, what, kinds, null);
      for (const k of kinds) protocol[k].add(fp);
    }
  };
  // a function installed as an accessor (a descriptor's get or set, a Proxy's get trap)
  const installAccessor = (name, v, at, what) => {
    const c = v === UNKNOWN ? { fns: [], obligation: "an unknown value" } : classify(v);
    for (const f of c.fns) addAccessor(declOf(asTarget(f)).fp, name);
    if (c.obligation) addAccessor(obligation(at, what, [], name), name);
  };
  const UNKNOWN = Symbol("unknown value");
  // a property descriptor: its value under kinds, its get and set as accessors; not a
  // literal: anything (both)
  const installDescriptor = (name, kinds, desc, at, what) => {
    desc = desc && unwrap(desc);
    if (!desc || !ts.isObjectLiteralExpression(desc)) {
      install(kinds, UNKNOWN, at, what + " (a descriptor the census can't read)");
      installAccessor(name, UNKNOWN, at, what + " (a descriptor the census can't read)");
      return;
    }
    for (const pr of desc.properties) {
      const pn = pr.name && memberName(pr.name);
      const val = ts.isPropertyAssignment(pr) ? pr.initializer : ts.isShorthandPropertyAssignment(pr) ? pr.name : ts.isMethodDeclaration(pr) ? pr : null;
      if (ts.isSpreadAssignment(pr) || pn === undefined) {
        install(kinds, UNKNOWN, at, what + " (a spread or computed descriptor field)");
        installAccessor(name, UNKNOWN, at, what + " (a spread or computed descriptor field)");
      } else if (pn === "value") install(kinds, val, at, what + "'s value");
      else if (pn === "get" || pn === "set") installAccessor(name, val, at, `${what}'s ${pn}`);
    }
  };
  // a property-descriptor map (defineProperties, Object.create's second argument)
  const installDescriptors = (map, at, what) => {
    map = map && unwrap(map);
    if (!map || !ts.isObjectLiteralExpression(map)) {
      install(Object.keys(PROTOCOL), UNKNOWN, at, what + " (a descriptor map the census can't read)");
      installAccessor(undefined, UNKNOWN, at, what + " (a descriptor map the census can't read)");
      return;
    }
    for (const pr of map.properties) {
      const name = ts.isSpreadAssignment(pr) ? undefined : memberName(pr.name);
      const kinds = kindsOf(name);
      const d = ts.isPropertyAssignment(pr) ? pr.initializer : ts.isShorthandPropertyAssignment(pr) ? pr.name : null;
      installDescriptor(name, kinds, d, at, `${what} ${name ?? "(computed)"}`);
    }
  };
  const kindsOfTarget = (t) => (ts.isPropertyAccessExpression(t) ? kindsOf(t.name.text) : ts.isElementAccessExpression(t) ? kindsOfKey(t.argumentExpression) : []);
  // is this property access the target of a destructuring assignment or a for-of/for-in?
  const isPatternTarget = (n) => {
    let c = n, p = n.parent;
    for (; p; c = p, p = p.parent) {
      if ((ts.isForOfStatement(p) || ts.isForInStatement(p)) && p.initializer === c) return true;
      if (ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.EqualsToken) return p.left === c && c !== n && (ts.isObjectLiteralExpression(c) || ts.isArrayLiteralExpression(c));
      if (!(ts.isArrayLiteralExpression(p) || ts.isObjectLiteralExpression(p) || ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p) || ts.isSpreadElement(p) || ts.isSpreadAssignment(p) ||
        (ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.EqualsToken && p.left === c))) return false;
      if (ts.isPropertyAssignment(p) && p.name === c) return false;
    }
    return false;
  };
  const ASSIGN = new Set([ts.SyntaxKind.EqualsToken, ts.SyntaxKind.QuestionQuestionEqualsToken, ts.SyntaxKind.BarBarEqualsToken, ts.SyntaxKind.AmpersandAmpersandEqualsToken]);
  const exported = (n) => !!(ts.getCombinedModifierFlags(n) & ts.ModifierFlags.Export);
  const registerMember = (n) => {
    const text = (x) => x.getText(x.getSourceFile()).slice(0, 60);
    // the code itself: a method or accessor, by its normalized name (unknown: every member)
    if (isFunctionLike(n) && n.name && !ts.isFunctionDeclaration(n)) {
      const name = memberName(n.name);
      if (ts.isGetAccessorDeclaration(n) || ts.isSetAccessorDeclaration(n)) return addAccessor(declOf(n).fp, name);
      if (ts.isMethodDeclaration(n)) for (const k of kindsOf(name)) protocol[k].add(declOf(n).fp);
      return;
    }
    // a class field, an object-literal property or shorthand
    if ((ts.isPropertyDeclaration(n) && n.initializer) || ts.isPropertyAssignment(n)) {
      if (ts.isPropertyAssignment(n) && ts.isObjectLiteralExpression(n.parent) && isPatternTarget(n.parent.parent ? n.initializer : n)) return;
      return install(ts.isComputedPropertyName(n.name) ? kindsOfKey(n.name.expression) : kindsOf(memberName(n.name)), n.initializer, n, `the property ${text(n.name)}`);
    }
    // (in a destructuring pattern, a shorthand or spread binds a variable, not a property)
    if ((ts.isShorthandPropertyAssignment(n) || ts.isSpreadAssignment(n)) && isPatternTarget(n.name ?? n.expression)) return;
    if (ts.isShorthandPropertyAssignment(n)) return install(kindsOf(n.name.text), n, n, `the property ${n.name.text}`);
    // object spread copies another object's own properties: any name, any value
    if (ts.isSpreadAssignment(n)) return ts.isObjectLiteralExpression(unwrap(n.expression)) || ts.isArrayLiteralExpression(unwrap(n.expression)) ? undefined : install(Object.keys(PROTOCOL), UNKNOWN, n, `a spread of ${text(n.expression)}`);
    // an assignment to a property
    if (ts.isBinaryExpression(n) && ASSIGN.has(n.operatorToken.kind) && (ts.isPropertyAccessExpression(n.left) || ts.isElementAccessExpression(n.left))) {
      return install(kindsOfTarget(n.left), n.right, n, `the assignment to ${text(n.left)}`);
    }
    // a property as a destructuring or loop target: its value is unknown
    if ((ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n)) && isPatternTarget(n)) return install(kindsOfTarget(n), UNKNOWN, n, `the destructuring target ${text(n)}`);
    // an export: a property of the module's namespace object
    if (ts.isFunctionDeclaration(n) && n.name && n.body && exported(n)) for (const k of kindsOf(n.name.text)) protocol[k].add(declOf(n).fp);
    if (ts.isVariableStatement(n) && exported(n)) for (const d of n.declarationList.declarations) if (ts.isIdentifier(d.name)) install(kindsOf(d.name.text), d.initializer ?? UNKNOWN, d, `the export ${d.name.text}`);
    if (ts.isExportSpecifier(n)) install(kindsOf(n.name.text), n.propertyName ?? n.name, n, `the export ${n.name.text}`);
    // lib calls that install properties
    if (ts.isCallExpression(n) || ts.isNewExpression(n)) {
      const d = checker.getResolvedSignature(n)?.getDeclaration?.();
      const lib = d && libFile(d.getSourceFile().fileName);
      if (!lib) return;
      const ln = libMemberName(d);
      const m = ts.isNewExpression(n) && !ln.endsWith(".new") ? ln + ".new" : ln;
      const a = n.arguments ?? [];
      if (/^(ObjectConstructor\.defineProperty|defineProperty)$/.test(m) && (m.startsWith("Object") || lib.includes("reflect"))) {
        return installDescriptor(keyOfExpr(a[1]), kindsOfKey(a[1]), a[2], n, `the defined property ${a[1] ? text(a[1]) : "?"}`);
      }
      if (m === "ObjectConstructor.defineProperties" || m === "ObjectConstructor.create" && a.length >= 2) return installDescriptors(a[1], n, m === "ObjectConstructor.create" ? "Object.create's descriptors" : "defineProperties");
      if (m === "set" && lib.includes("reflect") && a.length >= 3) return install(kindsOfKey(a[1]), a[2], n, `Reflect.set of ${text(a[1])}`);
      if (m === "ObjectConstructor.assign") {
        // (a literal source's own properties are registered where it's written; an array literal's are indexes)
        for (const src of a.slice(1)) if (!ts.isObjectLiteralExpression(unwrap(src)) && !ts.isArrayLiteralExpression(unwrap(src))) install(Object.keys(PROTOCOL), UNKNOWN, n, `Object.assign from ${text(src)}`);
        return;
      }
      if (m === "ProxyConstructor.new") {
        const h = a[1] && unwrap(a[1]);
        install(Object.keys(PROTOCOL), UNKNOWN, n, "a Proxy (its get trap answers any name)");
        if (h && ts.isObjectLiteralExpression(h)) {
          for (const pr of h.properties) {
            const pn = pr.name && memberName(pr.name);
            if (pn === "get" || pn === "set") installAccessor(undefined, ts.isPropertyAssignment(pr) ? pr.initializer : ts.isMethodDeclaration(pr) ? pr : UNKNOWN, n, `a Proxy's ${pn} trap`);
            if (ts.isSpreadAssignment(pr) || pn === undefined) installAccessor(undefined, UNKNOWN, n, "a Proxy's spread handler");
          }
        } else installAccessor(undefined, UNKNOWN, n, "a Proxy's handler");
      }
    }
  };
  // may a value of this type be an object (whose members scanned code may define)?
  const nonPrim = (t, depth = 0) => {
    if (!t || depth > 8) return true;
    const f = t.flags;
    if (f & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.NonPrimitive | ts.TypeFlags.Object)) return true;
    if (f & ts.TypeFlags.Instantiable) {
      const c = checker.getBaseConstraintOfType(t);
      return !c || c === t || nonPrim(c, depth + 1);
    }
    if (f & ts.TypeFlags.UnionOrIntersection) return t.types.some((u) => nonPrim(u, depth + 1));
    return false;
  };
  const np = (e) => !!e && nonPrim(checker.getTypeAtLocation(e));
  const COERCE_BIN = new Set([ts.SyntaxKind.PlusToken, ts.SyntaxKind.MinusToken, ts.SyntaxKind.AsteriskToken, ts.SyntaxKind.SlashToken, ts.SyntaxKind.PercentToken, ts.SyntaxKind.AsteriskAsteriskToken,
    ts.SyntaxKind.AmpersandToken, ts.SyntaxKind.BarToken, ts.SyntaxKind.CaretToken, ts.SyntaxKind.LessThanLessThanToken, ts.SyntaxKind.GreaterThanGreaterThanToken, ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken,
    ts.SyntaxKind.LessThanToken, ts.SyntaxKind.GreaterThanToken, ts.SyntaxKind.LessThanEqualsToken, ts.SyntaxKind.GreaterThanEqualsToken, ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken,
    ts.SyntaxKind.PlusEqualsToken, ts.SyntaxKind.MinusEqualsToken, ts.SyntaxKind.AsteriskEqualsToken, ts.SyntaxKind.SlashEqualsToken, ts.SyntaxKind.PercentEqualsToken, ts.SyntaxKind.AsteriskAsteriskEqualsToken,
    ts.SyntaxKind.AmpersandEqualsToken, ts.SyntaxKind.BarEqualsToken, ts.SyntaxKind.CaretEqualsToken, ts.SyntaxKind.LessThanLessThanEqualsToken, ts.SyntaxKind.GreaterThanGreaterThanEqualsToken,
    ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken]);
  const COERCE_UNARY = new Set([ts.SyntaxKind.PlusToken, ts.SyntaxKind.MinusToken, ts.SyntaxKind.TildeToken, ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken]);
  const keyName = (e) => (e && (ts.isStringLiteralLike(e) || ts.isNumericLiteral(e)) ? e.text : null);
  const inAsync = (n) => {
    for (let p = n.parent; p; p = p.parent) if (isFunctionLike(p)) return !!(ts.getCombinedModifierFlags(p) & ts.ModifierFlags.Async);
    return false;
  };
  const implicitUses = (n, encNode) => {
    if (ts.isPartOfTypeNode(n)) return;
    const mark = (k) => useOf(encNode).kinds.add(k);
    // coercion
    if ((ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n)) && COERCE_UNARY.has(n.operator) && np(n.operand)) mark("coerce");
    if (ts.isBinaryExpression(n) && COERCE_BIN.has(n.operatorToken.kind) && (np(n.left) || np(n.right))) mark("coerce");
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.InKeyword && np(n.left)) mark("coerce");
    if (ts.isTemplateSpan(n) && !ts.isTaggedTemplateExpression(n.parent.parent) && np(n.expression)) mark("coerce");
    if (ts.isElementAccessExpression(n) && keyName(n.argumentExpression) === null && np(n.argumentExpression)) mark("coerce");
    // iteration
    if (ts.isForOfStatement(n) && np(n.expression)) (mark("iterate"), n.awaitModifier && mark("await"));
    if (ts.isSpreadElement(n) && np(n.expression)) mark("iterate");
    if (ts.isArrayBindingPattern(n) && nonPrim(checker.getTypeAtLocation(n))) mark("iterate");
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isArrayLiteralExpression(n.left) && np(n.right)) mark("iterate");
    if (ts.isYieldExpression(n) && n.asteriskToken && np(n.expression)) mark("iterate");
    // awaiting
    if (ts.isAwaitExpression(n) && np(n.expression)) mark("await");
    if (ts.isReturnStatement(n) && n.expression && inAsync(n) && np(n.expression)) mark("await");
    // lib calls: what their parameters do with a non-primitive argument
    if ((ts.isCallExpression(n) || ts.isNewExpression(n)) && n.expression.kind !== ts.SyntaxKind.ImportKeyword) {
      const sig = checker.getResolvedSignature(n);
      const d = sig?.getDeclaration?.();
      if (d && libFile(d.getSourceFile().fileName)) {
        const member = libMemberName(d);
        if (member === "JSON.stringify") (mark("json"), (useOf(encNode).all = true));
        // a promise resolves a thenable it's given, or its callbacks return, by calling its then
        if (/^Promise(Constructor)?\./.test(member) && (n.arguments ?? []).some((a) => np(a) || isFunctionLike(skipParens(a)))) mark("await");
        if (/^(ObjectConstructor|Reflect)\./.test(member) || /^(apply|construct|get|set|ownKeys|has|defineProperty)$/.test(member) && libFile(d.getSourceFile().fileName).includes("reflect")) {
          if ((n.arguments ?? []).some((a) => np(a))) useOf(encNode).all = true;
        }
        const ps = sig.getParameters();
        (n.arguments ?? []).forEach((a, i) => {
          const p = ps[Math.min(i, ps.length - 1)];
          if (!p || !np(a)) return;
          const pt = checker.getTypeOfSymbolAtLocation(p, n);
          const names = [pt, ...(pt.isUnion?.() ? pt.types : [])].map((u) => u.getSymbol?.()?.getName() ?? u.aliasSymbol?.getName() ?? "");
          if (!nonPrim(pt) || pt.flags & ts.TypeFlags.Any) mark("coerce");
          if (names.some((x) => /^(Iterable|AsyncIterable|IterableIterator|ArrayLike)$/.test(x))) mark("iterate");
        });
      }
    }
    // accessors: a typed receiver reaches the property it resolves to (its accessors, and a
    // subclass's same-named accessor overriding it); an untyped one, or a property its type
    // can't resolve, every scanned accessor of that name; a key it can't name, the accessors
    // of the receiver's class and its subclasses (or, untyped, every accessor)
    const untyped = (t) => !t || t.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown) || (t.flags & ts.TypeFlags.Instantiable && nonPrim(t) && !checker.getBaseConstraintOfType(t));
    const classOf = (t) => {
      const sy = t?.getSymbol?.();
      const cd = sy?.valueDeclaration ?? sy?.declarations?.[0];
      return cd && (ts.isClassDeclaration(cd) || ts.isClassExpression(cd)) && isSourceFile(cd.getSourceFile()) ? idOf(cd).fp : null;
    };
    const access = (recvT, name, sym) => {
      const u = useOf(encNode);
      if (name === null) {
        const cls = untyped(recvT) ? null : classOf(checker.getApparentType(recvT));
        if (cls) u.classes.push(cls);
        else u.all = true;
        return;
      }
      if (untyped(recvT) || !sym) return u.names.add(name);
      for (const d of sym.declarations ?? []) {
        if ((ts.isGetAccessorDeclaration(d) || ts.isSetAccessorDeclaration(d)) && isSourceFile(d.getSourceFile())) declOf(encNode).refs.add(declOf(d).fp);
        const owner = d.parent && (ts.isClassDeclaration(d.parent) || ts.isClassExpression(d.parent)) && isSourceFile(d.getSourceFile()) ? idOf(d.parent).fp : null;
        if (owner) u.members.push([owner, name]);
      }
    };
    if (ts.isPropertyAccessExpression(n)) access(checker.getTypeAtLocation(n.expression), n.name.text, checker.getSymbolAtLocation(n.name));
    if (ts.isElementAccessExpression(n)) {
      const k = keyName(n.argumentExpression);
      access(checker.getTypeAtLocation(n.expression), k, k === null ? null : checker.getSymbolAtLocation(n));
    }
    if (ts.isBindingElement(n) && ts.isObjectBindingPattern(n.parent)) {
      const pn = n.propertyName ?? n.name;
      const k = ts.isIdentifier(pn) ? pn.text : ts.isComputedPropertyName(pn) ? keyName(pn.expression) : keyName(pn);
      const src = checker.getTypeAtLocation(n.parent);
      access(src, k, k === null || untyped(src) ? null : checker.getPropertyOfType(checker.getApparentType(src), k));
      if (n.dotDotDotToken) access(src, null, null);
    }
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isObjectLiteralExpression(n.left)) {
      const src = checker.getTypeAtLocation(n.right);
      for (const pr of n.left.properties) {
        const k = ts.isShorthandPropertyAssignment(pr) ? pr.name.text : ts.isPropertyAssignment(pr) ? (ts.isIdentifier(pr.name) ? pr.name.text : ts.isComputedPropertyName(pr.name) ? keyName(pr.name.expression) : keyName(pr.name)) : null;
        access(src, k, k === null || untyped(src) ? null : checker.getPropertyOfType(checker.getApparentType(src), k));
      }
    }
    if (ts.isSpreadAssignment(n)) access(checker.getTypeAtLocation(n.expression), null, null);
  };

  // a scanned declaration a symbol's declaration stands for: a function-like
  // node, a class, or null
  const refTarget = (d) => {
    if (!isSourceFile(d.getSourceFile())) return null;
    const f = ts.isVariableDeclaration(d) && d.initializer && isFunctionLike(skipParens(d.initializer)) ? skipParens(d.initializer) : d;
    if (isFunctionLike(f) && declName(f, f.getSourceFile()) !== null) return f;
    if (ts.isClassDeclaration(f) || ts.isClassExpression(f)) return f;
    return null;
  };
  const libKeyOf = (tg, n) => {
    let member = tg.member;
    if (VIEW_CTOR.test(member) && ts.isNewExpression(n) && n.arguments?.length) {
      const k0 = kindOf(checker, checker.getTypeAtLocation(n.arguments[0]), n.arguments[0]);
      const t0 = checker.getTypeAtLocation(n.arguments[0]);
      const isBuf = [t0, ...(t0.isUnion() ? t0.types : [])].every((u) => ["ArrayBuffer", "SharedArrayBuffer", "ArrayBufferLike"].includes(u.getSymbol?.()?.getName() ?? u.aliasSymbol?.getName()));
      member += isBuf ? "(buffer)" : k0.kind === "opaque" ? "(any)" : "(source)";
    }
    return tg.lib + " :: " + member;
  };
  for (const sf of files) {
    const rel = relOf(root, sf);
    const occ = new Map();
    // every call, `new` and lib-property read gets a key, record or not, so a
    // site that turns clean (or back) keeps its key: occurrence indexes count
    // all same-text sites of the declaration
    const keyOf = (n, encNode, prefix = "") => {
      const text = norm(n, sf);
      const id = idOf(encNode);
      const base = `${rel} :: ${id.name} :: ${prefix}${text.length > 160 ? text.slice(0, 160) + "… " + sha(text).slice(0, 8) : text}`;
      const k = occ.get(base) ?? 0;
      occ.set(base, k + 1);
      return `${base} #${k}`;
    };
    let curKey = null;
    // a sink's local producer fingerprint (section 3.1, r3): its enclosing declaration
    // and every top-level declaration of this file that declaration references;
    // local and incomplete (other modules are not followed)
    const producerOf = (encNode) => {
      const parts = new Set([idOf(encNode).fp]);
      const walk = (x) => {
        if (ts.isIdentifier(x)) {
          let sy = checker.getSymbolAtLocation(x);
          if (sy && sy.flags & ts.SymbolFlags.Alias) sy = undefined;
          for (const d of sy?.declarations ?? []) {
            if (d.getSourceFile() !== sf) continue;
            let top = d;
            while (top.parent && !ts.isSourceFile(top.parent)) top = top.parent;
            if (top === encNode || (encNode.pos <= d.pos && d.end <= encNode.end)) continue;
            parts.add(sha(norm(top, sf)).slice(0, 16));
          }
        }
        ts.forEachChild(x, walk);
      };
      if (!ts.isSourceFile(encNode)) walk(encNode);
      return sha([...parts].sort().join(" ")).slice(0, 16);
    };
    const push = (n, encNode, r) => {
      records.push({ key: curKey, file: rel, line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1, decl: idOf(encNode).fp, ...r });
    };
    const typeStr = (n) => checker.typeToString(checker.getTypeAtLocation(n), undefined, ts.TypeFormatFlags.NoTruncation).slice(0, 120);
    const kindAt = (n) => {
      try {
        return kindOf(checker, checker.getTypeAtLocation(n), n);
      } catch (e) {
        return { kind: "unresolved", reason: `the checker failed: ${e.message}` };
      }
    };
    const visit = (n) => {
      const encNode = enclosing(n, sf);
      registerMember(n);
      if (ts.isClassDeclaration(n) || ts.isClassExpression(n)) {
        const id = declOf(n);
        const info = { base: null, ctor: null, methods: new Map(), node: n };
        for (const m of n.members) {
          if (ts.isConstructorDeclaration(m) && m.body) info.ctor = idOf(m).fp;
          else if (ts.isMethodDeclaration(m) && !m.body && ts.getCombinedModifierFlags(m) & ts.ModifierFlags.Abstract) info.methods.set(m.name.getText(sf), declOf(m).fp);
          else if ((ts.isMethodDeclaration(m) || ts.isGetAccessorDeclaration(m) || ts.isSetAccessorDeclaration(m)) && m.body) info.methods.set((ts.isGetAccessorDeclaration(m) ? "get " : ts.isSetAccessorDeclaration(m) ? "set " : "") + m.name.getText(sf), idOf(m).fp);
          else if (ts.isPropertyDeclaration(m) && m.initializer && isFunctionLike(m.initializer) && m.initializer.body) info.methods.set(m.name.getText(sf), idOf(m.initializer).fp);
        }
        const ext = n.heritageClauses?.find((h) => h.token === ts.SyntaxKind.ExtendsKeyword)?.types[0];
        if (ext) {
          let bs = checker.getSymbolAtLocation(ext.expression);
          if (bs && bs.flags & ts.SymbolFlags.Alias) bs = checker.getAliasedSymbol(bs);
          const bd = bs?.valueDeclaration ?? bs?.declarations?.[0];
          if (bd && (ts.isClassDeclaration(bd) || ts.isClassExpression(bd)) && isSourceFile(bd.getSourceFile())) info.base = idOf(bd).fp;
          else if (bd && libFile(bd.getSourceFile().fileName)) info.base = libFile(bd.getSourceFile().fileName) + " :: " + bs.getName() + "Constructor.new";
          else {
            info.base = "dynamic:" + ext.expression.getText(sf);
            curKey = keyOf(ext, n, "extends ");
            push(ext, n, { kind: "delegating", result: "clean", type: typeStr(ext.expression), target: { dynamic: "extends" } });
          }
        }
        classes.set(id.fp, info);
        if (info.ctor) id.refs.add(info.ctor);
        if (info.base && !info.base.startsWith("dynamic:") && !info.base.includes(" :: ")) id.refs.add(info.base);
        if (info.base && info.base.includes(" :: ")) id.libs.add(info.base);
        if (info.base && info.base.startsWith("dynamic:")) id.dynamicBase = true;
      }
      if (ts.isCallExpression(n) || ts.isNewExpression(n)) {
        calls++;
        const k = kindAt(n);
        let tg = target(checker, n, root);
        curKey = keyOf(n, encNode);
        spans.push({ key: curKey, file: rel, start: n.getStart(sf), end: n.end, kind: k.kind, skip: parityskip(checker, n) });
        // a lib call that invokes a function value: Function's call/apply, Reflect.apply/construct,
        // and a callback argument; dynamic unless that value resolves to one function (or is a
        // function expression, whose body is part of this declaration)
        if (tg.lib) {
          const member = tg.member;
          const fnOk = (e) => !e || isFunctionLike(skipParens(e)) || !!resolveFn(checker, checker.getSymbolAtLocation(skipParens(e))) || refClass(checker, skipParens(e));
          if (/^(CallableFunction|NewableFunction|Function)\.(call|apply)$/.test(member) && ts.isPropertyAccessExpression(n.expression) && !fnOk(n.expression.expression)) tg = { dynamic: "invoker" };
          else if (/^Reflect\.(apply|construct)$/.test(member) && !fnOk(n.arguments[0])) tg = { dynamic: "invoker" };
          else {
            const sig = checker.getResolvedSignature(n);
            const ps = sig?.getParameters?.() ?? [];
            const bad = (n.arguments ?? []).some((a, i) => {
              const p = ps[Math.min(i, ps.length - 1)];
              if (!p) return false;
              const pt = checker.getTypeOfSymbolAtLocation(p, n);
              const callable = pt.getCallSignatures().length > 0 || (pt.isUnion() && pt.types.some((u) => u.getCallSignatures().length > 0));
              if (!callable || ts.isSpreadElement(a)) return false;
              const at = checker.getTypeAtLocation(a);
              if (!(at.getCallSignatures().length > 0 || at.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown))) return false;
              return !fnOk(a);
            });
            if (bad) tg = { dynamic: "callback", lib: tg.lib, member: tg.member };
          }
        }
        const de = declOf(encNode);
        const cap = n.expression.kind === ts.SyntaxKind.ImportKeyword ? (isLiteralText(n.arguments[0]) ? null : "import()") : sinkCapability(checker, n.expression) ?? (ts.isCallExpression(n) && hasStringTimer(checker, n) ? "timer-text" : null);
        const calleeName = ts.isPropertyAccessExpression(n.expression) ? n.expression.name.text : ts.isIdentifier(n.expression) ? n.expression.text : null;
        const nameCap = tg.dynamic === "any-callee" && calleeName && SINK_NAMES.has(calleeName) ? "name:" + calleeName : null;
        const modCap = ts.isCallExpression(n) && n.arguments.length > 0 && isLiteralText(n.arguments[0]) && /^(node:)?vm$/.test(n.arguments[0].text) ? "module:vm" : null;
        // require() of anything but a host module loads code the census doesn't scan
        const reqCap = tg.lib && tg.member === "Require.call" && !(n.arguments.length === 1 && isLiteralText(n.arguments[0]) && HOST_MODULE.test(n.arguments[0].text)) ? "require" : null;
        const calledResult = (ts.isCallExpression(n.parent) || ts.isNewExpression(n.parent)) && n.parent.expression === n;
        let tinfo = null;
        if (tg.dynamic) tinfo = { target: tg.lib ? { dynamic: tg.dynamic, via: tg.lib + " :: " + tg.member } : { dynamic: tg.dynamic } };
        if (tg.lib && !tg.dynamic || tg.dynamic === "callback") {
          const lk = libKeyOf(tg, n);
          if (!tg.dynamic) tinfo = { target: { lib: lk } };
          de.libs.add(lk);
          let m = libs.get(lk);
          if (!m) {
            const sig = checker.getResolvedSignature(n);
            const fnParam = (sig?.getParameters?.() ?? []).some((p) => {
              const pt = checker.getTypeOfSymbolAtLocation(p, n);
              return pt.getCallSignatures().length > 0 || (pt.isUnion() && pt.types.some((u) => u.getCallSignatures().length > 0));
            });
            libs.set(lk, (m = { calls: 0, kinds: {}, fnParam }));
          }
          m.calls++;
          m.kinds[k.kind] = (m.kinds[k.kind] ?? 0) + 1;
        }
        if (!tinfo) {
          const id = idOf(tg.decl ?? tg.cls);
          tinfo = { target: { decl: id.file, name: id.name, fp: id.fp } };
        }
        const args = n.arguments ?? [];
        if (cap || nameCap || modCap || reqCap) {
          const c = cap ?? nameCap ?? modCap ?? reqCap;
          const origin = c.startsWith("vm.Script#") || c === "module:vm" || args.length === 0 ? "external" : args.every((a) => isLiteralText(a)) ? "constant" : "template";
          push(n, encNode, { kind: "code-sink", capability: c, origin, ...(origin === "constant" ? {} : { fingerprint: "local-incomplete" }), producer: producerOf(encNode), type: typeStr(n), ...tinfo });
        } else if (tg.dynamic === "Function-typed" || (tg.dynamic && calledResult)) {
          push(n, encNode, { kind: "code-sink", capability: tg.dynamic === "Function-typed" ? "Function-typed callee" : "unresolved-callee", origin: "external", fingerprint: "local-incomplete", producer: producerOf(encNode), type: typeStr(n), ...tinfo });
        } else if (tg.dynamic) {
          push(n, encNode, { kind: "delegating", result: k.kind, ...(k.store ? { store: k.store } : {}), type: typeStr(n), ...tinfo });
        } else if (k.kind !== "clean") {
          push(n, encNode, { ...k, type: typeStr(n), ...tinfo });
        } else allSites.set(curKey, "clean");
      } else if ((ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n)) && !((ts.isCallExpression(n.parent) || ts.isNewExpression(n.parent)) && n.parent.expression === n) &&
        !(ts.isBinaryExpression(n.parent) && n.parent.left === n && n.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken)) {
        // a read of a lib property whose type holds a store or is opaque (r5 2.1's
        // MessageEvent.data adoption point, and its kin)
        const s = checker.getSymbolAtLocation(n);
        const d = s?.declarations?.[0];
        if (d && libFile(d.getSourceFile().fileName) && !(s.flags & ts.SymbolFlags.Method)) {
          const k = kindAt(n);
          curKey = keyOf(n, encNode, "read ");
          if (k.kind !== "clean") {
            let p = d.parent;
            while (p && !(ts.isInterfaceDeclaration(p) || ts.isClassDeclaration(p) || ts.isTypeLiteralNode(p) || ts.isSourceFile(p))) p = p.parent;
            const owner = p && (ts.isInterfaceDeclaration(p) || ts.isClassDeclaration(p)) ? p.name.getText(p.getSourceFile()) : "<type>";
            const lk = libFile(d.getSourceFile().fileName) + " :: " + owner + "." + s.getName() + " (read)";
            push(n, encNode, { ...k, access: "property", type: typeStr(n), target: { lib: lk } });
            curKey = null;
            declOf(encNode).libs.add(lk);
            let m = libs.get(lk);
            if (!m) libs.set(lk, (m = { calls: 0, kinds: {}, fnParam: false }));
            m.calls++;
            m.kinds[k.kind] = (m.kinds[k.kind] ?? 0) + 1;
          } else allSites.set(curKey, "clean");
        }
      }
      // a sink capability as a value, not called here: an alias (`const F = Function`), an
      // argument (`Reflect.construct(Function, ...)`), an export, a receiver of call/apply/bind
      if ((ts.isIdentifier(n) || ts.isPropertyAccessExpression(n)) && !ts.isPartOfTypeNode(n) && !(ts.isPropertyAccessExpression(n.parent) && n.parent.name === n) &&
        !(ts.isDeclaration(n.parent) && n.parent.name === n) && !ts.isImportSpecifier(n.parent) && !ts.isExportSpecifier(n.parent) && !ts.isImportClause(n.parent) && !ts.isNamespaceImport(n.parent) &&
        !((ts.isCallExpression(n.parent) || ts.isNewExpression(n.parent)) && n.parent.expression === n) && !(ts.isParenthesizedExpression(n.parent))) {
        const cap = sinkCapability(checker, n);
        const reads = ts.isPropertyAccessExpression(n.parent) && n.parent.expression === n && !/^(call|apply|bind)$/.test(n.parent.name.text);
        if (cap && !reads) {
          curKey = keyOf(n, encNode, "value ");
          push(n, encNode, { kind: "code-sink", capability: cap + " (value)", origin: "external", fingerprint: "local-incomplete", producer: producerOf(encNode), type: typeStr(n), target: { dynamic: "capability-value" } });
          curKey = null;
        }
      }
      // implicit invocations (section 5; astra2 C2): an operation that runs a member no call
      // site names, when an operand isn't primitive, is an edge to every scanned member of
      // that protocol: coercion (valueOf, toString, [Symbol.toPrimitive]), iteration
      // ([Symbol.iterator], [Symbol.asyncIterator], next, return, throw), awaiting (then) and
      // JSON (toJSON); and a property read or write by name (or by a key it can't name) is
      // an edge to the scanned accessors of that name (or to every accessor) (astra2 C1)
      implicitUses(n, encNode);
      // the reference graph: every reference to a scanned declaration, called or as a
      // value; a type position runs no code, and is no edge
      if ((ts.isIdentifier(n) || ts.isPrivateIdentifier(n)) && !ts.isPartOfTypeNode(n)) {
        let s = checker.getSymbolAtLocation(n);
        if (s && s.flags & ts.SymbolFlags.Alias) s = checker.getAliasedSymbol(s);
        if (s && !(ts.isDeclaration(n.parent) && n.parent.name === n)) {
          const de = declOf(encNode);
          for (const d of s.declarations ?? []) {
            const t = refTarget(d);
            if (t) de.refs.add(declOf(t).fp);
          }
          // a const binding of a function (`const f = g`, `const {f} = ns`): its function too
          const fn = resolveFn(checker, s);
          if (fn && isSourceFile(fn.getSourceFile()) && refTarget(fn)) de.refs.add(declOf(fn).fp);
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  // overrides: calling a method may run any same-named member of a subclass
  const subclasses = new Map();
  for (const [fp, c] of classes) if (c.base && classes.has(c.base)) (subclasses.get(c.base) ?? subclasses.set(c.base, []).get(c.base)).push(fp);
  const descendants = (fp, out = []) => {
    for (const s of subclasses.get(fp) ?? []) if (!out.includes(s)) (out.push(s), descendants(s, out));
    return out;
  };
  for (const [fp, c] of classes) {
    const ds = descendants(fp);
    for (const [name, mfp] of c.methods) for (const d of ds) {
      const o = classes.get(d).methods.get(name);
      if (o && decls.has(mfp)) decls.get(mfp).refs.add(o);
      else if (o) declOf(c.node).refs.add(o);
    }
  }
  for (const r of records) allSites.set(r.key, r.kind);
  // the implicit-invocation and accessor edges (every member and class is known now)
  const ancestors = (cfp) => {
    const out = [];
    for (let b = classes.get(cfp)?.base; b && classes.has(b) && !out.includes(b); b = classes.get(b).base) out.push(b);
    return out;
  };
  const accessorsOf = (cfp) => [...(classes.get(cfp)?.methods ?? [])].filter(([k]) => /^(get|set) /.test(k)).map(([, v]) => v);
  for (const [fp, u] of uses) {
    const d = decls.get(fp);
    for (const k of u.kinds) for (const t of protocol[k]) d.irefs.add(t);
    if (u.all) for (const t of allAccessors) d.irefs.add(t);
    for (const nm of u.names) for (const t of [...(accessorsByName.get(nm) ?? []), ...unknownAccessors]) d.irefs.add(t);
    // an unknown key on a class receiver: every class whose instance it can be, and whose
    // accessors it inherits: the ancestors, the class, its descendants (astra2 C1b)
    for (const cfp of u.classes) for (const c of [...ancestors(cfp), cfp, ...descendants(cfp)]) for (const t of accessorsOf(c)) d.irefs.add(t);
    for (const [cfp, nm] of u.members) for (const c of descendants(cfp)) for (const pre of ["get ", "set "]) {
      const t = classes.get(c)?.methods.get(pre + nm);
      if (t) d.irefs.add(t);
    }
  }
  records.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const byKind = {};
  for (const r of records) {
    const k = r.access ? r.kind + " (read)" : r.kind;
    byKind[k] = (byKind[k] ?? 0) + 1;
  }
  const header = {
    commit,
    script_sha256: sha(readFileSync(fileURLToPath(import.meta.url))),
    ts_api: ts.version,
    files: files.length,
    dirs: [...new Set(files.map((s) => relOf(root, s).split("/")[0]))].sort(),
    calls,
    obligations: obligations.length,
    records: records.length,
    by_kind: Object.fromEntries(Object.entries(byKind).sort()),
    generated,
  };
  const programFiles = program.getSourceFiles().filter((s) => !s.fileName.includes(`${sep}node_modules${sep}`)).map((s) => relOf(root, s));
  return { header, records, decls, libs, classes, allSites, spans, programFiles, protocol, accessors: allAccessors, accessorsByName, unknownAccessors, obligations, files: files.map((s) => relOf(root, s)) };
}

// the declaration a site belongs to: the nearest named function-like ancestor,
// the class whose body holds it (field initializers), else the module
function enclosing(n, sf) {
  for (let p = n.parent; p; p = p.parent) {
    if (isFunctionLike(p) && declName(p, sf) !== null) return p;
    if (ts.isClassDeclaration(p) || ts.isClassExpression(p)) return p;
  }
  return sf;
}

// the census as its committed JSON text: the header, then one record per line
export function censusText(c) {
  return `{"header": ${JSON.stringify(c.header)},\n"records": [\n${c.records.map((r) => JSON.stringify(r)).join(",\n")}\n]}\n`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const i = process.argv.indexOf("--root");
  const root = i > 0 ? process.argv[i + 1] : ROOT;
  const t0 = Date.now();
  const j = process.argv.indexOf("--commit");
  const c = census(root, { commit: j > 0 ? process.argv[j + 1] : null });
  if (process.argv.includes("--json")) process.stdout.write(censusText(c));
  else {
    console.log(JSON.stringify(c.header));
    const by = (f) => Object.fromEntries([...c.records.reduce((m, s) => m.set(f(s), (m.get(f(s)) ?? 0) + 1), new Map())].sort((a, b) => b[1] - a[1]).slice(0, 25));
    console.log("delegating by target:", by((r) => (r.kind === "delegating" ? r.target.dynamic : "-")));
    console.log("sinks:", c.records.filter((r) => r.kind === "code-sink").map((r) => `${r.file}:${r.line} ${r.capability} ${r.origin}`));
    if (process.argv.includes("--libs")) for (const [k, v] of [...c.libs].sort()) console.log("LIB", k, JSON.stringify(v));
    console.log("classes", c.classes.size, "protocol members", Object.values(c.protocol).reduce((n, x) => n + x.size, 0), "accessors", c.accessors.size);
    console.log(`${c.decls.size} declarations; ${Date.now() - t0} ms; ${Math.round(process.memoryUsage().rss / 1e6)} MB`);
  }
}
