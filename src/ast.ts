// Python AST.  Field names follow CPython's `ast` module where practical.
// Every node records the 1-based source line used for tracebacks.

export type Expr =
  | { k: "Name"; line: number; id: string }
  | { k: "Const"; line: number; value: Constant }
  | { k: "FString"; line: number; parts: FPart[] }
  | { k: "BinOp"; line: number; op: string; left: Expr; right: Expr }
  | { k: "UnaryOp"; line: number; op: string; operand: Expr }
  | { k: "BoolOp"; line: number; op: "and" | "or"; values: Expr[] }
  | { k: "Compare"; line: number; left: Expr; ops: string[]; comparators: Expr[] }
  | { k: "IfExp"; line: number; test: Expr; body: Expr; orelse: Expr }
  | { k: "Call"; line: number; func: Expr; args: Expr[]; keywords: Keyword[] }
  | { k: "Attribute"; line: number; value: Expr; attr: string }
  | { k: "Subscript"; line: number; value: Expr; index: Expr }
  | { k: "Slice"; line: number; lower: Expr | null; upper: Expr | null; step: Expr | null }
  | { k: "List"; line: number; elts: Expr[] }
  | { k: "Tuple"; line: number; elts: Expr[] }
  | { k: "Set"; line: number; elts: Expr[] }
  | { k: "Dict"; line: number; keys: (Expr | null)[]; values: Expr[] }
  | { k: "Comp"; line: number; kind: "list" | "set" | "gen" | "dict"; elt: Expr; value: Expr | null; generators: Comprehension[] }
  | { k: "Lambda"; line: number; args: Params; body: Expr }
  | { k: "Starred"; line: number; value: Expr }
  | { k: "Yield"; line: number; value: Expr | null }
  | { k: "Await"; line: number; value: Expr }
  | { k: "YieldFrom"; line: number; value: Expr }
  | { k: "NamedExpr"; line: number; target: string; value: Expr };

export type Constant =
  | { t: "int"; v: bigint }
  | { t: "float"; v: number }
  | { t: "complex"; v: number }
  | { t: "str"; v: string }
  | { t: "bytes"; v: number[] }
  | { t: "bool"; v: boolean }
  | { t: "None" }
  | { t: "Ellipsis" };

export type FPart = string | { expr: Expr; conv: string | null; spec: FPart[] | null; text: string };

export interface Keyword {
  arg: string | null; // null for **mapping
  value: Expr;
}

export interface Comprehension {
  target: Expr;
  iter: Expr;
  ifs: Expr[];
}

export interface Param {
  name: string;
  default: Expr | null;
}

export interface Params {
  posonly: number; // the first `posonly` entries of `args` are positional-only
  args: Param[];
  vararg: string | null;
  kwonly: Param[];
  kwarg: string | null;
}

export interface ExceptHandler {
  line: number;
  type: Expr | null;
  name: string | null;
  body: Stmt[];
}

export interface Alias {
  name: string; // dotted
  asname: string | null;
}

export type Stmt =
  | { k: "Expr"; line: number; value: Expr }
  | { k: "Assign"; line: number; targets: Expr[]; value: Expr }
  | { k: "AugAssign"; line: number; target: Expr; op: string; value: Expr }
  | { k: "AnnAssign"; line: number; target: Expr; value: Expr | null }
  | { k: "Return"; line: number; value: Expr | null }
  | { k: "If"; line: number; test: Expr; body: Stmt[]; orelse: Stmt[] }
  | { k: "While"; line: number; test: Expr; body: Stmt[]; orelse: Stmt[] }
  | { k: "For"; line: number; target: Expr; iter: Expr; body: Stmt[]; orelse: Stmt[] }
  | { k: "Break"; line: number }
  | { k: "Continue"; line: number }
  | { k: "Pass"; line: number }
  | { k: "FunctionDef"; line: number; name: string; args: Params; body: Stmt[]; decorators: Expr[]; isAsync?: boolean }
  | { k: "ClassDef"; line: number; name: string; bases: Expr[]; keywords: Keyword[]; body: Stmt[]; decorators: Expr[] }
  | { k: "Import"; line: number; names: Alias[] }
  | { k: "ImportFrom"; line: number; module: string; level: number; names: Alias[] }
  | { k: "Global"; line: number; names: string[] }
  | { k: "Nonlocal"; line: number; names: string[] }
  | { k: "Raise"; line: number; exc: Expr | null; cause: Expr | null }
  | { k: "Try"; line: number; body: Stmt[]; handlers: ExceptHandler[]; orelse: Stmt[]; finalbody: Stmt[] }
  | { k: "With"; line: number; items: { context: Expr; target: Expr | null }[]; body: Stmt[] }
  | { k: "Assert"; line: number; test: Expr; msg: Expr | null }
  | { k: "Delete"; line: number; targets: Expr[] };

export interface Module {
  body: Stmt[];
  lines: string[]; // source lines, for tracebacks
}
