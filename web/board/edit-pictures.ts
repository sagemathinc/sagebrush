// The frame's side of pictures sent by reference (web/board-host-protocol.md, "Pictures: imagePut and imageGet"):
// with a host that grants `pictures: "by-reference"`, a board names its pictures only (`i` and 32 hex digits of
// their bytes' SHA-256, as images.ts names them), and their bytes go apart on the channel.
//
// - imageGet: the pictures a board names that this browser doesn't hold, at most 32 names a message, following
//   `more`, at most 2 in flight;
// - imagePut: a picture the user added, before the edit that names it; at most 4 unanswered and 8 MiB of their
//   bytes in flight (the frame waits for room).
//
// No DOM here: the page gives it a port's post and the browser's pictures.

import { uuid } from "./channel";
import type { PicturePrep } from "./edit-channel";

export const PICTURE_BOUNDS = {
  /** names per imageGet */
  getNames: 32,
  /** imageGets in flight */
  gets: 2,
  /** imagePuts unanswered, and their bytes */
  puts: 4,
  putBytes: 8 * 2 ** 20,
  /** one picture */
  pictureBytes: 2_000_000,
  /** the pictures one `images` answer may carry, in all */
  getBytes: 8 * 2 ** 20,
  /** an answer not come in this long: given up on */
  answerMs: 60_000,
};
export const PICTURE_NAME = /^i[0-9a-f]{32}$/;
const TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/** Where the frame keeps pictures: images.ts's Images, as the page has it. */
export interface PictureStore {
  /** a picture's bytes, if this browser holds them */
  blob(name: string): Promise<Blob | undefined>;
  /** keep these bytes; resolves to the name they have (their content's), for the caller to check */
  put(blob: Blob): Promise<string>;
}
export type PutResult = { ok: true } | { ok: false; reason: string; message: string; retryAfter?: number };

export class PictureChannel {
  /** the pictures the host has for this channel, as far as the frame knows: the board's as posted, those put
   * and saved, those the host's own changes named */
  readonly hostHas = new Set<string>();
  private puts = new Map<string, { name: string; bytes: number; done: (r: PutResult) => void; timer: ReturnType<typeof setTimeout> }>();
  private putBytes = 0;
  private gets = new Map<string, { done: (m: any) => void; timer: ReturnType<typeof setTimeout> }>();
  private waiters: (() => void)[] = [];
  /** for tests: what was sent and answered, the latest 200 */
  readonly log: { what: string; name?: string; n?: number }[] = [];

  constructor(private post: (m: object, transfer?: Transferable[]) => void, private store: PictureStore) {}
  private note(what: string, extra: { name?: string; n?: number } = {}) { this.log.push({ what, ...extra }); if (this.log.length > 200) this.log.shift(); }

  /** A host message on the port: true if it was a picture's. */
  receive(m: any): boolean {
    if (!m || typeof m !== "object" || m.version !== 1 || typeof m.id !== "string") return false;
    const put = this.puts.get(m.id), get = this.gets.get(m.id);
    if (put && (m.sagebrush === "imageSaved" || m.sagebrush === "refused")) {
      if (m.sagebrush === "imageSaved") {
        if (m.name !== put.name) return true;
        this.hostHas.add(put.name);
        this.finishPut(m.id, { ok: true });
      } else this.finishPut(m.id, { ok: false, reason: typeof m.reason === "string" ? m.reason : "refused", message: typeof m.message === "string" ? m.message.slice(0, 500) : "refused", ...(typeof m.retryAfter === "number" && m.retryAfter >= 0 ? { retryAfter: m.retryAfter } : {}) });
      return true;
    }
    if (get && (m.sagebrush === "images" || m.sagebrush === "refused")) {
      // (answered: its place kept, as processing, until what it brought is checked and kept: daybreak2's LIMIT-BPR-1)
      this.gets.delete(m.id);
      this.processing++;
      clearTimeout(get.timer);
      get.done(m);
      return true;
    }
    return false;
  }
  private finishPut(id: string, r: PutResult) {
    const p = this.puts.get(id);
    if (!p) return;
    this.puts.delete(id);
    clearTimeout(p.timer);
    this.putBytes -= p.bytes;
    this.note(r.ok ? "saved" : "put refused", { name: p.name });
    p.done(r);
    this.wake();
  }
  private wake() { const w = this.waiters.splice(0); for (const f of w) f(); }
  /** Resolves once `ok()`, having run `take()` in the same step: the room checked and taken at once, so that
   * several waiters woken together can't all take the one place (a test caught six puts going out at once). */
  private room(ok: () => boolean, take: () => void = () => {}): Promise<void> {
    if (ok()) { take(); return Promise.resolve(); }
    return new Promise((r) => { const f = () => { if (ok()) { take(); r(); } else this.waiters.push(f); }; this.waiters.push(f); });
  }
  // (places taken by puts and gets not yet sent)
  private putsTaken = 0;
  private getsTaken = 0;
  // (answers to gets still being checked and kept: they hold their get's place)
  private processing = 0;

  /** Send the picture `name` (held in this browser) to the host, and resolve once it says it has it.  A name it has
   * already: at once. */
  async put(name: string): Promise<PutResult> {
    if (this.hostHas.has(name)) return { ok: true };
    if (!PICTURE_NAME.test(name)) return { ok: false, reason: "invalid", message: "this picture's name isn't one a host takes" };
    const blob = await this.store.blob(name);
    if (!blob) return { ok: false, reason: "invalid", message: "this picture isn't in this browser" };
    if (!TYPES.has(blob.type)) return { ok: false, reason: "invalid", message: `a picture of type ${blob.type || "unknown"} can't be sent` };
    if (blob.size > PICTURE_BOUNDS.pictureBytes) return { ok: false, reason: "too-large", message: `a picture of ${blob.size} bytes is more than a host takes (${PICTURE_BOUNDS.pictureBytes})` };
    await this.room(() => this.puts.size + this.putsTaken < PICTURE_BOUNDS.puts && this.putBytes + blob.size <= PICTURE_BOUNDS.putBytes, () => { this.putsTaken++; this.putBytes += blob.size; });
    const bytes = await blob.arrayBuffer();
    this.putsTaken--;
    if (this.hostHas.has(name)) { this.putBytes -= blob.size; this.wake(); return { ok: true }; }
    const id = uuid();
    return new Promise<PutResult>((done) => {
      const timer = setTimeout(() => this.finishPut(id, { ok: false, reason: "busy", message: "no answer from the host" }), PICTURE_BOUNDS.answerMs);
      this.puts.set(id, { name, bytes: blob.size, done, timer });
      this.note("put", { name });
      this.post({ sagebrush: "imagePut", version: 1, id, name, type: blob.type, bytes }, [bytes]);
    });
  }

  /** Get from the host the pictures among `names` this browser doesn't hold: at most 32 a message, `more` followed,
   * each checked against its name before it is kept.  Resolves to the names still missing. */
  async fetch(names: Iterable<string>): Promise<string[]> {
    const want: string[] = [];
    for (const n of new Set(names)) if (PICTURE_NAME.test(n) && !(await this.store.blob(n))) want.push(n);
    const missing: string[] = [];
    const queue = [...want], asked = new Set<string>(want);
    const one = async (batch: string[]) => {
      await this.room(() => this.gets.size + this.getsTaken + this.processing < PICTURE_BOUNDS.gets, () => { this.getsTaken++; });
      this.getsTaken--;
      const id = uuid();
      const m: any = await new Promise((done) => {
        const timer = setTimeout(() => { this.gets.delete(id); this.processing++; done(null); }, PICTURE_BOUNDS.answerMs);
        this.gets.set(id, { done, timer });
        this.note("get", { n: batch.length });
        this.post({ sagebrush: "imageGet", version: 1, id, names: batch });
      });
      try {
        // (the answer admitted whole, or not at all, before anything of it is hashed or kept: LIMIT-BPR-1)
        const ok = m && m.sagebrush === "images" ? admitImages(m, batch) : null;
        if (!ok) { this.note("answer refused", { n: batch.length }); missing.push(...batch); return; }
        const got = new Set<string>();
        for (const im of ok.images) {
          // (kept only under the name its bytes give: a host's bytes for another name are never kept as that one)
          const kept = await this.store.put(new Blob([im.bytes], { type: im.type }));
          if (kept === im.name) { got.add(im.name); this.hostHas.add(im.name); }
        }
        // (`more`: asked again, once each; a host that keeps saying more is given up on)
        const more = new Set(ok.more), again: string[] = [];
        for (const n of batch) {
          if (got.has(n)) continue;
          if (more.has(n) && !asked.has("again:" + n)) { asked.add("again:" + n); again.push(n); }
          else missing.push(n);
        }
        queue.push(...again);
      } finally {
        this.processing--;
        this.wake();
      }
    };
    const running: Promise<void>[] = [];
    while (queue.length || running.length) {
      while (queue.length && running.length < PICTURE_BOUNDS.gets) {
        const p = one(queue.splice(0, PICTURE_BOUNDS.getNames)).finally(() => running.splice(running.indexOf(p), 1));
        running.push(p);
      }
      await Promise.race(running);
    }
    return missing;
  }
}

/** An `images` answer to an imageGet of `batch`, admitted whole or not at all (daybreak2's LIMIT-BPR-1): at most one
 * picture for each name asked, each name asked at most once, each picture of a type it may be and at most 2,000,000
 * bytes, 8 MiB of them in all; `more`, if given, at most the names asked, each once.  null: refused. */
export function admitImages(m: any, batch: readonly string[]): { images: { name: string; type: string; bytes: ArrayBuffer }[]; more: string[] } | null {
  const images = m.images, more = m.more === undefined ? [] : m.more;
  if (!Array.isArray(images) || images.length > batch.length || !Array.isArray(more) || more.length > batch.length) return null;
  const asked = new Set(batch), seen = new Set<string>(), out: { name: string; type: string; bytes: ArrayBuffer }[] = [];
  let bytes = 0;
  for (const im of images) {
    if (!im || typeof im !== "object" || typeof im.name !== "string" || !asked.has(im.name) || seen.has(im.name)) return null;
    if (!TYPES.has(im.type) || !(im.bytes instanceof ArrayBuffer) || im.bytes.byteLength > PICTURE_BOUNDS.pictureBytes) return null;
    bytes += im.bytes.byteLength;
    if (bytes > PICTURE_BOUNDS.getBytes) return null;
    seen.add(im.name);
    out.push({ name: im.name, type: im.type, bytes: im.bytes });
  }
  const moreSeen = new Set<string>();
  for (const n of more) {
    if (typeof n !== "string" || !asked.has(n) || moreSeen.has(n) || seen.has(n)) return null;
    moreSeen.add(n);
  }
  return { images: out, more: [...moreSeen] };
}

/** By reference: each picture an action adds that the host doesn't have is put, and saved by the host, before the
 * edit naming it is sent (the action taken when it is made: edit-channel.ts).  A picture refused for the user's
 * quota, or as too large, takes that action out (web/board-host-protocol.md, Pictures, Order).  Busy, or no answer:
 * tried again after `retryAfter`, a few times (astra's CORR-PICREF-3); still not saved, or refused for another
 * reason: the action kept for download, its text and all, never dropped. */
export function byReference(p: PictureChannel, retry = { tries: 4, maxWaitMs: 60_000 }): PicturePrep {
  return {
    inline: false,
    needs: (entries) => Object.keys(entries ?? {}).filter((n) => !p.hostHas.has(n)),
    extraBytes: () => 0,
    async prepare(_changes, names) {
      for (const n of names) {
        for (let attempt = 0; ; attempt++) {
          const r = await p.put(n);
          if (r.ok) break;
          if (r.reason === "quota" || r.reason === "too-large") return { ok: false, keep: false, why: r.message };
          if (r.reason === "busy" && attempt < retry.tries) {
            await new Promise((ok) => setTimeout(ok, Math.min(Math.max(r.retryAfter ?? 1000, 0), retry.maxWaitMs)));
            continue;
          }
          return { ok: false, keep: true, why: r.message };
        }
      }
      return { ok: true };
    },
  };
}
