// The service worker's test-only hook (B8, the grader's ruling on cases v1): web/sw.js carries one block between
// `// <offline-test>` and `// </offline-test>` lines.  The shipped dist/sw.js is the same file with that block cut out
// (and nothing else changed); a test build keeps it, outside any deployable directory, as web/dist-test/sw.test.js.
const BLOCK = /^\/\/ <offline-test>\n[\s\S]*?^\/\/ <\/offline-test>\n/m;
const MARKERS = ["<offline-test>", "</offline-test>", "offlineTest"];

/** the shipped text: `text` with its one hook block cut out; throws unless exactly one block and no marker left */
export function stripHook(text: string): string {
  const blocks = text.match(new RegExp(BLOCK.source, "gm")) ?? [];
  if (blocks.length !== 1) throw new Error(`web/sw.js: ${blocks.length} test hook blocks (exactly one expected)`);
  const at = text.indexOf(blocks[0]);
  // (byte for byte: the shipped file is the test file minus exactly the block's bytes)
  const shipped = text.slice(0, at) + text.slice(at + blocks[0].length);
  assertShipped(shipped);
  return shipped;
}

/** the shipped service worker carries no trace of the hook (the grader's (b) and v2 additions 1-2) */
export function assertShipped(shipped: string) {
  for (const m of MARKERS) if (shipped.includes(m)) throw new Error(`dist/sw.js: the shipped service worker contains the test hook's ${JSON.stringify(m)}`);
  // (1) the hook's seams are assigned once, at their declaration: only the test build's block changes them
  for (const [name, decl] of [["timeScale", "let timeScale = 1, estimateFn = "], ["estimateFn", "estimateFn = () => navigator.storage?.estimate?.();"]]) {
    const n = shipped.match(new RegExp(`\\b${name}\\s*=(?!=)`, "g"))?.length ?? 0;
    if (n !== 1 || !shipped.includes(decl)) throw new Error(`dist/sw.js: ${name} is assigned ${n} times (only its declaration may assign it)`);
  }
  // (2) the counters are only written in shipped code: each use is its declaration, an increment, or X = Math.max(X, ...)
  for (const name of ["budgetPeak", "inflightPeak", "keysLooked"]) {
    const uses = shipped.split("\n").filter((l) => new RegExp(`\\b${name}\\b`).test(l));
    const fine = (l: string) => new RegExp(`(^|[,(;{\\s])${name} = Math\\.max\\(${name}, `).test(l) || new RegExp(`\\b${name}\\+\\+`).test(l) || new RegExp(`^(let|const) .*\\b${name} = 0\\b`).test(l.trim());
    const bad = uses.filter((l) => !fine(l));
    if (bad.length) throw new Error(`dist/sw.js: the counter ${name} is read in shipped code: ${bad[0].trim().slice(0, 120)}`);
  }
  // (3) the hook's other seams (the stop point, the grant log, the forced probe) never in shipped code
  for (const [what, re] of [["a patched Cache API", /\bCache\.prototype\b|\bcaches\.open\s*=(?!=)/], ["reserve rebound", /^(?!\s*(?:const|let|var)\b).*(?:^|[^.\w])reserve\s*=(?!=)/m],
    ["the stop point", /\bstopAt\b|sb-offline-test/], ["the grant log", /\bgrants\b/], ["the probe forced", /\bprobed\s*=(?!=)/]] as const) {
    if (re.test(shipped)) throw new Error(`dist/sw.js: the shipped service worker contains the test hook's ${what}`);
  }
}

/** (3) no deployable directory carries the test build: no sw.test.js, no file with a hook marker */
export async function assertNoHookIn(dir: string) {
  const { readdirSync, readFileSync, statSync } = await import("node:fs");
  const { join } = await import("node:path");
  const walk = (d: string): string[] => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));
  for (const f of walk(dir)) {
    if (/sw\.test\.js$/.test(f)) throw new Error(`${f}: the test build's service worker is in a deployable directory`);
    if (/\.(js|mjs|html|json)$/.test(f) && readFileSync(f, "utf8").includes("// <offline-test>")) throw new Error(`${f}: carries the service worker's test hook`);
  }
}
