// The terminal panel (plan-bash-shell r8c E5; step 6): a bottom dock on the notebook page that runs one command at a
// time through the page's ShellHost with the person principal.  From scratch: no emulator, no innerHTML from data
// (text nodes and class names from a fixed table only); the output is rendered in slices (web/shell/panel-render.ts).
// ROUGH PREVIEW (DEV/preview hosts only): the E5.8 tests, the scrollback's exact caps and the gates come next.
import css from "./panel.css" with { type: "text" };
import { Render, SLICE, type Run } from "./panel-render.ts";
import type { HostOutcome, ShellHost } from "./host.ts";

/** E5.4's scrollback caps (all commands): code units, lines, runs. */
export const SCROLLBACK = Object.freeze({ units: 4194304, lines: 6000, spans: 50000 });
const HISTORY_MAX = 500;
const MIN_H = 120;
// (the page's fixed bottom overlays: web/alpha-banner.js, and a hosted preview's notice gutter, web/preview/notice.js)
const OVERLAYS = ["sb-alpha-banner", "sb-preview-notice"];
// (the command's last line: its exit status, then its final directory after a record separator, so `cd` carries to
// the next command; a script that exits early keeps the directory it started in)
const TRAILER = "\n__sb_s=$?; printf '\\036'; pwd; exit $__sb_s";

type Cmd = { el: HTMLElement; out: HTMLElement; units: number; lines: number; spans: number };

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
      st.textContent = css;
    }
    const root = (this.root = el("section", "sb-term"));
    root.setAttribute("aria-label", "Terminal");
    root.hidden = true;
    const h = Number(sessionStorage.getItem("sb-term-h"));
    if (h >= MIN_H) root.style.height = `${h}px`;
    const grip = root.appendChild(el("div", "sb-term-grip"));
    grip.setAttribute("role", "separator");
    grip.setAttribute("aria-orientation", "horizontal");
    grip.title = "Drag to resize";
    grip.addEventListener("pointerdown", (e) => this.drag(e));

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

    const form = root.appendChild(el("div", "sb-term-in"));
    this.inputLabel = form.appendChild(el("label", "sb-term-prompt"));
    this.input = el("textarea");
    this.input.rows = 1;
    this.input.spellcheck = false;
    this.input.autocapitalize = "off";
    this.input.setAttribute("autocomplete", "off");
    this.input.id = "sb-term-input";
    this.inputLabel.htmlFor = this.input.id;
    form.appendChild(this.input);
    this.note = root.appendChild(el("div", "sb-term-note"));
    this.note.hidden = true;
    this.input.addEventListener("keydown", (e) => this.key(e));
    this.input.addEventListener("input", () => this.grow());
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
    for (const id of OVERLAYS) {
      const e = document.getElementById(id);
      if (!e || e.hidden || getComputedStyle(e).display === "none") continue;
      const r = e.getBoundingClientRect();
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
  show() {
    if (this.ended) return;
    this.root.hidden = false;
    this.place();
    requestAnimationFrame(() => this.place());
    this.warm();
    document.body.classList.add("sb-term-open");
    this.input.focus();
  }
  /** Hiding keeps the session, its history and its scrollback (E5.1). */
  hide() {
    this.root.hidden = true;
    document.body.classList.remove("sb-term-open");
  }
  toggle() {
    if (this.shown) this.hide();
    else this.show();
  }
  /** ✕ ends the session: a running command is stopped first; the scrollback and history are dropped. */
  end() {
    this.stop();
    this.ended = true;
    this.hide();
    removeEventListener("resize", this.place);
    this.watch.disconnect();
    this.root.remove();
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

  private drag(e: PointerEvent) {
    e.preventDefault();
    const y0 = e.clientY, h0 = this.root.getBoundingClientRect().height;
    const move = (m: PointerEvent) => {
      const h = Math.max(MIN_H, Math.min(innerHeight * 0.8, h0 + (y0 - m.clientY)));
      this.root.style.height = `${h}px`;
    };
    const up = () => {
      removeEventListener("pointermove", move);
      removeEventListener("pointerup", up);
      sessionStorage.setItem("sb-term-h", String(Math.round(this.root.getBoundingClientRect().height)));
    };
    addEventListener("pointermove", move);
    addEventListener("pointerup", up);
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
    this.loadingEl ??= this.log.appendChild(el("div", "sb-term-loading", "Starting the shell\u2026"));
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
    const ta = this.input;
    if (e.key === "Enter" && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
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
    } else if (e.key === "Tab") {
      // (no completion in the first release; Tab moves focus as usual)
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
    const c = el("div", "sb-term-cmd");
    c.appendChild(el("div", "sb-term-pl", prompt));
    const out = c.appendChild(el("pre", "sb-term-out"));
    const cmd = { el: c, out, units: prompt.length, lines: 1, spans: 1 };
    const stick = this.atBottom();
    this.log.appendChild(c);
    this.cmds.push(cmd);
    if (stick) this.log.scrollTop = this.log.scrollHeight;
    return cmd;
  }

  private echo(prompt: string, text: string) {
    const c = this.newCmd(prompt);
    if (text) c.out.textContent = text;
  }

  /** Before a slice of `units`/`lines`/`spans` goes in: drop the oldest commands whole until it and the marker fit. */
  private makeRoom(units: number, lines: number, spans: number) {
    const tot = () => this.cmds.reduce((a, c) => [a[0] + c.units, a[1] + c.lines, a[2] + c.spans], [0, 0, 0]);
    let [u, l, s] = tot();
    const mark = 64;
    while (this.cmds.length > 1 && (u + units + mark > SCROLLBACK.units || l + lines + 1 > SCROLLBACK.lines || s + spans + 1 > SCROLLBACK.spans)) {
      const c = this.cmds.shift()!;
      c.el.remove();
      this.dropped++;
      [u, l, s] = tot();
    }
    if (this.dropped) {
      if (!this.dropMark) this.dropMark = this.log.insertBefore(el("div", "sb-term-drop"), this.log.firstChild);
      this.dropMark.textContent = `[${this.dropped} earlier command${this.dropped === 1 ? "" : "s"} dropped]`;
    }
  }

  private async submit(script: string) {
    this.remember(script);
    this.say("");
    this.input.value = "";
    this.grow();
    const cmd = this.newCmd(`${this.cwd} $ ${script}`);
    if (!this.ready) {
      // (the first command while bash loads: says so, under its prompt, until the shell is up)
      const wait = cmd.el.appendChild(el("div", "sb-term-loading", "Starting the shell\u2026"));
      await this.warm();
      wait.remove();
    }
    const ctl = new AbortController();
    const t0 = performance.now();
    const timer = window.setInterval(() => (this.timeEl.textContent = `${((performance.now() - t0) / 1000).toFixed(1)} s`), 100);
    this.running = { ctl, t0, timer, cmd };
    this.stopBtn.hidden = false;
    this.root.classList.add("running");
    let r: HostOutcome;
    try {
      r = await this.opts.host.exec({ kind: "person" }, script + TRAILER, { cwd: this.cwd, signal: ctl.signal });
    } catch (e) {
      r = { kind: "unavailable", row: 2, reason: String((e as Error)?.message ?? e), ops: [] };
    }
    let status: string;
    // (the closing lines below keep the view at the bottom if the output left it there)
    const end = (text: string, cls = "") => {
      const stick = this.atBottom();
      cmd.el.appendChild(el("div", "sb-term-exit" + cls, text));
      if (stick) this.log.scrollTop = this.log.scrollHeight;
    };
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
    // (after the output is in: the polite status says only "done" or "exit N"; the log itself is never live)
    this.status.textContent = "";
    this.status.textContent = status;
    if (this.shown) this.input.focus();
  }

  /** The output, rendered in slices (E5.5): each slice's runs go in as one fragment, then the page yields. */
  private async paint(cmd: Cmd, stdout: string, stderr: string, signal: AbortSignal) {
    const r = new Render(stdout, stderr);
    for (let runs: Run[] | null; (runs = r.next(SLICE)); ) {
      if (signal.aborted && this.running?.cmd !== cmd) return;
      const f = document.createDocumentFragment();
      let units = 0, lines = 0;
      for (const run of runs) {
        units += run.text.length;
        for (let i = run.text.indexOf("\n"); i >= 0; i = run.text.indexOf("\n", i + 1)) lines++;
        if (run.cls === "" && !run.err) f.appendChild(document.createTextNode(run.text));
        else {
          const s = el("span", (run.err ? "sb-err " : "") + run.cls, run.text);
          f.appendChild(s);
        }
      }
      this.makeRoom(units, lines, runs.length);
      const stick = this.atBottom();
      cmd.out.appendChild(f);
      cmd.units += units;
      cmd.lines += lines;
      cmd.spans += runs.length;
      if (stick) this.log.scrollTop = this.log.scrollHeight;
      await yieldNow();
    }
  }
}
