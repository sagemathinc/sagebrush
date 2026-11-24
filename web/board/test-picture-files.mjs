// ci: web-runner order=200 runner=bun
// A workspace board's pictures as workspace files (#1872; images.ts with web/workspace/board-pictures.ts): a raster
// picture is saved in /Attachments/board-<id>/ under its content name, the same picture twice is one file, an SVG and
// a refused save stay in this browser; a board's files are shown only under their own content name; an export (no
// create) reads them and saves nothing; a board's copy gets its pictures in its own folder.
//   bun web/board/test-picture-files.mjs
import { Images } from "./images.ts";
import { boardPictureFiles, copyBoardPictures } from "../workspace/board-pictures.ts";

// (bun has no FileReader: the one use, a data: URL of a blob, as a browser makes it)
globalThis.FileReader ??= class { readAsDataURL(b) { b.arrayBuffer().then((a) => { this.result = `data:${b.type};base64,${Buffer.from(a).toString("base64")}`; this.onload(); }, (e) => { this.error = e; this.onerror(); }); } };

let failures = 0;
const ok = (c, msg, detail) => { console.log((c ? "ok   " : "FAIL ") + msg + (!c && detail !== undefined ? "  " + JSON.stringify(detail).slice(0, 600) : "")); if (!c) failures++; };
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const png = (fill, n = 64) => { const u = new Uint8Array(n).fill(fill); u.set(PNG); return u; };
const sha = async (u) => "i" + [...new Uint8Array(await crypto.subtle.digest("SHA-256", u)).slice(0, 16)].map((b) => b.toString(16).padStart(2, "0")).join("");

/** a stand-in workspace: files by path, an exclusive create (by whom, kept), list of a folder, readUpTo */
function workspace() {
  const files = new Map(), made = new Map();
  const err = (code) => Object.assign(new Error("secret text"), { code });
  const create = (who) => async (p, opts) => { if (files.has(p)) throw err("exists"); files.set(p, new Uint8Array(opts.content)); made.set(p, who); return { path: p }; };
  return {
    files, made,
    list: async (folder) => [...files.keys()].filter((p) => p.startsWith(folder + "/") && !p.slice(folder.length + 1).includes("/")).map((path) => ({ path, kind: "file" })),
    readUpTo: async (p, max) => { const u = files.get(p); if (!u) throw err("missing"); if (u.length > max) throw err("tooBig"); return { content: u }; },
    createByPerson: create("person"),
    create: async (p, opts) => create("elsewhere")(p, opts),
  };
}

// ---- saving
{
  const W = workspace(), im = new Images(boardPictureFiles(W, "0123456789ab", { save: true }));
  const u = png(1), name = await im.put(new Blob([u], { type: "image/png" }));
  const path = `/Attachments/board-0123456789ab/${name}.png`;
  ok(name === (await sha(u)) && W.files.has(path) && W.made.get(path) === "person", "a pasted picture: saved as the board's file, under its content name, by the person", [...W.files.keys()]);
  ok(typeof im.url(name) === "string", "and shown at once");
  // (another page of the same board puts the same picture: one file, no refusal)
  const im2 = new Images(boardPictureFiles(W, "0123456789ab", { save: true }));
  ok((await im2.put(new Blob([u], { type: "image/png" }))) === name && W.files.size === 1, "the same picture again: the one file", [...W.files.keys()]);
  const svg = await im.put(new Blob(['<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>'], { type: "image/svg+xml" }));
  ok(W.files.size === 1 && typeof im.url(svg) === "string", "an SVG: not a file (it stays in this browser)", [...W.files.keys()]);
  // (bytes that aren't the raster type: not a file either)
  const odd = await im.put(new Blob([new Uint8Array([1, 2, 3, 4])], { type: "image/png" }));
  ok(W.files.size === 1 && typeof im.url(odd) === "string", "bytes that aren't an image: not a file");
  im.dispose(); im2.dispose();
}

// ---- reading back
{
  const W = workspace(), A = new Images(boardPictureFiles(W, "aaaaaaaaaaaa", { save: true }));
  const u = png(2), name = await A.put(new Blob([u], { type: "image/png" }));
  A.dispose();
  // (another device: nothing in its browser, the board's file in the workspace)
  const B = new Images(boardPictureFiles(W, "aaaaaaaaaaaa"));
  await B.ensure([name]);
  ok(typeof B.url(name) === "string" && (await B.blob(name))?.type === "image/png", "the board's file: shown on another device");
  const d = await B.inline({ nodes: [], images: { [name]: { w: 1, h: 1 } } });
  ok(d.images[name].src === "data:image/png;base64," + Buffer.from(u).toString("base64"), "and carried by an export (a data: URL)", d.images[name].src?.slice(0, 40));
  B.dispose();
  // (a file in the folder under a name that isn't its content's: not that picture)
  const other = png(3), wrong = await sha(png(4));
  W.files.set(`/Attachments/board-aaaaaaaaaaaa/${wrong}.png`, other);
  const C = new Images(boardPictureFiles(W, "aaaaaaaaaaaa"));
  await C.ensure([wrong]);
  ok(C.url(wrong) === undefined, "a file whose bytes aren't its name's: not shown as that picture");
  // (a file elsewhere, or with another extension, isn't looked at)
  const n5 = await sha(png(5));
  W.files.set(`/Attachments/board-bbbbbbbbbbbb/${n5}.png`, png(5));
  W.files.set(`/Attachments/board-aaaaaaaaaaaa/${n5}.svg`, png(5));
  await C.ensure([n5]);
  ok(C.url(n5) === undefined, "another board's file, or a non-raster name: not this board's picture");
  // (an export reads, and never saves)
  const before = W.files.size;
  await C.put(new Blob([png(6)], { type: "image/png" }));
  ok(W.files.size === before, "without save (an export, the mirror, Push): nothing saved", [...W.files.keys()]);
  C.dispose();
}

// ---- folders
ok(boardPictureFiles(workspace(), "../x") === null && boardPictureFiles(workspace(), null) === null && boardPictureFiles(workspace(), "") === null, "an id that can't be a folder name: no files (this browser's alone)");

// ---- a board's copy
{
  const W = workspace(), A = new Images(boardPictureFiles(W, "aaaaaaaaaaaa", { save: true }));
  const n1 = await A.put(new Blob([png(7)], { type: "image/png" })), n2 = await A.put(new Blob([png(8)], { type: "image/png" }));
  A.dispose();
  await copyBoardPictures(W, "aaaaaaaaaaaa", "cccccccccccc", [n1, "i" + "0".repeat(32)], (p, content) => W.create(p, { content }));
  const p1 = `/Attachments/board-cccccccccccc/${n1}.png`;
  ok(W.files.has(p1) && W.made.get(p1) === "elsewhere" && !W.files.has(`/Attachments/board-cccccccccccc/${n2}.png`), "a copy: the pictures it shows, in its own folder, made as the copy was", [...W.files.keys()]);
  await copyBoardPictures(W, "aaaaaaaaaaaa", "cccccccccccc", [n1], (p, content) => W.create(p, { content }));
  ok([...W.files.keys()].filter((p) => p.startsWith("/Attachments/board-cccccccccccc/")).length === 1, "copied again: still one file");
  const B = new Images(boardPictureFiles(W, "cccccccccccc"));
  await B.ensure([n1]);
  ok(typeof B.url(n1) === "string", "and the copy shows it");
  B.dispose();
}

console.log(failures ? `${failures} FAILED` : "all ok");
process.exit(failures ? 1 : 0);
