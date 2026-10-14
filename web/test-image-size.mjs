// image-size.ts: a picture's size from its header (PNG, JPEG, WebP, GIF),
// the bounds (MAX_SIDE, MAX_PIXELS each, LOAD_PIXELS in all), and Markdown's
// data: images held to them (safe-html.ts).   bun web/test-image-size.mjs
import { LOAD_PIXELS, MAX_PIXELS, MAX_SIDE, PixelBudget, dataUrl, imageSize } from "./image-size.ts";
import { safeImage } from "./safe-html.ts";
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
const gif = (w, h) => b64([...Buffer.from("GIF89a"), ...le16(w), ...le16(h), 0, 0, 0]);

const sizes = { png: imageSize("image/png", png(8192, 8192)), jpeg: imageSize("image/jpeg", jpeg(300, 200)), webp: imageSize("image/webp", webp(5000, 9000)), gif: imageSize("image/gif", gif(640, 480)) };
check(JSON.stringify(sizes) === '{"png":{"w":8192,"h":8192},"jpeg":{"w":300,"h":200},"webp":{"w":5000,"h":9000},"gif":{"w":640,"h":480}}', "sizes from each header: " + JSON.stringify(sizes));
check(imageSize("image/png", "AAAA") === null && imageSize("image/gif", "R0lG") === null && imageSize("image/bmp", png(1, 1)) === null && imageSize("image/png", "!!") === null, "unreadable, or another type: no size");

// the bounds
const one = (w, h) => new PixelBudget().take({ w, h });
check(one(MAX_SIDE, 4000) === null && one(6000, 6000) === null, "within the bounds: shown");
check(/8193 × 10/.test(one(MAX_SIDE + 1, 10) ?? "") && one(10, MAX_SIDE + 1) !== null && one(8000, 6000) !== null && one(0, 10) !== null && new PixelBudget().take(null) !== null, "a side over 8192, over 40 MP, empty or unknown: not shown");
check(8192 * 8192 > MAX_PIXELS, "a picture 8192 square is over the pixels' bound too");
const budget = new PixelBudget();
const takes = [budget.take({ w: 6000, h: 5000 }), budget.take({ w: 6000, h: 5000 }), budget.take({ w: 6000, h: 5000 }), budget.take({ w: 100, h: 100 })];
check(takes[0] === null && takes[1] === null && /in all/.test(takes[2] ?? "") && takes[3] === null && budget.used <= LOAD_PIXELS, "a document's pictures: 80 MP in all, then not shown (a small one still fits): " + JSON.stringify(takes));
check(JSON.stringify(dataUrl("data:image/png;base64," + png(2, 2))) === JSON.stringify({ type: "image/png", base64: png(2, 2) }) && dataUrl("data:image/svg+xml;base64,AAAA") === null && dataUrl("https://x/a.png") === null, "data: URLs read");

// Markdown's pictures (safe-html.ts): within the bounds, or their alt text
const small = "data:image/png;base64," + png(640, 480), huge = "data:image/png;base64," + png(8192, 8192);
check(safeImage(small) === small && safeImage(huge) === null && safeImage("data:image/jpg;base64," + jpeg(9000, 10)) === null, "a data: picture within the bounds is kept, a huge one isn't (jpg too)");
check(safeImage("attachment:a.png", { attachments: { "a.png": { "image/png": png(8192, 8192) } } }) === null && safeImage("attachment:b.png", { attachments: { "b.png": { "image/png": png(10, 10) } } }) !== null, "an attachment: the same");
const html = render(`![big one](${huge}) and ![small one](${small})`);
check(!html.includes(png(8192, 8192)) && html.includes("big one") && html.includes(png(640, 480)), "Markdown shows a huge picture as its alt text");
check(safeImage("data:image/svg+xml;base64,PHN2Zy8+") !== null, "an SVG picture: kept (drawn at the size shown)");

if (fails.length) {
  console.log(`${fails.length} of ${checks} checks failed:\n  ` + fails.join("\n  "));
  process.exit(1);
}
console.log(`${checks}/${checks} checks passed`);
