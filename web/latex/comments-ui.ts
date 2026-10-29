// What the preview's comments share (cut 1's frozen threads, comments.ts; a document's live ones, comments-doc.ts): the
// style, the highlight registry (CSS Custom Highlight API: no element is added to the preview or the source, so their
// patching is undisturbed), and finding a quote in rendered text.
export const QUOTE = 300, CONTEXT = 32, MARGIN_MIN = 760;
export const CSS = `
::highlight(sb-comments) { background-color: rgba(255, 205, 40, .45); }
::highlight(sb-comment-active) { background-color: rgba(255, 150, 0, .6); }
.sb-cm-layer { position: absolute; top: 0; left: 0; right: 0; height: 0; z-index: 5; }
.tex-right.sb-cm-margin { padding-right: 236px; }
.sb-cm-bubble { position: absolute; right: 8px; width: 212px; box-sizing: border-box; background: #fffbea; border: 1px solid #e6c95a; border-radius: 8px; padding: 6px 8px; font: 13px/1.35 system-ui, sans-serif; color: #222; box-shadow: 0 1px 3px rgba(0,0,0,.15); cursor: pointer; white-space: pre-wrap; overflow-wrap: anywhere; }
.sb-cm-bubble.active { border-color: #e08a00; box-shadow: 0 0 0 2px rgba(224,138,0,.35); }
.sb-cm-bubble .sb-cm-who { font-size: 11px; opacity: .65; margin-bottom: 2px; }
.sb-cm-badge { position: absolute; min-width: 22px; height: 22px; padding: 0 5px; border-radius: 11px; background: #e08a00; color: #fff; font: bold 12px/22px system-ui, sans-serif; text-align: center; border: 0; cursor: pointer; box-shadow: 0 1px 3px rgba(0,0,0,.3); }
.sb-cm-sheet { position: fixed; left: 0; right: 0; bottom: 0; max-height: 60vh; overflow: auto; background: #fff; border-top: 1px solid #ccc; box-shadow: 0 -2px 8px rgba(0,0,0,.2); padding: 12px 14px calc(12px + env(safe-area-inset-bottom)); z-index: 2147483000; font: 14px/1.4 system-ui, sans-serif; }
.sb-cm-pop { position: absolute; z-index: 20; width: 260px; max-width: calc(100vw - 24px); background: #fff; border: 1px solid #c8ccc9; border-radius: 8px; padding: 8px; box-shadow: 0 2px 10px rgba(0,0,0,.2); font: 13px system-ui, sans-serif; }
.sb-cm-pop textarea, .sb-cm-sheet textarea { width: 100%; box-sizing: border-box; min-height: 64px; font: 13px/1.4 system-ui, sans-serif; }
.sb-cm-row { display: flex; gap: 6px; justify-content: flex-end; margin-top: 6px; }
.sb-cm-row button, .sb-cm-go { min-height: 32px; padding: 0 10px; }
.sb-cm-go { position: absolute; z-index: 1000; border-radius: 6px; border: 1px solid #c8a33a; background: #fff4cc; font: 13px system-ui, sans-serif; cursor: pointer; }
.sb-cm-bubble.agent, .sb-cm-msg.agent { border-left: 4px solid #6a5acd; }
.sb-cm-agent { display: inline-block; margin-left: 4px; padding: 0 4px; border-radius: 3px; background: #ece9ff; color: #4b3fb0; font-size: 10px; text-transform: uppercase; letter-spacing: .03em; }
.sb-cm-note { font-size: 11px; color: #8a5a00; margin: 2px 0; }
.sb-cm-msg { padding: 4px 6px; margin: 4px 0; background: #fafafa; border-radius: 4px; white-space: pre-wrap; overflow-wrap: anywhere; }
.sb-cm-quote { font-size: 12px; color: #555; border-left: 3px solid #e6c95a; padding-left: 6px; margin: 2px 0 6px; white-space: pre-wrap; overflow-wrap: anywhere; max-height: 4.5em; overflow: hidden; }
.sb-cm-err { color: #b00020; font-size: 12px; margin-top: 4px; }
.sb-cm-list { position: fixed; top: 0; right: 0; bottom: 0; width: min(380px, 100vw); overflow: auto; background: #fff; border-left: 1px solid #ccc; box-shadow: -2px 0 8px rgba(0,0,0,.15); padding: 10px 12px; z-index: 2147483000; font: 13px/1.4 system-ui, sans-serif; box-sizing: border-box; }
.sb-cm-list h3 { font-size: 13px; margin: 12px 0 4px; }
.sb-cm-item { border: 1px solid #e3e3e3; border-radius: 6px; padding: 6px 8px; margin: 6px 0; cursor: pointer; }
.sb-cm-item.agent { border-left: 4px solid #6a5acd; }
.sb-cm-pop.sb-cm-thread, .sb-cm-sheet.sb-cm-thread { max-height: 70vh; overflow: auto; }
.sb-cm-pop.sb-cm-thread { width: 300px; }
`;
// (both comment chunks may be on one page: one style element, one registry, kept on the window)
export const ensureStyle = () => { if (document.getElementById("sb-cm-style")) return; const st = document.createElement("style"); st.id = "sb-cm-style"; st.textContent = CSS; document.head.appendChild(st); };
// (the highlight names are one per document: every attached instance's ranges, joined)
export const regs: Map<object, { all: Range[]; act: Range[] }> = ((globalThis as any).__sbCommentRegs ??= new Map());
export const paint = () => {
  const hl = (globalThis as any).CSS?.highlights as Map<string, any> | undefined, HL = (globalThis as any).Highlight;
  if (!hl || !HL) return;
  const all: Range[] = [], act: Range[] = [];
  for (const r of regs.values()) { all.push(...r.all); act.push(...r.act); }
  hl.set("sb-comments", new HL(...all)); hl.set("sb-comment-active", new HL(...act));
};
export const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

export const el = (tag: string, cls = "", text = "") => { const e = document.createElement(tag); if (cls) e.className = cls; if (text) e.textContent = text; return e; };

// the text nodes under el, and a DOM Range for the first occurrence of `want` in their joined text (whitespace runs
// matched loosely), else null
export function rangeIn(el: HTMLElement, want: string): Range | null {
  const nodes: Text[] = [], starts: number[] = [];
  let all = "";
  const tw = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let n = tw.nextNode() as Text | null; n; n = tw.nextNode() as Text | null) { starts.push(all.length); nodes.push(n); all += n.data; }
  const w = want.trim();
  if (!w) return null;
  const re = new RegExp(w.split(/\s+/).map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+"));
  const m = re.exec(all);
  if (!m) return null;
  const at = (off: number): [Text, number] => { let k = starts.length - 1; while (k > 0 && starts[k] > off) k--; return [nodes[k], off - starts[k]]; };
  const r = document.createRange();
  const [sn, so] = at(m.index), [en, eo] = at(m.index + m[0].length);
  r.setStart(sn, so); r.setEnd(en, Math.min(eo, en.data.length));
  return r;
}

