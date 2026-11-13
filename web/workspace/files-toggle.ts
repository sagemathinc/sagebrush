// The Files button in the top-left corner of every page (William, Nov 8: "file side panel needs to be ridiculously
// easy to show no matter what ... PUT A BUTTON IN THE UPPER LEFT TO SHOW THE SIDEBAR"): the page's own Files button
// (the notebook page's #wsfilesbtn, the board's), moved out of its toolbar to the window's corner, where it stays
// whatever is open (a notebook, a board, the LaTeX or code editor over the notebook page) and whatever the width.
// One click or Ctrl+B (Cmd+B) shows and hides the files; the page remembers the choice as before
// (localStorage "sagebrush-files-sidebar").  While the files are hidden, each view's top bar starts right of the button
// (body.sbft:not(.wsfiles)); while they are shown, the button sits at the left of their header, beside "Files".

import { mountAccountCorner } from "./signin-cta";

const SVG = "http://www.w3.org/2000/svg";
/** The icon (a window with a side panel), made element by element; the agents page's toggle uses it too. */
export function icon(): SVGSVGElement {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  const part = (tag: string, attrs: Record<string, string>) => {
    const e = document.createElementNS(SVG, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    svg.append(e);
  };
  part("rect", { x: "1.5", y: "2.5", width: "13", height: "11", rx: "1.5", fill: "none", stroke: "currentColor", "stroke-width": "1.3" });
  part("path", { d: "M6 2.5v11", stroke: "currentColor", "stroke-width": "1.3" });
  part("path", { d: "M3 5h1.5M3 7h1.5M3 9h1.5", stroke: "currentColor", "stroke-width": "1.1" });
  return svg;
}

/** The corner button's style, and the room each view's top bar leaves for it (--sbft-w: the button and its margins). */
export const FILES_TOGGLE_CSS = `
body.sbft { --sbft-w: 44px; }
/* (small, as claude.ai's (William, Nov 12): the icon alone, no border; "Files" is its name for screen readers and its
   tooltip, and the panel's header says it beside the button while the files are shown) */
.sb-files-toggle { position: fixed; top: 8px; left: 8px; z-index: 1000; display: inline-grid; place-items: center; width: 32px; height: 32px; padding: 0; border: 0; border-radius: 8px; background: none; color: #5d645f; cursor: pointer; }
.sb-files-toggle:hover { background: rgba(0, 0, 0, .07); color: #1f2421; }
.sb-files-toggle:focus-visible { outline: 2px solid #4a6b49; outline-offset: -2px; }
.sb-files-toggle svg { width: 18px; height: 18px; flex: none; }
.sb-files-toggle .sbft-label { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
:root[data-theme="dark"] .sb-files-toggle { color: #a3aba4; }
:root[data-theme="dark"] .sb-files-toggle:hover { background: rgba(255, 255, 255, .09); color: #f4f6f1; }
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) .sb-files-toggle { color: #a3aba4; }
  :root:not([data-theme="light"]) .sb-files-toggle:hover { background: rgba(255, 255, 255, .09); color: #f4f6f1; }
}
/* (over the LaTeX editor's toolbar, dark green in either theme: a light icon) */
body.sbft:not(.wsfiles):has(.tex-page:not(.tex-embed)) .sb-files-toggle { color: #dfe8d8; }
body.sbft:not(.wsfiles):has(.tex-page:not(.tex-embed)) .sb-files-toggle:hover { background: rgba(255, 255, 255, .14); color: #fff; }
body.sbft:not(.wsfiles):has(.tex-page:not(.tex-embed)) .sb-files-toggle:focus-visible { outline-color: #dfe8d8; }
/* (beside the button, every page's top bar the same height, its name and title on the button's centre line) */
body.sbft:not(.wsfiles) .tex-head, body.sbft:not(.wsfiles) .code-page .code-head, body.sbft:not(.wsfiles) [data-sbb="top"] { min-height: 48px; box-sizing: border-box; }
.sb-files-toggle[hidden] { display: none; }
body.sbft .sbfiles .fh { padding-left: calc(var(--sbft-w) + 4px); padding-top: 8px; min-height: 40px; box-sizing: border-box; }
/* (the header's own word, beside the button, as claude.ai's name beside its toggle) */
body.sbft .sbfiles .fh > b { font-size: 15px; font-weight: 650; }
body.sbft:not(.wsfiles) .tex-head, body.sbft:not(.wsfiles) .code-page .code-head, body.sbft:not(.wsfiles) [data-sbb="top"] { padding-left: calc(var(--sbft-w) + 4px) !important; }
body.sbft .tex-back, body.sbft .code-files { display: none !important; }
/* (a message a page puts at the top of the window, such as "This file isn't here any more") */
body.sbft:not(.wsfiles) > p:first-child, body.sbft:not(.wsfiles) > .sb-files-toggle + p { margin-left: calc(var(--sbft-w) + 12px); }
@media (max-width: 1180px) { body.sbft:not(.wsfiles) > header { padding-left: calc(var(--sbft-w) + 4px); } }
/* (the notebook's name and title at the left, beside the button, as every other page has them, not in the centred
   column: the header the window's width, the cells' column as before) */
@media (min-width: 641px) {
  body.sbft > header { max-width: none; margin: 0; padding-left: 16px; padding-right: 16px; }
  body.sbft:not(.wsfiles) > header { padding-left: calc(var(--sbft-w) + 4px); }
}
@media print { .sb-files-toggle { display: none !important; } }
`;

/** Make `btn` the corner Files button: `toggle` shows or hides the files, `shown` says whether they are shown now. */
export function filesToggle(btn: HTMLButtonElement, toggle: () => void, shown: () => boolean) {
  if (!document.getElementById("sb-files-toggle-css")) {
    const st = document.createElement("style");
    st.id = "sb-files-toggle-css";
    st.textContent = FILES_TOGGLE_CSS;
    document.head.append(st);
  }
  btn.classList.add("sb-files-toggle");
  const label = document.createElement("span");
  label.className = "sbft-label";
  label.textContent = "Files";
  btn.replaceChildren(icon(), label);
  btn.setAttribute("aria-label", "Files");
  btn.setAttribute("aria-controls", "wssidebar");
  const mac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
  btn.title = `Show or hide your files (${mac ? "⌘B" : "Ctrl+B"})`;
  btn.setAttribute("aria-keyshortcuts", mac ? "Meta+B" : "Control+B");
  document.body.prepend(btn);
  document.body.classList.add("sbft");
  // (the account spot while the files are hidden: in the page's own corner where it has one (the notebook page's,
  // also under the LaTeX and code editors), else in a corner of its own: signin-cta.ts)
  if (!document.getElementById("sbcorner")) mountAccountCorner();
  addEventListener("keydown", (ev) => {
    if (ev.defaultPrevented || ev.altKey || ev.shiftKey || !(ev.ctrlKey || ev.metaKey) || ev.key.toLowerCase() !== "b" || btn.hidden) return;
    // (bold, where a rich-text editor has it)
    if ((ev.target as HTMLElement | null)?.closest?.("[contenteditable=''],[contenteditable='true']")) return;
    ev.preventDefault();
    // (the focus moves to the button only from inside the files as they hide, never from the document being edited)
    const inside = !!(document.activeElement as HTMLElement | null)?.closest?.("#wssidebar, .sbfiles");
    toggle();
    if (!shown() && inside) btn.focus();
  });
}
