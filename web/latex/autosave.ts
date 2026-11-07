// The LaTeX editor saves as you type (William, Nov 2, U8: "a user should never see 'Leave this file without saving
// your changes?', have to explicitly find and click a 'Save' button"; plan U8 r6, on top of #599).
//
//   - Every edit is durable at once: a draft of the editor's text, bound to the file (fid) and to this editor
//     (writerId, a fresh random id per editor instance, so two tabs never share or replace a draft), written before
//     anything asynchronous (drafts.ts: localStorage, synchronously; a draft too large for it goes to IndexedDB, durable
//     when its transaction completes; William: "Never prompt; accept that tiny risk for >2 MB files").
//   - The file is written 800 ms after the last edit, and at once on flush (blur, hidden, pagehide, a switch, Ctrl+S):
//     one write at a time, by the page's own save (page.ts, #599: compare-and-swap on the revision its saved text came
//     from), of the text as it is when the write starts. Its acknowledgement removes this writer's drafts up to that
//     write's gen only: edits made since stay pending and get the next write.
//   - A change made elsewhere is the page's (#599): followed with nothing pending; with edits pending, its bar asks
//     (Keep mine, Use theirs) and nothing is written meanwhile ("blocked"). Settled, the page says so (settled()).
//   - A write that fails (storage full, the file gone or replaced) is the one state that keeps a prompt on leaving;
//     its edits stay in the editor and in the draft, and are written again on the next edit or flush.
//   - After dispose (the editor closed or switched), nothing of the UI changes.
// Pure logic over injected I/O, timers and draft stores: test-latex-autosave.mjs runs it with fakes.

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
  /** The page's save of exactly this text: "saved"; "blocked" (a change made elsewhere is being asked about, or a
   * choice in its bar is under way: nothing written); "readonly" (this file can't be saved here, the banner says why:
   * nothing written, no prompt); throws for a refusal, its message the reason. */
  write(text: string): Promise<"saved" | "blocked" | "readonly">;
  /** Keep `text` as a version of this file, without writing the file (fid-checked). */
  keepVersion(text: string): Promise<void>;
}

export type SaveState = { k: "saved" } | { k: "edited" } | { k: "saving" } | { k: "blocked" } | { k: "readonly" } | { k: "failed"; why: string };

export interface SaverUI {
  text(): string;
  /** Edits not written: the editor's text isn't the one last saved or read (the page's own baseline) */
  dirty(): boolean;
  /** The revision the page's baseline is of */
  rev(): number;
  /** A change made elsewhere being asked about, or a choice in its bar under way */
  blocked(): boolean;
  /** A recovered draft put in the editor, as an edit of the person's (not saved) */
  adopt(text: string): void;
  /** A recovered draft made on an older revision than the file's: the page's bar asks, as for a change elsewhere */
  stale(): void;
  readOnly(on: boolean): void;
  state(s: SaveState): void;
}

export interface Timers { set(f: () => void, ms: number): unknown; clear(h: unknown): void }

export class AutoSaver {
  gen = 0;
  private writing: Promise<boolean> | null = null;
  private timer: unknown = null;
  disposed = false;
  state: SaveState = { k: "saved" };
  /** whether the last edit's draft is durable (a large one: when its transaction completes) */
  private putting: Promise<boolean> = Promise.resolve(true);

  constructor(private io: SaverIO, private drafts: DraftStore, readonly id: { fid: string; writerId: string; path: () => string },
    private ui: SaverUI, private timers: Timers, private now: () => number = Date.now) {}

  private show(s: SaveState) { this.state = s; if (!this.disposed) this.ui.state(s); }
  get failed(): boolean { return this.state.k === "failed"; }
  private fail(why: string) { this.show({ k: "failed", why }); }
  private schedule() {
    if (this.timer !== null) this.timers.clear(this.timer);
    this.timer = this.timers.set(() => { this.timer = null; void this.flush(); }, DEBOUNCE_MS);
  }

  /** After each edit of the person's: a new gen, its draft durable now, the write scheduled. */
  edited(): void {
    if (this.disposed) return;
    const g = ++this.gen, text = this.ui.text();
    const d: Draft = { fid: this.id.fid, writerId: this.id.writerId, gen: g, path: this.id.path(), baseRev: this.ui.rev(), text, t: this.now() };
    const kept = (e: unknown) => this.fail("this browser couldn't keep a copy of your edits (" + String((e as Error)?.message ?? e).slice(0, 120) + ")");
    let r: true | Promise<void>;
    try { r = this.drafts.put(d); } catch (e) { kept(e); this.putting = Promise.resolve(false); return; }
    this.putting = r === true ? Promise.resolve(true) : r.then(() => true, (e) => (kept(e), false));
    if (this.ui.blocked()) { this.show({ k: "blocked" }); return; }
    if (!this.failed) this.show({ k: "edited" });
    this.schedule();
  }

  /** Write what is pending now (Ctrl+S, blur, hidden, pagehide, a switch, the debounce): true once the editor's text
   * as of this call is written (or nothing was pending), false if a write failed or the page's bar is asking. */
  async flush(): Promise<boolean> {
    if (this.timer !== null) { this.timers.clear(this.timer); this.timer = null; }
    for (;;) {
      if (this.writing) { await this.writing; continue; }
      if (!this.ui.dirty()) { if (!this.failed) this.show({ k: "saved" }); return true; }
      if (this.ui.blocked()) { this.show({ k: "blocked" }); return false; }
      const g = this.gen;
      this.writing = this.writeOnce(g);
      const ok = await this.writing;
      this.writing = null;
      if (!ok) return false;
      // (typed during the write: the next one scheduled, as after any edit; nothing typed: written, Saved)
      if (!this.ui.dirty()) this.show({ k: "saved" });
      else if (!this.disposed && this.timer === null) this.schedule();
      return true;
    }
  }

  private async writeOnce(g: number): Promise<boolean> {
    this.show({ k: "saving" });
    let r: "saved" | "blocked" | "readonly";
    try { r = await this.io.write(this.ui.text()); }
    catch (e: any) { this.fail(String(e?.message ?? e).slice(0, 200)); return false; }
    if (r !== "saved") { this.show({ k: r }); return false; }
    await this.drafts.drop(this.id.fid, this.id.writerId, g).catch(() => {});
    return true;
  }

  /** The page's bar is asking: nothing written until it is settled. */
  held(): void {
    if (this.timer !== null) { this.timers.clear(this.timer); this.timer = null; }
    this.show({ k: "blocked" });
  }

  /** The page's baseline moved to the editor's text at gen `upTo` (theirs taken, Keep mine written, a change
   * followed): this writer's drafts up to it removed; what is still pending written next. */
  settled(upTo = this.gen): void {
    if (this.disposed) return;
    void this.drafts.drop(this.id.fid, this.id.writerId, upTo).catch(() => {});
    if (this.ui.dirty()) { this.show({ k: "edited" }); this.schedule(); } else this.show({ k: "saved" });
  }

  /** On open: the drafts of this file that edits never reached it (any writer: another tab, a closed one). One: put
   * in the editor and written (made on an older revision: the page's bar asks first, nothing written). Several: each
   * kept as a version first, none chosen; their count returned. Drafts equal to the file are dropped. The editor is
   * read-only until this is resolved (astra U8-RECOVERY-1), and a draft never replaces text edited meanwhile. */
  async recover(savedText: string): Promise<{ recovered: number; kept: number }> {
    const gen0 = this.gen;
    this.ui.readOnly(true);
    try {
      const all = await this.drafts.all(this.id.fid).catch(() => [] as Draft[]);
      // (per writer, its highest gen)
      const best = new Map<string, Draft>();
      for (const d of all) if (d.writerId !== this.id.writerId && (!best.has(d.writerId) || best.get(d.writerId)!.gen < d.gen)) best.set(d.writerId, d);
      const live = [...best.values()].filter((d) => d.text !== savedText);
      for (const d of best.values()) if (d.text === savedText) await this.drafts.drop(d.fid, d.writerId, d.gen).catch(() => {});
      if (this.disposed || !live.length) return { recovered: 0, kept: 0 };
      if (live.length === 1 && this.gen === gen0 && !this.ui.blocked()) {
        const d = live[0];
        // (made on an older revision: the bar first, before anything waits, so no write can go out before the person
        //  chooses (astra U8-RECOVERY-2))
        if (d.baseRev !== this.ui.rev()) this.ui.stale();
        this.ui.adopt(d.text);
        this.edited();
        // (the text now in this writer's draft: the other writer's dropped once that is durable, and not if it failed)
        if (await this.putting) await this.drafts.drop(d.fid, d.writerId, d.gen).catch(() => {});
        return { recovered: 1, kept: 0 };
      }
      // (several, or an edit made meanwhile: each kept as a version, none chosen)
      let kept = 0;
      for (const d of live) {
        try { await this.io.keepVersion(d.text); await this.drafts.drop(d.fid, d.writerId, d.gen); kept++; } catch {}
      }
      return { recovered: 0, kept };
    } finally { if (!this.disposed) this.ui.readOnly(false); }
  }

  /** Before a controlled close or switch is released (astra U8-DURABLE-CLOSE-1): the latest edit either written (an
   * acknowledged save, nothing pending) or durable as a draft of the current gen, the latest put waited for (a large
   * draft's IndexedDB write). A newer edit made meanwhile is settled too. False when neither: the write didn't happen
   * (blocked, read-only, refused) and the draft's put failed, so the edit lives only in the editor. */
  async settle(): Promise<boolean> {
    for (;;) {
      const g = this.gen;
      if (this.ui.dirty() && !this.ui.blocked()) await this.flush();
      if (this.gen !== g) continue;
      if (!this.ui.dirty()) return true;
      const durable = await this.putting;
      if (this.gen !== g) continue;
      return durable;
    }
  }

  /** The editor is closing: settled first (written, or durable in its draft); no UI change after. */
  async dispose(): Promise<boolean> {
    try { return await this.settle(); } finally { this.disposed = true; }
  }
}
