// ci: web-runner order=491 runner=bun
// A file's picture preview (web/workspace/preview.ts), in Bun with a small DOM stand-in: a picture is admitted by its
// header's size (web/image-size.ts: MAX_SIDE a side, MAX_PIXELS in all) before any URL is made for it, an SVG isn't
// previewed (download it), and a size that can't be read isn't either; a preview closed while its file is read makes
// nothing after that, so no Blob URL outlives it. (The same in the page: web/workspace/test-workspace-preview.mjs.)
//   bun web/workspace/test-preview-admission.mjs
import { deflateSync } from "node:zlib";

let failures = 0;
const ok = (c, msg, detail) => { console.log((c ? "ok   " : "FAIL ") + msg + (detail !== undefined ? "  " + JSON.stringify(detail).slice(0, 300) : "")); if (!c) failures++; };

// ---- a DOM just large enough for the preview panel
class El {
  constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.isConnected = false; this.attrs = {}; this.textContent = ""; this.style = {}; this.dataset = {}; }
  append(...k) { for (const c of k) if (typeof c === "object") this.children.push(c); }
  replaceChildren(...k) { this.children = []; this.append(...k); }
  remove() { this.isConnected = false; }
  setAttribute(k, v) { this.attrs[k] = v; }
  focus() {}
  querySelector() { return null; }
  get text() { return [this.textContent, ...this.children.map((c) => c.text)].join(" "); }
  find(tag) { return this.tagName === tag ? this : this.children.map((c) => c.find(tag)).find(Boolean) ?? null; }
}
let panelRoot = null;
globalThis.document = {
  head: { append() {} },
  body: { append(el) { el.isConnected = true; panelRoot = el; } },
  createElement: (t) => new El(t),
  querySelectorAll: () => (panelRoot?.isConnected ? [panelRoot] : []),
  querySelector: () => null,
};
globalThis.addEventListener = () => {};
globalThis.removeEventListener = () => {};
// (every Blob URL made and let go of)
const urls = { made: 0, revoked: 0 };
URL.createObjectURL = () => (urls.made++, `blob:test/${urls.made}`);
URL.revokeObjectURL = () => void urls.revoked++;
const { renderPreview, openPreview } = await import("./preview.ts");

// ---- PNGs: a real 80 x 40, one whose header says 10000 x 10000, one 8193 wide, and one whose header is broken
const crc32 = (b) => { let c = ~0; for (const x of b) { c ^= x; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return ~c >>> 0; };
const chunk = (type, data) => { const t = Buffer.from(type), len = Buffer.alloc(4), crc = Buffer.alloc(4); len.writeUInt32BE(data.length); crc.writeUInt32BE(crc32(Buffer.concat([t, data]))); return Buffer.concat([len, t, data, crc]); };
const png = (w, h, real = true) => {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const rows = real ? deflateSync(Buffer.concat(Array.from({ length: h }, () => Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 3, 0x60)])))) : Buffer.alloc(64);
  return new Uint8Array(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", rows), chunk("IEND", Buffer.alloc(0))]));
};

// ---- admission, before any URL
{
  const at = urls.made;
  const small = renderPreview("pic.png", png(80, 40));
  ok(small.el.tagName === "IMG" && urls.made === at + 1, "a picture within the limits is previewed, from one Blob URL");
  small.dispose();
  ok(urls.revoked === 1, "…let go of when it is disposed");
  for (const [name, bytes, re, why] of [
    ["huge.png", png(10000, 10000, false), /can't be previewed here \(it is 10000 × 10000 pixels\)/, "a 10000 x 10000 picture (a small file)"],
    ["wide.png", png(8193, 1, false), /it is 8193 × 1 pixels/, "a picture one pixel wider than a side may be (8193)"],
    ["broken.png", new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]), /its size can't be read/, "a picture whose size can't be read"],
    ["pic.svg", new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="80" height="40"/>'), /An SVG picture isn't previewed here: download it/, "an SVG"],
  ]) {
    const before = urls.made, r = renderPreview(name, bytes);
    ok(r.el.tagName === "P" && re.test(r.el.text) && urls.made === before, `${why}: not previewed, no URL made`, r.el.text);
  }
}
// ---- closed while its file is read: nothing made after, no URL left behind
{
  const before = { ...urls };
  let release;
  const entry = { path: "/pic.png", kind: "file", fid: "f1", size: 400, updated: 0 };
  const ws = {
    stat: async () => entry,
    readUpTo: () => new Promise((res) => { release = () => res({ entry, content: png(80, 40) }); }),
    history: async () => [],
  };
  const done = openPreview(ws, entry, { say() {}, fail() {} });
  for (let i = 0; i < 20 && !release; i++) await new Promise((r) => setTimeout(r, 5));
  ok(typeof release === "function" && panelRoot?.isConnected, "the preview is open, its file being read");
  panelRoot.sbClose();
  ok(!panelRoot.isConnected, "…closed before the read ends");
  release();
  await done;
  ok(urls.made === before.made && urls.revoked === before.revoked, "after the read ends, no picture is made for the closed preview: no Blob URL left", { made: urls.made - before.made, revoked: urls.revoked - before.revoked });
}
// ---- and a preview left open shows its picture, let go of when closed
{
  const before = { ...urls };
  const entry = { path: "/pic.png", kind: "file", fid: "f1", size: 400, updated: 0 };
  const ws = { stat: async () => entry, readUpTo: async () => ({ entry, content: png(80, 40) }), history: async () => [] };
  await openPreview(ws, entry, { say() {}, fail() {} });
  ok(urls.made === before.made + 1 && !!panelRoot.find("IMG"), "a preview left open shows its picture");
  panelRoot.sbClose();
  ok(urls.revoked === before.revoked + 1, "…and closing it lets go of its URL");
}
console.log(failures ? `${failures} FAILED` : "all passed");
process.exit(failures ? 1 : 0);
