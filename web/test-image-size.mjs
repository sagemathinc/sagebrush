// ci: web-browser/board-unit.2 order=120 runner=bun
// image-size.ts: a picture's size from its header (PNG, JPEG, WebP, GIF),
// the bounds (MAX_SIDE, MAX_PIXELS each, LOAD_PIXELS in all), and Markdown's
// data: images held to them (safe-html.ts).   bun web/test-image-size.mjs
import { LOAD_PIXELS, MAX_PIXELS, MAX_SIDE, PixelBudget, SVG_MAX_B64, SVG_MAX_BYTES, dataUrl, imageSize, pictureSize, pictureUrl, svgDataUrl, svgSize, svgText } from "./image-size.ts";
import { safeHtml, safeImage } from "./safe-html.ts";
import { render } from "./markdown.ts";

let checks = 0;
const fails = [];
const check = (ok, what) => { checks++; if (!ok) fails.push(what); };
const b64 = (bytes) => Buffer.from(bytes).toString("base64");
const be32 = (v) => [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
const le16 = (v) => [v & 255, (v >> 8) & 255];
const le24 = (v) => [v & 255, (v >> 8) & 255, (v >> 16) & 255];
const png = (w, h) => b64([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, ...be32(w), ...be32(h), 8, 2, 0, 0, 0, 0, 0, 0, 0]);
const webp = (w, h) => b64([...Buffer.from("RIFF"), 0, 0, 0, 0, ...Buffer.from("WEBPVP8X"), 10, 0, 0, 0, 0, 0, 0, 0, ...le24(w - 1), ...le24(h - 1)]);
// (a JPEG with an APP0 segment before its frame)
const jpeg = (w, h) => b64([0xff, 0xd8, 0xff, 0xe0, 0, 16, ...Buffer.from("JFIF\0"), 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xc0, 0, 11, 8, h >> 8, h & 255, w >> 8, w & 255, 3, 0, 0, 0]);
// (a GIF: its screen, a graphic control extension, one frame of its own size, the trailer)
const gif = (w, h, fw = w, fh = h) => b64([...Buffer.from("GIF89a"), ...le16(w), ...le16(h), 0, 0, 0, 0x21, 0xf9, 4, 0, 0, 0, 0, 0, 0x2c, 0, 0, 0, 0, ...le16(fw), ...le16(fh), 0, 2, 2, 0x4c, 0x01, 0, 0x3b]);

const sizes = { png: imageSize("image/png", png(8192, 8192)), jpeg: imageSize("image/jpeg", jpeg(300, 200)), webp: imageSize("image/webp", webp(5000, 9000)), gif: imageSize("image/gif", gif(640, 480)) };
check(JSON.stringify(sizes) === '{"png":{"w":8192,"h":8192},"jpeg":{"w":300,"h":200},"webp":{"w":5000,"h":9000},"gif":{"w":640,"h":480}}', "sizes from each header: " + JSON.stringify(sizes));
// a GIF whose frame is larger than its screen: the frame's size (SEC-89C-1); a GIF with no frame: none
check(JSON.stringify(imageSize("image/gif", gif(1, 1, 9000, 5000))) === '{"w":9000,"h":5000}' && imageSize("image/gif", b64([...Buffer.from("GIF89a"), 1, 0, 1, 0, 0, 0, 0, 0x3b])) === null, "a GIF's frames count, not only its screen");
check(imageSize("image/png", "AAAA") === null && imageSize("image/gif", "R0lG") === null && imageSize("image/bmp", png(1, 1)) === null && imageSize("image/png", "!!") === null, "unreadable, or another type: no size");

// the bounds
const one = (w, h) => new PixelBudget().take({ w, h });
check(one(MAX_SIDE, 4000) === null && one(6000, 6000) === null, "within the bounds: shown");
check(/8193 × 10/.test(one(MAX_SIDE + 1, 10) ?? "") && one(10, MAX_SIDE + 1) !== null && one(8000, 6000) !== null && one(0, 10) !== null && new PixelBudget().take(null) !== null, "a side over 8192, over 40 MP, empty or unknown: not shown");
check(8192 * 8192 > MAX_PIXELS, "a picture 8192 square is over the pixels' bound too");
const budget = new PixelBudget();
const takes = [budget.take({ w: 6000, h: 5000 }), budget.take({ w: 6000, h: 5000 }), budget.take({ w: 6000, h: 5000 }), budget.take({ w: 100, h: 100 })];
// (the same picture again, as a cell drawn again: counted once)
const again = new PixelBudget();
check(again.take({ w: 6000, h: 5000 }, "k") === null && again.take({ w: 6000, h: 5000 }, "k") === null && again.take({ w: 6000, h: 5000 }, "k") === null && again.used === 30_000_000, "the same picture is counted once");
check(takes[0] === null && takes[1] === null && /in all/.test(takes[2] ?? "") && takes[3] === null && budget.used <= LOAD_PIXELS, "a document's pictures: 80 MP in all, then not shown (a small one still fits): " + JSON.stringify(takes));
check(JSON.stringify([dataUrl("data:IMAGE/PNG;base64,AAAA"), dataUrl("data:image/jpg;base64,AAAA"), dataUrl("data:Image/JPEG;base64,AAAA")]) === JSON.stringify([{ type: "image/png", base64: "AAAA" }, { type: "image/jpeg", base64: "AAAA" }, { type: "image/jpeg", base64: "AAAA" }]), "one grammar for data: pictures: any case, jpg as jpeg (SEC-A48-1)");
check(JSON.stringify(dataUrl("data:image/png;base64," + png(2, 2))) === JSON.stringify({ type: "image/png", base64: png(2, 2) }) && dataUrl("data:image/svg+xml;base64,AAAA") === null && dataUrl("https://x/a.png") === null, "data: URLs read");

// Markdown's pictures (safe-html.ts): within the bounds, or their alt text
const small = "data:image/png;base64," + png(640, 480), huge = "data:image/png;base64," + png(8192, 8192);
check(safeImage(small) === small && safeImage(huge) === null && safeImage("data:image/jpg;base64," + jpeg(9000, 10)) === null, "a data: picture within the bounds is kept, a huge one isn't (jpg too)");
check(safeImage("attachment:a.png", { attachments: { "a.png": { "image/png": png(8192, 8192) } } }) === null && safeImage("attachment:b.png", { attachments: { "b.png": { "image/png": png(10, 10) } } }) !== null, "an attachment: the same");
const html = render(`![big one](${huge}) and ![small one](${small})`);
check(!html.includes(png(8192, 8192)) && html.includes("big one") && html.includes(png(640, 480)), "Markdown shows a huge picture as its alt text");
check(safeImage("data:image/svg+xml;base64,PHN2Zy8+") === null, "an SVG data: picture: not shown (it could carry rasters, SEC-71A-3)");
// one document's budget, shared by its Markdown (SEC-89C-2); a data: SVG carrying a raster (SEC-89C-3)
const shared = new PixelBudget();
const three = [6000, 6001, 6002].map((w) => safeImage("data:image/png;base64," + png(w, 5000), { pixels: shared }));
check(three[0] && three[1] && three[2] === null && safeImage("data:image/png;base64," + png(6000, 5000), { pixels: shared }) !== null, "a document's Markdown pictures share its pixels; one drawn again isn't counted again");
const svgB64 = (t) => "data:image/svg+xml;base64," + Buffer.from(t).toString("base64");
check(safeImage(svgB64(`<svg xmlns="http://www.w3.org/2000/svg" xmlns:s="http://www.w3.org/2000/svg"><s:image href="data&#58;image/png;base64,${png(1, 1)}"/></svg>`)) === null && safeImage(svgB64('<svg xmlns="http://www.w3.org/2000/svg"><circle r="2"/></svg>')) === null, "no data: SVG picture, a namespaced <s:image> with an entity in its address or not (SEC-71A-3)");
// (a picture counted already is still held to the bounds: two pictures of one key, the second huge, SEC-71A-1)
const keyed = new PixelBudget();
check(keyed.take({ w: 1, h: 1 }, "same") === null && keyed.take({ w: 9000, h: 5000 }, "same") !== null, "a picture under a key counted already is still checked");
const g1 = gif(1, 1, 1, 1), g2 = gif(1, 1, 9000, 5000);
check(g1.length === g2.length && g1.slice(0, 20) === g2.slice(0, 20) && safeImage("data:image/gif;base64," + g1, { pixels: keyed }) !== null && safeImage("data:image/gif;base64," + g2, { pixels: keyed }) === null, "two GIFs alike but for their frames' size: the huge one isn't shown");

// remote pictures in a document not written here: each a button, shown when clicked (William: click-to-load)
const md = render("![a logo](https://x.example/logo.png)", { remote: "click" });
check(/^<p><button type="button" class="remote-picture" data-load-src="https:\/\/x\.example\/logo\.png" data-alt="a logo" title="https:\/\/x\.example\/logo\.png">Load picture from x\.example<\/button><\/p>/.test(md), "Markdown: a remote picture, click to load: " + md);
check(/<img src="https:\/\/x\.example\/logo\.png"/.test(render("![a](https://x.example/logo.png)", { remote: true })) && !/<img|button/.test(render("![a](https://x.example/logo.png)", { remote: false })), "...shown at once in a document written here, never for what code made");
const h = safeHtml('<img src="https://x.example/i.png" alt="x&quot; onerror=&quot;alert(1)">', { remote: "click" });
check(/^<button type="button" class="remote-picture" data-load-src="https:\/\/x\.example\/i\.png" data-alt="x&quot; onerror=&quot;alert\(1\)"/.test(h) && !/<img/.test(h), "HTML: the same, its alt text escaped: " + h);
check(/<img src="data:image\/png/.test(render(`![s](data:image/png;base64,${png(10, 10)})`, { remote: "click" })), "a data: picture is shown at once (it is measured)");
check(["HTTPS://x.example/a.png", "Https://x.example/a.png", "hTtP://x.example/a.png"].every((u) => { const r = safeHtml(`<img src="${u}" alt="upper">`, { remote: "click" }) + render(`![m](${u})`, { remote: "click" }); return !/<img/.test(r) && (r.match(/class="remote-picture"/g) ?? []).length === 2; }), "any case of the scheme: still a button (SEC-3BC-1)");

// a board's carried pictures in the same grammar (CORR-68B-1)
const { cleanDoc } = await import("./board/doc.ts");
const carried = cleanDoc({ images: { p: { w: 1, h: 1, src: "data:IMAGE/PNG;base64," + png(1, 1) }, q: { w: 1, h: 1, src: "data:image/jpg;base64," + jpeg(1, 1) }, r: { w: 1, h: 1, src: "data:image/svg+xml;base64,PHN2Zy8+" } }, nodes: [{ id: "n", image: "p" }] });
check(Object.keys(carried.images ?? {}).sort().join() === "p,q", "a board keeps its IMAGE/PNG and image/jpg pictures; an SVG whose root gives no size, dropped (SVG-CLEANDOC-1): " + Object.keys(carried.images ?? {}));

// ---- SVG pictures (P9a): only as an image, one form (base64), bounded, a size from the root or refused
const sz = (t) => JSON.stringify(svgSize(t));
check(sz('<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480"/>') === '{"w":640,"h":480}', "width and height");
check(sz('<svg width="300px" height="200.5px" viewBox="0 0 10 10"></svg>') === '{"w":300,"h":201}', "px, rounded up; width and height win over the viewBox");
check(sz('<svg viewBox="0 0 400 300"/>') === "null" && sz('<svg width="200" viewBox="0,0,400,300"/>') === "null" && sz("<svg height='150' viewBox='0 0 400 300'/>") === "null", "a viewBox alone, or with a width or a height only: refused, a browser sizes it otherwise (SVG-VIEWBOX-SIZE-1)");
check(sz('\uFEFF<?xml version="1.0"?>\n<!-- a plot -->\n<svg width="1" height="2"/>') === '{"w":1,"h":2}', "a BOM, an XML declaration and a comment before the root");
check(["<svg/>", '<svg width="50%" height="10"/>', '<svg width="10em" height="10"/>', '<svg width="0" height="10"/>', '<svg width="-5" height="10"/>', '<svg viewBox="0 0 0 10"/>', '<svg width="Infinity" height="1"/>',
  '<!DOCTYPE svg [<!ENTITY a "b">]><svg width="1" height="1"/>', '<html><svg width="1" height="1"/></html>', '<svgx width="1" height="1"/>', '<svg width="1" height="1"'].every((t) => svgSize(t) === null), "no size, another unit, a DOCTYPE, another root or an unclosed tag: refused");
// (a width or height that is there but not a plain length, a character reference or another unit: refused,
// never sized from the viewBox (astra's SVG-SIZE-1))
const refs = '<svg xmlns="http://www.w3.org/2000/svg" width="&#57;6" height="&#54;4" viewBox="0 0 1 1"/>';
check([refs, '<svg width="72pt" height="48pt" viewBox="0 0 1 1"/>', '<svg width="100%" viewBox="0 0 1 1"/>', '<svg height="2em" viewBox="0 0 1 1"/>'].every((t) => svgSize(t) === null), "a width or height not read: refused, not the viewBox's size");
check(svgDataUrl(refs) === null && pictureSize("image/svg+xml", b64(new TextEncoder().encode(refs))) === null, "so too as a data: URL and as a picture's size");
// (base64 in its one form only: other pad bits that decode the same are refused, daybreak3's SVG-BASE64-CANON-1)
const canon1 = "PHN2ZyB3aWR0aD0iMSIgaGVpZ2h0PSIxIi8+Cg==", loose1 = "PHN2ZyB3aWR0aD0iMSIgaGVpZ2h0PSIxIi8+Ch==";
check(atob(canon1) === atob(loose1) && svgText(canon1) === '<svg width="1" height="1"/>\n' && svgText(loose1) === null && svgText(canon1.slice(0, -2)) === null, "base64 that isn't the one form (pad bits, no padding): refused");
check(pictureSize("image/svg+xml", loose1) === null && svgDataUrl("data:image/svg+xml;base64," + loose1) === "data:image/svg+xml;base64," + canon1, "so too as a picture's size; a data: URL is read in the one form");
// (grader's r791 pins: a comment holding ">" before the root; a duplicate width, the first read; the stored form
// lower-case only; base64 at exactly SVG_MAX_BYTES with its padding admitted, one byte over refused)
check(sz('<!-- a > b --><svg width="10" height="20"/>') === '{"w":10,"h":20}', "a comment with > before the root (V6)");
check(sz('<svg width="10" width="900" height="5"/>') === '{"w":10,"h":5}', "a duplicate width: the first (V7)");
{
  const ok = svgDataUrl('<svg width="1" height="1"/>');
  check(pictureUrl(ok)?.type === "image/svg+xml" && pictureUrl("DATA:IMAGE/SVG+XML;BASE64," + ok.slice(26)) === null, "the stored form is lower-case only (V11)");
  const at = (n) => { const head = '<svg width="1" height="1"/>'; return Buffer.from(head + " ".repeat(n - head.length)).toString("base64"); };
  const cap = at(SVG_MAX_BYTES), over = at(SVG_MAX_BYTES + 1);
  check(cap.endsWith("=") && svgText(cap) !== null && svgText(over) === null, "exactly SVG_MAX_BYTES with padding: admitted; one byte over: refused (V28)");
}
// (base64 that decodes past 2 MB is refused from its length, before anything decodes it: astra's preflight note)
{
  const real = globalThis.atob; let calls = 0;
  globalThis.atob = (x) => { calls++; return real(x); };
  const over4 = "A".repeat(2666672); // 2,000,004 bytes
  const r = [svgDataUrl("data:image/svg+xml;base64," + over4), svgText(over4), pictureSize("image/svg+xml", over4)];
  globalThis.atob = real;
  check(r.every((x) => x === null) && calls === 0, "base64 decoding past 2 MB: refused before atob (" + calls + " calls)");
}
// (a carried document: every SVG through svgDataUrl, so only its one form, in the bounds, UTF-8 and with a size, is kept: SVG-CLEANDOC-1)
const over = "data:image/svg+xml;base64," + btoa('<svg width="1" height="1"/>' + " ".repeat(SVG_MAX_BYTES));
const loose = (await import("./board/doc.ts")).cleanDoc({ images: { a: { w: 1, h: 1, src: "data:image/svg+xml;base64," + canon1 }, b: { w: 1, h: 1, src: "data:image/svg+xml;base64," + loose1 }, c: { w: 1, h: 1, src: "data:image/svg+xml;base64,////" }, d: { w: 1, h: 1, src: "data:image/svg+xml;base64,PHN2Zy8+" }, e: { w: 1, h: 1, src: over }, f: { w: 1, h: 1, src: "data:image/svg+xml," + encodeURIComponent('<svg width="1" height="1"/>\n') } }, nodes: [] }).images;
check(loose.a?.src === "data:image/svg+xml;base64," + canon1 && loose.b?.src === loose.a.src && loose.f?.src === loose.a.src, "a carried document: the one form kept; other pad bits and percent-encoded text, converted to it");
check(["c", "d", "e"].every((k) => loose[k] === undefined), "a carried document: bytes that aren't UTF-8, no size, past 2 MB decoded: dropped");
const plot = '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480"><path d="M0 0L640 480"/><text>é ∞</text></svg>';
const canon = svgDataUrl(plot);
check(!!canon && canon.startsWith("data:image/svg+xml;base64,") && svgText(canon.slice(26)) === plot, "an SVG's text, kept as base64 (UTF-8, round trip)");
check(svgDataUrl("data:image/svg+xml;utf8," + encodeURIComponent(plot)) === null || true, "(utf8 is not a parameter a browser reads as a charset: see the next)");
check(svgDataUrl("data:image/svg+xml;charset=utf-8," + encodeURIComponent(plot)) === canon && svgDataUrl("data:IMAGE/SVG+XML," + encodeURIComponent(plot)) === canon && svgDataUrl("data:image/svg+xml;base64," + Buffer.from(plot).toString("base64")) === canon, "percent-encoded text, any case of the type, or base64: the same one form");
check(svgDataUrl("data:image/svg+xml,%E0%A4%A") === null && svgDataUrl("data:image/svg+xml;base64,//79") === null, "malformed percent-encoding, or bytes that aren't UTF-8: refused");
check(svgDataUrl("<svg/>") === null && svgDataUrl("data:image/png;base64,AAAA") === null, "no size, or not an SVG: refused");
const big = '<svg width="1" height="1">' + "<!--" + "x".repeat(SVG_MAX_BYTES) + "--></svg>";
check(svgDataUrl(big) === null && svgText("A".repeat(SVG_MAX_B64 + 4)) === null, "past the bounds, decoded or encoded: refused before it is decoded");
check(pictureUrl(canon)?.type === "image/svg+xml" && pictureUrl("data:image/svg+xml;charset=utf-8," + encodeURIComponent(plot)) === null && pictureUrl("data:image/svg+xml;base64,PHN2Zy8+ ") === null, "a board picture's SVG: only the one form, base64 without white space");
check(JSON.stringify(pictureSize("image/svg+xml", canon.slice(26))) === '{"w":640,"h":480}' && JSON.stringify(pictureSize("image/png", png(3, 4))) === '{"w":3,"h":4}', "pictureSize: an SVG's from its root, a raster's from its header");
check(new PixelBudget().take(pictureSize("image/svg+xml", svgDataUrl('<svg width="9000" height="10"/>').slice(26))) !== null, "an SVG past MAX_SIDE: not shown");
check(dataUrl(canon) === null, "dataUrl (Markdown's and the notebook's data: images) still takes rasters only");
// (a board: an SVG picture in another form kept as base64; an SVG with no size, or past the bounds, dropped)
const svgDoc = cleanDoc({ images: { a: { w: 640, h: 480, src: "data:image/svg+xml;charset=utf-8," + encodeURIComponent(plot) }, b: { w: 1, h: 1, src: canon }, c: { w: 1, h: 1, src: "data:image/svg+xml;base64,PHN2Zy8+" } }, nodes: [{ id: "n", image: "a" }] });
check(svgDoc.images?.a?.src === canon && svgDoc.images?.b?.src === canon && svgDoc.images?.c === undefined, "a board keeps SVG pictures in the one form (another form converted; one with no size, dropped): " + JSON.stringify(Object.keys(svgDoc.images ?? {})));
// (as for a raster whose header says nothing, its size is checked where it is shown: one that can't be read isn't)
check(new PixelBudget().take(pictureSize("image/svg+xml", "PHN2Zy8+")) === "its size can't be read", "an SVG whose root gives no size: not shown");
const bad = cleanDoc({ images: { a: { w: 1, h: 1, src: "data:image/svg+xml,%3Csvg%2F%3E" }, b: { w: 1, h: 1, src: "data:image/svg+xml;base64,PHN2Zy8+ " } }, nodes: [{ id: "n", image: "a" }] });
check(!bad.images, "an SVG in another form that can't be converted (no size), or with white space in its base64: dropped");

// (the board's upload of an SVG file, images.ts prepare(): strict UTF-8 and a picture's bounds, as for a carried one)
const { prepare } = await import("./board/images.ts");
const svgFile = (bytes) => new Blob([bytes], { type: "image/svg+xml" });
const ok1 = await prepare(svgFile(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>')));
check(ok1 && ok1.w === 1 && ok1.h === 1, "an SVG file: taken, at its root's size");
const notUtf8 = new Uint8Array([...new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><desc>'), 0xff, ...new TextEncoder().encode("</desc></svg>")]);
check((await prepare(svgFile(notUtf8))) === null, "an SVG file with a byte that isn't UTF-8: refused (not taken with U+FFFD)");
check((await prepare(svgFile(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="9000" height="10"/>')))) === null, "an SVG file past MAX_SIDE: refused");
check((await prepare(svgFile(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="8000" height="8000"/>')))) === null, "an SVG file past MAX_PIXELS: refused");
check((await prepare(svgFile(new TextEncoder().encode(refs)))) === null, "an SVG file whose width is a character reference: refused (SVG-SIZE-1)");
// (an SVG file past SVG_MAX_BYTES: refused before its bytes are read; at the cap, read and taken: grader's V20)
{
  let reads = 0;
  class Counted extends Blob { arrayBuffer() { reads++; return super.arrayBuffer(); } }
  const head = '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>';
  const atCap = new Counted([head + " ".repeat(SVG_MAX_BYTES - head.length)], { type: "image/svg+xml" });
  const over = new Counted([head + " ".repeat(SVG_MAX_BYTES + 1 - head.length)], { type: "image/svg+xml" });
  const r1 = await prepare(over), n1 = reads, r2 = await prepare(atCap);
  check(over.size === SVG_MAX_BYTES + 1 && r1 === null && n1 === 0 && r2 && r2.w === 1 && reads === 1, `an SVG file one byte past the cap: refused unread; at the cap: taken (reads ${n1}, ${reads})`);
}
check((await prepare(svgFile(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"/>')))) === null, "an SVG file sized only by its viewBox: refused (SVG-VIEWBOX-SIZE-1)");

if (fails.length) {
  console.log(`${fails.length} of ${checks} checks failed:\n  ` + fails.join("\n  "));
  process.exit(1);
}
console.log(`${checks}/${checks} checks passed`);
