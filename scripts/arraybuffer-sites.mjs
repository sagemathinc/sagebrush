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
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, sep } from "node:path";
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

export function census(root = ROOT, { commit = null } = {}) {
  const cfg = ts.getParsedCommandLineOfConfigFile(join(root, "tsconfig.json"), {}, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (d) => { throw new Error(ts.flattenDiagnosticMessageText(d.messageText, "\n")); },
  });
  // the roots: src/runtime/** and the worker; plus every scanned-repository module a
  // constant relative require() names (its code runs too), to a fixpoint
  const rootNames = [...cfg.fileNames.filter((f) => f.includes(`${sep}src${sep}runtime${sep}`)), join(root, "web", "worker.ts")];
  let program;
  for (;;) {
    program = ts.createProgram({ rootNames, options: { ...cfg.options, noEmit: true, allowJs: true } });
    const more = [];
    for (const sf of program.getSourceFiles().filter(isSourceFile)) {
      const scan = (n) => {
        if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "require" && n.arguments.length === 1 && isLiteralText(n.arguments[0]) && n.arguments[0].text.startsWith(".")) {
          const base = join(dirname(sf.fileName), n.arguments[0].text);
          const f = [base, base + ".ts", base + ".js", join(base, "index.ts")].find((x) => ts.sys.fileExists(x) && !ts.sys.directoryExists(x));
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
  const registerMember = (n) => {
    if (!isFunctionLike(n) || !n.name) return;
    const sf = n.getSourceFile();
    const name = ts.isComputedPropertyName(n.name) ? "[" + n.name.expression.getText(sf) + "]" : n.name.getText(sf);
    if (ts.isGetAccessorDeclaration(n) || ts.isSetAccessorDeclaration(n)) {
      const fp = declOf(n).fp;
      (accessorsByName.get(name) ?? accessorsByName.set(name, new Set()).get(name)).add(fp);
      allAccessors.add(fp);
      return;
    }
    if (!ts.isMethodDeclaration(n) && !ts.isFunctionExpression(n) && !ts.isArrowFunction(n)) return;
    for (const [k, re] of Object.entries(PROTOCOL)) if (re.test(name)) protocol[k].add(declOf(n).fp);
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
  const accessorsOf = (cfp) => [...(classes.get(cfp)?.methods ?? [])].filter(([k]) => /^(get|set) /.test(k)).map(([, v]) => v);
  for (const [fp, u] of uses) {
    const d = decls.get(fp);
    for (const k of u.kinds) for (const t of protocol[k]) d.irefs.add(t);
    if (u.all) for (const t of allAccessors) d.irefs.add(t);
    for (const nm of u.names) for (const t of accessorsByName.get(nm) ?? []) d.irefs.add(t);
    for (const cfp of u.classes) for (const c of [cfp, ...descendants(cfp)]) for (const t of accessorsOf(c)) d.irefs.add(t);
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
    records: records.length,
    by_kind: Object.fromEntries(Object.entries(byKind).sort()),
  };
  const programFiles = program.getSourceFiles().filter((s) => !s.fileName.includes(`${sep}node_modules${sep}`)).map((s) => relOf(root, s));
  return { header, records, decls, libs, classes, allSites, spans, programFiles, protocol, accessors: allAccessors, files: files.map((s) => relOf(root, s)) };
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
