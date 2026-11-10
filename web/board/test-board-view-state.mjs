// ci: web-runner order=163 runner=bun chrome
// Where you were in a board (design/view-state.md, the board's adoption): its page, position and zoom kept in this
// browser and put back when it opens again (another board and back, a reload, a new tab), never given to another
// board; a page in the address (#p1) wins; a reload that keeps the board's own #p2 puts its camera back; nothing is
// kept before the first show (its math held); and a board with code isn't fitted again over the view put back.
// The shared rows are view-state-check.mjs's; this page's are the board's own.
//   bun web/build.ts && python3 web/serve.py 8765 &  CHROME=google-chrome bun web/board/test-board-view-state.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devtoolsPort } from "../test-port.mjs";
import { checkViewKept } from "../workspace/view-state-check.mjs";

const site = process.env.SB_URL ?? "http://127.0.0.1:8765/";
let port = Number(process.env.CDP_PORT) || 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = mkdtempSync(join(tmpdir(), "sb-board-view-"));
const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", `--remote-debugging-port=${port}`, "--window-size=1200,800", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
const fails = [];
let checks = 0;
const check = (ok, what) => { checks++; if (!ok) fails.push(what); console.log((ok ? "ok   " : "FAIL ") + what); };

/** A tab on `url`: evaluated in, navigated (resolved once the new document runs), closed. */
async function open(url) {
  const t = await (await fetch(`http://127.0.0.1:${port}/json/new?${url}`, { method: "PUT" })).json();
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let n = 0;
  const waiting = new Map(), listeners = [];
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method) for (const f of listeners) f(m);
    if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result ?? m.error); waiting.delete(m.id); }
    if (m.method === "Runtime.exceptionThrown") fails.push("page error: " + (m.params.exceptionDetails?.exception?.description ?? JSON.stringify(m.params.exceptionDetails)).slice(0, 500));
  };
  const send = (method, params = {}) => new Promise((r) => { const id = ++n; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
  const ev = async (expression) => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400)); return r.result?.value; };
  await send("Runtime.enable");
  // (the old document marked, so the new one is known by its absence)
  const goto = async (u) => {
    await ev("window.__old = true").catch(() => {});
    await send("Page.navigate", { url: u });
    for (let i = 0; i < 600; i++) { if (await ev("!window.__old && document.readyState !== 'loading'").catch(() => false)) return; await sleep(25); }
    throw new Error("never loaded: " + u);
  };
  for (let i = 0; i < 400 && !(await ev("document.readyState === 'complete'").catch(() => false)); i++) await sleep(25);
  const close = async () => { try { ws.close(); } catch {} await fetch(`http://127.0.0.1:${port}/json/close/${t.id}`); await sleep(300); };
  // (a reload of the address as it is, its hash included, as the browser's own)
  const reload = async () => {
    await ev("window.__old = true");
    await send("Page.reload");
    for (let i = 0; i < 600; i++) { if (await ev("!window.__old && document.readyState !== 'loading'").catch(() => false)) return; await sleep(25); }
    throw new Error("never reloaded");
  };
  return { ev, send, goto, reload, close, on: (f) => listeners.push(f) };
}

// (the board shown, its kept view put back or not: Board.shown, mount.ts)
const ready = "window.board?.shown === true";
const read = `({ x: +window.board.camera.x.toFixed(2), y: +window.board.camera.y.toFixed(2), zoom: +window.board.camera.z.toFixed(4), page: Number(document.querySelector('#board [data-sbb="pgsel"]')?.value || 0) })`;
const until = async (t, expr, ms = 20000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await t.ev(expr).catch(() => false)) return true; await sleep(100); } return false; };

let code = 1;
try {
  if (!port) port = await devtoolsPort(profile);
  for (let i = 0; i < 300; i++) { try { await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); break; } catch {} await sleep(100); }
  // two boards of this browser's, as File > New > Board makes them
  const ids = [];
  for (let i = 0; i < 2; i++) {
    const t = await open(`${site}board/?new=python`);
    check(await until(t, `${ready} && /^local:[0-9a-f]{12}$/.test(new URLSearchParams(location.search).get("doc") ?? "")`, 60000), `(a new board ${i + 1})`);
    ids.push(await t.ev(`new URLSearchParams(location.search).get("doc")`));
    // (the first with two pages, so the page is kept too)
    if (i === 0) {
      // (math on it, so its first show waits for KaTeX: held, below)
      await t.ev(`window.sagebrush.board.edit((d) => { d.pages = [{ title: "One", nodes: [{ id: "a1", text: "one $x^2$", x: 0, y: 0, w: 200, h: 80 }] }, { title: "Two", nodes: [{ id: "b1", text: "two", x: 900, y: 600, w: 200, h: 80 }] }]; delete d.nodes; }).then(() => 1)`);
      check(await until(t, `document.querySelector('#board [data-sbb="pgsel"]')?.options.length === 2`), "(the first board has two pages)");
      await sleep(1500);
    }
    await t.close();
  }
  const urlOf = (id) => `${site}board/?doc=${id}`;
  // (the person goes to page two, and moves and zooms there)
  const set = `(async () => {
    document.querySelector('#board [data-sbb="pgnext"]')?.click();
    for (let i = 0; i < 100 && Number(document.querySelector('#board [data-sbb="pgsel"]')?.value || 0) !== 1; i++) await new Promise((r) => setTimeout(r, 50));
    window.board.setCamera({ x: 123.5, y: -45.25, z: 0.75 });
    await new Promise((r) => setTimeout(r, 700));
    return ${read};
  })()`;
  const v = await checkViewKept(check, { name: "board", open, urlOf, docs: ids, ready, set, read });
  check(v.page === 1 && v.zoom === 0.75, `board: the view set is page two at zoom 0.75 (${JSON.stringify(v)})`);

  // a page in the address wins: #p1 is page one, as the board opens it, not the view kept
  // (navigated to, from a blank tab: /json/new would take the "#p1" as its own URL's)
  let t = await open("about:blank");
  await t.goto(`${urlOf(ids[0])}#p1`);
  check(await until(t, ready, 60000), "(the board with #p1)");
  let r = await t.ev(read);
  check(r.page === 0 && r.zoom !== 0.75, `board: a page in the address (#p1) wins over the view kept (${JSON.stringify(r)})`);
  await t.close();

  // kept in this browser only, ids and numbers: the board's entry as the module writes it
  t = await open(urlOf(ids[0]));
  check(await until(t, ready, 60000), "(the board again)");
  const raw = await t.ev("localStorage.getItem('sagebrush-view-state')");
  const kept = JSON.parse(raw ?? "{}")[`board:${ids[0].slice(6)}`]?.v;
  check(kept && Object.keys(kept).sort().join() === "page,x,y,zoom" && Object.values(kept).every((n) => typeof n === "number"), `board: kept as page, x, y and zoom, numbers only (${JSON.stringify(kept)})`);
  await t.close();

  // a reload keeps the address as the board wrote it (#p2, page two): that page, and the camera kept on it, put back
  t = await open(urlOf(ids[0]));
  check(await until(t, ready, 60000), "(the board for a reload)");
  const before = await t.ev(set);
  const hash = await t.ev("location.hash");
  await t.reload();
  check(await until(t, ready, 60000), "(the board reloaded)");
  r = await t.ev(read);
  check(hash === "#p2" && JSON.stringify(r) === JSON.stringify(before), `board: a reload with its own #p2 puts page two's camera back (${hash} ${JSON.stringify(before)} -> ${JSON.stringify(r)})`);
  await t.close();

  // nothing kept before the first show: its math (KaTeX) held 1.5 s, past the keeper's 500 ms, the view kept is put back
  t = await open("about:blank");
  let held = 0;
  t.on((m) => {
    if (m.method !== "Fetch.requestPaused") return;
    held++;
    setTimeout(() => t.send("Fetch.continueRequest", { requestId: m.params.requestId }), 1500);
  });
  await t.send("Network.enable");
  await t.send("Network.setCacheDisabled", { cacheDisabled: true });
  await t.send("Fetch.enable", { patterns: [{ urlPattern: "*sagebrush-math.js*" }] });
  await t.goto(urlOf(ids[0]));
  check(await until(t, ready, 60000), "(the board, its math held)");
  r = await t.ev(read);
  check(held > 0 && JSON.stringify(r) === JSON.stringify(before), `board: a slow first show doesn't overwrite the view kept (held ${held}; ${JSON.stringify(r)})`);
  await t.close();

  if (fails.length) console.error(`FAIL: ${fails.length} of ${checks} checks\n  ` + fails.join("\n  "));
  else { console.log(`ok: where you were in a board, ${checks} checks`); code = 0; }
} finally {
  chrome.kill();
  await sleep(200);
  rmSync(profile, { recursive: true, force: true });
}
process.exit(code);
