import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

// The install matrix (astra2 R1/R2, round 3): every way a value becomes a property,
// crossed with every kind of value.  Each case is checked against the registration it
// makes, so cases can share a fixture without masking each other:
//   fn        the function is registered as the member (or accessor)
//   oblig     an obligation at that line (the value may be callable and can't be resolved)
//   both      the function, and an obligation (a conditional of a function and an any)
//   none      nothing (provably not callable)
const ROOT = join(__dirname, "..", "..");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const S = require(join(ROOT, "scripts/arraybuffer-sites.mjs"));

function census(files: Record<string, string>): any {
  const dir = mkdtempSync(join(tmpdir(), "ab-installs-"));
  try {
    const opts = JSON.parse(readFileSync(join(ROOT, "tsconfig.json"), "utf8")).compilerOptions;
    writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: opts, include: ["src/**/*.ts", "web/**/*.ts"] }));
    symlinkSync(join(ROOT, "node_modules"), join(dir, "node_modules"));
    for (const [p, text] of Object.entries({ "web/worker.ts": "export {};\n", ...files })) {
      mkdirSync(dirname(join(dir, p)), { recursive: true });
      writeFileSync(join(dir, p), text);
    }
    return S.census(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// the value kinds: [name, expression (in a case function: o any, k string, g G, a any, u unknown,
// s {a: number}, c boolean), the expectation]
export const KINDS: [string, string, string][] = [
  ["function expression", "() => 1", "fn"],
  ["named function", "NAMED", "fn"],
  ["const alias of a function", "ALIAS", "fn"],
  ["generic T", "g", "oblig"],
  ["any", "a", "oblig"],
  ["unknown", "u", "oblig"],
  ["structural {a: number}", "s", "oblig"],
  ["object literal", "{ a: 1 }", "none"],
  ["number", "1", "none"],
  ["a new instance of a scanned class", "new Plain()", "none"],
  ["a function or an any", "c ? NAMED : a", "both"],
];
// the protocol installs (the property is toJSON): [path, template with V]
export const PATHS: [string, string][] = [
  ["assignment o.toJSON = V", "o.toJSON = V;"],
  ["assignment o[\"toJSON\"] = V", "o[\"toJSON\"] = V;"],
  ["assignment under a string key o[k] = V", "o[k] = V;"],
  ["o.toJSON ??= V", "o.toJSON ??= V;"],
  ["o.toJSON ||= V", "o.toJSON ||= V;"],
  ["o.toJSON &&= V", "o.toJSON &&= V;"],
  ["object-literal property", "return { toJSON: V };"],
  ["object-literal computed property", "return { [\"toJSON\"]: V };"],
  ["object-literal shorthand (const toJSON = V)", "const toJSON = V; return { toJSON };"],
  ["Object.defineProperty value", "Object.defineProperty(o, \"toJSON\", { value: V });"],
  ["Reflect.defineProperty value", "Reflect.defineProperty(o, \"toJSON\", { value: V });"],
  ["Object.defineProperties value", "Object.defineProperties(o, { toJSON: { value: V } });"],
  ["Object.create descriptor value", "return Object.create(null, { toJSON: { value: V } });"],
  ["Reflect.set", "Reflect.set(o, \"toJSON\", V);"],
  ["Object.assign from a literal", "Object.assign(o, { toJSON: V });"],
  ["spread of a literal", "return { ...{ toJSON: V } };"],
  ["class field", "class Cls_ID { toJSON = V; } return Cls_ID;"],
  ["static class field", "class Cls_ID { static toJSON = V; } return Cls_ID;"],
];
// the accessor installs (the property is bytes): [path, template with V, accessor name or "*"]
export const ACCESSOR_PATHS: [string, string, string][] = [
  ["Object.defineProperty get", "Object.defineProperty(o, \"bytes\", { get: V });", "bytes"],
  ["Object.defineProperty set", "Object.defineProperty(o, \"bytes\", { set: V });", "bytes"],
  ["Reflect.defineProperty get", "Reflect.defineProperty(o, \"bytes\", { get: V });", "bytes"],
  ["Object.defineProperties get", "Object.defineProperties(o, { bytes: { get: V } });", "bytes"],
  ["Object.create descriptor set", "return Object.create(null, { bytes: { set: V } });", "bytes"],
  ["a Proxy's get trap", "return new Proxy({}, { get: V });", "*"],
];
// installs whose value the census can't see: always an obligation
export const UNKNOWN_PATHS: [string, string, boolean][] = [
  ["a destructuring target", "({ x: o.toJSON } = a);", false],
  ["an array-destructuring target", "[o.toJSON] = a;", false],
  ["a for-of target", "for (o.toJSON of a) { break; }", false],
  ["a spread of an any", "return { ...a };", false],
  ["Object.assign from an any", "Object.assign(o, a);", false],
  ["a descriptor the census can't read", "Object.defineProperty(o, \"toJSON\", a);", true],
  ["a Proxy with an unknown handler", "return new Proxy({}, a);", true],
  ["defineProperties with an unknown map", "Object.defineProperties(o, a);", true],
];

const HEAD = `export class Plain { a = 1; }
export function named_fn(): number { return 1; }
export function named_target(): number { return 1; }
const alias_fn = named_target;
`;
const SIG = "<G>(o: any, k: string, g: G, a: any, u: unknown, s: { a: number }, c: boolean): any";

// each case gets its own named function and alias target, so no case's registration can stand
// in for another's
function build(rows: [string, string][]) {
  const cases: { id: string; line: number }[] = [];
  let text = HEAD;
  rows.forEach(([id, body]) => {
    text += `export function named_${id}(): number { return 1; }\nexport function target_${id}(): number { return 1; }\nconst alias_${id} = target_${id};\n`;
    const line = text.split("\n").length;
    text += `export function ${id}${SIG} { ${body.replace(/NAMED/g, `named_${id}`).replace(/ALIAS/g, `alias_${id}`)} }\n`;
    cases.push({ id, line });
  });
  return { text, cases };
}

test("the install matrix: every protocol install path x every value kind", () => {
  const rows: [string, string][] = [];
  const meta: Record<string, [string, string, string]> = {};
  PATHS.forEach(([path, tpl], i) => KINDS.forEach(([kind, v, want], j) => {
    const id = `case_${i}_${j}`;
    rows.push([id, tpl.replace(/V/g, v).replace(/Cls_ID/g, `Cls_${i}_${j}`)]);
    meta[id] = [path, kind, want];
  }));
  // (each shorthand case in a file of its own: they all declare a const toJSON)
  const shorthand = (id: string) => meta[id][0].startsWith("object-literal shorthand");
  const main = build(rows.filter(([id]) => !shorthand(id)));
  const files: Record<string, string> = { "src/runtime/m.ts": main.text };
  const fileOf: Record<string, string> = {};
  const cases = main.cases.map((x) => ((fileOf[x.id] = "src/runtime/m.ts"), x));
  for (const r of rows.filter(([id]) => shorthand(id))) {
    const b = build([r]);
    files[`src/runtime/${r[0]}.ts`] = b.text;
    fileOf[r[0]] = `src/runtime/${r[0]}.ts`;
    cases.push(b.cases[0]);
  }
  const c = census(files);
  const json = [...c.protocol.json].map((fp: string) => c.decls.get(fp)?.name ?? fp);
  const jsonIn = (file: string) => [...c.protocol.json].map((fp: string) => c.decls.get(fp)).filter((d: any) => d && d.file === file).map((d: any) => d.name);
  const bad: string[] = [];
  for (const { id, line } of cases) {
    const [path, kind, want] = meta[id];
    const [i, j] = id.slice(5).split("_");
    const obl = c.obligations.some((o: any) => o.file === fileOf[id] && o.line === line && o.kinds.includes("json"));
    // (a function expression's member is its own declaration if it has a name: a class field's,
    // or the shorthand's const toJSON; else the case function its body belongs to)
    const fnTargets = kind === "named function" || kind === "a function or an any" ? [`named_${id}`] : kind === "const alias of a function" ? [`target_${id}`] : path.startsWith("object-literal shorthand") ? ["toJSON"] : [id, `Cls_${i}_${j}.toJSON`];
    const fn = fnTargets.some((t) => (shorthand(id) ? jsonIn(fileOf[id]) : json).includes(t));
    const got = obl && fn ? "both" : obl ? "oblig" : fn ? "fn" : "none";
    // a function registered elsewhere (named_fn by another case) can't tell this case apart: check only its own target for fn kinds
    const ok = want === "fn" ? fn && !obl : want === "both" ? fn && obl : want === "oblig" ? obl && !fn : !obl && !fn;
    if (!ok) bad.push(`${path} x ${kind}: want ${want}, got ${got}`);
  }
  assert.deepEqual(bad, []);
});

test("the install matrix: every accessor install path x every value kind", () => {
  const rows: [string, string][] = [];
  const meta: Record<string, [string, string, string, string]> = {};
  ACCESSOR_PATHS.forEach(([path, tpl, name], i) => KINDS.forEach(([kind, v, want], j) => {
    const id = `acc_${i}_${j}`;
    rows.push([id, tpl.replace(/V/g, v)]);
    meta[id] = [path, kind, want, name];
  }));
  const { text, cases } = build(rows);
  const c = census({ "src/runtime/a.ts": text });
  const names = (set: Set<string>) => [...set].map((fp) => c.decls.get(fp)?.name ?? fp);
  const bad: string[] = [];
  for (const { id, line } of cases) {
    const [path, kind, want, name] = meta[id];
    const reg = names(name === "*" ? c.unknownAccessors : c.accessorsByName.get(name) ?? new Set());
    const obl = c.obligations.some((o: any) => o.line === line && o.accessor === name);
    const fnTargets = kind === "named function" || kind === "a function or an any" ? [`named_${id}`] : kind === "const alias of a function" ? [`target_${id}`] : [id];
    const fn = fnTargets.some((t) => reg.includes(t));
    const ok = want === "fn" ? fn && !obl : want === "both" ? fn && obl : want === "oblig" ? obl && !fn : !obl && !fn;
    if (!ok) bad.push(`${path} x ${kind}: want ${want}, got ${obl && fn ? "both" : obl ? "oblig" : fn ? "fn" : "none"}`);
  }
  assert.deepEqual(bad, []);
});

test("the install matrix: installs whose value the census can't see are obligations", () => {
  const { text, cases } = build(UNKNOWN_PATHS.map(([, body], i) => [`unk_${i}`, body]));
  const c = census({ "src/runtime/u.ts": text });
  const bad: string[] = [];
  cases.forEach(({ line }, i) => {
    const [path, , accessorToo] = UNKNOWN_PATHS[i];
    const here = c.obligations.filter((o: any) => o.line === line);
    if (!here.some((o: any) => o.kinds.includes("json"))) bad.push(`${path}: no protocol obligation`);
    if (accessorToo && !here.some((o: any) => o.accessor)) bad.push(`${path}: no accessor obligation`);
  });
  assert.deepEqual(bad, []);
});

test("the install matrix: exports are properties of the module's namespace", () => {
  const files: Record<string, string> = {};
  const want: Record<string, string> = {};
  const decl = "export class Plain { a = 1; }\nexport function named_fn(): number { return 1; }\nexport function named_target(): number { return 1; }\nconst alias_fn = named_target;\ndeclare const a: any;\ndeclare const u: unknown;\ndeclare const s: { a: number };\ndeclare const c: boolean;\n";
  KINDS.filter(([kind]) => kind !== "generic T").forEach(([kind, v0, w], j) => {
    const v = v0.replace(/NAMED/g, "named_fn").replace(/ALIAS/g, "alias_fn");
    files[`src/runtime/e${j}.ts`] = `${decl}export const toJSON = ${v};\n`;
    files[`src/runtime/x${j}.ts`] = `${decl}const local = ${v};\nexport { local as toJSON };\n`;
    want[`e${j}`] = `${kind} ${w}`;
    want[`x${j}`] = `${kind} ${w}`;
  });
  files["src/runtime/fd.ts"] = "export function toJSON(): any { return 1; }\n";
  want["fd"] = "an exported function declaration fn";
  const c = census(files);
  const bad: string[] = [];
  for (const [f, kw] of Object.entries(want)) {
    const w = kw.split(" ").pop()!;
    const file = `src/runtime/${f}.ts`;
    const obl = c.obligations.some((o: any) => o.file === file && o.kinds.includes("json"));
    const fn = [...c.protocol.json].some((fp: any) => { const d = c.decls.get(fp); return d && !d.obligation && d.file === file; });
    const ok = w === "fn" ? fn && !obl : w === "both" ? fn && obl : w === "oblig" ? obl && !fn : !obl && !fn;
    if (!ok) bad.push(`${f} (${kw}): obligation ${obl}, function ${fn}`);
  }
  assert.deepEqual(bad, []);
});
