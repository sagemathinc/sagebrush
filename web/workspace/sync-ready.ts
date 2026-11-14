// syncReady: whether this browser's index of the account's files holds everything the server's log had when it was
// asked, for a page that must not decide "it isn't there" too early (the account copy of an assignment: a lookup made
// on a partly read index would start a second copy).
//
// A barrier, not a time: the call makes a random token and gives it to the tab that holds the account's connection
// (sync-owner.ts refresh); that tab's client answers it only with a pull asked AFTER it was given whose page reads the
// log to its end, once that page is applied (sync-client.ts refresh, `status.ready`).  So a snapshot made earlier, a
// pull begun before the call, or another call's answer can't pass for it, whatever the clocks say.
// - "current": the token answered, for the lifecycle (account namespace and epoch) the call began under.
// - "off": sync isn't on in this browser, or its lifecycle changed meanwhile (another account, sync turned off).
// - "refused": the log can't be read here now (a large move's replay stopped, or a rebuild under way).
// - "timeout": not answered within the bound (or the caller aborted); never to be taken as "not there".
// The holder changing meanwhile (another tab takes the connection): the token is given to the new holder.
import type { SyncOwner, Snapshot } from "./sync-owner";

export type Ready = "current" | "off" | "refused" | "timeout";

/** At most this long by default, and never longer (a caller's bound is clamped to it). */
export const SYNC_READY = { defaultMs: 30_000, maxMs: 120_000 };

/** A fresh token: 12 base-36 characters from the browser's random source (sync-client READY.form). */
export function readyToken(): string {
  const b = crypto.getRandomValues(new Uint8Array(12));
  return Array.from(b, (x) => (x % 36).toString(36)).join("");
}

/** What `s`, a snapshot of the holder's status, answers for `token`; null: not yet. */
export function readyOf(s: Snapshot, token: string): Ready | null {
  if (s.ready?.includes(token)) return "current";
  if (s.stuck) return "refused";
  return null;
}

/** Waits until this browser's index is current as of the call (see above), through `owner`, the page's sync owner. */
export async function syncReady(owner: SyncOwner, o: { signal?: AbortSignal; timeoutMs?: number; token?: string } = {}): Promise<Ready> {
  const ms = Math.min(Math.max(0, o.timeoutMs ?? SYNC_READY.defaultMs), SYNC_READY.maxMs);
  if (o.signal?.aborted) return "timeout";
  await owner.reconcile();
  const life = owner.lifecycle();
  if (!life || !(await owner.durable())) return "off";
  const token = o.token ?? readyToken();
  return new Promise<Ready>((ok) => {
    let done = false, gen = -1;
    const end = (r: Ready) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      off();
      o.signal?.removeEventListener("abort", abort);
      ok(r);
    };
    const look = () => {
      const l = owner.lifecycle();
      if (!l || l.ns !== life.ns || l.epoch !== life.epoch) return end("off");
      // (another holder than the one asked: the token given again, to it)
      if (owner.holderGen() !== gen) {
        gen = owner.holderGen();
        owner.refresh(token);
      }
      const r = readyOf(owner.view().s, token);
      if (r) end(r);
    };
    const abort = () => end("timeout");
    const timer = setTimeout(() => end("timeout"), ms);
    const off = owner.onChange(look);
    o.signal?.addEventListener("abort", abort);
    look();
  });
}
