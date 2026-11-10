// The LaTeX editor's presenter: a beamer document's slides one at a time, full screen, step by step through their
// overlays (overlay.ts), as an audience sees them. A chunk of its own, /sagebrush-latex-present.js, fetched when the
// person (or an agent) presses Present. The slide shown is a copy of the preview's, made again whenever the preview
// is redrawn, so an edit made while presenting shows at once. Each slide is a size container (style.ts), so its
// type scales with the width it is given: no transform.
//   Keys: Right, Down, Page Down, Space, Enter, N: next step (then the next slide); Left, Up, Page Up, Backspace, P:
//   back; Home, End: the first and the last slide; a number then Enter: that slide; F: full screen on and off;
//   Escape: stop; Shift+Enter: run the document's code (opts.onRun), the slide staying as it is shown, its values
//   updated when the Run's results are. A click on the left third goes back, elsewhere forward.
import { applyStep, stepsOf } from "./overlay";

export interface PresentOpts {
  /** The preview's slides, in order, as they are now. */
  slides: () => HTMLElement[];
  /** Calls back after each redraw of the preview; returns a function that stops it. */
  onRendered?: (f: () => void) => () => void;
  /** The slide to start at (1-based), and its step. */
  start?: number;
  step?: number;
  /** Shift+Enter: run the document's code (the page's Run), presenting on. */
  onRun?: () => void;
  /** Full screen (default true; it needs the person's click). */
  fullscreen?: boolean;
  onExit?: () => void;
}
export interface Presenter { at: () => { frame: number; step: number; frames: number; steps: number }; go: (frame: number, step?: number) => void; next: () => void; prev: () => void; stop: () => void; el: HTMLElement }

const CSS = `
.tex-page.tex-present { position: fixed; inset: 0; z-index: 2147483000; display: flex; align-items: center; justify-content: center; background: #000; overflow: hidden; }
.tex-present .tp-stage { position: relative; }
.tex-present .tp-stage > .slide { margin: 0; border: none; box-shadow: none; width: 100%; }
.tex-present .tp-count { position: fixed; right: 14px; bottom: 10px; font: 13px system-ui, sans-serif; color: rgba(255,255,255,.55); pointer-events: none; }
.tex-present.tp-idle { cursor: none; }
.tex-present .tp-count:empty { display: none; }
.tex-present .sagechip.s-notrun { display: none; }
`;

export function present(o: PresentOpts): Presenter {
  const root = document.createElement("div");
  root.className = "tex-page tex-present";
  root.setAttribute("role", "dialog"); root.setAttribute("aria-label", "Presentation"); root.tabIndex = -1;
  const style = document.createElement("style"); style.textContent = CSS; root.appendChild(style);
  const stage = document.createElement("div"); stage.className = "tp-stage"; root.appendChild(stage);
  const count = document.createElement("div"); count.className = "tp-count"; count.setAttribute("aria-live", "polite"); root.appendChild(count);
  document.body.appendChild(root);
  let frame = Math.max(1, o.start ?? 1), step = Math.max(1, o.step ?? 1), typed = "", stopped = false;

  const fit = () => {
    const s = stage.firstElementChild as HTMLElement | null;
    if (!s) return;
    // (the slide's aspect ratio, from its own style; the largest box of that ratio in the window)
    const ar = getComputedStyle(s).aspectRatio.split("/").map(Number), r = ar.length === 2 && ar[0] > 0 && ar[1] > 0 ? ar[0] / ar[1] : 4 / 3;
    const w = Math.min(window.innerWidth, window.innerHeight * r);
    stage.style.width = Math.floor(w) + "px";
  };
  const show = () => {
    const all = o.slides();
    if (!all.length) { stage.textContent = ""; count.textContent = "No slides: this document has no beamer frames."; return; }
    frame = Math.min(Math.max(1, frame), all.length);
    const src = all[frame - 1], steps = stepsOf(src);
    step = Math.min(Math.max(1, step), steps);
    const copy = src.cloneNode(true) as HTMLElement;
    copy.removeAttribute("id");
    // (an @interact's controls, live in the preview, shown here as drawn: disabled (a copy has no listeners))
    copy.querySelectorAll(".sageinteract :is(input, select, button)").forEach((c) => ((c as HTMLInputElement).disabled = true));
    applyStep(copy, step);
    stage.replaceChildren(copy);
    fit();
    count.textContent = `${frame} / ${all.length}` + (steps > 1 ? ` · ${step} / ${steps}` : "");
    root.dataset.frame = String(frame); root.dataset.step = String(step);
  };
  const next = () => { const all = o.slides(); const steps = all[frame - 1] ? stepsOf(all[frame - 1]) : 1; if (step < steps) step++; else if (frame < all.length) { frame++; step = 1; } show(); };
  const prev = () => { const all = o.slides(); if (step > 1) step--; else if (frame > 1) { frame--; step = all[frame - 1] ? stepsOf(all[frame - 1]) : 1; } show(); };
  const go = (f: number, s = 1) => { frame = f; step = s; show(); };
  const stop = () => {
    if (stopped) return;
    stopped = true;
    window.removeEventListener("keydown", onKey, true); window.removeEventListener("resize", fit);
    document.removeEventListener("fullscreenchange", onFs);
    offRendered?.(); clearTimeout(idle);
    if (document.fullscreenElement === root) void document.exitFullscreen().catch(() => {});
    root.remove();
    o.onExit?.();
  };
  const onKey = (ev: KeyboardEvent) => {
    if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
    const k = ev.key;
    let used = true;
    if (/^[0-9]$/.test(k)) typed = (typed + k).slice(-4);
    else if (k === "Enter" && ev.shiftKey) { typed = ""; if (o.onRun) o.onRun(); else used = false; }
    else if (k === "Enter" && typed) { go(+typed); typed = ""; }
    else if (["ArrowRight", "ArrowDown", "PageDown", " ", "Enter", "n", "N"].includes(k)) next();
    else if (["ArrowLeft", "ArrowUp", "PageUp", "Backspace", "p", "P"].includes(k)) prev();
    else if (k === "Home") go(1);
    else if (k === "End") go(o.slides().length || 1);
    else if (k === "f" || k === "F") { if (document.fullscreenElement) void document.exitFullscreen().catch(() => {}); else void root.requestFullscreen?.().catch(() => {}); }
    else if (k === "Escape") stop();
    else used = false;
    if (used) { ev.preventDefault(); ev.stopPropagation(); }
  };
  // (leaving full screen, by Escape or the browser's own control, ends the presentation it began)
  let wasFull = false;
  const onFs = () => { if (document.fullscreenElement === root) wasFull = true; else if (wasFull) stop(); };
  root.addEventListener("click", (ev) => { if (ev.clientX < window.innerWidth / 3) prev(); else next(); });
  let idle: ReturnType<typeof setTimeout> | undefined;
  root.addEventListener("mousemove", () => { root.classList.remove("tp-idle"); clearTimeout(idle); idle = setTimeout(() => root.classList.add("tp-idle"), 2000); });
  window.addEventListener("keydown", onKey, true);
  window.addEventListener("resize", fit);
  document.addEventListener("fullscreenchange", onFs);
  const offRendered = o.onRendered?.(() => { if (!stopped) show(); });
  show();
  root.focus();
  if (o.fullscreen !== false) void root.requestFullscreen?.().catch(() => {});
  return { at: () => { const all = o.slides(); return { frame, step, frames: all.length, steps: all[frame - 1] ? stepsOf(all[frame - 1]) : 1 }; }, go, next, prev, stop, el: root };
}
