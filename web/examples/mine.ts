// An example opened again: the person's copy of it found first, and the question asked (open the copy already there,
// or make a new one), so picking an example twice doesn't leave "<title> (2)", "(3)", ... behind without asking.
// Both ways of opening one use it: the gallery's "Open a copy" (panel.ts), which makes a folder under /Examples, and
// the page's own list (index.html's File > Examples… where the site has no gallery), which makes a notebook at the top.
//
// A copy is recognized by:
//   - its identity, recorded here when the copy is made (noteCopy), and found again through the workspace's index of
//     identities (entriesByIdent): an entry keeps its identity through a rename or a move, so a renamed or moved copy
//     still counts.  Kept in this browser's localStorage, as an example id -> identities map;
//   - else, for a copy made before (or in another browser), its name: "<title>" or "<title> (N)" (plus the
//     extension) among the entries directly in the folder copies are made in.
// Never the whole tree: at most PER_EXAMPLE identities looked up, and one folder listed (not recursively).
//
// A copy counts only if what it opens is here: the list's notebook itself, or the gallery folder's main file (its
// path in the copy, as the example names it). One in Trash, one whose contents are on another device or missing,
// and a folder without that main file are never offered, and never stop a new copy from being made.
import type { Entry, Workspace } from "../workspace/api";
import { TRASH, join, nameOf, parentOf, safeName, splitExt, within } from "../workspace/paths";

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
/** Here, usable: not in Trash, its contents on this device. */
const here = (e: Entry | undefined): e is Entry => !!e && !e.trashed && !e.missing && !e.remote && !within(e.path, TRASH);

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

/** Where copies of an example are made, and how each is named: the gallery's, a folder "/Examples/<title>" whose
 * `main` (the example's main file, relative to it) is what it opens; the list's, a notebook "/<title>.ipynb" (each name
 * as the copy path makes it: safeName). */
export type Where = { folder: string; kind: "folder" | "notebook"; ext: string; max: number; main?: string };
export const gallery = (main: string): Where => ({ folder: "/Examples", kind: "folder", ext: "", max: 120, main });
export const LIST: Where = { folder: "/", kind: "notebook", ext: ".ipynb", max: 200 };

/** A copy found, and the document it opens. */
export type Copy = { copy: Entry; open: Entry };

/** The person's usable copies of example `id` (title `title`) on this device, by identity or by name. */
export async function findCopies(ws: Workspace, id: string, title: string, where: Where): Promise<Copy[]> {
  const base = safeName(title, where.max);
  const byName = (e: Entry) => {
    const [b, ext] = where.ext ? splitExt(nameOf(e.path)) : [nameOf(e.path), ""];
    return ext === where.ext && (b === base || (b.startsWith(base + " (") && /^ \(\d+\)$/.test(b.slice(base.length))));
  };
  const known = await ws.entriesByIdent(read()[id] ?? []);
  const named = (await ws.list(where.folder).catch(() => [] as Entry[])).filter(byName);
  const seen = new Set<string>(), out: Copy[] = [];
  for (const e of [...known, ...named]) {
    if (e.kind !== where.kind || !here(e) || seen.has(e.path)) continue;
    seen.add(e.path);
    const open = where.kind === "folder" ? await ws.stat(join(e.path, where.main ?? "")).catch(() => undefined) : e;
    if (here(open) && open.kind !== "folder") out.push({ copy: e, open });
  }
  return out;
}

/** The one of `copies` edited last: the later of its document's `updated` and the host's `editedAt` (a notebook's
 * save stamps its own record, not its entry). */
export async function lastEdited(copies: Copy[], editedAt?: (e: Entry) => Promise<number>): Promise<Copy | undefined> {
  let best: Copy | undefined, at = -Infinity;
  for (const c of copies) {
    const t = Math.max(c.open.updated ?? 0, editedAt ? await editedAt(c.open).catch(() => 0) : 0);
    if (t > at) [best, at] = [c, t];
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

/** Before making a copy of example `id`: the document to open instead (the person chose Open my copy: the copy edited
 * last), "new" (no usable copy here, or New copy), or null (Escape: do nothing). */
export async function mineFirst(ws: Workspace | null | undefined, id: string, title: string, where: Where, editedAt?: (e: Entry) => Promise<number>): Promise<Entry | "new" | null> {
  if (!ws) return "new";
  const copies = await findCopies(ws, id, title, where).catch(() => [] as Copy[]);
  if (!copies.length) return "new";
  const choice = await askCopy(title);
  if (choice !== "open") return choice;
  return (await lastEdited(copies, editedAt))?.open ?? "new";
}
