// Dump our AST as canonical JSON (same encoding as test/pydump.py), one
// line per input file: {file, ok, sha, ms} or {file, ok:false, error}.
//   node dist/test/dump.js [--full] FILE...   (or file names on stdin)
import { readFileSync } from "fs";
import { createHash } from "crypto";
import { parse, PegenError } from "../src/index";
import { FIELDS, ATTRIBUTES } from "../src/ast.gen";
import { PySingleton } from "../src/helpers";
import { PyComplex } from "../src/pegen";

function floatHex(x: number): string {
  const dv = new DataView(new ArrayBuffer(8));
  dv.setFloat64(0, x);
  return dv.getBigUint64(0).toString(16).padStart(16, "0");
}

/** A Constant's value (or MatchSingleton's): type-tagged. */
function constValue(v: any): any {
  if (typeof v === "number") return { float: floatHex(v) };
  if (v instanceof PySingleton && v.name === "None") return null;
  return canon(v);
}

export function canon(v: any): any {
  if (v === null || v === undefined) return null;
  if (typeof v === "boolean" || typeof v === "string") return v;
  if (typeof v === "number") return v;
  if (typeof v === "bigint") return { int: v.toString() };
  if (v instanceof PyComplex) return { complex: floatHex(v.imag) };
  if (v instanceof PySingleton) return { $: v.name };
  if (v instanceof Uint8Array) return { bytes: Buffer.from(v).toString("hex") };
  if (Array.isArray(v)) return v.map(canon);
  if (typeof v === "object" && typeof v._type === "string") {
    const t = v._type;
    if ((FIELDS[t] ?? []).length === 0 && (ATTRIBUTES[t] ?? []).length === 0) return t;
    const o: any = { _type: t };
    for (const f of FIELDS[t]) o[f] = f === "value" && (t === "Constant" || t === "MatchSingleton") ? constValue(v[f]) : canon(v[f]);
    for (const a of ATTRIBUTES[t]) o[a] = canon(v[a]);
    return o;
  }
  throw new Error("cannot dump " + String(v));
}

function sorted(v: any): any {
  if (Array.isArray(v)) return v.map(sorted);
  if (v && typeof v === "object") {
    const o: any = {};
    for (const k of Object.keys(v).sort()) o[k] = sorted(v[k]);
    return o;
  }
  return v;
}

export function canonicalJSON(v: any): string {
  return JSON.stringify(sorted(v)).replace(/[\u007f-￿]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
}

function main() {
  const args = process.argv.slice(2);
  const full = args[0] === "--full";
  if (full) args.shift();
  const files = args.length ? args : readFileSync(0, "utf8").split("\n").filter(Boolean);
  for (const file of files) {
    let src: string;
    try {
      src = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const t0 = performance.now();
    try {
      const tree = parse(src);
      const ms = performance.now() - t0;
      const js = canonicalJSON(canon(tree));
      const out: any = { file, ok: true, sha: createHash("sha1").update(js).digest("hex"), ms };
      if (full) out.json = js;
      console.log(JSON.stringify(out));
    } catch (e) {
      if (e instanceof PegenError) {
        const i = e.info;
        console.log(JSON.stringify({ file, ok: false, error: [i.type, i.msg, i.lineno, i.offset, i.end_lineno, i.end_offset] }));
      } else {
        console.log(JSON.stringify({ file, ok: false, crash: String((e as Error).stack ?? e).slice(0, 600) }));
      }
    }
  }
}

if (require.main === module) main();
