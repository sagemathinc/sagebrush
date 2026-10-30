// The LaTeX editor as a component (for @sagebrush-sage's "LaTeX proof" answers on the questions site): the editor and
// its live preview in a box of the host's page, with no files, no Save and no title bar. The host keeps the text
// (onChange) and may read the preview's groups and their source ranges, to anchor a grader's annotations.
// Offsets are JS string indices into getText() (UTF-16 code units, as a textarea's selectionStart).
// (in the page module, /sagebrush-latex.js, beside mount(): the worker and the core are shared, not bundled twice)
import { createEditor } from "./editor";
import { PAGE_CSS } from "./style";

export type LatexEditor = {
  getText(): string;
  setText(text: string): void;
  rendered(): Promise<void>;
  previewRoot(): HTMLElement;
  groups(): { el: HTMLElement; start: number; end: number }[];
  sourceRangeOf(range: Range): { start: number; end: number } | null;
  previewRangesOf(start: number, end: number): HTMLElement[];
  on(ev: "rendered", f: () => void): () => void;
  destroy(): void;
};

// (in a box: the page's own rules, under .tex-page, with these on top)
const EMBED_CSS = `
.tex-page.tex-embed { position: relative; inset: auto; left: auto; width: 100%; height: 100%; min-height: 240px; z-index: auto; border: 1px solid #d5d9d6; border-radius: 6px; overflow: hidden; }
body.wsfiles .tex-page.tex-embed { left: auto; }
.tex-page.tex-embed .page { margin: 8px auto; padding: 16px 20px 24px 20px; }
.tex-page.tex-embed .tex-status { padding: 2px 8px; font-size: 12px; min-height: 0; }
@media (max-width: 700px) {
  .tex-page.tex-embed .tex-main { flex-direction: column; }
  .tex-page.tex-embed .tex-left, .tex-page.tex-embed .tex-right { flex: 1 1 50%; display: block; }
  .tex-page.tex-embed .tex-left { border-right: 0; border-bottom: 1px solid #ccc; }
}
.tex-page.tex-embed.tex-only-preview .tex-left { display: none !important; }
`;
let styled = false;

/** The editor in `root` (its children replaced), with `opts.text`. `onChange` is called after the person's edits
 * (debounced, 300 ms; not after the host's own setText); `readOnly` makes the source read only; `layout: "preview"` shows the preview alone (a grader's view). */
export function mountEditor(root: HTMLElement, opts: { text: string; onChange?(text: string): void; readOnly?: boolean; layout?: "split" | "preview" }): LatexEditor {
  if (!styled) {
    styled = true;
    const st = document.createElement("style"); st.textContent = PAGE_CSS + EMBED_CSS; document.head.appendChild(st);
    // (KaTeX's stylesheet, from beside this module)
    if (!document.getElementById("sb-katex")) {
      const link = document.createElement("link"); link.id = "sb-katex"; link.rel = "stylesheet"; link.href = new URL("katex/katex.min.css", import.meta.url).href; document.head.appendChild(link);
    }
  }
  root.textContent = "";
  const box = document.createElement("div"); box.className = "tex-page tex-embed" + (opts.layout === "preview" ? " tex-only-preview" : "");
  const status = document.createElement("div"); status.className = "tex-status"; status.setAttribute("role", "status"); status.setAttribute("aria-live", "polite");
  const main = document.createElement("div"); main.className = "tex-main";
  const left = document.createElement("div"); left.className = "tex-left";
  const right = document.createElement("div"); right.className = "tex-right";
  const preview = document.createElement("div"); preview.className = "page tex-preview";
  right.appendChild(preview); main.append(left, right); box.append(main, status); root.appendChild(box);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const E = createEditor({
    left, right, preview, text: opts.text, readOnly: !!opts.readOnly,
    workerUrl: new URL("sagebrush-latex-worker.js", import.meta.url),
    say: (t) => { status.textContent = t; },
    onEdit: () => { if (!opts.onChange) return; clearTimeout(timer); timer = setTimeout(() => opts.onChange!(E.getText()), 300); },
  });
  return {
    ...viewOf(E),
    setText: (t) => E.setText(t),
    destroy: () => { clearTimeout(timer); E.destroy(); root.textContent = ""; },
  };
}

/** An editor's preview as the comments read it (and as mountEditor's host does): shared by the component and the page. */
export function viewOf(E: ReturnType<typeof createEditor>): Omit<LatexEditor, "setText" | "destroy"> {
  return {
    getText: () => E.getText(),
    // (resolves once the preview shows the text as it is now: at once if it already does)
    rendered: () => new Promise<void>((res) => { if (E.posCurrent()) return res(); const off = E.onRendered(() => { off(); res(); }); }),
    previewRoot: () => E.preview,
    groups: () => E.groups(),
    // a selection in the preview: its group's source range, narrowed to the selected text when that text is found in
    // it (as the double-click does); null while the preview is behind the source, or outside the groups
    sourceRangeOf: (range) => {
      if (!E.posCurrent()) return null;
      const k = E.groupOf(range.startContainer);
      return k < 0 ? null : E.findIn(k, range.toString());
    },
    // the groups whose source ranges meet [start, end) (a point, start === end, meets the group it falls in)
    previewRangesOf: (start, end) => E.groups().filter((g) => (start === end ? g.start <= start && start < g.end : g.start < end && start < g.end)).map((g) => g.el),
    on: (_ev, f) => E.onRendered(f),
  };
}
