// An agent's runs of code on a page (run-verbs.ts's RunHost), for runVerbsFor: the verbs in /sagebrush-agent-run.js,
// fetched at the first run, given the page's workspace, the interpreter's classes, the sandboxed runner (never a plain
// worker: without it the run is refused) and each notebook's own write trees. One host for every page that pairs an
// agent: the notebook page (web/index.html) and the Agents page (web/agents/page.ts), so latex_build, run_notebook,
// run_file and run_stop are the same verbs, under the same grant, on both.
import type { LatexMods, RunHost } from "./run-verbs";

type Kernels = { WorkerKernel: RunHost["WorkerKernel"]; RunnerWorker: RunHost["RunnerWorker"] };

export type RunsPage = {
  /** the site's root, where the chunks and the runner are */
  site: string;
  /** the interpreter's classes: the page's own, or fetched with the run's chunk */
  kernels(): Kernels | Promise<Kernels>;
  /** "ok" only where the sandboxed runner can be had (a cross-origin isolated page, not the app's or the CLI's) */
  sandbox: "ok" | "none";
  /** the notebooks' write trees as the person allowed them (notebook/permissions.js), and their changes in this tab */
  perms: { writeTrees(ref: string): string[]; onChange(cb: () => void): () => void };
  /** the chunks, as the page names them (its lazy imports, which the size checks read on the page): the run's, and
   * latex_build's three only in a build with the LaTeX editor (elsewhere the build is refused: no LaTeX) */
  chunks: { run: string; latex?: [page: string, tools: string, run: string] };
  /** what else this page's runs may use (run-verbs.ts RunHost's optional fields: on a local host, the tests' holds),
   * asked at each run */
  more?: () => Partial<RunHost>;
};

export function agentRunsFor(ws: RunHost["ws"], o: RunsPage): { load(): Promise<typeof import("./run-verbs")>; host(): RunHost } {
  let mod: Promise<typeof import("./run-verbs")> | null = null, tries = 0, latexMods: Promise<LatexMods> | null = null, latexTries = 0;
  let kernels: Kernels | null = null;
  const at = (f: string) => new URL(f, o.site).href;
  return {
    load: () => (mod ??= Promise.all([import(/* @vite-ignore */ at(o.chunks.run) + (tries++ ? `?try=${tries}` : "")), o.kernels()])
      .then(([m, k]) => ((kernels = k), m))
      .catch((e) => { mod = null; throw e; })),
    host: () => ({
      ws, WorkerKernel: kernels!.WorkerKernel, RunnerWorker: kernels!.RunnerWorker, runnerSrc: at("runner/"), sandbox: o.sandbox,
      docTrees: (ref) => o.perms.writeTrees(ref),
      // (a change of any notebook's trees, here or in another tab (its storage event), told to the run, whose ceiling
      //  narrows at once)
      docChange: (cb) => {
        const st = (e: StorageEvent) => { if (e.key === null || e.key === "sagebrush-grants") cb(); };
        const off = o.perms.onChange(() => cb());
        addEventListener("storage", st);
        return () => { off(); removeEventListener("storage", st); };
      },
      // (latex_build: the LaTeX page module, its tools and Run's code, fetched at an agent's first build)
      ...(o.chunks.latex ? { latex: { load: () => (latexMods ??= Promise.all(o.chunks.latex!.map((f) => import(/* @vite-ignore */ at(f) + (latexTries ? `?try=${latexTries}` : ""))))
        .then(([page, tools, run]) => ({ page, tools, run })).catch((e) => { latexMods = null; latexTries++; throw e; })) } } : {}),
      ...o.more?.(),
    }),
  };
}
