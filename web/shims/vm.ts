// Compiled Python is evaluated globally; sourceURL keeps "py:<file>" frames
// in stack traces, which the runtime maps back to Python lines.
export function runInThisContext(code: string, opts?: { filename?: string }) {
  return (0, eval)(`${code}\n//# sourceURL=${opts?.filename ?? "py:<string>"}`);
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
