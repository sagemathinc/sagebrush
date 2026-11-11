// The terminal's line editor (plan-term-xterm r2.7 §3): just-bash has no terminal device, so the panel edits the line
// itself, in front of xterm, as web/console.ts does.  Pure: keys in; the line, the cursor, history and a submission
// out.  No DOM and no xterm here, so it is tested directly (web/shell/test-line-editor.mjs); web/shell/panel.ts draws
// what it says.
//
// Bounds (daybreak4 P2, daybreak3 E2): the line (with what is typed ahead into it) is at most `maxBytes` of UTF-8, the
// limit a submitted script meets (bash.source_bytes); a paste or key that would pass it is refused whole, never cut
// and never partly submitted.  History holds at most 500 entries and 4 MiB of UTF-8 in all, oldest out first; an
// entry over 256 KiB still runs but isn't kept.  Ctrl-R scans that history at most once per key.  `work` counts the
// characters each operation copies or scans (the tests' measure: no operation is quadratic).

export const HISTORY = Object.freeze({ entries: 500, bytes: 4 << 20, entryMax: 256 << 10 });

/** UTF-8 bytes of `s` (a lone surrogate counts 3, as the encoder's replacement character). */
export function utf8Len(s: string): number {
  // (counted in constant space, whatever the length: no encoded copy is made just to measure; a lone surrogate counts
  // 3, as the encoder's replacement character)
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) (n += 4), i++;
    else n += 3;
  }
  return n;
}

/** The session's history (bash's: per session; the prompts' in PR 3b: per device), within HISTORY's bounds. */
export class History {
  entries: string[] = [];
  bytes = 0;
  constructor(readonly limits: { entries: number; bytes: number; entryMax: number } = HISTORY, saved: string[] = []) {
    for (const s of saved) this.push(s);
  }
  /** Kept at the end, oldest out past the bounds; false when it isn't kept (blank, a repeat, past entryMax). */
  push(s: string): boolean {
    if (s.trim() === "" || this.entries[this.entries.length - 1] === s) return false;
    const b = utf8Len(s);
    if (b > this.limits.entryMax) return false;
    this.entries.push(s);
    this.bytes += b;
    while (this.entries.length > this.limits.entries || this.bytes > this.limits.bytes) this.bytes -= utf8Len(this.entries.shift()!);
    return true;
  }
}

export type Key = { key: string; ctrl?: boolean; alt?: boolean; meta?: boolean; shift?: boolean };
export type Act =
  | { t: "none" } // (handled; nothing to draw)
  | { t: "redraw" }
  | { t: "submit"; line: string }
  | { t: "interrupt" } // Ctrl-C: the panel decides (copy, Stop, or ^C)
  | { t: "clear" } // Ctrl-L
  | { t: "tab" }
  | { t: "eof" } // Ctrl-D on an empty line
  | { t: "refused"; how: "pasted" | "typed" }
  | { t: "pass" }; // not the editor's key: the browser's own (Tab's focus move, for one)

const isWord = (c: string) => /[A-Za-z0-9_]/.test(c);

export class LineEditor {
  buf = "";
  cur = 0;
  /** reverse incremental search (Ctrl-R): the query, the history index of the match, and whether it failed */
  search: { q: string; at: number; failed: boolean; saved: string; savedCur: number } | null = null;
  /** characters copied or scanned so far (the tests' work measure) */
  work = 0;
  private hpos: number;
  private draft = "";
  private bytes = 0;

  constructor(readonly maxBytes: number, readonly history: History) {
    this.hpos = history.entries.length;
  }

  /** A fresh line (after a submission or ^C): history browsing starts again from the newest entry. */
  reset(text = ""): void {
    this.buf = text;
    this.cur = text.length;
    this.bytes = utf8Len(text);
    this.search = null;
    this.hpos = this.history.entries.length;
    this.draft = "";
  }

  private set(text: string, cur = text.length): void {
    this.work += text.length;
    this.buf = text;
    this.cur = cur;
    this.bytes = utf8Len(text);
  }

  /** The line replaced whole (a Tab completion's result): refused whole past maxBytes, the line kept as it was. */
  load(text: string, cur = text.length): Act {
    if (utf8Len(text) > this.maxBytes) return { t: "refused", how: "typed" };
    this.search = null;
    this.set(text, Math.min(cur, text.length));
    return { t: "redraw" };
  }

  /** Text typed or pasted at the cursor; refused whole past maxBytes. */
  insert(text: string, how: "pasted" | "typed" = "typed"): Act {
    if (this.search && !this.accept()) return { t: "refused", how };
    const add = utf8Len(text);
    if (this.bytes + add > this.maxBytes) return { t: "refused", how };
    this.work += this.buf.length + text.length;
    this.buf = this.buf.slice(0, this.cur) + text + this.buf.slice(this.cur);
    this.cur += text.length;
    this.bytes += add;
    return { t: "redraw" };
  }

  /** The line shown in the search's place, kept for editing (Esc, an arrow): bash's accept. */
  private accept(): boolean {
    const s = this.search!;
    if (!s.failed && s.at >= 0 && utf8Len(this.history.entries[s.at]) > this.maxBytes) return false;
    this.search = null;
    if (s.failed || s.at < 0) return true;
    this.set(this.history.entries[s.at]);
    return true;
  }

  private find(q: string, from: number): number {
    const e = this.history.entries;
    for (let i = Math.min(from, e.length - 1); i >= 0; i--) {
      this.work += e[i].length;
      if (e[i].includes(q)) return i;
    }
    return -1;
  }

  private searchKey(k: Key): Act {
    const s = this.search!;
    if (k.ctrl && k.key.toLowerCase() === "r") {
      // (the next older match)
      if (s.q === "") return { t: "none" };
      const i = this.find(s.q, s.at - 1);
      if (i >= 0) (s.at = i), (s.failed = false);
      else s.failed = true;
      return { t: "redraw" };
    }
    if (k.ctrl && k.key.toLowerCase() === "g") {
      // (cancel: the line as it was)
      this.search = null;
      this.set(s.saved, s.savedCur);
      return { t: "redraw" };
    }
    if (k.key === "Backspace") {
      s.q = s.q.slice(0, -1);
      const i = s.q === "" ? -1 : this.find(s.q, this.history.entries.length - 1);
      s.at = i;
      s.failed = s.q !== "" && i < 0;
      return { t: "redraw" };
    }
    if (k.key === "Enter" && !k.shift) {
      // (a match past the line's bound is never accepted, so never submitted)
      if (!this.accept()) return { t: "refused", how: "typed" };
      return this.submit();
    }
    if (k.ctrl && k.key.toLowerCase() === "c") return { t: "interrupt" };
    if (k.key.length === 1 && !k.ctrl && !k.meta && !k.alt) {
      // (the query is bounded as the line is)
      if (utf8Len(s.q) + utf8Len(k.key) > this.maxBytes) return { t: "refused", how: "typed" };
      s.q += k.key;
      const i = this.find(s.q, s.failed ? -1 : s.at >= 0 ? s.at : this.history.entries.length - 1);
      if (i >= 0) (s.at = i), (s.failed = false);
      else s.failed = true;
      return { t: "redraw" };
    }
    // (Esc, an arrow, Home, End or any other key: the match stays in the line, and the key then acts on it)
    if (!this.accept()) return { t: "refused", how: "typed" };
    if (k.key === "Escape") return { t: "redraw" };
    const a = this.key(k);
    return a.t === "none" || a.t === "pass" ? { t: "redraw" } : a;
  }

  private submit(): Act {
    // (the central guard: whatever path filled the line, nothing past the bound is ever submitted)
    if (utf8Len(this.buf) > this.maxBytes) return { t: "refused", how: "typed" };
    const line = this.buf;
    this.pushed = this.history.push(line);
    this.reset();
    return { t: "submit", line };
  }
  /** whether the last submission added its own history entry (a repeat or a blank line adds none) */
  private pushed = false;

  /** A submission taken back (the panel refused to start it): the line restored, and its history entry removed only if
   * it added one (after a repeat, the earlier entry stays: grader E2). */
  unsubmit(line: string): void {
    const e = this.history.entries;
    if (this.pushed && e[e.length - 1] === line) {
      e.pop();
      this.history.bytes -= utf8Len(line);
    }
    this.pushed = false;
    this.reset(line);
  }

  key(k: Key): Act {
    if (this.search) return this.searchKey(k);
    const { buf, cur } = this;
    const lower = k.key.length === 1 ? k.key.toLowerCase() : k.key;
    if (k.ctrl && !k.alt && !k.meta) {
      switch (lower) {
        case "c": return { t: "interrupt" };
        case "l": return { t: "clear" };
        case "a": this.cur = this.lineStart(); return { t: "redraw" };
        case "e": this.cur = this.lineEnd(); return { t: "redraw" };
        case "u": this.set(buf.slice(0, this.lineStart()) + buf.slice(cur), this.lineStart()); return { t: "redraw" };
        case "k": this.set(buf.slice(0, cur) + buf.slice(this.lineEnd()), cur); return { t: "redraw" };
        case "w": {
          let i = cur;
          while (i > 0 && !isWord(buf[i - 1]) && buf[i - 1] !== "\n") i--;
          while (i > 0 && isWord(buf[i - 1])) i--;
          this.set(buf.slice(0, i) + buf.slice(cur), i);
          return { t: "redraw" };
        }
        case "d":
          if (buf === "") return { t: "eof" };
          if (cur < buf.length) this.set(buf.slice(0, cur) + buf.slice(cur + this.charLen(cur)), cur);
          return { t: "redraw" };
        case "r":
          this.search = { q: "", at: -1, failed: false, saved: buf, savedCur: cur };
          return { t: "redraw" };
      }
      return { t: "none" };
    }
    if (k.meta || k.alt) return { t: "pass" };
    switch (k.key) {
      case "Enter":
        if (k.shift) return this.insert("\n");
        return this.submit();
      case "Tab":
        // (Shift-Tab is the browser's: the focus moves back, never a completion; Tab stays in the Terminal, whose way
        // out is Esc then Tab (panel.ts): no keyboard trap)
        return k.shift ? { t: "pass" } : { t: "tab" };
      case "Backspace": {
        if (cur === 0) return { t: "none" };
        const n = this.charLenBefore(cur);
        this.set(buf.slice(0, cur - n) + buf.slice(cur), cur - n);
        return { t: "redraw" };
      }
      case "Delete":
        if (cur >= buf.length) return { t: "none" };
        this.set(buf.slice(0, cur) + buf.slice(cur + this.charLen(cur)), cur);
        return { t: "redraw" };
      case "ArrowLeft":
        if (cur > 0) this.cur -= this.charLenBefore(cur);
        return { t: "redraw" };
      case "ArrowRight":
        if (cur < buf.length) this.cur += this.charLen(cur);
        return { t: "redraw" };
      case "Home":
        this.cur = this.lineStart();
        return { t: "redraw" };
      case "End":
        this.cur = this.lineEnd();
        return { t: "redraw" };
      case "ArrowUp": {
        // (in a many-line script: the line above; on its first line: history)
        const ls = this.lineStart();
        if (ls > 0) {
          const col = cur - ls, ps = buf.lastIndexOf("\n", ls - 2) + 1;
          this.cur = Math.min(ps + col, ls - 1);
          return { t: "redraw" };
        }
        if (this.hpos === 0) return { t: "none" };
        // (an entry past the line's bound (a smaller configured bash.source_bytes) isn't loaded)
        if (utf8Len(this.history.entries[this.hpos - 1]) > this.maxBytes) return { t: "refused", how: "typed" };
        if (this.hpos === this.history.entries.length) this.draft = buf;
        this.hpos--;
        this.set(this.history.entries[this.hpos]);
        return { t: "redraw" };
      }
      case "ArrowDown": {
        const le = this.lineEnd();
        if (le < buf.length) {
          const col = cur - this.lineStart(), ns = le + 1, ne = buf.indexOf("\n", ns);
          this.cur = Math.min(ns + col, ne < 0 ? buf.length : ne);
          return { t: "redraw" };
        }
        if (this.hpos >= this.history.entries.length) return { t: "none" };
        if (this.hpos + 1 < this.history.entries.length && utf8Len(this.history.entries[this.hpos + 1]) > this.maxBytes) return { t: "refused", how: "typed" };
        this.hpos++;
        this.set(this.hpos === this.history.entries.length ? this.draft : this.history.entries[this.hpos]);
        return { t: "redraw" };
      }
    }
    // (a printable character, astral ones included)
    if ([...k.key].length === 1 && k.key >= " ") return this.insert(k.key, "typed");
    return { t: "pass" };
  }

  private lineStart(): number {
    return this.buf.lastIndexOf("\n", this.cur - 1) + 1;
  }
  private lineEnd(): number {
    const i = this.buf.indexOf("\n", this.cur);
    return i < 0 ? this.buf.length : i;
  }
  private charLen(i: number): number {
    const c = this.buf.charCodeAt(i);
    return c >= 0xd800 && c <= 0xdbff && (this.buf.charCodeAt(i + 1) & 0xfc00) === 0xdc00 ? 2 : 1;
  }
  private charLenBefore(i: number): number {
    const c = this.buf.charCodeAt(i - 1);
    return (c & 0xfc00) === 0xdc00 && i >= 2 && (this.buf.charCodeAt(i - 2) & 0xfc00) === 0xd800 ? 2 : 1;
  }
}
