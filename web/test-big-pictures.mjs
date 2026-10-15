// Pictures whose headers say they are huge (image-size.ts) in headless Chrome:
// a notebook output over the bounds shows a placeholder ("Show it" shows it),
// is saved as it was, and a document's pictures stop at 80 MP in all; a
// Markdown cell shows a huge data: picture as its alt text; a board doesn't
// take in a huge picture it carries.  Serve web/dist first (python3
// web/serve.py 8765), then   node web/test-big-pictures.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const base = process.env.SB_URL ?? "http://127.0.0.1:8765/";
const port = +(process.env.CDP_PORT ?? 9466), sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = mkdtempSync(join(tmpdir(), "sb-bigpic-"));
const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", `--remote-debugging-port=${port}`, "--window-size=1280,900", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
let targets;
for (let i = 0; i < 300; i++) { try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); break; } catch { await sleep(100); } }
const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let n = 0; const waiting = new Map(); const errors = [];
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result ?? m.error); waiting.delete(m.id); }
  if (m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails?.exception?.description ?? JSON.stringify(m.params.exceptionDetails));
};
const send = (method, params = {}) => new Promise((r) => { const id = ++n; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (expression) => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400)); return r.result?.value; };
const until = async (expr, ms = 30000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(expr).catch(() => false)) return true; await sleep(50); } return false; };
const fails = [];
let checks = 0;
const check = (ok, what) => { checks++; if (!ok) fails.push(what); };

// pictures' headers: a real 1 x 1 PNG's bytes, its size in the header changed
const real = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const png = (w, h) => { const b = Buffer.from(real); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20); return b.toString("base64"); };
const out = (b64, text) => [{ output_type: "display_data", data: { "image/png": b64, "text/plain": text }, metadata: {} }];

try {
  for (const m of ["Page.enable", "Runtime.enable"]) await send(m);
  await send("Page.navigate", { url: base });
  check(await until("!!window.sagebrush?.notebook?.cells", 60000), "the notebook page");
  // (after the page has shown its own notebook, which would replace ours)
  await until("sagebrush.notebook.cells().length > 0", 30000);
  await sleep(1500);
  const doc = { mode: "python", cells: [
    { id: "huge", code: "", outputs: out(png(8192, 8192), "huge") },
    { id: "ok", code: "", outputs: out(real.toString("base64"), "small") },
    { id: "p1", code: "", outputs: out(png(6000, 5000), "thirty MP") },
    { id: "p2", code: "", outputs: out(png(6001, 5000), "thirty MP more") },
    { id: "p3", code: "", outputs: out(png(6002, 5000), "past eighty") },
    { id: "md", type: "markdown", code: `![a huge one](data:image/png;base64,${png(9000, 9000)}) and ![a small one](data:image/png;base64,${real.toString("base64")})` },
  ] };
  await ev(`sagebrush.notebook.load(${JSON.stringify(doc)}), 1`);
  const C = (id) => `sagebrush.notebook.cells().find((c) => c.id === ${JSON.stringify(id)})`;
  await until(`!!${C("huge")}?.out.querySelector('.big-picture, img')`, 10000);
  const shown = await ev(`Object.fromEntries(["huge", "ok", "p1", "p2", "p3"].map((id) => { const o = ${C("ID")}.out; return [id, { img: !!o.querySelector("img"), placeholder: o.querySelector(".big-picture")?.textContent ?? null }]; }))`.replace('"ID"', "id"));
  check(!shown.huge.img && /8192 × 8192 pixels/.test(shown.huge.placeholder ?? ""), "a picture whose header says 8192 x 8192: a placeholder saying why: " + JSON.stringify(shown.huge));
  check(shown.ok.img && !shown.ok.placeholder, "a small one: shown");
  check(shown.p1.img && shown.p2.img && !shown.p3.img && /in all/.test(shown.p3.placeholder ?? ""), "30 MP pictures: two shown, the third past 80 MP in all not: " + JSON.stringify([shown.p1, shown.p2, shown.p3]));
  // saved as it was
  const saved = await ev(`JSON.stringify(sagebrush.notebook.snapshot().cells.find((c) => c.id === "huge").outputs)`);
  check(saved.includes(png(8192, 8192)) && saved.includes('"huge"'), "the placeholder's picture is saved as it was");
  // Show it: the picture, on request
  await ev(`${C("huge")}.out.querySelector(".big-picture button").click(), 1`);
  check(await ev(`!!${C("huge")}.out.querySelector("img") && !${C("huge")}.out.querySelector(".big-picture")`), "Show it shows it");
  // Markdown: the huge one as its alt text, the small one shown
  await ev(`sagebrush.notebook.renderMd(${C("md")}), 1`);
  await until(`!!${C("md")}.el.querySelector(".mdout img")`, 5000);
  const md = await ev(`(() => { const el = ${C("md")}.el.querySelector(".mdout"); return { imgs: el.querySelectorAll("img").length, text: el.textContent }; })()`);
  check(md.imgs === 1 && /a huge one/.test(md.text), "Markdown: the huge data: picture as its alt text, the small one shown: " + JSON.stringify(md));

  // a second document: its pictures counted afresh, and with them its
  // Markdown's, HTML's and SVGs' (SEC-89C-2, -3); a GIF's frames (SEC-89C-1)
  const gifBig = Buffer.from([...Buffer.from("GIF89a"), 1, 0, 1, 0, 0, 0, 0, 0x2c, 0, 0, 0, 0, 0x28, 0x23, 0x88, 0x13, 0, 2, 2, 0x4c, 0x01, 0, 0x3b]).toString("base64");
  const svgWith = (b64) => `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><image href="data:image/png;base64,${b64}" width="10" height="10"/><circle cx="5" cy="5" r="3"/></svg>`;
  const doc2 = { mode: "python", cells: [
    { id: "gif", type: "markdown", code: `![a big frame](data:image/gif;base64,${gifBig})` },
    { id: "svg", code: "", outputs: [{ output_type: "display_data", data: { "image/svg+xml": svgWith(png(8192, 8192)), "text/plain": "an svg" }, metadata: {} }] },
    { id: "md3", type: "markdown", code: [6000, 6001, 6002].map((w, i) => `![p${i}](data:image/png;base64,${png(w, 5000)})`).join(" ") },
    { id: "mdsvg", type: "markdown", code: `![carried](data:image/svg+xml;base64,${Buffer.from(svgWith(real.toString("base64"))).toString("base64")}) ![plain](data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><circle r="2"/></svg>').toString("base64")})` },
  ] };
  await ev(`sagebrush.notebook.load(${JSON.stringify(doc2)}), 1`);
  await until(`!!${C("svg")}?.out.querySelector('svg')`, 10000);
  await ev(`sagebrush.notebook.renderMd(${C("gif")}), 1`);
  check(await ev(`!${C("gif")}.el.querySelector(".mdout img") && /a big frame/.test(${C("gif")}.el.querySelector(".mdout").textContent)`), "a GIF whose frame is larger than its screen: not shown, its frame's size counts (SEC-89C-1)");
  check(await ev(`(() => { const s = ${C("svg")}.out.querySelector("svg"); return !!s && !s.querySelector("image") && !!s.querySelector("circle"); })()`), "an SVG output's huge inline raster is dropped, its vectors kept (SEC-89C-3)");
  for (const id of ["md3", "mdsvg"]) await ev(`sagebrush.notebook.renderMd(${C(id)}), 1`);
  await until(`!!${C("md3")}.el.querySelector(".mdout img")`, 5000);
  const md3 = await ev(`${C("md3")}.el.querySelectorAll(".mdout img").length`);
  await ev(`sagebrush.notebook.renderMd(${C("md3")}), 1`);
  await sleep(200);
  const md3again = await ev(`${C("md3")}.el.querySelectorAll(".mdout img").length`);
  check(md3 === 2 && md3again === 2, "Markdown's pictures count in the document's pixels: two of three 30 MP shown, the same two when drawn again (SEC-89C-2): " + [md3, md3again]);
  const mdsvg = await ev(`[...${C("mdsvg")}.el.querySelectorAll(".mdout img")].map((i) => i.alt).join()`);
  check(mdsvg === "", "no data: SVG picture in Markdown (it could carry rasters, SEC-71A-3): " + mdsvg);

  // remote pictures: in a document from elsewhere, each shown when clicked;
  // in one written here (a new notebook), at once (William: click-to-load)
  const remoteMd = "![a remote one](https://pictures.invalid/r.png)";
  await ev(`sagebrush.notebook.load(${JSON.stringify({ mode: "python", cells: [{ id: "rm", type: "markdown", code: remoteMd }] })}), 1`);
  await ev(`sagebrush.notebook.renderMd(${C("rm")}), 1`);
  check(await ev(`(() => { const el = ${C("rm")}.el.querySelector(".mdout"); const b = el.querySelector("button.remote-picture"); return !!b && !el.querySelector("img") && /pictures\.invalid/.test(b.textContent); })()`), "a notebook from elsewhere: its remote picture is a button naming the site");
  await ev(`${C("rm")}.el.querySelector(".mdout button.remote-picture").click(), 1`);
  check(await ev(`(() => { const i = ${C("rm")}.el.querySelector(".mdout img"); return !!i && i.src === "https://pictures.invalid/r.png" && i.alt === "a remote one"; })()`), "...clicked, the picture");
  await ev(`sagebrush.notebook.load(${JSON.stringify({ mode: "python", here: true, cells: [{ id: "rm", type: "markdown", code: remoteMd }] })}), 1`);
  await ev(`sagebrush.notebook.renderMd(${C("rm")}), 1`);
  check(await ev(`!!${C("rm")}.el.querySelector(".mdout img") && !${C("rm")}.el.querySelector("button.remote-picture")`), "a notebook written here: its remote picture at once");

  // a board's code: each board's pictures counted afresh (CORR-89C-4)
  await send("Page.navigate", { url: `${base}board/?doc=${encodeURIComponent("examples/live.json")}` });
  await until("window.sagebrush?.board?.snapshot().items.length > 0", 60000);
  const show30 = (w) => `from IPython.display import Image, display\nimport base64\ndisplay(Image(data=base64.b64decode(${JSON.stringify(png(w, 5000))})))`;
  await ev(`window.sagebrush.board.load(${JSON.stringify({ title: "A", nodes: [{ id: "a1", code: show30(6000) }, { id: "a2", code: show30(6001) }] })}).then(() => 1)`);
  await until("window.sagebrush.board.outputs().then((os) => os.length === 2 && os.every((o) => o.state === ''))", 60000);
  // (board B reuses an item's id of A's: still another document, CORR-71A-2)
  await ev(`window.sagebrush.board.load(${JSON.stringify({ title: "B", nodes: [{ id: "a1", code: show30(6002) }] })}).then(() => 1)`);
  await until("window.sagebrush.board.outputs().then((os) => os.length === 1 && os[0].id === 'a1' && os[0].state === '' && os[0].code.includes('Image'))", 60000);
  await sleep(500);
  await ev("window.board.focus(['a1'], true), window.board.render(), 1");
  check(await until("!!document.querySelector('[data-code=a1] .board-code-out img') && !document.querySelector('[data-code=a1] .big-picture')", 10000), "board B's picture shows, though it reuses an id of A's: its own document's pixels, not board A's");

  // board C keeps an item of B's as it was (its output kept, not run again)
  // and adds two 30 MP pictures in notes: all three in its pixels (SEC-4DF-1)
  await ev(`window.sagebrush.board.load(${JSON.stringify({ title: "C", nodes: [{ id: "a1", code: show30(6002) }, { id: "n1", text: `![n1](data:image/png;base64,${png(6003, 5000)})` }, { id: "n2", text: `![n2](data:image/png;base64,${png(6004, 5000)})` }] })}).then(() => 1)`);
  await sleep(1500);
  await ev("window.board.focus(undefined, true), window.board.render(), 1");
  await sleep(300);
  const shownC = await ev("document.querySelectorAll('.board-item img[src^=\"data:image/png\"]').length");
  check(shownC === 2, "board C: of its three 30 MP pictures (one an output kept from B), two shown: " + shownC);

  // a picture kept from the last board, its type in capitals (an HTML
  // output's data:IMAGE/PNG): counted again all the same (SEC-A48-1)
  const html30 = (w) => `from IPython.display import HTML, display\ndisplay(HTML('<img src="data:IMAGE/PNG;base64,${png(w, 5000)}">'))`;
  await ev(`window.sagebrush.board.load(${JSON.stringify({ title: "D", nodes: [{ id: "h", code: html30(6005) }] })}).then(() => 1)`);
  await until("window.sagebrush.board.outputs().then((os) => os.length === 1 && os[0].state === '')", 60000);
  await ev("window.board.focus(['h'], true), window.board.render(), 1");
  check(await until("!!document.querySelector('[data-code=h] .board-code-out img[src^=\"data:IMAGE/PNG\"]')", 10000), "board D shows its HTML output's data:IMAGE/PNG picture");
  await ev(`window.sagebrush.board.load(${JSON.stringify({ title: "E", nodes: [{ id: "h", code: html30(6005) }, { id: "n6", text: `![n6](data:image/png;base64,${png(6006, 5000)})` }, { id: "n7", text: `![n7](data:image/png;base64,${png(6007, 5000)})` }] })}).then(() => 1)`);
  await sleep(1500);
  await ev("window.board.focus(undefined, true), window.board.render(), 1");
  await sleep(300);
  const shownE = await ev("document.querySelectorAll('.board-item img[src^=\"data:image/png\" i]').length");
  check(shownE === 2, "board E: of its three 30 MP pictures (one kept from D, IMAGE/PNG), two shown: " + shownE);
  // a small held preview after a board whose pictures nearly filled its budget: shown (CORR-A48-2)
  await ev(`window.sagebrush.board.load(${JSON.stringify({ title: "F", nodes: [{ id: "f1", code: show30(7950) }, { id: "f2", code: show30(7951) }] })}).then(() => 1)`);
  await until("window.sagebrush.board.outputs().then((os) => os.length === 2 && os.every((o) => o.state === ''))", 60000);
  const smallPreview = { at: "2026-10-14T00:00:00.000Z", ms: 12000, total: 12000, outputs: [{ output_type: "display_data", data: { "image/png": png(640, 1280), "text/plain": "small" }, metadata: {} }] };
  await ev(`window.sagebrush.board.load(${JSON.stringify({ title: "G", nodes: [{ id: "g1", code: "print('slow')", preview: smallPreview }] })}).then(() => 1)`);
  await sleep(1000);
  await ev("window.board.focus(['g1'], true), window.board.render(), 1");
  check(await until("!!document.querySelector('[data-code=g1] .board-code-out img') && !document.querySelector('[data-code=g1] .big-picture')", 10000), "board G's small preview shows, in its own pixels, not board F's");

  // a board from elsewhere: its notes' remote pictures shown when clicked; a new board's, at once
  await ev(`window.sagebrush.board.load(${JSON.stringify({ title: "remote", nodes: [{ id: "r", title: "remote", text: remoteMd }] })}).then(() => 1)`);
  await ev("window.board.focus(['r'], true), window.board.render(), 1");
  check(await until("!!document.querySelector('[data-id=r] button.remote-picture, .board-item button.remote-picture') && !document.querySelector('.board-item img[src^=\"https://pictures\"]')", 5000), "a board from elsewhere: its note's remote picture is a button");
  await ev("document.querySelector('.board-item button.remote-picture').click(), 1");
  check(await until("!!document.querySelector('.board-item img[src=\"https://pictures.invalid/r.png\"]')", 5000), "...clicked, the picture");
  await ev("document.querySelector('[data-sbb=newboard]').click(), 1");
  await sleep(300);
  await ev(`window.sagebrush.board.edit((d) => { d.nodes = [{ id: "n", title: "mine", text: ${JSON.stringify(remoteMd)} }]; }).then(() => 1)`);
  await ev("window.board.focus(['n'], true), window.board.render(), 1");
  check(await until("!!document.querySelector('.board-item img[src=\"https://pictures.invalid/r.png\"]') && !document.querySelector('.board-item button.remote-picture')", 5000), "a new board, written here: its note's remote picture at once");

  // a board carrying a picture whose type is in capitals: taken in and shown (CORR-68B-1)
  await ev(`window.sagebrush.board.load(${JSON.stringify({ title: "caps", images: { p: { w: 1, h: 1, src: "data:IMAGE/PNG;base64," + real.toString("base64") } }, nodes: [{ id: "cp", title: "caps", image: "p" }] })}).then(() => 1)`);
  const capsDoc = JSON.parse(await ev("window.sagebrush.board.json()"));
  check(Object.keys(capsDoc.images ?? {}).length === 1 && capsDoc.nodes[0].image === Object.keys(capsDoc.images)[0], "a board's data:IMAGE/PNG picture is taken in: " + JSON.stringify([Object.keys(capsDoc.images ?? {}), capsDoc.nodes[0].image]));

  // a picture whose scheme is in capitals (DATA:, Data:) is checked all the
  // same: one past the bounds isn't taken in, nor shown (SEC-1D8-1)
  await ev(`window.sagebrush.board.load(${JSON.stringify({ title: "scheme", images: { u: { w: 8193, h: 1, src: "DATA:image/png;base64," + png(8193, 1) }, m: { w: 8193, h: 1, src: "Data:IMAGE/PNG;base64," + png(8194, 1) }, ok: { w: 1, h: 1, src: "DATA:image/png;base64," + real.toString("base64") } }, nodes: [{ id: "su", title: "u", image: "u" }, { id: "sm", title: "m", image: "m" }, { id: "so", title: "ok", image: "ok" }] })}).then(() => 1)`);
  const schemeDoc = JSON.parse(await ev("window.sagebrush.board.json()"));
  const keptScheme = Object.entries(schemeDoc.images ?? {});
  check(keptScheme.length === 1 && !keptScheme.some(([, v]) => /^data:/i.test(v.src ?? "") && v.w > 8192) && !(await ev("[...document.querySelectorAll('.board-item img')].some((i) => /^data:/i.test(i.getAttribute('src') ?? '') && i.naturalWidth > 8192)")), "a DATA: or Data: picture past the bounds is not taken in, a small one is: " + JSON.stringify(keptScheme.map(([k, v]) => [k, v.w, (v.src ?? "").slice(0, 12)])));

  // a board carrying a huge picture doesn't take it in; a small one, it does
  await send("Page.navigate", { url: `${base}board/?doc=${encodeURIComponent("examples/live.json")}` });
  await until("window.sagebrush?.board?.snapshot().items.length > 0", 60000);
  const board = { title: "pictures", images: { big: { w: 100, h: 100, src: "data:image/png;base64," + png(20000, 20000) }, small: { w: 1, h: 1, src: "data:image/png;base64," + real.toString("base64") } },
    nodes: [{ id: "a", image: "big", title: "big" }, { id: "b", image: "small", title: "small" }] };
  await ev(`window.sagebrush.board.load(${JSON.stringify(board)}).then(() => 1)`);
  const kept = JSON.parse(await ev("window.sagebrush.board.json()"));
  const names = Object.keys(kept.images ?? {});
  check(names.length === 1 && kept.nodes.find((x) => x.id === "b").image === names[0], "a board takes in the small picture, not the huge one: " + JSON.stringify(names));
  check(!errors.length, "no exceptions: " + errors.join(" | ").slice(0, 300));
} catch (e) {
  fails.push(String(e?.stack ?? e));
} finally {
  chrome.kill();
  await sleep(200);
  rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
if (fails.length) {
  console.log(`${fails.length} of ${checks} checks failed:\n  ` + fails.join("\n  "));
  process.exit(1);
}
console.log(`${checks}/${checks} checks passed`);
