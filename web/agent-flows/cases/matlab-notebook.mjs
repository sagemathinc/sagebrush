// "make a MATLAB notebook plotting sin(x^2)": the agent makes a MATLAB notebook (not a bare .m file); it opens, runs once
// by itself under "may run code" and shows the plot; then the agent adds a cell and runs the notebook again, in MATLAB.
export default {
  id: "matlab-notebook",
  prompt: "make a MATLAB notebook plotting sin(x^2)",
  surfaces: ["mcp", "chat"],
  agent: [
    { tool: "workspace_create", args: { path: "/sin_x_squared.ipynb", mode: "matlab", content: { json: { cells: [{ code: "x = linspace(0, 3, 200);\nplot(x, sin(x.^2))\ntitle('sin(x^2)')" }] } } } },
  ],
  async expect(h) {
    await h.shown("/sin_x_squared.ipynb");
    await h.ran("/sin_x_squared.ipynb", { images: 1, errors: 0 });
    await h.shot("plot");
    const nb = await h.read("/sin_x_squared.ipynb");
    h.ok(nb?.mode === "matlab", "a MATLAB notebook (its mode), not a bare .m file", nb?.mode);
    // (the person asks for more: the agent adds a cell and runs the notebook again, in MATLAB)
    const r = await h.tool("workspace_read", { path: "/sin_x_squared.ipynb" });
    const cells = [...(nb?.cells ?? []).map((c) => ({ code: c.code })), { code: "fprintf('%.4f\\n', max(sin(x.^2)))" }];
    const w = await h.tool("workspace_write", { path: "/sin_x_squared.ipynb", base: r.structured?.result?.rev, content: { json: { mode: "matlab", cells } } });
    h.ok(!w.isError, "the agent's edit is written", w.text);
    const run = await h.tool("workspace_run_notebook", { path: "/sin_x_squared.ipynb" });
    const res = run.structured?.result ?? {};
    h.ok(!run.isError && res.ended === "done" && res.cells?.[0]?.images?.count === 1 && res.cells?.[1]?.out === "1.0000\n",
      "run again after the edit: the plot, and max(sin(x.^2)) printed as 1.0000", run.isError ? run.text : res);
    await h.agentStillThere();
  },
};
