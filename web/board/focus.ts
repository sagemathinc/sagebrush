// Which board the page's keys and clipboard are for, when a page holds
// several (a host's frames, side by side): the one holding the focus; else
// the one last pressed or focused in; until then, the first one mounted.
// A board's own elements' events need nothing of this; the page's (keydown,
// copy, cut, paste on window and document) ask active() first.

const boards: HTMLElement[] = [];
let last: HTMLElement | null = null;

/** Follow a mounted board; the function returned stops (unmounted). */
export function track(root: HTMLElement): () => void {
  boards.push(root);
  last ??= root;
  const mark = () => { last = root; };
  root.addEventListener("pointerdown", mark, true);
  root.addEventListener("focusin", mark, true);
  return () => {
    root.removeEventListener("pointerdown", mark, true);
    root.removeEventListener("focusin", mark, true);
    boards.splice(boards.indexOf(root), 1);
    if (last === root) last = boards.at(-1) ?? null;
  };
}

/** Whether the page's keys and clipboard are this board's. */
export function active(root: HTMLElement): boolean {
  const a = document.activeElement;
  if (a && a !== document.body && root.contains(a)) return true;
  // (the focus in another board: that one's)
  if (a && boards.some((b) => b !== root && b.contains(a))) return false;
  // (the focus in a page panel that takes its own keys, the terminal's dock (web/shell/panel.ts): no board's, whichever
  // was last pressed; anywhere in it, its log, grip and buttons as well as its input (board's B363-1))
  if (a?.closest(".sb-term")) return false;
  return last === root;
}
