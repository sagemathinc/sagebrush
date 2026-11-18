// A pairing link (?pair=CODE&port=N, as an agent on this computer prints it): read once, when this module is first
// evaluated, and taken out of the address bar at once, so the code doesn't stay on screen, in the history, in a
// bookmark or a copied URL. Pages import this module before anything else that reads or reports the URL.

export type PairLink = { code: string; port: string };

const PARAMS = ["pair", "port"];

// (the board page's handover of a bare link to the notebook page (decided Nov 18 2026): within this tab only, never in a
// second URL, so the code isn't sent again, logged, shown or given as a Referer; the notebook page takes it once, deleting
// it as it reads, and only while fresh)
export const HANDOFF_KEY = "sb-pair-handoff-v1";
export const HANDOFF_MS = 30_000;
/** Hand `link` over to the notebook page of this tab: true only if it is stored, as read back (else the caller keeps it). */
export function handOver(l: PairLink, now = Date.now()): boolean {
  try {
    const v = JSON.stringify({ code: l.code, port: l.port, at: now });
    sessionStorage.setItem(HANDOFF_KEY, v);
    if (sessionStorage.getItem(HANDOFF_KEY) === v) return true;
    sessionStorage.removeItem(HANDOFF_KEY);
  } catch { /* (no storage: not handed over) */ }
  return false;
}
/** The handed-over link, on the notebook page only (/), deleted before it is looked at; null if none, stale or malformed. */
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

function take(): PairLink | null {
  if (typeof location === "undefined") return null;
  const q = new URLSearchParams(location.search);
  if (!q.has("pair")) return location.search || location.hash ? null : takeHandoff(location.pathname);
  const link = { code: q.get("pair") ?? "", port: q.get("port") ?? "" };
  for (const p of PARAMS) q.delete(p);
  const search = q.toString();
  try {
    history.replaceState(history.state, "", location.pathname + (search ? "?" + search : "") + location.hash);
  } catch { /* (a page that can't rewrite its URL keeps it; the code is still single use, for 5 minutes) */ }
  return link;
}

// (one link per page: a chunk with its own copy of this module (the LaTeX editor's agent chunk, the notebook page's)
// gets the link the page took first, by this key, as the URL no longer has it)
const KEY = Symbol.for("sagebrush.pairLink");
const g = globalThis as any;
const link: PairLink | null = KEY in g ? g[KEY] : (g[KEY] = take());

/** The pairing link this page was opened with, if any (the URL no longer shows it). */
export function pairLink(): PairLink | null {
  return link;
}
