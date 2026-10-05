// The front end: pyparse, CPython 3.14's own grammar generated in
// TypeScript (../pyparse), lowered to pyjs's AST by ./frontend.
import * as A from "./ast";
import * as F from "./frontend";

export { PySyntaxError } from "./frontend";

// Kept for callers that awaited parser initialization (the former
// tree-sitter front end needed it); pyparse is synchronous.
export async function initParser(): Promise<void> {}

export function parse(source: string, filename: string, mode: "exec" | "eval" = "exec", opts: { sage?: boolean } = {}): A.Module {
  return F.parse(source, filename, mode, opts);
}
