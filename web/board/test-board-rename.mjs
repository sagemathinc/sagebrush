// A board's title is its file's name, as a notebook's is (William's B2), in headless Chromium against the built site:
// a title changed on the board page renames its file in the person's files, to a free name beside it (" (2)" when it is
// taken: never over another board), and a later edit keeps it there; the other board is left as it was.
//   bun web/build.ts, then node web/board/test-board-rename.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { devtoolsPort } from "../test-port.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = mkdtempSync(join(tmpdir(), "sb-board-rename-"));
const serve = spawn("python3", [join(here, "..", "serve.py"), "0"], { stdio: ["ignore", "pipe", "inherit"] });
const port = await new Promise((r) => serve.stdout.once("data", (d) => r(Number(String(d).trim().split(/\s+/).pop()))));
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
const ev = async (expression) => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400)); return r.result?.value; };
const until = async (expr, ms = 20000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(expr).catch(() => false)) return true; await sleep(200); } return false; };
const fails = [];
let checks = 0;
const check = (ok, what) => { checks++; console.log((ok ? "ok   " : "FAIL ") + what); if (!ok) fails.push(what); };
const boards = () => ev(`window.sagebrush.workspace.list("/").then((l) => l.filter((e) => e.kind === "board").map((e) => e.path).sort())`);
const title = (t) => ev(`Promise.resolve(window.sagebrush.board.edit((d) => { d.title = ${JSON.stringify(t)}; })).then(() => true)`);
try {
  for (const m of ["Page.enable", "Runtime.enable"]) await send(m);
  // (a board called "Talk" already there)
  await send("Page.navigate", { url: `http://127.0.0.1:${port}/board/?new=python` });
  check(await until("!!window.sagebrush?.workspace && !!window.sagebrush?.board?.snapshot().doc"), "a new board opens");
  await title("Talk");
  check(await until(`window.sagebrush.workspace.list("/").then((l) => l.some((e) => e.path === "/Talk.board.json"))`), "its title \"Talk\": its file is /Talk.board.json");
  await ev(`Promise.resolve(window.sagebrush.board.edit((d) => { d.nodes = [{ id: "a", text: "the first talk", x: 0, y: 0 }]; })).then(() => true)`);
  await sleep(1500);
  // a second board, titled "Talk" too: its file is the free "Talk (2)", the first left as it was
  await send("Page.navigate", { url: "about:blank" });
  await send("Page.navigate", { url: `http://127.0.0.1:${port}/board/?new=python` });
  await until("!!window.sagebrush?.workspace && !!window.sagebrush?.board?.snapshot().doc");
  await title("Talk");
  check(await until(`window.sagebrush.workspace.list("/").then((l) => l.some((e) => e.path === "/Talk (2).board.json"))`), `a second board titled "Talk": its file is the free /Talk (2).board.json (${JSON.stringify(await boards())})`);
  const first = await ev(`window.sagebrush.workspace.read("/Talk.board.json").then((r) => r.content)`);
  check(first?.title === "Talk" && JSON.stringify(first.nodes?.map((x) => x.text)) === '["the first talk"]', "…and the first board is left as it was (never written over)");
  // renamed again: a free name taken exactly; a later edit keeps it there
  await title("Slides for Friday");
  check(await until(`window.sagebrush.workspace.list("/").then((l) => l.some((e) => e.path === "/Slides for Friday.board.json") && !l.some((e) => e.path === "/Talk (2).board.json"))`), "retitled \"Slides for Friday\": its file renamed to it, the old name gone");
  await ev(`Promise.resolve(window.sagebrush.board.edit((d) => { d.nodes = [{ id: "b", text: "kept", x: 0, y: 0 }]; })).then(() => true)`);
  check(await until(`window.sagebrush.workspace.read("/Slides for Friday.board.json").then((r) => r.content?.nodes?.some((x) => x.text === "kept"))`), "…and a later edit is saved there");
  const all = await boards();
  check(JSON.stringify(all.filter((p) => /Talk|Slides/.test(p))) === JSON.stringify(["/Slides for Friday.board.json", "/Talk.board.json"]), `the files: ${JSON.stringify(all)}`);
  // astra's BOARD-RENAME-1: another writer's newer title, written after the page read the board and before the rename
  // is admitted: nothing moves, the newer title and contents stay at the old path
  await send("Page.navigate", { url: "about:blank" });
  await send("Page.navigate", { url: `http://127.0.0.1:${port}/board/?new=python` });
  await until("!!window.sagebrush?.workspace && !!window.sagebrush?.board?.snapshot().doc");
  await title("Before");
  check(await until(`window.sagebrush.workspace.list("/").then((l) => l.some((e) => e.path === "/Before.board.json"))`), "a third board, \"Before\": /Before.board.json");
  await sleep(1500);
  await ev(`(() => { const W = window.sagebrush.workspace; let once = true; window.__SB_BOARD_TEST__ = { beforeRename: async (from) => { if (!once) return; once = false; const r = await W.read(from); await W.write(from, { ...r.content, title: "Other writer", nodes: [{ id: "k", text: "KEEP ME", x: 0, y: 0 }] }, { base: r.rev }); window.__wroteBetween = from; } }; return 1; })()`);
  await title("Edited");
  check(await until(`window.__wroteBetween === "/Before.board.json"`), "…another's write landed between the page's read and its rename");
  await sleep(2500);
  const left = await boards();
  check(left.includes("/Before.board.json") && !left.includes("/Edited.board.json"), `…and nothing moved: the board is still /Before.board.json, no /Edited.board.json (${JSON.stringify(left)})`);
  const kept = await ev(`window.sagebrush.workspace.read("/Before.board.json").then((r) => r.content)`);
  check(kept?.title === "Other writer" && kept.nodes?.some((x) => x.text === "KEEP ME"), `…its newer title and contents as the other wrote them (${JSON.stringify(kept?.title)})`);
  // the control: a save of this page's own in the same window still renames (its title is still the one edited)
  await send("Page.navigate", { url: "about:blank" });
  await send("Page.navigate", { url: `http://127.0.0.1:${port}/board/?new=python` });
  await until("!!window.sagebrush?.workspace && !!window.sagebrush?.board?.snapshot().doc");
  await title("Mine");
  check(await until(`window.sagebrush.workspace.list("/").then((l) => l.some((e) => e.path === "/Mine.board.json"))`), "a fourth board, \"Mine\": /Mine.board.json");
  await sleep(1500);
  await ev(`(() => { let once = true; window.__SB_BOARD_TEST__ = { beforeRename: async () => { if (!once) return; once = false; await window.sagebrush.board.edit((d) => { d.nodes = [{ id: "o", text: "own edit", x: 0, y: 0 }]; }); await new Promise((r) => setTimeout(r, 1200)); window.__ownBetween = 1; } }; return 1; })()`);
  await title("Mine renamed");
  check(await until(`window.__ownBetween === 1`), "…the page's own save landed between its read and its rename");
  check(await until(`window.sagebrush.workspace.list("/").then((l) => l.some((e) => e.path === "/Mine renamed.board.json") && !l.some((e) => e.path === "/Mine.board.json"))`), `…and it is still renamed, after asking again (${JSON.stringify(await boards())})`);
  check(await until(`window.sagebrush.workspace.read("/Mine renamed.board.json").then((r) => r.content?.nodes?.some((x) => x.text === "own edit"))`), "…its own edit kept there");
  check(errors.length === 0, "no exceptions in the page: " + errors.slice(0, 3).join(" | "));
} catch (e) {
  check(false, "threw: " + String(e?.stack ?? e).slice(0, 800));
} finally {
  const gone = chrome.exitCode !== null ? Promise.resolve() : new Promise((r) => chrome.once("exit", r));
  chrome.kill(); serve.kill();
  await Promise.race([gone, sleep(5000)]);
  rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
console.log(`${checks - fails.length}/${checks} checks passed`);
process.exit(fails.length ? 1 : 0);
