// ci: web-browser/board-c order=160
// An open board follows its writes made elsewhere (web/board/page.ts, followWrites), in headless Chromium: another tab
// of this browser writes the board through the workspace, as an agent paired with the notebook page does, and the
// board shows the new version at once, without a reload, and runs its changed and new code; the board's own edits
// are never taken for a write made elsewhere (no "changed elsewhere" copy, nothing shown twice).  Serve web/dist
// first (python3 web/serve.py 8765), then
//   node web/board/test-board-follows-writes.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devtoolsPort } from "../test-port.mjs";

const base = process.env.SB_URL ?? "http://127.0.0.1:8765/";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = mkdtempSync(join(tmpdir(), "sb-follows-prof-"));
const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", "--remote-debugging-port=0", "--window-size=1280,800", `--user-data-dir=${profile}`, "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
// (a browser that goes away is a failure that says so, with Chrome's last stderr lines, never a silent exit)
let chromeTail = "", dead = "";
chrome.stderr.on("data", (d) => { chromeTail = (chromeTail + d).slice(-2048); });
const tabs = [];
const die = (why) => { if (dead) return; dead = why; for (const t of tabs) t.dieAll(why); };
chrome.on("exit", (code, signal) => die(`Chrome exited (code ${code}, signal ${signal})`));
const port = await devtoolsPort(profile, 60_000, { child: chrome });
const fails = [];
let checks = 0;
const check = (ok, what) => { checks++; if (!ok) fails.push(what); };

/** A tab: its DevTools socket, with bounded calls that fail at once when the browser is gone. */
async function tab(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((ok, fail) => { ws.onopen = ok; ws.onclose = () => fail(new Error(`the DevTools socket closed before it opened; Chrome's stderr: ${chromeTail}`)); });
  let n = 0;
  const waiting = new Map(), errors = [];
  const t = {
    errors,
    dieAll(why) { for (const [, w] of waiting) { clearTimeout(w.timer); w.at.message = why; w.fail(w.at); } waiting.clear(); },
    send(method, params = {}, ms = 120000) {
      return new Promise((ok, fail) => {
        const at = new Error(dead);
        if (dead) return fail(at);
        const id = ++n;
        const timer = setTimeout(() => { waiting.delete(id); at.message = `${method}: no answer in ${ms / 1000} s`; fail(at); }, ms);
        waiting.set(id, { ok, fail, timer, at });
        ws.send(JSON.stringify({ id, method, params }));
      });
    },
    async ev(expression) { const r = await t.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400)); return r.result?.value; },
    async until(expr, ms = 30000) { const s = Date.now(); while (Date.now() - s < ms) { if (await t.ev(expr).catch((e) => { if (dead) throw e; return false; })) return true; await sleep(100); } return false; },
  };
  ws.onclose = () => die("the DevTools socket closed");
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && waiting.has(m.id)) { const w = waiting.get(m.id); waiting.delete(m.id); clearTimeout(w.timer); w.ok(m.result ?? m.error); }
    if (m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails?.exception?.description ?? JSON.stringify(m.params.exceptionDetails));
    if (m.method === "Inspector.targetCrashed") die("a page crashed");
  };
  tabs.push(t);
  for (const m of ["Page.enable", "Runtime.enable", "Inspector.enable"]) await t.send(m);
  return t;
}
const pageTarget = async (url) => {
  for (let i = 0; i < 100; i++) {
    const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json().catch(() => []);
    const p = list.find((x) => x.type === "page" && (url ? x.url.startsWith(url) : true));
    if (p) return p;
    await sleep(100);
  }
  throw new Error("no page target" + (url ? " at " + url : ""));
};

try {
  // the board, made in tab A (a board of the workspace, shown in Edit as one made here)
  const A = await tab((await pageTarget()).webSocketDebuggerUrl);
  await A.send("Page.navigate", { url: `${base}board/?new=python` });
  check(await A.until("/doc=local:/.test(location.search) && !!window.sagebrush?.board?.snapshot?.()?.doc", 60000), "the board page makes a board of the workspace");
  const id = await A.ev("new URLSearchParams(location.search).get('doc').slice('local:'.length)");
  const W = "window.sagebrush.workspace";
  check(await A.until(`${W}.list("/").then((l) => l.some((e) => e.kind === "board" && e.ref === ${JSON.stringify(id)}))`, 20000), "…listed in the workspace");
  const path = await A.ev(`${W}.list("/").then((l) => l.find((e) => e.kind === "board" && e.ref === ${JSON.stringify(id)}).path)`);
  const origin0 = await A.ev("performance.timeOrigin");
  const items = "window.sagebrush.board.snapshot().items.length";
  const outOf = (nid) => `window.sagebrush.board.outputs().then((os) => String(os.find((o) => o.id === ${JSON.stringify(nid)})?.output ?? ''))`;

  // tab B, another page of this browser (the notebook page, where an agent pairs), writes the board
  const created = await A.send("Target.createTarget", { url: "about:blank" });
  const B = await tab((await (async () => { for (let i = 0; i < 100; i++) { const l = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); const p = l.find((x) => x.id === created.targetId); if (p) return p; await sleep(100); } throw new Error("tab B not found"); })()).webSocketDebuggerUrl);
  await B.send("Page.navigate", { url: base });
  check(await B.until(`!!${W}`, 60000), "tab B, the notebook page, has the workspace");
  const write = (doc) => B.ev(`${W}.read(${JSON.stringify(path)}).then((r) => ${W}.write(${JSON.stringify(path)}, ${JSON.stringify(doc)}, { base: r.rev })).then((r) => r.rev)`);
  const rev2 = await write({ title: "Followed", nodes: [{ id: "intro", title: "About", text: "Its square: $x^2$." }, { id: "sq", title: "A square", code: "x = 6\nprint(x * 7)" }], edges: [] });
  check(typeof rev2 === "number", "tab B writes the board (its base)");
  check(await A.until(`${items} === 2 && window.sagebrush.board.snapshot().doc.title === "Followed"`, 15000), "the open board shows the write at once", await A.ev(`${items}`).catch(() => null));
  check(await A.until(`${outOf("sq")}.then((o) => /42/.test(o))`, 60000), "…and runs its new code", await A.ev(outOf("sq")).catch(() => null));
  check(await A.ev("performance.timeOrigin") === origin0, "…without a reload");

  // a change to its code and a new item: the changed code runs again, the new one runs
  const rev3 = await write({ title: "Followed", nodes: [{ id: "intro", title: "About", text: "Its square: $x^2$." }, { id: "sq", title: "A square", code: "x = 6\nprint(x * 8)" }, { id: "more", title: "More", code: "print(x + 100)" }], edges: [] });
  check(rev3 === rev2 + 1, "tab B writes it again", rev3);
  check(await A.until(`${items} === 3 && ${outOf("sq")}.then((o) => /48/.test(o))`, 60000), "the changed code runs again", await A.ev(outOf("sq")).catch(() => null));
  check(await A.until(`${outOf("more")}.then((o) => /106/.test(o))`, 60000), "the new item runs", await A.ev(outOf("more")).catch(() => null));

  // the board's own edit, here: saved over the version it shows, never taken for a write made elsewhere
  await A.ev("window.sagebrush.board.editing(true), 1");
  await A.ev(`window.sagebrush.board.edit((d) => { d.title = "Followed, renamed here"; }).then(() => 1)`);
  check(await B.until(`${W}.read(${JSON.stringify(path)}).then((r) => r.content.title === "Followed, renamed here" && r.rev === ${rev3 + 1})`, 15000), "the board's own edit is saved over the version it shows");
  await sleep(1500);
  check(!(await A.ev(`${W}.list("/").then((l) => l.some((e) => /changed elsewhere/.test(e.path)))`)), "…no \"changed elsewhere\" copy is made");
  check((await A.ev("window.sagebrush.board.snapshot().doc.title")) === "Followed, renamed here" && !/changed elsewhere/.test(await A.ev("document.body.innerText")), "…and the board shows its own edit, saying nothing");
  check(await A.ev("performance.timeOrigin") === origin0, "…still without a reload");
  check(!A.errors.length && !B.errors.length, "no exceptions: " + [...A.errors, ...B.errors].join(" | ").slice(0, 400));
} catch (e) {
  fails.push(String(e?.stack ?? e) + (dead && chromeTail.trim() ? `\n  Chrome's stderr, its end:\n    ${chromeTail.trim().split("\n").slice(-15).join("\n    ")}` : ""));
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
process.exit(0);
