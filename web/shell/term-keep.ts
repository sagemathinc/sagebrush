// The pages' side of the Terminal's kept folder and commands (web/workspace/term-kept.ts; William's H9, step 2): what
// a Terminal opens with, the line that says what came back (board's words), its writes as commands end, and End
// session's clear.  All of it in the page, none in the Terminal's chunk (terminal.js, at its size ceiling): attach()
// works through the panel as it is (its editor's history, its setCwd, its note and status lines).
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
  let timer: ReturnType<typeof setTimeout> | undefined, stale = false;
  return {
    kept: { cwd, history: k.history },
    notice,
    /** The folder and commands now: kept half a second later (a write End session made stale is refused, and ends these) */
    onKeep(c: string, history: readonly string[]) {
      if (stale) return;
      clearTimeout(timer);
      const copy = [...history];
      timer = setTimeout(() => void ws.putTermKept(gen, c, copy).then((ok) => { if (!ok) stale = true; }, () => {}), 500);
    },
    /** On a Terminal just opened (web/shell/panel.ts's TerminalPanel): the kept commands in its history, its folder,
     *  the line said; then, each time a command ends (its status line written), the folder and commands kept */
    attach(term: any) {
      for (const c of k.history) term.editor.history.push(c);
      term.editor.reset(); // (↑ from the newest kept)
      if (cwd !== "/") term.setCwd(cwd);
      const q = (c: string) => term.root.querySelector(c) as HTMLElement | null, note = q(".sb-term-note"), status = q(".sb-term-status");
      if (notice && note) { note.textContent = notice; note.hidden = false; }
      if (status) new MutationObserver(() => this.onKeep(term.cwd, term.editor.history.entries)).observe(status, { childList: true, characterData: true, subtree: true });
    },
    /** End session: what was kept cleared; a keep still waiting is dropped */
    async clear() {
      stale = true;
      clearTimeout(timer);
      try { gen = await ws.clearTermKept(); } catch {}
    },
  };
}
