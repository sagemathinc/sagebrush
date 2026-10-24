// Following a board's file as `sagebrush board open FILE` serves it (src/board-open.ts; web/board/page.ts): the
// server's events say each new revision of the file; the file is then read once and shown, one read at a time,
// the latest revision said winning.  A read that fails (the server busy, gone, the network) is tried again after
// a delay that doubles up to RETRY_MAX_MS, or at once when the events reconnect, never in a loop; stopping
// cancels whatever waits (astra's CORR-BOARDOPEN-1).

/** The first delay before a failed read is tried again, and the most it grows to (ms). */
export const RETRY_FIRST_MS = 1000, RETRY_MAX_MS = 30_000;

export interface FollowRead { revision: string; doc?: unknown; notice: string; error?: string }
export interface FollowEvents {
  addEventListener(type: "board", f: (e: { data: unknown }) => void): void;
  onerror: ((e?: unknown) => void) | null;
  onopen: ((e?: unknown) => void) | null;
  close(): void;
}
export interface FollowDeps {
  /** The server's events. */
  events(): FollowEvents;
  /** The file now. */
  read(): Promise<FollowRead>;
  /** Show this version (resolved once shown). */
  show(doc: any, notice?: string): void | Promise<void>;
  /** The version read isn't a board (its error), reading failed (`failed`), the server stopped (`stopped`) or
   * answers again (`answering`: a bar of the last two goes); null: the version shown is a good one. */
  trouble(what: { error: string } | { failed: string } | { stopped: true } | { answering: true } | null): void;
  /** The revision shown first. */
  shown: string;
  setTimeout?: (f: () => void, ms: number) => unknown;
  clearTimeout?: (t: unknown) => void;
}

/** Follow the file; returns stop. */
export function localFollow(d: FollowDeps): () => void {
  const later = d.setTimeout ?? ((f, ms) => setTimeout(f, ms));
  const cancel = d.clearTimeout ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
  let want = "", shown = d.shown, reading = false, stopped = false, delay = RETRY_FIRST_MS;
  let retry: unknown = null, failing = false;
  const retryLater = () => {
    if (stopped || retry !== null) return;
    retry = later(() => { retry = null; void next(); }, delay);
    delay = Math.min(delay * 2, RETRY_MAX_MS);
  };
  const next = async (): Promise<void> => {
    if (reading || stopped || !want || want === shown) return;
    reading = true;
    let failed = false;
    try {
      const target = want, r = await d.read();
      if (stopped) return;
      delay = RETRY_FIRST_MS;
      failing = false;
      // (the file said to have changed again while it was read: read once more; else this version, good or not)
      if (want !== target) return;
      shown = r.revision || target;
      if (r.doc) { d.trouble(null); await d.show(r.doc, r.notice || undefined); }
      else d.trouble({ error: r.error ?? "unknown" });
    } catch (e: any) {
      failed = failing = true;
      if (!stopped) d.trouble({ failed: String(e?.message ?? e).slice(0, 300) });
    } finally {
      reading = false;
      if (!stopped) { if (failed) retryLater(); else void next(); }
    }
  };
  const es = d.events();
  es.addEventListener("board", (e) => {
    const rev = String(e.data).slice(0, 64);
    if (/^[0-9a-f]{64}$/.test(rev)) { want = rev; if (!failing) void next(); }
  });
  es.onerror = () => { if (!stopped) d.trouble({ stopped: true }); };
  // (the events back: a read that failed is tried again at once, the delay from the start)
  es.onopen = () => {
    if (stopped) return;
    delay = RETRY_FIRST_MS;
    if (retry !== null) { cancel(retry); retry = null; }
    failing = false;
    d.trouble({ answering: true });
    void next();
  };
  return () => {
    stopped = true;
    if (retry !== null) { cancel(retry); retry = null; }
    es.close();
  };
}
