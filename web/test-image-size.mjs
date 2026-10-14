// image-size.ts: a picture's size from its header (PNG, JPEG, WebP, GIF),
// the bounds (MAX_SIDE, MAX_PIXELS each, LOAD_PIXELS in all), and Markdown's
// data: images held to them (safe-html.ts).   bun web/test-image-size.mjs
import { LOAD_PIXELS, MAX_PIXELS, MAX_SIDE, PixelBudget, dataUrl, imageSize } from "./image-size.ts";
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

if (fails.length) {
  console.log(`${fails.length} of ${checks} checks failed:\n  ` + fails.join("\n  "));
  process.exit(1);
}
console.log(`${checks}/${checks} checks passed`);
