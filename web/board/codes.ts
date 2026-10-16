// A board's code items in several languages (William's item 16, option A):
// an item may say its own `mode`; else it is the board's.  Each language
// the board uses has an interpreter of its own (a BoardCode: code.ts), made
// when an item in it is first given to run, at most MAX_LANGUAGES of them.
// Nothing crosses languages: an item shares names, and so runs in order and
// reruns reactively, only with the items of its own language; a name
// defined in another is that language's ordinary undefined name.  To the
// board this is one engine, as BoardCode is (mount.ts): each call goes to
// the language of the items it names.

import type { BoardMode } from "./doc";
import { BOARD_SEED, BoardCode, type CodeState } from "./code";
import { DOC_CAP, ENTRY_MAX, sizeOf, type CachedOutputs, type OutputCache } from "./outcache";
import type { Preview } from "./preview";

/** at most this many interpreters (languages) for one board */
export const MAX_LANGUAGES = 4;
const NAMES: Record<BoardMode, string> = { python: "Python", sage: "Sage", magma: "Magma", matlab: "MATLAB" };

type Item = { id: string; code: string; preview?: Preview; mode?: BoardMode };

export class BoardCodes {
  /** a cell's output or state changed */
  onChange: (() => void) | null = null;
  /** items that ran (after each run, of any language) */
  onRan: ((ids: string[]) => void) | null = null;
  /** why a language's interpreter could not start, or why one wasn't made */
  error: string | null = null;
  /** a language's interpreter could not start (made as its items first came:
   * after `ready`, which is only the interpreters made so far) */
  onError: ((why: string) => void) | null = null;
  /** the board's output cache, and its name for the board shown: every language's (code.ts) */
  private cacheSet: OutputCache | null = null;
  private cacheIdSet: string | null = null;
  get cache() { return this.cacheSet; }
  set cache(c: OutputCache | null) { this.cacheSet = c; for (const e of this.engines.values()) e.cache = c; }
  get cacheId() { return this.cacheIdSet; }
  set cacheId(id: string | null) { this.cacheIdSet = id; for (const e of this.engines.values()) e.cacheId = id; }
  private engines = new Map<BoardMode, BoardCode>();
  private modeOf = new Map<string, BoardMode>();
  // (the document the last sync was of: its cache id)
  private syncedDoc: string | null | undefined = undefined;
  private pictures: unknown = null;
  private previewMsSet: number | null = null;
  private cacheMsSet: number | null = null;
  // (refused: a language past MAX_LANGUAGES; its items' state is "error", and their text says why)
  private refused = new Map<string, string>();

  /** @param make an interpreter for a language (the host's: page.ts) */
  constructor(private make: (mode: BoardMode) => BoardCode) {}

  /** the languages' engines, ready (none yet: true; false if any could not start) */
  get ready(): Promise<boolean> {
    const es = [...this.engines.values()];
    return Promise.all(es.map((e) => e.ready)).then((oks) => oks.every(Boolean));
  }
  /** the language of an item (as last given to run) */
  modeFor(id: string): BoardMode | undefined {
    return this.modeOf.get(id);
  }
  private engine(mode: BoardMode, make = true): BoardCode | null {
    let e = this.engines.get(mode);
    if (e || !make) return e ?? null;
    e = this.make(mode);
    e.mode = mode;
    e.onChange = () => this.onChange?.();
    e.onRan = (ids) => this.onRan?.(ids);
    e.cache = this.cache;
    e.cacheId = this.cacheId;
    if (this.pictures !== null) e.usePictures(this.pictures);
    if (this.previewMsSet !== null) e.previewMs = this.previewMsSet;
    if (this.cacheMsSet !== null) e.cacheMs = this.cacheMsSet;
    e.ready.then((ok) => {
      if (ok || !e!.error || this.engines.get(mode) !== e) return;
      // (named by its language only when the board has another)
      const why = this.engines.size > 1 ? `${NAMES[mode]}: ${e!.error}` : e!.error;
      this.error ??= why;
      this.onError?.(why);
    });
    this.engines.set(mode, e);
    return e;
  }
  private of(id: string): BoardCode | null {
    const m = this.modeOf.get(id);
    return m ? this.engines.get(m) ?? null : null;
  }
  // (ids by their languages' engines, in their order)
  private split(ids: string[]): Map<BoardCode, string[]> {
    const out = new Map<BoardCode, string[]>();
    for (const id of ids) { const e = this.of(id); if (e) (out.get(e) ?? out.set(e, []).get(e)!).push(id); }
    return out;
  }

  /**
   * The board's code items, in reading order, each in its language (its
   * own, or `mode`, the board's): each language's engine is given its
   * items, in that order (one made for a language first used, past
   * MAX_LANGUAGES none: those items say so); an engine whose language
   * has no items left is given none.  Resolves to the ids run.
   */
  async sync(items: Item[], mode: BoardMode = "python", seed?: string): Promise<string[]> {
    const parts = new Map<BoardMode, Item[]>();
    // (an item whose language changed, in the same document: its stored
    // preview is the other language's output, so it is not shown as this
    // one's, held unrun: it runs.  Another document's ids are not its own.)
    const was = this.syncedDoc === this.cacheIdSet ? new Map(this.modeOf) : new Map<string, BoardMode>();
    this.syncedDoc = this.cacheIdSet;
    for (const it of items) {
      const m = it.mode ?? mode, before = was.get(it.id);
      const item = before !== undefined && before !== m && it.preview ? (({ preview: _, ...rest }) => rest)(it) : it;
      (parts.get(m) ?? parts.set(m, []).get(m)!).push(item);
    }
    this.modeOf.clear();
    this.refused.clear();
    const used = [...parts.keys()];
    // (the board's own language first, then in the order they come: those past the cap refused)
    used.sort((a, b) => (a === mode ? -1 : b === mode ? 1 : 0));
    const allowed = new Set(used.filter((m) => this.engines.has(m)).concat(used.filter((m) => !this.engines.has(m))).slice(0, MAX_LANGUAGES));
    const runs: Promise<string[]>[] = [];
    for (const [m, its] of parts) {
      if (!allowed.has(m)) {
        for (const it of its) this.refused.set(it.id, `${NAMES[m]} isn't run: a board runs at most ${MAX_LANGUAGES} languages`);
        continue;
      }
      for (const it of its) this.modeOf.set(it.id, m);
      runs.push(this.engine(m)!.sync(its.map(({ mode: _, ...rest }) => rest), m, seed ?? BOARD_SEED));
    }
    // (a language with no items now: its cells gone)
    for (const [m, e] of this.engines) if (!parts.has(m)) runs.push(e.sync([], m, seed ?? BOARD_SEED));
    return (await Promise.all(runs)).flat();
  }

  output(id: string, copy = false): HTMLElement | null {
    const r = this.refused.get(id);
    if (r) { const d = document.createElement("div"); d.className = "board-code-refused"; d.textContent = r; return d; }
    return this.of(id)?.output(id, copy) ?? null;
  }
  state(id: string): CodeState {
    return this.refused.has(id) ? "error" : this.of(id)?.state(id) ?? "";
  }
  text(id: string): string {
    return this.refused.get(id) ?? this.of(id)?.text(id) ?? "";
  }
  generation(id: string): number {
    return this.of(id)?.generation(id) ?? 0;
  }
  /** a code item's code, highlighted in its language */
  highlight(src: string, id: string): string | null {
    const e = this.of(id) ?? [...this.engines.values()][0];
    return e?.highlight ? e.highlight(src) : null;
  }

  /** Run these items, then what depends on them, each in its language. */
  async run(ids: string[]): Promise<any> {
    const reports = await Promise.all([...this.split(ids)].map(([e, part]) => e.run(part)));
    return { ran: reports.flatMap((r) => (Array.isArray(r?.ran) ? r.ran : [])) };
  }
  /** Run every item: each language's, in the board's order. */
  async runAll(): Promise<any> {
    const reports = await Promise.all([...this.engines.values()].map((e) => e.runAll()));
    return { ran: reports.flatMap((r) => (Array.isArray(r?.ran) ? r.ran : [])) };
  }
  async idle(): Promise<void> {
    await Promise.all([...this.engines.values()].map((e) => e.idle()));
  }
  interrupt() {
    for (const e of this.engines.values()) e.interrupt();
  }
  close() {
    for (const e of this.engines.values()) e.close();
    this.engines.clear();
  }

  usePictures(budget: unknown) {
    this.pictures = budget;
    for (const e of this.engines.values()) e.usePictures(budget);
  }
  set previewMs(ms: number) { this.previewMsSet = ms; for (const e of this.engines.values()) e.previewMs = ms; }
  get previewMs() { return this.previewMsSet ?? [...this.engines.values()][0]?.previewMs ?? 0; }
  set cacheMs(ms: number) { this.cacheMsSet = ms; for (const e of this.engines.values()) e.cacheMs = ms; }
  get cacheMs() { return this.cacheMsSet ?? [...this.engines.values()][0]?.cacheMs ?? 0; }

  async previews(ids: string[]): Promise<Map<string, { preview: Preview | null; gen: number }>> {
    const maps = await Promise.all([...this.split(ids)].map(([e, part]) => e.previews(part)));
    return new Map(maps.flatMap((m) => [...m]));
  }
  async outputKeys(): Promise<Record<string, { key: string | null; ms: number | null; fromRoot: number; untimed: number; widget: boolean }> | null> {
    const all = await Promise.all([...this.engines.values()].map((e) => e.outputKeys()));
    if (all.every((k) => k === null) && all.length) return null;
    // (each id its own entry, __proto__ too: defined, not assigned, SEC-781-1)
    const out: Record<string, any> = {};
    for (const k of all) for (const [id, v] of Object.entries(k ?? {})) Object.defineProperty(out, id, { value: v, enumerable: true, writable: true, configurable: true });
    return out;
  }
  /** What a downloaded board carries (code.ts carry()): every language's,
   * the slowest first, at most DOC_CAP in all; with `expect`, only if each
   * language's items are as given (else null). */
  async carry(expect?: { mode: BoardMode; seed?: string; items: { id: string; code: string; mode?: BoardMode }[] }): Promise<CachedOutputs[] | null> {
    const got: (CachedOutputs[] | null)[] = [];
    for (const [m, e] of this.engines) {
      if (!expect) { got.push(await e.carry()); continue; }
      const items = expect.items.filter((it) => (it.mode ?? expect.mode) === m).map(({ id, code }) => ({ id, code }));
      got.push(await e.carry({ mode: m, seed: expect.seed, items }));
    }
    if (got.some((g) => g === null)) return null;
    const out = (got as CachedOutputs[][]).flat().sort((a, b) => b.total - a.total);
    let total = 0;
    return out.filter((e) => {
      const n = sizeOf(e.outputs);
      if (n > ENTRY_MAX || total + n > DOC_CAP) return false;
      total += n;
      return true;
    });
  }
}
