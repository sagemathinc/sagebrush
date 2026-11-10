// The terminal panel (plan-bash-shell r8c E5; plan-term-xterm r2.7 PR 2): a bottom dock on the notebook and board
// pages that runs one command at a time through the page's ShellHost with the person principal.  The screen is xterm
// (web/term/xterm-view.ts: the page's shared setup and its OUT-ISO rules), the line is web/shell/line-editor.ts's, and
// every byte reaches xterm through web/shell/term-writer.ts, in order, filtered and charged.
//
// Input (plan §2, astra TX1): xterm's onData is never an input source, so nothing a command prints (a cursor-position
// query's answer, a mouse report) can become a command.  Keys come from the keyboard event itself (xterm's custom key
// handler, which then lets xterm do nothing with them); a paste from the paste event; an input method's text from
// compositionend; a phone keyboard's from the textarea's insertText input after a 229 keydown.  A submitted command is
// always the editor's line, never text read back from the screen.
import css from "./panel.css" with { type: "text" };
import type { HostOutcome, ShellHost } from "./host.ts";
import { FitAddon, Terminal, KEYS, TOOLBAR_CSS, BUTTON_CSS, ensureXtermCss, extraKeysRow, safeTerminal } from "../term/xterm-view.ts";
import { LineEditor, History, HISTORY, utf8Len, type Act, type Key } from "./line-editor.ts";
import { TermWriter, zeroWidthOf, ITEM_MAX } from "./term-writer.ts";

const MIN_H = 120;
/** xterm's retained rows (wrapped rows count) and the screen's largest size (daybreak3 E1) */
export const SCROLLBACK = 6000;
export const MAX_COLS = 500, MAX_ROWS = 200;
/** S1 (E5.4), kept: UTF-8 bytes of a command's output shown, stdout then stderr, with 64 KiB kept for stderr */
export const OUTPUT = Object.freeze({ inBytes: 1 << 20, errReserve: 65536 });
// (the editor's line is drawn in full up to this size; past it, as one summary line)
const SHOW_UNITS = 4096, SHOW_LINES = 100;
/** an exit line's text at most (UTF-16 units): a shell's reason included */
const EXIT_UNITS = 512;
/** the prompt's cwd at most (UTF-16 units): its end, after an ellipsis */
const PATH_UNITS = 256;
/** top's block at most (UTF-8 bytes): one lazy write's room (term-writer.ts ITEM_MAX) less its moves */
const REPLACE_MAX = ITEM_MAX - 64;
const BUSY = "The screen is still drawing: try again in a moment.";
// E5.3's 16 colours: web/shell/palette.ts, xterm's ANSI palette, read back from the CSS variables it injects, so the
// theme follows the page's
import { palette } from "./palette.ts";
export { palette };
const ANSI = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white", "brightBlack", "brightRed", "brightGreen", "brightYellow", "brightBlue", "brightMagenta", "brightCyan", "brightWhite"];
/** xterm's theme from the palette's variables, as the page's theme has them now */
export function termTheme(): Record<string, string> {
  const cs = getComputedStyle(document.documentElement);
  const v = (n: string) => cs.getPropertyValue(n).trim();
  const t: Record<string, string> = { background: v("--sb-term-bg"), foreground: v("--sb-term-fg"), cursor: v("--sb-term-fg"), selectionBackground: v("--sb-term-c12") + "55" };
  ANSI.forEach((name, i) => (t[name] = v(`--sb-term-c${i}`)));
  return t;
}

// (the person's text runs as one eval of a quoted word, so a continuation, an open quote or heredoc, or a parse error
// stays inside it (its errors keep its own line numbers); then its exit status, and its final directory after a
// record separator, so `cd` carries to the next command; a script that exits early keeps the directory it began in)
export const wrap = (script: string) => `eval -- '${script.replace(/'/g, "'\\''")}'\n__sb_s=$?; printf '\\036'; pwd; exit $__sb_s`;

/** Text of the panel's own making that holds the person's text (the editor's line, a path, a listing): controls shown
 * as visible symbols, never interpreted (ESC as U+241B, C0 as U+2400+c, DEL as U+2421). */
export const visible = (s: string) => s.replace(/[\x00-\x09\x0b-\x1f\x7f\x80-\x9f]/g, (c) => {
  const n = c.charCodeAt(0);
  return n === 0x7f ? "\u2421" : n < 0x20 ? String.fromCharCode(0x2400 + n) : "\ufffd";
});

/** `s` cut to at most `room` UTF-8 bytes, at a character's edge. */
const enc = typeof TextEncoder === "undefined" ? null : new TextEncoder();
export function cutUtf8(s: string, room: number): string {
  if (s.length * 3 <= room) return s;
  return s.slice(0, fitUtf8(s, room)[0]);
}

/** The code units of `s` that fit in `room` UTF-8 bytes (at a character's edge) and their bytes: one pass of the
 * platform's encoder into one reused S1-sized buffer (no copy of the text; E5.5's first paint, daybreak4 r3). */
let capBuf: Uint8Array | null = null;
function fitUtf8(s: string, room: number): [number, number] {
  room = Math.max(0, Math.min(room, OUTPUT.inBytes));
  if (enc) {
    capBuf ??= new Uint8Array(OUTPUT.inBytes);
    const r = enc.encodeInto(s, capBuf.subarray(0, room));
    return [r.read!, r.written!];
  }
  let b = 0, i = 0;
  for (const ch of s) {
    const n = utf8Len(ch);
    if (b + n > room) break;
    b += n;
    i += ch.length;
  }
  return [i, b];
}

/** The output kept within S1: stdout then stderr, stderr's reserve held for it, cut at a character's edge; the bytes
 * left out counted.  Text within S1 is measured once and never copied. */
export function capOutput(stdout: string, stderr: string): { out: string; err: string; omitted: number } {
  const [er0, eb0] = fitUtf8(stderr, OUTPUT.errReserve);
  const outRoom = OUTPUT.inBytes - (er0 === stderr.length ? eb0 : OUTPUT.errReserve);
  const [or, ob] = fitUtf8(stdout, outRoom);
  const [er, eb] = er0 === stderr.length ? [er0, eb0] : fitUtf8(stderr, OUTPUT.inBytes - ob);
  void eb;
  const out = or === stdout.length ? stdout : stdout.slice(0, or);
  const err = er === stderr.length ? stderr : stderr.slice(0, er);
  const omitted = (or < stdout.length ? utf8Len(stdout.slice(or)) : 0) + (er < stderr.length ? utf8Len(stderr.slice(er)) : 0);
  return { out, err, omitted };
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text = ""): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

export interface TerminalOptions {
  /** the page's shell host (one per page tab) */
  host: ShellHost;
  /** the package set the shell runs, shown in the header (r3 §1.6) */
  label: string;
  /** the page's own commands (web/shell/panel-commands.ts: open, ps, top), run in the page when typed alone */
  commands?: Record<string, PanelCommand>;
  /** a line above the prompt in a tab's first terminal (web/shell/terminal.ts: what commands do to your files) */
  intro?: string;
  /** Tab completion, help NAME's routing and ls colours (web/shell/panel-tab.ts), the page's like `commands` */
  tab?: PanelTab;
  /** the largest line the editor takes (UTF-8 bytes): the shell's bash.source_bytes */
  maxBytes?: number;
}
export interface TabState { busy: boolean; cwd: string; ended: boolean }
/** What a Tab sees of the line, and how it answers: a new line and caret, or a block of text under the prompt. */
export interface TabInput {
  readonly value: string;
  readonly caret: number;
  set(line: string, caret: number): void;
  show(text: string): void;
}
export interface PanelTab {
  /** a Tab: true if it is the completion's (the panel then prevents the browser's own, a focus move) */
  key(input: TabInput, root: HTMLElement, state: () => TabState): boolean;
  /** an edit, a cd, a run, reset, end: what a Tab has in flight is superseded */
  reset(): void;
  /** what bash runs for a typed line the page's commands would otherwise take or answer (help NAME, compgen's other forms), or null */
  route(argv: string[] | null, line: string): string | null;
  /** a command's stdout, coloured if it is a plain ls typed alone */
  colour(line: string, out: string, cwd: string): Promise<string>;
}

/** A page command: its output through `io`, Stop through `io.signal`; resolves with its exit status. */
export type PanelCommand = (args: string[], io: CommandIO) => Promise<number>;
export interface CommandIO {
  /** the session's directory */
  cwd: string;
  signal: AbortSignal;
  /** appends output (stderr's colour with err) */
  write(text: string, err?: boolean): void;
  /** replaces the command's output with `text` (a refreshing listing: top) */
  replace(text: string): void;
}

/** Words, with '…' and "…" quoting and backslash escapes; null if the line has shell syntax beyond that. */
export function words(line: string): string[] | null {
  const out: string[] = [];
  let cur = "", any = false, q: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === q) q = null;
      else if (c === "\\" && q === '"' && i + 1 < line.length) cur += line[++i];
      else cur += c;
    } else if (c === "'" || c === '"') {
      q = c;
      any = true;
    } else if (c === "\\" && i + 1 < line.length) {
      cur += line[++i];
      any = true;
    } else if (/\s/.test(c)) {
      if (any) out.push(cur);
      cur = "";
      any = false;
    } else if ("|;&<>()`$".includes(c)) return null;
    else {
      cur += c;
      any = true;
    }
  }
  if (q) return null;
  if (any) out.push(cur);
  return out;
}

// (the extra keys' bytes, as the editor's keys)
const EXTRA: Record<string, Key> = { Escape: { key: "Escape" }, Tab: { key: "Tab" }, "Control+C": { key: "c", ctrl: true }, Backtick: { key: "`" }, "Left arrow": { key: "ArrowLeft" }, "Up arrow": { key: "ArrowUp" }, "Down arrow": { key: "ArrowDown" }, "Right arrow": { key: "ArrowRight" } };
const DIM = (s: string) => `\x1b[2;3m${s}\x1b[0m`;

export class TerminalPanel {
  readonly root: HTMLElement;
  private body: HTMLElement;
  private status: HTMLElement;
  private note: HTMLElement;
  private cwdEl: HTMLElement;
  private timeEl: HTMLElement;
  private titleEl: HTMLElement;
  private stopBtn: HTMLButtonElement;
  private cwd = "/";
  private running: { ctl: AbortController; t0: number; timer: number } | null = null;
  private ended = false;
  /** the screen: replaced whole at a new generation (term-writer.ts) */
  term!: Terminal;
  private fit!: FitAddon;
  private observer: ResizeObserver | null = null;
  readonly editor: LineEditor;
  readonly writer: TermWriter;
  /** where the prompt being edited starts (an xterm marker: it follows the line through reflow and scrolling) */
  private start: { line: number; isDisposed: boolean; dispose(): void } | null = null;
  /** the prompt is on screen and the editor's line is drawn after it */
  private editing = false;

  constructor(private opts: TerminalOptions) {
    if (!document.getElementById("sb-term-css")) {
      const st = document.head.appendChild(el("style"));
      st.id = "sb-term-css";
      st.textContent = css + palette() + `.sb-term-keys{${TOOLBAR_CSS} flex:none}.sb-term-keys button{${BUTTON_CSS}}`;
    }
    ensureXtermCss();
    this.editor = new LineEditor(opts.maxBytes ?? 1 << 20, new History(HISTORY));
    const root = (this.root = el("section", "sb-term"));
    root.setAttribute("aria-label", "Terminal");
    root.hidden = true;
    const grip = (this.grip = root.appendChild(el("div", "sb-term-grip")));
    grip.setAttribute("role", "separator");
    grip.setAttribute("aria-orientation", "horizontal");
    grip.setAttribute("aria-label", "Resize the terminal");
    grip.tabIndex = 0;
    grip.title = "Drag to resize; double-click to reset";
    grip.addEventListener("pointerdown", (e) => this.drag(e));
    // (the non-drag way: Up/Down by 24 px, with Shift by 96: TP-8)
    grip.addEventListener("keydown", (e) => {
      const d = e.key === "ArrowUp" ? 1 : e.key === "ArrowDown" ? -1 : 0;
      if (!d) return;
      e.preventDefault();
      this.setHeight(this.root.getBoundingClientRect().height + d * (e.shiftKey ? 96 : 24), true);
    });
    // (the remembered height, clamped on read; else the default: the grip's value is set either way: TP-8)
    this.setHeight(Number((() => { try { return localStorage.getItem("sb-term-h"); } catch { return null; } })()) || 280, false);
    // (a double-click puts the default height back, as every panel's edge does: workspace/resize.ts)
    grip.addEventListener("dblclick", (e) => { e.preventDefault(); this.setHeight(280, false); try { localStorage.removeItem("sb-term-h"); } catch {} });

    const head = root.appendChild(el("div", "sb-term-head"));
    head.appendChild(el("span", "sb-term-set", opts.label));
    this.cwdEl = head.appendChild(el("span", "sb-term-cwd", this.cwd));
    // (a title a command sets (OSC 0/2): text only, capped (xterm-view.ts))
    this.titleEl = head.appendChild(el("span", "sb-term-title"));
    head.appendChild(el("span", "sb-term-sp"));
    this.timeEl = head.appendChild(el("span", "sb-term-time"));
    this.stopBtn = head.appendChild(el("button", "sb-term-stop", "Stop"));
    this.stopBtn.hidden = true;
    this.stopBtn.onclick = () => this.stop();
    // (✕ closes, keeping the session, its history and its scrollback, as closing a notebook keeps it: William's H9;
    //  ending it is the page's ⋯ ▸ End terminal session…, endAsk below)
    const hide = head.appendChild(el("button", "sb-term-hide", "✕"));
    hide.title = "Close (keeps the session)";
    hide.setAttribute("aria-label", "Close the terminal");
    hide.onclick = () => this.hide();

    // (the intro: a static line above the screen, once per tab, describing the terminal's input; not live, not a
    // dialog: T358-3; in each tab's first terminal until its "Got it", which this device then keeps, as the site keeps
    // its other preferences: localStorage, sagebrush-*; William, Oct 30)
    const intro = this.opts.intro && !localStorage.getItem("sagebrush-term-intro") && !sessionStorage.getItem("sb-term-intro") && root.appendChild(el("div", "sb-term-intro"));
    if (intro) {
      intro.appendChild(el("span", "", this.opts.intro)).id = "sb-term-intro";
      sessionStorage.setItem("sb-term-intro", "1");
      const ok = intro.appendChild(el("button", "", "Got it"));
      ok.setAttribute("aria-describedby", "sb-term-intro");
      // (put away first, kept after: a storage that refuses the write still lets the intro go, N386-2)
      ok.onclick = () => {
        intro.remove();
        this.term?.textarea?.setAttribute("aria-describedby", "sb-term-note");
        this.term?.focus();
        localStorage.setItem("sagebrush-term-intro", "1");
      };
    }
    const row = extraKeysRow("sb-term-keys", (data) => {
      const k = KEYS.find((x) => x.data === data);
      if (k && EXTRA[k.title]) this.onKey(EXTRA[k.title], null);
    }, () => this.term?.focus());
    if (row) root.appendChild(row);
    this.body = root.appendChild(el("div", "sb-term-body"));
    // (the note under the screen: polite; the screen's input names it: TP-6)
    this.note = root.appendChild(el("div", "sb-term-note"));
    this.note.hidden = true;
    this.note.id = "sb-term-note";
    this.note.setAttribute("aria-live", "polite");
    this.status = root.appendChild(el("div", "sb-term-status"));
    this.status.setAttribute("role", "status");
    this.status.setAttribute("aria-live", "polite");
    document.body.appendChild(root);
    this.writer = new TermWriter(() => this.term, (cp) => this.zw(cp), () => this.newGeneration(), undefined, () => this.term.buffer.active.type === "alternate");
    this.makeTerm(!!intro);
    this.setCwd("/");
    // (above the site's fixed alpha notice while it shows: web/alpha-banner.js; it can be dismissed at any time)
    this.place = this.place.bind(this);
    addEventListener("resize", this.place);
    this.watch = new MutationObserver(this.place);
    this.watch.observe(document.body, { childList: true, subtree: false, attributes: true, attributeFilter: ["style", "class"] });
    // (the page's theme, chosen or the system's: the screen's colours follow, on every page that has the Terminal)
    this.setTheme = this.setTheme.bind(this);
    this.themeWatch = new MutationObserver(this.setTheme);
    this.themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    this.dark.addEventListener("change", this.setTheme);
    this.prompt();
  }
  private zw: (cp: number) => boolean = () => false;
  private themeWatch: MutationObserver;
  private dark = matchMedia("(prefers-color-scheme: dark)");

  /** A fresh xterm in the dock (the first, or a new generation's): the shared OUT-ISO setup, this panel's input. */
  private makeTerm(intro = false): void {
    // (a title, as text, at most once a frame: output that sets it on every line costs one header update a frame)
    let title: string | null = null;
    const term = safeTerminal({ scrollback: SCROLLBACK, onTitle: (t) => {
      if (title === null) requestAnimationFrame(() => { this.titleEl.textContent = title ?? ""; title = null; });
      title = t;
    } });
    term.options.theme = termTheme();
    term.options.convertEol = true;
    term.options.screenReaderMode = true;
    term.options.fontSize = 13;
    // (the keyboard: the event itself; xterm does nothing with a key (false), and nothing it sends is read)
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown") return false;
      // (a composition's or a phone keyboard's key (229): its text comes from the input events below)
      if (e.isComposing || e.keyCode === 229) return false;
      this.onKey({ key: e.key, ctrl: e.ctrlKey, alt: e.altKey, meta: e.metaKey, shift: e.shiftKey }, e);
      return false;
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(this.body);
    const ta = term.textarea!;
    ta.setAttribute("aria-label", `Command, in ${this.cwd}`);
    ta.setAttribute("aria-describedby", intro || document.getElementById("sb-term-intro") ? "sb-term-intro sb-term-note" : "sb-term-note");
    // (a paste: from the event, the panel's alone; xterm's own paste handling never runs)
    ta.addEventListener("paste", (e) => {
      e.preventDefault();
      e.stopImmediatePropagation();
      const text = (e.clipboardData?.getData("text/plain") ?? "").replace(/\r\n?/g, "\n");
      if (text) this.act(this.editor.insert(text, "pasted"));
    }, true);
    // (an input method's text, and a phone keyboard's, read from the DOM event, never from xterm's onData)
    // (a composition's text arrives once: some browsers follow compositionend with an insertText of the same text)
    let composed: string | null = null;
    ta.addEventListener("compositionend", (e) => {
      composed = e.data || null;
      if (e.data) this.act(this.editor.insert(e.data, "typed"));
      setTimeout(() => (composed = null), 0);
    });
    // (text the browser inserts with no key the panel took: a phone keyboard's (after a 229 keydown), the OS emoji
    // picker's or dictation's (no keydown at all: X6); a key the panel takes is prevented, so it never arrives here too)
    ta.addEventListener("input", (e) => {
      const ie = e as InputEvent;
      if (ie.inputType === "insertText" && ie.data && ie.data === composed) return void (composed = null);
      if (!this.ended && ie.inputType === "insertText" && !ie.isComposing && ie.data) this.act(this.editor.insert(ie.data, "typed"));
    });
    this.term = term;
    this.fit = fit;
    this.zw = zeroWidthOf(term);
    this.observer?.disconnect();
    this.observer = new ResizeObserver(() => this.refit());
    this.observer.observe(this.body);
    this.refit();
  }

  /** The screen fitted to the dock, within MAX_COLS × MAX_ROWS; the line drawn again after a reflow. */
  private refit(): void {
    if (this.root.hidden || !this.term) return;
    try {
      const d = this.fit.proposeDimensions();
      if (!d || !(d.cols > 0) || !(d.rows > 0)) return;
      const cols = Math.min(MAX_COLS, d.cols), rows = Math.min(MAX_ROWS, d.rows);
      if (cols !== this.term.cols || rows !== this.term.rows) {
        this.term.resize(cols, rows);
        if (this.editing) this.redraw();
      }
    } catch {}
  }

  /** A new generation (term-writer.ts, a budget reached): the old xterm and all it holds released, a fresh one shown;
   * its first line, the notice, returned for the writer to write first. */
  private newGeneration(): string {
    const old = this.term;
    this.start?.dispose();
    this.start = null;
    old.dispose();
    this.body.replaceChildren();
    this.makeTerm();
    if (this.shown) this.term.focus();
    return DIM("Earlier output was cleared to save memory in this tab.") + "\r\n";
  }

  private watch: MutationObserver;
  /** Stacks the dock above the page's fixed bottom overlays (the alpha notice, a preview's notice and its pill), so
   * none covers the prompt: the dock's bottom is the highest top edge among them. */
  private place() {
    let lift = 0;
    for (const e of Array.from(document.body.children) as HTMLElement[]) {
      if (e === this.root || e.hidden) continue;
      const cs = getComputedStyle(e);
      if (cs.position !== "fixed" || cs.display === "none" || cs.visibility === "hidden") continue;
      const r = e.getBoundingClientRect();
      if (!(r.width >= innerWidth * 0.5 || r.bottom >= innerHeight - 1)) continue;
      // (fixed in the window's lower half; a stacked one, like the alpha notice above a preview's gutter, counts too)
      if (r.height > 0 && r.top > innerHeight / 2 && r.top < innerHeight) lift = Math.max(lift, innerHeight - r.top);
    }
    const b = Math.max(0, Math.round(lift));
    this.root.style.bottom = `${b}px`;
    // (the page keeps its last lines reachable above the dock)
    if (!this.root.hidden) document.body.style.setProperty("--sb-term-h", `${Math.round(this.root.getBoundingClientRect().height) + b}px`);
    // (the page's other bottom panels share the room below its content: web/index.html bottomRoom)
    dispatchEvent(new Event("sb-term-place"));
  }

  get shown() {
    return !this.root.hidden;
  }
  private opener: Element | null = null;
  show() {
    if (this.ended) return;
    if (!this.root.contains(document.activeElement)) this.opener = document.activeElement;
    this.root.hidden = false;
    this.place();
    requestAnimationFrame(() => (this.place(), this.refit()));
    this.refit();
    void this.warm();
    document.body.classList.add("sb-term-open");
    this.term.focus();
  }
  /** Hiding keeps the session, its history and its scrollback (E5.1). */
  hide() {
    const back = this.root.contains(document.activeElement);
    this.root.hidden = true;
    document.body.classList.remove("sb-term-open");
    dispatchEvent(new Event("sb-term-place"));
    // (focus goes back where it came from: TP-7)
    // (an opener that can't take focus (a menu item hidden since): the ⋯ button instead: TP-7-R2)
    const o = this.opener as HTMLElement | null;
    if (back) {
      if (o?.isConnected && o !== document.body) o.focus();
      if (document.activeElement !== o) document.getElementById("morebtn")?.focus();
    }
  }
  toggle() {
    if (this.shown) this.hide();
    else this.show();
  }
  focus() {
    if (this.shown) this.term.focus();
  }
  /** The page's theme changed: the screen's colours follow (the console's and the remote terminal's do too). */
  setTheme() {
    if (this.term) this.term.options.theme = termTheme();
  }
  /** The page's ⋯ ▸ End terminal session…: asked first (a running command named), then end(). */
  endAsk() {
    if (confirm("End this terminal session?" + (this.running ? " The command running now is stopped." : "") + " Its output and command history are cleared. This can't be undone.")) this.end();
  }
  /** Ends the session: a running command is stopped first; the scrollback and history are dropped. */
  end() {
    this.stop();
    this.opts.tab?.reset();
    this.ended = true;
    this.hide();
    removeEventListener("resize", this.place);
    this.watch.disconnect();
    this.themeWatch.disconnect();
    this.dark.removeEventListener("change", this.setTheme);
    this.observer?.disconnect();
    this.writer.dispose();
    this.start?.dispose();
    this.term.dispose();
    this.root.remove();
    // (the shell's worker too: the panel's own, so a page's onEnd can't drop it: TP-1)
    this.opts.host.endShell("the terminal was ended");
    this.onEnd?.();
  }
  onEnd: (() => void) | null = null;

  private setCwd(d: string) {
    this.cwd = d;
    this.cwdEl.textContent = d;
    this.term?.textarea?.setAttribute("aria-label", `Command, in ${d}`);
  }

  private grip: HTMLElement;
  /** The dock's height, within 120 px and 80% of the window (E5.1), remembered on this device. */
  setHeight(h: number, keep: boolean) {
    const max = Math.round(innerHeight * 0.8);
    h = Math.round(Math.max(MIN_H, Math.min(max, h)));
    this.root.style.height = `${h}px`;
    this.grip.setAttribute("aria-valuemin", String(MIN_H));
    this.grip.setAttribute("aria-valuemax", String(max));
    this.grip.setAttribute("aria-valuenow", String(h));
    if (keep) try { localStorage.setItem("sb-term-h", String(h)); } catch {}
    this.place();
  }

  private drag(e: PointerEvent) {
    e.preventDefault();
    const g = this.grip, y0 = e.clientY, h0 = this.root.getBoundingClientRect().height;
    g.setPointerCapture?.(e.pointerId);
    const move = (m: PointerEvent) => this.setHeight(h0 + (y0 - m.clientY), false);
    const up = () => {
      g.removeEventListener("pointermove", move);
      g.removeEventListener("pointerup", up);
      g.removeEventListener("pointercancel", up);
      this.setHeight(this.root.getBoundingClientRect().height, true);
    };
    g.addEventListener("pointermove", move);
    g.addEventListener("pointerup", up);
    g.addEventListener("pointercancel", up);
  }

  // ---------------------------------------------------------------- the shell's start (William: "show something
  // during the first load since that can be a few seconds")
  private ready = false;
  private starting: Promise<void> | null = null;
  private loadingEl: HTMLElement | null = null;
  /** Starts the shell worker if it isn't running, showing "Starting the shell…" in the dock until it is. */
  private warm(): Promise<void> {
    if (this.ready) return Promise.resolve();
    if (this.starting) return this.starting;
    // (in the header, beside the cwd: not on the screen)
    this.loadingEl ??= this.cwdEl.insertAdjacentElement("afterend", el("span", "sb-term-loading", "Starting the shell\u2026")) as HTMLElement;
    this.root.classList.add("loading");
    const t0 = performance.now();
    this.starting = this.opts.host.shellFor().then(
      () => {
        this.ready = true;
        this.loadingEl?.remove();
        this.loadingEl = null;
        this.root.classList.remove("loading");
        this.root.dataset.startMs = String(Math.round(performance.now() - t0));
      },
      (e) => {
        if (this.loadingEl) {
          this.loadingEl.textContent = `The shell didn't start: ${String((e as Error)?.message ?? e)}`;
          this.loadingEl.classList.add("sb-term-err");
          this.loadingEl = null;
        }
        this.root.classList.remove("loading");
        this.starting = null;
      },
    );
    return this.starting;
  }

  private say(text: string) {
    this.note.textContent = text;
    this.note.hidden = !text;
  }

  // ---------------------------------------------------------------- drawing the line
  private width(s: string): number {
    const svc = (this.term as any)?._core?.unicodeService;
    return svc ? svc.getStringCellWidth(s) : [...s].length;
  }

  /** The prompt and the editor's line as drawn: lines of [prefix, text], and the cursor's line and offset. */
  private view(line?: string): { lines: [string, string][]; at: [number, number] } {
    // (every part bounded before it is drawn: the cwd's last PATH_UNITS, the line or query within SHOW_UNITS, else its
    // summary; so a redraw is made within its lazy write's room, never cut after: SEC r4 materialization)
    const ed = this.editor, ps = `${this.cwd.length > PATH_UNITS ? "\u2026" + this.cwd.slice(-PATH_UNITS) : this.cwd} $ `;
    if (line !== undefined) {
      const text = this.small(line) ? line : this.summary(line);
      const parts = text.split("\n");
      return { lines: parts.map((t, i) => [i === 0 ? ps : "> ", visible(t)] as [string, string]), at: [parts.length - 1, visible(parts[parts.length - 1]).length] };
    }
    if (ed.search) {
      const s = ed.search, match = s.at >= 0 ? ed.history.entries[s.at] : "";
      // (bash's own prompt: a backtick opens the query, an apostrophe closes it)
      const p = `(${s.failed ? "failed " : ""}reverse-i-search)\`${this.small(s.q) ? visible(s.q) : this.summary(s.q)}': `;
      const text = this.small(match) ? visible(match) : this.summary(match);
      return { lines: [[p, text]], at: [0, text.length] };
    }
    if (!this.small(ed.buf)) {
      const text = this.summary(ed.buf);
      return { lines: [[ps, text]], at: [0, text.length] };
    }
    const parts = ed.buf.split("\n");
    const lines = parts.map((t, i) => [i === 0 ? ps : "> ", visible(t)] as [string, string]);
    const before = ed.buf.slice(0, ed.cur).split("\n");
    return { lines, at: [before.length - 1, visible(before[before.length - 1]).length] };
  }
  private small(s: string): boolean {
    if (s.length > SHOW_UNITS) return false;
    let n = 0;
    for (let i = s.indexOf("\n"); i >= 0; i = s.indexOf("\n", i + 1)) if (++n >= SHOW_LINES) return false;
    return true;
  }
  /** a long line's summary, counted in constant space (no split, no encoded copy): SEC T854-6 */
  private summary(s: string): string {
    let lines = 1;
    for (let i = s.indexOf("\n"); i >= 0; i = s.indexOf("\n", i + 1)) lines++;
    return `[${lines} line${lines === 1 ? "" : "s"}, ${utf8Len(s)} bytes: Enter runs it, Ctrl-C clears it]`;
  }

  /** The drawn line's text, from the prompt's start, and the moves that put the cursor where the editor has it. */
  private drawing(position = true, line?: string): string {
    const cols = this.term.cols;
    const { lines, at } = this.view(line);
    let s = "", row = 0, endRow = 0, curRow = 0, curCol = 0;
    lines.forEach(([p, t], i) => {
      const w = this.width(p) + this.width(t);
      if (i) s += "\r\n";
      s += (i === 0 ? `\x1b[1m${visible(p)}\x1b[0m` : DIM(p)) + t;
      if (i === at[0]) {
        const cw = this.width(p) + this.width(t.slice(0, at[1]));
        curRow = row + Math.floor(cw / cols);
        curCol = cw % cols;
      }
      const rows = Math.max(1, Math.ceil(w / cols));
      endRow = row + Math.floor(w / cols);
      // (a line ending exactly at the edge: leave xterm's pending-wrap state, as web/console.ts does)
      if (i === lines.length - 1 && w > 0 && w % cols === 0) s += " \r\x1b[K";
      row += rows;
    });
    if (!position) return s;
    if (endRow > curRow) s += `\x1b[${endRow - curRow}A`;
    s += `\x1b[${curCol + 1}G`;
    return s;
  }

  /** A fresh prompt: on a line of its own, its start marked, the editor's line after it. */
  private prompt(): void {
    this.editing = false;
    void this.writer.writeLazy(() => (this.term.buffer.active.cursorX ? "\r\n" : ""));
    void this.writer.writeLazy(() => {
      this.start?.dispose();
      this.start = this.term.registerMarker(0) ?? null;
      this.editing = true;
      return this.drawing();
    });
  }

  /** The line drawn again in place (an edit, a resize). */
  private redraw(): void {
    if (!this.editing) return;
    // (keyed: a redraw still waiting is replaced, so keys typed while the screen is busy cost one redraw)
    void this.writer.writeLazy(() => {
      if (!this.editing || !this.start || this.start.isDisposed) return "";
      const b = this.term.buffer.active;
      const up = b.baseY + b.cursorY - this.start.line;
      return (up > 0 ? `\x1b[${up}A` : "") + "\r\x1b[J" + this.drawing();
    }, "redraw");
  }

  /** The line left as it is (`line`, a submission's; else the editor's now), the cursor after it, a new line begun. */
  private leave(mark = "", line?: string): void {
    if (!this.editing) return;
    this.editing = false;
    // (the panel's one left line, bounded as drawn (SHOW_UNITS, else its summary): at most one waits, as `editing`
    // comes back only with the next prompt; the lazy write reads it, capturing nothing)
    this.leaving = this.drawing(false, line) + mark;
    void this.writer.writeLazy(() => {
      const body = this.leaving;
      this.leaving = "";
      if (!this.start || this.start.isDisposed) return "\r\n";
      const b = this.term.buffer.active;
      const up = b.baseY + b.cursorY - this.start.line;
      return (up > 0 ? `\x1b[${up}A` : "") + "\r\x1b[J" + body + "\r\n";
    });
  }
  private leaving = "";

  // ---------------------------------------------------------------- keys (E5.2)
  /** A key from the keyboard (or the extra keys row): the editor's, or the panel's (Ctrl-C, Enter while running). */
  private onKey(k: Key, e: KeyboardEvent | null): void {
    if (this.ended) return;
    const lower = k.key.length === 1 ? k.key.toLowerCase() : k.key;
    if (lower !== "Tab") this.opts.tab?.reset();
    // (a selection on the screen: Ctrl-C (or Cmd-C) copies it, the browser's own copy, even while a command runs)
    if ((k.ctrl || k.meta) && !k.shift && !k.alt && lower === "c" && this.term.hasSelection()) return;
    // (Ctrl-V and Cmd-V: the browser's paste, which the paste listener takes)
    if ((k.ctrl || k.meta) && lower === "v") return;
    // (Enter, in the line or in a reverse search: the one admission, before the editor takes the line)
    let id: number | null = null;
    if (k.key === "Enter" && !k.shift) {
      e?.preventDefault();
      const why = this.admission();
      if (why) return this.say(why);
      id = this.writer.tryStartCommand();
      if (id === null) return this.say(BUSY);
      this.cmd = id;
    }
    const a = this.editor.key(k);
    // (an Enter the editor didn't submit (a match past the bound): its admission let go, the end written)
    if (id !== null && a.t !== "submit") this.end_();
    if (a.t === "pass") return; // (the browser's own: no preventDefault)
    if (a.t === "tab") {
      const taken = !this.running && !!this.opts.tab?.key(this.tabInput(), this.root, () => ({ busy: !!this.running, cwd: this.cwd, ended: this.ended }));
      if (taken) { e?.preventDefault(); this.term.scrollToBottom(); }
      return;
    }
    e?.preventDefault();
    this.act(a);
  }

  /** the writer's ledger near a cap (term-writer.ts): actions that would queue more wait, said once */
  private get busy_(): boolean {
    return this.writer.pressed;
  }

  /** the command admitted (its writer id), from its Enter until its end; null between commands */
  private cmd: number | null = null;

  /** Why a command can't start now (a command admitted or running, the shell starting for one, the screen drawing),
   * or "": the one check for Enter and Ctrl-R Enter, made before the editor takes the line, so a refusal keeps it. */
  private admission(): string {
    if (this.ended) return "The terminal has ended.";
    if (this.cmd !== null || this.running) return "A command is running: Stop it first.";
    if (this.busy_) return BUSY;
    return "";
  }

  /** the admitted command's end (once): the writer's reset and its omission marker, `omitted` the panel's own */
  private end_(omitted = 0): Promise<void> {
    const id = this.cmd;
    this.cmd = null;
    return id === null ? Promise.resolve() : this.writer.endOutput(id, omitted);
  }

  private act(a: Act): void {
    // (what the person does at the prompt brings the screen back to it, scrolled up or not, as a terminal does:
    //  William's H8; xterm's own scroll on input never runs, as the panel takes every key)
    if (a.t !== "none" && a.t !== "pass" && a.t !== "tab") this.term.scrollToBottom();
    if ((a.t === "clear" || (a.t === "interrupt" && !this.running)) && this.busy_) return this.say(BUSY);
    if (a.t === "submit" && this.cmd === null) {
      // (never reached: Enter is admitted first in onKey; kept so no other path starts a command unadmitted)
      this.editor.unsubmit(a.line);
      this.redraw();
      return this.say("A command is running: Stop it first.");
    }
    switch (a.t) {
      case "redraw":
        this.say("");
        if (!this.running) this.redraw();
        return;
      case "refused": {
        const max = this.editor.maxBytes;
        const fig = max % (1 << 20) === 0 ? `${max >> 20} MiB` : max % 1024 === 0 ? `${max >> 10} KiB` : `${max} bytes`;
        return this.say(`Not ${a.how}: it's longer than the Terminal accepts at once (${fig}).`);
      }
      case "interrupt":
        if (this.running) return this.stop();
        this.leave("^C");
        this.editor.reset();
        this.prompt();
        return;
      case "clear":
        return this.clear();
      case "submit":
        return this.enter(a.line);
      case "eof":
      case "none":
      case "tab":
      case "pass":
        return;
    }
  }

  private tabInput(): TabInput {
    const ed = this.editor;
    return {
      get value() { return ed.buf; },
      get caret() { return ed.cur; },
      set: (line, caret) => this.act(ed.load(line, caret)),
      show: (text) => {
        // (a candidate block, bash's way: under the line, then the line again; the names shown as visible text)
        if (this.busy_) return;
        this.leave();
        void this.writer.write(visible(text).replace(/\n/g, "\r\n") + "\r\n");
        this.prompt();
      },
    };
  }

  /** Ctrl-L: clears the screen and its scrollback, keeping the line being edited; during a run its output still comes. */
  clear() {
    void this.writer.writeLazy(() => {
      this.term.clear();
      return "";
    });
    if (this.editing) this.redraw();
  }

  stop() {
    this.running?.ctl.abort();
  }

  /** this session, as `ps` lists it */
  readonly since = Date.now();
  get busy() {
    return !!this.running;
  }

  /** A submitted line: the panel's own words, a page command, or bash. */
  private enter(line: string) {
    this.leave("", line);
    this.say("");
    const word = line.trim();
    if (word === "") return void this.end_(), this.prompt();
    // (the panel's own: clear = Ctrl-L; reset also starts a fresh shell, keeping the cwd and the history, for when
    // something was pasted by mistake)
    if (word === "clear") return void this.end_(), this.clear(), this.prompt();
    if (word === "reset") return void this.reset();
    const argv = words(word), via = this.opts.tab?.route(argv, line);
    if (via) return void this.submit(line, via);
    if (argv && argv.length && Object.hasOwn(this.opts.commands ?? {}, argv[0])) return void this.builtin(line, argv);
    void this.submit(line);
  }

  /** `reset`: a fresh shell.  It holds the command's admission until the new shell is up, and a start already under
   * way (show()'s own) is adopted and finished first: never cleared or overlapped by a second (ENGINE E3). */
  private async reset(): Promise<void> {
    this.clear();
    if (this.starting) await this.starting.catch(() => {});
    // (after every wait: an ended panel starts, ends or draws nothing more: SEC T854-8)
    if (this.ended) return;
    this.opts.host.endShell("reset");
    this.ready = false;
    this.starting = null;
    await this.warm();
    if (this.ended) return;
    await this.end_();
    if (this.ended) return;
    this.prompt();
  }

  private begin(): AbortController {
    const ctl = new AbortController();
    const t0 = performance.now();
    const timer = window.setInterval(() => (this.timeEl.textContent = `${((performance.now() - t0) / 1000).toFixed(1)} s`), 100);
    this.running = { ctl, t0, timer };
    this.stopBtn.hidden = false;
    this.root.classList.add("running");
    return ctl;
  }

  private async finish(status: string) {
    // (every path ends its command first; this only makes sure no admission outlives its command)
    if (this.cmd !== null) void this.end_();
    clearInterval(this.running!.timer);
    this.timeEl.textContent = "";
    this.stopBtn.hidden = true;
    this.root.classList.remove("running");
    this.running = null;
    this.say("");
    // (after the output is in: the polite status says only "done" or "exit N")
    this.status.textContent = "";
    this.status.textContent = status;
    this.prompt();
    await this.writer.idle();
    if (this.shown) this.term.focus();
  }

  /**
   * A command's output into the screen: stdout, then stderr in the theme's red, within S1.  E5.5's gates read two
   * performance measures, from the outcome's arrival: sb-term:first-paint (the first 2 KiB drawn and a frame after it)
   * and sb-term:last-paint (all of it drawn and a frame after).
   */
  private async output(stdout: string, stderr: string): Promise<number> {
    const t0 = performance.now();
    const frame = () => (document.hidden ? Promise.resolve() : new Promise<void>((r) => { requestAnimationFrame(() => r()); setTimeout(r, 100); }));
    const head = (s: string) => {
      let k = Math.min(s.length, 2048);
      if (k < s.length && (s.charCodeAt(k) & 0xfc00) === 0xdc00) k--;
      return s.slice(0, k);
    };
    // (stdout's first 2 KiB is always within S1 (stdout's room is at least 960 KiB): it is written first, and S1's
    // cut measured over the rest after, so the first paint never waits for that pass; stderr alone: cut first)
    let c = stdout ? null : capOutput(stdout, stderr);
    const red = (e: string) => (e ? "\x1b[31m" + e + "\x1b[39m" : "");
    const first = c ? head(red(c.err)) : head(stdout);
    if (first) {
      await this.writer.write(first, "output");
      await frame();
      performance.measure("sb-term:first-paint", { start: t0, end: performance.now() });
    }
    c ??= capOutput(stdout, stderr);
    await this.writer.write(stdout ? c.out.slice(first.length) + red(c.err) : red(c.err).slice(first.length), "output");
    await frame();
    performance.measure("sb-term:last-paint", { start: t0, end: performance.now() });
    // (S1's omitted bytes: the writer's end marker counts them with any it dropped)
    return c.omitted;
  }

  /** open, ps and top: run in the page, Stop-able (top). */
  private async builtin(line: string, argv: string[]) {
    const ctl = this.begin();
    // (a page command's output goes through the writer as it comes; top's replace redraws its own block: up over the
    // rows it drew last and erase below, or anew if they have scrolled past the screen)
    let drawnFrom: { line: number; isDisposed: boolean; dispose(): void } | null = null;
    // (S1 for a page command too: at most 1 MiB of its writes shown, the rest counted for the end's marker; a
    // replace's block is capped on its own at REPLACE_MAX, the newest block's cut counted)
    let shown = 0, omitted = 0, latest = "", latestCut = 0;
    const fit = (text: string): string => {
      const kept = cutUtf8(text, Math.max(0, OUTPUT.inBytes - shown));
      const k = utf8Len(kept);
      omitted += utf8Len(text) - k;
      shown += k;
      return kept;
    };
    const io: CommandIO = {
      cwd: this.cwd,
      signal: ctl.signal,
      write: (text, err = false) => {
        const t = fit(text);
        if (t) void this.writer.write(err ? "\x1b[31m" + t + "\x1b[39m" : t, "output");
      },
      replace: (text) => {
        // (one keyed write: a refresh still waiting is replaced by the newest, so a fast refresher costs one draw; it
        // reads `latest`, the one bounded block, capturing nothing)
        latest = cutUtf8(text, REPLACE_MAX);
        latestCut = utf8Len(text) - utf8Len(latest);
        void this.writer.writeLazy(() => {
          const b = this.term.buffer.active;
          let pre = "";
          if (drawnFrom && !drawnFrom.isDisposed && b.baseY + b.cursorY - drawnFrom.line < this.term.rows) {
            const up = b.baseY + b.cursorY - drawnFrom.line;
            pre = (up > 0 ? `\x1b[${up}A` : "") + "\r\x1b[J";
          } else {
            drawnFrom?.dispose();
            drawnFrom = this.term.registerMarker(0) ?? null;
          }
          return pre + latest;
        }, "replace", true, utf8Len(latest));
      },
    };
    let code = 0;
    try {
      code = await this.opts.commands![argv[0]](argv.slice(1), io);
    } catch (e) {
      io.write(`${argv[0]}: ${String((e as Error)?.message ?? e)}\n`, true);
      code = 1;
    }
    drawnFrom?.dispose();
    await this.end_(omitted + latestCut);
    if (code) await this.exitLine(`exit ${code}`);
    await this.finish(code ? `exit ${code}` : "done");
  }

  private exitLine(text: string, err = false): Promise<void> {
    // (one per command, awaited: the lazy write reads the panel's field, at most EXIT_UNITS, capturing nothing)
    const t = visible(text.slice(0, EXIT_UNITS));
    this.exitText = err ? `\x1b[31m${t}\x1b[39m` : DIM(t);
    return this.writer.writeLazy(() => {
      const t = this.exitText;
      this.exitText = "";
      return (this.term.buffer.active.cursorX ? "\r\n" : "") + t + "\r\n";
    });
  }
  private exitText = "";

  /** `script` runs; `line`, what was typed (help NAME's), is what history keeps. */
  private async submit(line: string, script = line) {
    if (!this.ready) {
      // (the first command while bash loads: says so, under its prompt, until the shell is up)
      void this.writer.write(DIM("Starting the shell\u2026"));
      await this.warm();
      // (ended while the shell started: nothing runs or is drawn: SEC T854-8)
      if (this.ended) return;
      void this.writer.write("\r\x1b[2K");
    }
    const ctl = this.begin();
    let r: HostOutcome;
    try {
      r = await this.opts.host.exec({ kind: "person" }, wrap(script), { cwd: this.cwd, signal: ctl.signal });
    } catch (e) {
      r = { kind: "unavailable", row: 2, reason: String((e as Error)?.message ?? e), ops: [] };
    }
    let status: string;
    if (r.kind === "exit") {
      let out = r.stdout;
      const k = out.lastIndexOf("\x1e");
      if (k >= 0 && out.endsWith("\n")) {
        const d = out.slice(k + 1, -1);
        if (d.startsWith("/") && !d.includes("\n")) {
          this.setCwd(d);
          out = out.slice(0, k);
        }
      }
      if (script === line && this.opts.tab) out = await this.opts.tab.colour(line, out, this.cwd);
      await this.end_(await this.output(out, r.stderr));
      if (r.code !== 0) await this.exitLine(`exit ${r.code}`);
      status = r.code === 0 ? "done" : `exit ${r.code}`;
    } else if (r.kind === "interrupted") {
      await this.end_();
      await this.exitLine("^C (stopped)");
      status = "stopped";
    } else if (r.kind === "limit") {
      await this.end_(await this.output("", r.stderr));
      await this.exitLine(`exit ${r.code} (limit ${r.key})`);
      status = `exit ${r.code}`;
    } else {
      await this.end_();
      await this.exitLine(`the shell is unavailable: ${r.reason}`, true);
      status = "unavailable";
    }
    await this.finish(status);
  }

  /** The screen's text as shown (the tests' read: the buffer's lines, trailing spaces trimmed). */
  get screenText(): string {
    const b = this.term.buffer.active, out: string[] = [];
    for (let i = 0; i < b.length; i++) {
      const l = b.getLine(i);
      if (!l) continue;
      const t = l.translateToString(true);
      if (l.isWrapped && out.length) out[out.length - 1] += t;
      else out.push(t);
    }
    while (out.length && out[out.length - 1] === "") out.pop();
    return out.join("\n");
  }
}
