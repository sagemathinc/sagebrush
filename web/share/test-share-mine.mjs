// ci: web-sync.2 order=59 chrome
// Your shares (File ▸ Your shares…, and the Share dialog's footer), end to end in headless Chromium against the share API
// in Miniflare (web/share/serve-dev.mjs) and web/dist:
//   1. File has Your shares… right under Share…; signed out, the dialog asks to sign in (board's line);
//   2. signed in with none: the empty line;
//   3. two shares (one with a second version): listed newest first, each "published"/"updated" with its date; opened
//      from the Share dialog's footer too;
//   4. Copy link copies the share's link and reads Copied; Open opens it in a new tab;
//   5. Delete asks first (board's line); Keep it keeps it; Delete discards it (its page answers 404, the list loses it);
//   6. a delete the server refuses (the share already gone): board's line, the row kept;
//   7. the list can't be loaded: board's line;
//   8. a share with no version yet isn't listed;
//   9. a failed delete's line goes when a later delete succeeds; after the last, "You have no shares now.";
//  10. the sign-in check gets no answer: board's line for that;
//  11. the Share dialog's footer while an upload is under way: Your shares opens over it, the upload's dialog stays;
//  12. the CLI's local page: no Your shares in File.
//   bun web/build.ts && node web/share/test-share-mine.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDev } from "./serve-dev.mjs";
import { devtoolsPort } from "../test-port.mjs";

const A = "77777777-7777-4777-8777-777777777777";
// (ports 0: startDev's servers take the system's choice and hold it, web/share/serve-dev.mjs)
const dev = await startDev({ sitePort: 0, filesPort: 0, limits: { [A]: { tier: "dev", storage_bytes: 1e8, max_file_bytes: 1e7, private_links: false } } });
const profile = mkdtempSync(join(tmpdir(), "sb-mine-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", "--disable-gpu", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
const cdpPort = await devtoolsPort(profile);
let targets;
for (let i = 0; i < 300; i++) { try { targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json(); break; } catch { await sleep(100); } }
const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let n = 0;
const waiting = new Map();
let route = null;
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result ?? m.error); waiting.delete(m.id); } if (m.method === "Fetch.requestPaused") void (route ? route(m.params) : send("Fetch.continueRequest", { requestId: m.params.requestId })); };
const send = (method, params = {}) => new Promise((r) => { const id = ++n; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (expression) => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400)); return r.result?.value; };
const until = async (expr, ms = 30000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(expr).catch(() => false)) return true; await sleep(100); } throw new Error("timeout: " + expr); };
let failures = 0;
const ok = (c, msg) => { console.log((c ? "ok   " : "FAIL ") + msg); if (!c) failures++; };
const J = JSON.stringify;
const MINE = {
  empty: "You haven't shared anything yet.",
  signIn: "Sign in with CoCalc to see your shares.",
  cantLoad: "Couldn't load your shares. Try again in a moment.",
  deleteFailed: "Couldn't delete it. Try again in a moment.",
  none: "You have no shares now.",
  unreachable: "Couldn't reach the server to check your sign-in. Try again in a moment.",
  confirm: (t) => `Delete “${t}”? Its links stop working for everyone, and this can't be undone. Copies people already made stay theirs.`,
};
const status = () => ev("document.querySelector('#sbminedlg [role=status]')?.textContent ?? null");
const rows = () => ev("[...document.querySelectorAll('#sbminedlg .row')].map((r) => ({ id: r.dataset.id, text: r.textContent, buttons: [...r.querySelectorAll('button')].map((b) => b.textContent) }))");
const press = (id, label) => ev(`(() => { const b = [...document.querySelector('#sbminedlg .row[data-id="${id}"]').querySelectorAll('button')].find((x) => x.textContent === ${J(label)}); b.click(); return 1; })()`);
const ready = () => until("(() => { const s = document.querySelector('#sbminedlg [role=status]'); return !!s && !/^Checking/.test(s.textContent); })()", 30000);
const openFromMenu = async () => {
  await ev("(() => { document.querySelector('#sbminedlg')?.close(); const b = document.querySelector('#filemenu [data-f=\"mine\"]'); b.click(); return 1; })()");
  await until("document.querySelector('#sbminedlg')?.open");
  await ready();
};
// (a share made through the API: its files, a first upload, then any later versions; its id)
const makeShare = (title, versions = 1) => ev(`(async () => {
  const b = new TextEncoder().encode(JSON.stringify({ nbformat: 4, nbformat_minor: 5, metadata: {}, cells: [] })), sha = [...new Uint8Array(await crypto.subtle.digest("SHA-256", b))].map((x) => x.toString(16).padStart(2, "0")).join("");
  await fetch("/api/share/blob/" + sha, { method: "PUT", body: b });
  const files = [{ path: "nb.ipynb", sha256: sha, size: b.length }];
  const attempt = [...crypto.getRandomValues(new Uint8Array(16))].map((x) => x.toString(16).padStart(2, "0")).join("");
  const r = await (await fetch("/api/share/first-upload", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: ${J(title)}, files, attempt }) })).json();
  const id = r.collection;
  // (a later version, a second on: the server keeps times in seconds)
  for (let v = 1; v < ${versions}; v++) await new Promise((r) => setTimeout(r, 1100)), await fetch("/api/share/collections/" + id + "/versions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: ${J(title)}, files }) });
  return id;
})()`);
const today = new Date().toISOString().slice(0, 10);

try {
  await send("Page.navigate", { url: dev.site + "/" });
  await until("document.querySelector('#status')?.textContent.startsWith('ready')", 90000);
  // ---- 1. the menu; signed out
  const items = await ev("[...document.querySelectorAll('#filemenu [data-f]')].filter((b) => !b.hidden).map((b) => b.dataset.f)");
  ok(items.indexOf("mine") === items.indexOf("share") + 1 && (await ev("document.querySelector('#filemenu [data-f=\"mine\"]').textContent")) === "Your shares…", "File has Your shares… right under Share… (" + J(items) + ")");
  await openFromMenu();
  ok((await status()) === MINE.signIn && (await ev("document.querySelector('#sbminedlg a.btn')?.textContent")) === "Sign in with CoCalc", "signed out: board's line, and Sign in with CoCalc");
  ok((await ev(`fetch('/auth/dev', { method: 'POST', headers: {'content-type': 'application/json'}, body: ${J(J({ token: "dev-token", account_id: A }))} }).then((r) => r.status)`)) === 200, "(signs in: dev)");

  // ---- 2. none yet
  await openFromMenu();
  ok((await status()) === MINE.empty && (await rows()).length === 0, "no shares: board's empty line");

  // ---- 3. two shares, newest first; the Share dialog's footer opens it too
  const alpha = await makeShare("Alpha");
  await sleep(1100);
  const beta = await makeShare("Beta", 2);
  await ev("(() => { document.querySelector('#sbminedlg')?.close(); document.querySelector('#sharemenu').click(); return 1; })()");
  await until("document.querySelector('#sharedlg').open && !!document.querySelector('#sharemine')");
  ok((await ev("document.querySelector('#sharemine').textContent")) === "Your shares", "the Share dialog's footer has Your shares");
  await ev("(document.querySelector('#sharemine').click(), true)");
  await until("document.querySelector('#sbminedlg')?.open");
  await ready();
  ok(!(await ev("document.querySelector('#sharedlg').open")), "…which opens Your shares in place of the Share dialog");
  const r3 = await rows();
  ok(J(r3.map((r) => r.id)) === J([beta, alpha]), "the shares, newest first (" + J(r3.map((r) => r.id)) + ")");
  ok(r3[0].text.includes("Beta") && r3[0].text.includes(`updated ${today}`) && r3[1].text.includes("Alpha") && r3[1].text.includes(`published ${today}`), "each with its title, \"published\" or \"updated\", and its date (" + J(r3.map((r) => r.text)) + ")");
  ok(J(r3[0].buttons) === J(["Versions", "Copy link", "Open", "Delete"]) && (await ev(`[...document.querySelector('#sbminedlg .row[data-id="${beta}"]').querySelectorAll('button')].find((b) => b.textContent === 'Open').title`)) === "Open in a new tab", "…and Copy link, Open (in a new tab), Delete");

  // ---- 4. Copy link, Open
  // (headless: a clipboard write needs the page focused, and the permission)
  await send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await send("Browser.grantPermissions", { permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"], origin: dev.site });
  await press(beta, "Copy link");
  await until(`[...document.querySelector('#sbminedlg .row[data-id="${beta}"]').querySelectorAll('button')].some((b) => b.textContent === 'Copied')`, 10000);
  ok((await ev("navigator.clipboard.readText()")) === `${dev.site}/s/${beta}`, "Copy link copies the share's link, and reads Copied");
  await ev("(window.__opened = [], window.open = (...a) => (window.__opened.push(a), null), true)");
  await press(alpha, "Open");
  ok(J(await ev("window.__opened")) === J([[`${dev.site}/s/${alpha}`, "_blank", "noopener"]]), "Open opens the share's page in a new tab");

  // ---- 5. Delete: asked first; Keep it; Delete
  await press(alpha, "Delete");
  const ask = await ev(`document.querySelector('#sbminedlg .row[data-id="${alpha}"]').textContent`);
  ok(ask === MINE.confirm("Alpha") + "DeleteKeep it", "Delete asks first: board's line, Delete and Keep it (" + J(ask) + ")");
  await press(alpha, "Keep it");
  ok(J((await rows()).find((r) => r.id === alpha).buttons) === J(["Versions", "Copy link", "Open", "Delete"]) && (await ev(`fetch('/api/share/c/${alpha}').then((r) => r.status)`)) === 200, "Keep it: the row as it was, the share kept");
  await press(alpha, "Delete");
  await press(alpha, "Delete");
  await until(`!document.querySelector('#sbminedlg .row[data-id="${alpha}"]')`, 20000);
  ok((await ev(`fetch('/api/share/c/${alpha}').then((r) => r.status)`)) === 404 && J((await rows()).map((r) => r.id)) === J([beta]) && (await status()) === "", "Delete: the share discarded (its page answers 404), its row gone");

  // ---- 6. a delete the server refuses
  ok((await ev(`fetch('/api/share/collections/${beta}', { method: 'DELETE' }).then((r) => r.status)`)) === 200, "(the other share deleted behind the dialog's back)");
  await press(beta, "Delete");
  await press(beta, "Delete");
  await until(`document.querySelector('#sbminedlg [role=status]').textContent === ${J(MINE.deleteFailed)}`, 20000);
  const r6 = await rows();
  // (its Copy link still reads Copied, from 4)
  ok(J(r6.find((r) => r.id === beta)?.buttons.slice(2)) === J(["Open", "Delete"]), "a delete that fails: board's line, the row kept (" + J(r6) + ")");

  // ---- 7. the list can't be loaded
  route = async (p) => (/\/api\/share\/mine/.test(p.request.url) ? send("Fetch.fulfillRequest", { requestId: p.requestId, responseCode: 500, responseHeaders: [{ name: "content-type", value: "application/json" }], body: Buffer.from("{}").toString("base64") }) : send("Fetch.continueRequest", { requestId: p.requestId }));
  await send("Fetch.enable", { patterns: [{ urlPattern: "*/api/share/mine*", requestStage: "Request" }] });
  await openFromMenu();
  ok((await status()) === MINE.cantLoad && (await rows()).length === 0, "the list can't be loaded: board's line");
  await send("Fetch.disable");
  route = null;
  // ---- and after the deletes, none
  await openFromMenu();
  ok((await status()) === MINE.empty, "both deleted: the empty line again");

  // ---- 8. a share with no version yet (an older page's empty collection) has no page, so it isn't listed
  const empty = await ev(`fetch('/api/share/collections', { method: 'POST', headers: { 'content-type': 'application/json' }, body: ${J(J({ title: "Empty" }))} }).then((r) => r.json()).then((j) => j.id)`);
  await openFromMenu();
  ok(typeof empty === "string" && !(await rows()).some((r) => r.id === empty) && (await status()) === MINE.empty, "a share with no version yet isn't listed (" + empty + ")");

  // ---- 9. a failed delete's line goes when a later one succeeds; after the last, board's "none" line
  const x = await makeShare("X"), y = await makeShare("Y"), z = await makeShare("Z");
  await openFromMenu();
  ok((await ev(`fetch('/api/share/collections/${z}', { method: 'DELETE' }).then((r) => r.status)`)) === 200, "(Z, listed, deleted behind the dialog's back)");
  await press(z, "Delete");
  await press(z, "Delete");
  await until(`document.querySelector('#sbminedlg [role=status]').textContent === ${J(MINE.deleteFailed)}`, 20000);
  await press(x, "Delete");
  await press(x, "Delete");
  await until(`!document.querySelector('#sbminedlg .row[data-id="${x}"]')`, 20000);
  ok((await status()) === "" && (await rows()).some((r) => r.id === y), "a later delete that succeeds clears the failed one's line; the others stay");
  // (opened again: Z, deleted behind its back, isn't listed; Y is the last)
  await openFromMenu();
  ok(J((await rows()).map((r) => r.id)) === J([y]), "(opened again: only Y is left)");
  await press(y, "Delete");
  await press(y, "Delete");
  await until(`!document.querySelector('#sbminedlg .row[data-id="${y}"]')`, 20000);
  ok((await status()) === MINE.none, "the last share deleted: board's line for none left (" + J(await status()) + ")");

  // ---- 10. the sign-in check gets no answer: board's line for it, not "isn't available"
  route = async (p) => (/\/api\/share\/me/.test(p.request.url) ? send("Fetch.failRequest", { requestId: p.requestId, errorReason: "Failed" }) : send("Fetch.continueRequest", { requestId: p.requestId }));
  await send("Fetch.enable", { patterns: [{ urlPattern: "*/api/share/me*", requestStage: "Request" }] });
  await openFromMenu();
  ok((await status()) === MINE.unreachable, "the sign-in check gets no answer: board's line (" + J(await status()) + ")");
  await send("Fetch.disable");
  route = null;

  // ---- 11. the Share dialog's footer, while an upload is under way: Your shares opens over it; the upload's dialog stays
  await ev("(() => { document.querySelector('#sbminedlg')?.close(); return 1; })()");
  const blobs = [];
  route = async (p) => (/\/api\/share\/blob\//.test(p.request.url) ? blobs.push(p) : send("Fetch.continueRequest", { requestId: p.requestId }));
  await send("Fetch.enable", { patterns: [{ urlPattern: "*/api/share/blob/*", requestStage: "Request" }] });
  await ev("(() => { const d = document.querySelector('#sharedlg'); if (d.open) d.close(); document.querySelector('#sharemenu').click(); return 1; })()");
  await until("!document.querySelector('#shareform').hidden && !document.querySelector('#shareupload').disabled && !/^Finding|^Checking/.test(document.querySelector('#sharestatus').textContent)", 60000);
  await ev("(document.querySelector('#shareupload').click(), true)");
  for (let i = 0; i < 300 && !blobs.length; i++) await sleep(100);
  ok(blobs.length >= 1 && (await ev("document.querySelector('#shareupload').classList.contains('busy')")), "(an upload under way, its file held)");
  await ev("(document.querySelector('#sharemine').click(), true)");
  await until("document.querySelector('#sbminedlg')?.open");
  ok(await ev("document.querySelector('#sharedlg').open"), "the Share dialog's footer mid-upload: Your shares opens, and the upload's dialog stays open");
  route = null;
  for (const p of blobs.splice(0)) await send("Fetch.continueRequest", { requestId: p.requestId });
  await send("Fetch.disable");
  await ev("(document.querySelector('#sbminedlg').close(), true)");
  await until("!document.querySelector('#shareupload').classList.contains('busy')", 60000);

  // ---- 11b. the header's Share (William, round 2): shown, and it opens the same Share dialog, hanging under it at
  // its right edge (File ▸ Share… opens it centred, as before)
  ok(await ev("!document.querySelector('#sharebtn').hidden"), "the header's Share is shown where File ▸ Share… is");
  await ev("(document.querySelector('#sharebtn').click(), true)");
  await until("document.querySelector('#sharedlg').open");
  await sleep(300);
  const an = await ev("(() => { const d = document.querySelector('#sharedlg'), r = d.getBoundingClientRect(), b = document.querySelector('#sharebtn').getBoundingClientRect(); return { anchored: d.classList.contains('sb-anchored'), below: r.top >= b.bottom, right: Math.abs(r.right - b.right) <= 2 }; })()");
  ok(an.anchored && an.below && an.right, "…and opens the Share dialog under it, at its right edge (" + J(an) + ")");
  await ev("(document.querySelector('#sharedlg').close(), true)");
  await ev("(document.querySelector('#sharemenu').click(), true)");
  await until("document.querySelector('#sharedlg').open");
  await sleep(300);
  ok(!(await ev("document.querySelector('#sharedlg').classList.contains('sb-anchored')")), "File ▸ Share… still opens it centred");
  await ev("(document.querySelector('#sharedlg').close(), true)");

  // ---- 12. the CLI's local page has no share server: no Your shares in File
  await send("Page.enable");
  const loc = (await send("Page.addScriptToEvaluateOnNewDocument", { source: `window.__SAGEBRUSH_LOCAL__ = { path: "/tmp/sb-mine.ipynb", name: "sb-mine.ipynb" };` })).identifier;
  await send("Page.navigate", { url: dev.site + "/" });
  await until("!!document.querySelector('#filemenu [data-f=\"mine\"]')", 90000);
  ok(await ev("document.querySelector('#filemenu [data-f=\"mine\"]').hidden"), "the CLI's local page: no Your shares in File (local: " + J(await ev("!!window.__SAGEBRUSH_LOCAL__")) + ")");
  const lb = await ev("(() => { const i = document.querySelector('#sharemenu'); return { btn: document.querySelector('#sharebtn').hidden, item: !i || i.hidden || i.disabled }; })()");
  ok(lb.btn === lb.item, "…and the header's Share is shown exactly when File ▸ Share… is (" + J(lb) + ")");
  await send("Page.removeScriptToEvaluateOnNewDocument", { identifier: loc });
} catch (e) {
  ok(false, "the test failed: " + (e?.stack ?? e));
} finally {
  chrome.kill();
  await dev.close();
  await sleep(300);
  rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
console.log(failures ? `${failures} FAILED` : "all ok");
process.exit(failures ? 1 : 0);
