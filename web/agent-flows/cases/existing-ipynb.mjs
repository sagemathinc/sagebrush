// "open this Jupyter notebook and run it, then change the damping to 0.5 and run it again": a course-style lab the person
// already has (SciPy's solve_ivp, a matplotlib plot, a cell that uses `_`, an @interact slider), run by the agent in
// the notebook open on the page, then by the person, then edited by the agent and run again.
// Its expected values are CPython's SciPy's: x(10) = -0.2143 for c = 0.3, -0.0845 for c = 0.5.
const PATH = "/labs/damped-oscillator.ipynb";
const lines = (s) => s.split(/(?<=\n)/);
const code = (s) => ({ cell_type: "code", metadata: {}, execution_count: null, outputs: [], source: lines(s) });
const NOTEBOOK = {
  metadata: { kernelspec: { name: "python3", display_name: "Python 3", language: "python" }, language_info: { name: "python" } },
  nbformat: 4,
  nbformat_minor: 5,
  cells: [
    { cell_type: "markdown", metadata: {}, source: lines("# Damped oscillator\n\nSolve $x'' + c\\,x' + x = 0$ with $x(0)=1$, $x'(0)=0$, plot it, and explore the damping $c$.") },
    code("import numpy as np\nfrom scipy.integrate import solve_ivp\nimport matplotlib.pyplot as plt"),
    code("def rhs(t, y, c):\n    return [y[1], -y[0] - c * y[1]]\n\nsol = solve_ivp(rhs, (0, 10), [1.0, 0.0], args=(0.3,), t_eval=np.linspace(0, 10, 101))\nround(float(sol.y[0][-1]), 4)"),
    code("# the value just shown, doubled\n_ * 2"),
    code("plt.plot(sol.t, sol.y[0])\nplt.xlabel('t')\nplt.ylabel('x')\nplt.title('Damped oscillator, c = 0.3')\nplt.show()"),
    code("from ipywidgets import interact\n\n@interact(c=(0.0, 1.0, 0.1))\ndef final_position(c=0.3):\n    s = solve_ivp(rhs, (0, 10), [1.0, 0.0], args=(c,), t_eval=[10])\n    print(f'x(10) = {s.y[0][-1]:.4f} for c = {c:.1f}')"),
  ],
};
// (the cell that solves the ODE, and the one doubling its value: the agent's edit changes the damping)
const SOLVE = 2;

export default {
  id: "existing-ipynb",
  prompt: "Open this Jupyter notebook and run it. Then change the damping to 0.5 and run it again.",
  surfaces: ["mcp", "chat"],
  given: { [PATH]: { json: NOTEBOOK } },
  // (the agent reads the notebook it was pointed at; its runs and its edit are in expect, where their answers are checked)
  agent: [{ tool: "workspace_read", args: { path: PATH } }],
  async expect(h) {
    // (the notebook page's own checks: the outputs it shows, its Run all and its slider; the pane has none of these)
    const onPage = h.surface === "mcp";
    // (on the notebook page it is open, and run, before the agent's run; in the Agents page's pane the agent's run is
    //  what opens it, below)
    if (onPage) {
      await h.shown(PATH);
      await h.ran(PATH, { images: 1, errors: 0, text: /x\(10\) = -0\.2143 for c = 0\.3/ });
    }
    // (its outputs cleared and saved, so what the page shows next is the agent's run)
    if (onPage) await h.ev("(async () => { sagebrush.notebook.clearOutputs(); await sagebrush.notebook.saved(); return true; })()");
    const outs = () => h.ev(`(() => {
      const outs = sagebrush.notebook.cells().map((c) => c.out?.innerText ?? "");
      return { solved: outs[${SOLVE}], doubled: outs[${SOLVE + 1}], sliders: document.querySelectorAll(".interact input[type=range]").length };
    })()`);

    // the agent runs it: in the notebook open here, so the person sees it run, and the agent gets each cell's result
    const run = await h.tool("workspace_run_notebook", { path: PATH });
    const res = run.structured?.result ?? {};
    h.ok(!run.isError && res.ended === "done" && res.saved === "saved", "the agent's run: done, its outputs saved with the notebook", run.isError ? run.text : res);
    h.ok(/-0\.2143/.test(res.cells?.[1]?.out ?? "") && /-0\.4286/.test(res.cells?.[2]?.out ?? "") && res.cells?.[3]?.images?.count === 1,
      "its answer: the ODE's value, `_` doubled, the plot", res.cells);
    if (!onPage) {
      // (the pane: the notebook the agent ran, opened there, its run's outputs shown and saved)
      await h.shown(PATH);
      await h.ran(PATH, { images: 1, errors: 0, text: /-0\.2143/ });
    }
    if (onPage) {
      let page = await outs();
      h.ok(/-0\.2143/.test(page.solved) && /-0\.4286/.test(page.doubled) && page.sliders >= 1, "the page shows the agent's run, with no Run all pressed: the values and the slider", page);
      await h.ran(PATH, { images: 1, errors: 0, text: /x\(10\) = -0\.2143 for c = 0\.3/ });
      await h.shot("agent-run");

      // the person's own Run all after it: the same values
      // (waited for to its end: the outputs already there from the agent's run would pass h.ran at once)
      await h.ev("sagebrush.notebook.runAllGesture().then(() => true)");
      await h.ran(PATH, { images: 1, errors: 0, text: /x\(10\) = -0\.2143 for c = 0\.3/ });
      page = await outs();
      h.ok(/-0\.2143/.test(page.solved) && /-0\.4286/.test(page.doubled), "the person's Run all: the same values", page);
      // the slider responds: moved to 0.5, its output follows
      await h.ev(`(() => {
        // (the interact's own slider: the page has other range inputs)
        const s = document.querySelector(".interact input[type=range]");
        s.value = "0.5";
        s.dispatchEvent(new Event("input", { bubbles: true }));
        s.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      })()`);
      h.ok(await h.until(`/x\\(10\\) = -0\\.0845 for c = 0\\.5/.test(document.body.innerText)`, 30000), "the slider at 0.5: x(10) = -0.0845");
    }

    // the agent edits the solving cell (damping 0.3 -> 0.5) on the revision it read, then runs it again at once
    const read = await h.tool("workspace_read", { path: PATH });
    const r = read.structured?.result ?? {};
    const json = r.content?.json ?? {};
    const src = (c) => (Array.isArray(c.source) ? c.source.join("") : c.source ?? c.code ?? "");
    const cells = (json.cells ?? []).map((c, i) => {
      if (i !== SOLVE) return c;
      const edited = src(c).replace("args=(0.3,)", "args=(0.5,)");
      return "source" in c ? { ...c, source: lines(edited) } : { ...c, code: edited };
    });
    // (on the Agents page, as sagebrush-agent 0.8.8 does where the page edits notebooks by cell: that one cell set, from
    //  the read, its outputs and every other cell kept; with sagebrush-mcp, the whole notebook written on the revision)
    const id = json.cells?.[SOLVE]?.id;
    const wrote = onPage
      ? await h.tool("workspace_write", { path: PATH, base: r.rev, content: { json: { ...json, cells } } })
      : await h.tool("workspace_edit_notebook", { path: PATH, base: r.rev, set: [{ id, source: src(cells[SOLVE]) }] });
    h.ok(!wrote.isError, onPage ? "the agent's edit is written on the revision it read" : "the agent's edit of that one cell is applied, from the revision it read", wrote.text);
    const rerun = await h.tool("workspace_run_notebook", { path: PATH });
    const rr = rerun.structured?.result ?? {};
    h.ok(!rerun.isError && /-0\.0845/.test(rr.cells?.[1]?.out ?? "") && /-0\.169/.test(rr.cells?.[2]?.out ?? ""), "the rerun: the new damping's values", rerun.isError ? rerun.text : rr.cells);
    // the person sees the edit and the rerun's values in the open notebook
    if (onPage) {
      h.ok(await h.until(`sagebrush.notebook.cells()[${SOLVE}].ta.value.includes("args=(0.5,)")`, 30000), "the edit shows on the page");
      const page = await outs();
      h.ok(/-0\.0845/.test(page.solved) && /-0\.169/.test(page.doubled), "the rerun's values show on the page", page);
    }
    await h.ran(PATH, { images: 1, errors: 0, text: /-0\.0845/ });
    await h.shot("rerun");

    await h.agentStillThere();
  },
};
