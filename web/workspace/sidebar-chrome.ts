// The files sidebar's chrome, shared by the notebook page (index.html) and the board page (board/page.ts):
//  - the button that shows and hides it: Sagebrush's logo and an arrow (‹ when open, › when closed), as CoCalc's
//    project sidebar has, in place of a "Files" text button (William, Nov 1: B3);
//  - a handle on its right edge that resizes it: dragged, or with the arrow keys when focused (Home and End for the
//    narrowest and widest, a double click back to the default), the width remembered in this browser.
// On a phone the sidebar covers the page, so there is no handle and the width is the page's.

export const FILES_WIDTH = 272;
const MIN = 180, KEY = "sagebrush-files-width";
const max = () => Math.max(MIN, Math.min(640, Math.round(innerWidth * 0.6)));
const phone = () => matchMedia("(max-width: 640px)").matches;
const clamp = (w: number) => Math.max(MIN, Math.min(max(), Math.round(w)));

/** The width the sidebar was left at in this browser (or the default), within today's bounds. */
export function filesWidth(): number {
  let w = FILES_WIDTH;
  try { const s = Number(localStorage.getItem(KEY)); if (Number.isFinite(s) && s > 0) w = s; } catch {}
  return clamp(w);
}

// (the 16 px tab icon: leaf and path, no mesas: William's pick, Oct 31)
const LOGO = `<svg viewBox="0 0 32 32" width="18" height="18" aria-hidden="true" focusable="false"><rect width="32" height="32" rx="6" fill="#AE472A"/><path fill="#FADEB6" d="M4.4 30.8 L7.4 30.8 L10.6 30.6 L13.7 30.2 L16.7 29.6 L19.3 28.8 L21.6 27.7 L23.3 25.9 L23.9 23.4 L22.9 21.3 L21.2 20.1 L19.5 19.4 L17.7 18.9 L16.1 18.4 L14.9 18.0 L14.4 17.6 L14.2 17.1 L14.3 16.8 L14.5 16.4 L14.8 16.1 L15.4 15.6 L16.0 15.2 L16.7 14.8 L17.4 14.3 L18.0 13.7 L18.3 13.3 L18.4 12.8 L18.3 12.4 L18.1 12.0 L17.7 11.7 L17.2 11.6 L16.8 11.7 L16.4 11.9 L15.9 12.3 L15.4 12.6 L14.7 13.0 L13.9 13.5 L13.1 14.0 L12.3 14.8 L11.7 15.8 L11.4 17.3 L11.9 19.2 L13.3 20.5 L14.9 21.4 L16.6 22.0 L18.3 22.6 L19.5 23.2 L20.1 23.7 L20.1 23.8 L20.1 23.9 L19.5 24.3 L18.0 24.9 L15.8 25.4 L13.2 25.7 L10.3 25.8 L7.4 25.8 L4.6 25.6 L3.6 25.8 L2.7 26.3 L2.1 27.1 L1.9 28.1 L2.1 29.1 L2.6 30.0 L3.4 30.6 Z"/><path fill="#BAC49E" d="M16.4 13.8C13.6 8.6 17.6 4.2 28.4 3C28.2 10.4 24 15 16.4 13.8Z"/></svg>`;

// (the button's and the handle's look, added once to the page: the notebook page and the board page both use them)
const CSS = `.sb-filesbtn{display:inline-flex;align-items:center;gap:2px;padding-left:6px;padding-right:6px}
.sb-filesbtn svg{display:block;border-radius:4px}
.sb-filesarrow{font-size:15px;line-height:1;opacity:.7;width:10px;text-align:center}
.sb-filesresize[hidden]{display:none}
.sb-filesresize:hover,.sb-filesresize:focus-visible{background:var(--accent2,#c9d6ff);outline:none}
body.sb-resizing{cursor:col-resize;user-select:none}`;
function addStyle(): void {
  if (document.getElementById("sb-files-chrome")) return;
  const st = document.createElement("style");
  st.id = "sb-files-chrome";
  st.textContent = CSS;
  document.head.append(st);
}

/** Makes `btn` the logo-and-arrow toggle (its id, data attributes and aria-pressed are kept: tests and pages use
 * them). Its accessible name stays "Files". Call setFilesOpen() as the sidebar shows and hides. */
export function filesButton(btn: HTMLButtonElement): void {
  addStyle();
  btn.classList.add("sb-filesbtn");
  btn.innerHTML = `${LOGO}<span class="sb-filesarrow" aria-hidden="true">›</span>`;
  btn.setAttribute("aria-label", "Files");
  setFilesOpen(btn, btn.getAttribute("aria-pressed") === "true");
}

/** The toggle's state: pressed, its arrow and its tooltip. */
export function setFilesOpen(btn: HTMLButtonElement, on: boolean): void {
  btn.setAttribute("aria-pressed", String(on));
  btn.title = on ? "Hide your files" : "Your notebooks, boards and files (in this browser)";
  const a = btn.querySelector(".sb-filesarrow");
  if (a) a.textContent = on ? "‹" : "›";
}

/** A resize handle for `side` (fixed at the left). `apply(width)` lays the page out for a width; it's called on a
 * change and once now. Returns `sync()`, to call as the sidebar shows and hides (the handle follows it). */
export function filesResizer(side: HTMLElement, apply: (width: number) => void): () => void {
  addStyle();
  const h = document.createElement("div");
  h.className = "sb-filesresize";
  h.setAttribute("role", "separator");
  h.setAttribute("aria-orientation", "vertical");
  h.setAttribute("aria-label", "Resize the files sidebar");
  h.setAttribute("aria-controls", side.id || "wssidebar");
  h.tabIndex = 0;
  h.title = "Drag to resize (double-click: back to the default)";
  h.style.cssText = "position:fixed;top:0;bottom:0;width:7px;cursor:col-resize;z-index:31;touch-action:none";
  document.body.append(h);
  let width = filesWidth();
  const set = (w: number, keep = true) => {
    width = clamp(w);
    h.style.left = `${width - 4}px`;
    h.setAttribute("aria-valuemin", String(MIN));
    h.setAttribute("aria-valuemax", String(max()));
    h.setAttribute("aria-valuenow", String(width));
    if (keep) try { localStorage.setItem(KEY, String(width)); } catch {}
    apply(width);
  };
  const sync = () => { h.hidden = side.hidden || phone(); if (!h.hidden) set(width, false); };
  h.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    h.setPointerCapture(e.pointerId);
    document.body.classList.add("sb-resizing");
    const move = (m: PointerEvent) => set(m.clientX);
    const up = () => {
      h.removeEventListener("pointermove", move);
      document.body.classList.remove("sb-resizing");
      dispatchEvent(new Event("resize"));
    };
    h.addEventListener("pointermove", move);
    h.addEventListener("pointerup", up, { once: true });
    h.addEventListener("pointercancel", up, { once: true });
  });
  h.addEventListener("dblclick", () => { set(FILES_WIDTH); dispatchEvent(new Event("resize")); });
  h.addEventListener("keydown", (e) => {
    const step = e.shiftKey ? 64 : 16;
    const to = e.key === "ArrowLeft" ? width - step : e.key === "ArrowRight" ? width + step : e.key === "Home" ? MIN : e.key === "End" ? max() : null;
    if (to === null) return;
    e.preventDefault();
    set(to);
    dispatchEvent(new Event("resize"));
  });
  addEventListener("resize", () => { if (!h.hidden) set(width, false); });
  set(width, false);
  sync();
  return sync;
}
