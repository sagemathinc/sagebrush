// The LaTeX editor's @interact (a Sagebrush extension, William Nov 8: "@interact inside sagesilent/sageblock as a
// documented Sagebrush extension"; upstream SageTeX and Sage 10.10 raise NameError on it): a chunk of its own,
// /sagebrush-latex-interact.js, fetched only once a preview has an interact (sagetex.mjs interactsAt's placeholder, its
// interacts as escaped JSON). Each is drawn with its controls at their defaults, not live here, what its function
// printed and showed at those values, and a line saying it is interactive in Sagebrush (William's Q2: the PDF shows it
// so). Everything from the results file reaches the HTML through esc(); a shown plot only as a base64 SVG data URL
// (DATA_SVG), as \sageplot's.
import { DATA_SVG, STALE_TITLE, utf8len } from "./engine/sagetex.mjs";

// ---- an item's @interacts, as the Run's session printed them (run-core's driver), checked before the results file
// holds them, as a result is (this chunk's, so Run's own carries only the driver: daybreak2's SIZE design, Beamer plan PR
// 3): at most INTERACT_LIMITS.n an item, each with its controls (only the fields drawn, by kind), what its function
// printed at the defaults (bounded) and what it showed (a plot only as an SVG, as \sageplot's; text bounded)
export const INTERACT_LIMITS = { n: 8, controls: 20, shows: 4, text: 4000, options: 50, label: 200, svg: 2 * 2 ** 20 };   // (svg: Run's RUN_LIMITS.svg)
const CONTROL_KINDS = new Set(["slider", "range", "selector", "checkbox", "input", "color", "text", "button"]);
const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const str = (v: unknown, n: number) => (typeof v === "string" ? v.slice(0, n) : undefined);
const b64 = (s: string) => {
  const u = new TextEncoder().encode(s);
  let t = "";
  for (let i = 0; i < u.length; i += 0x8000) t += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(t);
};
function controlOf(c: any): Record<string, unknown> | null {
  if (!c || typeof c !== "object" || !CONTROL_KINDS.has(c.kind)) return null;
  const L = INTERACT_LIMITS.label;
  const o: Record<string, unknown> = { kind: c.kind, name: str(c.name, L) ?? "", label: str(c.label, L) ?? str(c.name, L) ?? "" };
  for (const k of ["min", "max", "step"]) if (num(c[k])) o[k] = c[k];
  const v = c.value;
  if (typeof v === "boolean" || num(v)) o.value = v;
  else if (typeof v === "string") o.value = v.slice(0, L);
  else if (Array.isArray(v) && v.length === 2 && v.every(num)) o.value = [v[0], v[1]];
  for (const k of ["labels", "options"]) if (Array.isArray(c[k])) o[k] = c[k].slice(0, INTERACT_LIMITS.options).map((x: unknown) => String(x).slice(0, L));
  if (typeof c.text === "string") o.text = c.text.slice(0, L);
  return o;
}
export function interactsOf(list: unknown) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, INTERACT_LIMITS.n).filter((x: any) => x && typeof x === "object" && x.spec && typeof x.spec === "object").map((x: any) => ({
    id: Number.isInteger(x.spec.id) ? x.spec.id : 0,
    name: str(x.spec.name, INTERACT_LIMITS.label) ?? "",
    controls: (Array.isArray(x.spec.controls) ? x.spec.controls : []).slice(0, INTERACT_LIMITS.controls).map(controlOf).filter(Boolean),
    out: str(x.out, INTERACT_LIMITS.text) ?? "",
    shows: (Array.isArray(x.shows) ? x.shows : []).slice(0, INTERACT_LIMITS.shows).map((sh: any) => {
      const svg = typeof sh?.svg === "string" ? sh.svg : null;
      if (svg !== null) return utf8len(svg) <= INTERACT_LIMITS.svg && /^\s*(<\?xml[^>]*>\s*)?<svg[\s>]/.test(svg) ? { src: "data:image/svg+xml;base64," + b64(svg) } : { text: "(a plot that can't be shown)" };
      return { text: str(sh?.text, INTERACT_LIMITS.text) ?? "" };
    }),
  }));
}

const NOTE = "Interactive in Sagebrush";
const CSS_ID = "sb-tex-interact-style";
const CSS = `
.tex-page .sageinteract{border:1px solid #c8c8d0;border-radius:4px;padding:.3em .6em;margin:.4em 0}
.tex-page .sageinteract .si-c{display:inline-flex;align-items:center;gap:.3em;margin-right:1.2em}
.tex-page .sageinteract .si-out{margin:.3em 0}
.tex-page .si-note{font-size:.7em;color:#777}
`;
const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (s: unknown) => String(s).replace(/[&<>"']/g, (c) => ESC[c]);
const attrNum = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? String(v) : "");

// (each control names itself, data-name and data-kind, so a live one's value can be read back; a range is two inputs)
function controlHtml(c: any): string {
  if (!c || typeof c !== "object") return "";
  // (a "text" control, text_control's or fixed's, is a line of text, as the notebook draws it: no label, no box)
  if (c.kind === "text") return c.value ? '<div class="si-t">' + esc(String(c.value)) + "</div>" : "";
  const label = '<span class="si-l">' + esc(String(c.label ?? c.name ?? "").slice(0, 200)) + "</span>";
  const v = c.value, attrs = ' data-name="' + esc(String(c.name ?? "")) + '" data-kind="' + esc(String(c.kind)) + '"';
  const rng = (x: unknown, b = "") => '<input type="range" disabled' + b + ' min="' + attrNum(c.min) + '" max="' + attrNum(c.max) + '" step="' + attrNum(c.step) + '" value="' + attrNum(x) + '">';
  let w: string;
  if (c.kind === "slider") {
    const shown = Array.isArray(c.labels) && typeof v === "number" && c.labels[v] !== undefined ? c.labels[v] : v;
    w = rng(v) + '<span class="si-v">' + esc(String(shown ?? "")) + "</span>";
  } else if (c.kind === "range") {
    const [a, b] = Array.isArray(v) ? v : [c.min, c.max];
    w = rng(a) + rng(b, ' data-hi="1"') + '<span class="si-v">' + esc(String(a) + " to " + String(b)) + "</span>";
  } else if (c.kind === "selector") {
    const opts = Array.isArray(c.options) ? c.options : [];
    w = "<select disabled>" + opts.map((o: unknown, i: number) => '<option value="' + i + '"' + (i === v ? " selected" : "") + ">" + esc(String(o)) + "</option>").join("") + "</select>";
  } else if (c.kind === "checkbox") w = '<input type="checkbox" disabled' + (v === true ? " checked" : "") + ">";
  else if (c.kind === "button") w = '<button disabled data-clicks="0">' + esc(String(c.text ?? c.label ?? "")) + "</button>";
  else if (c.kind === "color" && typeof v === "string" && /^#[0-9a-fA-F]{6}$/.test(v)) w = '<input type="color" disabled value="' + esc(v) + '">';
  else w = '<input type="text" disabled value="' + esc(String(v ?? "")) + '">';
  return '<label class="si-c"' + attrs + ">" + label + " " + w + "</label>";
}

/** An item's interacts (run-core interactsOf's shape) as HTML: each drawn, not live (live(): live). */
export function interactsHtml(list: unknown, stale = false): string {
  if (!Array.isArray(list)) return "";
  return list.slice(0, 8).map((x: any) => {
    if (!x || typeof x !== "object") return "";
    const controls = (Array.isArray(x.controls) ? x.controls : []).slice(0, 20).map(controlHtml).join("");
    const out = typeof x.out === "string" && x.out ? '<pre class="si-out">' + esc(x.out.slice(0, 4000)) + "</pre>" : "";
    const shows = (Array.isArray(x.shows) ? x.shows : []).slice(0, 4).map((sh: any) =>
      typeof sh?.src === "string" && DATA_SVG.test(sh.src) ? '<img class="sageplot" alt="a plot" src="' + sh.src + '">'
        : typeof sh?.text === "string" && sh.text ? '<pre class="si-out">' + esc(sh.text.slice(0, 4000)) + "</pre>" : "").join("");
    return '<div class="sageinteract' + (stale ? ' sagestale" title="' + esc(STALE_TITLE) : "") + '" data-iid="' + (Number.isInteger(x.id) ? x.id : 0) + '"><div class="si-controls">' + controls + '</div><div class="si-outs">' + out + shows + '</div><div class="si-note">' + NOTE + "</div></div>";
  }).join("");
}

/** Draws every placeholder under `root` not drawn yet (its interacts, from its data), then makes live those a Run of
 * `s`'s session made (`ids`, live()); how many it drew. */
export function draw(root: ParentNode, s: InteractSession | null = null, ids: RunIds = new Set()): number {
  let n = 0;
  for (const at of Array.from(root.querySelectorAll<HTMLElement>(".sageinteract-at:not([data-drawn])"))) {
    let list: unknown = [];
    try { list = JSON.parse(at.dataset.ia ?? "[]"); } catch {}
    at.innerHTML = interactsHtml(list, at.dataset.stale === "1");
    at.dataset.drawn = "1";
    n++;
  }
  if (n && !document.getElementById(CSS_ID)) { const st = document.createElement("style"); st.id = CSS_ID; st.textContent = CSS; document.head.appendChild(st); }
  live(root, s, ids);
  return n;
}

// ---- live (the Beamer plan's PR 4): an interact a Run of this page's session made (`ids`) gets its controls live; a
// change runs its function again in that session (the kernel's interact(): web/notebook/worker-kernel.js, Python's
// _interact._update), one request at a time, the latest values next, and what it prints and shows replaces its output
// (the kernel's targetSink: output addressed to it). Every copy of it on the page (the preview's, Present's) shows the
// same values and output, kept here, so a widget drawn again (a redraw, Present's copy) is put back as it was. One whose
// session is gone (a reload: its results from the file) stays as drawn, saying to run the code first.
// What is live belongs to one Run (astra, #937): its ids (a new Set each Run, run-core's interactIds, with the kernel's
// generation then), in the document it was of (the page gives no ids for another, and marks them `over` when it leaves
// the document). A new Run, another document or the interpreter started again (a new generation: its interacts are
// gone) ends it: its values and output dropped, a
// request of it not sent, output addressed to it not shown. A request is sent in the session's turn (serial), as a Run
// is, so it never runs while a Run puts another folder in; output goes only to the request running, checked at each
// delivery. A new Run ends the last one as it starts (page.ts), before it takes the session's turn. Present shows its
// copy with the controls disabled (present.ts): its values and output follow the preview's.
/** The part of the LaTeX session's kernel (WorkerKernel) live interacts use. */
export interface InteractKernel { generation: number; on?(e: string, f: () => void): unknown; interact(iid: number, values: Record<string, unknown>, sink: object): void; targetSink: (t: number) => object | null }
/** The LaTeX session (run-core sessionOf): its kernel once started, and its turn. */
export interface InteractSession { kernel: InteractKernel | null; serial: (fn: () => Promise<void>) => Promise<unknown> }
export type RunIds = Set<number> & { gen?: number; over?: number };
const NOT_LIVE = "Run the code (Shift+Enter) to use these controls";
type State = { values: Record<string, unknown>; outs: string | null; busy: boolean; dirty: boolean; fresh: boolean };
const states = new Map<number, State>();
// (the elements given listeners, so a later live() over the same element doesn't wire it twice)
const wired = new WeakSet<HTMLElement>();
let hooked: InteractKernel | null = null, run: RunIds | null = null, cur: { iid: number; st: State } | null = null;
/** Requests sent to the kernel so far (the page test's count). */
export let sent = 0;
// (a state still the one of the Run live now, its interpreter still the Run's)
const ours = (k: InteractKernel, iid: number, st: State) => states.get(iid) === st && !run?.over && run?.gen === k.generation;
// (a widget whose Run is over: as drawn, saying to run the code first)
function dead(w: HTMLElement) { delete w.dataset.live; w.title = NOT_LIVE; for (const el of Array.from(w.querySelectorAll<HTMLInputElement>("input,select,button"))) el.disabled = true; }
// (a shown value, as the runtime's display gives it: an SVG or PNG image, else its text; never HTML)
function bundleHtml(b: any): string {
  const svg = b?.["image/svg+xml"];
  if (typeof svg === "string" && utf8len(svg) <= INTERACT_LIMITS.svg && /^\s*(<\?xml[^>]*>\s*)?<svg[\s>]/.test(svg)) return '<img class="sageplot" alt="a plot" src="data:image/svg+xml;base64,' + b64(svg) + '">';
  const png = b?.["image/png"];
  if (typeof png === "string" && png.length <= INTERACT_LIMITS.svg && /^[A-Za-z0-9+/=\s]+$/.test(png)) return '<img class="sageplot" alt="a plot" src="data:image/png;base64,' + png.replace(/\s/g, "") + '">';
  const t = b?.["text/plain"];
  return typeof t === "string" && t ? '<pre class="si-out">' + esc(t.slice(0, INTERACT_LIMITS.text)) + "</pre>" : "";
}
const copies = (iid: number) => Array.from(document.querySelectorAll<HTMLElement>('.sageinteract[data-live="1"][data-iid="' + iid + '"]'));
function showOuts(iid: number) { const st = states.get(iid); if (st && st.outs !== null) for (const w of copies(iid)) { const o = w.querySelector(".si-outs"); if (o) o.innerHTML = st.outs; } }
// (a control's value as Python's convert() takes it, as the notebook sends it: a slider's number (a labels slider's
//  index), a range's [lo, hi], a selector's index, a checkbox's bool, a button's clicks, text as typed)
function read(w: HTMLElement): Record<string, unknown> {
  const v: Record<string, unknown> = {};
  for (const c of Array.from(w.querySelectorAll<HTMLElement>(".si-c[data-name]"))) {
    const name = c.dataset.name ?? "", kind = c.dataset.kind;
    const inp = c.querySelector<HTMLInputElement>("input"), sel = c.querySelector<HTMLSelectElement>("select"), btn = c.querySelector<HTMLButtonElement>("button");
    if (kind === "slider" && inp) v[name] = +inp.value;
    else if (kind === "range") { const [a, b] = Array.from(c.querySelectorAll<HTMLInputElement>("input")).map((x) => +x.value); v[name] = [Math.min(a, b), Math.max(a, b)]; }
    else if (kind === "selector" && sel) v[name] = +sel.value;
    else if (kind === "checkbox" && inp) v[name] = inp.checked;
    else if (kind === "button" && btn) v[name] = +(btn.dataset.clicks ?? 0);
    else if (inp) v[name] = inp.value;
  }
  return v;
}
// (values put into a copy's controls: its inputs' current values, not their attributes, so a clone needs them again)
function apply(w: HTMLElement, values: Record<string, unknown>) {
  for (const c of Array.from(w.querySelectorAll<HTMLElement>(".si-c[data-name]"))) {
    const x = values[c.dataset.name ?? ""], kind = c.dataset.kind;
    if (x === undefined) continue;
    const inputs = Array.from(c.querySelectorAll<HTMLInputElement>("input")), sel = c.querySelector<HTMLSelectElement>("select"), btn = c.querySelector<HTMLButtonElement>("button");
    if (kind === "range" && Array.isArray(x)) inputs.forEach((i, k) => (i.value = String(x[k])));
    else if (kind === "checkbox" && inputs[0]) inputs[0].checked = x === true;
    else if (sel) sel.value = String(x);
    else if (btn) btn.dataset.clicks = String(x);
    else if (inputs[0]) inputs[0].value = String(x);
    const show = c.querySelector(".si-v");
    if (show && kind === "slider") show.textContent = String(x);
    if (show && kind === "range" && Array.isArray(x)) show.textContent = x[0] + " to " + x[1];
  }
}
function send(s: InteractSession, k: InteractKernel, iid: number, st: State) {
  if (st.busy) { st.dirty = true; return; }
  st.busy = true;
  void s.serial(() => new Promise<void>((res) => {
    if (!ours(k, iid, st)) { st.busy = false; return res(); }
    st.dirty = false; st.fresh = true; cur = { iid, st }; sent++;
    const done = () => { if (cur?.st === st) cur = null; st.busy = false; res(); if (st.dirty && ours(k, iid, st)) send(s, k, iid, st); };
    k.interact(iid, st.values, {
      start() {}, out() {}, display() {}, interact() {}, clear() {}, input(_p: string, reply: (v: null) => void) { reply(null); },
      done, skipped: done,
      stopped(m: string) { if (ours(k, iid, st)) { st.outs = '<pre class="si-out">' + esc(String(m ?? "").trim().slice(0, 400)) + "</pre>"; showOuts(iid); } done(); },
    });
  }));
}
// (output addressed to a live interact: the first of a request's starts its output afresh)
function sinkFor(iid: number) {
  const st = cur?.iid === iid && hooked && ours(hooked, iid, cur.st) ? cur.st : null;
  if (!st) return null;
  const add = (h: string) => { if (st.fresh) { st.outs = ""; st.fresh = false; } st.outs = ((st.outs ?? "") + h).slice(-8 * INTERACT_LIMITS.svg); showOuts(iid); };
  return {
    start() {}, interact() {}, input(_p: string, reply: (v: null) => void) { reply(null); },
    out(t: string) { add('<pre class="si-out">' + esc(String(t).slice(0, INTERACT_LIMITS.text)) + "</pre>"); },
    display(b: unknown) { add(bundleHtml(b)); },
    clear() { st.outs = ""; st.fresh = false; showOuts(iid); },
  };
}
/** Makes live, under `root`, every drawn interact whose id the Run `ids` of `s`'s session made, in its interpreter;
 * the others say to run the code first. Copies drawn again get the values and output kept for their interact. */
export function live(root: ParentNode, s: InteractSession | null, ids: RunIds): number {
  const k = s?.kernel ?? null;
  // (the interpreter started again: every live widget shown dead at once (agents-ui's n2))
  if (k && hooked !== k) { hooked = k; k.targetSink = (t: number) => sinkFor(+t); k.on?.("ready", () => document.querySelectorAll<HTMLElement>(".sageinteract[data-live]").forEach(dead)); }
  if (ids !== run) { run = ids; states.clear(); }
  let n = 0;
  for (const w of Array.from(root.querySelectorAll<HTMLElement>(".sageinteract[data-iid]"))) {
    const iid = +(w.dataset.iid ?? 0);
    if (!s || !k || ids.over || ids.gen !== k.generation || !ids.has(iid) || w.classList.contains("sagestale")) { if (w.dataset.live) dead(w); else if (!w.title) w.title = NOT_LIVE; continue; }
    if (!states.has(iid)) states.set(iid, { values: read(w), outs: null, busy: false, dirty: false, fresh: false });
    const st = states.get(iid)!;
    if (!wired.has(w)) {
      wired.add(w); w.dataset.live = "1"; w.removeAttribute("title");
      for (const el of Array.from(w.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>("input,select,button"))) el.disabled = false;
      const changed = () => { if (!ours(k, iid, st)) return apply(w, st.values), dead(w); st.values = read(w); for (const c of copies(iid)) if (c !== w) apply(c, st.values); apply(w, st.values); send(s, k, iid, st); };
      // (text runs on change (Enter, or leaving it), as the notebook's (agents-ui's A1); the others as they move)
      const text = (e: Event) => (e.target as HTMLInputElement).type === "text";
      w.addEventListener("input", (e) => { if (!text(e)) changed(); });
      w.addEventListener("change", (e) => { if (text(e)) changed(); });
      w.addEventListener("click", (ev) => { const b = (ev.target as HTMLElement).closest?.("button[data-clicks]") as HTMLButtonElement | null; if (b) { b.dataset.clicks = String(+(b.dataset.clicks ?? 0) + 1); changed(); } });
    }
    apply(w, st.values);
    if (st.outs !== null) { const o = w.querySelector(".si-outs"); if (o) o.innerHTML = st.outs; }
    n++;
  }
  return n;
}
