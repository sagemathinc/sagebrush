// Compiled Python is evaluated globally; sourceURL keeps "py:<file>" frames
// in stack traces, which the runtime maps back to Python lines.
export function runInThisContext(code: string, opts?: { filename?: string }) {
  return (0, eval)(`${code}\n//# sourceURL=${opts?.filename ?? "py:<string>"}`);
}
export default { runInThisContext };
