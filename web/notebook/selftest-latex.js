// The LaTeX editor in the desktop app, for the app's self-test (selftest() in web/index.html, last: its page takes the
// notebook page over): the editor on, with File ▸ New ▸ LaTeX document; a .tex written to the workspace, mounted as
// /?tex=<fid> mounts it (web/latex/boot.ts mountTex, with this page's own sandbox and Share) and rendered, a section
// title and a formula in its preview; and what the app doesn't offer said rather than done: Share disabled with its
// reason, no Agent, and Run answering why it doesn't run (no sandbox in the app), its Sage never started.
export const LATEX_CHECKS = ["the LaTeX editor is on in the desktop app", "a .tex opens in the editor and renders", "Share, Agent and Run say what the app doesn't offer"];
// (a SageTeX item, so that Run is shown; a formula, so that the preview's math is drawn)
const TEX = "\\documentclass{article}\n\\usepackage{sagetex}\n\\begin{document}\n\\section{Hello from the app}\nTwo is $\\sage{1+1}$, and $x^2 + 1$.\n\\end{document}\n";
const until = async (f, ms) => {
  for (const t = Date.now(); Date.now() - t < ms; await new Promise((r) => setTimeout(r, 100))) { const v = f(); if (v) return v; }
  return null;
};

/** The checks, each [name, ok, detail]: `on`, the page's latexHere; `menu`, its File menu; `ws`, its workspace;
 * `mount(root, ws, fid)`, the editor mounted as the page mounts it. */
export async function latexChecks({ on, menu, ws, mount }) {
  const out = [];
  const item = menu?.querySelector('[data-item="newLatex"]');
  const itemState = item ? (item.hidden ? "hidden" : item.disabled ? "disabled" : "shown") : "none";
  out.push([LATEX_CHECKS[0], on === true && itemState === "shown", "on=" + on + " New > LaTeX document: " + itemState]);
  if (!ws) return [...out, [LATEX_CHECKS[1], false, "no workspace"], [LATEX_CHECKS[2], false, "not opened"]];
  const path = "/selftest-latex-" + crypto.randomUUID().slice(0, 8) + ".tex";
  const root = document.createElement("div");
  document.body.append(root);
  try {
    const e = await ws.createByPerson(path, { content: new TextEncoder().encode(TEX) });
    await mount(root, ws, e.fid);
    const preview = () => root.querySelector(".tex-preview");
    const shown = await until(() => /Hello from the app/.test(preview()?.textContent ?? "") && preview().querySelector(".katex"), 60000);
    out.push([LATEX_CHECKS[1], !!shown, shown ? "the title and the formula shown" : "preview: " + JSON.stringify((preview()?.textContent ?? "(none)").slice(0, 120))]);
    // (Share: the item the editor's File menu draws, disabled, its reason as its title; Agent: no button; Run: shown for
    //  the SageTeX item, and a click answered with why, nothing started)
    const share = root.querySelector('[data-item="share"]'), agent = root.querySelector(".tex-agent");
    const shareOk = !!share && share.disabled && /Sharing isn't available here/.test(share.title);
    const agentOk = !agent || agent.hidden;
    const run = await until(() => { const b = root.querySelector(".tex-run"); return b && !b.hidden ? b : null; }, 30000);
    let runSaid = "";
    if (run) {
      run.click();
      runSaid = (await until(() => { const t = root.querySelector(".tex-status")?.textContent ?? ""; return /desktop app/.test(t) ? t : ""; }, 10000)) ?? "";
    }
    const runOk = !!run && !!runSaid && /desktop app/.test(run.title) && run.textContent === "Run";
    out.push([LATEX_CHECKS[2], shareOk && agentOk && runOk,
      "share=" + (share ? (share.disabled ? "disabled" : "enabled") + " " + JSON.stringify(share.title.slice(0, 60)) : "none") +
      " agent=" + (agent ? (agent.hidden ? "hidden" : "shown") : "none") +
      " run=" + (run ? JSON.stringify(run.textContent) + " said " + JSON.stringify(runSaid.slice(0, 60)) : "not shown")]);
  } catch (e) {
    while (out.length < 3) out.push([LATEX_CHECKS[out.length], false, String(e?.message ?? e)]);
  } finally {
    root.remove();
    await ws.remove(path).catch(() => {});
  }
  return out;
}
