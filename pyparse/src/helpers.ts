// Grammar action helpers: a port of CPython 3.14's Parser/action_helpers.c and
// Parser/string_parser.c.  Names match the C ones so that the grammar's
// actions (translated mechanically by gen/build.py) call them unchanged.

import * as T from "./tokens.gen";
import * as AST from "./ast.gen";
import {
  BaseParser, Token, PyComplex, RAISE_ERROR_KNOWN_LOCATION, RAISE_SYNTAX_ERROR, RAISE_SYNTAX_ERROR_KNOWN_LOCATION,
  RAISE_SYNTAX_ERROR_KNOWN_RANGE, RAISE_SYNTAX_ERROR_STARTING_FROM, RAISE_INDENTATION_ERROR,
  RAISE_SYNTAX_ERROR_ON_NEXT_TOKEN,
} from "./pegen";

export {
  RAISE_ERROR_KNOWN_LOCATION, RAISE_SYNTAX_ERROR, RAISE_SYNTAX_ERROR_KNOWN_LOCATION, RAISE_SYNTAX_ERROR_KNOWN_RANGE,
  RAISE_SYNTAX_ERROR_STARTING_FROM, RAISE_INDENTATION_ERROR, RAISE_SYNTAX_ERROR_ON_NEXT_TOKEN,
};

type P = BaseParser;
type Seq = any[] | null;

// ---- Python constants

export class PySingleton {
  constructor(public name: string) {}
}
export const Py_None = new PySingleton("None");
export const Py_True = true;
export const Py_False = false;
export const Py_Ellipsis = new PySingleton("Ellipsis");
export const PyExc_SyntaxError = "SyntaxError";

export const STAR_TARGETS = 0, DEL_TARGETS = 1, FOR_TARGETS = 2;

// ---- macros

export const CHECK = (_p: P, x: any) => x;
export const CHECK_NULL_ALLOWED = (_p: P, x: any) => x;
export function CHECK_VERSION(p: P, version: number, msg: string, node: any): any {
  if (p.feature_version < version) RAISE_SYNTAX_ERROR(p, "%s only supported in Python 3.%i and greater", msg, version);
  return node;
}
export const NEW_TYPE_COMMENT = (_p: P, _tc: any) => null; // type comments are not supported
export const PyBytes_AS_STRING = (s: string) => s;
export const asdl_seq_LEN = (s: Seq) => (s ? s.length : 0);
export const asdl_seq_GET = (s: any[], i: number) => s[i];
export const PyPegen_first_item = (s: any[]) => s[0];
export const PyPegen_last_item = (s: any[]) => s[s.length - 1];

// ---- sequences

const DUMMY_NAME = Object.freeze({ _type: "Name", id: "", ctx: AST.Load, lineno: 1, col_offset: 0, end_lineno: 1, end_col_offset: 0 });
export const _PyPegen_dummy_name = (_p: P, ..._a: any[]) => DUMMY_NAME;
export const _PyPegen_singleton_seq = (_p: P, a: any) => [a];
export const _PyPegen_seq_insert_in_front = (_p: P, a: any, seq: Seq) => (seq ? [a, ...seq] : [a]);
export const _PyPegen_seq_append_to_end = (_p: P, seq: Seq, a: any) => (seq ? [...seq, a] : [a]);
export const _PyPegen_seq_flatten = (_p: P, seqs: any[][]) => seqs.flatMap((s) => s ?? []);
export const _PyPegen_join_sequences = (_p: P, a: Seq, b: Seq) => [...(a ?? []), ...(b ?? [])];

export function _PyPegen_join_names_with_dot(_p: P, a: any, b: any): any {
  return AST._PyAST_Name(`${a.id}.${b.id}`, AST.Load, a.lineno, a.col_offset, b.end_lineno, b.end_col_offset, null);
}

export function _PyPegen_seq_count_dots(seq: Token[]): number {
  let n = 0;
  for (const t of seq ?? []) n += t.type === T.ELLIPSIS ? 3 : 1;
  return n;
}

export function _PyPegen_alias_for_star(_p: P, l: number, c: number, el: number, ec: number, _arena: any): any {
  return AST._PyAST_alias("*", null, l, c, el, ec, null);
}

export const _PyPegen_map_names_to_ids = (_p: P, seq: any[]) => seq.map((e) => e.id);
export const _PyPegen_cmpop_expr_pair = (_p: P, cmpop: any, expr: any) => ({ cmpop, expr });
export const _PyPegen_get_cmpops = (_p: P, seq: any[]) => seq.map((x) => x.cmpop);
export const _PyPegen_get_exprs = (_p: P, seq: any[]) => seq.map((x) => x.expr);

function setSeqContext(p: P, seq: Seq, ctx: any): Seq {
  if (!seq || seq.length === 0) return null;
  return seq.map((e) => _PyPegen_set_expr_context(p, e, ctx));
}

export function _PyPegen_set_expr_context(p: P, e: any, ctx: any): any {
  const loc = [e.lineno, e.col_offset, e.end_lineno, e.end_col_offset, null] as const;
  switch (e._type) {
    case "Name": return AST._PyAST_Name(e.id, ctx, ...loc);
    case "Tuple": return AST._PyAST_Tuple(setSeqContext(p, e.elts, ctx), ctx, ...loc);
    case "List": return AST._PyAST_List(setSeqContext(p, e.elts, ctx), ctx, ...loc);
    case "Subscript": return AST._PyAST_Subscript(e.value, e.slice, ctx, ...loc);
    case "Attribute": return AST._PyAST_Attribute(e.value, e.attr, ctx, ...loc);
    case "Starred": return AST._PyAST_Starred(_PyPegen_set_expr_context(p, e.value, ctx), ctx, ...loc);
    default: return e;
  }
}

export const _PyPegen_key_value_pair = (_p: P, key: any, value: any) => ({ key, value });
export const _PyPegen_get_keys = (_p: P, seq: any[]) => (seq ?? []).map((x) => x.key);
export const _PyPegen_get_values = (_p: P, seq: any[]) => (seq ?? []).map((x) => x.value);
export const _PyPegen_key_pattern_pair = (_p: P, key: any, pattern: any) => ({ key, pattern });
export const _PyPegen_get_pattern_keys = (_p: P, seq: any[]) => (seq ?? []).map((x) => x.key);
export const _PyPegen_get_patterns = (_p: P, seq: any[]) => (seq ?? []).map((x) => x.pattern);

export function _PyPegen_name_default_pair(p: P, arg: any, value: any, tc: any): any {
  return { arg: _PyPegen_add_type_comment_to_arg(p, arg, tc), value };
}
export const _PyPegen_slash_with_default = (_p: P, plain_names: Seq, names_with_defaults: Seq) => ({ plain_names, names_with_defaults });
export const _PyPegen_star_etc = (_p: P, vararg: any, kwonlyargs: Seq, kwarg: any) => ({ vararg, kwonlyargs, kwarg });
export const _PyPegen_add_type_comment_to_arg = (_p: P, a: any, _tc: any) => a;

const getNames = (s: any[]) => s.map((x) => x.arg);
const getDefaults = (s: any[]) => s.map((x) => x.value);

export function _PyPegen_make_arguments(_p: P, slash_without_default: Seq, slash_with_default: any, plain_names: Seq,
  names_with_default: Seq, star_etc: any): any {
  let posonlyargs: any[];
  if (slash_without_default) posonlyargs = slash_without_default;
  else if (slash_with_default) posonlyargs = [...(slash_with_default.plain_names ?? []), ...getNames(slash_with_default.names_with_defaults ?? [])];
  else posonlyargs = [];
  let posargs: any[];
  if (names_with_default) posargs = plain_names ? [...plain_names, ...getNames(names_with_default)] : getNames(names_with_default);
  else posargs = plain_names ?? [];
  let posdefaults: any[];
  if (slash_with_default && names_with_default) posdefaults = [...getDefaults(slash_with_default.names_with_defaults ?? []), ...getDefaults(names_with_default)];
  else if (!slash_with_default && names_with_default) posdefaults = getDefaults(names_with_default);
  else if (slash_with_default && !names_with_default) posdefaults = getDefaults(slash_with_default.names_with_defaults ?? []);
  else posdefaults = [];
  const vararg = star_etc?.vararg ?? null;
  const kwonly = star_etc?.kwonlyargs ? getNames(star_etc.kwonlyargs) : [];
  const kwdefaults = star_etc?.kwonlyargs ? getDefaults(star_etc.kwonlyargs) : [];
  const kwarg = star_etc?.kwarg ?? null;
  return AST._PyAST_arguments(posonlyargs, posargs, vararg, kwonly, kwdefaults, kwarg, posdefaults, null);
}

export function _PyPegen_empty_arguments(_p: P): any {
  return AST._PyAST_arguments([], [], null, [], [], null, [], null);
}

export const _PyPegen_augoperator = (_p: P, kind: any) => ({ kind });

export function _PyPegen_function_def_decorators(_p: P, decorators: Seq, f: any): any {
  return { ...f, decorator_list: decorators };
}
export function _PyPegen_class_def_decorators(_p: P, decorators: Seq, c: any): any {
  return { ...c, decorator_list: decorators };
}

export const _PyPegen_keyword_or_starred = (_p: P, element: any, is_keyword: number) => ({ element, is_keyword });

export function _PyPegen_seq_extract_starred_exprs(_p: P, kwargs: any[]): Seq {
  const r = kwargs.filter((k) => !k.is_keyword).map((k) => k.element);
  return r.length ? r : null;
}
export function _PyPegen_seq_delete_starred_exprs(_p: P, kwargs: any[]): Seq {
  const r = kwargs.filter((k) => k.is_keyword).map((k) => k.element);
  return r.length ? r : null;
}

export function _PyPegen_ensure_imaginary(p: P, exp: any): any {
  if (exp._type !== "Constant" || !(exp.value instanceof PyComplex)) {
    RAISE_SYNTAX_ERROR_KNOWN_LOCATION(p, exp, "imaginary number required in complex literal");
  }
  return exp;
}
export function _PyPegen_ensure_real(p: P, exp: any): any {
  if (exp._type !== "Constant" || exp.value instanceof PyComplex) {
    RAISE_SYNTAX_ERROR_KNOWN_LOCATION(p, exp, "real number required in complex literal");
  }
  return exp;
}

export const _PyPegen_make_module = (_p: P, a: Seq) => AST._PyAST_Module(a, [], null);
export const _PyPegen_interactive_exit = (_p: P) => null;

export function _PyPegen_check_barry_as_flufl(_p: P, t: Token): number {
  return t.str === "!=" ? 0 : 1;
}

export function _PyPegen_check_legacy_stmt(_p: P, name: any): boolean {
  return name._type === "Name" && (name.id === "print" || name.id === "exec");
}

function prefixChar(p: P): string {
  return p.tok.mode.string_kind === 1 ? "t" : "f";
}

export function _PyPegen_check_fstring_conversion(p: P, conv_token: Token, conv: any): any {
  if (conv_token.lineno !== conv.lineno || conv_token.end_col_offset !== conv.col_offset) {
    RAISE_SYNTAX_ERROR_KNOWN_RANGE(p, conv_token, conv, "%c-string: conversion type must come right after the exclamation mark", prefixChar(p));
  }
  const id: string = conv.id;
  if ([...id].length > 1 || !(id[0] === "s" || id[0] === "r" || id[0] === "a")) {
    RAISE_SYNTAX_ERROR_KNOWN_LOCATION(p, conv, "%c-string: invalid conversion character %R: expected 's', 'r', or 'a'", prefixChar(p), id);
  }
  return { result: conv, metadata: conv_token.metadata };
}

const isEmptyStrConst = (e: any) => e._type === "Constant" && typeof e.value === "string" && e.value.length === 0;

export function _PyPegen_setup_full_format_spec(p: P, colon: Token, spec: Seq, l: number, c: number, el: number, ec: number, _a: any): any {
  if (!spec) return null;
  spec = spec.filter((e) => !isEmptyStrConst(e));
  let res: any;
  if (spec.length === 0 || (spec.length === 1 && spec[0]._type === "Constant")) {
    res = AST._PyAST_JoinedStr(spec, l, c, el, ec, null);
  } else {
    res = _PyPegen_concatenate_strings(p, spec, l, c, el, ec, null);
  }
  return { result: res, metadata: colon.metadata };
}

export function _PyPegen_get_expr_name(e: any): string | null {
  switch (e._type) {
    case "Attribute": return "attribute";
    case "Subscript": return "subscript";
    case "Starred": return "starred";
    case "Name": return "name";
    case "List": return "list";
    case "Tuple": return "tuple";
    case "Lambda": return "lambda";
    case "Call": return "function call";
    case "BoolOp": case "BinOp": case "UnaryOp": return "expression";
    case "GeneratorExp": return "generator expression";
    case "Yield": case "YieldFrom": return "yield expression";
    case "Await": return "await expression";
    case "ListComp": return "list comprehension";
    case "SetComp": return "set comprehension";
    case "DictComp": return "dict comprehension";
    case "Dict": return "dict literal";
    case "Set": return "set display";
    case "JoinedStr": case "FormattedValue": return "f-string expression";
    case "TemplateStr": case "Interpolation": return "t-string expression";
    case "Constant": {
      const v = e.value;
      if (v === Py_None) return "None";
      if (v === false) return "False";
      if (v === true) return "True";
      if (v === Py_Ellipsis) return "ellipsis";
      return "literal";
    }
    case "Compare": return "comparison";
    case "IfExp": return "conditional expression";
    case "NamedExpr": return "named expression";
    default: return null;
  }
}

export function _PyPegen_get_last_comprehension_item(comp: any): any {
  if (!comp.ifs || comp.ifs.length === 0) return comp.iter;
  return comp.ifs[comp.ifs.length - 1];
}

export function _PyPegen_collect_call_seqs(p: P, a: any[], b: Seq, l: number, c: number, el: number, ec: number, _arena: any): any {
  if (b === null) return AST._PyAST_Call(DUMMY_NAME, a, null, l, c, el, ec, null);
  const starreds = _PyPegen_seq_extract_starred_exprs(p, b);
  const keywords = _PyPegen_seq_delete_starred_exprs(p, b);
  return AST._PyAST_Call(DUMMY_NAME, [...a, ...(starreds ?? [])], keywords, l, c, el, ec, null);
}

function getInvalidTarget(e: any, type: number): any {
  if (e === null || e === undefined) return null;
  switch (e._type) {
    case "List":
    case "Tuple":
      for (const other of e.elts ?? []) {
        const child = getInvalidTarget(other, type);
        if (child !== null) return child;
      }
      return null;
    case "Starred":
      if (type === DEL_TARGETS) return e;
      return getInvalidTarget(e.value, type);
    case "Compare":
      if (type === FOR_TARGETS) {
        if (e.ops[0]._type === "In") return getInvalidTarget(e.left, type);
        return null;
      }
      return e;
    case "Name":
    case "Subscript":
    case "Attribute":
      return null;
    default:
      return e;
  }
}

export function RAISE_SYNTAX_ERROR_INVALID_TARGET(p: P, type: number, e: any): any {
  const t = getInvalidTarget(e, type);
  if (t !== null) {
    const msg = type === STAR_TARGETS || type === FOR_TARGETS ? "cannot assign to %s" : "cannot delete %s";
    RAISE_SYNTAX_ERROR_KNOWN_LOCATION(p, t, msg, _PyPegen_get_expr_name(t));
  }
  return null;
}

export function _PyPegen_arguments_parsing_error(p: P, e: any): any {
  const unpack = (e.keywords ?? []).some((k: any) => !k.arg);
  RAISE_SYNTAX_ERROR(p, unpack ? "positional argument follows keyword argument unpacking" : "positional argument follows keyword argument");
}

export function _PyPegen_nonparen_genexp_in_call(p: P, args: any, comprehensions: any[]): any {
  const len = (args.args ?? []).length;
  if (len <= 1) return null;
  const last = comprehensions[comprehensions.length - 1];
  RAISE_SYNTAX_ERROR_KNOWN_RANGE(p, args.args[len - 1], _PyPegen_get_last_comprehension_item(last), "Generator expression must be parenthesized");
}

export function _PyPegen_checked_future_import(p: P, module: string, names: any[], level: number, l: number, c: number, el: number, ec: number, _a: any): any {
  return AST._PyAST_ImportFrom(module, names, level, l, c, el, ec, null);
}

export function _PyPegen_register_stmts(p: P, stmts: Seq): Seq {
  if (!p.call_invalid_rules || !stmts || stmts.length === 0) return stmts;
  const last = stmts[stmts.length - 1];
  if (p.last_stmt_location.lineno > last.lineno) return stmts;
  p.last_stmt_location = { lineno: last.lineno, col_offset: last.col_offset, end_lineno: last.end_lineno, end_col_offset: last.end_col_offset };
  return stmts;
}

// ---- strings (string_parser.c)

const JAMO_L = ["G", "GG", "N", "D", "DD", "R", "M", "B", "BB", "S", "SS", "", "J", "JJ", "C", "K", "T", "P", "H"];
const JAMO_V = ["A", "AE", "YA", "YAE", "EO", "E", "YEO", "YE", "O", "WA", "WAE", "OE", "YO", "U", "WEO", "WE", "WI", "YU", "EU", "YI", "I"];
const JAMO_T = ["", "G", "GG", "GS", "N", "NJ", "NH", "D", "L", "LG", "LM", "LB", "LS", "LT", "LP", "LH", "M", "B", "BS", "S", "SS", "NG", "J", "C", "K", "T", "P", "H"];

/** unicodedata.lookup for \N{...}: the generated table is loaded on first use. */
export class UnicodeNameTable {
  private static map: Map<string, number> | null = null;
  private static prefixes: string[] = [];
  static lookup(name: string): number | undefined {
    if (UnicodeNameTable.map === null) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const t = require("./unames.gen");
      const m = new Map<string, number>();
      for (const line of (t.DATA as string).split("\n")) {
        const i = line.lastIndexOf(";");
        m.set(line.slice(0, i), parseInt(line.slice(i + 1), 16));
      }
      UnicodeNameTable.map = m;
      UnicodeNameTable.prefixes = t.ALGORITHMIC_PREFIXES;
    }
    const n = name.toUpperCase();
    const hit = UnicodeNameTable.map.get(n);
    if (hit !== undefined) return hit;
    for (const pre of UnicodeNameTable.prefixes) {
      if (n.startsWith(pre) && /^[0-9A-F]{4,6}$/.test(n.slice(pre.length))) return parseInt(n.slice(pre.length), 16);
    }
    if (n.startsWith("HANGUL SYLLABLE ")) {
      const rest = n.slice(16);
      for (let l = 0; l < 19; l++) {
        if (!rest.startsWith(JAMO_L[l])) continue;
        for (let v = 0; v < 21; v++) {
          if (!rest.startsWith(JAMO_V[v], JAMO_L[l].length)) continue;
          const t = JAMO_T.indexOf(rest.slice(JAMO_L[l].length + JAMO_V[v].length));
          if (t >= 0) return 0xac00 + (l * 21 + v) * 28 + t;
        }
      }
    }
    return undefined;
  }
}

class DecodeError extends Error {}

/** Decode Python escape sequences in a str literal body. */
function decodeUnicodeEscapes(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c !== "\\") {
      out += c;
      continue;
    }
    i++;
    if (i >= s.length) {
      throw new DecodeError("\\ at end of string");
    }
    const e = s[i];
    switch (e) {
      case "\n": break;
      case "\\": out += "\\"; break;
      case "'": out += "'"; break;
      case '"': out += '"'; break;
      case "a": out += "\x07"; break;
      case "b": out += "\b"; break;
      case "f": out += "\f"; break;
      case "n": out += "\n"; break;
      case "r": out += "\r"; break;
      case "t": out += "\t"; break;
      case "v": out += "\v"; break;
      case "0": case "1": case "2": case "3": case "4": case "5": case "6": case "7": {
        let j = i, v = 0;
        while (j < s.length && j < i + 3 && s[j] >= "0" && s[j] <= "7") v = v * 8 + (s.charCodeAt(j++) - 48);
        out += String.fromCodePoint(v);
        i = j - 1;
        break;
      }
      case "x": case "u": case "U": {
        const n = e === "x" ? 2 : e === "u" ? 4 : 8;
        const hex = s.slice(i + 1, i + 1 + n);
        if (hex.length < n || !/^[0-9a-fA-F]+$/.test(hex)) {
          throw new DecodeError(`truncated \\${e === "x" ? "xXX" : e === "u" ? "uXXXX" : "UXXXXXXXX"} escape`);
        }
        const v = parseInt(hex, 16);
        if (v > 0x10ffff) throw new DecodeError("illegal Unicode character");
        out += String.fromCodePoint(v);
        i += n;
        break;
      }
      case "N": {
        const m = /^\{([^}]*)\}/.exec(s.slice(i + 1));
        const cp = m ? UnicodeNameTable.lookup(m[1]) : undefined;
        if (!m || cp === undefined) throw new DecodeError(m ? "unknown Unicode character name" : "malformed \\N character escape");
        out += String.fromCodePoint(cp);
        i += m[0].length;
        break;
      }
      default:
        out += "\\" + e; // invalid escape: kept (CPython warns)
    }
  }
  return out;
}

function decodeBytesEscapes(p: P, t: Token, s: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (s[i] !== "\\") {
      out.push(c);
      continue;
    }
    i++;
    const e = s[i];
    switch (e) {
      case "\n": break;
      case "\\": out.push(92); break;
      case "'": out.push(39); break;
      case '"': out.push(34); break;
      case "a": out.push(7); break;
      case "b": out.push(8); break;
      case "f": out.push(12); break;
      case "n": out.push(10); break;
      case "r": out.push(13); break;
      case "t": out.push(9); break;
      case "v": out.push(11); break;
      case "0": case "1": case "2": case "3": case "4": case "5": case "6": case "7": {
        let j = i, v = 0;
        while (j < s.length && j < i + 3 && s[j] >= "0" && s[j] <= "7") v = v * 8 + (s.charCodeAt(j++) - 48);
        out.push(v & 0xff);
        i = j - 1;
        break;
      }
      case "x": {
        const hex = s.slice(i + 1, i + 3);
        if (!/^[0-9a-fA-F]{2}$/.test(hex)) {
          RAISE_SYNTAX_ERROR(p, "(value error) invalid \\x escape at position %d", i - 1);
        }
        out.push(parseInt(hex, 16));
        i += 2;
        break;
      }
      default:
        out.push(92, s.charCodeAt(i));
    }
  }
  return new Uint8Array(out);
}

export function decode_string(p: P, raw: boolean, s: string, _t: Token | null): string {
  if (raw) return s;
  try {
    return decodeUnicodeEscapes(s);
  } catch (e) {
    if (e instanceof DecodeError) RAISE_SYNTAX_ERROR(p, "(unicode error) 'unicodeescape' codec can't decode bytes: %s", e.message);
    throw e;
  }
}

/** _PyPegen_parse_string: a STRING token (with prefix and quotes) -> str or bytes. */
export function parse_string(p: P, t: Token): string | Uint8Array {
  let s = t.str;
  let i = 0, bytesmode = false, rawmode = false;
  while (/[a-zA-Z]/.test(s[i])) {
    const c = s[i].toLowerCase();
    if (c === "b") bytesmode = true;
    else if (c === "r") rawmode = true;
    i++;
  }
  const q = s[i];
  s = s.slice(i + 1, -1);
  if (s.length >= 4 && s[0] === q && s[1] === q) s = s.slice(2, -2);
  rawmode = rawmode || !s.includes("\\");
  if (bytesmode) {
    if (/[^\x00-\x7f]/.test(s)) RAISE_SYNTAX_ERROR_KNOWN_LOCATION(p, t, "bytes can only contain ASCII literal characters");
    if (rawmode) return new Uint8Array([...s].map((c) => c.charCodeAt(0)));
    return decodeBytesEscapes(p, t, s);
  }
  return decode_string(p, rawmode, s, t);
}

const constant = (value: any, kind: any, t: any) => AST._PyAST_Constant(value, kind, t.lineno, t.col_offset, t.end_lineno, t.end_col_offset, null);

export function _PyPegen_constant_from_string(p: P, tok: Token): any {
  const s = parse_string(p, tok);
  return constant(s, tok.str[0] === "u" ? "u" : null, tok);
}

export const _PyPegen_constant_from_token = (_p: P, tok: Token) => constant(tok.str, null, tok);

export function _PyPegen_decoded_constant_from_token(p: P, tok: Token): any {
  const raw = p.tok.insideFString() ? p.tok.mode.raw : false;
  return constant(decode_string(p, raw, tok.str, tok), null, tok);
}

function decodeFstringPart(p: P, is_raw: boolean, c: any, token: Token): any {
  let s: string = c.value;
  if (s === "{{" || s === "}}") s = s[0];
  is_raw = is_raw || !s.includes("\\");
  return AST._PyAST_Constant(decode_string(p, is_raw, s, token), null, c.lineno, c.col_offset, c.end_lineno, c.end_col_offset, null);
}

function resizedExprs(p: P, a: Token, raw: any[], b: Token): any[] {
  const is_raw = /[rR]/.test(a.str);
  const out: any[] = [];
  for (let item of raw ?? []) {
    if (item._type === "JoinedStr") {
      out.push(item.values[0], item.values[1]);
      continue;
    }
    if (item._type === "Constant") {
      item = decodeFstringPart(p, is_raw, item, b);
      if (typeof item.value === "string" && item.value.length === 0) continue;
    }
    out.push(item);
  }
  return out;
}

export function _PyPegen_template_str(p: P, a: Token, raw: any[], b: Token): any {
  return AST._PyAST_TemplateStr(resizedExprs(p, a, raw, b), a.lineno, a.col_offset, b.end_lineno, b.end_col_offset, null);
}
export function _PyPegen_joined_str(p: P, a: Token, raw: any[], b: Token): any {
  return AST._PyAST_JoinedStr(resizedExprs(p, a, raw, b), a.lineno, a.col_offset, b.end_lineno, b.end_col_offset, null);
}

function conversionValue(debug: any, conversion: any, format: any): number {
  if (conversion) return conversion.result.id.codePointAt(0);
  if (debug && !format) return "r".charCodeAt(0);
  return -1;
}

function debugInfo(conversion: any, format: any, closing: Token, el: number, ec: number): [number, number, string] {
  if (conversion) return [conversion.result.lineno, conversion.result.col_offset, conversion.metadata];
  if (format) return [format.result.lineno, format.result.col_offset + 1, format.metadata];
  return [el, ec, closing.metadata!];
}

export function _PyPegen_interpolation(p: P, expression: any, debug: any, conversion: any, format: any, closing: Token,
  l: number, c: number, el: number, ec: number, _a: any): any {
  const conv = conversionValue(debug, conversion, format);
  const [dl, doff, meta] = debugInfo(conversion, format, closing, el, ec);
  const exprstr = (meta ?? "").replace(/[\s=]+$/u, "");
  const node = AST._PyAST_Interpolation(expression, exprstr, conv, format ? format.result : null, l, c, el, ec, null);
  if (!debug) return node;
  const text = AST._PyAST_Constant(meta, null, l, c + 1, dl, doff - 1, null);
  return AST._PyAST_JoinedStr([text, node], l, c, dl, doff, null);
}

export function _PyPegen_formatted_value(p: P, expression: any, debug: any, conversion: any, format: any, closing: Token,
  l: number, c: number, el: number, ec: number, _a: any): any {
  const conv = conversionValue(debug, conversion, format);
  const node = AST._PyAST_FormattedValue(expression, conv, format ? format.result : null, l, c, el, ec, null);
  if (!debug) return node;
  const [dl, doff, meta] = debugInfo(conversion, format, closing, el, ec);
  const text = AST._PyAST_Constant(meta, null, l, c + 1, dl, doff - 1, null);
  return AST._PyAST_JoinedStr([text, node], l, c, dl, doff, null);
}

function buildConcatenatedStr(strings: any[]): any[] {
  const flat: any[] = [];
  for (const e of strings) {
    if (e._type === "JoinedStr" || e._type === "TemplateStr") flat.push(...(e.values ?? []));
    else flat.push(e);
  }
  const values: any[] = [];
  for (let i = 0; i < flat.length; i++) {
    let e = flat[i];
    if (e._type === "Constant") {
      if (i + 1 < flat.length && flat[i + 1]._type === "Constant") {
        const first = e;
        let last = e;
        let text = "";
        let j = i;
        for (; j < flat.length && flat[j]._type === "Constant"; j++) {
          text += flat[j].value;
          last = flat[j];
        }
        i = j - 1;
        e = AST._PyAST_Constant(text, first.kind, first.lineno, first.col_offset, last.end_lineno, last.end_col_offset, null);
      }
      if (typeof e.value === "string" && e.value.length === 0) continue;
    }
    values.push(e);
  }
  return values;
}

export function _PyPegen_concatenate_tstrings(_p: P, strings: any[], l: number, c: number, el: number, ec: number, _a: any): any {
  return AST._PyAST_TemplateStr(buildConcatenatedStr(strings), l, c, el, ec, null);
}

export function _PyPegen_concatenate_strings(p: P, strings: any[], l: number, c: number, el: number, ec: number, _a: any): any {
  let fstring = false, unicode = false, bytes = false;
  for (const e of strings) {
    if (e._type === "Constant") {
      if (e.value instanceof Uint8Array) bytes = true;
      else unicode = true;
    } else fstring = true;
  }
  if ((unicode || fstring) && bytes) RAISE_SYNTAX_ERROR(p, "cannot mix bytes and nonbytes literals");
  if (!fstring) {
    if (strings.length === 1) return strings[0];
    if (bytes) {
      const total = strings.reduce((n, e) => n + e.value.length, 0);
      const out = new Uint8Array(total);
      let k = 0;
      for (const e of strings) {
        out.set(e.value, k);
        k += e.value.length;
      }
      return AST._PyAST_Constant(out, strings[0].kind, l, c, el, ec, null);
    }
    return AST._PyAST_Constant(strings.map((e) => e.value).join(""), strings[0].kind, l, c, el, ec, null);
  }
  return AST._PyAST_JoinedStr(buildConcatenatedStr(strings), l, c, el, ec, null);
}
