// The Python notebook an agent makes: numpy and matplotlib, two curves with a legend and a printed
// value; then the person's follow-up, "add a histogram", which the agent makes in the same notebook and runs. What the
// person sees is checked on each surface: the notebook shown, its cells run with no error, the plots as images, the
// printed value; after the follow-up, a second image and the earlier outputs still there.
const PATH = "/sin and cos.ipynb";
const PLOT = [
  "import numpy as np",
  "import matplotlib.pyplot as plt",
  "x = np.linspace(0, 2 * np.pi, 400)",
  "plt.plot(x, np.sin(x), label=\"sin(x)\")",
  "plt.plot(x, np.cos(x), label=\"cos(x)\")",
  "plt.legend()",
  "plt.show()",
].join("\n");
const MAX = "print(round(float(np.max(np.sin(x) * np.cos(x))), 3))";
const HIST = [
  "rng = np.random.default_rng(1)",
  "plt.hist(rng.normal(size=1000), bins=30)",
  "plt.show()",
].join("\n");

export default {
  id: "python-notebook",
  prompt: "Make a Python notebook that plots sin(x) and cos(x) on [0, 2π] with numpy and matplotlib, with a legend, and prints the maximum of sin(x)·cos(x). Then: add a histogram of 1000 normal samples.",
  surfaces: ["mcp", "chat"],
  grant: { folders: ["/"], write: true, run: true },
  agent: [
    { tool: "workspace_create", args: { path: PATH, mode: "python", content: { json: { cells: [{ code: PLOT }, { code: MAX }] } } } },
  ],
  async expect(h) {
    // made, shown, and run once by itself under "May run code": the plot and the printed maximum, sin·cos = sin(2x)/2
    await h.shown(PATH);
    await h.ran(PATH, { images: 1, errors: 0, text: /^0\.5\s*$/m }, 60000);
    await h.shot("python-notebook-1-made");
    const made = await h.read(PATH);
    h.ok(made.mode === "python", "a Python notebook", made.mode);

    // the follow-up: the agent reads the notebook back and adds a cell, then runs it (its own run after an edit)
    const rd = await h.tool("workspace_read", { path: PATH });
    const doc = rd.structured?.result?.content?.json;
    h.ok(!rd.isError && Array.isArray(doc?.cells) && doc.cells.length === 2, "the agent reads its notebook back", rd.text);
    // (on the Agents page, as sagebrush-agent 0.8.1 does where the page edits notebooks by cell: the cell inserted after
    //  the last, from the read, the others and their outputs kept; with sagebrush-mcp, the whole notebook written)
    const wr = h.surface === "chat"
      ? await h.tool("workspace_edit_notebook", { path: PATH, base: rd.structured?.result?.rev, insert: [{ source: HIST, after: doc.cells.at(-1)?.id ?? null }] })
      : await h.tool("workspace_write", { path: PATH, content: { json: { ...doc, cells: [...doc.cells, { code: HIST }] } }, base: rd.structured?.result?.rev });
    h.ok(!wr.isError, "the agent adds the histogram cell", wr.text);
    const run = await h.tool("workspace_run_notebook", { path: PATH });
    const cells = run.structured?.result?.cells ?? [];
    // (its result: each code cell's {index, status, out, images: {count, bytes}})
    h.ok(!run.isError && cells.length === 3, "the agent runs the notebook: a result for each cell", run.text);
    h.ok(cells.length === 3 && cells.every((c) => c.status === "ok"), "every cell ran ok", cells.map((c) => c.status));
    h.ok(cells[0]?.images?.count === 1 && cells[2]?.images?.count === 1 && /^0\.5\s*$/m.test(cells[1]?.out ?? ""), "the agent's result: the two plots and 0.5", cells);
    // (and the person sees the new cell's histogram on the page, the earlier outputs kept)
    await h.ran(PATH, { images: 2, errors: 0, text: /^0\.5\s*$/m }, 60000);
    // (the screenshot at the new cell and its histogram; best effort, for the review only)
    await h.ev(`([...document.querySelectorAll(".ed textarea")].pop()?.scrollIntoView({ block: "start" }), true)`).catch(() => {});
    await h.shot("python-notebook-2-histogram");
    await h.agentStillThere();
  },
};
