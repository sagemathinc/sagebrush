// ci: web-artifacts.1 order=51 runner=bun chrome
// An image pasted or dropped into the Agents page's composer (#1791 step 2), in the real page: saved in this browser's
// workspace in the chat's own folder, its path in that chat's draft; text pastes as before; the help line says the
// agent can see images only when its hello says workspace.image; and such an agent reads the saved file as an image.
//   SAGEBRUSH_AGENTS=1 bun web/build.ts && CHROME=google-chrome bun web/agents/test-agents-attach.mjs
import { spawn } from "node:child_process";
import { join } from "node:path";
import { startServe } from "../test-port.mjs";
import { browser, fakeAgent, pair } from "./a14-cases.mjs";

const here = new URL(".", import.meta.url).pathname;
let failures = 0;
const ok = (c, msg, detail) => { console.log((c ? "ok   " : "FAIL ") + msg + (!c && detail !== undefined ? "  " + JSON.stringify(detail).slice(0, 800) : "")); if (!c) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let server;
const sitePort = await startServe(() => (server = spawn("python3", [join(here, "..", "serve.py"), "0"], { stdio: ["ignore", "pipe", "pipe"] }))).port;
const site = `http://127.0.0.1:${sitePort}`;
const B = await browser();
const agents = [];
// (a PNG's signature, then 56 bytes: what each paste carries, made in the page)
const PNG_JS = `(() => { const u = new Uint8Array(64).fill(7); u.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); return u; })()`;
/** A paste (or a drop) on the composer's field: a PNG file, and `text` with it if given. */
const paste = (P, { text = "", files = 1, drop = false } = {}) => P.ev(`(() => {
  const dt = new DataTransfer();
  for (let i = 0; i < ${files}; i++) dt.items.add(new File([${PNG_JS}], "shot.png", { type: "image/png" }));
  if (${JSON.stringify(text)}) dt.setData("text/plain", ${JSON.stringify(text)});
  const at = document.querySelector('#editor textarea') ?? document.querySelector('#editor .mb-block');
  const e = ${drop} ? new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }) : new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true });
  at.dispatchEvent(e);
  return e.defaultPrevented;
})()`);
const draftOfChat = (P, id) => P.ev(`JSON.parse(localStorage.getItem('sagebrush-agents-drafts-v1') ?? '{}')[${JSON.stringify(id)}] ?? ''`);
const chatId = (P) => P.ev(`JSON.parse(localStorage.getItem('sagebrush-agents-preview-v1') ?? 'null')?.current ?? null`);
/** A new chat shown, its composer empty and written in: its id. */
const fresh = async (P, text = "") => { await P.ev(`(document.querySelector('#new').click(), true)`); await sleep(400); await P.draft(text); await sleep(400); return chatId(P); };
/** The chat's draft once it has `n` image lines (its draft as kept: what the composer holds, as Markdown). */
const lines = async (P, id, n, ms = 10000) => { const t = Date.now(); let d = ""; while (Date.now() - t < ms) { d = await draftOfChat(P, id); if (d.split("Image: `").length - 1 >= n) break; await sleep(50); } return d; };
const hint = (P) => P.ev(`document.querySelector('#attach-hint')?.textContent ?? null`);
/** The workspace's entry at `path` and its bytes, read beside the page (as another tab would). */
const saved = (P, path) => P.ev(`(async () => {
  const db = await new Promise((ok, no) => { const r = indexedDB.open("sagebrush-workspace"); r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); });
  const get = (store, k) => new Promise((ok, no) => { const r = db.transaction(store).objectStore(store).get(k); r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); });
  try { const e = await get("entries", ${JSON.stringify(path)}); if (!e) return null; const b = e.fid ? await get("fileBytes", e.fid) : null; return { kind: e.kind, size: e.size, bytes: b ? [...new Uint8Array(b instanceof Blob ? await b.arrayBuffer() : b)] : null }; } finally { db.close(); }
})()`);
const pathIn = (s) => /Image: `(\/Attachments\/[^`]+)`/.exec(s ?? "")?.[1] ?? null;
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...Array(56).fill(7)];
try {
  const P = await B.tab();
  await P.navigate(`${site}/agents/?speed=20`);
  await sleep(1500);

  // ---- T1: the help line, no agent
  ok((await hint(P)) === "Paste or drop an image to attach it.", "T1: one help line under the composer; no agent connected, nothing said about seeing images", await hint(P));

  // ---- T2: a paste of an image: saved in the chat's folder, the path in the draft
  const id = await fresh(P, "Look at this");
  const took = await paste(P);
  const c2 = await lines(P, id, 1), p2 = pathIn(c2);
  const s2 = p2 && (await saved(P, p2));
  ok(took && new RegExp(`^/Attachments/${id}/[0-9a-f]{24}\\.png$`).test(p2 ?? "") && /^Look at this\n\nImage: `[^`]+`$/.test(c2), "T2: a pasted image: its path in the chat's draft, after what was typed, in /Attachments/<this chat>/ under a random name", { c2, id });
  ok(s2 && s2.kind === "file" && s2.size === 64 && JSON.stringify(s2.bytes) === JSON.stringify(PNG), "T2: …saved in this browser's workspace with its own bytes", s2);
  await P.ev(`(document.activeElement?.blur(), true)`);
  await sleep(300);
  ok(/Image: \/Attachments\//.test(await P.ev(`document.querySelector('#editor').textContent`)) && (await P.ev(`document.querySelectorAll('#editor img, #log img').length`)) === 0 && (await P.ev(`performance.getEntriesByType('resource').filter((r) => r.name.includes('/Attachments/')).length`)) === 0, "T2: …shown in the composer as text (code): no image element, nothing fetched from its path");

  // ---- T3: a drop
  const took3 = await paste(P, { drop: true });
  const all3 = [...(await lines(P, id, 2)).matchAll(/Image: `([^`]+)`/g)].map((m) => m[1]);
  ok(took3 && all3.length === 2 && all3[0] === p2 && all3[1] !== p2 && (await saved(P, all3[1]))?.size === 64, "T3: a dropped image: saved under another name, its path added too", all3);

  // ---- T4: text and an image in one paste (a document's selection): the text pasted as before, the image attached
  const id4 = await fresh(P);
  await paste(P, { text: "from a doc" });
  const c4 = await lines(P, id4, 1);
  ok(/^from a doc\n\nImage: `\/Attachments\//.test(c4), "T4: a paste of text with an image: the text pasted as before (the editor's own paste), the image's path after it", c4);

  // ---- T5: text alone pastes as before, nothing attached
  const id5 = await fresh(P);
  const took5 = await paste(P, { text: "just words", files: 0 });
  await sleep(800);
  ok((await draftOfChat(P, id5)) === "just words" && took5 === true, "T5: a paste of text alone: pasted as before, nothing attached", await draftOfChat(P, id5));

  // ---- T6: a paste that isn't an image: nothing saved, said
  await P.ev(`(() => { const dt = new DataTransfer(); dt.items.add(new File(["<svg/>"], "a.svg", { type: "image/svg+xml" })); document.querySelector('#editor textarea').dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true })); return true; })()`);
  await sleep(800);
  ok((await draftOfChat(P, id5)) === "just words" && /Only PNG, JPEG, GIF and WebP/.test(await P.ev(`document.querySelector('#toast')?.textContent ?? ''`)), "T6: an SVG pasted: not attached, and said why");

  // ---- T7: the image's path goes to the chat it was pasted in, even if another is shown by the time it is saved
  const a = await fresh(P, "for chat A");
  await P.ev(`(() => { window.__release = null; navigator.locks.request("sagebrush-workspace", { mode: "exclusive" }, () => new Promise((r) => (window.__release = r))); return true; })()`);
  await P.until(`typeof window.__release === "function"`);
  await paste(P);
  await sleep(300);
  const b = await fresh(P, "for chat B");
  await P.ev(`(window.__release(), true)`);
  const dA = await lines(P, a, 1);
  await sleep(800);
  const dB = await draftOfChat(P, b), shownB = await P.ev(`document.querySelector('#editor textarea')?.value ?? ''`);
  ok(a !== b && /^for chat A\n\nImage: `\/Attachments\//.test(dA) && (pathIn(dA) ?? "").startsWith(`/Attachments/${a}/`) && dB === "for chat B" && shownB === "for chat B", "T7: pasted in chat A, saved after chat B is shown: the path goes to A's draft, in A's folder; B's untouched", { a, b, dA, dB, shownB });

  // ---- T10: a name that's taken (the same random name twice): the workspace's create refuses it, the first file's
  //  bytes stay, nothing more goes in the draft, and the reason is said in the page's words
  const id10 = await fresh(P, "keep  ");
  await P.ev(`(() => { window.__grv = crypto.getRandomValues.bind(crypto); crypto.getRandomValues = (a) => (a.length === 12 ? a.fill(0xab) : window.__grv(a)); return true; })()`);
  await paste(P);
  const d10a = await lines(P, id10, 1);
  const p10 = pathIn(d10a);
  await P.ev(`(() => { const dt = new DataTransfer(); const u = new Uint8Array(64).fill(9); u.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); dt.items.add(new File([u], "b.png", { type: "image/png" })); (document.querySelector('#editor textarea') ?? document.querySelector('#editor .mb-block')).dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true })); return true; })()`);
  await P.until(`/already there/.test(document.querySelector('#toast')?.textContent ?? '')`, 10000).catch(() => {});
  await P.ev(`(crypto.getRandomValues = window.__grv, true)`);
  const t10 = await P.ev(`document.querySelector('#toast')?.textContent ?? ''`);
  await sleep(500);
  const d10b = await draftOfChat(P, id10), s10 = p10 && (await saved(P, p10));
  ok(p10 === `/Attachments/${id10}/${"ab".repeat(12)}.png` && t10 === "The image wasn't saved: a file with its name is already there." && d10b === d10a && s10 && JSON.stringify(s10.bytes) === JSON.stringify(PNG), "T10: a second image at a taken name: refused by the workspace, the first file's bytes kept, the draft unchanged, said in the page's words", { p10, t10, d10a, d10b });
  ok(d10a.startsWith("keep  \n\nImage: `"), "T10: what was typed is kept as it is, its spaces too, the image's line after it", d10a);

  // ---- T11: typing on in the same chat while the image is saved: what is typed stays, the path after it
  const id11 = await fresh(P, "before");
  await P.ev(`(() => { window.__release = null; navigator.locks.request("sagebrush-workspace", { mode: "exclusive" }, () => new Promise((r) => (window.__release = r))); return true; })()`);
  await P.until(`typeof window.__release === "function"`);
  await paste(P);
  await sleep(300);
  await P.ev(`document.querySelector('#editor textarea').focus()`);
  await P.send("Input.insertText", { text: " and after" });
  await sleep(500);
  await P.ev(`(window.__release(), true)`);
  const d11 = await lines(P, id11, 1);
  ok(/^before and after\n\nImage: `\/Attachments\//.test(d11), "T11: typing on while the image is saved: all of it kept, the image's path after it", d11);

  // ---- T12: the workspace's own limit (a folder of 10,000 entries): the attachment is refused by it, nothing added
  const id12 = await fresh(P, "full");
  const filled = await P.ev(`(async () => {
    const db = await new Promise((ok, no) => { const r = indexedDB.open("sagebrush-workspace"); r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); });
    try { await new Promise((ok, no) => { const t = db.transaction("entries", "readwrite"), st = t.objectStore("entries"); for (let i = 0; i < 10000; i++) st.put({ path: "/Attachments/${id12}/f" + i, kind: "file", created: 1, updated: 1, size: 0, fid: "x" + i }); t.oncomplete = ok; t.onerror = () => no(t.error); }); return true; } finally { db.close(); }
  })()`, {}, 60000);
  await paste(P);
  await P.until(`/limits/.test(document.querySelector('#toast')?.textContent ?? '')`, 15000).catch(() => {});
  const t12 = await P.ev(`document.querySelector('#toast')?.textContent ?? ''`);
  await sleep(500);
  const n12 = await P.ev(`(async () => { const db = await new Promise((ok) => { const r = indexedDB.open("sagebrush-workspace"); r.onsuccess = () => ok(r.result); }); try { return await new Promise((ok) => { const r = db.transaction("entries").objectStore("entries").count(IDBKeyRange.bound("/Attachments/${id12}/", "/Attachments/${id12}/\\uffff")); r.onsuccess = () => ok(r.result); }); } finally { db.close(); } })()`);
  ok(filled && t12 === "The image wasn't saved: the workspace is at one of its limits." && n12 === 10000 && (await draftOfChat(P, id12)) === "full", "T12: a folder the workspace says is full: the image refused by its limit, nothing saved, the draft unchanged", { t12, n12 });

  // ---- T8: an agent that takes images: the help line says so, and it reads the pasted file as an image
  const A = fakeAgent({ features: ["workspace.image"] });
  agents.push(A);
  const Q = await B.tab();
  await pair(Q, A, site, "page");
  await sleep(500);
  ok((await hint(Q)) === "Paste or drop an image to attach it. Claude can see images.", "T8: an agent whose hello says workspace.image: the help line says it can see images", await hint(Q));
  const q = await fresh(Q);
  await paste(Q);
  const p8 = pathIn(await lines(Q, q, 1));
  const r8 = p8 ? await A.call("workspace.read", { path: p8 }) : null;
  ok(r8?.result && Object.keys(r8.result).sort().join() === "entry,image,rev" && JSON.stringify([...Buffer.from(r8.result.image.base64, "base64")]) === JSON.stringify(PNG), "T8: …and its workspace.read of the pasted path gets the image ({entry, rev, image}) with the pasted bytes", r8 && { keys: Object.keys(r8.result ?? r8.error ?? {}), err: r8.error?.data });

  // ---- T9: an agent that doesn't: nothing said about seeing images
  const A2 = fakeAgent();
  agents.push(A2);
  const R = await B.tab();
  await pair(R, A2, site, "page");
  await sleep(500);
  ok((await hint(R)) === "Paste or drop an image to attach it.", "T9: an agent that didn't say workspace.image: the help line doesn't say it can see images", await hint(R));
  ok([P, Q, R].every((t) => t.errors.length === 0), "no page errors", [P, Q, R].map((t) => t.errors));
} catch (e) {
  ok(false, "the run threw: " + (e?.stack ?? e).toString().slice(0, 600));
} finally {
  for (const A of agents) A.stop();
  await B.close();
  server?.kill();
}
console.log(failures ? `${failures} FAILED` : "test-agents-attach: all passed");
process.exit(failures ? 1 : 0);
