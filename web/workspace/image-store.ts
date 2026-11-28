// Images kept as workspace files, shared by every place a person pastes or drops one: the agents page's composer
// (web/agents/attach.ts), notebook Markdown cells (#1872) and whiteboards. One set of rules for all of them:
//   - only PNG, JPEG, GIF and WebP, judged by their bytes (never their name), at most IMAGE_BYTES_MAX;
//   - saved under /Attachments/<folder>/ with a random name and the real type's extension, by an exclusive create (a
//     taken path is refused, never written over), counted in the workspace's own limits like any file;
//   - a refusal said by a fixed code, never an error's own text.
// And, for documents that carry images (a notebook's Markdown cell attachments):
//   - an attachment that refers to such a file is exactly {"sagebrush/file": "<path>"}; anything else of that key
//     fails closed (filePathOf), and a path outside /Attachments is never followed;
//   - export embeds those files back as Jupyter's {mime: base64} (embedAttachments), so other clients show them;
//   - import extracts Jupyter's inline images to files (extractAttachments), so cells stay light.
// No DOM here: the page that shows images uses ImageUrls (image-urls.ts), kept apart so an export needs nothing of it.

export const ATTACH_ROOT = "/Attachments";
/** The most an image may be, in bytes: what an agent may see (its base64 at most 5,000,000 characters). */
export const IMAGE_BYTES_MAX = 3_750_000;
/** The key of a Markdown cell attachment that refers to a workspace file instead of holding base64. */
export const FILE_KEY = "sagebrush/file";

const TYPES = [
  { ext: "png", mime: "image/png" },
  { ext: "jpg", mime: "image/jpeg" },
  { ext: "gif", mime: "image/gif" },
  { ext: "webp", mime: "image/webp" },
] as const;
export type ImageType = (typeof TYPES)[number];

/** The raster type `u` starts as, by its bytes alone; null for anything else. */
export function imageType(u: Uint8Array): ImageType | null {
  const at = (i: number, s: number[]) => s.every((b, j) => u[i + j] === b);
  if (at(0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return TYPES[0];
  if (at(0, [0xff, 0xd8, 0xff])) return TYPES[1];
  if (at(0, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) || at(0, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61])) return TYPES[2];
  if (at(0, [0x52, 0x49, 0x46, 0x46]) && at(8, [0x57, 0x45, 0x42, 0x50])) return TYPES[3];
  return null;
}
/** Whether `u` starts as a PNG, JPEG, GIF or WebP file does: by its bytes alone, never its name. */
export const isRaster = (u: Uint8Array): boolean => imageType(u) !== null;

const PLAIN = /^[A-Za-z0-9_-]{1,64}$/;
// (a content-addressed file name: the board's "i" + 64 hex fits)
const NAME = /^[A-Za-z0-9_-]{1,80}$/;
/** The folder for one place's images, if its id can be a folder name as it is (else null: nothing is saved): a chat's
 * `/Attachments/<id>` (as the agents page has always used), a notebook's `/Attachments/nb-<ref>`, a board's
 * `/Attachments/board-<id>`. */
export function imageFolder(kind: "chat" | "nb" | "board", id: string): string | null {
  if (!PLAIN.test(id)) return null;
  return kind === "chat" ? `${ATTACH_ROOT}/${id}` : `${ATTACH_ROOT}/${kind}-${id}`;
}

export type Refusal = "notImage" | "tooBig" | "exists" | "limit" | "storage" | "other";
/** At most this many images from one paste or drop. */
export const IMAGES_AT_ONCE = 8;
/** What a page says when an image isn't added (COPY's; never an error's own text). */
export const IMAGE_COPY = {
  tooMany: `At most ${IMAGES_AT_ONCE} images at once.`,
  noPlace: "This notebook isn't in this browser's workspace, so images can't be added to it.",
  refused: (r: Refusal | "read", size?: number): string =>
    r === "notImage" ? "Only PNG, JPEG, GIF and WebP images can be added."
    : r === "tooBig" ? `That image is ${((size ?? 0) / 1e6).toFixed(1)} MB: images can be at most ${IMAGE_BYTES_MAX / 1e6} MB.`
    : `The image wasn't saved: ${r === "exists" ? "a file with its name is already there." : r === "limit" ? "the workspace is at one of its limits." : r === "storage" ? "this browser's storage refused it." : r === "read" ? "it couldn't be read." : "something went wrong."}`,
} as const;
/** A refused create's reason, by the workspace's own error code only (an error's text could carry anything). */
export function refusalOf(e: unknown): Refusal {
  const c = (e as { code?: unknown } | null)?.code;
  return c === "exists" || c === "limit" || c === "storage" ? c : "other";
}

const randomName = () => [...crypto.getRandomValues(new Uint8Array(12))].map((b) => b.toString(16).padStart(2, "0")).join("");

export interface SaveOptions {
  /** a cap of the caller's own, at most IMAGE_BYTES_MAX (the board keeps 2,000,000) */
  max?: number;
  /** a content-addressed name (the board's "i" + SHA-256 hex): a plain name, the extension added from the bytes. When
   * a file is already there under it with the very same bytes, that is success (the same picture saved twice is one
   * file); other bytes there stay a refusal ("exists"). Without it, a random name. */
  name?: string;
  /** reads a file's bytes: needed with `name`, to compare with what's already there */
  read?: (path: string) => Promise<Uint8Array | null>;
}

export const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

/** Save `bytes` as an image in `folder`: checked, then created exclusively (never over another file). `create` is the
 * workspace's exclusive create (Workspace.createByPerson for a person's paste). */
export async function saveImage(create: (path: string, bytes: Uint8Array) => Promise<unknown>, folder: string, bytes: Uint8Array, o: SaveOptions = {}): Promise<{ path: string; type: ImageType } | { refused: Refusal }> {
  const max = Math.min(o.max ?? IMAGE_BYTES_MAX, IMAGE_BYTES_MAX);
  if (bytes.length > max) return { refused: "tooBig" };
  const type = imageType(bytes);
  if (!type) return { refused: "notImage" };
  if (o.name !== undefined && (!NAME.test(o.name) || !o.read)) return { refused: "other" };
  const path = `${folder}/${o.name ?? randomName()}.${type.ext}`;
  try { await create(path, bytes); } catch (e) {
    const r = refusalOf(e);
    // (content-addressed: the very same bytes already there are this picture, saved before)
    if (r === "exists" && o.name !== undefined) {
      const had = await o.read!(path).catch(() => null);
      if (had && sameBytes(had, bytes)) return { path, type };
    }
    return { refused: r };
  }
  return { path, type };
}

// ---- attachments that refer to files

const SEGMENT = /^[A-Za-z0-9_.-]{1,255}$/;
/** The workspace path an attachment refers to, if it is exactly {"sagebrush/file": "<folder>/<name>.<ext>"} with a plain
 * name and a raster extension, in exactly `folder`: the folder of the document that holds it (imageFolder of its owner,
 * passed by the caller, never read from the document). Null for anything else, a reference into another notebook's or
 * chat's folder included (fail closed: such an entry is shown as a missing image and never read, embedded or sent), and
 * for every entry when there's no owner folder. */
export function filePathOf(att: unknown, folder: string | null): string | null {
  if (!att || typeof att !== "object" || Array.isArray(att)) return null;
  const keys = Object.keys(att);
  if (keys.length !== 1 || keys[0] !== FILE_KEY) return null;
  const p = (att as Record<string, unknown>)[FILE_KEY];
  if (typeof p !== "string" || p.length > 1024) return null;
  const segs = p.split("/");
  if (segs.length !== 4 || segs[0] !== "" || `/${segs[1]}` !== ATTACH_ROOT) return null;
  if (!segs.slice(2).every((s) => SEGMENT.test(s) && s !== "." && s !== ".." && !s.startsWith("."))) return null;
  if (!/\.(png|jpg|gif|webp)$/.test(segs[3])) return null;
  // (the owner's own folder only: exactly equal, so no folder (null) or any other string follows nothing)
  if (`/${segs[1]}/${segs[2]}` !== folder) return null;
  return p;
}
/** Whether an attachment entry is one of ours (its key), valid or not: such entries are never treated as Jupyter's. */
export const isFileEntry = (att: unknown): boolean => !!att && typeof att === "object" && !Array.isArray(att) && Object.hasOwn(att, FILE_KEY);

const B64 = /^[A-Za-z0-9+/]*={0,2}$/;
/** Base64 to bytes, strictly (canonical alphabet and padding, no whitespace), refusing before decoding anything that
 * would be over `max` bytes; null if it isn't. */
export function fromBase64(s: unknown, max = IMAGE_BYTES_MAX): Uint8Array | null {
  if (typeof s !== "string" || s.length % 4 !== 0 || !B64.test(s)) return null;
  const n = (s.length / 4) * 3 - (s.endsWith("==") ? 2 : s.endsWith("=") ? 1 : 0);
  if (n > max) return null;
  try {
    const bin = atob(s);
    const u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return u;
  } catch { return null; }
}
/** An image's bytes as a data: URL (the board's export form), or null if they aren't a raster image within `max`. */
export function toDataUrl(u: Uint8Array, max = IMAGE_BYTES_MAX): string | null {
  const type = u.length <= Math.min(max, IMAGE_BYTES_MAX) ? imageType(u) : null;
  return type ? `data:${type.mime};base64,${toBase64(u)}` : null;
}
/** A data: URL's image bytes: only `data:image/(png|jpeg|gif|webp);base64,` with strict base64, within `max`, whose
 * bytes are the type it says; null for anything else (an SVG stays the caller's). */
export function fromDataUrl(url: unknown, max = IMAGE_BYTES_MAX): Uint8Array | null {
  if (typeof url !== "string") return null;
  const m = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/]*={0,2})$/.exec(url);
  if (!m) return null;
  const u = fromBase64(m[2], Math.min(max, IMAGE_BYTES_MAX));
  return u && imageType(u)?.mime === m[1] ? u : null;
}
export function toBase64(u: Uint8Array): string {
  let s = "";
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s);
}

type Cell = { type?: string; cell_type?: string; attachments?: Record<string, unknown> | null; [k: string]: unknown };
const isMarkdown = (c: Cell) => (c?.type ?? c?.cell_type) === "markdown";

const needsEmbed = (doc: { cells?: Cell[] }) => Array.isArray(doc?.cells) && doc.cells.some((c) => isMarkdown(c) && !!c.attachments && Object.values(c.attachments).some(isFileEntry));
/** The workspace paths a notebook's attachments refer to: well-formed ones in its own `folder` only. */
export function referencedPaths(doc: { cells?: Cell[] }, folder: string | null): string[] {
  const out = new Set<string>();
  for (const c of Array.isArray(doc?.cells) ? doc.cells : []) {
    if (!isMarkdown(c) || !c.attachments) continue;
    for (const a of Object.values(c.attachments)) { const p = filePathOf(a, folder); if (p) out.add(p); }
  }
  return [...out];
}

/** embedAttachments with the files' bytes already at hand (`get`, synchronous): for a page that holds the bytes of the
 * images it shows (the open notebook's Download and share, whose hooks are synchronous). */
export function embedAttachmentsWith<D extends { cells?: Cell[] }>(doc: D, folder: string | null, get: (path: string) => Uint8Array | null): { doc: D; missing: string[] } {
  const missing: string[] = [];
  if (!needsEmbed(doc)) return { doc, missing };
  const cells: Cell[] = [];
  for (const c of doc.cells!) {
    if (!isMarkdown(c) || !c.attachments || !Object.values(c.attachments).some(isFileEntry)) { cells.push(c); continue; }
    // (a dictionary with no prototype: an attachment may be named "__proto__")
    const att: Record<string, unknown> = Object.create(null);
    for (const [name, a] of Object.entries(c.attachments)) {
      if (!isFileEntry(a)) { att[name] = a; continue; }
      // (only the owner's folder is ever read: a reference elsewhere is left out, as a missing one is)
      const p = filePathOf(a, folder);
      const u = p ? get(p) : null;
      const type = u && u.length <= IMAGE_BYTES_MAX ? imageType(u) : null;
      if (!u || !type) { missing.push(name); continue; }
      att[name] = { [type.mime]: toBase64(u) };
    }
    cells.push({ ...c, attachments: Object.keys(att).length ? att : null });
  }
  return { doc: { ...doc, cells }, missing };
}

/** A notebook document with every file-referring attachment embedded as Jupyter's {mime: base64}, for an export that
 * leaves this browser (Download, Export all, a share, a push): `folder` is the folder of the notebook it is (imageFolder
 * of its ref, from the caller's own record of it), and `read` gives a workspace file's bytes (or null). Only files in
 * that folder are read. An entry whose file is missing, unreadable, over the cap or not a raster image is left out, and
 * its name listed in `missing`; an ill-formed entry of our key, or one naming another folder, is left out too, and
 * never read. Nothing else changes; the document given isn't modified. */
export async function embedAttachments<D extends { cells?: Cell[] }>(doc: D, folder: string | null, read: (path: string) => Promise<Uint8Array | null>): Promise<{ doc: D; missing: string[] }> {
  if (!needsEmbed(doc)) return { doc, missing: [] };
  const got = new Map<string, Uint8Array | null>();
  for (const p of referencedPaths(doc, folder)) got.set(p, await read(p).catch(() => null));
  return embedAttachmentsWith(doc, folder, (p) => got.get(p) ?? null);
}

/** A notebook document whose Markdown cells' inline raster images (Jupyter's {mime: base64}) are saved as workspace
 * files by `save` and referred to instead, for an import into the workspace. An attachment is extracted only if it has
 * one entry, an image/png, jpeg, gif or webp mime, strict base64 within the cap, and bytes that are that raster type;
 * anything else (SVG, several mimes, over the cap, a refused save) stays inline as it was, so nothing is lost.
 * An entry of OUR key in the imported document (a reference to a workspace file) is removed and counted in `dropped`:
 * a document from outside never brings a reference, so it can't name any file here, its own new folder included. */
export async function extractAttachments<D extends { cells?: Cell[] }>(doc: D, save: (bytes: Uint8Array) => Promise<{ path: string } | { refused: Refusal }>): Promise<{ doc: D; extracted: number; dropped: number }> {
  let extracted = 0, dropped = 0;
  if (!Array.isArray(doc?.cells)) return { doc, extracted, dropped };
  const cells: Cell[] = [];
  for (const c of doc.cells) {
    if (!isMarkdown(c) || !c.attachments || typeof c.attachments !== "object") { cells.push(c); continue; }
    const att: Record<string, unknown> = Object.create(null);
    let changed = false;
    for (const [name, a] of Object.entries(c.attachments)) {
      if (isFileEntry(a)) { dropped++; changed = true; continue; }
      att[name] = a;
      if (!a || typeof a !== "object" || Array.isArray(a)) continue;
      const entries = Object.entries(a as Record<string, unknown>);
      if (entries.length !== 1) continue;
      const [mime, b64] = entries[0];
      const type = TYPES.find((t) => t.mime === mime);
      const u = type ? fromBase64(b64) : null;
      if (!type || !u || imageType(u) !== type) continue;
      const r = await save(u);
      if (!("path" in r)) continue;
      att[name] = { [FILE_KEY]: r.path };
      changed = true;
      extracted++;
    }
    cells.push(changed ? { ...c, attachments: Object.keys(att).length ? att : null } : c);
  }
  return { doc: extracted || dropped ? { ...doc, cells } : doc, extracted, dropped };
}
