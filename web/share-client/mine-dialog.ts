// Your shares (File ▸ Your shares…, and the Share dialog's footer): the dialog, in a chunk of its own
// (/sagebrush-share-mine.js), loaded only when it is chosen.  It lists the signed-in person's shares (GET
// /api/share/mine, newest first), each with Copy link, Open and Delete; Delete asks first, in the dialog, then
// DELETE /api/share/collections/<id> discards the share for good.  A share with no version yet (an older page's
// empty one) has no page, so it isn't listed.
import { shareStatus, signInUrl } from "./upload";

/** Board's lines. */
export const MINE = {
  title: "Your shares",
  empty: "You haven't shared anything yet.",
  none: "You have no shares now.",
  signIn: "Sign in with CoCalc to see your shares.",
  off: "Sharing isn't available on this site.",
  unreachable: "Couldn't reach the server to check your sign-in. Try again in a moment.",
  cantLoad: "Couldn't load your shares. Try again in a moment.",
  deleteFailed: "Couldn't delete it. Try again in a moment.",
  confirm: (title: string) => `Delete “${title}”? Its links stop working for everyone, and this can't be undone. Copies people already made stay theirs.`,
};

type Share = { id: string; title: string; created: number; updated: number; latest: string | null };

const STYLE = `#sbminedlg{border:1px solid var(--line);border-radius:10px;background:var(--cell);color:var(--fg);padding:14px 16px;width:min(620px,94vw)}
#sbminedlg::backdrop{background:rgba(0,0,0,.35)}#sbminedlg .note{color:var(--muted);font-size:13px;margin:2px 0 8px}
#sbminedlg .rows{max-height:50vh;overflow:auto;margin:6px 0;font-size:13px}
#sbminedlg .row{display:flex;gap:8px;align-items:center;padding:5px 0;border-top:1px solid var(--line)}
#sbminedlg .row .what{flex:1;min-width:0}#sbminedlg .row .what b{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#sbminedlg .row .when{color:var(--muted);font-size:12px}#sbminedlg .row .ask{flex:1}`;

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> & { className?: string } = {}, ...kids: (Node | string)[]) => {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...kids);
  return e;
};
// (the date as the share page writes it: YYYY-MM-DD)
const day = (s: number) => new Date(s * 1000).toISOString().slice(0, 10);

/** Opens the dialog; resolves when it is closed.  (tests: window.sagebrush.mineDialog is the open one) */
export async function openYourShares(): Promise<void> {
  if (!document.getElementById("sbminestyle")) document.head.append(el("style", { id: "sbminestyle", textContent: STYLE }));
  document.getElementById("sbminedlg")?.remove();
  const close = el("button", { type: "button", textContent: "✕", ariaLabel: "Close" });
  const status = el("p", { className: "note", role: "status" });
  const list = el("div", { className: "rows" });
  const dlg = el("dialog", { id: "sbminedlg" }, el("div", { style: "display:flex;justify-content:space-between;align-items:center" } as any, el("b", { textContent: MINE.title }), close), status, list);
  dlg.setAttribute("aria-label", MINE.title);
  document.body.append(dlg);
  close.onclick = () => dlg.close();
  const closed = new Promise<void>((r) => dlg.addEventListener("close", () => { dlg.remove(); r(); }));
  dlg.showModal();
  (window as any).sagebrush && ((window as any).sagebrush.mineDialog = dlg);

  status.textContent = "Checking your sign-in…";
  const s = await shareStatus();
  if (!s.enabled || !s.me) {
    status.textContent = s.enabled ? MINE.signIn : s.error ? MINE.unreachable : MINE.off;
    if (s.enabled) dlg.append(el("a", { className: "btn", href: signInUrl(location.pathname + location.search), textContent: "Sign in with CoCalc" }));
    return closed;
  }
  let shares: Share[];
  try {
    const r = await fetch("/api/share/mine", { credentials: "same-origin" });
    const j = r.ok ? await r.json() : null;
    if (!Array.isArray(j?.collections)) throw new Error("not a list");
    shares = j.collections.filter((c: any) => c && typeof c.id === "string" && c.latest);
  } catch {
    status.textContent = MINE.cantLoad;
    return closed;
  }
  status.textContent = shares.length ? "" : MINE.empty;
  for (const c of shares) list.append(row(c));

  function row(c: Share) {
    const url = new URL(`/s/${c.id}`, location.href).href;
    const r = el("div", { className: "row" });
    r.dataset.id = c.id;
    const what = el("div", { className: "what" }, el("b", { textContent: c.title || c.id, title: url }), el("span", { className: "when", textContent: `${c.created === c.updated ? "published" : "updated"} ${day(c.updated)}` }));
    const copy = el("button", { type: "button", textContent: "Copy link" });
    copy.onclick = () => void navigator.clipboard?.writeText(url).then(() => { copy.textContent = "Copied"; }, () => {});
    const open = el("button", { type: "button", textContent: "Open", title: "Open in a new tab" });
    open.onclick = () => void window.open(url, "_blank", "noopener");
    const del = el("button", { type: "button", textContent: "Delete" });
    const shown = () => r.replaceChildren(what, copy, open, del);
    // (asked first, in the dialog; the share discarded only once the server says so, else the row stays)
    del.onclick = () => {
      const yes = el("button", { type: "button", textContent: "Delete" }), no = el("button", { type: "button", textContent: "Keep it" });
      r.replaceChildren(el("span", { className: "ask", textContent: MINE.confirm(c.title || c.id) }), yes, no);
      no.onclick = shown;
      yes.onclick = async () => {
        yes.disabled = no.disabled = true;
        let ok = false;
        try {
          ok = (await fetch(`/api/share/collections/${encodeURIComponent(c.id)}`, { method: "DELETE", credentials: "same-origin" })).ok;
        } catch {}
        if (ok) {
          r.remove();
          // (an earlier failure's line goes; after the last one, board's line for none left)
          status.textContent = list.childElementCount ? "" : MINE.none;
        } else {
          shown();
          status.textContent = MINE.deleteFailed;
        }
      };
    };
    shown();
    return r;
  }
  return closed;
}
