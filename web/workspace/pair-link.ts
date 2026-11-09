// A pairing link (?pair=CODE&port=N, as an agent on this computer prints it): read once, when this module is first
// evaluated, and taken out of the address bar at once, so the code doesn't stay on screen, in the history, in a
// bookmark or a copied URL. Pages import this module before anything else that reads or reports the URL.

export type PairLink = { code: string; port: string };

const PARAMS = ["pair", "port"];

function take(): PairLink | null {
  if (typeof location === "undefined") return null;
  const q = new URLSearchParams(location.search);
  if (!q.has("pair")) return null;
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
