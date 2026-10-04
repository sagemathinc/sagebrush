// Tree-sitter concrete syntax tree -> Python AST (src/ast.ts).
//
// Tree-sitter recovers from errors, so any ERROR or MISSING node is reported
// as a SyntaxError with CPython's wording where it is easy to match.

import { readFileSync } from "fs";
import * as A from "./ast";

// web-tree-sitter types are loose; the lowering checks node types explicitly.
type Node = any;

let parser: any = null;

export async function initParser(): Promise<void> {
  if (parser !== null) return;
  const { Parser, Language } = require("web-tree-sitter");
  await Parser.init();
  const wasm = require.resolve("tree-sitter-python/tree-sitter-python.wasm");
  const language = await Language.load(readFileSync(wasm));
  parser = new Parser();
  parser.setLanguage(language);
}

import { PySyntaxError } from "./frontend";
export { PySyntaxError };

export function parse(source: string, filename: string): A.Module {
  if (parser === null) throw new Error("initParser() has not completed");
  const tree = parser.parse(source);
  const lines = source.split("\n");
  try {
    const bad = findError(tree.rootNode);
    if (bad !== null) {
      const line = bad.startPosition.row + 1;
      throw new PySyntaxError("invalid syntax", filename, line, lines[line - 1] ?? "");
    }
    const lowering = new Lowering(filename, lines);
    return { body: lowering.block(tree.rootNode), lines };
  } finally {
    tree.delete();
  }
}

function findError(n: Node): Node | null {
  if (!n.hasError) return null;
  if (n.type === "ERROR" || n.isMissing) return n;
  for (const c of n.children) {
    const r = findError(c);
    if (r !== null) return r;
  }
  return n;
}

const named = (n: Node): Node[] => n.namedChildren.filter((c: Node) => c.type !== "comment");
const line = (n: Node) => n.startPosition.row + 1;

class Lowering {
  constructor(
    private filename: string,
    private lines: string[]
  ) {}

  fail(n: Node, msg: string): never {
    const l = line(n);
    throw new PySyntaxError(msg, this.filename, l, this.lines[l - 1] ?? "");
  }

  // ------------------------------------------------------------ statements

  block(n: Node): A.Stmt[] {
    const out: A.Stmt[] = [];
    for (const c of named(n)) out.push(...this.stmt(c));
    return out;
  }

  body(n: Node | null): A.Stmt[] {
    return n === null ? [] : this.block(n);
  }

  stmt(n: Node): A.Stmt[] {
    const l = line(n);
    switch (n.type) {
      case "expression_statement": {
        const kids = named(n);
        if (kids.length === 1) {
          const c = kids[0];
          if (c.type === "assignment") return [this.assignment(c)];
          if (c.type === "augmented_assignment") {
            return [{ k: "AugAssign", line: l, target: this.target(c.childForFieldName("left")), op: c.childForFieldName("operator").text.slice(0, -1), value: this.expr(c.childForFieldName("right")) }];
          }
          return [{ k: "Expr", line: l, value: this.expr(c) }];
        }
        return [{ k: "Expr", line: l, value: { k: "Tuple", line: l, elts: kids.map((c: Node) => this.expr(c)) } }];
      }
      case "return_statement": {
        const kids = named(n);
        return [{ k: "Return", line: l, value: kids.length ? this.exprOrTuple(kids[0]) : null }];
      }
      case "pass_statement":
        return [{ k: "Pass", line: l }];
      case "break_statement":
        return [{ k: "Break", line: l }];
      case "continue_statement":
        return [{ k: "Continue", line: l }];
      case "if_statement":
        return [this.ifStatement(n)];
      case "while_statement":
        return [{ k: "While", line: l, test: this.expr(n.childForFieldName("condition")), body: this.block(n.childForFieldName("body")), orelse: this.elseClause(n.childForFieldName("alternative")) }];
      case "for_statement":
        if (n.children[0].type === "async") this.fail(n, "async for is not supported");
        return [{ k: "For", line: l, target: this.target(n.childForFieldName("left")), iter: this.exprOrTuple(n.childForFieldName("right")), body: this.block(n.childForFieldName("body")), orelse: this.elseClause(n.childForFieldName("alternative")) }];
      case "function_definition":
        return [this.functionDef(n, [])];
      case "class_definition":
        return [this.classDef(n, [])];
      case "decorated_definition": {
        const decorators = named(n)
          .filter((c: Node) => c.type === "decorator")
          .map((d: Node) => this.expr(named(d)[0]));
        const def = n.childForFieldName("definition");
        return [def.type === "class_definition" ? this.classDef(def, decorators) : this.functionDef(def, decorators)];
      }
      case "import_statement":
        return [{ k: "Import", line: l, names: n.childrenForFieldName("name").map((c: Node) => this.alias(c)) }];
      case "import_from_statement":
        return [this.importFrom(n)];
      case "future_import_statement":
        return [];
      case "global_statement":
        return [{ k: "Global", line: l, names: named(n).map((c: Node) => c.text) }];
      case "nonlocal_statement":
        return [{ k: "Nonlocal", line: l, names: named(n).map((c: Node) => c.text) }];
      case "raise_statement": {
        const cause = n.childForFieldName("cause");
        const exc = named(n).filter((c: Node) => cause === null || c.id !== cause.id);
        return [{ k: "Raise", line: l, exc: exc.length ? this.expr(exc[0]) : null, cause: cause ? this.expr(cause) : null }];
      }
      case "try_statement":
        return [this.tryStatement(n)];
      case "with_statement": {
        if (n.children[0].type === "async") this.fail(n, "async with is not supported");
        const clause = named(n).find((c: Node) => c.type === "with_clause");
        const items = named(clause).map((item: Node) => {
          const v = item.childForFieldName("value");
          if (v.type === "as_pattern") {
            const target = named(v.childForFieldName("alias"))[0];
            return { context: this.expr(named(v)[0]), target: this.target(target) };
          }
          return { context: this.expr(v), target: null };
        });
        return [{ k: "With", line: l, items, body: this.block(n.childForFieldName("body")) }];
      }
      case "assert_statement": {
        const kids = named(n);
        return [{ k: "Assert", line: l, test: this.expr(kids[0]), msg: kids[1] ? this.expr(kids[1]) : null }];
      }
      case "delete_statement": {
        const t = named(n)[0];
        const targets = t.type === "expression_list" ? named(t) : [t];
        return [{ k: "Delete", line: l, targets: targets.map((c: Node) => this.target(c)) }];
      }
      default:
        this.fail(n, `unsupported statement: ${n.type}`);
    }
  }

  assignment(n: Node): A.Stmt {
    const l = line(n);
    const targets: A.Expr[] = [];
    let cur = n;
    // `a = b = c` nests as assignment(left=a, right=assignment(left=b, right=c)).
    while (true) {
      const left = cur.childForFieldName("left");
      const right = cur.childForFieldName("right");
      if (cur.childForFieldName("type") !== null && targets.length === 0) {
        return { k: "AnnAssign", line: l, target: this.target(left), value: right ? this.exprOrTuple(right) : null };
      }
      targets.push(this.target(left));
      if (right.type === "assignment") {
        cur = right;
        continue;
      }
      if (right.type === "augmented_assignment") this.fail(right, "invalid syntax");
      return { k: "Assign", line: l, targets, value: this.exprOrTuple(right) };
    }
  }

  ifStatement(n: Node): A.Stmt {
    const alternatives = n.childrenForFieldName("alternative");
    const build = (test: Node, body: Node, rest: Node[]): A.Stmt => {
      let orelse: A.Stmt[] = [];
      if (rest.length) {
        const [first, ...more] = rest;
        orelse = first.type === "elif_clause" ? [build(first.childForFieldName("condition"), first.childForFieldName("consequence"), more)] : this.block(first.childForFieldName("body"));
      }
      return { k: "If", line: line(test), test: this.expr(test), body: this.block(body), orelse };
    };
    return build(n.childForFieldName("condition"), n.childForFieldName("consequence"), alternatives);
  }

  elseClause(n: Node | null): A.Stmt[] {
    return n === null ? [] : this.block(n.childForFieldName("body"));
  }

  tryStatement(n: Node): A.Stmt {
    const handlers: A.ExceptHandler[] = [];
    let orelse: A.Stmt[] = [];
    let finalbody: A.Stmt[] = [];
    for (const c of named(n)) {
      if (c.type === "except_clause") {
        const kids = named(c);
        const body = kids.find((k: Node) => k.type === "block");
        const value = c.childForFieldName("value");
        let type: A.Expr | null = null;
        let name: string | null = null;
        if (value !== null) {
          if (value.type === "as_pattern") {
            type = this.expr(named(value)[0]);
            name = named(value.childForFieldName("alias"))[0].text;
          } else type = this.expr(value);
        } else {
          const exprs = kids.filter((k: Node) => k.type !== "block");
          if (exprs.length) type = this.expr(exprs[0]);
          if (exprs.length > 1) name = exprs[1].text;
        }
        handlers.push({ line: line(c), type, name, body: this.block(body) });
      } else if (c.type === "except_group_clause") {
        this.fail(c, "except* is not supported");
      } else if (c.type === "else_clause") {
        orelse = this.block(c.childForFieldName("body"));
      } else if (c.type === "finally_clause") {
        finalbody = this.block(named(c).find((k: Node) => k.type === "block"));
      }
    }
    return { k: "Try", line: line(n), body: this.block(n.childForFieldName("body")), handlers, orelse, finalbody };
  }

  params(n: Node | null): A.Params {
    const p: A.Params = { posonly: 0, args: [], vararg: null, kwonly: [], kwarg: null };
    if (n === null) return p;
    let kwonly = false;
    for (const c of named(n)) {
      let name: string;
      let dflt: A.Expr | null = null;
      switch (c.type) {
        case "identifier":
          name = c.text;
          break;
        case "default_parameter":
        case "typed_default_parameter":
          name = c.childForFieldName("name").text;
          dflt = this.expr(c.childForFieldName("value"));
          break;
        case "typed_parameter": {
          const inner = named(c)[0];
          if (inner.type === "list_splat_pattern") {
            p.vararg = named(inner)[0].text;
            kwonly = true;
            continue;
          }
          if (inner.type === "dictionary_splat_pattern") {
            p.kwarg = named(inner)[0].text;
            continue;
          }
          name = inner.text;
          break;
        }
        case "list_splat_pattern":
          p.vararg = named(c)[0].text;
          kwonly = true;
          continue;
        case "dictionary_splat_pattern":
          p.kwarg = named(c)[0].text;
          continue;
        case "keyword_separator":
          kwonly = true;
          continue;
        case "positional_separator":
          p.posonly = p.args.length;
          continue;
        default:
          this.fail(c, `unsupported parameter: ${c.type}`);
      }
      (kwonly ? p.kwonly : p.args).push({ name, default: dflt });
    }
    return p;
  }

  functionDef(n: Node, decorators: A.Expr[]): A.Stmt {
    if (n.children[0].type === "async") this.fail(n, "async def is not supported");
    return { k: "FunctionDef", line: line(n), name: n.childForFieldName("name").text, args: this.params(n.childForFieldName("parameters")), body: this.block(n.childForFieldName("body")), decorators };
  }

  classDef(n: Node, decorators: A.Expr[]): A.Stmt {
    const sup = n.childForFieldName("superclasses");
    const { args, keywords } = sup ? this.callArgs(sup) : { args: [], keywords: [] };
    return { k: "ClassDef", line: line(n), name: n.childForFieldName("name").text, bases: args, keywords, body: this.block(n.childForFieldName("body")), decorators };
  }

  alias(n: Node): A.Alias {
    if (n.type === "aliased_import") return { name: n.childForFieldName("name").text, asname: n.childForFieldName("alias").text };
    return { name: n.text, asname: null };
  }

  importFrom(n: Node): A.Stmt {
    const mod = n.childForFieldName("module_name");
    let level = 0;
    let module = mod.text;
    if (mod.type === "relative_import") {
      const prefix = named(mod).find((c: Node) => c.type === "import_prefix");
      level = prefix.text.length;
      const dotted = named(mod).find((c: Node) => c.type === "dotted_name");
      module = dotted ? dotted.text : "";
    }
    const names = named(n).some((c: Node) => c.type === "wildcard_import") ? [{ name: "*", asname: null }] : n.childrenForFieldName("name").map((c: Node) => this.alias(c));
    return { k: "ImportFrom", line: line(n), module, level, names };
  }

  // ------------------------------------------------------------ expressions

  // A bare `a, b` in return/for/assignment position is a tuple.
  exprOrTuple(n: Node): A.Expr {
    if (n.type === "expression_list") return { k: "Tuple", line: line(n), elts: named(n).map((c: Node) => this.expr(c)) };
    return this.expr(n);
  }

  target(n: Node): A.Expr {
    switch (n.type) {
      case "pattern_list":
      case "tuple_pattern":
      case "expression_list":
        return { k: "Tuple", line: line(n), elts: named(n).map((c: Node) => this.target(c)) };
      case "list_pattern":
        return { k: "List", line: line(n), elts: named(n).map((c: Node) => this.target(c)) };
      case "list_splat_pattern":
        return { k: "Starred", line: line(n), value: this.target(named(n)[0]) };
      case "parenthesized_expression":
        return this.target(named(n)[0]);
      case "identifier":
      case "attribute":
      case "subscript":
      case "tuple":
      case "list":
      case "list_splat":
        return this.expr(n);
      default:
        this.fail(n, `cannot assign to ${n.type.replace(/_/g, " ")}`);
    }
  }

  callArgs(n: Node): { args: A.Expr[]; keywords: A.Keyword[] } {
    const args: A.Expr[] = [];
    const keywords: A.Keyword[] = [];
    for (const c of named(n)) {
      if (c.type === "keyword_argument") keywords.push({ arg: c.childForFieldName("name").text, value: this.expr(c.childForFieldName("value")) });
      else if (c.type === "dictionary_splat") keywords.push({ arg: null, value: this.expr(named(c)[0]) });
      else args.push(this.expr(c));
    }
    return { args, keywords };
  }

  comprehension(n: Node, kind: "list" | "set" | "gen" | "dict"): A.Expr {
    const generators: A.Comprehension[] = [];
    for (const c of named(n).slice(1)) {
      if (c.type === "for_in_clause") {
        if (c.children[0].type === "async") this.fail(c, "async comprehensions are not supported");
        const rights = c.childrenForFieldName("right");
        const iter: A.Expr = rights.length === 1 ? this.expr(rights[0]) : { k: "Tuple", line: line(c), elts: rights.map((r: Node) => this.expr(r)) };
        generators.push({ target: this.target(c.childForFieldName("left")), iter, ifs: [] });
      } else if (c.type === "if_clause") {
        generators[generators.length - 1].ifs.push(this.expr(named(c)[0]));
      }
    }
    const body = n.childForFieldName("body");
    if (kind === "dict") {
      return { k: "Comp", line: line(n), kind, elt: this.expr(body.childForFieldName("key")), value: this.expr(body.childForFieldName("value")), generators };
    }
    return { k: "Comp", line: line(n), kind, elt: this.expr(body), value: null, generators };
  }

  expr(n: Node): A.Expr {
    const l = line(n);
    switch (n.type) {
      case "identifier":
        return { k: "Name", line: l, id: n.text };
      case "integer":
        return this.integer(n);
      case "float": {
        const t = n.text.replace(/_/g, "");
        if (/[jJ]$/.test(t)) return { k: "Const", line: l, value: { t: "complex", v: parseFloat(t) } };
        return { k: "Const", line: l, value: { t: "float", v: parseFloat(t) } };
      }
      case "true":
        return { k: "Const", line: l, value: { t: "bool", v: true } };
      case "false":
        return { k: "Const", line: l, value: { t: "bool", v: false } };
      case "none":
        return { k: "Const", line: l, value: { t: "None" } };
      case "ellipsis":
        return { k: "Const", line: l, value: { t: "Ellipsis" } };
      case "string":
        return this.strings([n]);
      case "concatenated_string":
        return this.strings(named(n));
      case "parenthesized_expression":
        return this.expr(named(n)[0]);
      case "binary_operator":
        return { k: "BinOp", line: l, op: n.childForFieldName("operator").type, left: this.expr(n.childForFieldName("left")), right: this.expr(n.childForFieldName("right")) };
      case "unary_operator":
        return this.unary(n);
      case "not_operator":
        return { k: "UnaryOp", line: l, op: "not", operand: this.expr(n.childForFieldName("argument")) };
      case "boolean_operator": {
        const op = n.childForFieldName("operator").type as "and" | "or";
        const values: A.Expr[] = [];
        const add = (e: Node) => {
          if (e.type === "boolean_operator" && e.childForFieldName("operator").type === op) {
            add(e.childForFieldName("left"));
            add(e.childForFieldName("right"));
          } else values.push(this.expr(e));
        };
        add(n);
        return { k: "BoolOp", line: l, op, values };
      }
      case "comparison_operator": {
        const operands = named(n).map((c: Node) => this.expr(c));
        const ops = n.childrenForFieldName("operators").map((o: Node) => o.type);
        return { k: "Compare", line: l, left: operands[0], ops, comparators: operands.slice(1) };
      }
      case "conditional_expression": {
        const [body, test, orelse] = named(n);
        return { k: "IfExp", line: l, test: this.expr(test), body: this.expr(body), orelse: this.expr(orelse) };
      }
      case "call": {
        const a = n.childForFieldName("arguments");
        if (a.type === "generator_expression") return { k: "Call", line: l, func: this.expr(n.childForFieldName("function")), args: [this.comprehension(a, "gen")], keywords: [] };
        const { args, keywords } = this.callArgs(a);
        return { k: "Call", line: l, func: this.expr(n.childForFieldName("function")), args, keywords };
      }
      case "attribute":
        return { k: "Attribute", line: l, value: this.expr(n.childForFieldName("object")), attr: n.childForFieldName("attribute").text };
      case "subscript": {
        const subs = n.childrenForFieldName("subscript");
        const index: A.Expr = subs.length === 1 ? this.expr(subs[0]) : { k: "Tuple", line: l, elts: subs.map((s: Node) => this.expr(s)) };
        return { k: "Subscript", line: l, value: this.expr(n.childForFieldName("value")), index };
      }
      case "slice": {
        // Children interleave expressions and ':' tokens; position decides the role.
        const parts: (A.Expr | null)[] = [null, null, null];
        let i = 0;
        for (const c of n.children) {
          if (c.type === ":") i++;
          else if (c.isNamed && c.type !== "comment") parts[i] = this.expr(c);
        }
        return { k: "Slice", line: l, lower: parts[0], upper: parts[1], step: parts[2] };
      }
      case "list":
        return { k: "List", line: l, elts: named(n).map((c: Node) => this.expr(c)) };
      case "tuple":
      case "expression_list":
        return { k: "Tuple", line: l, elts: named(n).map((c: Node) => this.expr(c)) };
      case "set":
        return { k: "Set", line: l, elts: named(n).map((c: Node) => this.expr(c)) };
      case "dictionary": {
        const keys: (A.Expr | null)[] = [];
        const values: A.Expr[] = [];
        for (const c of named(n)) {
          if (c.type === "pair") {
            keys.push(this.expr(c.childForFieldName("key")));
            values.push(this.expr(c.childForFieldName("value")));
          } else if (c.type === "dictionary_splat") {
            keys.push(null);
            values.push(this.expr(named(c)[0]));
          }
        }
        return { k: "Dict", line: l, keys, values };
      }
      case "list_comprehension":
        return this.comprehension(n, "list");
      case "set_comprehension":
        return this.comprehension(n, "set");
      case "dictionary_comprehension":
        return this.comprehension(n, "dict");
      case "generator_expression":
        return this.comprehension(n, "gen");
      case "lambda":
        return { k: "Lambda", line: l, args: this.params(n.childForFieldName("parameters")), body: this.expr(n.childForFieldName("body")) };
      case "list_splat":
        return { k: "Starred", line: l, value: this.expr(named(n)[0]) };
      case "yield": {
        const kids = named(n);
        if (n.children.some((c: Node) => c.type === "from")) return { k: "YieldFrom", line: l, value: this.expr(kids[0]) };
        return { k: "Yield", line: l, value: kids.length ? this.exprOrTuple(kids[0]) : null };
      }
      case "named_expression":
        return { k: "NamedExpr", line: l, target: n.childForFieldName("name").text, value: this.expr(n.childForFieldName("value")) };
      case "await":
        this.fail(n, "await is not supported");
      default:
        this.fail(n, `unsupported expression: ${n.type}`);
    }
  }

  unary(n: Node): A.Expr {
    const op = n.childForFieldName("operator").type;
    const operand = this.expr(n.childForFieldName("argument"));
    // Fold `-literal` so that e.g. -9223372036854775808 stays exact.
    if (op === "-" && operand.k === "Const") {
      const v = operand.value;
      if (v.t === "int") return { k: "Const", line: line(n), value: { t: "int", v: -v.v } };
      if (v.t === "float") return { k: "Const", line: line(n), value: { t: "float", v: -v.v } };
    }
    return { k: "UnaryOp", line: line(n), op, operand };
  }

  integer(n: Node): A.Expr {
    const t = n.text.replace(/_/g, "");
    if (/[jJ]$/.test(t)) return { k: "Const", line: line(n), value: { t: "complex", v: parseFloat(t) } };
    let v: bigint;
    if (/^0[oO]/.test(t)) v = BigInt("0o" + t.slice(2));
    else if (/^0[bB]/.test(t)) v = BigInt("0b" + t.slice(2));
    else if (/^0[xX]/.test(t)) v = BigInt(t);
    else {
      if (/^0\d/.test(t) && /[1-9]/.test(t)) this.fail(n, "leading zeros in decimal integer literals are not permitted; use an 0o prefix for octal integers");
      v = BigInt(t);
    }
    return { k: "Const", line: line(n), value: { t: "int", v } };
  }

  // ------------------------------------------------------------ strings

  strings(nodes: Node[]): A.Expr {
    const l = line(nodes[0]);
    const parts: A.FPart[] = [];
    let bytes: number[] | null = null;
    let isF = false;
    nodes.forEach((s, i) => {
      const start = s.children[0].text;
      const prefix = start.replace(/['"]+$/, "").toLowerCase();
      const raw = prefix.includes("r");
      const isBytes = prefix.includes("b");
      if (i > 0 && isBytes !== (bytes !== null)) this.fail(s, "cannot mix bytes and nonbytes literals");
      if (isBytes) {
        bytes ??= [];
        for (const c of s.children.slice(1, -1)) {
          if (/[^\x00-\x7f]/.test(c.text)) this.fail(s, "bytes can only contain ASCII literal characters");
          const text = raw ? c.text : decodeEscapes(c.text, true, (m) => this.fail(s, m));
          for (const ch of text) bytes.push(ch.charCodeAt(0));
        }
        return;
      }
      if (prefix.includes("f")) isF = true;
      for (const c of s.children.slice(1, -1)) {
        if (c.type === "interpolation") parts.push(this.interpolation(c, raw));
        else parts.push(this.stringText(c, raw, prefix.includes("f"), s));
      }
    });
    if (bytes !== null) return { k: "Const", line: l, value: { t: "bytes", v: bytes } };
    const merged: A.FPart[] = [];
    for (const p of parts) {
      if (typeof p === "string" && typeof merged[merged.length - 1] === "string") merged[merged.length - 1] += p;
      else merged.push(p);
    }
    if (!isF) return { k: "Const", line: l, value: { t: "str", v: (merged[0] as string) ?? "" } };
    return { k: "FString", line: l, parts: merged };
  }

  stringText(c: Node, raw: boolean, f: boolean, s: Node): string {
    let text = c.text;
    if (f) text = text.replace(/\{\{/g, "{").replace(/\}\}/g, "}");
    return raw ? text : decodeEscapes(text, false, (m) => this.fail(s, m));
  }

  interpolation(c: Node, raw: boolean): A.FPart {
    const expr = this.exprOrTuple(c.childForFieldName("expression"));
    const conv = c.childForFieldName("type_conversion");
    const specNode = c.childForFieldName("format_specifier");
    let spec: A.FPart[] | null = null;
    if (specNode !== null) {
      // Text between format expressions is not a separate node; recover it from offsets.
      spec = [];
      let pos = specNode.startIndex + 1;
      for (const p of specNode.namedChildren) {
        if (p.startIndex > pos) spec.push(sourceSlice(specNode, pos, p.startIndex));
        spec.push({ expr: this.exprOrTuple(p.childForFieldName("expression")), conv: null, spec: null, text: "" });
        pos = p.endIndex;
      }
      if (specNode.endIndex > pos) spec.push(sourceSlice(specNode, pos, specNode.endIndex));
    }
    // `f"{x=}"` self-documenting expressions keep their source text.
    const eq = c.children.some((k: Node) => k.type === "=");
    return { expr, conv: conv ? conv.text.slice(1) : eq && specNode === null ? "r" : null, spec, text: eq ? c.text.slice(1, c.text.indexOf("=") + 1) : "" };
  }
}

function sourceSlice(node: Node, start: number, end: number): string {
  return node.text.slice(start - node.startIndex, end - node.startIndex);
}

const SIMPLE_ESCAPES: Record<string, string> = { "\n": "", "\\": "\\", "'": "'", '"': '"', a: "\x07", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v" };

export function decodeEscapes(text: string, bytes: boolean, fail: (msg: string) => never | void): string {
  if (!text.includes("\\")) return text;
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch !== "\\") {
      out += ch;
      continue;
    }
    const e = text[++i];
    if (e in SIMPLE_ESCAPES) out += SIMPLE_ESCAPES[e];
    else if (e >= "0" && e <= "7") {
      let j = i;
      while (j < i + 3 && text[j] >= "0" && text[j] <= "7") j++;
      out += String.fromCharCode(parseInt(text.slice(i, j), 8));
      i = j - 1;
    } else if (e === "x") {
      out += String.fromCharCode(parseInt(text.slice(i + 1, i + 3), 16));
      i += 2;
    } else if (!bytes && (e === "u" || e === "U")) {
      const n = e === "u" ? 4 : 8;
      out += String.fromCodePoint(parseInt(text.slice(i + 1, i + 1 + n), 16));
      i += n;
    } else if (!bytes && e === "N") {
      fail("\\N{...} escapes are not supported");
    } else out += "\\" + e;
  }
  return out;
}
