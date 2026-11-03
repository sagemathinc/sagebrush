// The LaTeX editor saves as you type (William, Nov 2, U8: "a user should never see 'Leave this file without saving
// your changes?', have to explicitly find and click a 'Save' button"; plan U8 r5, astra's DATA PLAN CLEAR 089b329b).
//
//   - Every edit is durable at once: a draft of the editor's text, bound to the file (fid) and to this editor
//     (writerId, a fresh random id per editor instance, so two tabs never share or replace a draft), written before
//     anything asynchronous (drafts.ts: localStorage, synchronously; a draft too large for it goes to IndexedDB, durable
//     when its transaction completes; William: "Never prompt; accept that tiny risk for >2 MB files").
//   - The file is written 800 ms after the last edit, and at once on flush (blur, hidden, pagehide, a switch, Ctrl+S):
//     one write at a time, compare-and-swap on the revision this editor last read or wrote, of a snapshot (text, gen,
//     base) taken when it starts. Its acknowledgement moves the saved baseline to that snapshot only: edits made since
//     stay pending and get the next write; it removes this writer's drafts up to that snapshot's gen only.
//   - The file changed elsewhere (another tab, an agent, Python, sync; not this editor's own write, known by the
//     revisions it wrote): with nothing pending, the editor takes the new text; with edits pending, nothing is
//     written and the person chooses: Keep mine (compare-and-swap on the exact revision shown; a third writer since is a
//     new conflict, never an overwrite) or Use theirs (mine kept first as a version of the file, the editor read-only
//     meanwhile; if mine changed anyway, nothing is replaced).
//   - A write that fails (storage full, the file gone or replaced) is the one state that keeps a prompt on leaving;
//     its edits stay in the editor and in the draft, and are written again on the next edit or flush.
//   - After dispose (the editor closed or switched), a write still in flight completes and updates only this writer's
//     drafts: nothing of the UI.
// Pure logic over injected I/O, timers and draft stores: test-latex-units.mjs runs it with fakes.

export const DEBOUNCE_MS = 800;

export interface Draft { fid: string; writerId: string; gen: number; path: string; baseRev: number; text: string; t: number }

/** Where drafts are kept (drafts.ts; a fake in the tests). `put` is synchronous when it returns true (durable now),
 * else it returns the promise of the write that makes it durable (a large draft). `drop` removes this writer's
 * drafts whose gen is at most `upTo`, checked at the time of the removal. */
export interface DraftStore {
  put(d: Draft): true | Promise<void>;
  drop(fid: string, writerId: string, upTo: number): Promise<void>;
  all(fid: string): Promise<Draft[]>;
}

export interface SaverIO {
  /** Write the file with these bytes if its revision is still `base`; the new revision. Throws {code: "conflict"} if
   * it isn't, anything else for a refusal. */
  write(bytes: Uint8Array, base: number): Promise<number>;
  /** The file's text and revision now, or null if it isn't there (or isn't this file any more). */
  current(): Promise<{ text: string; rev: number } | null>;
  /** Keep `text` as a version of this file, without writing the file (fid-checked). */
  keepVersion(text: string): Promise<void>;
  /** The bytes a text is saved as, or why it can't be. */
  encode(text: string): Uint8Array | string;
}

export type SaveState =
  | { k: "saved" } | { k: "edited" } | { k: "saving" }
  | { k: "failed"; why: string }
  | { k: "conflict"; why?: string }
  | { k: "preserving" };

export interface SaverUI {
  text(): string;
  /** Put this text in the editor (the file's, changed elsewhere; or a recovered draft) */
  setText(text: string): void;
  readOnly(on: boolean): void;
  state(s: SaveState): void;
}

export interface Timers { set(f: () => void, ms: number): unknown; clear(h: unknown): void }

export class AutoSaver {
  gen = 0;
  /** the highest gen a completed write covered */
  ackGen = 0;
  savedText: string;
  rev: number;
  /** the revisions this editor wrote (its own echoes) */
  private own = new Set<number>();
  private writing: Promise<boolean> | null = null;
  private timer: unknown = null;
  /** the other text and its revision while a conflict is shown */
  conflict: { text: string; rev: number } | null = null;
  private failedWhy: string | null = null;
  disposed = false;
  state: SaveState = { k: "saved" };

  constructor(private io: SaverIO, private drafts: DraftStore, readonly id: { fid: string; writerId: string; path: () => string },
    init: { text: string; rev: number }, private ui: SaverUI, private timers: Timers, private now: () => number = Date.now) {
    this.savedText = init.text; this.rev = init.rev;
  }

  private show(s: SaveState) { this.state = s; if (!this.disposed) this.ui.state(s); }
  /** Edits not yet written (the editor's text isn't what was last saved), or a write failed. */
  get pending(): boolean { return this.gen > this.ackGen; }
  get failed(): boolean { return this.state.k === "failed"; }

  /** After each edit of the person's: a new gen, its draft durable now, the write scheduled. */
  edited(): void {
    if (this.disposed) return;
    const g = ++this.gen, text = this.ui.text();
    this.draft(g, text);
    if (this.conflict || this.state.k === "preserving") return;
    if (!this.failed) this.show({ k: "edited" });
    if (this.timer !== null) this.timers.clear(this.timer);
    this.timer = this.timers.set(() => { this.timer = null; void this.flush(); }, DEBOUNCE_MS);
  }

  private draft(gen: number, text: string): void {
    const d: Draft = { fid: this.id.fid, writerId: this.id.writerId, gen, path: this.id.path(), baseRev: this.rev, text, t: this.now() };
    let r: true | Promise<void>;
    try { r = this.drafts.put(d); } catch (e) { this.fail("this browser couldn't keep a copy of your edits (" + String((e as Error)?.message ?? e).slice(0, 120) + ")"); return; }
    if (r !== true) r.catch((e) => this.fail("this browser couldn't keep a copy of your edits (" + String((e as Error)?.message ?? e).slice(0, 120) + ")"));
  }

  private fail(why: string) { this.failedWhy = why; this.show({ k: "failed", why }); }

  /** Write what is pending now (Ctrl+S, blur, hidden, pagehide, a switch, the debounce): true once the editor's text
   * as of this call is written (or nothing was pending), false if a write failed or a conflict is open. */
  async flush(): Promise<boolean> {
    if (this.timer !== null) { this.timers.clear(this.timer); this.timer = null; }
    for (;;) {
      if (this.conflict) return false;
      if (this.writing) { await this.writing; continue; }
      if (!this.pending) { if (!this.failed && !this.disposed) this.show({ k: "saved" }); return true; }
      const target = this.gen;
      this.writing = this.writeOnce();
      const ok = await this.writing;
      this.writing = null;
      if (!ok) return false;
      if (this.ackGen >= target) { if (!this.pending) this.show({ k: "saved" }); else if (!this.disposed && this.timer === null) this.timer = this.timers.set(() => { this.timer = null; void this.flush(); }, DEBOUNCE_MS); return true; }
    }
  }

  // One write: the snapshot taken now; its acknowledgement moves the baseline to it, and only it.
  private async writeOnce(): Promise<boolean> {
    const snap = { gen: this.gen, text: this.disposed ? this.lastText : this.ui.text(), base: this.rev };
    this.lastText = snap.text;
    const bytes = this.io.encode(snap.text);
    if (typeof bytes === "string") { this.fail(bytes); return false; }
    this.show({ k: "saving" });
    let rev: number;
    try { rev = await this.io.write(bytes, snap.base); }
    catch (e: any) {
      if (e?.code === "conflict") { await this.openConflict(); return false; }
      this.fail(String(e?.message ?? e).slice(0, 200)); return false;
    }
    this.own.add(rev);
    if (rev > this.rev) this.rev = rev;
    this.savedText = snap.text;
    if (snap.gen > this.ackGen) this.ackGen = snap.gen;
    this.failedWhy = null;
    if (this.state.k === "failed") this.show({ k: this.pending ? "edited" : "saved" });
    await this.drafts.drop(this.id.fid, this.id.writerId, snap.gen).catch(() => {});
    return true;
  }
  // (the text of the last snapshot, for a flush after dispose: the editor's element may be gone)
  private lastText = "";

  /** The file changed (the workspace's watch: this path). Its own echo (a revision it wrote) changes nothing. */
  async external(): Promise<void> {
    if (this.disposed) return;
    // (an echo may come before this editor's write resolves: decided once it has, when its revision is known)
    while (this.writing) { await this.writing; if (this.disposed) return; }
    const cur = await this.io.current();
    if (!cur || this.disposed || cur.rev === this.rev || this.own.has(cur.rev)) return;
    if (!this.pending && !this.writing && !this.conflict) {
      this.rev = cur.rev; this.savedText = cur.text;
      this.ui.setText(cur.text);
      this.show({ k: "saved" });
      return;
    }
    await this.openConflict(cur);
  }

  private async openConflict(cur?: { text: string; rev: number } | null) {
    cur ??= await this.io.current();
    if (!cur) { this.fail("this file isn't here any more"); return; }
    this.conflict = { text: cur.text, rev: cur.rev };
    if (this.timer !== null) { this.timers.clear(this.timer); this.timer = null; }
    this.show({ k: "conflict" });
  }

  /** Keep mine: written over the exact revision the conflict showed; another writer since is a new conflict. */
  async keepMine(): Promise<boolean> {
    const c = this.conflict;
    if (!c || this.disposed) return false;
    const snap = { gen: this.gen, text: this.ui.text() };
    const bytes = this.io.encode(snap.text);
    if (typeof bytes === "string") { this.fail(bytes); return false; }
    this.show({ k: "saving" });
    let rev: number;
    try { rev = await this.io.write(bytes, c.rev); }
    catch (e: any) {
      if (e?.code === "conflict") { await this.openConflict(); return false; }
      this.show({ k: "conflict", why: String(e?.message ?? e).slice(0, 200) }); return false;
    }
    this.own.add(rev); this.rev = rev; this.savedText = snap.text; this.conflict = null;
    if (snap.gen > this.ackGen) this.ackGen = snap.gen;
    await this.drafts.drop(this.id.fid, this.id.writerId, snap.gen).catch(() => {});
    if (this.pending) { this.show({ k: "edited" }); void this.flush(); } else this.show({ k: "saved" });
    return true;
  }

  /** Use theirs: mine kept first as a version of the file (the editor read-only meanwhile); then theirs loaded. If
   * keeping mine fails, or mine changed anyway, nothing is replaced and the conflict stays. */
  async useTheirs(): Promise<boolean> {
    const c = this.conflict;
    if (!c || this.disposed) return false;
    const mine = { gen: this.gen, text: this.ui.text() };
    this.ui.readOnly(true); this.show({ k: "preserving" });
    try { await this.io.keepVersion(mine.text); }
    catch (e: any) {
      this.ui.readOnly(false);
      this.show({ k: "conflict", why: "your text couldn't be kept as a version (" + String(e?.message ?? e).slice(0, 120) + "): nothing was replaced" });
      return false;
    }
    if (this.disposed) return false;
    this.ui.readOnly(false);
    if (this.gen !== mine.gen || this.ui.text() !== mine.text) { this.show({ k: "conflict", why: "you typed meanwhile: your newer text is kept" }); return false; }
    this.conflict = null; this.rev = c.rev; this.savedText = c.text;
    this.ui.setText(c.text);
    this.ackGen = this.gen;
    await this.drafts.drop(this.id.fid, this.id.writerId, mine.gen).catch(() => {});
    this.show({ k: "saved" });
    return true;
  }

  /** On open: the drafts of this file that edits never reached it (any writer: another tab, a closed one). One: put
   * in the editor and written (compare-and-swap; changed since, a conflict). Several: each kept as a version first,
   * none chosen; their count returned. Drafts equal to the file are dropped. */
  async recover(): Promise<{ recovered: number; kept: number }> {
    const all = await this.drafts.all(this.id.fid).catch(() => [] as Draft[]);
    // (per writer, its highest gen)
    const best = new Map<string, Draft>();
    for (const d of all) if (d.writerId !== this.id.writerId && (!best.has(d.writerId) || best.get(d.writerId)!.gen < d.gen)) best.set(d.writerId, d);
    const live = [...best.values()].filter((d) => d.text !== this.savedText);
    for (const d of best.values()) if (d.text === this.savedText) await this.drafts.drop(d.fid, d.writerId, d.gen).catch(() => {});
    if (this.disposed || !live.length) return { recovered: 0, kept: 0 };
    if (live.length === 1) {
      const d = live[0];
      this.ui.setText(d.text);
      this.edited();
      // (the draft is now this writer's too; the other writer's goes once this one's is durable and written)
      if (d.baseRev !== this.rev) { await this.openConflict(); return { recovered: 1, kept: 0 }; }
      if (await this.flush()) await this.drafts.drop(d.fid, d.writerId, d.gen).catch(() => {});
      return { recovered: 1, kept: 0 };
    }
    let kept = 0;
    for (const d of live) {
      try { await this.io.keepVersion(d.text); await this.drafts.drop(d.fid, d.writerId, d.gen); kept++; } catch {}
    }
    return { recovered: 0, kept };
  }

  /** The editor is closing: what is pending is written (the drafts keep it if that fails); no UI change after. */
  dispose(): Promise<boolean> {
    if (!this.disposed) this.lastText = this.ui.text();
    const p = this.pending && !this.conflict ? this.flush() : Promise.resolve(!this.pending);
    this.disposed = true;
    return p;
  }
}
