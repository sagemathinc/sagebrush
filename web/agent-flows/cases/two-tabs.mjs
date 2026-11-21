// "add a cell that plots sin(x) and run it", with the notebook open in two tabs of the person's browser: the agent
// changes the notebook shown in one; the other tab shows the change and its plot within seconds, what the person
// typed there kept; after both reload, everything is there, and the agent can go on.
const PATH = "/two-tabs.ipynb";
const PLOT = "import numpy as np\nimport matplotlib.pyplot as plt\nx = np.linspace(0, 6.3, 100)\nplt.plot(x, np.sin(x))\nplt.show()";
const PERSON = "y = 2  # typed in the other tab";
// (the notebook page's notebook, its cells' texts; and an image in some output)
const codes = `JSON.stringify(window.sagebrush?.notebook?.cells().map((c) => c.ta.value) ?? null)`;
const hasPlot = `!!document.querySelector("#cells .cell .out img, #cells .cell .out svg, #cells .cell .out canvas")`;

export default {
  id: "two-tabs",
  prompt: "Add a cell that plots sin(x) and run it.",
  surfaces: ["mcp"],
  // (two tabs, a run, and both reloaded: more than the default 120 s)
  ms: 240_000,
  why: "on chat the notebook is the pane's own; its second-tab case (the pane and a notebook tab, sync on) is test-agents-artifacts' journal-live J4",
  given: { [PATH]: { json: { cells: [{ code: "x = 1" }, { code: "y = 1" }] } } },
  agent: [{ tool: "workspace_read", args: { path: PATH } }],
  async expect(h) {
    await h.shown(PATH);
    // the person opens the same notebook in a second tab (a link, as they would), and types there
    // (the notebook page's own address for it, ?nb=<its ref>, as the Files sidebar's "Open in a new tab" makes it)
    const ref = await h.ev(`window.sagebrush.workspace.stat(${JSON.stringify(PATH)}).then((e) => e?.ref ?? null)`);
    await h.ev(`(() => { const a = document.createElement("a"); a.id = "two-tabs-link"; a.href = "/?nb=" + ${JSON.stringify(ref)}; a.target = "_blank"; a.textContent = "the same notebook"; a.style.cssText = "position:fixed;left:8px;top:8px;z-index:9999;background:#fff;padding:4px"; document.body.append(a); return true; })()`);
    await h.click("#two-tabs-link");
    const B = await h.tab(/[?&]nb=/);
    const ready = await B.until(`!!(window.sagebrush?.notebook && document.querySelectorAll("#cells .cell textarea").length === 2)`, 30000);
    h.ok(ready, "the second tab shows the notebook", await B.ev(codes).catch((e) => String(e)));
    await B.ev(`(async () => { const t = document.querySelectorAll("#cells .cell textarea")[1]; t.focus(); t.value = ${JSON.stringify(PERSON)}; t.dispatchEvent(new Event("input", { bubbles: true })); window.sagebrush.notebook.flush(); await window.sagebrush.notebook.saved(); return true; })()`);
    const typed = await h.until(`${codes}.includes(${JSON.stringify(JSON.stringify(PERSON).slice(1, -1))})`, 10000);
    h.ok(typed, "what the person typed in the second tab reaches the first", await h.ev(codes));

    // the agent: reads what is there now, adds its cell (the person's line kept), and runs the notebook
    const r = await h.tool("workspace_read", { path: PATH });
    const res = r.structured?.result ?? {};
    const cells = (res.content?.json?.cells ?? []).map((c) => ({ ...(c.id ? { id: c.id } : {}), code: c.code ?? (Array.isArray(c.source) ? c.source.join("") : c.source ?? "") }));
    h.ok(cells.some((c) => c.code === PERSON), "the agent reads the person's line", cells);
    const w = await h.tool("workspace_write", { path: PATH, content: { json: { cells: [...cells, { code: PLOT }] } }, base: res.rev });
    h.ok(!w.isError, "the agent's write is saved", w.text);
    const run = await h.tool("workspace_run_notebook", { path: PATH });
    h.ok(!run.isError, "the agent runs the notebook", run.text);

    // both tabs: the agent's cell and its plot, the person's line kept
    const here = await h.until(`(() => { const c = ${codes}; return c.includes("plt.plot") && c.includes(${JSON.stringify(JSON.stringify(PERSON).slice(1, -1))}); })()`, 15000);
    h.ok(here, "the first tab shows the agent's cell, the person's line kept", await h.ev(codes));
    await h.ran(PATH, { images: 1, errors: 0 });
    const there = await B.until(`(() => { const c = ${codes}; return c.includes("plt.plot") && c.includes(${JSON.stringify(JSON.stringify(PERSON).slice(1, -1))}); })()`, 15000);
    h.ok(there, "the second tab shows the agent's cell within seconds, the person's line kept", await B.ev(codes));
    const plotThere = await B.until(hasPlot, 30000);
    h.ok(plotThere, "the second tab shows the plot");
    await B.shot("second-tab");

    // after both reload: everything there; and the agent goes on
    await B.ev(`location.reload(), true`).catch(() => {});
    await h.ev(`location.reload(), true`).catch(() => {});
    await h.shown(PATH, 60000);
    const kept = await h.until(`(() => { const c = ${codes}; return c.includes("plt.plot") && c.includes(${JSON.stringify(JSON.stringify(PERSON).slice(1, -1))}); })()`, 30000);
    const keptB = await B.until(`(() => { const c = ${codes}; return c.includes("plt.plot") && c.includes(${JSON.stringify(JSON.stringify(PERSON).slice(1, -1))}); })()`, 30000);
    h.ok(kept && keptB, "after both tabs reload, the agent's cell and the person's line are in each", { here: await h.ev(codes), there: await B.ev(codes) });
    // (the page reloaded: its remembered pairing reconnects by itself, the agent's next call then works)
    let back = null;
    for (let i = 0; i < 30 && !back; i++) { const r = await h.tool("workspace_list", { folder: "/" }); if (!r.isError) back = r; else await new Promise((ok) => setTimeout(ok, 1000)); }
    h.ok(!!back, "after the reload the agent is still there: its next call works within 30 s, with no new link to open", await h.ev(`document.querySelector("#agentbar, .agent-bar, #agentbtn")?.textContent ?? null`).catch(() => null));
  },
};
