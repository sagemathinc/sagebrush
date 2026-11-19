// "draw a plot of sin(x^2)": the agent makes a Sage notebook; it opens, runs once by itself under "may run code", and
// shows the plot; the agent is still there and can change it.
export default {
  id: "sage-notebook",
  prompt: "draw a plot of sin(x^2)",
  surfaces: ["mcp", "chat"],
  // (decided Nov 19 2026: one rule everywhere, a notebook the agent creates runs once by itself under "may run code")
  gaps: { chat: "the Agents page's pane shows the agent's notebook but doesn't run it by itself yet" },
  agent: [
    { tool: "workspace_create", args: { path: "/sin x squared.ipynb", mode: "sage", content: { json: { mode: "sage", cells: [{ code: "plot(sin(x^2), (x, -3, 3))" }] } } } },
  ],
  async expect(h) {
    await h.shown("/sin x squared.ipynb");
    await h.ran("/sin x squared.ipynb", { images: 1, errors: 0 });
    await h.shot("plot");
    const nb = await h.read("/sin x squared.ipynb");
    h.ok(nb?.mode === "sage", "a Sage notebook", nb?.mode);
    await h.agentStillThere();
  },
};
