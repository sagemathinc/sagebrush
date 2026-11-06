// File > Examples… and New > From an example… on the notebook and board pages: the gallery's panel (panel.ts, the lazy
// chunk sagebrush-examples-panel.js) where this site serves it and its catalog (/examples/index.json); false where it
// doesn't (the CLI's `sagebrush notebook` and the desktop app carry neither), and the page shows its own list as
// before.  No import of panel.ts here: the chunk is fetched only when chosen.
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
