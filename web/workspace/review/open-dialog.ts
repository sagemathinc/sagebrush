// The pages that offer branches open the person's review here (the Agents page's "Review changes", the board's
// ⋯ ▸ Review changes…): a dialog, then the review's chunk (sagebrush-review.js) and, for a notebook's document as
// submitted, the notebook's (sagebrush-notebook.js), each fetched at first use.  Closing the dialog closes the review.
// Eager in those pages, so it stays this small: it names the chunk only for a dynamic import.

/** `site`: the site's root URL (the chunks are there); `host`: Workspace.reviewHost(). */
export async function openReviewDialog(host: unknown, site: URL): Promise<void> {
  const dlg = document.createElement("dialog"), panel = document.createElement("div"), x = document.createElement("button");
  dlg.className = "review-dlg";
  dlg.style.cssText = "width:min(900px,95vw);max-height:90vh;overflow:auto";
  x.textContent = "×";
  x.setAttribute("aria-label", "Close");
  x.style.cssText = "float:right;border:0;background:none;font-size:20px;cursor:pointer";
  x.onclick = () => dlg.close();
  dlg.append(x, panel);
  document.body.append(dlg);
  dlg.showModal();
  let view: { close(): void } | null = null;
  dlg.addEventListener("close", () => { view?.close(); dlg.remove(); }, { once: true });
  const mod = (await import(new URL("sagebrush-review.js", site).href)) as typeof import("./review-page");
  if (!dlg.isConnected) return;
  view = mod.openReview(host as any, {}, panel, { notebook: () => import(new URL("sagebrush-notebook.js", site).href) });
}

/** `el` shown only while the workspace has a branch (its records): checked now and after its changes, one check at a
 * time, the changes meanwhile (and within `ms`) making one more; returns the stop, after which nothing is checked. */
export function showWhenBranches(ws: { watch(f: () => void): () => void; branchRecords(): Promise<Map<string, unknown>> }, el: HTMLElement, ms = 200): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null, active = false, dirty = false, stopped = false;
  const check = () => {
    timer = null;
    if (stopped) return;
    if (active) { dirty = true; return; }
    active = true; dirty = false;
    void ws.branchRecords().then((m) => { if (!stopped) el.hidden = !m.size; }, () => {}).finally(() => {
      active = false;
      if (dirty && !stopped) schedule();
    });
  };
  const schedule = () => { if (!timer && !stopped) timer = setTimeout(check, ms); };
  const off = ws.watch(schedule);
  check();
  return () => { stopped = true; off(); if (timer) clearTimeout(timer); timer = null; };
}
