// Python source -> CPython-shaped AST, with CPython's exact SyntaxErrors.
import { GeneratedParser } from "./parser.gen";
export { PegenError } from "./pegen";
export type { SyntaxErrorInfo } from "./pegen";

/** Parse a module (like ast.parse / compile(..., "exec")); throws PegenError. */
export function parse(source: string): any {
  return new GeneratedParser(source).run();
}
