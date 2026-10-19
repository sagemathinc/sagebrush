// Workspace paths (design/workspace-files.md §2.1): absolute, "/"-separated,
// each name a real one.  A path's kind comes from its name: `.ipynb` a
// notebook, `.board.json` a board, anything else a data file; folders are
// entries of their own.

export type Kind = "notebook" | "board" | "file" | "folder";

/** The bounds of a path (the review's limits): its length, its depth, a name's length. */
export const MAX_PATH = 1024, MAX_DEPTH = 32, MAX_NAME = 255;
/** The folder deleted entries go to (§2.4). */
export const TRASH = "/Trash";

export class PathError extends Error {}

// (control characters, which no name of a file can hold here)
const CONTROL = /[\u0000-\u001f\u007f]/;

/** `p` as a workspace path, or a PathError saying why it isn't one: no empty
 * names, no "." or "..", no control characters, within the bounds; a
 * trailing "/" is dropped.  "/" itself is the root. */
export function normPath(p: unknown): string {
  if (typeof p !== "string") throw new PathError("a path is a string");
  if (!p.startsWith("/")) throw new PathError(`not an absolute path: ${JSON.stringify(p.slice(0, 80))}`);
  if (p.length > MAX_PATH) throw new PathError(`a path is at most ${MAX_PATH} characters`);
  if (p === "/") return p;
  const names = (p.endsWith("/") ? p.slice(1, -1) : p.slice(1)).split("/");
  if (names.length > MAX_DEPTH) throw new PathError(`a path is at most ${MAX_DEPTH} folders deep`);
  for (const n of names) {
    if (n === "" || n === "." || n === "..") throw new PathError(`not a name in a path: ${JSON.stringify(n)}`);
    if (n.length > MAX_NAME) throw new PathError(`a name is at most ${MAX_NAME} characters`);
    if (CONTROL.test(n)) throw new PathError("a name can't hold control characters");
  }
  return "/" + names.join("/");
}

/** The folder holding `p` ("/" for one at the top). */
export const parentOf = (p: string) => p.slice(0, Math.max(1, p.lastIndexOf("/")));
/** The last name of `p`. */
export const nameOf = (p: string) => p.slice(p.lastIndexOf("/") + 1);
/** `child` in `folder`. */
export const join = (folder: string, child: string) => (folder === "/" ? "" : folder) + "/" + child;
/** Whether `p` is `folder` or inside it. */
export const within = (p: string, folder: string) => folder === "/" || p === folder || p.startsWith(folder + "/");

/** A name's base and extension, `.board.json` as one extension. */
export function splitExt(name: string): [string, string] {
  if (name.toLowerCase().endsWith(".board.json") && name.length > 11) return [name.slice(0, -11), name.slice(-11)];
  const i = name.lastIndexOf(".");
  return i > 0 ? [name.slice(0, i), name.slice(i)] : [name, ""];
}

/** The kind of a document or file by its name (a folder is said by its entry). */
export function kindOf(path: string): Exclude<Kind, "folder"> {
  const n = nameOf(path).toLowerCase();
  if (n.endsWith(".ipynb") && n.length > 6) return "notebook";
  if (n.endsWith(".board.json") && n.length > 11) return "board";
  return "file";
}

/** A title made a name: what a path can't hold ("/", control characters)
 * made "-", spaces at the ends dropped, cut to `max`; "Untitled" for nothing. */
export function safeName(title: unknown, max = 200): string {
  const s = String(title ?? "").replace(/[\/\u0000-\u001f\u007f]/g, "-").trim().slice(0, max).trim();
  return s === "" || s === "." || s === ".." ? "Untitled" : s;
}

/** The first of `base + ext`, `base (2) + ext`, … in `folder` that `taken`
 * says is free; undefined if none in `tries` (a folder that full). */
export function freePath(folder: string, base: string, ext: string, taken: (p: string) => boolean, tries = 10000): string | undefined {
  for (let i = 1; i <= tries; i++) {
    const p = join(folder, base + (i === 1 ? "" : ` (${i})`) + ext);
    if (!taken(p)) return p;
  }
  return undefined;
}
