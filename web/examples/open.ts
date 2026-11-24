// File > Examples… and New > From an example… on the notebook, board, code and LaTeX pages: the gallery's panel
// (panel.ts, the lazy chunk sagebrush-examples-panel.js), the only list of examples, where this site serves it and its
// catalog (/examples/index.json: the site, and the desktop app's app/dist); false where it doesn't, or where there is no
// workspace to copy into, and the page says the examples aren't available.  No import of panel.ts here: the chunk is
// fetched only when chosen.
import type { Entry, Workspace } from "../workspace/api";

/** The gallery panel opened (resolving once it shows), or false when this site has no gallery. */
export async function openGallery(ws: Workspace | null | undefined, open: (e: Entry) => unknown, kind?: "notebook" | "board" | "latex"): Promise<boolean> {
  if (!ws) return false;
  try {
    const at = (p: string) => new URL(p, location.href).href;
    // (the catalog first, as panel.ts's loadCatalog reads it: a site without the gallery answers 404, or a page)
    const r = await fetch(at("/examples/index.json"), { cache: "no-cache", redirect: "error", credentials: "same-origin" });
    if (!r.ok || !Array.isArray((await r.json().catch(() => null))?.examples)) return false;
    const { openExamplesPanel } = await import(at("/sagebrush-examples-panel.js"));
    void openExamplesPanel({ ws, open }, { kind });
    return true;
  } catch {
    return false;
  }
}
