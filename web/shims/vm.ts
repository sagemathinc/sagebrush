// Compiled Python is evaluated globally; sourceURL keeps "py:<file>" frames
// in stack traces, which the runtime maps back to Python lines.
// The name ends a line comment, so a line terminator in it would inject
// code: src/compile.ts encodes file names, and this refuses any that slip by.
export function runInThisContext(code: string, opts?: { filename?: string }) {
  const name = opts?.filename ?? "py:<string>";
  if (/[\r\n\u2028\u2029]/.test(name)) throw new Error("invalid script name");
  return (0, eval)(`${code}\n//# sourceURL=${name}`);
}
// The subset src/compile.ts uses; there is no code cache in a browser.
export class Script {
  constructor(private code: string, private opts?: { filename?: string }) {}
  runInThisContext() {
    return runInThisContext(this.code, this.opts);
  }
  createCachedData(): Uint8Array {
    throw new Error("no code cache in a browser");
  }
}
export default { runInThisContext, Script };
