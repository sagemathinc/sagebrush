// Python source -> CPython-shaped AST, with CPython's exact SyntaxErrors.
import { GeneratedParser } from "./parser.gen";
export { PegenError } from "./pegen";
export type { SyntaxErrorInfo } from "./pegen";

/** Parse like ast.parse(source, mode=mode): "exec" (default), "eval" or
 *  "single".  Returns a CPython-shaped AST; throws PegenError. */
export function parse(source: string, mode: "exec" | "eval" | "single" = "exec"): any {
  return new GeneratedParser(source).run(mode);
}
