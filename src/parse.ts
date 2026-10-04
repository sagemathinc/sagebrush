// Parser selection.  The default front end is pyparse (CPython 3.14's own
// grammar, generated in TypeScript: ../pyparse); PYJS_PARSER=tree-sitter
// selects the original tree-sitter lowering for comparison.
import * as A from "./ast";
import * as F from "./frontend";
import * as TS from "./parse_treesitter";

export { PySyntaxError } from "./frontend";
export { decodeEscapes } from "./parse_treesitter";

const useTreeSitter = typeof process !== "undefined" && process.env?.PYJS_PARSER === "tree-sitter";

export async function initParser(): Promise<void> {
  if (useTreeSitter) await TS.initParser();
}

export function parse(source: string, filename: string, mode: "exec" | "eval" = "exec"): A.Module {
  return useTreeSitter ? TS.parse(source, filename) : F.parse(source, filename, mode);
}
