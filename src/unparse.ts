// An expression of pyparse's AST (CPython's ast) as text, as CPython 3.14's
// Python/ast_unparse.c writes it: the strings `from __future__ import
// annotations` makes of annotations. Its precedence levels, parentheses
// only where a level needs them, and its spelling of each node; a node it
// does not write here (a t-string) refused.

import { PySingleton } from "../pyparse/src/helpers";
import { PyComplex } from "../pyparse/src/pegen";
import { strRepr, floatRepr, bytesRepr } from "./runtime/format";

// (CPython's enum: PR_BOR is PR_EXPR)
const PR_TUPLE = 0, PR_TEST = 1, PR_OR = 2, PR_AND = 3, PR_NOT = 4, PR_CMP = 5, PR_EXPR = 6, PR_BOR = 6, PR_BXOR = 7, PR_BAND = 8, PR_SHIFT = 9, PR_ARITH = 10, PR_TERM = 11, PR_FACTOR = 12, PR_POWER = 13, PR_AWAIT = 14, PR_ATOM = 15;

const BINOP: Record<string, [string, number]> = {
  Add: [" + ", PR_ARITH], Sub: [" - ", PR_ARITH], Mult: [" * ", PR_TERM], MatMult: [" @ ", PR_TERM], Div: [" / ", PR_TERM], Mod: [" % ", PR_TERM],
  LShift: [" << ", PR_SHIFT], RShift: [" >> ", PR_SHIFT], BitOr: [" | ", PR_BOR], BitXor: [" ^ ", PR_BXOR], BitAnd: [" & ", PR_BAND],
  FloorDiv: [" // ", PR_TERM], Pow: [" ** ", PR_POWER],
};
const UNOP: Record<string, [string, number]> = { Invert: ["~", PR_FACTOR], Not: ["not ", PR_NOT], UAdd: ["+", PR_FACTOR], USub: ["-", PR_FACTOR] };
const CMPOP: Record<string, string> = { Eq: " == ", NotEq: " != ", Lt: " < ", LtE: " <= ", Gt: " > ", GtE: " >= ", Is: " is ", IsNot: " is not ", In: " in ", NotIn: " not in " };

export class UnparseUnsupported extends Error {}

// (a float as ast_unparse writes it: its repr, an infinity 1e309)
const INF = "1e309";
function floatText(x: number): string {
  if (x === Infinity) return INF;
  if (x === -Infinity) return "-" + INF;
  return floatRepr(x);
}

// (pyparse's constants: an int a bigint, a float a number)
function constant(v: any): string {
  if (v === null || v === undefined) return "None";
  if (v instanceof PySingleton) return v.name === "Ellipsis" ? "..." : "None";
  if (typeof v === "boolean") return v ? "True" : "False";
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "number") return floatText(v);
  if (v instanceof PyComplex) {
    const im = (v as any).imag;
    return (im === Infinity ? INF : floatRepr(im).replace(/\.0$/, "")) + "j";
  }
  if (typeof v === "string") return strRepr(v);
  if (v instanceof Uint8Array) return bytesRepr(v);
  throw new UnparseUnsupported("an unknown constant");
}

export function unparse(e: any, level = PR_TEST): string {
  switch (e._type) {
    case "BoolOp": {
      const [op, pr] = e.op._type === "And" ? [" and ", PR_AND] : [" or ", PR_OR];
      const s = e.values.map((v: any) => unparse(v, pr + 1)).join(op);
      return level > pr ? `(${s})` : s;
    }
    case "BinOp": {
      const [op, pr] = BINOP[e.op._type];
      const rassoc = e.op._type === "Pow" ? 1 : 0;
      const s = unparse(e.left, pr + rassoc) + op + unparse(e.right, pr + 1 - rassoc);
      return level > pr ? `(${s})` : s;
    }
    case "UnaryOp": {
      const [op, pr] = UNOP[e.op._type];
      const s = op + unparse(e.operand, pr);
      return level > pr ? `(${s})` : s;
    }
    case "Lambda": {
      const a = args(e.args);
      // (CPython's: a space after `lambda` only before a positional parameter, so `lambda*, k: k`)
      const sp = e.args.posonlyargs.length + e.args.args.length ? " " : "";
      const s = `lambda${sp}${a}: ${unparse(e.body, PR_TEST)}`;
      return level > PR_TEST ? `(${s})` : s;
    }
    case "IfExp": {
      const s = `${unparse(e.body, PR_TEST + 1)} if ${unparse(e.test, PR_TEST + 1)} else ${unparse(e.orelse, PR_TEST)}`;
      return level > PR_TEST ? `(${s})` : s;
    }
    case "Dict":
      return `{${e.keys.map((k: any, i: number) => (k === null || k === undefined ? `**${unparse(e.values[i], PR_EXPR)}` : `${unparse(k, PR_TEST)}: ${unparse(e.values[i], PR_TEST)}`)).join(", ")}}`;
    case "Set":
      return e.elts.length ? `{${e.elts.map((x: any) => unparse(x, PR_TEST)).join(", ")}}` : "{*()}";
    case "ListComp":
      return `[${unparse(e.elt, PR_TEST)}${comps(e.generators)}]`;
    case "SetComp":
      return `{${unparse(e.elt, PR_TEST)}${comps(e.generators)}}`;
    case "DictComp":
      return `{${unparse(e.key, PR_TEST)}: ${unparse(e.value, PR_TEST)}${comps(e.generators)}}`;
    case "GeneratorExp":
      return `(${unparse(e.elt, PR_TEST)}${comps(e.generators)})`;
    case "Await": {
      const s = `await ${unparse(e.value, PR_ATOM)}`;
      return level > PR_AWAIT ? `(${s})` : s;
    }
    case "Yield":
      return e.value ? `(yield ${unparse(e.value, PR_TEST)})` : "(yield)";
    case "YieldFrom":
      return `(yield from ${unparse(e.value, PR_TEST)})`;
    case "NamedExpr": {
      const s = `${unparse(e.target, PR_ATOM)} := ${unparse(e.value, PR_ATOM)}`;
      return level > PR_TUPLE ? `(${s})` : s;
    }
    case "Compare": {
      let s = unparse(e.left, PR_CMP + 1);
      e.ops.forEach((op: any, i: number) => (s += CMPOP[op._type] + unparse(e.comparators[i], PR_CMP + 1)));
      return level > PR_CMP ? `(${s})` : s;
    }
    case "Call": {
      let s = unparse(e.func, PR_ATOM);
      // (a lone generator expression argument without parentheses of its own)
      if (e.args.length === 1 && e.keywords.length === 0 && e.args[0]._type === "GeneratorExp") return s + unparse(e.args[0], PR_TEST);
      const parts = e.args.map((x: any) => unparse(x, PR_TEST));
      for (const k of e.keywords) parts.push(k.arg === null || k.arg === undefined ? `**${unparse(k.value, PR_TEST)}` : `${k.arg}=${unparse(k.value, PR_TEST)}`);
      return `${s}(${parts.join(", ")})`;
    }
    case "Constant":
      // (a u-prefixed str keeps its prefix, as CPython's append_ast_constant)
      return (e.kind === "u" ? "u" : "") + constant(e.value);
    case "JoinedStr":
      return "f" + strRepr(fbody(e.values));
    case "Attribute": {
      const v = unparse(e.value, PR_ATOM);
      // (an int literal's attribute: "1 .real")
      const intLit = e.value._type === "Constant" && typeof e.value.value === "bigint";
      return `${v}${intLit ? " ." : "."}${e.attr}`;
    }
    case "Subscript": {
      const sl = e.slice;
      const inner = sl._type === "Tuple" && sl.elts.length ? sl.elts.map((x: any) => unparse(x, PR_TEST)).join(", ") + (sl.elts.length === 1 ? "," : "") : unparse(sl, PR_TUPLE);
      return `${unparse(e.value, PR_ATOM)}[${inner}]`;
    }
    case "Starred":
      return `*${unparse(e.value, PR_EXPR)}`;
    case "Name":
      return e.id;
    case "List":
      return `[${e.elts.map((x: any) => unparse(x, PR_TEST)).join(", ")}]`;
    case "Tuple": {
      if (e.elts.length === 0) return "()";
      const s = e.elts.map((x: any) => unparse(x, PR_TEST)).join(", ") + (e.elts.length === 1 ? "," : "");
      return level > PR_TUPLE ? `(${s})` : s;
    }
    case "Slice": {
      let s = "";
      if (e.lower) s += unparse(e.lower, PR_TEST);
      s += ":";
      if (e.upper) s += unparse(e.upper, PR_TEST);
      if (e.step) s += ":" + unparse(e.step, PR_TEST);
      return s;
    }
    default:
      throw new UnparseUnsupported(e._type);
  }
}

function comps(gens: any[]): string {
  return gens
    .map((g: any) => `${g.is_async ? " async for " : " for "}${unparse(g.target, PR_TUPLE)} in ${unparse(g.iter, PR_TEST + 1)}${g.ifs.map((c: any) => ` if ${unparse(c, PR_TEST + 1)}`).join("")}`)
    .join("");
}

function args(a: any): string {
  const out: string[] = [];
  const pos = [...a.posonlyargs, ...a.args];
  const nd = a.defaults.length, first = pos.length - nd;
  pos.forEach((p: any, i: number) => {
    out.push(i >= first ? `${p.arg}=${unparse(a.defaults[i - first], PR_TEST)}` : p.arg);
    if (a.posonlyargs.length && i === a.posonlyargs.length - 1) out.push("/");
  });
  if (a.vararg) out.push(`*${a.vararg.arg}`);
  else if (a.kwonlyargs.length) out.push("*");
  a.kwonlyargs.forEach((p: any, i: number) => {
    const d = a.kw_defaults[i];
    out.push(d ? `${p.arg}=${unparse(d, PR_TEST)}` : p.arg);
  });
  if (a.kwarg) out.push(`**${a.kwarg.arg}`);
  return out.join(", ");
}

// (an f-string's body, its braces doubled in literal parts; each field's
// expression after a space when it starts with a brace)
function fbody(values: any[]): string {
  let s = "";
  for (const v of values) {
    if (v._type === "Constant") s += String(v.value).replace(/\{/g, "{{").replace(/\}/g, "}}");
    else if (v._type === "FormattedValue") {
      let x = unparse(v.value, PR_TEST + 1);
      if (x.startsWith("{")) x = " " + x;
      s += "{" + x;
      if (v.conversion !== undefined && v.conversion !== null && v.conversion >= 0) s += "!" + String.fromCharCode(v.conversion);
      if (v.format_spec) s += ":" + fbody(v.format_spec.values);
      s += "}";
    } else throw new UnparseUnsupported(v._type);
  }
  return s;
}
