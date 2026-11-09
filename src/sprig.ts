// Sprig, Sagebrush's bracket-notation symbolic mode (design/sprig-mvp.md): the CLI's side.  Through S1.3 the flag is
// hidden (not in --help) and runs `--sprig -c <source>` only; files (.sprig and .wl), stdin and the REPL become
// Sprig's in S1.4 (the S1 plan, and @sagebrush's ruling of Nov 9 on .wl).

/** A Sprig program as the Python that runs it: lib/_sprig's run(), whose result is the exit status.  (A JSON string
 * is a valid Python string literal.) */
export function sprigSource(src: string): string {
  return `import sys, _sprig\nsys.exit(_sprig.run(${JSON.stringify(src)}))\n`;
}

/** Why `--sprig` can't run what the other arguments ask for in this version, or null when they ask for `-c`. */
export function sprigRefusal(o: { cmd: string | null; file: string | null; mod: string | null; inspect: boolean; emit: boolean }): string | null {
  if (o.cmd !== null && o.file === null && o.mod === null && !o.inspect && !o.emit) return null;
  return "--sprig runs only -c in this version of Sagebrush";
}
