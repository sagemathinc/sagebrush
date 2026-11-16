// An example opened again: the person's copy of it found first, and the question asked (William, Nov 16: "open your
// existing version of this or create a new one"), so picking an example twice doesn't leave "<title> (2)", "(3)", ...
// behind without asking.  Both ways of opening one use it: the gallery's "Open a copy" (panel.ts), which makes a folder
// under /Examples, and the page's own list (index.html's File > Examples… where the site has no gallery), which makes a
// notebook at the top.
//
// A copy is recognized by:
//   - its identity, recorded here when the copy is made (noteCopy): an entry keeps its identity through a rename or a
//     move, so a renamed copy still counts.  Kept in this browser's localStorage, as an example id -> identities map;
//   - else, for a copy made before (or in another browser), its name: "<title>" or "<title> (N)" (plus the
//     extension) in the folder copies are made in.
// Only copies on this device count: an entry in Trash, or one whose contents are on another device, is never offered.
import type { Entry, Workspace } from "../workspace/api";
import { TRASH, nameOf, parentOf, safeName, splitExt } from "../workspace/paths";

const KEY = "sagebrush-example-copies";
/** The most identities kept per example (the oldest dropped first) */
const PER_EXAMPLE = 50;

const read = (): Record<string, string[]> => {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
};
const identOf = (e: Entry) => e.ident ?? (e.kind === "folder" ? e.fid : e.ref) ?? undefined;

/** `e` is a copy of example `id`: the entry just made (the gallery's root folder), or its identity (the list's
 * notebook: its id, which is its entry's identity). */
export function noteCopy(id: string, e: Entry | string): void {
  const ident = typeof e === "string" ? e : identOf(e);
  if (!ident) return;
  const all = read();
  all[id] = [...(all[id] ?? []).filter((x) => x !== ident), ident].slice(-PER_EXAMPLE);
  try {
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {}
}

/** Where copies of an example are made, and how each is named: the gallery's, a folder "/Examples/<title>"; the
 * list's, a notebook "/<title>.ipynb" (each name as the copy path makes it: safeName). */
export type Where = { folder: string; kind: "folder" | "notebook"; ext: string; max: number };
export const GALLERY: Where = { folder: "/Examples", kind: "folder", ext: "", max: 120 };
export const LIST: Where = { folder: "/", kind: "notebook", ext: ".ipynb", max: 200 };

/** The person's copies of example `id` (title `title`) on this device, by identity or by name. */
export async function findCopies(ws: Workspace, id: string, title: string, where: Where): Promise<Entry[]> {
  const known = new Set(read()[id] ?? []);
  const base = safeName(title, where.max);
  const byName = (e: Entry) => {
    if (e.kind !== where.kind || parentOf(e.path) !== where.folder) return false;
    const [b, ext] = where.ext ? splitExt(nameOf(e.path)) : [nameOf(e.path), ""];
    if (ext !== where.ext) return false;
    return b === base || (b.startsWith(base + " (") && /^ \(\d+\)$/.test(b.slice(base.length)));
  };
  const all = await ws.list("/", { recursive: true });
  return all.filter((e) => {
    if (e.trashed || e.missing || e.remote || e.path === TRASH || e.path.startsWith(TRASH + "/")) return false;
    if (e.kind !== where.kind) return false;
    const ident = identOf(e);
    return (ident !== undefined && known.has(ident)) || byName(e);
  });
}

/** The one of `copies` edited last: an entry's time is the later of its `updated` and the host's `editedAt` (a
 * notebook's save stamps its own record, not its entry); a folder's, the latest of what is in it. */
export async function lastEdited(ws: Workspace, copies: Entry[], editedAt?: (e: Entry) => Promise<number>): Promise<Entry | undefined> {
  const one = async (e: Entry) => Math.max(e.updated ?? 0, editedAt ? await editedAt(e).catch(() => 0) : 0);
  let best: Entry | undefined, at = -Infinity;
  for (const e of copies) {
    let t = await one(e);
    if (e.kind === "folder") for (const x of await ws.list(e.path, { recursive: true }).catch(() => [] as Entry[])) t = Math.max(t, await one(x));
    if (t > at) [best, at] = [e, t];
  }
  return best;
}

/** Asks "You already have a copy of <title>.": "open" (Open my copy), "new" (New copy), or null (Escape, or the dialog
 * closed any other way: nothing happens). */
export function askCopy(title: string): Promise<"open" | "new" | null> {
  const dlg = document.createElement("dialog");
  dlg.className = "sb-examples-mine";
  dlg.setAttribute("aria-label", "Your copy of this example");
  const p = document.createElement("p");
  p.textContent = `You already have a copy of ${title}.`;
  const form = document.createElement("form");
  form.method = "dialog";
  const open = Object.assign(document.createElement("button"), { value: "open", textContent: "Open my copy", autofocus: true });
  const fresh = Object.assign(document.createElement("button"), { value: "new", textContent: "New copy" });
  form.append(open, " ", fresh);
  dlg.append(p, form);
  dlg.style.cssText = "border: 1px solid #8884; border-radius: 10px; padding: 1rem 1.2rem; color: inherit; background: Canvas;";
  document.body.append(dlg);
  return new Promise((done) => {
    dlg.addEventListener("close", () => {
      const v = dlg.returnValue;
      dlg.remove();
      done(v === "open" || v === "new" ? v : null);
    });
    dlg.returnValue = "";
    dlg.showModal();
    open.focus();
  });
}

/** Before making a copy of example `id`: the copy to open instead (the person chose Open my copy), "new" (no copy
 * here, or New copy), or null (Escape: do nothing). */
export async function mineFirst(ws: Workspace | null | undefined, id: string, title: string, where: Where, editedAt?: (e: Entry) => Promise<number>): Promise<Entry | "new" | null> {
  if (!ws) return "new";
  const copies = await findCopies(ws, id, title, where).catch(() => [] as Entry[]);
  if (!copies.length) return "new";
  const choice = await askCopy(title);
  if (choice !== "open") return choice;
  return (await lastEdited(ws, copies, editedAt)) ?? "new";
}
