// ci: web-runner order=174 chrome
// The reader's copy of a GitHub notebook (/gh/..., web/share-client/view.ts with the workspace's ghSource), end to end
// in Chromium against the built site (web/serve.py), with GitHub answered by this test (CDP Fetch) from the fixtures
// (web/gh/fixtures/math-repo, as o/math-notebooks's examples/notebooks, as web/gh/test-gh-page.mjs serves them), in two
// tabs of one browser profile, which share its files. What it shows:
//   - the copy's source is recorded with it, by its identity (the notebook's ref, a data file's fid): the repository,
//     the ref and commit, the path, its listed git blob id, and the files that stayed on GitHub;
//   - each time the copy opens, its line names the files that stayed on GitHub, from that record;
//   - GitHub's version newer than the copy's commit, at the same ref: "Newer on GitHub (<commit>): open it", which
//     opens GitHub's version, never merges;
//   - a renamed copy is still found; one put in Trash isn't (the next edit makes a fresh one); a notebook of the
//     reader's own at the copy's path is never taken for it;
//   - one tab at a time makes a copy (it waits while another holds the copy's lock); a second tab's first edit, when
//     another tab made the copy meanwhile, is a conflict, said, and never a second copy; two tabs' first edits at once
//     make one copy, holding one tab's edit whole; and with this browser's note of the copy cleared, the first edit
//     finds the copy there and says so.
//   bun web/build.ts && CHROME=chromium node web/gh/test-gh-copy.mjs
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devtoolsPort } from "../test-port.mjs";

const here = new URL(".", import.meta.url).pathname;
let failures = 0, checks = 0;
const ok = (c, msg, detail) => { checks++; console.log((c ? "ok   " : "FAIL ") + msg + (c || detail === undefined ? "" : " " + JSON.stringify(detail).slice(0, 500))); if (!c) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- the stand-in repository: o/math-notebooks, its branch main at `head` (C, or C2 once it has moved)
const C = "0123456789abcdef0123456789abcdef01234567", C2 = "89abcdef0123456789abcdef0123456789abcdef";
let head = C;
const fx = (f) => readFileSync(join(here, "fixtures", "math-repo", f));
const DIR = "examples/notebooks/";
const FILES = { [DIR + "count-zeros.ipynb"]: fx("count-zeros.ipynb"), [DIR + "NOTES.txt"]: fx("NOTES.txt"), [DIR + "zeta_zeros_1000.txt"]: fx("zeta_zeros_1000.txt"),
  // (enough files below the notebook's folder to pass the copy's 20-file cap: 3 stay on GitHub)
  ...Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`${DIR}data/p${String(i + 1).padStart(2, "0")}.txt`, Buffer.from(`pad ${i + 1}\n`)])) };
const blobId = (b) => createHash("sha1").update(Buffer.concat([Buffer.from(`blob ${b.length}\0`), b])).digest("hex");
const TREE = { sha: "t".repeat(40), truncated: false, tree: [{ path: "examples", mode: "040000", type: "tree", sha: "a".repeat(40) }, { path: "examples/notebooks", mode: "040000", type: "tree", sha: "b".repeat(40) },
  ...Object.entries(FILES).map(([path, b]) => ({ path, mode: "100644", type: "blob", sha: blobId(b), size: b.length }))].sort((a, b) => (a.path < b.path ? -1 : 1)) };
const CORS = [{ name: "Access-Control-Allow-Origin", value: "*" }];
function answer(url) {
  const u = new URL(url);
  const json = (code, body) => ({ responseCode: code, responseHeaders: [...CORS, { name: "Content-Type", value: "application/json" }], body: Buffer.from(JSON.stringify(body)) });
  if (u.host === "api.github.com") {
    if (u.pathname === "/repos/o/math-notebooks/commits/main") return { responseCode: 200, responseHeaders: [...CORS, { name: "Content-Type", value: "application/vnd.github.sha" }], body: Buffer.from(head) };
    if ([C, C2].some((c) => u.pathname === `/repos/o/math-notebooks/git/trees/${c}`)) return json(200, TREE);
    return json(404, { message: "Not Found" });
  }
  if (u.host === "raw.githubusercontent.com") {
    const m = /^\/o\/math-notebooks\/([0-9a-f]{40})\/(.+)$/.exec(u.pathname), p = m && decodeURIComponent(m[2]);
    if (!m || ![C, C2].includes(m[1]) || !FILES[p]) return { responseCode: 404, responseHeaders: CORS, body: Buffer.from("404: Not Found") };
    return { responseCode: 200, responseHeaders: [...CORS, { name: "Content-Type", value: "text/plain; charset=utf-8" }], body: FILES[p] };
  }
  return null;
}

// ---- the built site, as web/serve.py serves it
const server = spawn("python3", ["-u", join(here, "..", "serve.py"), "0"], { stdio: ["ignore", "pipe", "inherit"] });
const sport = await new Promise((res, rej) => { let acc = ""; server.stdout.on("data", (b) => { acc += b; const m = /(\d{2,5})/.exec(acc); if (m) res(+m[1]); }); setTimeout(() => rej(new Error("no server port")), 15000); });
const origin = `http://127.0.0.1:${sport}`;
let cdp = Number(process.env.CDP_PORT) || 0;
const profile = mkdtempSync(join(tmpdir(), "sb-gh-copy-"));
const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", `--remote-debugging-port=${cdp}`, "--window-size=1300,900", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });

// (a tab, driven over its own DevTools socket, its GitHub answered by `answer`)
async function tab(wsUrl) {
  const sock = new WebSocket(wsUrl);
  await new Promise((r) => (sock.onopen = r));
  let n = 0;
  const waiting = new Map();
  const send = (method, params = {}) => new Promise((r) => { const id = ++n; waiting.set(id, r); sock.send(JSON.stringify({ id, method, params })); });
  sock.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); }
    if (m.method === "Fetch.requestPaused") {
      const a = answer(m.params.request.url);
      if (!a) return void send("Fetch.continueRequest", { requestId: m.params.requestId });
      void send("Fetch.fulfillRequest", { requestId: m.params.requestId, responseCode: a.responseCode, responseHeaders: a.responseHeaders, body: a.body.toString("base64") });
    }
  };
  const ev = async (expr) => { const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }); if (!r.result || r.result.exceptionDetails) throw new Error(JSON.stringify(r.result?.exceptionDetails ?? r.error ?? r).slice(0, 400)); return r.result.result.value; };
  const until = async (expr, ms = 30000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(expr).catch(() => false)) return true; await sleep(150); } return false; };
  const text = (sel) => ev(`document.querySelector(${JSON.stringify(sel)})?.textContent ?? ""`);
  for (const m of ["Page.enable", "Runtime.enable"]) await send(m);
  await send("Fetch.enable", { patterns: ["https://api.github.com/*", "https://raw.githubusercontent.com/*"].map((urlPattern) => ({ urlPattern, requestStage: "Request" })) });
  // (the notebook page, opened and shown)
  const open = async () => {
    await ev("window.__old = 1").catch(() => {});
    await send("Page.navigate", { url: `${origin}/gh/o/math-notebooks/blob/main/${DIR}count-zeros.ipynb` });
    await sleep(300);
    return (await until("!window.__old && document.readyState === 'complete'")) && until(`!document.querySelector("#nb").hidden && !!document.querySelector("#nb textarea")`, 60000);
  };
  // (an edit to the first code cell: the reader's first change, which makes the copy)
  const edit = (line) => ev(`(() => { const ta = document.querySelector('#nb .cell:not(.md) textarea') ?? [...document.querySelectorAll('#nb textarea')].pop(); ta.value += ${JSON.stringify("\n" + line)}; ta.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  // (the reader's files, through the page's own workspace module)
  const ws = (body) => ev(`(async () => { const ws = await (await import("/sagebrush-share-copy.js")).openWorkspace(); ${body} })()`);
  return { send, ev, until, text, open, edit, ws };
}

try {
  if (!cdp) cdp = await devtoolsPort(profile);
  let targets;
  for (let i = 0; i < 300; i++) { try { targets = await (await fetch(`http://127.0.0.1:${cdp}/json`)).json(); break; } catch { await sleep(100); } }
  const A = await tab(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
  const { result: { targetId } } = await A.send("Target.createTarget", { url: "about:blank" });
  for (let i = 0; i < 100 && !(targets = await (await fetch(`http://127.0.0.1:${cdp}/json`)).json()).some((t) => t.id === targetId); i++) await sleep(100);
  const B = await tab(targets.find((t) => t.id === targetId).webSocketDebuggerUrl);
  const COPY = `/GitHub/o/math-notebooks/${DIR}count-zeros.ipynb`;
  const LEFT = ["data/p19.txt", "data/p20.txt", "data/p21.txt"];
  const leftLine = `3 files of its folder stayed on GitHub (over the copy's limit of 20 files or 10 MB): ${LEFT.join(", ")}.`;
  // (the reader's notebooks named count-zeros, out of Trash)
  const mine = () => A.ws(`return (await ws.list("/GitHub/o/math-notebooks/${DIR}")).filter((e) => e.kind === "notebook").map((e) => e.path).sort();`);
  const sourceOf = (p) => A.ws(`const e = await ws.stat(${JSON.stringify(p)}); return e ? { ref: e.ref, src: await ws.ghSource("notebook", e.ref) } : null;`);
  const cellsOf = (p) => A.ws(`return JSON.stringify((await ws.read(${JSON.stringify(p)})).content.cells);`);

  // ---- the first edit: the copy, its source recorded with it
  ok(await A.open(), "a GitHub notebook's page opens");
  await A.edit("print('first')");
  ok(await A.until(`/kept in this browser at ${COPY.replace(/[/.]/g, "\\$&")}/.test(document.querySelector("#copyline").textContent)`, 60000), "the first edit makes the copy", await A.text("#copyline"));
  ok(await A.until(`document.querySelector("#copyline .left")?.textContent === ${JSON.stringify(leftLine)}`), "the copy's line names the 3 files that stayed on GitHub", await A.text("#copyline"));
  const s1 = await sourceOf(COPY);
  ok(JSON.stringify(s1?.src) === JSON.stringify({ owner: "o", repo: "math-notebooks", ref: "main", commit: C, path: DIR + "count-zeros.ipynb", listed: blobId(FILES[DIR + "count-zeros.ipynb"]), left: LEFT.map((p) => DIR + p) }),
    "its source, by the notebook's ref: repository, ref, commit, path, listed git blob id, the files left on GitHub", s1);
  const zeta = await A.ws(`const e = await ws.stat("/GitHub/o/math-notebooks/${DIR}zeta_zeros_1000.txt"); return e && ws.ghSource("file", e.fid);`);
  ok(JSON.stringify(zeta) === JSON.stringify({ owner: "o", repo: "math-notebooks", ref: "main", commit: C, path: DIR + "zeta_zeros_1000.txt", listed: blobId(FILES[DIR + "zeta_zeros_1000.txt"]), left: [] }), "…and each data file copied beside it, by its fid", zeta);

  // (a record that isn't one is refused, never written: each field's shape, no other field, and a copy's id)
  const refused = await A.ws(`const good = { owner: "o", repo: "r", ref: "main", commit: null, path: "a.ipynb", listed: "${"a".repeat(40)}", left: [] };
    const out = [];
    for (const [kind, id, src] of [["notebook", "x", { ...good, commit: "main" }], ["notebook", "x", { ...good, listed: "z" }], ["notebook", "x", { ...good, extra: 1 }], ["notebook", "x", { ...good, path: "a\\nb" }],
      ["notebook", "x", { ...good, left: [""] }], ["folder", "x", good], ["notebook", "a b", good]]) out.push(await ws.setGhSource(kind, id, src).then(() => "written", (e) => e.code));
    out.push(await ws.setGhSource("notebook", "x", good).then(() => "written", (e) => e.code), JSON.stringify(await ws.ghSource("notebook", "x")) === JSON.stringify(good), (await ws.ghSource("file", "x")) === undefined);
    return out;`);
  ok(JSON.stringify(refused) === JSON.stringify([...Array(7).fill("invalid"), "written", true, true]), "a source that isn't one is refused (a commit, a blob id, another field, a control character, an empty path, a kind, an id); one that is reads back, by kind", refused);

  // ---- each time it opens: the line, from the record; GitHub's version newer
  ok(await A.open() && await A.until(`/This is your copy/.test(document.querySelector("#copyline").textContent) && document.querySelector("#copyline .left")?.textContent === ${JSON.stringify(leftLine)}`), "opened again: the copy, and its line names what stayed on GitHub", await A.text("#copyline"));
  ok(await A.ev(`[...document.querySelectorAll("#copyline button")].map((b) => b.textContent).join("|")`) === "Back to GitHub's version", "…GitHub's version no newer: \"Back to GitHub's version\"");
  head = C2;
  ok(await A.open() && await A.until(`[...document.querySelectorAll("#copyline button")].some((b) => b.textContent === "Newer on GitHub (89abcde): open it")`), "main moved on GitHub: \"Newer on GitHub (89abcde): open it\"", await A.text("#copyline"));
  ok((await cellsOf(COPY)).includes("print('first')"), "…the copy as it was, nothing merged");
  await A.ev(`[...document.querySelectorAll("#copyline button")].find((b) => /^Newer on GitHub/.test(b.textContent)).click(), 1`);
  ok(await A.until(`/^This is GitHub's version/.test(document.querySelector("#copyline").textContent) && /Nothing has run yet/.test(document.querySelector("#status").textContent)`), "…which opens GitHub's version", await A.text("#copyline"));
  head = C;

  // ---- renamed: still found; in Trash: not, and the next edit makes a fresh copy
  const RENAMED = `/GitHub/o/math-notebooks/${DIR}renamed.ipynb`;
  await A.ws(`await ws.rename(${JSON.stringify(COPY)}, ${JSON.stringify(RENAMED)}); return 1;`);
  ok(await A.open() && await A.until(`/kept in this browser at ${RENAMED.replace(/[/.]/g, "\\$&")}/.test(document.querySelector("#copyline").textContent)`), "renamed in the reader's files: still found, at its new name", await A.text("#copyline"));
  await A.ws(`await ws.remove(${JSON.stringify(RENAMED)}); return 1;`);
  ok(await A.open() && await A.until(`document.querySelector("#copyline").hidden && /Your first change makes it your own copy/.test(document.querySelector("#status").textContent)`), "put in Trash: no copy (the next change makes one)", { line: await A.text("#copyline"), status: await A.text("#status") });
  // (and a notebook of the reader's own at the copy's path is theirs: the copy goes beside it)
  await A.ws(`await ws.create(${JSON.stringify(COPY)}); return 1;`);
  await A.edit("print('fresh')");
  const FRESH = `/GitHub/o/math-notebooks/${DIR}count-zeros (2).ipynb`;
  ok(await A.until(`/kept in this browser at ${FRESH.replace(/[/.()]/g, "\\$&")}/.test(document.querySelector("#copyline").textContent)`, 60000), "a notebook of the reader's own at its path: a fresh copy beside it, theirs never taken for it", await A.text("#copyline"));
  ok(!(await cellsOf(COPY)).includes("fresh") && (await cellsOf(FRESH)).includes("print('fresh')"), "…theirs untouched, the edit in the copy");
  for (const p of [COPY, FRESH]) await A.ws(`await ws.remove(${JSON.stringify(p)}); return 1;`);

  // ---- one tab at a time: a copy waits while another tab holds the copy's lock
  ok(await A.open() && await B.open(), "the notebook's page in two tabs, no copy in either");
  await B.ev(`navigator.locks.request("sagebrush-gh-copy", () => new Promise((r) => (window.__release = r))), 1`);
  await A.edit("print('A waits')");
  await sleep(1500);
  ok(JSON.stringify(await mine()) === "[]" && (await A.ev(`document.querySelector("#copyline").hidden`)), "while another tab holds the lock, no copy is made", await mine());
  await B.ev("window.__release(), 1");
  ok(await A.until(`/kept in this browser at ${COPY.replace(/[/.]/g, "\\$&")}/.test(document.querySelector("#copyline").textContent)`, 60000), "…then it is, once the lock is free", await A.text("#copyline"));
  // (B opened before A's copy: its first edit finds A's, and is a conflict, never a second copy)
  await B.edit("print('B late')");
  ok(await B.until(`/^You already have a copy of this notebook: reload to open it/.test(document.querySelector("#status").textContent)`, 60000), "the other tab's first edit, the copy made meanwhile: a conflict, said", await B.text("#status"));
  ok(JSON.stringify(await mine()) === JSON.stringify([COPY]), "…one copy, never a second", await mine());
  const kept = await cellsOf(COPY);
  ok(kept.includes("print('A waits')") && !kept.includes("B late"), "…holding the first tab's edit, the other's not written over it");
  await B.edit("print('B again')");
  await sleep(1500);
  ok(!(await cellsOf(COPY)).includes("B again"), "…nor its next edit");
  ok(await B.open() && await B.until(`/This is your copy/.test(document.querySelector("#copyline").textContent)`) && (await B.ev(`document.querySelector("#nb").textContent`)).includes("A waits"), "reloaded, the other tab opens the copy");
  await A.ws(`await ws.remove(${JSON.stringify(COPY)}); return 1;`);

  // ---- two tabs' first edits at once: one copy, one tab's edit whole
  ok(await A.open() && await B.open(), "again, two tabs, no copy");
  await Promise.all([A.edit("print('race A')"), B.edit("print('race B')")]);
  ok(await A.until(`!!document.querySelector("#copyline:not([hidden])") || /already have a copy/.test(document.querySelector("#status").textContent)`, 60000) && await B.until(`!!document.querySelector("#copyline:not([hidden])") || /already have a copy/.test(document.querySelector("#status").textContent)`, 60000), "both tabs' first edits answered");
  await sleep(1000);
  const one = await mine(), cells = one.length === 1 ? await cellsOf(one[0]) : "";
  const conflicts = [await A.text("#status"), await B.text("#status")].filter((s) => /^You already have a copy of this notebook/.test(s)).length;
  ok(JSON.stringify(one) === JSON.stringify([COPY]), "one copy", one);
  ok(cells.includes("race A") !== cells.includes("race B") && conflicts === 1, "…holding one tab's edit, the other tab told its change isn't saved", { conflicts, a: cells.includes("race A"), b: cells.includes("race B") });

  // ---- the copy still there, but this browser's note of it cleared (its site data, in part): found by its record,
  // and said so; no second copy, nothing written over
  await A.ev(`localStorage.removeItem("sagebrush-gh-copies"), localStorage.removeItem("sagebrush-share-copies"), 1`);
  ok(await A.open() && (await A.ev(`document.querySelector("#copyline").hidden`)), "the note cleared: the page opens GitHub's version");
  await A.edit("print('after clearing')");
  ok(await A.until(`document.querySelector("#status").textContent === "You already have a copy of this notebook: reload to open it (this change isn't saved)."`, 60000), "…the first edit finds the copy there: said so, nothing about another tab", await A.text("#status"));
  ok(JSON.stringify(await mine()) === JSON.stringify([COPY]) && !(await cellsOf(COPY)).includes("after clearing"), "…one copy, the edit not written into it", await mine());
  ok(await A.open() && await A.until(`/This is your copy/.test(document.querySelector("#copyline").textContent)`), "…and a reload opens the copy");
} catch (e) {
  ok(false, "the test ran: " + (e?.stack ?? e));
} finally {
  const exited = new Promise((r) => (chrome.exitCode !== null ? r() : chrome.once("exit", r)));
  chrome.kill();
  server.kill();
  await exited;
}
console.log(failures ? `FAIL: ${failures} of ${checks}` : `all ${checks} passed`);
process.exit(failures ? 1 : 0);
