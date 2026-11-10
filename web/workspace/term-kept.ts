// The Terminal's kept history (William's H9, step 2; astra's and @sagebrush's rulings, Nov 10): the shell's folder and
// the last commands typed, kept in this browser for this workspace (its meta store: never synced, exported, copied or
// read by an agent), so a Terminal opened later, on any of the workspace's pages, has them back.  Only the commands as
// typed, never their output: a command that starts with a space or a tab isn't kept (bash's ignorespace), nor a blank
// one; at most TERM_KEPT.entries of them and TERM_KEPT.bytes of UTF-8 together, the oldest going first (one longer
// than that isn't kept).  `gen` counts End session's clears: a write for an older gen (another page's, or a late one)
// is refused, so cleared history never comes back.
export const TERM_KEPT = { entries: 500, bytes: 1 << 20 };
export const TERM_KEPT_KEY = "terminal-kept";
export type TermKept = { gen: number; cwd: string; history: string[] };

const utf8 = (s: string) => new TextEncoder().encode(s).length;
/** The commands of `history` (oldest first) that are kept: the newest, within TERM_KEPT, ignorespace's left out. */
export function keepable(history: readonly unknown[]): string[] {
  const out: string[] = [];
  let bytes = 0;
  for (let i = history.length - 1; i >= 0 && out.length < TERM_KEPT.entries; i--) {
    const s = history[i];
    if (typeof s !== "string" || /^[ \t]/.test(s) || s.trim() === "") continue;
    const b = utf8(s);
    if (b > TERM_KEPT.bytes) continue;
    if (bytes + b > TERM_KEPT.bytes) break;
    bytes += b;
    out.unshift(s);
  }
  return out;
}
/** A stored row read: its gen, a /-led cwd and its commands within the bounds; anything else as nothing kept. */
export function termKeptOf(v: unknown): TermKept {
  const o = v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  const gen = Number.isSafeInteger(o.gen) && (o.gen as number) >= 0 ? (o.gen as number) : 0;
  const cwd = typeof o.cwd === "string" && o.cwd.startsWith("/") ? o.cwd : "/";
  return { gen, cwd, history: Array.isArray(o.history) ? keepable(o.history) : [] };
}
