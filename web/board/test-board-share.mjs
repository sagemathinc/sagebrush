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
  const got = await ev(`window.sagebrush.board.snapshot().doc`);
  check(got.title === TALK.title && TALK.nodes.every((x) => got.nodes.some((y) => y.id === x.id && (y.text ?? y.code) === (x.text ?? x.code))), `the same board: title, notes and code (${got.nodes?.length} items)`);
  check(await until(`!document.querySelector('[data-sbb="runpaused"]').hidden`, 10000), "its code is paused until the person runs it (Run this board's code shown)");
  const copy = await ev("location.href");
  check(await open(copy) && (await ev("location.href")) === copy, "a reload opens the same copy, not a second one");

  // a damaged link, and one that isn't a board: nothing made, said why
  for (const [z, why, want] of [["%%%", "not base64url", /damaged/], [b64url(Buffer.from("not deflated")), "not deflated", /damaged/], [b64url(deflateRawSync(Buffer.from('{"a": 1}'))), "not a board", /couldn't be opened/]]) {
    await open(`${origin}/board/#z=${z}`);
    await sleep(800);
    const c = await caption();
    check(/This shared board couldn't be opened/.test(c) && want.test(c) && !/[?&]doc=local:/.test(await ev("location.search")) && (await ev("location.hash")) === "", `${why}: nothing opened, said why, the fragment cleared`);
  }
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
