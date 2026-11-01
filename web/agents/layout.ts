// The agents page's layout (web/agents): the body classes that place the chat, the artifact pane and full screen, and
// the two resizable columns (the chat list and the artifact pane; William A1 + A10, the layout plan r3 PR 2).
// Widths are two CSS variables on body, --sb-side-w and --sb-pane-w, which index.html reads only above 900 px and
// outside full screen, so the narrow overlay and full screen keep their own layout. Nothing here sets a width.
import type { Artifact } from "./events";

/** The pane-state classes on body: an artifact shown, and full screen. (A notebook no longer widens its pane: A10.) */
export function applyPaneClasses(a: Artifact | undefined, fullscreen: boolean) {
  document.body.classList.toggle("has-artifact", !!a);
  document.body.classList.toggle("fullscreen", !!a && fullscreen);
}

export const LAYOUT_KEY = "sb-agents-layout-v1";
const SIDE = { min: 180, max: 480, default: 250 };
const CHAT_MIN = 420;
const PANE_MIN = 320;
const WIDE = 901; // (the narrow overlay is 900 px and below: index.html's @media)
const STEP = 16;

type Stored = { side: number; pane: number };

/** A stored layout, or null: exactly {side, pane}, two finite numbers in 0..4096; any other shape is ignored whole. */
export function parseLayout(raw: string | null): Stored | null {
  if (raw == null) return null;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const keys = Object.keys(v).sort();
  if (keys.length !== 2 || keys[0] !== "pane" || keys[1] !== "side") return null;
  const { side, pane } = v as Record<string, unknown>;
  const ok = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 4096;
  return ok(side) && ok(pane) ? { side, pane } : null;
}

function readStored(): Stored | null {
  try {
    return parseLayout(localStorage.getItem(LAYOUT_KEY));
  } catch {
    return null; // (storage unavailable: the defaults)
  }
}

// what the person asked for (null: the default), and what is shown after the clamps
let want: { side: number | null; pane: number | null } = { side: null, pane: null };
let shown = { side: SIDE.default, pane: 0, sideMax: SIDE.max, paneMax: 0, collapsed: false, open: false };

// (the test seam, only with ?layout-test in the URL: the animation-frame function and the counts of applies and writes)
let frame: (cb: () => void) => unknown = (cb) => requestAnimationFrame(cb);
const stats = { applies: 0, writes: 0 };

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** The widths for this window: the chat keeps 420 px first, the pane 320, and the sidebar gets what it can (180-480);
 * when 180 + 420 + 320 doesn't fit beside an open pane, the sidebar collapses to the narrow overlay's. */
function compute() {
  const vw = innerWidth;
  const b = document.body.classList;
  const open = b.contains("has-artifact") && !b.contains("fullscreen");
  const collapsed = open && vw >= WIDE && vw < SIDE.min + CHAT_MIN + PANE_MIN;
  const sideMax = Math.max(SIDE.min, Math.min(SIDE.max, vw - CHAT_MIN - (open ? PANE_MIN : 0)));
  const side = clamp(want.side ?? SIDE.default, SIDE.min, sideMax);
  const room = vw - (collapsed ? 0 : side) - CHAT_MIN;
  const paneMax = Math.max(PANE_MIN, room);
  const pane = clamp(want.pane ?? Math.min(0.46 * vw, 760), PANE_MIN, paneMax);
  return { side, pane, sideMax, paneMax, collapsed, open };
}

/** Clamp and show: the two variables, the collapse class and the separators' values. */
function apply() {
  stats.applies++;
  shown = compute();
  const s = document.body.style;
  s.setProperty("--sb-side-w", `${shown.side}px`);
  s.setProperty("--sb-pane-w", `${shown.pane}px`);
  document.body.classList.toggle("side-collapsed", shown.collapsed);
  setAria(sepSide, shown.side, SIDE.min, shown.sideMax);
  setAria(sepPane, shown.pane, PANE_MIN, shown.paneMax);
}

function setAria(el: HTMLElement | null, now: number, min: number, max: number) {
  if (!el) return;
  el.setAttribute("aria-valuenow", String(Math.round(now)));
  el.setAttribute("aria-valuemin", String(min));
  el.setAttribute("aria-valuemax", String(Math.round(max)));
}

// one layout update per animation frame: pointer moves and window resizes only record the latest request
let scheduled = false;
function schedule() {
  if (scheduled) return;
  scheduled = true;
  frame(() => {
    if (!scheduled) return; // (already applied: a drag's end flushed it)
    scheduled = false;
    apply();
  });
}
function flush() {
  if (scheduled) {
    scheduled = false;
    apply();
  }
}

/** Save what is shown: once, at a drag's end or a key's release. */
function commit() {
  stats.writes++;
  try {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify({ side: Math.round(shown.side), pane: Math.round(shown.pane) }));
  } catch {
    // (storage unavailable or full: the layout still works for this page)
  }
}

let sepSide: HTMLElement | null = null;
let sepPane: HTMLElement | null = null;

/** A separator: drag (pointer capture), arrow keys move it 16 px, Home and End go to the minimum and the maximum. */
function wire(sep: HTMLElement, which: "side" | "pane") {
  const toWidth = (x: number) => (which === "side" ? x : innerWidth - x);
  sep.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    sep.setPointerCapture(e.pointerId);
    document.body.classList.add("sb-dragging");
    const move = (m: PointerEvent) => {
      want = { ...want, [which]: toWidth(m.clientX) };
      schedule();
    };
    const end = () => {
      sep.removeEventListener("pointermove", move);
      sep.removeEventListener("pointerup", end);
      sep.removeEventListener("pointercancel", end);
      document.body.classList.remove("sb-dragging");
      flush();
      want = { ...want, [which]: which === "side" ? shown.side : shown.pane };
      commit();
    };
    sep.addEventListener("pointermove", move);
    sep.addEventListener("pointerup", end);
    sep.addEventListener("pointercancel", end);
  });
  let keyed = false;
  sep.addEventListener("keydown", (e) => {
    const cur = which === "side" ? shown.side : shown.pane;
    const [min, max] = which === "side" ? [SIDE.min, shown.sideMax] : [PANE_MIN, shown.paneMax];
    // (the arrows move the separator: right widens the chat list, left widens the pane)
    const grow = which === "side" ? "ArrowRight" : "ArrowLeft";
    const shrink = which === "side" ? "ArrowLeft" : "ArrowRight";
    let next: number | null = null;
    if (e.key === grow) next = cur + STEP;
    else if (e.key === shrink) next = cur - STEP;
    else if (e.key === "Home") next = min;
    else if (e.key === "End") next = max;
    if (next == null) return;
    e.preventDefault();
    want = { ...want, [which]: clamp(next, min, max) };
    apply();
    keyed = true;
  });
  sep.addEventListener("keyup", () => {
    if (!keyed) return;
    keyed = false;
    commit();
  });
}

/** Mount the layout: the stored widths, the separators, and a re-clamp on every window resize. */
export function mountLayout() {
  if (new URLSearchParams(location.search).has("layout-test")) {
    (window as unknown as { __sbLayout: unknown }).__sbLayout = { stats, setFrame: (f: typeof frame) => (frame = f) };
  }
  const s = readStored();
  if (s) want = { side: s.side, pane: s.pane };
  sepSide = document.getElementById("sep-side");
  sepPane = document.getElementById("sep-pane");
  if (sepSide) wire(sepSide, "side");
  if (sepPane) wire(sepPane, "pane");
  addEventListener("resize", schedule);
  apply();
}

/** Re-clamp now: after the pane opens or closes (renderArtifacts, an agent's own open too) or the sidebar toggles. */
export function relayout() {
  scheduled = false;
  apply();
}
