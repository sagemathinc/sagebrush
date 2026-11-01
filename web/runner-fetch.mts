// What the runner's broker may fetch for its interpreter (G-10; web/notebook/runner-worker.js): the exact
// URLs, chosen at build time from the files the worker is built with, never a pattern. The engine's and the
// raster's URLs with their ?h= exactly as the worker forms them (web/worker.ts), each ordinary library
// chunk's name (web/lib-chunks.mts), and the zone data's index by name and SHA-256 (web/tzdata-chunks.mts);
// the zone files themselves are admitted from that index at run time, after its hash and its grammar are
// checked (parseTzIndex). The same list is written to dist/runner-fetch.json.

export type RunnerFetch = { files: string[]; tzIndex: { file: string; sha256: string } | null };

export function runnerFetchList(engineSha256: string, rasterSha256: string, chunkFiles: Iterable<string>, tz: { file: string; sha256: string } | null): RunnerFetch {
  const files = [`sagebrush-engine.wasm?h=${engineSha256.slice(0, 16)}`, `sagebrush-raster.wasm?h=${rasterSha256.slice(0, 16)}`, ...[...chunkFiles].filter((f) => !f.startsWith("lib/tzdata/")).sort()];
  return { files, tzIndex: tz ? { file: tz.file, sha256: tz.sha256 } : null };
}

/** The build fails for a bundle that contains runner-worker.js but not the list: its broker would allow nothing,
 * or, worse, a later edit could give it a fallback (G7). `inputs` are the bundle's metafile inputs, `texts` its
 * outputs; the define replaces every use of the name, so a name left in an output is a bundle built without it. */
export function checkRunnerDefine(what: string, inputs: string[], texts: string[]): void {
  if (!inputs.some((p) => /(^|\/)web\/notebook\/runner-worker\.js$/.test(p) || p === "notebook/runner-worker.js")) return;
  if (texts.some((t) => t.includes("__SB_RUNNER_FETCH__"))) throw new Error(`${what}: contains web/notebook/runner-worker.js but was built without __SB_RUNNER_FETCH__ (web/runner-fetch.mts)`);
}
