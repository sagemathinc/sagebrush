// The pages' side of the Terminal's kept folder and commands (web/workspace/term-kept.ts; William's H9, step 2): what
// a Terminal opens with, the line that says what came back (board's words), its writes as commands end, and End
// session's clear.  All of it in the page, none in the Terminal's chunk (terminal.js, at its size ceiling): attach()
// works through the panel as it is (its editor's history, its setCwd, its note and folder lines).
import type { Workspace } from "../workspace/api";

const n = (k: number) => `${k} command${k === 1 ? "" : "s"}`;
/** What this workspace's Terminal kept, checked (its folder still a folder here), and how to keep and clear it. */
export async function termKeep(ws: Workspace) {
  let k = { gen: 0, cwd: "/", history: [] as string[] };
  try { k = await ws.termKept(); } catch {}
  let { gen, cwd } = k, gone = "";
  // (the folder kept is only where to start: still a folder of this workspace, else the top)
  if (cwd !== "/") {
    const e = await ws.stat(cwd).catch(() => undefined);
    if (!e || e.kind !== "folder" || e.trashed || cwd === "/Trash" || cwd.startsWith("/Trash/")) { gone = cwd; cwd = "/"; }
  }
  const h = k.history.length;
  const back = h ? `Your last ${n(h)} ${h === 1 ? "is" : "are"} back (press ↑). Kept only in this browser.` : "";
  // (board's words: a folder gone since says so, and the commands that came back are still said)
  const notice = gone ? `${gone} isn't there any more, so this starts in /.` + (back && " " + back)
    : h && cwd !== "/" ? `Back in ${cwd}, with your last ${n(h)} (press ↑). Kept only in this browser.`
    : back || (cwd !== "/" ? `Back in ${cwd}.` : "");
  // (writes in order, each as soon as there is something to keep: a reload right after a command loses nothing)
  let chain: Promise<unknown> = Promise.resolve(), stale = false;
  return {
    kept: { cwd, history: k.history },
    notice,
    /** The folder and commands now, kept (a write End session made stale is refused, and ends these) */
    onKeep(c: string, history: readonly string[]) {
      if (stale) return;
      const copy = [...history];
      chain = chain.then(() => (stale ? true : ws.putTermKept(gen, c, copy))).then((ok) => { if (!ok) stale = true; }, () => {});
    },
    /** On a Terminal just opened (web/shell/panel.ts's TerminalPanel): the kept commands in its history, its folder,
     *  the line said; then each command as it is taken into the history (the panel's own clear and reset too), and
     *  each change of folder, kept */
    attach(term: any) {
      const hist = term.editor.history;
      for (const c of k.history) hist.push(c);
      term.editor.reset(); // (↑ from the newest kept)
      if (cwd !== "/") term.setCwd(cwd);
      const keepNow = () => this.onKeep(term.cwd, hist.entries);
      const push = hist.push.bind(hist);
      hist.push = (c: string) => { const took = push(c); if (took) keepNow(); return took; };
      const q = (c: string) => term.root.querySelector(c) as HTMLElement | null, note = q(".sb-term-note"), cwdEl = q(".sb-term-cwd");
      if (notice && note) { note.textContent = notice; note.hidden = false; }
      if (cwdEl) new MutationObserver(keepNow).observe(cwdEl, { childList: true, characterData: true, subtree: true });
    },
    /** End session: what was kept cleared (whether it was); a write still queued is dropped (stale), and one already
     *  under way was for the old gen, which the clear moves past, so it is refused */
    async clear(): Promise<boolean> {
      stale = true;
      try { gen = await ws.clearTermKept(); return true; } catch { return false; }
    },
  };
}
