// The person asks before anything is connected: the agent's first tool call isn't workspace_connect, and its answer is
// the one link (code and port in it). The person opens it, Connect, then Allow, while the agent waits in
// workspace_connect; the agent's request then goes on, and the notebook it makes opens and runs.
const LINK = /https?:\/\/[^\s]+\/board\/\?pair=[A-Z0-9]+&port=\d+/g;
const NB = { path: "/sin.ipynb", mode: "sage", content: { json: { mode: "sage", cells: [{ code: "plot(sin(x^2), (x, -3, 3))" }] } } };

export default {
  id: "one-link",
  prompt: "draw a plot of sin(x^2) (before connecting)",
  surfaces: ["mcp"],
  why: "the chat pairs from the Agents page itself: there is no first tool call before pairing",
  async unpaired(h) {
    const r1 = await h.tool("workspace_create", NB);
    const links = r1.text.match(LINK) ?? [];
    h.ok(r1.isError && r1.structured?.error?.code === "not_connected" && links.length === 1, "the first call answers not_connected with one link", r1.text);
    h.ok(/Connect, then Allow/.test(r1.text) && !/menu|by hand/.test(r1.text), "...open it, Connect, Allow: nothing to find in a menu or type", r1.text);
    const waited = h.tool("workspace_connect", { wait: 60 });
    await h.open(links[0]);
    h.ok(await h.until(`location.pathname === "/" && document.querySelectorAll(".sbag-box input").length === 1 && !!document.querySelector(".sbag-box button.primary")`, 60000), "the link opens Connect on the notebook page, one field, filled in");
    await h.ev(`(document.querySelector(".sbag-box button.primary").click(), true)`);
    h.ok(await h.until(`[...document.querySelectorAll(".sbag-box h2")].some((x) => x.textContent === "Allow this agent?")`, 30000), "paired: Allow this agent?");
    // (the person's choice: everything, may change files, may run code)
    await h.ev(`(() => { const b = [...document.querySelectorAll(".sbag-box")].at(-1), by = (re) => [...b.querySelectorAll("label")].find((l) => re.test(l.textContent))?.querySelector("input[type=checkbox]"); for (const c of [b.querySelector(".folders input"), by(/may change files/), by(/^May run code/)]) if (!c.checked) c.click(); [...b.querySelectorAll("button.primary")].pop().click(); return true; })()`);
    const r2 = await waited;
    h.ok(r2.structured?.result?.granted === true, "workspace_connect with wait returns once allowed", r2.text);
    const r3 = await h.tool("workspace_create", NB);
    h.ok(!r3.isError, "the agent's request goes on: the notebook is made", r3.text);
  },
  async expect(h) {
    await h.shown("/sin.ipynb");
    await h.ran("/sin.ipynb", { images: 1, errors: 0 });
    await h.agentStillThere();
  },
};
