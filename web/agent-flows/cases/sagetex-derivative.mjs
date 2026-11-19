// "write a SageTeX document with the derivative of sin(x^2) and a plot of it, and build it": the agent writes the .tex
// and builds it (latex_build: Sage runs the document's code; the agent gets the built pages); the person sees the
// document, the PDF view, with the derivative Sage computed and the plot, without pressing anything; the agent is still
// there. (Decided Nov 19 2026: a .tex the agent created or built runs once by itself in the editor when it is shown,
// under Everything and May run code, as a notebook the agent created does; the agent's own results never become the
// person's file: latex_build on the main branch saves none, and the editor's run is the person's.)
// (On chat the pane frames the LaTeX editor's page, the PDF by default; on mcp the person opens the document from the
// notebook page, in a tab of its own, as from Files. The editor's page needs a build whose hosts include this one:
// SAGEBRUSH_LATEX_PREVIEW=test on loopback.)
const PATH = "/sin x squared.tex";
const TEX = String.raw`\documentclass{article}
\usepackage{sagetex}
\begin{document}
\section*{The derivative of $\sin(x^2)$}
\[ \frac{d}{dx}\sin(x^2) = \sage{diff(sin(x^2), x)} \]
\begin{center}
\sageplot[width=0.8\textwidth]{plot(sin(x^2), (x, -3, 3))}
\end{center}
\end{document}
`;

export default {
  id: "sagetex-derivative",
  prompt: "write a SageTeX document with the derivative of sin(x^2) and a plot of it, and build it",
  surfaces: ["mcp", "chat"],
  ms: 300000,
  agent: [
    { tool: "workspace_create", args: { path: PATH, content: { text: TEX } } },
  ],
  async expect(h) {
    // (the build, as the agent asks it: both SageTeX items run, none failed, and its first page as a PNG)
    const b = await h.tool("workspace_latex_build", { path: PATH, timeout_s: 240 });
    const r = b.structured?.result;
    h.ok(!b.isError && r?.ok === true && r.sagetex?.ran === 2 && r.sagetex.failed === 0, "latex_build: built, its 2 SageTeX items run", { ok: r?.ok, ended: r?.ended, sagetex: r?.sagetex, error: b.structured?.error });
    h.ok(typeof r?.pages?.[0]?.png === "string" && Buffer.from(r.pages[0].png, "base64").subarray(0, 4).toString("latin1") === "\x89PNG", "latex_build: the agent gets its first page as a PNG", r?.pages?.map((p) => [p.n, p.w, p.h]));
    // (the document as the person sees it: the pane's frame on chat; the editor's page in a tab of its own on mcp)
    let page = h, doc = "document";
    if (h.surface === "mcp") {
      await h.ev(`(() => { const a = document.createElement("a"); a.id = "sbflow-files"; a.href = "/"; a.target = "_blank"; a.textContent = "Sagebrush"; a.style.cssText = "position:fixed;left:8px;top:8px;z-index:2147483647;padding:8px;background:#fff"; document.body.append(a); return true; })()`);
      await h.click("#sbflow-files");
      const t = await h.tab(/^https?:\/\/[^/]+\/$/);
      // (its file, as the file browser opens it: the editor's page, by the file's id)
      h.ok(await t.until(`!!window.sagebrush?.workspace`, 60000), "the notebook page opens in a tab of its own");
      const fid = await t.ev(`window.sagebrush.workspace.list("/", { recursive: true }).then((es) => es.find((e) => e.path === ${JSON.stringify(PATH)})?.fid ?? null)`);
      h.ok(typeof fid === "string", "the .tex is in the person's files", fid);
      await t.ev(`(location.assign("/?tex=" + ${JSON.stringify(fid ?? "")}), true)`);
      page = t;
    } else {
      await h.shown(PATH);
      doc = `document.querySelector("#artifacts .pane-host:not([hidden]) iframe.tex-frame")?.contentDocument`;
    }
    const pdf = `(() => { const d = ${doc}, p = d?.querySelector(".tex-page .tex-preview"); if (!p) return null;
      const img = [...p.querySelectorAll("img.sageplot")].find((i) => i.complete && i.naturalWidth > 100);
      return { view: d.querySelector(".tex-page")?.dataset.view ?? null, text: p.textContent.replace(/\\s+/g, ""), plot: !!img, run: !!d.querySelector(".tex-head .tex-run:not([hidden])") }; })()`;
    h.ok(await page.until(`!!${pdf}?.run && /derivative/.test(${pdf}.text)`, 60000), "the document is shown, with its Run", await page.ev(pdf).catch((e) => String(e)));
    if (h.surface === "chat") h.ok((await page.ev(pdf))?.view === "pdf", "the pane shows the PDF");
    // (nothing pressed: it runs once by itself; then the derivative, as Sage gave it, 2 x cos(x^2), typeset, and the plot,
    //  drawn)
    const seen = await page.until(`(() => { const s = ${pdf}; return !!s && /2xcos\\(x2\\)/.test(s.text) && s.plot; })()`, 180000);
    const s = await page.ev(pdf).catch((e) => String(e));
    h.ok(seen, "with nothing pressed, the PDF shows the derivative Sage computed (2 x cos(x^2)) and the plot", { ...s, text: s?.text?.slice(0, 200) });
    await (page === h ? h.shot("pdf") : page.shot("pdf"));
    await h.agentStillThere();
  },
};
