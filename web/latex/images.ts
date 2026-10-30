// The LaTeX editor's images (plan sbspace r5 §3): \includegraphics{name} resolved inside the opened file's folder,
// read by identity, bounded, checked by their bytes, and shown only as <img> from a blob: URL. The page decides with
// these pure functions; tests/test-latex-units.mjs checks them.
import { normPath, parentOf, join, within, PathError } from "../workspace/paths";

export const IMAGE_EXTS = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"];
export const IMAGE_BOUNDS = { perDocument: 64, perImage: 8 * 2 ** 20, total: 64 * 2 ** 20, megapixels: 40 };

/** The bytes actually read (len), against the size the file was admitted with (its stat) and the bytes already kept:
 * null if they may be kept, else why not. Checked after the read, before any blob is made. */
export function admitImageBytes(len: number, statSize: number | undefined, kept: number, b = IMAGE_BOUNDS): string | null {
  if (len !== (statSize ?? -1)) return "changed while it was read";
  if (len > b.perImage || kept + len > b.total) return "too large";
  return null;
}

/** The workspace paths an \includegraphics argument may name, in the order LaTeX tries them (as written, then with
 * each allowed extension), or why it names none: never outside the opened file's folder. */
export function imageCandidates(arg: string, docPath: string): { ok: true; paths: string[] } | { ok: false; why: string } {
  const s = String(arg).trim();
  if (s === "" || s.length > 512) return { ok: false, why: "not a file name" };
  if (/[\u0000-\u001f\u007f]/.test(s)) return { ok: false, why: "not a file name" };
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(s)) return { ok: false, why: "a URL, not a file in this folder" };
  if (s.startsWith("/") || s.includes("\\")) return { ok: false, why: "outside this folder" };
  if (/%(2f|2e|5c)/i.test(s)) return { ok: false, why: "outside this folder" };
  const segs = s.split("/");
  if (segs.some((x) => x === "" || x === "." || x === "..")) return { ok: false, why: "outside this folder" };
  const folder = parentOf(docPath);
  let base: string;
  try { base = normPath(join(folder, s)); } catch (e) { return { ok: false, why: e instanceof PathError ? "not a file name" : "not a file name" }; }
  // (inside the folder at a path-component boundary: /a/b holds /a/b/c.png, never /a/bc/x.png)
  if (base === folder || !within(base, folder)) return { ok: false, why: "outside this folder" };
  const lower = base.toLowerCase();
  if (IMAGE_EXTS.some((x) => lower.endsWith(x))) return { ok: true, paths: [base] };
  return { ok: true, paths: [base, ...IMAGE_EXTS.map((x) => base + x)] };
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
