// Rill, Sagebrush's R mode (design/rill.md): the CLI's side.  Through A1.6 the flag is hidden (not in --help) and runs
// `--rill -c <R source>` only; .R files, stdin and the REPL become Rill's in A1.7 (plan r2, @sagebrush and astra, Nov 7).

/** An R program as the Python that runs it: lib/_rill's run(), whose result is the exit status.  (A JSON string is a
 * valid Python string literal.) */
export function rillSource(src: string): string {
  return `import sys, _rill\nsys.exit(_rill.run(${JSON.stringify(src)}))\n`;
}

/** Why `--rill` can't run what the other arguments ask for in this version, or null when they ask for `-c`. */
export function rillRefusal(o: { cmd: string | null; file: string | null; mod: string | null; inspect: boolean; emit: boolean }): string | null {
  if (o.cmd !== null && o.file === null && o.mod === null && !o.inspect && !o.emit) return null;
  return "--rill runs only -c in this version of Sagebrush";
}
