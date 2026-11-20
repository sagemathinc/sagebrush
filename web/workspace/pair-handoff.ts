// The board page's handover of a bare pairing link (decided Nov 18 2026): an agent's /board/?pair=CODE&port=N with
// nothing else in it opens on the notebook page instead, where what the agent makes opens in place. The code goes within
// this tab only, never in a second URL, so the handover adds no second request, URL or referrer with the code in it; the
// notebook page takes it once, deleting it as it reads, and only while fresh. A module of its own, imported by those two
// pages only, so the other pages' pairing (the LaTeX editor's chunk) carries none of it.
import type { PairLink } from "./pair-link";

export const HANDOFF_KEY = "sb-pair-handoff-v1";
export const HANDOFF_MS = 30_000;
/** Hand `l` over to the notebook page of this tab: true only if it is stored, as read back (else the caller keeps it). */
export function handOver(l: PairLink, now = Date.now()): boolean {
  try {
    const v = JSON.stringify({ code: l.code, port: l.port, at: now });
    sessionStorage.setItem(HANDOFF_KEY, v);
    if (sessionStorage.getItem(HANDOFF_KEY) === v) return true;
    sessionStorage.removeItem(HANDOFF_KEY);
  } catch { /* (no storage: not handed over) */ }
  return false;
}
/** The handed-over link, on the notebook page only (/, its address with no query and no hash), deleted before it is
 * looked at; null if none, stale or malformed. */
export function takeHandoff(path: string, now = Date.now()): PairLink | null {
  if (path !== "/" && path !== "/index.html") return null;
  let v: string | null = null;
  try { v = sessionStorage.getItem(HANDOFF_KEY); if (v !== null) sessionStorage.removeItem(HANDOFF_KEY); } catch { return null; }
  if (v === null) return null;
  try {
    const o = JSON.parse(v);
    if (typeof o?.code !== "string" || !/^[A-Za-z0-9 -]{1,64}$/.test(o.code) || typeof o.port !== "string" || !/^[0-9]{1,5}$/.test(o.port) || typeof o.at !== "number" || !(now - o.at >= 0 && now - o.at < HANDOFF_MS)) return null;
    return { code: o.code, port: o.port };
  } catch { return null; }
}
