// The pages' side of the Terminal's kept folder and commands (web/workspace/term-kept.ts; William's H9, step 2): what
// a Terminal opens with, the line that says what came back (board's words), its writes as commands end, and End
// session's clear.  In the page, not the Terminal's chunk (terminal.js), which only takes them: kept, notice, onKeep.
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
  const notice = gone ? `${gone} isn't there any more, so this starts in /.`
    : h && cwd !== "/" ? `Back in ${cwd}, with your last ${n(h)} (press ↑). Kept only in this browser.`
    : h ? `Your last ${n(h)} are back (press ↑). Kept only in this browser.`
    : cwd !== "/" ? `Back in ${cwd}.` : "";
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
    /** End session: what was kept cleared; a keep still waiting is dropped */
    async clear() {
      stale = true;
      clearTimeout(timer);
      try { gen = await ws.clearTermKept(); } catch {}
    },
  };
}
