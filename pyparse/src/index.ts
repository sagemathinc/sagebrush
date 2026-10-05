// Python source -> CPython-shaped AST, with CPython's exact SyntaxErrors.
import { GeneratedParser } from "./parser.gen";
export { PegenError } from "./pegen";
export type { SyntaxErrorInfo } from "./pegen";

/** Parse like ast.parse(source, mode=mode): "exec" (default), "eval" or
 *  "single".  Returns a CPython-shaped AST; throws PegenError.
 *  opts.sage enables Sage operators (`^` is `**`, `^^` is xor). */
export function parse(
  source: string,
  mode: "exec" | "eval" | "single" = "exec",
  opts: { sage?: boolean } = {},
): any {
  return new GeneratedParser(source, opts).run(mode);
}
