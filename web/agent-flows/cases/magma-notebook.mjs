// The Magma notebook scenario: the agent makes a Magma notebook, and it runs in the page and prints Magma's own text.
// The expected lines are Magma 2.18's output for these statements, and Sagebrush's CLI prints the same.
export default {
  id: "magma-notebook",
  prompt: "make a Magma notebook that factors 2^64 - 1 and finds the class number of Q(sqrt(-23))",
  surfaces: ["mcp", "chat"],
  gaps: {
    chat: "the Agents page's pane shows the agent's notebook but doesn't run it by itself yet",
  },
  agent: [
    {
      tool: "workspace_create",
      args: {
        path: "/magma-factor.ipynb",
        mode: "magma",
        content: {
          json: {
            cells: [
              { code: "print Factorization(2^64 - 1);" },
              { code: "K := QuadraticField(-23);\nprint ClassNumber(K);" },
            ],
          },
        },
      },
    },
  ],
  async expect(h) {
    await h.shown("/magma-factor.ipynb");
    // (runs once by itself under the grant's "may run code"; the text is Magma's, byte for byte)
    await h.ran("/magma-factor.ipynb", {
      images: 0,
      errors: 0,
      text: /\[ <3, 1>, <5, 1>, <17, 1>, <257, 1>, <641, 1>, <65537, 1>, <6700417, 1> \]/,
    });
    await h.ran("/magma-factor.ipynb", { images: 0, errors: 0, text: /^3$/m });
    const nb = await h.read("/magma-factor.ipynb");
    h.ok(nb?.mode === "magma", "a Magma notebook", nb?.mode);
    // (a re-run after an edit, as the agent would: the explicit run verb returns each cell's result)
    const rerun = await h.tool("workspace_run_notebook", { path: "/magma-factor.ipynb" });
    h.ok(!rerun.isError && /6700417/.test(rerun.text) && /\b3\b/.test(rerun.text), "the agent's re-run returns Magma's results", rerun.text);
    await h.agentStillThere();
  },
};
