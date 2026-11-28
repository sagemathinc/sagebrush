// ci: web-runner order=200 runner=bun chrome
// Images in notebook Markdown cells (#1872), on the real notebook page with this browser's workspace:
//  N1. a PNG pasted into a Markdown cell: saved as /Attachments/nb-<the notebook's ref>/<random>.png with its bytes,
//      the cell gets `![image](attachment:<name>)` and an attachment entry {"sagebrush/file": path};
//  N2. drawn: an <img> with a blob: URL, sized within the page's pixel budget;
//  N3. Download's .ipynb embeds it as Jupyter's {"image/png": base64} of the very bytes, the source unchanged;
//  N4. a drop works the same; a paste of an SVG is refused, said in the status line, nothing saved; a code cell takes
//      no image;
//  N5. an .ipynb uploaded with PNG, GIF and SVG attachments: the raster ones extracted to files (the cells refer to
//      them), the SVG kept inline; exported again, the attachments and sources are the same (round trip);
//  N6. an ill-formed reference ({"sagebrush/file": "/private/..."}) shows as missing and is never read.
//   SAGEBRUSH_AGENTS=1 bun web/build.ts && CHROME=google-chrome bun web/workspace/test-notebook-images.mjs
import { spawn } from "node:child_process";
import { join } from "node:path";
import { startServe } from "../test-port.mjs";
import { browser } from "../agents/a14-cases.mjs";

const here = new URL(".", import.meta.url).pathname;
let failures = 0;
const ok = (c, msg, detail) => { console.log((c ? "ok   " : "FAIL ") + msg + (!c && detail !== undefined ? "  " + JSON.stringify(detail).slice(0, 800) : "")); if (!c) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = JSON.stringify;

let server;
const sitePort = await startServe(() => (server = spawn("python3", [join(here, "..", "serve.py"), "0"], { stdio: ["ignore", "pipe", "pipe"] }))).port;
const site = `http://127.0.0.1:${sitePort}`;
const B = await browser();
// (a real 3x2 PNG, so a drawn image can be decoded: its pixels, not only its header)
const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAIAAAASFvFNAAAAEElEQVR4nGM4IScHQQxwFgBBAAYZPEVBlgAAAABJRU5ErkJggg==";
const PNG_JS = `Uint8Array.from(atob("${PNG_B64}"), (c) => c.charCodeAt(0))`;
const PNG = new Uint8Array(Buffer.from(PNG_B64, "base64"));
/** whether every <img> matched by `sel` decodes, and their natural widths */
const decoded = (P, sel) => P.ev(`Promise.all([...document.querySelectorAll(${JSON.stringify(sel)})].map((i) => i.decode().then(() => i.naturalWidth, () => 0)))`);
const b64 = (u) => Buffer.from(u).toString("base64");
const NB = "window.sagebrush.notebook", T = "window.sagebrush.imagesTest", W = "window.sagebrush.workspace";
try {
  const P = await B.tab();
  await P.send("Page.navigate", { url: `${site}/` });
  await P.until(`!!(window.sagebrush?.notebook && window.sagebrush.workspace && ${T}.ref() && document.querySelector("#cells .cell"))`, 30000);
  await sleep(1000);
  const ref = await P.ev(`${T}.ref()`);

  // ---- N1: paste into a Markdown cell
  const at = await P.ev(`(() => { const c = ${NB}.addCell("Look:", null, false, "markdown"); return ${NB}.cells().indexOf(c); })()`);
  const cellJs = `${NB}.cells()[${at}]`;
  /** a paste or drop of `files` (bytes expressions) on a cell's element; true if the page took it (preventDefault) */
  const give = (i, files, { drop = false, text = "" } = {}) => P.ev(`(() => {
    const dt = new DataTransfer();
    for (const [bytes, name, type] of ${files}) dt.items.add(new File([bytes], name, { type }));
    if (${J(text)}) dt.setData("text/plain", ${J(text)});
    const el = ${NB}.cells()[${i}].el.querySelector("textarea") ?? ${NB}.cells()[${i}].el;
    const e = ${drop} ? new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }) : new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true });
    el.dispatchEvent(e);
    return e.defaultPrevented;
  })()`);
  const took = await give(at, `[[${PNG_JS}, "shot.png", "image/png"]]`);
  await P.until(`/attachment:/.test(${cellJs}.ta.value)`, 10000).catch(() => {});
  const c1 = await P.ev(`(() => { const c = ${cellJs}; return { text: c.ta.value, att: c.attachments }; })()`);
  const name = /attachment:([^)]+)\)/.exec(c1.text)?.[1];
  const path = c1.att?.[name]?.["sagebrush/file"];
  ok(took && new RegExp(`^/Attachments/nb-${ref}/[0-9a-f]{24}\\.png$`).test(path ?? "") && /^Look:\n\n!\[image\]\(attachment:[0-9a-f]{24}\.png\)$/.test(c1.text) && Object.keys(c1.att[name]).join() === "sagebrush/file", "N1: a pasted PNG: saved in /Attachments/nb-<ref>/, the cell refers to it as Jupyter's attachment:name", { c1, ref });
  const saved = await P.ev(`(async () => { const r = await ${W}.read(${J(path ?? "/none")}).catch(() => null); return r?.content ? [...r.content] : null; })()`);
  ok(J(saved) === J([...PNG]), "N1: …the file has the pasted bytes");

  // ---- N2: drawn from the workspace, as a blob: image
  await P.ev(`(${NB}.run(${cellJs}), true)`).catch(() => {});
  await P.until(`!!${cellJs}.md.querySelector('img[src^="blob:"]')`, 10000).catch(() => {});
  const img = await P.ev(`(() => { const i = ${cellJs}.md.querySelector("img"); return i ? { src: i.getAttribute("src").slice(0, 5), alt: i.alt } : ${cellJs}.md.innerHTML.slice(0, 200); })()`);
  const w2 = await P.ev(`(() => { const i = ${cellJs}.md.querySelector("img"); return i ? i.decode().then(() => [i.naturalWidth, i.naturalHeight], () => null) : null; })()`);
  ok(img?.src === "blob:" && img.alt === "image" && J(w2) === J([3, 2]), "N2: the cell shows it, from a blob: URL, and it decodes as the 3x2 image pasted", { img, w2 });

  // ---- N3: Download embeds it
  await sleep(500);
  const nbJson = JSON.parse(await P.ev(`${T}.exportIpynb()`));
  const out = nbJson.cells.find((c) => c.cell_type === "markdown" && /attachment:/.test([].concat(c.source).join("")));
  ok(out && J(Object.keys(out.attachments[name])) === J(["image/png"]) && out.attachments[name]["image/png"] === b64(PNG) && [].concat(out.source).join("") === c1.text, "N3: Download's .ipynb embeds the image as {\"image/png\": base64} of its bytes, the source unchanged", out);

  // ---- N4: a drop; an SVG refused; a code cell takes nothing
  const took4 = await give(at, `[[${PNG_JS}, "d.png", "image/png"]]`, { drop: true });
  await P.until(`(${cellJs}.ta.value.match(/attachment:/g) ?? []).length === 2`, 10000).catch(() => {});
  ok(took4 && Object.keys(await P.ev(`${cellJs}.attachments`)).length === 2, "N4: a dropped image is added the same way");
  const filesBefore = await P.ev(`(async () => (await ${W}.list(${J(`/Attachments/nb-${ref}`)})).length)()`);
  await give(at, `[[new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'/>"), "a.svg", "image/svg+xml"]]`);
  await sleep(800);
  const filesAfter = await P.ev(`(async () => (await ${W}.list(${J(`/Attachments/nb-${ref}`)})).length)()`);
  ok(filesAfter === filesBefore && /Only PNG, JPEG, GIF and WebP/.test(await P.ev(`document.querySelector("#status").textContent`)), "N4: an SVG pasted: refused, said in the status line, nothing saved");
  const codeAt = await P.ev(`(() => { const c = ${NB}.addCell("x = 1", null, false, "code"); return ${NB}.cells().indexOf(c); })()`);
  const took4c = await give(codeAt, `[[${PNG_JS}, "c.png", "image/png"]]`);
  await sleep(500);
  ok(!took4c && (await P.ev(`${NB}.cells()[${codeAt}].ta.value`)) === "x = 1" && !(await P.ev(`${NB}.cells()[${codeAt}].attachments`)), "N4: a code cell takes no image");

  // ---- N5: import an .ipynb with attachments, then export it again
  // (a real 1x1 GIF)
  const gif = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");
  const svg = { "image/svg+xml": Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>").toString("base64") };
  const src = { cells: [
    { cell_type: "markdown", id: "m1", metadata: {}, source: ["![p](attachment:p.png) ![g](attachment:g.gif) ![s](attachment:s.svg)"], attachments: { "p.png": { "image/png": b64(PNG) }, "g.gif": { "image/gif": gif.toString("base64") }, "s.svg": svg } },
    { cell_type: "code", id: "c1", metadata: {}, source: ["1 + 1"], outputs: [], execution_count: null },
  ], metadata: { kernelspec: { name: "python3", display_name: "Python 3", language: "python" } }, nbformat: 4, nbformat_minor: 5 };
  const r5 = await P.ev(`(async () => { const r = await ${T}.importIpynb("imported.ipynb", ${J(J(src))}); return { made: r.made.map((e) => ({ path: e.path, ref: e.ref })), refused: r.refused }; })()`);
  const made = r5.made[0];
  const doc5 = made && (await P.ev(`(async () => (await ${W}.read(${J(made.path)})).content)()`));
  const att5 = doc5?.cells?.[0]?.attachments ?? {};
  const pp = att5["p.png"]?.["sagebrush/file"], gp = att5["g.gif"]?.["sagebrush/file"];
  ok(made && new RegExp(`^/Attachments/nb-${made.ref}/[0-9a-f]{24}\\.png$`).test(pp ?? "") && /\.gif$/.test(gp ?? "") && J(att5["s.svg"]) === J(svg) && doc5.cells[0].code === src.cells[0].source[0], "N5: an uploaded .ipynb: PNG and GIF extracted to files in its own folder, the SVG kept inline, the source as it was", { r5, att5 });
  await P.ev(`window.sagebrush.open(${J(made?.ref)})`);
  await P.until(`${T}.ref() === ${J(made?.ref)}`, 15000).catch(() => {});
  await sleep(800);
  const back = JSON.parse(await P.ev(`${T}.exportIpynb()`));
  ok(J(back.cells[0].attachments) === J(src.cells[0].attachments) && [].concat(back.cells[0].source).join("") === src.cells[0].source[0], "N5: exported again: the same attachments, byte for byte, and the same source (round trip)", back.cells[0].attachments);
  await P.until(`[...document.querySelectorAll("#cells .mdout img")].filter((i) => i.getAttribute("src").startsWith("blob:")).length === 2`, 10000).catch(() => {});
  const w5 = await decoded(P, '#cells .mdout img[src^="blob:"]');
  ok(J(w5) === J([3, 1]), "N5: the imported notebook shows its two raster images from files, and both decode (3 and 1 pixels wide)", w5);

  // ---- N7: an image over the page's pixel budget (9000 px wide): saved and exported, but not drawn
  const big = `(() => { const u = new Uint8Array(64).fill(7); u.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0x23, 0x28, 0, 0, 0, 10]); return u; })()`;
  const at7 = await P.ev(`(() => { const c = ${NB}.addCell("", null, false, "markdown"); return ${NB}.cells().indexOf(c); })()`);
  await give(at7, `[[${big}, "big.png", "image/png"]]`);
  await P.until(`/attachment:/.test(${NB}.cells()[${at7}].ta.value)`, 10000).catch(() => {});
  await P.ev(`(${NB}.run(${NB}.cells()[${at7}]), true)`).catch(() => {});
  await sleep(1000);
  const shown7 = await P.ev(`(() => { const c = ${NB}.cells()[${at7}]; return { img: !!c.md.querySelector("img"), name: /attachment:([^)]+)\\)/.exec(c.ta.value)?.[1] }; })()`);
  const ex7 = JSON.parse(await P.ev(`${T}.exportIpynb()`));
  const embedded7 = ex7.cells.some((c) => c.attachments?.[shown7.name]?.["image/png"]);
  ok(shown7.name && !shown7.img && embedded7, "N7: an image over the pixel budget (9000 px wide): not drawn, but saved and exported", { shown7, embedded7 });

  // ---- N8: an export after the file changed in the workspace embeds what the workspace has now
  const p8 = await P.ev(`(() => { const c = ${NB}.cells()[${at7}]; return Object.values(c.attachments)[0]["sagebrush/file"]; })()`);
  await P.ev(`(async () => { const u = new Uint8Array(64).fill(5); u.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 3, 0, 0, 0, 2]); await ${W}.write(${J(p8)}, u); return true; })()`);
  const ex8 = JSON.parse(await P.ev(`${T}.exportIpynb()`));
  const b8 = ex8.cells.map((c) => c.attachments?.[shown7.name]?.["image/png"]).find(Boolean);
  ok(b8 && Buffer.from(b8, "base64")[40] === 5, "N8: the file changed in the workspace: Download embeds its new bytes, not the ones held before");

  // ---- N9: the real File > Download: captured as the page writes it, after the file changed again
  await P.ev(`(async () => { const u = new Uint8Array(64).fill(4); u.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 3, 0, 0, 0, 2]); await ${W}.write(${J(p8)}, u); return true; })()`);
  await P.ev(`(() => { window.__dl = null; const click = HTMLAnchorElement.prototype.click; HTMLAnchorElement.prototype.click = function () { if (this.download) { window.__dl = { name: this.download, href: this.href }; fetch(this.href).then((r) => r.text()).then((t) => (window.__dl.text = t)); return; } return click.call(this); }; return true; })()`);
  await P.ev(`(document.querySelector('[data-f="ipynb"]').click(), true)`);
  await P.until(`!!window.__dl?.text`, 10000).catch(() => {});
  const dl = await P.ev(`window.__dl`);
  const b9 = dl?.text ? JSON.parse(dl.text).cells.map((c) => c.attachments?.[shown7.name]?.["image/png"]).find(Boolean) : null;
  ok(/\.ipynb$/.test(dl?.name ?? "") && b9 && Buffer.from(b9, "base64")[40] === 4, "N9: File > Download writes the .ipynb with the image's current bytes embedded", dl && { name: dl.name });

  // ---- N10: a paste still being saved when another notebook is opened: the image goes to the notebook it was pasted
  //  into (its folder), and nothing is put into the one now shown
  const refA = await P.ev(`${T}.ref()`);
  const atA = await P.ev(`(() => { const c = ${NB}.addCell("A", null, false, "markdown"); return ${NB}.cells().indexOf(c); })()`);
  await sleep(700);
  const otherRef = made?.ref === refA ? ref : made?.ref;
  await P.ev(`(() => { window.__release = null; navigator.locks.request("sagebrush-workspace", { mode: "exclusive" }, () => new Promise((r) => (window.__release = r))); return true; })()`);
  await P.until(`typeof window.__release === "function"`);
  await give(atA, `[[${PNG_JS}, "late.png", "image/png"]]`);
  await sleep(300);
  await P.ev(`window.sagebrush.open(${J(otherRef)})`).catch(() => {});
  await sleep(300);
  await P.ev(`(window.__release(), true)`);
  await P.until(`${T}.ref() === ${J(otherRef)}`, 15000).catch(() => {});
  await sleep(1500);
  const shownRef = await P.ev(`${T}.ref()`);
  const inShown = await P.ev(`${NB}.cells().some((c) => /late|attachment:[0-9a-f]{24}/.test(c.ta.value) && c.attachments && Object.values(c.attachments).some((a) => a["sagebrush/file"]?.includes(${J(refA)})))`);
  const otherFolder = await P.ev(`(async () => (await ${W}.list(${J(`/Attachments/nb-${otherRef}`)}).catch(() => [])).length)()`);
  const otherBefore = 2; // (the imported notebook's PNG and GIF, N5)
  ok(shownRef === otherRef && !inShown && otherFolder === otherBefore, "N10: a paste saved after another notebook was opened: nothing put into the notebook now shown, nothing in its folder", { shownRef, otherRef, inShown, otherFolder });

  // ---- N10b: another notebook opened while the pasted file is still being read: nothing saved anywhere
  await P.ev(`window.sagebrush.open(${J(refA)})`).catch(() => {});
  await P.until(`${T}.ref() === ${J(refA)}`, 15000).catch(() => {});
  await sleep(800);
  const atB = await P.ev(`(() => { const c = ${NB}.addCell("B", null, false, "markdown"); return ${NB}.cells().indexOf(c); })()`);
  const countA = async () => P.ev(`(async () => (await ${W}.list(${J(`/Attachments/nb-${refA}`)}).catch(() => [])).length)()`);
  const countO = async () => P.ev(`(async () => (await ${W}.list(${J(`/Attachments/nb-${otherRef}`)}).catch(() => [])).length)()`);
  const a0 = await countA(), o0 = await countO();
  await P.ev(`(() => { const ab = Blob.prototype.arrayBuffer; Blob.prototype.arrayBuffer = function () { const self = this; Blob.prototype.arrayBuffer = ab; return new Promise((r) => (window.__abRelease = () => r(ab.call(self)))); }; return true; })()`);
  await give(atB, `[[${PNG_JS}, "slow.png", "image/png"]]`);
  await P.until(`typeof window.__abRelease === "function"`, 5000).catch(() => {});
  await P.ev(`window.sagebrush.open(${J(otherRef)})`).catch(() => {});
  await P.until(`${T}.ref() === ${J(otherRef)}`, 15000).catch(() => {});
  await P.ev(`(window.__abRelease?.(), true)`);
  await sleep(1500);
  const a1 = await countA(), o1 = await countO();
  ok(a1 === a0 && o1 === o0, "N10b: another notebook opened while the file was read: nothing saved, in either notebook's folder", { a0, a1, o0, o1 });

  // ---- N11: the notebook reloaded while an export prepares, now with an image at a path not referred to before: the
  //  export waits for that one too, and embeds it
  {
    const doc = await P.ev(`${NB}.snapshot()`);
    // (a file that exists, in the folder of the notebook shown now: only its own folder is ever followed (H1))
    const extraPath = `/Attachments/nb-${await P.ev(`${T}.ref()`)}/n11extra.png`;
    await P.ev(`${W}.create(${J(extraPath)}, { content: ${PNG_JS} }).then(() => true, () => true)`);
    const reloaded = { ...doc, cells: [...doc.cells, { id: "n11", type: "markdown", code: "![n](attachment:n11.png)", attachments: { "n11.png": { "sagebrush/file": extraPath } } }] };
    await P.ev(`${NB}.load(${J(doc)})`);
    await sleep(300);
    await P.ev(`${T}.holdReads()`);
    await P.ev(`(() => { window.__ex = null; ${T}.exportIpynb().then((t) => (window.__ex = t)); return true; })()`);
    await sleep(300);
    await P.ev(`(${NB}.load(${J(reloaded)}), true)`);
    await sleep(300);
    await P.ev(`(window.__imagesGo(), true)`);
    await P.until(`!!window.__ex`, 15000).catch(() => {});
    const ex11 = JSON.parse((await P.ev(`window.__ex`)) ?? "{}");
    const got11 = (ex11.cells ?? []).find((c) => c.id === "n11")?.attachments?.["n11.png"]?.["image/png"];
    ok(!!got11, "N11: reloaded during an export's preparation, with an image at a new path: the export waits for it and embeds it", ex11.cells?.find((c) => c.id === "n11"));
  }

  // ---- N6: an ill-formed reference: missing, never read
  await P.ev(`(() => { window.__reads = []; const w = ${W}; const r = w.read.bind(w); w.read = (p, ...a) => { window.__reads.push(p); return r(p, ...a); }; return true; })()`);
  await P.ev(`(() => { const c = ${NB}.addCell("![x](attachment:x.png)", null, false, "markdown"); c.attachments = { "x.png": { "sagebrush/file": "/private/notes.png" } }; ${NB}.run(c); return true; })()`);
  await sleep(800);
  const reads = await P.ev(`window.__reads`);
  const shown6 = await P.ev(`(() => { const cs = ${NB}.cells(); const c = cs[cs.length - 1]; return { img: !!c.md.querySelector("img"), text: c.md.textContent }; })()`);
  ok(!reads.some((p) => p.startsWith("/private")) && !shown6.img && /x/.test(shown6.text), "N6: an ill-formed reference: shown as missing (its alt text), never read", { reads, shown6 });
  // ---- N12 (H1): a reference into ANOTHER notebook's folder, or a chat's, is never read, shown or embedded: a saved
  //  notebook (as an agent or an edit could make it), its Download, and an import that brings such references
  const OTHER = "/Attachments/nb-someoneelse/secret.png", CHAT = "/Attachments/chat-x1/secret.png";
  for (const p of [OTHER, CHAT]) await P.ev(`${W}.create(${J(p)}, { content: ${PNG_JS} }).then(() => true, () => true)`);
  await P.ev(`(() => { window.__reads = []; return true; })()`);
  await P.ev(`(() => { const c = ${NB}.addCell("![o](attachment:o.png) ![c](attachment:c.png)", null, false, "markdown"); c.attachments = { "o.png": { "sagebrush/file": ${J(OTHER)} }, "c.png": { "sagebrush/file": ${J(CHAT)} } }; ${NB}.run(c); return true; })()`);
  await sleep(800);
  const shown12 = await P.ev(`(() => { const cs = ${NB}.cells(); const c = cs[cs.length - 1]; return { img: c.md.querySelectorAll("img").length, text: c.md.textContent }; })()`);
  const ex12 = JSON.parse(await P.ev(`${T}.exportIpynb()`));
  const cell12 = ex12.cells.find((c) => [].concat(c.source).join("").includes("attachment:o.png"));
  const reads12 = await P.ev(`window.__reads`);
  ok(shown12.img === 0 && !reads12.includes(OTHER) && !reads12.includes(CHAT), "N12: a notebook's reference into another notebook's folder, or a chat's: not shown, never read", { shown12, reads12 });
  ok(cell12 && !cell12.attachments?.["o.png"] && !cell12.attachments?.["c.png"] && !JSON.stringify(ex12).includes(b64(PNG).slice(0, 40) + "secret"), "N12: …and Download embeds neither (left out, as a missing one is)", cell12?.attachments);
  // (an import that brings references: removed, never followed, not even into its own new folder)
  const src12 = { cells: [{ cell_type: "markdown", id: "m12", metadata: {}, source: ["![o](attachment:o.png)"], attachments: { "o.png": { "sagebrush/file": OTHER } } }], metadata: {}, nbformat: 4, nbformat_minor: 5 };
  await P.ev(`(() => { window.__reads = []; return true; })()`);
  const r12 = await P.ev(`(async () => { const r = await ${T}.importIpynb("brings-refs.ipynb", ${J(J(src12))}); return r.made.map((e) => ({ path: e.path, ref: e.ref })); })()`);
  const doc12 = r12[0] && (await P.ev(`(async () => (await ${W}.read(${J(r12[0].path)})).content)()`));
  const reads12b = await P.ev(`window.__reads.filter((p) => p.startsWith("/Attachments/"))`);
  ok(r12[0] && !JSON.stringify(doc12?.cells?.[0]?.attachments ?? null).includes("sagebrush/file") && reads12b.length === 0, "N12: an imported .ipynb's own sagebrush/file references are removed on import, and nothing under /Attachments is read", { att: doc12?.cells?.[0]?.attachments, reads12b });
  ok(P.errors.length === 0, "no page errors", P.errors);
} catch (e) {
  ok(false, "the run threw: " + String(e?.stack ?? e).slice(0, 600));
} finally {
  await B.close();
  server?.kill();
}
console.log(failures ? `${failures} FAILED` : "test-notebook-images: all passed");
process.exit(failures ? 1 : 0);
