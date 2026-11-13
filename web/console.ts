// An interactive Python prompt in xterm.js, loaded only when the page's
// Console is opened.  xterm only draws a terminal; this file is the line
// editor (cursor keys, history, Tab completion, auto-indent, paste) and the
// >>> / ... protocol, asking the page's worker whether input is complete.
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import css from "@xterm/xterm/css/xterm.css" with { type: "text" };

export interface Host {
  /** Run `src` in REPL mode; `out` receives its output.  Resolves when done: true if it left the prompt (exit() or
   *  quit(), Magma's quit;, MATLAB's exit), the host having ended the session and started a new one. */
  run(src: string, out: (text: string, isErr: boolean) => void): Promise<boolean | void>;
  /** Ctrl+D at an empty prompt: end the session and start a new one.  Resolves when the new one is there. */
  end(): Promise<void>;
  /** Is `src` an incomplete statement? */
  more(src: string): Promise<boolean>;
  /** Tab completion of the end of `line`: [matches, the text they replace]. */
  complete(line: string): Promise<[string[], string]>;
  /** Ctrl+C while code runs: stop it. */
  interrupt(): void;
  sage(): boolean;
  version(): string;
  /** Read out text for screen readers (a live region). */
  announce(text: string): void;
}

const HISTORY_KEY = "sagebrush-console-history";
const ENDED = "Session ended; new session started.";

export function openConsole(el: HTMLElement, host: Host) {
  if (!document.getElementById("xterm-css")) {
    const style = document.createElement("style");
    style.id = "xterm-css";
    style.textContent = css;
    document.head.appendChild(style);
  }
  const term = new Terminal({
    fontFamily: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
    fontSize: 14,
    cursorBlink: true,
    // Not screenReaderMode: it ignores the input events that phone keyboards
    // send.  Instead each command's output goes to host.announce.
    convertEol: true,
    scrollback: 5000,
    theme: themeFromCss(),
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(el);
  fit.fit();
  new ResizeObserver(() => fit.fit()).observe(el);

  let history: string[] = [];
  try {
    history = JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]");
  } catch {}
  let hpos = history.length; // index into history while browsing it
  let saved = ""; // the line being edited before browsing history

  let buf: string[] = []; // lines of the statement being entered
  let line = "", cur = 0; // the line being edited, and the cursor in it
  let prompt = "";
  let busy = false; // code is running (or the worker is being asked)
  let shown = 0; // characters (prompt + line) drawn by the last redraw
  let curShown = 0; // where its cursor was
  const queue: string[] = []; // pasted lines waiting for the prompt

  const ps1 = () => (host.sage() ? "sage: " : ">>> ");
  const ps2 = () => (host.sage() ? "....: " : "... ");

  // Redraw prompt + line, handling lines that wrap.
  function redraw() {
    const cols = term.cols;
    let s = "";
    const up = Math.floor(curShown / cols);
    if (up) s += `\x1b[${up}A`;
    s += "\r\x1b[J" + prompt + line;
    const total = prompt.length + line.length;
    if (total > 0 && total % cols === 0) s += " \r\x1b[K"; // leave xterm's pending-wrap state
    const at = prompt.length + cur;
    const endRow = Math.floor(total / cols), row = Math.floor(at / cols);
    if (endRow > row) s += `\x1b[${endRow - row}A`;
    s += `\x1b[${(at % cols) + 1}G`;
    term.write(s);
    shown = total;
    curShown = at;
  }

  function newPrompt(p: string, initial = "") {
    prompt = p;
    line = initial;
    cur = initial.length;
    shown = curShown = 0;
    term.write(prompt + line);
    shown = curShown = prompt.length + line.length;
    if (queue.length) setTimeout(() => submit(queue.shift()!, true), 0);
  }

  // Leave the line being edited: put the cursor after it.
  function endLine() {
    cur = line.length;
    redraw();
    term.write("\r\n");
  }

  async function submit(text: string, pasted = false) {
    if (pasted) {
      line = text;
      cur = line.length;
      redraw();
    }
    endLine();
    if (line.trim() !== "" && history[history.length - 1] !== line) {
      history.push(line);
      if (history.length > 500) history = history.slice(-500);
      try {
        localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
      } catch {}
    }
    hpos = history.length;
    buf.push(line);
    const src = buf.join("\n");
    if (src.trim() === "") {
      buf = [];
      return newPrompt(ps1());
    }
    busy = true;
    const more = await host.more(src);
    if (more) {
      busy = false;
      // Auto-indent: as deep as the last line, one level more after a colon.
      const indent = /^\s*/.exec(line)![0] + (/:\s*(#.*)?$/.test(line) ? "    " : "");
      return newPrompt(ps2(), line.trim() === "" ? "" : indent);
    }
    buf = [];
    let said = "";
    const ended = await host.run(src, (text, isErr) => {
      said += text;
      term.write(isErr ? `\x1b[31m${text}\x1b[0m` : text);
    });
    if (ended === true) return sessionEnded(said);
    host.announce(said.trim() === "" ? "done" : said.slice(-600));
    busy = false;
    newPrompt(ps1());
  }

  // The session ended (exit(), or Ctrl+D at an empty prompt) and a new one started: said, then a fresh prompt.
  function sessionEnded(said = "") {
    term.write((said === "" || said.endsWith("\n") ? "" : "\r\n") + ENDED + "\r\n");
    host.announce(ENDED);
    buf = [];
    busy = false;
    newPrompt(ps1());
  }

  async function tab() {
    const before = line.slice(0, cur);
    if (before.trim() === "") return insert("    ");
    busy = true;
    const [matches, prefix] = await host.complete(before);
    busy = false;
    if (!matches.length) return;
    let common = matches[0];
    for (const m of matches) while (!m.startsWith(common)) common = common.slice(0, -1);
    if (common.length > prefix.length) return insert(common.slice(prefix.length));
    if (matches.length > 1) {
      endLine();
      const w = Math.max(...matches.map((m) => m.length)) + 2;
      const per = Math.max(1, Math.floor(term.cols / w));
      let out = "";
      matches.slice(0, 200).forEach((m, i) => (out += m.padEnd(w) + ((i + 1) % per === 0 ? "\r\n" : "")));
      term.write(out.trimEnd() + "\r\n");
      shown = curShown = 0;
      term.write(prompt + line);
      shown = curShown = prompt.length + line.length;
      cur = before.length;
      redraw();
    }
  }

  function insert(text: string) {
    line = line.slice(0, cur) + text + line.slice(cur);
    cur += text.length;
    redraw();
  }

  function historyMove(d: number) {
    if (hpos === history.length) saved = line;
    const n = Math.min(history.length, Math.max(0, hpos + d));
    if (n === hpos) return;
    hpos = n;
    line = hpos === history.length ? saved : history[hpos];
    cur = line.length;
    redraw();
  }

  term.onData((data) => {
    if (busy) {
      if (data === "\x03") host.interrupt();
      return;
    }
    // A paste of several lines: enter them one at a time.
    if (data.length > 1 && /[\r\n]/.test(data) && !data.startsWith("\x1b")) {
      const parts = data.replace(/\r\n?/g, "\n").split("\n");
      const first = parts.shift()!;
      insert(first);
      queue.push(...parts.slice(0, -1));
      const last = parts[parts.length - 1];
      if (last) queue.push(last); // left to be completed?  run it too
      submit(line);
      return;
    }
    // Ctrl+D at an empty prompt: the session ends and a new one starts, as EOF ends Python's
    if (data === "\x04" && line === "" && buf.length === 0) {
      busy = true;
      term.write("\r\n");
      void host.end().then(() => sessionEnded());
      return;
    }
    switch (data) {
      case "\r":
        return void submit(line);
      case "\x7f": // Backspace
      case "\b":
        if (cur > 0) {
          // Delete a whole indent step in leading whitespace.
          const n = /^ +$/.test(line.slice(0, cur)) && cur % 4 === 0 ? 4 : 1;
          line = line.slice(0, cur - n) + line.slice(cur);
          cur -= n;
          redraw();
        }
        return;
      case "\x1b[3~": // Delete
      case "\x04": // Ctrl+D (at an empty prompt: above)
        if (cur < line.length) {
          line = line.slice(0, cur) + line.slice(cur + 1);
          redraw();
        }
        return;
      case "\x1b[D":
      case "\x02":
        if (cur > 0) cur--, redraw();
        return;
      case "\x1b[C":
      case "\x06":
        if (cur < line.length) cur++, redraw();
        return;
      case "\x1b[1;5D": // Ctrl+Left: a word back
      case "\x1bb":
        cur = line.slice(0, cur).search(/\w*\W*$/);
        return redraw();
      case "\x1b[1;5C": // Ctrl+Right
      case "\x1bf": {
        const m = /^\W*\w*/.exec(line.slice(cur))!;
        cur += m[0].length;
        return redraw();
      }
      case "\x1b[A":
      case "\x10":
        return historyMove(-1);
      case "\x1b[B":
      case "\x0e":
        return historyMove(1);
      case "\x1b[H":
      case "\x1bOH":
      case "\x01":
        cur = 0;
        return redraw();
      case "\x1b[F":
      case "\x1bOF":
      case "\x05":
        cur = line.length;
        return redraw();
      case "\x15": // Ctrl+U
        line = line.slice(cur);
        cur = 0;
        return redraw();
      case "\x0b": // Ctrl+K
        line = line.slice(0, cur);
        return redraw();
      case "\x17": // Ctrl+W
        {
          const k = line.slice(0, cur).search(/\w*\W*$/);
          line = line.slice(0, k) + line.slice(cur);
          cur = k;
        }
        return redraw();
      case "\x0c": // Ctrl+L
        term.clear();
        return redraw();
      case "\x03": // Ctrl+C
        endLine();
        term.write("KeyboardInterrupt\r\n");
        buf = [];
        return newPrompt(ps1());
      case "\t":
        return void tab();
    }
    if (data >= " " && !data.startsWith("\x1b")) insert(data.replace(/[\x00-\x1f\x7f]/g, ""));
  });

  term.write(`sagebrush ${host.version()} — Python 3.14${host.sage() ? " (Sage mode)" : ""}. A fresh, ephemeral session: the notebook's variables are not here.\r\n`);
  term.write("Tab completes, ↑/↓ recall history, Ctrl+C stops running code.\r\n");
  newPrompt(ps1());
  term.focus();

  return {
    focus: () => term.focus(),
    setTheme: () => (term.options.theme = themeFromCss()),
    /** The worker was restarted under running code. */
    restarted(message: string) {
      term.write(`\x1b[31m${message.trim()}\x1b[0m\r\n`);
    },
    dispose: () => term.dispose(),
  };
}

// Terminal colors from the page's CSS variables (so light/dark follow it).
function themeFromCss() {
  const v = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const dark = v("--scheme") === "dark";
  return {
    background: v("--code"),
    foreground: v("--fg"),
    cursor: v("--fg"),
    selectionBackground: dark ? "#3d4a3f" : "#cfe0c8",
    red: v("--err"),
    green: v("--accent"),
    ...(dark ? {} : { brightBlack: "#5d645f", white: "#5d645f" }),
  };
}
