// Previews of slow code items' outputs, kept in the board's file
// (design/outputs.md, section 1).  An item whose time from root (its own run
// time and its ancestors') is over PREVIEW_MS keeps a small copy of its
// output in its node, so a reader opening the board sees it at once, marked
// as a preview, without waiting for it to run.  Bounded: text cut to its
// head and tail, at most one picture (re-encoded, at most IMAGE_W wide), no
// 3D scenes or widgets; at most CELL_MAX a node, DOC_MAX a board (bytes of
// JSON as UTF-8).  A file's previews are held to the same, when it is read
// (cleanPreview, and cleanDoc's capPreviews).
//
// Outputs are Jupyter's (stream, display_data), as the notebook saves them.

export interface PreviewStream { output_type: "stream"; name: "stdout" | "stderr"; text: string }
export interface PreviewDisplay { output_type: "display_data"; data: Record<string, string>; metadata: Record<string, never> }
export type PreviewOutput = PreviewStream | PreviewDisplay;
export interface Preview {
  /** when it was computed (ISO 8601) */
  at: string;
  /** its own run time, ms */
  ms: number;
  /** its time from root, ms */
  total: number;
  outputs: PreviewOutput[];
}

/** an item whose time from root is over this keeps a preview */
export const PREVIEW_MS = 10_000;
export const CELL_MAX = 32 * 1024, DOC_MAX = 512 * 1024;
const HEAD = 4096, TAIL = 1024;
/** a preview's picture: at most this wide and this tall (pixels) */
export const IMAGE_W = 640, IMAGE_H = 1280;
const TEXTS = ["text/plain", "text/latex", "text/markdown"];
const IMAGES = ["image/png", "image/jpeg", "image/webp"];
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/;
const utf8 = new TextEncoder();
/** The size that counts: its JSON's bytes, as UTF-8. */
export const bytes = (v: unknown) => utf8.encode(JSON.stringify(v)).length;

/** A text cut to its first HEAD and last TAIL characters, saying what was left out. */
export function cut(t: string): string {
  if (t.length <= HEAD + TAIL + 64) return t;
  const gone = t.slice(HEAD, t.length - TAIL), lines = gone.split("\n").length - 1;
  return t.slice(0, HEAD) + `\n… ${lines ? `${lines} lines` : `${gone.length} characters`} …\n` + t.slice(t.length - TAIL);
}

/** A picture as a smaller one: (a data: URL, the width at most) -> [type, base64], or null. */
export type Raster = (src: string, maxWidth: number) => Promise<[string, string] | null>;

/** In a page: drawn on a canvas, as WebP (or PNG where WebP can't be written).
 * An SVG drawn as an image runs no scripts. */
export const pageRaster: Raster = async (src, maxWidth) => {
  if (typeof document === "undefined") return null;
  try {
    const img = new Image();
    img.src = src;
    await img.decode();
    const w0 = img.naturalWidth || 640, h0 = img.naturalHeight || 480, s = Math.min(1, maxWidth / w0, IMAGE_H / h0);
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(w0 * s));
    c.height = Math.max(1, Math.round(h0 * s));
    const g = c.getContext("2d")!;
    g.fillStyle = "#fff";
    g.fillRect(0, 0, c.width, c.height);
    g.drawImage(img, 0, 0, c.width, c.height);
    const url = c.toDataURL("image/webp", 0.8);
    const m = /^data:(image\/(?:webp|png));base64,(.*)$/.exec(url);
    return m ? [m[1], m[2]] : null;
  } catch {
    return null;
  }
};

const textOf = (v: unknown) => (Array.isArray(v) ? v.join("") : typeof v === "string" ? v : "");

/**
 * A preview of `outputs` (as the notebook saves them), or null if they show
 * nothing.  `raster` re-encodes pictures (pageRaster in a page).
 */
export async function makePreview(outputs: any[], o: { at: string; ms: number; total: number }, raster: Raster = pageRaster): Promise<Preview | null> {
  const out: PreviewOutput[] = [];
  let picture = false;
  for (const x of outputs ?? []) {
    if (x?.output_type === "stream") {
      const text = cut(textOf(x.text));
      if (text) out.push({ output_type: "stream", name: x.name === "stderr" ? "stderr" : "stdout", text });
    } else if (x?.output_type === "display_data" || x?.output_type === "execute_result") {
      const d = x.data ?? {}, data: Record<string, string> = {};
      for (const t of TEXTS) if (typeof d[t] === "string" || Array.isArray(d[t])) data[t] = cut(textOf(d[t]));
      if (!picture) {
        const img = IMAGES.find((t) => typeof d[t] === "string");
        const svg = textOf(d["image/svg+xml"]);
        const src = img ? `data:${img};base64,${d[img].replace(/\s/g, "")}` : svg ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}` : null;
        if (src) {
          // (drawn again, at most IMAGE_W wide, whatever it was)
          const small = await raster(src, IMAGE_W);
          if (small && fits(small[0], small[1])) {
            data[small[0]] = small[1];
            picture = true;
          }
        }
      }
      if (Object.keys(data).length) out.push({ output_type: "display_data", data, metadata: {} });
    }
  }
  // (at most CELL_MAX: the last outputs go first)
  while (out.length && bytes(out) > CELL_MAX) out.pop();
  if (!out.length) return null;
  return { at: o.at, ms: Math.round(o.ms), total: Math.round(o.total), outputs: out };
}

/**
 * A picture's size in pixels, from its header (PNG, JPEG, WebP), or null if
 * it can't be read.  (A small file can say it is huge, and decoding it would
 * take that much memory: SEC-B00-1.)
 */
export function imageSize(type: string, base64: string): { w: number; h: number } | null {
  let b: Uint8Array;
  try {
    const s = atob(base64);
    b = Uint8Array.from(s, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
  const u16 = (i: number) => (b[i] << 8) | b[i + 1], le16 = (i: number) => b[i] | (b[i + 1] << 8), le24 = (i: number) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16);
  const u32 = (i: number) => ((b[i] << 24) >>> 0) + ((b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]);
  const ascii = (i: number, n: number) => String.fromCharCode(...b.subarray(i, i + n));
  if (type === "image/png") {
    if (b.length < 24 || b[0] !== 0x89 || ascii(1, 3) !== "PNG" || ascii(12, 4) !== "IHDR") return null;
    return { w: u32(16), h: u32(20) };
  }
  if (type === "image/jpeg") {
    if (b[0] !== 0xff || b[1] !== 0xd8) return null;
    for (let i = 2; i + 9 < b.length; ) {
      if (b[i] !== 0xff) return null;
      const m = b[i + 1];
      if (m === 0xff) { i++; continue; }
      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
      // (a start of frame: its height and width)
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { w: u16(i + 7), h: u16(i + 5) };
      i += 2 + u16(i + 2);
    }
    return null;
  }
  if (type === "image/webp") {
    if (b.length < 30 || ascii(0, 4) !== "RIFF" || ascii(8, 4) !== "WEBP") return null;
    const kind = ascii(12, 4);
    if (kind === "VP8 " && b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a) return { w: le16(26) & 0x3fff, h: le16(28) & 0x3fff };
    if (kind === "VP8L" && b[20] === 0x2f) return { w: 1 + (b[21] | ((b[22] & 0x3f) << 8)), h: 1 + ((b[22] >> 6) | (b[23] << 2) | ((b[24] & 0x0f) << 10)) };
    if (kind === "VP8X") return { w: 1 + le24(24), h: 1 + le24(27) };
    return null;
  }
  return null;
}
const fits = (type: string, base64: string) => {
  const s = imageSize(type, base64);
  return !!s && s.w > 0 && s.h > 0 && s.w <= IMAGE_W && s.h <= IMAGE_H;
};

/** A preview as a file may hold it: well formed, and held to what a preview
 * written here is (texts cut, one picture, its header saying at most
 * IMAGE_W by IMAGE_H, CELL_MAX), else undefined. */
export function cleanPreview(p: any): Preview | undefined {
  if (!p || typeof p !== "object" || typeof p.at !== "string" || !ISO.test(p.at)) return undefined;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v) : null);
  const ms = n(p.ms), total = n(p.total);
  if (ms === null || total === null || !Array.isArray(p.outputs)) return undefined;
  const outputs: PreviewOutput[] = [];
  let picture = false;
  for (const x of p.outputs) {
    if (x?.output_type === "stream" && typeof x.text === "string") outputs.push({ output_type: "stream", name: x.name === "stderr" ? "stderr" : "stdout", text: cut(x.text) });
    else if (x?.output_type === "display_data" && x.data && typeof x.data === "object") {
      const data: Record<string, string> = {};
      for (const t of TEXTS) if (typeof x.data[t] === "string") data[t] = cut(x.data[t]);
      const img = picture ? undefined : IMAGES.find((t) => typeof x.data[t] === "string" && BASE64.test(x.data[t]) && fits(t, x.data[t]));
      if (img) {
        data[img] = x.data[img];
        picture = true;
      }
      if (Object.keys(data).length) outputs.push({ output_type: "display_data", data, metadata: {} });
    } else return undefined;
  }
  const out = { at: p.at, ms, total, outputs };
  return outputs.length && bytes(outputs) <= CELL_MAX ? out : undefined;
}

/** Whether two previews show the same outputs (when and how long aside). */
export const sameOutputs = (a: Preview | undefined, b: Preview | undefined) => !!a && !!b && JSON.stringify(a.outputs) === JSON.stringify(b.outputs);

/** The previews to drop so a board's fit DOC_MAX: those closest to PREVIEW_MS first. */
export function overCap(previews: Map<string, Preview>): string[] {
  const size = new Map([...previews].map(([id, p]) => [id, bytes(p)]));
  let total = [...size.values()].reduce((a, b) => a + b, 0);
  const drop: string[] = [];
  for (const [id, p] of [...previews].sort(([, a], [, b]) => a.total - b.total)) {
    if (total <= DOC_MAX) break;
    total -= size.get(id)!;
    drop.push(id);
  }
  return drop;
}

/** A document's code notes (every page, in groups too) held to DOC_MAX: those
 * closest to PREVIEW_MS lose their previews first.  (Notes are changed in place.) */
export function capPreviews(notes: { preview?: Preview }[]): void {
  const with_ = notes.filter((n) => n.preview);
  const drop = new Set(overCap(new Map(with_.map((n, i) => [String(i), n.preview!]))));
  with_.forEach((n, i) => { if (drop.has(String(i))) delete n.preview; });
}

/** "computed October 13, 42 s. Run to update" */
export function previewLabel(p: Preview): string {
  const d = new Date(p.at), s = p.total / 1000;
  const when = isNaN(+d) ? "" : ` ${d.toLocaleDateString(undefined, { month: "long", day: "numeric" })}`;
  return `Preview, computed${when} (${s < 60 ? `${s.toFixed(s < 10 ? 1 : 0)} s` : `${Math.round(s / 60)} min`}). Run to update.`;
}
