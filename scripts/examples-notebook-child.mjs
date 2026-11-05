// One notebook's fresh run, for scripts/examples.mjs (its own process, killed at the example's deadline):
// the code cells, in order, on a fresh notebook session (src/notebook-session.ts, as the page's worker and
// `sagebrush notebook` run them), with the run's fixed seed. Writes each cell's outputs, in Jupyter's
// shape, to OUT as JSON.
//   node scripts/examples-notebook-child.mjs DIR NOTEBOOK MODE SEED OUT
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const [dir, file, mode, seed, out] = process.argv.slice(2);
const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { notebookSession } = require(
  join(root, "dist", "src", "notebook-session.js"),
);

const nb = JSON.parse(readFileSync(join(dir, file), "utf8"));
const text = (v) => (Array.isArray(v) ? v.join("") : String(v ?? ""));
const cells = nb.cells
  .filter((c) => c.cell_type === "code")
  .map((c) => text(c.source));
const outputs = cells.map(() => []);
const waiting = new Map();
const session = notebookSession(
  (m) => {
    // (run ids start at 1: the session skips ids at or below its interrupt cutoff, which starts at 0)
    const o = outputs[m.id - 1];
    if (!o) return;
    if (m.stream)
      o.push({ output_type: "stream", name: m.stream, text: m.text });
    else if (m.display)
      o.push({ output_type: "display_data", data: m.display, metadata: {} });
    else if (m.done) {
      if (m.error)
        o.push({
          output_type: "error",
          ename: typeof m.error === "string" ? m.error : "Error",
          evalue: "",
          traceback: [],
        });
      waiting.get(m.id)?.();
    } else if (m.skipped) waiting.get(m.id)?.();
  },
  {
    captureStreams: true,
    init: (R) => {
      R.importModule("os").chdir(dir);
      R.importModule("sys").path.push(dir);
    },
  },
);
await session.ready;
for (const [i, code] of cells.entries()) {
  const id = i + 1;
  const done = new Promise((resolve) => waiting.set(id, resolve));
  await session.handle({
    id,
    code,
    seed,
    sage: mode === "sage",
    magma: mode === "magma",
    matlab: mode === "matlab",
  });
  await done;
  if (outputs[i].some((o) => o.output_type === "error")) break;
}
writeFileSync(out, JSON.stringify(outputs));
process.exit(0);
