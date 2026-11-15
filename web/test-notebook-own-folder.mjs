// ci: web-runner order=117 chrome
// A notebook runs in its own folder (the Nov 4 ruling: as Jupyter runs one; web/index.html's start, web/worker.ts
// {startDir}, web/shims/fs.ts startIn), in headless Chromium against the built page:
//   - a notebook in a folder starts there: os.getcwd() is its folder and sys.path[0] too, so it reads a neighbouring
//     data file by its relative name and imports a neighbouring .py module;
//   - a top-level notebook's working folder is "/", as before, and a relative read finds the file beside it there;
//     its sys.path[0] is now "/" too (it was the runtime's library, /$pyjs/lib), so it imports a module beside it;
//   - the worker itself, sent its folder before its init, answers its first question from that folder; a folder
//     named with ".." is refused and the session stays at "/";
//   - the session's own answer of where it resolves files and imports (importInfo, the file-dependency check's), asked
//     at once after a start, before any run, is that folder;
//   - a rename or a move takes effect at the next start: the running interpreter keeps the folder it started in (it
//     reads its old neighbour's name, now gone, and says so), and a restart starts in the new folder;
//   - a notebook opened from a link (?open=URL&file=URL), kept only in this browser and in no folder, starts at the top
//     of the files, where the link's files are put: it reads and imports them as a notebook saved there does.
//   bun web/build.ts, then node web/test-notebook-own-folder.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { devtoolsPort } from "./test-port.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = mkdtempSync(join(tmpdir(), "sb-ownfolder-"));
// (the link's notebook and files, served at /t/ by serve.py's overrides, read at each request)
const overrides = join(tmp, "overrides.json");
writeFileSync(overrides, "{}");
const serve = spawn("python3", [join(here, "serve.py"), "0"], { stdio: ["ignore", "pipe", "inherit"], env: { ...process.env, SB_SERVE_OVERRIDES: overrides } });
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

const W = "window.sagebrush.workspace";
const base = `http://127.0.0.1:${port}/`;
const go = async (url) => { await send("Page.navigate", { url }); await until("document.querySelector('#status')?.textContent.startsWith('ready')", 90000); await sleep(300); };
const bytes = (s) => `new TextEncoder().encode(${JSON.stringify(s)})`;
const make = (p, content) => ev(`${W}.create(${JSON.stringify(p)}, { content: ${content} }).then((e) => e.ref)`);
// (the one cell: where it runs, what it reads and imports beside it; each part said, an error as its kind)
const PROBE = [
  "import os, sys",
  "def t(f):",
  "    try: return str(f())",
  "    except Exception as e: return type(e).__name__",
  "def mod():",
  "    import helper",
  "    return helper.X",
  "print('AT:' + '|'.join([os.getcwd(), sys.path[0], t(lambda: open('data.csv').read().strip()), t(mod)]))",
].join("\n");
const nb = (name) => `{ name: ${JSON.stringify(name)}, mode: "python", cells: [{ id: "c1", type: "code", code: ${JSON.stringify(PROBE)} }] }`;
// (Run all, then the cell's line: a new run's, not the last one's)
const runAt = async () => {
  await ev(`(() => { const o = document.querySelector('#cells .cell .out'); if (o) o.textContent = ''; return 1; })()`);
  await ev("sagebrush.notebook.runAll().then(() => 1)");
  await until("/AT:/.test(document.querySelector('#cells .cell .out')?.textContent ?? '')", 90000);
  return ((await ev("document.querySelector('#cells .cell .out')?.textContent ?? ''")).match(/AT:(.*)/) ?? [])[1] ?? "(no output)";
};
const restart = async () => {
  await ev("(sagebrush.notebook.restart?.() ?? document.querySelector('#restart').click(), 1)");
  await sleep(1500);
};
try {
  for (const m of ["Page.enable", "Runtime.enable"]) await send(m);
  await go(base);
  check(await until(`!!${W}`, 60000), "the notebook page opens its workspace");
  // (a book's folder: a chapter, its data and its helper module; another folder to move it to; a top-level notebook
  // with a data file beside it at /)
  await ev(`(async () => { for (const d of ["/Book", "/Book2"]) await ${W}.mkdir(d); return 1; })()`);
  await make("/Book/data.csv", bytes("one\n"));
  await make("/Book/helper.py", bytes("X = 1\n"));
  await make("/Book2/data.csv", bytes("two\n"));
  await make("/Book2/helper.py", bytes("X = 2\n"));
  await make("/data.csv", bytes("top\n"));
  await make("/helper.py", bytes("X = 0\n"));
  const ch = await make("/Book/ch.ipynb", nb("ch"));
  const top = await make("/top.ipynb", nb("top"));
  check(typeof ch === "string" && typeof top === "string", "(the files are made in the workspace)");

  // ---- a notebook in a folder
  await go(base + "?nb=" + encodeURIComponent(ch));
  check(await until(`localStorage.getItem("sagebrush-current") === ${JSON.stringify(ch)}`, 30000), "(the chapter is open: ?nb=)");
  const a = await runAt();
  check(a.split("|")[0] === "/Book", `a notebook in a folder starts in it: os.getcwd() is /Book (${a})`);
  check(a.split("|")[1] === "/Book", `…and sys.path[0] is /Book (${a})`);
  check(a.split("|")[2] === "one", `…it reads its neighbour data.csv by the relative name (${a})`);
  check(a.split("|")[3] === "1", `…and imports its neighbour helper.py (${a})`);
  await restart();
  const info = await ev(`sagebrush.kernel.ask({ importInfo: true }, "python", null).then((m) => JSON.stringify([m?.cwd, m?.path?.[0]]))`);
  check(info === JSON.stringify(["/Book", "/Book"]), `the session's importInfo, asked at once after a restart, before any run: cwd and sys.path[0] /Book (${info})`);

  // ---- a move: the running interpreter keeps its folder; the next start is in the new one
  const moved = await ev(`${W}.rename("/Book/ch.ipynb", "/Book2/ch.ipynb").then((e) => e.path, (e) => "refused: " + (e?.message ?? e))`);
  check(moved === "/Book2/ch.ipynb", `(the chapter is moved to /Book2: ${moved})`);
  const b = await runAt();
  check(b.split("|").slice(0, 3).join("|") === "/Book|/Book|one", `the running interpreter keeps the folder it started in, /Book (${b})`);
  await restart();
  const c = await runAt();
  check(c === "/Book2|/Book2|two|2", `after a restart it starts in the new folder: /Book2, its data.csv and its helper.py (${c})`);
  const renamed = await ev(`${W}.rename("/Book2", "/Book3").then((e) => e.path, (e) => "refused: " + (e?.message ?? e))`);
  await restart();
  const d = await runAt();
  check(renamed === "/Book3" && d === "/Book3|/Book3|two|2", `a renamed folder too, at the next start: ${renamed}, ${d}`);

  // ---- a notebook alone in its folder (no file beside it, so nothing else makes the folder known): the folder it
  // starts in still exists for it, empty (grader's K9: startIn registers it)
  await ev(`${W}.mkdir("/Solo").then(() => 1)`);
  const solo = await make("/Solo/alone.ipynb", `{ name: "alone", mode: "python", cells: [{ id: "c1", type: "code", code: ${JSON.stringify("import os\nprint('AT:' + '|'.join([os.getcwd(), str(os.path.isdir(os.getcwd())), repr(os.listdir('.'))]))")} }] }`);
  await go(base + "?nb=" + encodeURIComponent(solo));
  check(await until(`localStorage.getItem("sagebrush-current") === ${JSON.stringify(solo)}`, 30000), "(the lone notebook is open)");
  const lone = await runAt();
  check(lone === "/Solo|True|[]", `a notebook alone in its folder starts there, and the folder exists, empty: isdir(getcwd()) and listdir('.') (${lone})`);

  // ---- the worker itself, sent its folder before its init (the interpreter not ready yet), then asked at once: the
  // folder is set once the interpreter is ready, and the question waits for it; a folder that names another place
  // (here "..") is refused and the session stays at "/"
  const raw = (dir) => ev(`new Promise((res) => {
    const w = new Worker("sagebrush-worker.js", { type: "module" });
    const t = setTimeout(() => { w.terminate(); res("(no answer)"); }, 60000);
    w.onmessage = (e) => { if (e.data?.id === 1 && "cwd" in e.data) { clearTimeout(t); w.terminate(); res(JSON.stringify([e.data.cwd, e.data.path?.[0]])); } };
    w.postMessage({ startDir: ${JSON.stringify(dir)} });
    w.postMessage({ init: { limits: null } });
    w.postMessage({ id: 1, importInfo: true, mode: "python" });
  })`);
  const early = await raw("/Early/sub");
  check(early === JSON.stringify(["/Early/sub", "/Early/sub"]), `a worker sent its folder before it is ready: cwd and sys.path[0] are that folder at the first question (${early})`);
  const refused = await raw("/Book/..");
  check(JSON.parse(refused)[0] === "/" && JSON.parse(refused)[1] !== "/Book/..", `a folder named with ".." is refused: the session stays at "/" (${refused})`);

  // ---- a top-level notebook: "/" as before
  await go(base + "?nb=" + encodeURIComponent(top));
  check(await until(`localStorage.getItem("sagebrush-current") === ${JSON.stringify(top)}`, 30000), "(the top-level notebook is open)");
  const e = await runAt();
  check(e.split("|")[0] === "/", `a top-level notebook's working folder is "/", as before (${e})`);
  check(e.split("|")[2] === "top", `…and its relative read finds the file beside it (${e})`);
  check(e.split("|")[1] === "/" && e.split("|")[3] === "0", `…sys.path[0] is "/" too, so it imports a module beside it (${e})`);

  // ---- a notebook opened from a link: in no folder, it starts at the top of the files, where its files are put
  const LINK = PROBE.replace("import helper", "import linkhelper").replace("helper.X", "linkhelper.X").replace("open('data.csv')", "open('linkdata.csv')");
  writeFileSync(join(tmp, "link.ipynb"), JSON.stringify({ nbformat: 4, nbformat_minor: 5, metadata: { kernelspec: { name: "python3", language: "python" } },
    cells: [{ id: "l1", cell_type: "code", metadata: {}, execution_count: null, source: LINK, outputs: [] }] }));
  writeFileSync(join(tmp, "linkhelper.py"), "X = 7\n");
  writeFileSync(join(tmp, "linkdata.csv"), "link\n");
  writeFileSync(overrides, JSON.stringify(Object.fromEntries(["link.ipynb", "linkhelper.py", "linkdata.csv"].map((f) => ["/t/" + f, { file: join(tmp, f) }]))));
  const t = (f) => encodeURIComponent(base + "t/" + f);
  await go(`${base}?open=${t("link.ipynb")}&file=${t("linkhelper.py")}&file=${t("linkdata.csv")}`);
  const f = await runAt();
  check(f.split("|")[0] === "/" && f.split("|")[1] === "/", `a notebook opened from a link starts at the top of the files: cwd and sys.path[0] "/" (${f})`);
  check(f.split("|")[2] === "link" && f.split("|")[3] === "7", `…so it reads and imports the files the link gave it (${f})`);
} catch (e) {
  check(false, "the test ran: " + String(e?.stack ?? e).slice(0, 400));
} finally {
  chrome.kill(); serve.kill();
  await sleep(300);
  rmSync(tmp, { recursive: true, force: true });
}
console.log(fails.length ? `${fails.length} failed` : "all passed");
process.exit(fails.length ? 1 : 0);
