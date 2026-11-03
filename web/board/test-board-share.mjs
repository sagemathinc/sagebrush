// A board's share link (sim run 4, APP-board-share-disabled: agents built their talks as boards and had no link to
// present from), in headless Chromium against the built site:
//   - File > Share is enabled on the board page; it copies a link /board/#z=<deflated JSON> and shows it in the
//     caption (so an agent sees what it made);
//   - opening the link makes the person's own copy, the same board, its code paused until they run it, the
//     fragment cleared (a reload opens the copy, not a second one);
//   - a damaged link, or one that isn't a board, opens nothing and says why.
//   bun web/build.ts, then node web/board/test-board-share.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateRawSync } from "node:zlib";
import { devtoolsPort } from "../test-port.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = mkdtempSync(join(tmpdir(), "sb-board-share-"));
const serve = spawn("python3", [join(here, "..", "serve.py"), "0"], { stdio: ["ignore", "pipe", "inherit"] });
const port = await new Promise((r) => serve.stdout.once("data", (d) => r(Number(String(d).trim().split(/\s+/).pop()))));
const origin = `http://127.0.0.1:${port}`;
const profile = join(tmp, "profile");
const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", "--password-store=basic", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
const cdp = await devtoolsPort(profile);
let targets;
for (let i = 0; i < 300; i++) { try { targets = await (await fetch(`http://127.0.0.1:${cdp}/json`)).json(); break; } catch { await sleep(100); } }
const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let n = 0; const waiting = new Map(); const errors = [];
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result ?? m.error); waiting.delete(m.id); }
  if (m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails?.exception?.description ?? JSON.stringify(m.params.exceptionDetails));
};
const send = (method, params = {}) => new Promise((r) => { const id = ++n; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (expression) => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 500)); return r.result?.value; };
const until = async (expr, ms = 30000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(expr).catch(() => false)) return true; await sleep(200); } return false; };
const open = async (url) => { await send("Page.navigate", { url: "about:blank" }); await sleep(100); await send("Page.navigate", { url }); return until("!!window.sagebrush?.board && !!document.querySelector('[data-sbb=\"share\"]')"); };
const caption = () => ev(`document.querySelector(".sbb")?.innerText ?? ""`);
const fails = [];
let checks = 0;
const check = (ok, what) => { checks++; console.log((ok ? "ok   " : "FAIL ") + what); if (!ok) fails.push(what); };
const TALK = { format: "sagebrush-board", version: 1, title: "My talk: primes", nodes: [{ id: "n0", text: "# Primes\n\nThere are infinitely many: $p_1 p_2 \\cdots p_n + 1$.", x: 40, y: 40 }, { id: "n1", text: "A second note, ünïcødé ✓", x: 40, y: 200 }, { id: "c", code: "print(sum(1 for p in range(2, 100) if all(p % d for d in range(2, p))))", x: 400, y: 40 }] };
const b64url = (b) => Buffer.from(b).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
try {
  for (const m of ["Page.enable", "Runtime.enable"]) await send(m);
  check(await open(`${origin}/board/?new=python`), "a new board opens");
  await ev(`window.sagebrush.board.load(${JSON.stringify(TALK)})`);
  check(await until(`window.sagebrush.board.snapshot().doc?.title === ${JSON.stringify(TALK.title)}`), "(the talk is loaded)");
  check(!(await ev(`document.querySelector('[data-sbb="share"]').disabled`)), "File > Share is enabled on the board page");
  await ev(`(document.querySelector('[data-sbb="share"]').click(), true)`);
  check(await until(`!!document.querySelector('[data-sbb="sharelink"]')`, 10000), "Share shows the link in the caption");
  const link = await ev(`document.querySelector('[data-sbb="sharelink"]').href`);
  check(link.startsWith(`${origin}/board/#z=`) && /^[A-Za-z0-9_-]+$/.test(link.slice(link.indexOf("#z=") + 3)), `a link to the board page with the board in its fragment (${link.slice(0, 80)}…)`);
  check(/whoever opens it gets a copy of their own, its code paused until they run it/.test(await caption()), "the caption says what the link holds and what opening it does");

  // opening it: the person's own copy, the same board, its code paused, the fragment gone
  check(await open(link), "the link opens the board page");
  check(await until(`/[?&]doc=local:[0-9a-f]{12}/.test(location.search) && location.hash === ""`), `a copy of its own, the fragment cleared (${await ev("location.search + location.hash")})`);
  await until(`!!window.sagebrush.board.snapshot().doc?.title`, 20000);
  const got = await ev(`window.sagebrush.board.snapshot().doc`);
  check(got.title === TALK.title && TALK.nodes.every((x) => got.nodes.some((y) => y.id === x.id && (y.text ?? y.code) === (x.text ?? x.code))), `the same board: title, notes and code (${got.nodes?.length} items)`);
  check(await until(`!document.querySelector('[data-sbb="runpaused"]').hidden`, 10000), "its code is paused until the person runs it (Run this board's code shown)");
  const paused0 = await ev(`Promise.race([window.sagebrush.board.outputs().then((o) => JSON.stringify(o)), new Promise((r) => setTimeout(() => r("(still running)"), 8000))])`);
  check(!/\b25\b/.test(paused0), "…its code hasn't run");
  await ev(`(document.querySelector('[data-sbb="runpaused"]').click(), true)`);
  check(await until(`window.sagebrush.board.outputs().then((o) => /\\b25\\b/.test(JSON.stringify(o)))`, 60000), "…until the person runs it: then its output (25 primes below 100)");
  const copy = await ev("location.href");
  check(await open(copy) && (await ev("location.href")) === copy, "a reload opens the same copy, not a second one");

  // a damaged link, and one that isn't a board: nothing made, said why
  for (const [z, why, want] of [["%%%", "not base64url", /damaged/], [b64url(Buffer.from("not deflated")), "not deflated", /damaged/], [b64url(deflateRawSync(Buffer.from('{"a": 1}'))), "not a board", /couldn't be opened/]]) {
    await open(`${origin}/board/#z=${z}`);
    await sleep(800);
    const c = await caption();
    check(/This shared board couldn't be opened/.test(c) && want.test(c) && !/[?&]doc=local:/.test(await ev("location.search")) && (await ev("location.hash")) === "", `${why}: nothing opened, said why, the fragment cleared`);
  }
  // sessionStorage refused or full (astra's BOARD-SHARE-1): no copy made, or the copy's code still paused, never run
  const refuse = (pred) => send("Page.addScriptToEvaluateOnNewDocument", { source: `(() => { const set = Storage.prototype.setItem; Storage.prototype.setItem = function (k, v) { if (this === window.sessionStorage && (${pred})(String(k))) throw new DOMException("full", "QuotaExceededError"); return set.call(this, k, v); }; })();` });
  const boards = () => ev(`window.sagebrush.workspace ? window.sagebrush.workspace.list("/").then((l) => l.filter((e) => e.kind === "board").length) : -1`);
  await open(`${origin}/board/?new=python`);
  const before = await boards();
  const outs = () => ev(`Promise.race([window.sagebrush.board.outputs().then((o) => JSON.stringify(o)), new Promise((r) => setTimeout(() => r("(still running)"), 8000))])`);
  const s1 = await refuse("(k) => true");
  await open(link);
  await sleep(1500);
  check(/This shared board couldn't be opened/.test(await caption()) && /sessionStorage/.test(await caption()) && !/[?&]doc=local:/.test(await ev("location.search")) && (await boards()) === before, `sessionStorage refused: no copy made, said why (${before} boards before and after)`);
  await send("Page.removeScriptToEvaluateOnNewDocument", { identifier: s1.identifier });
  // (the probe kept, the pause's own key refused: only an inert placeholder (a note, no code) is left, nothing in
  // Trash, nothing removed, the shared code never kept nor run, also after a reload: astra's BOARD-SHARE-1/2)
  const codeIn = () => ev(`window.sagebrush.workspace.list("/", { recursive: true }).then(async (l) => { let n = 0; for (const e of l.filter((x) => x.kind === "board")) { const r = await window.sagebrush.workspace.read(e.path); n += (r.content?.nodes ?? []).filter((x) => x.code && x.code.includes("range(2, 100)")).length; } return n; })`);
  const codeBefore = await codeIn();
  const s2 = await refuse("(k) => k.startsWith('sagebrush-board-paused:') && k !== 'sagebrush-board-paused:probe'");
  await open(link);
  await sleep(1500);
  const trash = await ev(`window.sagebrush.workspace.list("/Trash").then((l) => l.filter((e) => e.kind === "board").length).catch(() => 0)`);
  check(/This shared board couldn't be opened/.test(await caption()) && /keeps a shared board's code paused/.test(await caption()) && /holding no code/.test(await caption()) && !/[?&]doc=local:/.test(await ev("location.search")), "the pause's own key refused: not opened, said why, and that an empty board is left");
  check((await boards()) === before + 1 && trash === 0 && (await codeIn()) === codeBefore, `…only the inert placeholder is left (${before} -> ${await boards()} boards, Trash ${trash}): the shared code isn't in any board`);
  const o1 = await outs();
  check(!/\b25\b/.test(o1), `…and the shared code never ran (outputs ${o1.slice(0, 60)})`);
  // (astra's reload negative: reloaded before any Run, there is still no copy to open, nothing ran)
  await send("Page.reload");
  await until("!!window.sagebrush?.board", 20000);
  await sleep(1000);
  check(!/[?&]doc=local:/.test(await ev("location.search")) && (await codeIn()) === codeBefore && !/\b25\b/.test(await outs()), "…reloaded before any Run: the shared code still in no board, nothing ran");
  // (and this browser's own boards, without the workspace (?workspace=0): no copy kept there either)
  const localIds = () => ev(`JSON.parse(localStorage.getItem("sagebrush-boards") ?? "[]").map((b) => b.id).join(",")`);
  await open(`${origin}/board/?workspace=0&new=python`);
  const localBefore = await localIds();
  await open(`${origin}/board/?workspace=0${link.slice(link.indexOf("#"))}`);
  await sleep(1500);
  const localCode = () => ev(`JSON.parse(localStorage.getItem("sagebrush-boards") ?? "[]").map((b) => localStorage.getItem("sagebrush-board:local:" + b.id) ?? "").filter((t) => t.includes("range(2, 100)")).length`);
  check(/keeps a shared board's code paused/.test(await caption()) && (await localCode()) === 0 && !/[?&]doc=local:/.test(await ev("location.search")), `without the workspace, the pause's own key refused: the shared code in none of this browser's boards (${localBefore.split(",").length} before)`);
  await send("Page.removeScriptToEvaluateOnNewDocument", { identifier: s2.identifier });
  // (the copy's path replaced between the fill's check and its write: the board now there is left as it was, the shared
  // code written nowhere: the fill is checked against the placeholder's own id, BOARD-SHARE-2)
  const seam = await send("Page.addScriptToEvaluateOnNewDocument", { source: `globalThis.__sbShareSeam = async (ws, id, p) => { await ws.rename(p, "/moved-away.board.json"); await ws.create(p, { content: { title: "Someone else's", nodes: [{ id: "k", text: "keep me", x: 0, y: 0 }] } }); };` });
  await open(`${origin}/board/?new=python`);
  const codeBefore2 = await codeIn();
  await open(link);
  await sleep(1500);
  const other = await ev(`window.sagebrush.workspace.list("/").then(async (l) => { const all = await Promise.all(l.filter((x) => x.kind === "board").map(async (x) => ({ path: x.path, doc: (await window.sagebrush.workspace.read(x.path)).content }))); return all.filter((x) => x.doc?.title === "Someone else's").map((x) => ({ path: x.path, nodes: x.doc.nodes })); })`);
  check(/This shared board couldn't be opened/.test(await caption()) && /moved before it was filled in/.test(await caption()), "the copy's path replaced before the fill: refused, said why");
  check(other.length === 1 && JSON.stringify(other[0].nodes.map((x) => x.text ?? x.code)) === '["keep me"]' && (await codeIn()) === codeBefore2, `…the board put at that path is left as it was (${JSON.stringify(other).slice(0, 120)}), the shared code written nowhere`);
  await send("Page.removeScriptToEvaluateOnNewDocument", { identifier: seam.identifier });
  check(errors.length === 0, "no exceptions in the page: " + errors.slice(0, 3).join(" | "));
} catch (e) {
  check(false, "threw: " + String(e?.stack ?? e).slice(0, 800));
} finally {
  // (Chromium's profile removed only once it has exited: it writes there until then, CI's ENOTEMPTY on #516)
  const gone = chrome.exitCode !== null || chrome.signalCode !== null ? Promise.resolve() : new Promise((r) => chrome.once("exit", r));
  chrome.kill(); serve.kill();
  await Promise.race([gone, sleep(5000)]);
  rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
console.log(`${checks - fails.length}/${checks} checks passed`);
process.exit(fails.length ? 1 : 0);
