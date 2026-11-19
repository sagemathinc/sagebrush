// web/agent-flows/cases/board.mjs (for the agent-flows harness, web/agent-flows/FORMAT.md)
// "Make me a board about the primes", then "count up to 5000 and add twin primes": the agent makes a board, the bar
// offers it ("<agent> made <name> · Open"), Open shows it in a tab of its own where its code runs once by itself,
// and the agent's later edit reaches that open tab at once, its changed and new code run, with no reload.
const PATH = "/The primes.board.json";
const isprime = "def isprime(n):\n    return n > 1 and all(n % d for d in range(2, int(n ** 0.5) + 1))\n";
const board = (n, more = []) => ({
  title: "The primes",
  nodes: [
    { id: "intro", title: "About", text: "A prime is a whole number $p > 1$ whose only divisors are $1$ and $p$; $\\pi(x) \\sim x/\\log x$." },
    { id: "count", title: "Primes up to N", code: `N = ${n}\n${isprime}print(sum(1 for k in range(N + 1) if isprime(k)), 'primes up to', N)` },
    { id: "plot", title: "π(x) and x/log x", code: "import math\nimport matplotlib.pyplot as plt\nxs = list(range(2, 2000, 10))\nplt.plot(xs, [sum(1 for k in range(2, x + 1) if isprime(k)) for x in xs], label='pi(x)')\nplt.plot(xs, [x / math.log(x) for x in xs], label='x/log x')\nplt.legend(); plt.show()" },
    ...more,
  ],
  edges: [],
});

export default {
  id: "board",
  prompt: "make me a board about the primes: an intro, a plot of π(x) against x/log x, and a count of the primes up to N",
  surfaces: ["mcp", "chat"],
  gaps: { chat: "the Agents page shows a board the agent writes as its JSON source: no board, and no Open for it" },
  grant: { folders: ["/"], write: true, run: true },
  agent: [
    { tool: "workspace_create", args: { path: PATH, content: { json: board(1000) } } },
  ],
  async expect(h) {
    // the bar says what the agent made, with Open as its call to action (a board opens in a tab of its own)
    h.ok(await h.until(`/made\\s*The primes\\.board\\.json/.test(document.querySelector(".sbag-bar .made")?.textContent ?? "")`, 10000), "the bar: <agent> made The primes.board.json · Open");
    await h.click(".sbag-bar .made button");
    const B = await h.tab(/\/board\/\?doc=local:/);
    h.ok(await B.until("window.sagebrush?.board?.snapshot?.()?.items?.length === 3", 60000), "the board opens in its tab, its three items");
    h.ok(await B.until("window.sagebrush.board.outputs().then((os) => os.some((o) => /168 primes up to 1000/.test(String(o.output))))", 90000), "its code runs once by itself: the count");
    h.ok(await B.until("window.sagebrush.board.outputs().then((os) => os.some((o) => /^\\[picture: Plot/.test(String(o.output))))", 90000), "…and the plot");
    h.ok(await B.ev("document.querySelectorAll('.katex').length > 0"), "the math is typeset");
    const origin0 = await B.ev("performance.timeOrigin");
    // the person: "count up to 5000 and add twin primes"; the agent edits the same board
    const rd = await h.tool("workspace_read", { path: PATH });
    const rev = rd.structured?.result?.rev;
    await h.tool("workspace_write", { path: PATH, base: rev, content: { json: board(5000, [{ id: "twin", title: "Twin primes", code: "print(sum(1 for p in range(3, N) if isprime(p) and isprime(p + 2)), 'twin pairs below', N)" }]) } });
    h.ok(await B.until("window.sagebrush.board.snapshot().items.length === 4", 15000), "the open board shows the edit at once");
    h.ok(await B.until("window.sagebrush.board.outputs().then((os) => os.some((o) => /669 primes up to 5000/.test(String(o.output))) && os.some((o) => /126 twin pairs below 5000/.test(String(o.output))))", 90000), "…its changed and new code run");
    h.ok((await B.ev("performance.timeOrigin")) === origin0, "…without a reload");
    h.ok(!(await h.files()).some((p) => /changed elsewhere/.test(p)), "no \"changed elsewhere\" copy");
    await B.shot("board-after-edit");
    await h.agentStillThere();
  },
};
