// The LaTeX editor's images (plan sbspace r5 §3): \includegraphics{name} resolved as TeX does (the opened file's folder,
// then \graphicspath's; up with ../, never above the workspace's top folder: William, Nov 2, L2),
// read by identity, bounded, checked by their bytes, and shown only as <img> from a blob: URL. The page decides with
// these pure functions; tests/test-latex-units.mjs checks them.
import { normPath, parentOf } from "../workspace/paths";

export const IMAGE_EXTS = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"];
export const IMAGE_BOUNDS = { perDocument: 64, perImage: 8 * 2 ** 20, total: 64 * 2 ** 20, megapixels: 40 };

/** The bytes actually read (len), against the size the file was admitted with (its stat) and the bytes already kept:
 * null if they may be kept, else why not. Checked after the read, before any blob is made. */
export function admitImageBytes(len: number, statSize: number | undefined, kept: number, b = IMAGE_BOUNDS): string | null {
  if (len !== (statSize ?? -1)) return "changed while it was read";
  if (len > b.perImage || kept + len > b.total) return "too large";
  return null;
}

/** `rel` ("a/b", "../x", "./y") from the folder `from`, as a workspace path, or null if it isn't a relative path of
 * names or goes above the workspace's top folder. */
function resolveRel(from: string, rel: string): string | null {
  const out = from === "/" ? [] : from.slice(1).split("/");
  for (const x of rel.split("/")) {
    if (x === "" || x === ".") continue;
    if (x === "..") { if (!out.length) return null; out.pop(); } else out.push(x);
  }
  try { return normPath("/" + out.join("/")); } catch { return null; }
}

/** The folders of a \graphicspath{{dir/}{../figs/}} in the preamble (the last one, as LaTeX keeps the last), in order;
 * comments are skipped. */
export function graphicsPathOf(text: string): string[] {
  const pre = String(text).slice(0, 2 ** 20).split(/\\begin\s*\{document\}/)[0].replace(/(^|[^\\])%.*$/gm, "$1");
  let last: string[] = [];
  for (const m of pre.matchAll(/\\graphicspath\s*\{((?:\s*\{[^{}]*\})*)\s*\}/g)) last = [...m[1].matchAll(/\{([^{}]*)\}/g)].map((d) => d[1].trim()).filter(Boolean).slice(0, 16);
  return last;
}

/** The workspace paths an \includegraphics argument may name, in the order LaTeX tries them: relative to the opened
 * file's folder, then to each \graphicspath folder (`dirs`, themselves relative to the file's folder), each as written
 * and then with each allowed extension; and the folders searched. Or why it names none. A name may go up ("../x.png")
 * as TeX's may, but never above the workspace's top folder; a leading "/" is that top folder (`root`; William, Nov 2:
 * never the real filesystem's), searched alone, as TeX searches an absolute name; never a URL or a backslash. */
export function imageCandidates(arg: string, docPath: string, dirs: string[] = [], root = "/"): { ok: true; paths: string[]; searched: string[] } | { ok: false; why: string } {
  return candidates(arg, docPath, dirs, root, (base) => (IMAGE_EXTS.some((x) => base.toLowerCase().endsWith(x)) ? [base] : [base, ...IMAGE_EXTS.map((x) => base + x)]));
}

/** The workspace paths an \input or \include argument may name, as TeX tries them (with .tex added first, then as
 * written; \include{x} reads x.tex), found as images are (imageCandidates: the file's folder, ../, a leading "/";
 * TeX's \input doesn't search \graphicspath), and the folders searched; or why it names none. */
export function texCandidates(arg: string, docPath: string, root = "/"): { ok: true; paths: string[]; searched: string[] } | { ok: false; why: string } {
  return candidates(arg, docPath, [], root, (base) => (base.toLowerCase().endsWith(".tex") ? [base] : [base + ".tex", base]));
}

function candidates(arg: string, docPath: string, dirs: string[], root: string, names: (base: string) => string[]): { ok: true; paths: string[]; searched: string[] } | { ok: false; why: string } {
  const s = String(arg).trim();
  if (s === "" || s.length > 512) return { ok: false, why: "not a file name" };
  if (/[\u0000-\u001f\u007f]/.test(s)) return { ok: false, why: "not a file name" };
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(s)) return { ok: false, why: "a URL: only files in this workspace are shown" };
  if (s.includes("\\")) return { ok: false, why: "a backslash: write the path with / (e.g. figs/" + s.replace(/^.*[\\/]/, "") + ")" };
  if (/%(2f|2e|5c)/i.test(s)) return { ok: false, why: "not a file name" };
  const folder = parentOf(docPath);
  const searched: string[] = [], paths: string[] = [];
  // (a leading "/": the top folder alone; else the file's folder, then \graphicspath's, never an absolute one or a URL)
  for (const d of s.startsWith("/") ? [null] : ["", ...dirs]) {
    if (d !== null && (d.startsWith("/") || d.includes("\\") || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(d))) continue;
    const dir = d === null ? root : d === "" ? folder : resolveRel(folder, d);
    if (dir === null) continue;
    const base = resolveRel(dir, s);
    if (base === null || base === "/" || paths.includes(base) || (s.startsWith("/") && base !== root && !base.startsWith(root === "/" ? "/" : root + "/"))) continue;
    // (the folder the file would be in: "../x.png" is looked for in the parent)
    if (!searched.includes(parentOf(base))) searched.push(parentOf(base));
    paths.push(...names(base));
  }
  if (!paths.length) return { ok: false, why: "above the workspace's top folder" };
  return { ok: true, paths, searched };
}

/** `to` (a workspace path) relative to the folder `from`, as \includegraphics would name it. */
export function relativePath(from: string, to: string): string {
  const a = from === "/" ? [] : from.slice(1).split("/"), b = to.slice(1).split("/");
  let i = 0;
  while (i < a.length && i < b.length - 1 && a[i] === b[i]) i++;
  return [...Array(a.length - i).fill(".."), ...b.slice(i)].join("/");
}

/** Why an image wasn't found: the folders searched, and, if a file of that name is elsewhere (`elsewhere`, workspace
 * paths), how to name it from the opened file's folder. */
export function notFoundWhy(docPath: string, searched: string[], elsewhere: string[] = [], relativeToFile = false, name = ""): string {
  // (the folders by their workspace paths; or, for the command line, from the file's folder)
  const shown = (f: string) => relativeToFile ? (f === parentOf(docPath) ? "this file's folder" : "\"" + relativePath(parentOf(docPath), (f === "/" ? "" : f) + "/x").slice(0, -1) + "\"")
    : f === "/" ? "the top folder" : "\"" + f.slice(1) + "/\"";
  let why = "not found in " + searched.slice(0, 4).map(shown).join(", ");
  if (name.startsWith("/")) why += relativeToFile ? " (a leading / is the folder the command runs in, not the computer's top folder)" : " (a leading / is the workspace's top folder)";
  if (elsewhere.length) why += "; it is in " + shown(parentOf(elsewhere[0])) + ": write {" + relativePath(parentOf(docPath), elsewhere[0]) + "}, or move the file into " + shown(parentOf(docPath));
  return why;
}

/** An image's type and decoded size from its first bytes, or why it isn't one we show. SVG has no pixel size: it is
 * drawn as an <img> at the size the page gives it. */
export function sniffImage(b: Uint8Array): { ok: true; mime: string; pixels: number | null } | { ok: false; why: string } {
  const u32 = (o: number) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
  const u16le = (o: number) => b[o] | (b[o + 1] << 8);
  const u24le = (o: number) => b[o] | (b[o + 1] << 8) | (b[o + 2] << 16);
  if (b.length >= 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && String.fromCharCode(...b.subarray(12, 16)) === "IHDR")
    return { ok: true, mime: "image/png", pixels: u32(16) * u32(20) };
  if (b.length >= 10 && String.fromCharCode(...b.subarray(0, 4)) === "GIF8") return { ok: true, mime: "image/gif", pixels: u16le(6) * u16le(8) };
  if (b.length >= 30 && String.fromCharCode(...b.subarray(0, 4)) === "RIFF" && String.fromCharCode(...b.subarray(8, 12)) === "WEBP") {
    const kind = String.fromCharCode(...b.subarray(12, 16));
    if (kind === "VP8X") return { ok: true, mime: "image/webp", pixels: (u24le(24) + 1) * (u24le(27) + 1) };
    if (kind === "VP8L") { const v = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24); return { ok: true, mime: "image/webp", pixels: ((v & 0x3fff) + 1) * (((v >>> 14) & 0x3fff) + 1) }; }
    if (kind === "VP8 ") return { ok: true, mime: "image/webp", pixels: (u16le(26) & 0x3fff) * (u16le(28) & 0x3fff) };
    return { ok: false, why: "not an image" };
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    // (the first start-of-frame marker's height and width)
    for (let i = 2; i + 9 < b.length;) {
      if (b[i] !== 0xff) return { ok: false, why: "not an image" };
      const m = b[i + 1], len = (b[i + 2] << 8) | b[i + 3];
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { ok: true, mime: "image/jpeg", pixels: ((b[i + 5] << 8) | b[i + 6]) * ((b[i + 7] << 8) | b[i + 8]) };
      if (len < 2) return { ok: false, why: "not an image" };
      i += 2 + len;
    }
    return { ok: false, why: "not an image" };
  }
  const head = new TextDecoder("utf-8", { fatal: false }).decode(b.subarray(0, 4096)).replace(/^﻿/, "").trimStart();
  if (/^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE svg[^>]*>\s*)?<svg[\s>]/i.test(head)) return { ok: true, mime: "image/svg+xml", pixels: null };
  return { ok: false, why: "not an image" };
}
