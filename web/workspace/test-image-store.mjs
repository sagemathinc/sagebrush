// ci: web-runner order=199 runner=bun
// The shared image store (image-store.ts): which bytes are images, where they're saved, content-addressed names, the
// attachment form that refers to a file (and fails closed), data: URLs, and a notebook's embed on export and extract
// on import, round trip included.
//   bun web/workspace/test-image-store.mjs
import { IMAGE_BYTES_MAX, FILE_KEY, ImageUrls, referencedPaths, embedAttachmentsWith, imageType, imageFolder, saveImage, filePathOf, isFileEntry, fromBase64, toBase64, toDataUrl, fromDataUrl, embedAttachments, extractAttachments, refusalOf } from "./image-store.ts";

let failures = 0;
const J = JSON.stringify;
const ok = (c, msg, detail) => { console.log((c ? "ok   " : "FAIL ") + msg + (!c && detail !== undefined ? "  " + JSON.stringify(detail).slice(0, 600) : "")); if (!c) failures++; };
const ascii = (s) => [...s].map((c) => c.charCodeAt(0));
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const bytes = (head, n = 64, fill = 7) => { const u = new Uint8Array(n).fill(fill); u.set(head); return u; };
/** a stand-in workspace: exclusive create, read */
function store() {
  const files = new Map();
  const create = async (p, u) => { if (files.has(p)) throw Object.assign(new Error("there already: secret text"), { code: "exists" }); files.set(p, new Uint8Array(u)); };
  const read = async (p) => files.get(p) ?? null;
  return { files, create, read };
}

// ---- types and folders
ok(imageType(bytes(PNG))?.ext === "png" && imageType(bytes([0xff, 0xd8, 0xff]))?.mime === "image/jpeg" && imageType(bytes(ascii("GIF89a")))?.ext === "gif" && imageType(bytes([...ascii("RIFF"), 1, 2, 3, 4, ...ascii("WEBP")]))?.ext === "webp" && imageType(bytes(ascii("<svg"))) === null, "types by bytes: PNG, JPEG, GIF, WebP; SVG isn't one");
ok(imageFolder("chat", "abc") === "/Attachments/abc" && imageFolder("nb", "u-1") === "/Attachments/nb-u-1" && imageFolder("board", "ab12") === "/Attachments/board-ab12" && imageFolder("nb", "../x") === null && imageFolder("board", "a b") === null && imageFolder("nb", "") === null, "folders: a chat's, a notebook's (nb-), a board's (board-); only plain ids");

// ---- saving
{
  const S = store();
  const r = await saveImage(S.create, "/Attachments/nb-x", bytes(PNG));
  ok(/^\/Attachments\/nb-x\/[0-9a-f]{24}\.png$/.test(r.path) && S.files.size === 1, "saved under a random name with the bytes' extension", r);
  ok((await saveImage(S.create, "/Attachments/nb-x", bytes(ascii("<svg")))).refused === "notImage" && (await saveImage(S.create, "/Attachments/nb-x", bytes(PNG, IMAGE_BYTES_MAX + 1))).refused === "tooBig" && S.files.size === 1, "refused: not an image, over the cap; nothing written");
  ok((await saveImage(S.create, "/Attachments/nb-x", bytes(PNG, IMAGE_BYTES_MAX))).path !== undefined, "exactly the cap is saved");
  ok((await saveImage(S.create, "/Attachments/b", bytes(PNG, 2_000_001), { max: 2_000_000 })).refused === "tooBig" && (await saveImage(S.create, "/Attachments/b", bytes(PNG, IMAGE_BYTES_MAX + 1), { max: 9e9 })).refused === "tooBig", "a caller's cap applies; never above the outer cap");
  // content-addressed (the board's)
  const T = store();
  const a = await saveImage(T.create, "/Attachments/board-1", bytes(PNG), { name: "iabc", read: T.read });
  const again = await saveImage(T.create, "/Attachments/board-1", bytes(PNG), { name: "iabc", read: T.read });
  const other = await saveImage(T.create, "/Attachments/board-1", bytes(PNG, 64, 9), { name: "iabc", read: T.read });
  ok(a.path === "/Attachments/board-1/iabc.png" && again.path === a.path && other.refused === "exists" && T.files.size === 1, "a content-addressed name: the same bytes again is the same file (success); other bytes there are refused", { a, again, other });
  ok((await saveImage(T.create, "/Attachments/board-1", bytes(PNG), { name: "../x", read: T.read })).refused === "other" && (await saveImage(T.create, "/Attachments/board-1", bytes(PNG), { name: "ok" })).refused === "other", "a name must be plain, and comes with read");
  ok(refusalOf({ code: "limit" }) === "limit" && refusalOf({ code: "toString" }) === "other" && refusalOf(new Error("x")) === "other", "refusals by code only");
}

// ---- the file-referring attachment, failing closed
ok(filePathOf({ [FILE_KEY]: "/Attachments/nb-x/ab12.png" }) === "/Attachments/nb-x/ab12.png", "a well-formed reference");
const bad = [{ [FILE_KEY]: "/Attachments/nb-x/../../secret.png" }, { [FILE_KEY]: "/private/a.png" }, { [FILE_KEY]: "/Attachments/a.png" }, { [FILE_KEY]: "/Attachments/nb-x/a/b.png" }, { [FILE_KEY]: "/Attachments/nb-x/a.svg" }, { [FILE_KEY]: "/Attachments/nb-x/.a.png" }, { [FILE_KEY]: 7 }, { [FILE_KEY]: "/Attachments/nb-x/a.png", extra: 1 }, { "image/png": "AAAA" }, null, [], "x"];
ok(bad.every((b) => filePathOf(b) === null), "ill-formed references are refused: traversal, outside /Attachments, wrong depth, not raster, hidden, not a string, extra keys", bad.filter((b) => filePathOf(b) !== null));
ok(isFileEntry({ [FILE_KEY]: 1 }) && !isFileEntry({ "image/png": "x" }), "an entry of our key is ours even when ill-formed");

// ---- base64 and data: URLs
ok(fromBase64("QQ==")?.[0] === 65 && fromBase64("QQ") === null && fromBase64("Q Q==") === null && fromBase64("QQ==\n") === null && fromBase64("-_8=") === null, "strict base64");
ok(fromBase64("A".repeat(8), 5) === null && fromBase64("A".repeat(8), 6) !== null, "refused by its decoded length before decoding");
{
  const u = bytes(PNG);
  const url = toDataUrl(u);
  ok(url.startsWith("data:image/png;base64,") && fromDataUrl(url).length === 64, "data: URL round trip");
  ok(fromDataUrl("data:image/svg+xml;base64,PHN2Zz4=") === null && fromDataUrl(url.replace("image/png", "image/gif")) === null && toDataUrl(bytes(ascii("<svg"))) === null && fromDataUrl(url, 10) === null, "data: URLs: not SVG, the type must match the bytes, the cap applies");
}

// ---- a notebook: extract on import, embed on export, round trip
{
  const png = bytes(PNG), gif = bytes(ascii("GIF89a"), 40);
  const svg = { "image/svg+xml": "PHN2Zz4=" };
  const doc = { mode: "python", cells: [
    { id: "a", type: "markdown", code: "![a](attachment:a.png) ![g](attachment:g.gif) ![s](attachment:s.svg)", attachments: { "a.png": { "image/png": toBase64(png) }, "g.gif": { "image/gif": toBase64(gif) }, "s.svg": svg, "two.png": { "image/png": toBase64(png), "text/plain": "x" }, "lie.png": { "image/png": toBase64(gif) } } },
    { id: "b", code: "1+1", attachments: { "c.png": { "image/png": toBase64(png) } } },
  ] };
  const S = store();
  const x = await extractAttachments(doc, (u) => saveImage(S.create, "/Attachments/nb-r1", u));
  const att = x.doc.cells[0].attachments;
  ok(x.extracted === 2 && filePathOf(att["a.png"]) && filePathOf(att["g.gif"]) && att["s.svg"] === svg && att["two.png"]["text/plain"] === "x" && att["lie.png"]["image/png"] && S.files.size === 2, "import: raster images become files; SVG, several mimes and a mime that lies stay inline", att);
  ok(x.doc.cells[0].code === doc.cells[0].code && x.doc.cells[1] === doc.cells[1] && doc.cells[0].attachments["a.png"]["image/png"], "the source never changes, code cells are untouched, the given document isn't modified");
  const e = await embedAttachments(x.doc, S.read);
  ok(e.missing.length === 0 && JSON.stringify(e.doc.cells[0].attachments) === JSON.stringify(doc.cells[0].attachments) && e.doc.cells[0].code === doc.cells[0].code, "export: the same attachments, byte for byte, and the same source (round trip)", e.doc.cells[0].attachments);
  // a missing file, and a file that isn't an image any more
  S.files.delete(filePathOf(att["a.png"]));
  S.files.set(filePathOf(att["g.gif"]), new TextEncoder().encode("not an image"));
  const m = await embedAttachments(x.doc, S.read);
  ok(m.missing.join() === "a.png,g.gif" && !("a.png" in m.doc.cells[0].attachments) && m.doc.cells[0].attachments["s.svg"] === svg, "export: a missing or changed file is left out and listed; the rest is kept", m.missing);
  const evil = { cells: [{ type: "markdown", code: "x", attachments: { "e.png": { [FILE_KEY]: "/private/notes.png" } } }] };
  let asked = 0;
  const ev = await embedAttachments(evil, async () => { asked++; return bytes(PNG); });
  ok(asked === 0 && ev.missing.join() === "e.png", "export: an ill-formed reference is never read, only listed as missing");
  const plain = { cells: [{ type: "markdown", code: "x" }] };
  ok((await embedAttachments(plain, S.read)).doc === plain && (await extractAttachments(plain, () => { throw new Error("no"); })).doc === plain, "a notebook with nothing to do is returned as it is");
}

// ---- ImageUrls: shown when its size can be read; its checked bytes kept for export either way
{
  const real = new Uint8Array(64).fill(7); real.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 3, 0, 0, 0, 2]);
  const noSize = bytes(PNG); // (a PNG signature with no IHDR: its size can't be read)
  const files = new Map([["/Attachments/nb-x/a.png", real], ["/Attachments/nb-x/b.png", noSize], ["/Attachments/nb-x/c.png", new TextEncoder().encode("text")]]);
  const reads = [];
  let changes = 0;
  const U = new ImageUrls(async (p) => { reads.push(p); return files.get(p) ?? null; }, () => changes++);
  await U.ready(["/Attachments/nb-x/a.png", "/Attachments/nb-x/b.png", "/Attachments/nb-x/c.png", "/Attachments/nb-x/none.png", "/private/x.png"]);
  const a = U.url("/Attachments/nb-x/a.png");
  ok(a && a.url.startsWith("blob:") && a.w === 3 && a.h === 2 && U.bytes("/Attachments/nb-x/a.png")?.length === 64, "a readable image: a blob: URL with its size, and its bytes");
  ok(U.url("/Attachments/nb-x/b.png") === null && U.bytes("/Attachments/nb-x/b.png")?.length === 64, "an image whose size can't be read: not drawn, but its bytes kept for export");
  ok(U.bytes("/Attachments/nb-x/c.png") === null && U.bytes("/Attachments/nb-x/none.png") === null, "not an image, or missing: nothing");
  ok(!reads.includes("/private/x.png") && reads.length === 4, "a path outside /Attachments is never read", reads);
  U.put("/Attachments/nb-x/d.png", real);
  ok(U.bytes("/Attachments/nb-x/d.png")?.length === 64 && !reads.includes("/Attachments/nb-x/d.png"), "an image saved just now is held without reading it back");
  const doc = { cells: [{ type: "markdown", code: "x", attachments: { "a.png": { [FILE_KEY]: "/Attachments/nb-x/a.png" }, "b.png": { [FILE_KEY]: "/Attachments/nb-x/b.png" }, "c.png": { [FILE_KEY]: "/Attachments/nb-x/c.png" } } }] };
  ok(J(referencedPaths(doc)) === J(["/Attachments/nb-x/a.png", "/Attachments/nb-x/b.png", "/Attachments/nb-x/c.png"]), "the paths a notebook refers to");
  const e = embedAttachmentsWith(doc, (p) => U.bytes(p));
  ok(e.missing.join() === "c.png" && Object.keys(e.doc.cells[0].attachments).join() === "a.png,b.png", "export from held bytes: both images embedded (the one not drawn too); the non-image left out and listed", e.missing);
  U.dispose();
}

console.log(failures ? `${failures} FAILED` : "test-image-store: all passed");
process.exit(failures ? 1 : 0);
