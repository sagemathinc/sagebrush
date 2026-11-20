// The pane reader (the harness's PANE_CELLS) on the computer surface, both ways, with no self-run involved: the agent's
// notebook under a grant without May run code reads as no outputs at all; after the person presses Run on each cell, it
// reads as the list and the plot, as the person sees them.
import { PANE_CELLS, sleep } from "../../../agent-flows/harness.mjs";

const path = "/pane-check.ipynb";
const judge = (cells) => {
  const outs = (cells ?? []).flat();
  const text = outs.map((o) => o.text ?? o.data?.["text/plain"] ?? "").join("\n");
  return { cells: cells?.length ?? 0, outputs: outs.length, images: outs.filter((o) => o.data && Object.keys(o.data).some((k) => k.startsWith("image/"))).length, errors: outs.filter((o) => o.output_type === "error").length, text: text.slice(0, 200) };
};

export default {
  id: "pane-reader",
  prompt: "make a notebook for the pane check",
  surfaces: ["computer"],
  ms: 240_000, // (enrolling the computer and starting its runner come first)
  grant: { folders: ["/"], write: true, run: false },
  agent: [
    { tool: "workspace_create", args: { path, mode: "python", content: { json: { cells: [
      { code: "print(list(range(5)))" },
      { code: "import matplotlib.pyplot as plt\nplt.plot([0, 1, 4, 9])\nplt.show()" },
    ] } } } },
  ],
  async expect(h) {
    const read = async () => (await h.ev(PANE_CELLS).catch(() => null)) ?? null;
    h.ok(await h.until(`document.querySelector(".pane-head .tab.on")?.dataset.tab === ${JSON.stringify(path)} && document.querySelectorAll(".pane-body .cell").length === 2`, 30000), "it is shown in the pane, its two cells rendered");
    // (negative: nothing has run it, so the reader finds the cells and no output in any)
    await sleep(1500);
    const before = judge(await read());
    h.ok(before.cells === 2 && before.outputs === 0, "before anyone runs it, the pane reader finds its 2 cells and no outputs", before);
    // (positive: the person's Run on each cell, in order)
    for (const i of [0, 1]) {
      await h.ev(`([...document.querySelectorAll(".pane-body .cell")][${i}].querySelector("button[title^=Run]").click(), true)`);
      await h.until(`(() => { const c = [...document.querySelectorAll(".pane-body .cell")][${i}]; return !!c && !c.classList.contains("running") && !!c.querySelector(${i === 0 ? '"pre.txt"' : '"*"'}); })()`, 60000);
    }
    let after = null;
    for (const t = Date.now(); Date.now() - t < 60000; await sleep(300)) {
      after = judge(await read());
      if (after.images >= 1 && /\[0, 1, 2, 3, 4\]/.test(after.text)) break;
    }
    h.ok(after.images === 1 && after.errors === 0 && /\[0, 1, 2, 3, 4\]/.test(after.text), "after the person's Run on each cell, it reads the list and one plot, no error", after);
  },
};
