// The terminal panel (plan-bash-shell r8c E5; step 6): a bottom dock on the notebook page that runs one command at a
// time through the page's ShellHost with the person principal.  From scratch: no emulator, no innerHTML from data
// (text nodes and class names from a fixed table only); the output is rendered in slices (web/shell/panel-render.ts).
// A preview: the page shows it on preview and DEV hosts only (web/index.html), until E5.5's timing gates are met.
import css from "./panel.css" with { type: "text" };
import { Render, SLICE, FIRST, SCROLLBACK, dropMarker, evictCount, type Run } from "./panel-render.ts";
import type { HostOutcome, ShellHost } from "./host.ts";

export { SCROLLBACK };
const HISTORY_MAX = 500;
const MIN_H = 120;
// (a prompt line shows at most this much of a long or pasted input)
const PROMPT_LINES = 100, PROMPT_UNITS = 4096;
// E5.3's 16 colours, light and dark (each >= 4.5:1 on its theme's background: min 4.91 light, 6.15 dark), and their
// fixed class table: sb-fg-N, sb-bg-N, and sb-fga-N (a background alone: the theme's bg reads best on all 16)
const LIGHT = "1f2328 b3261e 116329 7a4a00 0550ae 8250df 0e6e74 59636e 424a53 c9271b 1a7f37 8a5300 0969da 9e45d6 0b7a80 59636e";
const DARK = "c9d1d9 ff7b72 3fb950 d29922 58a6ff bc8cff 39c5cf b1bac4 8b949e ffa198 56d364 e3b341 79c0ff d2a8ff 56d4dd f0f6fc";
export function palette(): string {
  const vars = (p: string, fg: string, bg: string) => p.split(" ").map((c, i) => `--sb-term-c${i}:#${c}`).join(";") + `;--sb-term-fg:#${fg};--sb-term-bg:#${bg}`;
  const dark = vars(DARK, "e6edf3", "0d1117");
  let out = `:root{${vars(LIGHT, "1f2328", "ffffff")}}:root[data-theme=dark]{${dark}}@media (prefers-color-scheme:dark){:root:not([data-theme=light]){${dark}}}`;
  for (let i = 0; i < 16; i++) out += `.sb-fg-${i}{color:var(--sb-term-c${i})}.sb-bg-${i}{background:var(--sb-term-c${i})}.sb-fga-${i}{color:var(--sb-term-bg)}`;
  return out;
}
// (the page's fixed bottom overlays, found by layout, not by name: the site's early-alpha notice, a hosted preview's
// notice gutter and its pill; any direct child of body fixed along the window's lower edge, wide or at the bottom)
// (the person's text runs as one eval of a quoted word, so a continuation, an open quote or heredoc, or a parse error
// stays inside it (its errors keep its own line numbers); then its exit status, and its final directory after a
// record separator, so `cd` carries to the next command; a script that exits early keeps the directory it began in)
export const wrap = (script: string) => `eval -- '${script.replace(/'/g, "'\\''")}'\n__sb_s=$?; printf '\\036'; pwd; exit $__sb_s`;

type Cmd = { el: HTMLElement; out: HTMLElement; units: number; lines: number; spans: number };

// (up to FRAME ms of slices between frames, after the first slice (panel-render.ts FIRST) and its frame)
const FRAME = 12;
const yieldNow = (): Promise<void> =>
  (globalThis as any).scheduler?.yield ? (globalThis as any).scheduler.yield() : new Promise((r) => setTimeout(r, 0));

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
}
export interface TabState { busy: boolean; cwd: string; ended: boolean }
export interface PanelTab {
  /** a Tab in the input: true if it is the completion's (the panel then prevents the browser's own) */
  key(input: HTMLTextAreaElement, root: HTMLElement, state: () => TabState): boolean;
  /** an edit, a cd, a run, reset, end: what a Tab has in flight is superseded, its block put away */
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

export class TerminalPanel {
  readonly root: HTMLElement;
  private log: HTMLElement;
  private status: HTMLElement;
  private input: HTMLTextAreaElement;
  private inputLabel: HTMLLabelElement;
  private note: HTMLElement;
  private cwdEl: HTMLElement;
  private timeEl: HTMLElement;
  private stopBtn: HTMLButtonElement;
  private cwd = "/";
  private history: string[] = [];
  private hpos = 0; // (== history.length: the draft)
  private draft = "";
  private cmds: Cmd[] = [];
  private dropped = 0;
  private dropMark: HTMLElement | null = null;
  private running: { ctl: AbortController; t0: number; timer: number; cmd: Cmd } | null = null;
  private ended = false;

  constructor(private opts: TerminalOptions) {
    if (!document.getElementById("sb-term-css")) {
      const st = document.head.appendChild(el("style"));
      st.id = "sb-term-css";
      st.textContent = css + palette();
    }
    const root = (this.root = el("section", "sb-term"));
    root.setAttribute("aria-label", "Terminal");
    root.hidden = true;
    const grip = (this.grip = root.appendChild(el("div", "sb-term-grip")));
    grip.setAttribute("role", "separator");
    grip.setAttribute("aria-orientation", "horizontal");
    grip.setAttribute("aria-label", "Resize the terminal");
    grip.tabIndex = 0;
    grip.title = "Drag, or use the arrow keys, to resize";
    grip.addEventListener("pointerdown", (e) => this.drag(e));
    // (the non-drag way: Up/Down by 24 px, with Shift by 96: TP-8)
    grip.addEventListener("keydown", (e) => {
      const d = e.key === "ArrowUp" ? 1 : e.key === "ArrowDown" ? -1 : 0;
      if (!d) return;
      e.preventDefault();
      this.setHeight(this.root.getBoundingClientRect().height + d * (e.shiftKey ? 96 : 24), true);
    });
    // (the remembered height, clamped on read; else the default: the grip's value is set either way: TP-8)
    this.setHeight(Number(sessionStorage.getItem("sb-term-h")) || 280, false);

    const head = root.appendChild(el("div", "sb-term-head"));
    head.appendChild(el("span", "sb-term-set", opts.label));
    this.cwdEl = head.appendChild(el("span", "sb-term-cwd", this.cwd));
    head.appendChild(el("span", "sb-term-sp"));
    this.timeEl = head.appendChild(el("span", "sb-term-time"));
    this.stopBtn = head.appendChild(el("button", "sb-term-stop", "Stop"));
    this.stopBtn.hidden = true;
    this.stopBtn.onclick = () => this.stop();
    const hide = head.appendChild(el("button", "sb-term-hide", "–"));
    hide.title = "Hide (keeps the session)";
    hide.setAttribute("aria-label", "Hide the terminal");
    hide.onclick = () => this.hide();
    const end = head.appendChild(el("button", "sb-term-end", "✕"));
    end.title = "End the session (drops its history and scrollback)";
    end.setAttribute("aria-label", "End the terminal session");
    end.onclick = () => this.end();

    this.log = root.appendChild(el("div", "sb-term-log"));
    this.log.setAttribute("role", "log");
    this.log.setAttribute("aria-live", "off");
    this.log.tabIndex = 0;
    this.status = root.appendChild(el("div", "sb-term-status"));
    this.status.setAttribute("role", "status");
    this.status.setAttribute("aria-live", "polite");

    // (the intro: a static line above the prompt, once per tab, named by the input; not live, not a dialog: T358-3;
    // in each tab's first terminal until its "Got it", which this device then keeps, as the site keeps its other
    // preferences: localStorage, sagebrush-*; William, Oct 30)
    const intro = this.opts.intro && !localStorage.getItem("sagebrush-term-intro") && !sessionStorage.getItem("sb-term-intro") && root.appendChild(el("div", "sb-term-intro"));
    const form = root.appendChild(el("div", "sb-term-in"));
    this.inputLabel = form.appendChild(el("label", "sb-term-prompt"));
    this.input = el("textarea");
    this.input.rows = 1;
    this.input.spellcheck = false;
    this.input.autocapitalize = "off";
    this.input.setAttribute("autocomplete", "off");
    this.input.id = "sb-term-input";
    this.input.setAttribute("aria-describedby", intro ? "sb-term-intro sb-term-note" : "sb-term-note");
    if (intro) {
      // (the text alone names the input; the button beside it, described by the text too: board's N386-1)
      intro.appendChild(el("span", "", this.opts.intro)).id = "sb-term-intro";
      sessionStorage.setItem("sb-term-intro", "1");
      const ok = intro.appendChild(el("button", "", "Got it"));
      ok.setAttribute("aria-describedby", "sb-term-intro");
      // (put away first, kept after: a storage that refuses the write still lets the intro go, N386-2)
      ok.onclick = () => {
        intro.remove();
        this.input.setAttribute("aria-describedby", "sb-term-note");
        this.input.focus();
        localStorage.setItem("sagebrush-term-intro", "1");
      };
    }
    this.inputLabel.htmlFor = this.input.id;
    form.appendChild(this.input);
    // (the note under the input: polite, apart from the log, which is never live; the input names it: TP-6)
    this.note = root.appendChild(el("div", "sb-term-note"));
    this.note.hidden = true;
    this.note.id = "sb-term-note";
    this.note.setAttribute("aria-live", "polite");
    this.input.addEventListener("keydown", (e) => this.key(e));
    this.input.addEventListener("input", () => (this.grow(), this.opts.tab?.reset()));
    root.addEventListener("keydown", (e) => this.globalKey(e));
    this.setCwd("/");
    document.body.appendChild(root);
    // (above the site's fixed alpha notice while it shows: web/alpha-banner.js; it can be dismissed at any time)
    this.place = this.place.bind(this);
    addEventListener("resize", this.place);
    this.watch = new MutationObserver(this.place);
    this.watch.observe(document.body, { childList: true, subtree: false, attributes: true, attributeFilter: ["style", "class"] });
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
    requestAnimationFrame(() => this.place());
    this.warm();
    document.body.classList.add("sb-term-open");
    this.input.focus();
  }
  /** Hiding keeps the session, its history and its scrollback (E5.1). */
  hide() {
    const back = this.root.contains(document.activeElement);
    this.root.hidden = true;
    document.body.classList.remove("sb-term-open");
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
  /** ✕ ends the session: a running command is stopped first; the scrollback and history are dropped. */
  end() {
    this.stop();
    this.opts.tab?.reset();
    this.ended = true;
    this.hide();
    removeEventListener("resize", this.place);
    this.watch.disconnect();
    this.root.remove();
    // (the shell's worker too: the panel's own, so a page's onEnd can't drop it: TP-1)
    this.opts.host.endShell("the terminal was ended");
    this.onEnd?.();
  }
  onEnd: (() => void) | null = null;

  private setCwd(d: string) {
    this.cwd = d;
    this.cwdEl.textContent = d;
    this.inputLabel.textContent = `${d} $`;
    this.input.setAttribute("aria-label", `Command, in ${d}`);
  }

  private grow() {
    this.input.style.height = "auto";
    this.input.style.height = `${Math.min(this.input.scrollHeight, 240)}px`;
  }

  private grip: HTMLElement;
  /** The dock's height, within 120 px and 80% of the window (E5.1), remembered for the session. */
  setHeight(h: number, keep: boolean) {
    const max = Math.round(innerHeight * 0.8);
    h = Math.round(Math.max(MIN_H, Math.min(max, h)));
    this.root.style.height = `${h}px`;
    this.grip.setAttribute("aria-valuemin", String(MIN_H));
    this.grip.setAttribute("aria-valuemax", String(max));
    this.grip.setAttribute("aria-valuenow", String(h));
    if (keep) sessionStorage.setItem("sb-term-h", String(h));
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
    // (in the header, beside the cwd: not in the scrollback, whose every line is charged to its caps)
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

  // ---------------------------------------------------------------- keys (E5.2)
  private globalKey(e: KeyboardEvent) {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "c") {
      // (a selection anywhere: copy, even while a command runs)
      const sel = getSelection();
      const inInput = document.activeElement === this.input && this.input.selectionStart !== this.input.selectionEnd;
      if ((sel && sel.toString() !== "") || inInput) return;
      e.preventDefault();
      if (this.running) this.stop();
      else {
        this.echo(`${this.cwd} $ ${this.input.value}`, "^C");
        this.input.value = "";
        this.grow();
      }
    } else if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "l") {
      e.preventDefault();
      this.clear();
    }
  }

  private key(e: KeyboardEvent) {
    // (an input method's Enter confirms its composition: never a submit: TP-4)
    if (e.isComposing || e.keyCode === 229) return;
    const ta = this.input;
    if (e.key === "Enter" && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      this.opts.tab?.reset();
      if (this.running) return this.say("A command is running: Stop it first.");
      const s = ta.value;
      if (s.trim() === "") {
        this.echo(`${this.cwd} $`, "");
        return;
      }
      const word = s.trim();
      if (word === "clear" || word === "reset") {
        // (the panel's own: clear = Ctrl-L; reset also drops the input and starts a fresh shell, keeping the cwd
        // and the history, for when something was pasted by mistake)
        this.remember(s);
        ta.value = "";
        this.grow();
        this.clear();
        this.say("");
        if (word === "reset") {
          this.opts.host.endShell("reset");
          this.ready = false;
          this.starting = null;
          void this.warm();
        }
        return;
      }
      const argv = words(word), via = this.opts.tab?.route(argv, s);
      if (via) return void this.submit(s, via);
      if (argv && argv.length && Object.hasOwn(this.opts.commands ?? {}, argv[0])) {
        void this.builtin(s, argv);
        return;
      }
      void this.submit(s);
    } else if (e.key === "ArrowUp" && !e.shiftKey && !ta.value.slice(0, ta.selectionStart).includes("\n")) {
      if (this.hpos === 0) return;
      if (this.hpos === this.history.length) this.draft = ta.value;
      e.preventDefault();
      this.hpos--;
      ta.value = this.history[this.hpos];
      this.grow();
    } else if (e.key === "ArrowDown" && !e.shiftKey && !ta.value.slice(ta.selectionEnd).includes("\n")) {
      if (this.hpos >= this.history.length) return;
      e.preventDefault();
      this.hpos++;
      ta.value = this.hpos === this.history.length ? this.draft : this.history[this.hpos];
      this.grow();
    } else if (e.key === "Tab" && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
      // (the page's completion takes it only at a word's end; otherwise Tab moves focus as usual: no keyboard trap)
      if (this.opts.tab?.key(ta, this.root, () => ({ busy: !!this.running, cwd: this.cwd, ended: this.ended }))) e.preventDefault();
    }
  }

  private remember(s: string) {
    if (this.history[this.history.length - 1] !== s) this.history.push(s);
    if (this.history.length > HISTORY_MAX) this.history.shift();
    this.hpos = this.history.length;
    this.draft = "";
  }

  /** Ctrl-L: clears the scrollback; during a run only the earlier commands, so its output still appears. */
  clear() {
    for (const c of this.cmds) if (c !== this.running?.cmd) c.el.remove();
    this.cmds = this.running ? [this.running.cmd] : [];
    this.dropMark?.remove();
    this.dropMark = null;
    this.dropped = 0;
  }

  stop() {
    this.running?.ctl.abort();
  }

  // ---------------------------------------------------------------- a command
  private atBottom() {
    return this.log.scrollHeight - this.log.scrollTop - this.log.clientHeight < 4;
  }

  private newCmd(prompt: string): Cmd {
    // (a long or many-line input shows its start: the prompt line is charged like content, before it goes in)
    let shown = prompt;
    const nl = shown.split("\n");
    if (nl.length > PROMPT_LINES) shown = nl.slice(0, PROMPT_LINES).join("\n");
    if (shown.length > PROMPT_UNITS) shown = shown.slice(0, PROMPT_UNITS);
    if (shown !== prompt) shown += " \u2026";
    const t = { units: shown.length, lines: shown.split("\n").length, spans: 1 };
    this.makeRoomNew(t);
    const c = el("div", "sb-term-cmd");
    c.appendChild(el("div", "sb-term-pl", shown));
    const out = c.appendChild(el("pre", "sb-term-out"));
    const cmd = { el: c, out, ...t };
    this.log.appendChild(c);
    this.cmds.push(cmd);
    // (a command just entered: the view goes to it, as a terminal's does; its output then sticks only if still there)
    this.log.scrollTop = this.log.scrollHeight;
    return cmd;
  }

  private echo(prompt: string, text: string) {
    const c = this.newCmd(prompt);
    if (text) this.addLine(c, text, "sb-term-echo");
  }

  /** A synthetic line under a command (its exit, a status, the loading note, an echo): room made in the scrollback
   * before it goes in, and charged to the command (E5.4: every live representation charged before insertion). */
  private addLine(cmd: Cmd, text: string, cls: string): HTMLElement {
    const t = { units: text.length, lines: 1, spans: 1 };
    this.makeRoom(t.units, t.lines, t.spans);
    const e = cmd.el.appendChild(el("div", cls, text));
    cmd.units += t.units, cmd.lines += t.lines, cmd.spans += t.spans;
    const stick = this.atBottom();
    if (stick) this.log.scrollTop = this.log.scrollHeight;
    return e;
  }

  /** Room for a new command's prompt line: any of the commands shown may be dropped (the new one isn't in yet). */
  private makeRoomNew(t: { units: number; lines: number; spans: number }) {
    this.makeRoom(t.units, t.lines, t.spans, true);
  }


  /** Before a slice goes into the newest command: the oldest commands dropped, whole, until it and the drop marker
   * fit the scrollback's caps (E5.4, panel-render.ts evictCount); the marker charged like content. */
  private makeRoom(units: number, lines: number, spans: number, fresh = false) {
    const k = evictCount(fresh ? [...this.cmds, { units: 0, lines: 0, spans: 0 }] : this.cmds, { units, lines, spans }, this.dropped);
    for (const c of this.cmds.splice(0, k)) c.el.remove();
    this.dropped += k;
    if (this.dropped) {
      if (!this.dropMark) this.dropMark = this.log.insertBefore(el("div", "sb-term-drop"), this.log.firstChild);
      this.dropMark.textContent = dropMarker(this.dropped);
    }
  }

  /** The scrollback's totals as shown, the drop marker included (the tests' figure). */
  get scrollbackTotals() {
    const t = { units: 0, lines: 0, spans: 0 };
    for (const c of this.cmds) (t.units += c.units), (t.lines += c.lines), (t.spans += c.spans);
    if (this.dropMark) (t.units += this.dropMark.textContent!.length), t.lines++, t.spans++;
    return t;
  }


  /** this session, as `ps` lists it */
  readonly since = Date.now();
  get busy() {
    return !!this.running;
  }

  /** open, ps and top: run in the page, shown like any command, Stop-able (top). */
  private async builtin(line: string, argv: string[]) {
    this.remember(line);
    this.say("");
    this.input.value = "";
    this.grow();
    const cmd = this.newCmd(`${this.cwd} $ ${line}`);
    const ctl = new AbortController();
    const t0 = performance.now();
    const timer = window.setInterval(() => (this.timeEl.textContent = `${((performance.now() - t0) / 1000).toFixed(1)} s`), 100);
    this.running = { ctl, t0, timer, cmd };
    this.stopBtn.hidden = false;
    this.root.classList.add("running");
    // (a page command's output goes through the same capped, sliced rendering as a shell's: its text is kept as
    // stdout and stderr, and the command's output is painted again from them, coalesced, as they change)
    let outBuf = "", errBuf = "", painting: Promise<void> | null = null, dirty = false;
    const base = { units: cmd.units, lines: cmd.lines, spans: cmd.spans };
    const repaint = () => {
      if (painting) return void (dirty = true);
      painting = (async () => {
        do {
          dirty = false;
          await Promise.resolve();
          cmd.out.textContent = "";
          Object.assign(cmd, base);
          await this.paint(cmd, outBuf, errBuf, ctl.signal);
        } while (dirty);
        painting = null;
      })();
    };
    const write = (text: string, err = false) => {
      if (err) errBuf += text;
      else outBuf += text;
      repaint();
    };
    let code = 0;
    const io: CommandIO = {
      cwd: this.cwd,
      signal: ctl.signal,
      write,
      replace: (text) => {
        outBuf = text;
        errBuf = "";
        repaint();
      },
    };
    try {
      code = await this.opts.commands![argv[0]](argv.slice(1), io);
    } catch (e) {
      write(`${argv[0]}: ${String((e as Error)?.message ?? e)}\n`, true);
      code = 1;
    } finally {
      while (painting) await painting;
      clearInterval(timer);
      this.timeEl.textContent = "";
      this.stopBtn.hidden = true;
      this.root.classList.remove("running");
      this.running = null;
      this.say("");
      if (code) this.addLine(cmd, `exit ${code}`, "sb-term-exit");
      this.status.textContent = "";
      this.status.textContent = code ? `exit ${code}` : "done";
      if (this.shown) this.input.focus();
    }
  }

  /** `script` runs; `line`, what was typed (help NAME's), is what the prompt shows and history keeps. */
  private async submit(line: string, script = line) {
    this.remember(line);
    this.say("");
    this.input.value = "";
    this.grow();
    const cmd = this.newCmd(`${this.cwd} $ ${line}`);
    if (!this.ready) {
      // (the first command while bash loads: says so, under its prompt, until the shell is up)
      const wait = this.addLine(cmd, "Starting the shell\u2026", "sb-term-loading");
      await this.warm();
      wait.remove();
      cmd.units -= "Starting the shell\u2026".length, cmd.lines--, cmd.spans--;
    }
    const ctl = new AbortController();
    const t0 = performance.now();
    const timer = window.setInterval(() => (this.timeEl.textContent = `${((performance.now() - t0) / 1000).toFixed(1)} s`), 100);
    this.running = { ctl, t0, timer, cmd };
    this.stopBtn.hidden = false;
    this.root.classList.add("running");
    let r: HostOutcome;
    try {
      r = await this.opts.host.exec({ kind: "person" }, wrap(script), { cwd: this.cwd, signal: ctl.signal });
    } catch (e) {
      r = { kind: "unavailable", row: 2, reason: String((e as Error)?.message ?? e), ops: [] };
    }
    let status: string;
    // (the closing lines below keep the view at the bottom if the output left it there)
    const end = (text: string, cls = "") => void this.addLine(cmd, text, "sb-term-exit" + cls);
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
      await this.paint(cmd, out, r.stderr, ctl.signal);
      if (r.code !== 0) end(`exit ${r.code}`);
      status = r.code === 0 ? "done" : `exit ${r.code}`;
    } else if (r.kind === "interrupted") {
      end("^C (stopped)");
      status = "stopped";
    } else if (r.kind === "limit") {
      await this.paint(cmd, "", r.stderr, ctl.signal);
      end(`exit ${r.code} (limit ${r.key})`);
      status = `exit ${r.code}`;
    } else {
      end(`the shell is unavailable: ${r.reason}`, " sb-term-err");
      status = "unavailable";
    }
    clearInterval(timer);
    this.timeEl.textContent = "";
    this.stopBtn.hidden = true;
    this.root.classList.remove("running");
    this.running = null;
    this.say("");
    // (after the output is in: the polite status says only "done" or "exit N"; the log itself is never live)
    this.status.textContent = "";
    this.status.textContent = status;
    if (this.shown) this.input.focus();
  }

  /** The output, rendered in slices (E5.5): each slice's runs go in as one fragment, then the page yields. */
  /**
   * The output, rendered in slices (E5.5): each slice's runs go in as one fragment, then the page yields.  E5.5's gates
   * read performance measures: sb-term:first-paint and sb-term:last-paint (from the command's finishing, its outcome
   * in, to the animation frame after its first and last slices), and each slice's sb-term:parse and sb-term:patch.
   */
  private async paint(cmd: Cmd, stdout: string, stderr: string, signal: AbortSignal) {
    const t0 = performance.now();
    const r = new Render(stdout, stderr);
    let first = true;
    // (no layout is forced in a slice: the view follows the output once per frame, in the frame, while the person has
    // not scrolled away from where it last put it; work goes on for at most FRAME ms, then the frame is painted)
    let stick = this.atBottom(), top = -1, f0 = t0;
    // (a hidden tab paints no frames: its slices only yield, and a frame awaited when the tab hides ends after 100 ms)
    const frame = (m?: string) =>
      document.hidden
        ? yieldNow()
        : new Promise((res) => {
            let done = 0;
            const go = () => {
              if (done++) return;
              if (m) performance.measure(m, { start: t0, end: performance.now() });
              if (stick && (top < 0 || this.log.scrollTop >= top - 4)) {
                this.log.scrollTop = this.log.scrollHeight;
                top = this.log.scrollTop;
              } else stick = false;
              setTimeout(res);
            };
            requestAnimationFrame(go);
            setTimeout(go, 100);
          });
    // (the open line's top-level nodes, its page boxes included: what a later lone \r takes back; the line's current page)
    let open: Node[] = [];
    let page: HTMLElement | null = null;
    // (the slice's chunk, from its first line start: the parent of its line-level nodes)
    let box: HTMLElement | null = null;
    // (a page box's charge: itself, and each node in it)
    const cost = (nd: Node) => [nd.textContent!.length, 1 + ((nd as HTMLElement).classList?.contains("sb-term-page") ? nd.childNodes.length : 0)];
    for (;;) {
      const p0 = performance.now();
      const runs = r.next(first ? FIRST : SLICE);
      if (!runs) break;
      // (a slice with no runs yet, stderr's reservation scanned in slices: nothing to paint, and the first output keeps
      // the first slice's budget and its first-paint measure: DB2-LL-337-4)
      if (!runs.length) {
        await yieldNow();
        continue;
      }
      const p1 = performance.now();
      if (signal.aborted && this.running?.cmd !== cmd) return;
      const f = document.createDocumentFragment();
      box = null;
      // (nodes for a page box already on screen: put in after the slice is charged, never before)
      let pf: DocumentFragment | null = null, pfPage: HTMLElement | null = null;
      let units = 0, lines = 0, spans = 0;
      for (const run of runs) {
        if (run.restart) {
          // (a lone \r over this line's earlier slices: their nodes and page boxes go, uncharged: TP-2, B-LL-3)
          if (pf) (units -= pf.textContent!.length), (spans -= pf.childNodes.length), (pf = pfPage = null);
          for (const nd of open) {
            const [u, n] = cost(nd);
            if (f.contains(nd)) (units -= u), (spans -= n);
            else (cmd.units -= u), (cmd.spans -= n);
            (nd as ChildNode).remove();
          }
          open = [];
          page = null;
          continue;
        }
        if (run.chunk) {
          box = f.appendChild(el("span", "sb-term-chunk"));
          spans++;
          continue;
        }
        if (run.page) {
          // (a join: the line goes on in an inline-block box of its own, charged as a run)
          page = el("span", "sb-term-page");
          (box ?? f).appendChild(page);
          open.push(page);
          spans++;
          continue;
        }
        units += run.text.length;
        spans++;
        for (let i = run.text.indexOf("\n"); i >= 0; i = run.text.indexOf("\n", i + 1)) lines++;
        // (in a page box, the line's end and anything after it go after the box, so the box holds no empty last row
        // and no later line: the omission line's run starts with its line end)
        const node = (s: string) => (run.cls === "" && !run.err ? document.createTextNode(s) : el("span", (run.err ? "sb-err " : "") + run.cls, s));
        const nl = page ? run.text.indexOf("\n") : -1;
        const text = nl < 0 ? run.text : run.text.slice(0, nl);
        if (text) {
          const nd = node(text);
          if (!page) {
            (box ?? f).appendChild(nd);
            open.push(nd);
          } else if (f.contains(page)) page.appendChild(nd);
          else {
            if (pfPage !== page) (pf = document.createDocumentFragment()), (pfPage = page);
            pf!.appendChild(nd);
          }
        }
        if (nl >= 0) {
          if (text) spans++;
          (box ?? f).appendChild(node(run.text.slice(nl)));
        }
        // (a line end closes the line: only the omission line's run has text after its line end, and nothing follows it)
        if (run.text.includes("\n")) (open = []), (page = null);
      }
      this.makeRoom(units, lines, spans);
      cmd.out.appendChild(f);
      if (pf && pfPage) pfPage.appendChild(pf);
      cmd.units += units;
      cmd.lines += lines;
      cmd.spans += spans;
      const p2 = performance.now();
      performance.measure("sb-term:parse", { start: p0, end: p1 });
      performance.measure("sb-term:patch", { start: p1, end: p2 });
      if (first || p2 - f0 > FRAME) {
        await frame(first ? "sb-term:first-paint" : "");
        first = false;
        f0 = performance.now();
      } else await yieldNow();
    }
    await frame("sb-term:last-paint");
  }

}
