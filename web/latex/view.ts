// Where you were in a .tex (design/view-state.md, kind tex): the source's top line and cursor, and the preview's top
// group and the offset in it, kept in this browser and put back when the file is opened again. Its own chunk,
// /sagebrush-latex-view.js, fetched as the page opens a file; the page keeps only the import and the guard that says
// the person has moved before it came (daybreak2's SIZE plan for V1, Nov 10)
import { keepView, viewToRestore, type View } from "../workspace/view-state";

type Ed = {
  src: HTMLTextAreaElement; hl: HTMLElement;
  groups: () => { el: HTMLElement; start: number; end: number }[];
  onRendered: (f: () => void) => () => void;
};

// the source line of an offset
const lineAt = (t: string, off: number) => { let n = 0; for (let i = t.indexOf("\n"); i >= 0 && i < off; i = t.indexOf("\n", i + 1)) n++; return n; };
const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);

/** Keeps `fid`'s view from now on, and puts the kept one back once, after the preview's first layout, unless `moved`
 *  (the person scrolled, typed, clicked or touched before this came, or the URL has a target). Ends with `signal`. */
export function attachView(E: Ed, right: HTMLElement, fid: string, moved: boolean, signal: AbortSignal) {
  const key = { kind: "tex" as const, id: fid }, { src, hl } = E;
  const read = (): View | null => {
    const lines = hl.children, t = src.value;
    let line = 0;
    while (line < lines.length - 1 && (lines[line + 1] as HTMLElement).offsetTop <= src.scrollTop) line++;
    const v: View = { src: { line, sel: src.selectionStart } };
    const gs = E.groups(), top = right.getBoundingClientRect().top, g = gs.find((x) => x.el.getBoundingClientRect().bottom > top);
    const max = right.scrollHeight - right.clientHeight;
    if (g) v.preview = { anchor: lineAt(t, g.start), dy: Math.round(top - g.el.getBoundingClientRect().top), frac: max > 0 ? right.scrollTop / max : 0 };
    return v;
  };
  // (asked once: its listeners go then, or when the file closes first)
  const ask = viewToRestore(key, right.parentElement ?? right, moved);
  let asked = false;
  const restore = () => (asked ? null : ((asked = true), ask()));
  signal.addEventListener("abort", () => void restore());
  const apply = (v: View | null) => {
    // (done, put back or not: the page test's mark)
    right.dataset.view = "1";
    if (!v) return;
    const s = v.src as View | undefined, p = v.preview as View | undefined;
    if (s) {
      // (the cursor first, the scroll after: placing the cursor can't move the source then)
      const sel = num(s.sel, -1);
      if (sel >= 0 && sel <= src.value.length) src.setSelectionRange(sel, sel);
      const l = hl.children[num(s.line, 0)] as HTMLElement | undefined;
      if (l) src.scrollTop = l.offsetTop;
    }
    if (p) {
      // (the group that began on that line; gone, the fraction; else the top: never an error)
      const t = src.value, g = E.groups().find((x) => lineAt(t, x.start) === num(p.anchor, -1));
      if (g) right.scrollTop += g.el.getBoundingClientRect().top - right.getBoundingClientRect().top + num(p.dy, 0);
      else right.scrollTop = Math.max(0, Math.min(1, num(p.frac, 0))) * (right.scrollHeight - right.clientHeight);
    }
  };
  // (once, after the first layout: now if the preview is already there, else at its first render)
  if (E.groups().length) apply(restore());
  else { const off = E.onRendered(() => { off(); apply(restore()); }); signal.addEventListener("abort", off); }
  const kept = keepView(key, read);
  const changed = () => kept.changed();
  for (const [el, evs] of [[src, ["scroll", "keyup", "click"]], [right, ["scroll"]]] as const)
    for (const e of evs) el.addEventListener(e, changed, { passive: true, signal });
  signal.addEventListener("abort", () => kept.stop());
}
