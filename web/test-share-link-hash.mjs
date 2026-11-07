// ci: web-runner order=118 chrome
// A share link opened in a tab that already shows a notebook (run 13's APP-share-link-same-tab: pasted into the address
// bar, only the URL's fragment changes and nothing reloads), in headless Chromium against the built page:
//   - the shared notebook opens here, as at load: named "Shared notebook", its cells, its language (m=sage);
//   - the notebook it replaced is kept (still in this browser, its cells as they were), and Run all runs the shared
//     notebook's cells, not the old one's;
//   - a fragment that is no share link (#notes) changes nothing; a damaged one (#z= whose bytes don't inflate) says so and changes nothing;
//   - only the latest fragment counts (astra's SHARE-HASH-STALE-1): A held, then B, B wins; a held link dropped by a
//     later non-link fragment; an explicit open meanwhile wins; a held damaged link's error isn't said after a newer one;
//   - a control: the same link opened in a fresh load opens too.
//   bun web/build.ts, then node web/test-share-link-hash.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { devtoolsPort } from "./test-port.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = mkdtempSync(join(tmpdir(), "sb-sharehash-"));
const serve = spawn("python3", [join(here, "serve.py"), "0"], { stdio: ["ignore", "pipe", "inherit"] });
const port = await new Promise((r) => serve.stdout.once("data", (d) => r(Number(String(d).trim().split(/\s+/).pop()))));
const profile = join(tmp, "profile");
const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", "--password-store=basic", "--remote-debugging-port=0", "--window-size=1280,900", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
const cdp = await devtoolsPort(profile);
let targets;
for (let i = 0; i < 300; i++) { try { targets = await (await fetch(`http://127.0.0.1:${cdp}/json`)).json(); break; } catch { await sleep(100); } }
const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let n = 0; const waiting = new Map();
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result ?? m.error); waiting.delete(m.id); } };
const send = (method, params = {}) => new Promise((r) => { const id = ++n; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (expression) => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400)); return r.result?.value; };
const until = async (expr, ms = 30000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(expr).catch(() => false)) return true; await sleep(200); } return false; };
const fails = [];
const check = (ok, what) => { console.log((ok ? "ok   " : "FAIL ") + what); if (!ok) fails.push(what); };

const base = `http://127.0.0.1:${port}/`;
const ready = () => until("document.querySelector('#status')?.textContent.startsWith('ready')", 90000);
const go = async (url) => { await send("Page.navigate", { url }); await ready(); await sleep(300); };
const name = () => ev("document.querySelector('#nbname').value");
const codes = () => ev("JSON.stringify(sagebrush.notebook.cells().map((c) => c.ta.value))");
const current = () => ev("localStorage.getItem('sagebrush-current')");
// (a share link of these cells, made as the page makes one: the cells' JSON, deflated, base64url, in the fragment)
const linkOf = (cells, mode = "") => ev(`(async () => {
  const json = new TextEncoder().encode(JSON.stringify(${JSON.stringify(cells)}));
  const z = new Uint8Array(await new Response(new Blob([json]).stream().pipeThrough(new CompressionStream("deflate-raw"))).arrayBuffer());
  let b = ""; for (const c of z) b += String.fromCharCode(c);
  return "#" + ${JSON.stringify(mode)} + "z=" + btoa(b).replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/, "");
})()`);
// (the address bar's fragment changed, as pasting a link there does: the page isn't reloaded, hashchange fires)
const setHash = (h) => ev(`(location.hash = ${JSON.stringify(h)}, 1)`);

try {
  for (const m of ["Page.enable", "Runtime.enable"]) await send(m);
  await go(base);
  check(await until("!!window.sagebrush?.notebook", 60000), "the notebook page opens");
  // (the notebook showing: one of this browser's, with a cell of its own)
  check(await until("!!window.sagebrush?.workspace", 60000), "(the workspace is open)");
  const made = await ev(`sagebrush.workspace.create("/old.ipynb", { content: { name: "old", mode: "python", cells: [{ id: "c1", type: "code", code: "print('OLD-CELL')" }] } }).then((e) => e.ref)`);
  await go(base + "?nb=" + encodeURIComponent(made));
  check(await until(`localStorage.getItem("sagebrush-current") === ${JSON.stringify(made)}`, 30000), "(the old notebook is open: ?nb=)");
  const oldId = await current();
  const oldName = await name();
  check(typeof oldId === "string" && oldId.length > 0, `(a notebook of this browser's is showing: ${oldId}, "${oldName}")`);

  // ---- a share link pasted into this tab: opened here
  const link = await linkOf(["print('SHARED-CELL')", { md: "# Shared" }], "m=sage&");
  await setHash(link);
  check(await until("document.querySelector('#nbname').value === 'Shared notebook'", 30000), `a share link pasted into this tab opens here: the notebook is "Shared notebook" (${await name()})`);
  const shared = await codes();
  check(shared.includes("print('SHARED-CELL')") && !shared.includes("OLD-CELL"), `…with the shared cells, not the old ones (${shared.slice(0, 120)})`);
  check(await ev("document.querySelector('#mode').value") === "sage", "…in the link's language (m=sage)");
  check(await current() !== oldId, "…as a notebook of its own, not over the one it replaced");
  // (Run all runs the shared cell: its output is the shared notebook's)
  await ev("sagebrush.notebook.runAll().then(() => 1)");
  check(await until("/SHARED-CELL/.test(document.querySelector('#cells').textContent) && [...document.querySelectorAll('#cells .out')].some((o) => o.textContent.includes('SHARED-CELL'))", 90000), "Run all runs the shared notebook's cells");
  check(!(await ev("[...document.querySelectorAll('#cells .out')].some((o) => o.textContent.includes('OLD-CELL'))")), "…and none of the old notebook's");
  // (the notebook it replaced is kept: opened again, its cell as it was)
  await go(base + "?nb=" + encodeURIComponent(oldId));
  check(await until(`localStorage.getItem("sagebrush-current") === ${JSON.stringify(oldId)}`, 30000) && (await codes()).includes("OLD-CELL"), "the notebook it replaced is kept, its cell as it was");

  // ---- a fragment that is no share link: nothing changes
  const before = await current();
  await setHash("#notes");
  await sleep(2500);
  check(await current() === before && (await codes()).includes("OLD-CELL"), "a fragment that is no share link (#notes) changes nothing");

  // ---- a damaged share link: said, and nothing changes
  await setHash("#z=AAAAAAAA");
  check(await until("/could not open the share link/.test(document.querySelector('#status').textContent)", 10000), `a damaged share link says so (${await ev("document.querySelector('#status').textContent")})`);
  check(await current() === before && (await codes()).includes("OLD-CELL"), "…and changes nothing");

  // ---- only the latest fragment counts (astra's SHARE-HASH-STALE-1): A's decode held (the page's shareTest seam), then
  // B: B opens; A, released, opens nothing and says nothing
  const A = await linkOf(["print('LINK-A')"], "m=sage&"), B = await linkOf(["print('LINK-B')"], "m=magma&");
  const hold = (h) => ev(`(() => { const t = sagebrush.shareTest; t.beforeLinkDecode = (h) => h === ${JSON.stringify(h)} ? new Promise((r) => (window.__release = r)) : null; return 1; })()`);
  const release = () => ev("(window.__release?.(), sagebrush.shareTest.beforeLinkDecode = null, 1)");
  const hasCell = (t) => ev(`sagebrush.notebook.cells().some((c) => c.ta.value.includes(${JSON.stringify(t)}))`);
  await go(base + "?nb=" + encodeURIComponent(oldId));
  await hold(A);
  await setHash(A);
  await sleep(300);
  await setHash(B);
  check(await until(`sagebrush.notebook.cells().some((c) => c.ta.value.includes("LINK-B"))`, 30000) && (await ev("document.querySelector('#mode').value")) === "magma", "A held, then B: B opens, in B's language");
  const bId = await current();
  await release();
  await sleep(2500);
  check((await current()) === bId && (await hasCell("LINK-B")) && !(await hasCell("LINK-A")) && (await ev("document.querySelector('#mode').value")) === "magma", "…A, released after B, opens nothing: B stays, in its language");
  // (a fragment that is no share link, after a held one: the held one is dropped)
  await go(base + "?nb=" + encodeURIComponent(oldId));
  await hold(A);
  await setHash(A);
  await sleep(300);
  await setHash("#notes");
  await release();
  await sleep(2500);
  check((await current()) === oldId && (await hasCell("OLD-CELL")) && !(await hasCell("LINK-A")), "a held link, then a fragment that is no share link: the held one is dropped");
  // (an explicit open while a link is held: the open wins, and the released link doesn't replace it)
  const other = await ev(`sagebrush.workspace.create("/other.ipynb", { content: { name: "other", mode: "python", cells: [{ id: "c1", type: "code", code: "print('OTHER-CELL')" }] } }).then((e) => e.ref)`);
  await go(base + "?nb=" + encodeURIComponent(oldId));
  await hold(A);
  await setHash(A);
  await sleep(300);
  await ev(`sagebrush.open(${JSON.stringify(other)}).then(() => 1)`);
  check(await until(`localStorage.getItem("sagebrush-current") === ${JSON.stringify(other)}`, 30000), "(an explicit open while a link is held)");
  await release();
  await sleep(2500);
  check((await current()) === other && (await hasCell("OTHER-CELL")) && !(await hasCell("LINK-A")), "…the explicit open wins: the released link doesn't replace it");
  // (a damaged link held, then a good one: the good one opens, and the damaged one's error, when released, isn't said)
  await go(base + "?nb=" + encodeURIComponent(oldId));
  await hold("#z=AAAAAAAA");
  await setHash("#z=AAAAAAAA");
  await sleep(300);
  await setHash(B);
  check(await until(`sagebrush.notebook.cells().some((c) => c.ta.value.includes("LINK-B"))`, 30000), "(a damaged link held, then B: B opens)");
  await ev("(document.querySelector('#status').textContent = 'B-OPENED', 1)");
  await release();
  await sleep(2500);
  check(!/could not open the share link/.test(await ev("document.querySelector('#status').textContent")), "…the damaged link's error, released after, doesn't overwrite the newer status");

  // ---- a control: the same link in a fresh load opens it too (the path at load)
  await go(base + link);
  check(await until("document.querySelector('#nbname').value === 'Shared notebook'", 30000) && (await codes()).includes("SHARED-CELL"), "(control: the same link in a fresh load opens it)");
} catch (e) {
  check(false, "the test ran: " + String(e?.stack ?? e).slice(0, 400));
} finally {
  chrome.kill(); serve.kill();
  await sleep(300);
  rmSync(tmp, { recursive: true, force: true });
}
console.log(fails.length ? `${fails.length} failed` : "all passed");
process.exit(fails.length ? 1 : 0);
