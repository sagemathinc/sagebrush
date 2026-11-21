// ci: web-runner order=198 runner=bun chrome
// A Delegate task's proposal for the person to read (proposal-view.ts), in a real browser, from a fake source (the
// page's view of the host's tasks.diff and tasks.file): its list, each kind of file's diff, the notebook as proposed
// (read only, no code run, outputs filtered), its bounds, a failing source, one open at a time, close, and the host
// page's actions at its foot.
//   CHROME=google-chrome bun web/workspace/review/test-proposal-view.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devtoolsPort } from "../../test-port.mjs";

const here = new URL("..", import.meta.url).pathname;
const site = mkdtempSync(join(tmpdir(), "sb-proposal-site-"));
writeFileSync(join(site, "entry.ts"), `export { openProposal, PROPOSAL_TEXT, PROPOSAL_LIMITS } from ${JSON.stringify(join(here, "review", "proposal-view.ts"))};`);
const built = await Bun.build({ entrypoints: [join(site, "entry.ts")], outdir: site, naming: "pv.js", target: "browser", format: "esm" });
if (!built.success) { console.error(built.logs.join("\n")); process.exit(1); }
const nbBuilt = await Bun.build({ entrypoints: [join(here, "..", "notebook", "index.js")], outdir: site, naming: "nb.js", target: "browser", format: "esm" });
if (!nbBuilt.success) { console.error(nbBuilt.logs.join("\n")); process.exit(1); }

// (the documents: an ipynb whose proposal changes a cell, adds one with a picture, an html output and a script, and
//  a text file, a deleted file, an added file and a picture)
const nb = (cells) => JSON.stringify({ nbformat: 4, nbformat_minor: 5, metadata: { kernelspec: { name: "python3" } }, cells });
const code = (id, src, outputs = []) => ({ id, cell_type: "code", source: src, outputs, execution_count: outputs.length ? 1 : null, metadata: {} });
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const FILES = {
  base: {
    "nb.ipynb": nb([code("c1", "x = 1"), code("c2", "print(x)"), { id: "m1", cell_type: "markdown", source: "# Title", metadata: {} }]),
    "notes.txt": "one\ntwo\nthree\n",
    "old.txt": "gone\n",
  },
  proposal: {
    "nb.ipynb": nb([code("c1", "x = 2"), code("c2", "print(x)"), code("c3", "plot()", [
      { output_type: "display_data", data: { "image/png": PNG, "text/plain": "<Figure>" }, metadata: {} },
      { output_type: "display_data", data: { "text/html": "<b id=planted>bold</b><img src=x onerror=\"window.__ran=1\"><script>window.__ran=2</script>" }, metadata: {} },
    ]), { id: "m1", cell_type: "markdown", source: "# Title", metadata: {} }]),
    "notes.txt": "one\nTWO\nthree\n",
    "new.md": "fresh\n",
    "pic.png": "\x89PNG...",
  },
};
const LIST = { base: "1111111aaaaaaaa", proposal: "2222222bbbbbbbb", round: 2, seq: 9, files: [
  { path: "nb.ipynb", kind: "notebook", change: "modified" },
  { path: "notes.txt", kind: "text", change: "modified" },
  { path: "old.txt", kind: "text", change: "deleted" },
  { path: "new.md", kind: "text", change: "added" },
  { path: "pic.png", kind: "file", change: "added" },
] };
// (inlined into the page's script: "<" escaped, so a "</script>" in a document can't end it)
const safe = (v) => JSON.stringify(v).replace(/</g, "\\u003c");
writeFileSync(join(site, "index.html"), `<!doctype html><meta charset="utf-8"><title>proposal test</title><div id="p"></div><script type="module">
import { openProposal, PROPOSAL_TEXT, PROPOSAL_LIMITS } from "./pv.js";
const FILES = ${safe(FILES)}, LIST = ${safe(LIST)};
const commitSide = (c) => (c === LIST.base ? "base" : c === LIST.proposal ? "proposal" : null);
window.T = PROPOSAL_TEXT; window.L = PROPOSAL_LIMITS;
window.reads = [];
window.calls = { fromFile: 0, mount: 0 };
// (a notebook's .ipynb text padded with trailing spaces (JSON allows them) to exactly n UTF-8 bytes; with fill, a
//  multibyte character repeated in a cell first, so its length in UTF-16 units is far under its bytes)
window.padded = (n, fill) => {
  const head = JSON.parse(FILES.proposal["nb.ipynb"]);
  if (fill) head.cells[0].source = fill;
  const t = JSON.stringify(head), bytes = new TextEncoder().encode(t).length;
  return bytes > n ? t : t + " ".repeat(n - bytes);
};
window.make = (o = {}) => ({
  diff: async () => { if (o.failDiff) throw new Error("no"); return o.list ?? LIST; },
  file: async (path, commit) => {
    window.reads.push(path + "@" + commit.slice(0, 7));
    if (o.slow?.[path]) await new Promise((r) => setTimeout(r, o.slow[path]));
    if (o.big === path) return "x".repeat(PROPOSAL_LIMITS.bytes + 1);
    if ((o.nbBytes || o.nbFill) && path === "nb.ipynb") return window.padded(o.nbBytes ?? 0, o.nbFill);
    // (under the bound in UTF-16 units, over it in UTF-8 bytes: 3 bytes each)
    if (o.wide === path) return "\u4e00".repeat(Math.floor(PROPOSAL_LIMITS.bytes / 2));
    const side = commitSide(commit);
    return side ? FILES[side][path] ?? null : null;
  },
});
window.open1 = (o, withActions) => {
  const p = document.getElementById("p");
  const actions = withActions ? Object.assign(document.createElement("div"), { id: "acts", textContent: "ACTIONS" }) : undefined;
  window.view?.close();
  window.view = openProposal(window.make(o), p, { notebook: () => import("./nb.js").then((m) => ({ ...m, fromFile: (...a) => { window.calls.fromFile++; return m.fromFile(...a); }, createNotebook: (...a) => { window.calls.mount++; return m.createNotebook(...a); } })), actions });
  return true;
};
window.clickFile = (path) => { [...document.querySelectorAll("#p .file .path")].find((b) => b.textContent === path).click(); return true; };
window.ready = true;
</script>`);
const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => {
  const p = new URL(req.url).pathname;
  if (!["/", "/pv.js", "/nb.js"].includes(p)) return new Response("not found", { status: 404 });
  return new Response(Bun.file(join(site, p === "/" ? "index.html" : p.slice(1))), { headers: { "content-type": p.endsWith(".js") ? "text/javascript" : "text/html" } });
} });
const url = `http://127.0.0.1:${server.port}/`;

let port = Number(process.env.CDP_PORT) || 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = mkdtempSync(join(tmpdir(), "sb-proposal-"));
const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
process.on("exit", () => { try { chrome.kill(); } catch {} });
const fails = [];
let checks = 0;
const ok = (cond, what, got) => { checks++; if (!cond) fails.push(`${what}${got === undefined ? "" : `  ${JSON.stringify(got).slice(0, 300)}`}`); if (process.env.SHOW) console.log((cond ? "  ok   " : "  FAIL ") + what); };

let code1 = 1;
try {
  if (!port) port = await devtoolsPort(profile);
  for (let i = 0; i < 300; i++) { try { await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); break; } catch {} await sleep(100); }
  const t = await (await fetch(`http://127.0.0.1:${port}/json/new?${url}`, { method: "PUT" })).json();
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let n = 0;
  const waiting = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result ?? m.error); waiting.delete(m.id); }
    if (m.method === "Runtime.exceptionThrown") fails.push("page error: " + (m.params.exceptionDetails?.exception?.description ?? "").slice(0, 300));
  };
  const send = (method, params = {}) => Promise.race([
    new Promise((r) => { const id = ++n; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params })); }),
    sleep(15000).then(() => { throw new Error(`no answer to ${method}`); }),
  ]);
  const ev = async (expression) => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300)); return r.result.value; };
  const until = async (expr, ms = 10000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await ev(expr).catch(() => false)) return true; await sleep(50); } return false; };
  await send("Runtime.enable");
  await until("window.ready === true");

  // ---- the list
  await ev("window.open1({}, true)");
  await until("document.querySelectorAll('#p .file').length === 5");
  const head = await ev(`({ h: document.querySelector('#p h3')?.textContent, st: document.querySelector('#p .st')?.textContent, rows: [...document.querySelectorAll('#p .file')].map((r) => r.textContent), acts: document.querySelector('#p .sbpv > #acts')?.textContent ?? null })`);
  ok(head.h === "Proposal, round 2" && head.st === "5 files changed · from 1111111 to 2222222", "the header: its round, its files and both commits, short", head);
  ok(head.rows.join("|") === "nb.ipynb changed|notes.txt changed|old.txt deleted|new.md added|pic.png added", "each changed file a row, with its change", head.rows);
  ok(head.acts === "ACTIONS", "the host page's actions at the foot", head.acts);
  ok((await ev("window.reads.length")) === 0, "nothing read before a file is opened", await ev("window.reads"));

  // ---- a notebook: cell by cell, and as proposed
  await ev("window.clickFile('nb.ipynb')");
  await until("!!document.querySelector('#p details .sbnb, #p details .nb-root, #p details .cell textarea')", 15000);
  const nbv = await ev(`(() => { const f = [...document.querySelectorAll('#p .file')][0]; return { chg: f.querySelectorAll('.cell.chg').length, add: f.querySelectorAll('.cell.add').length, del: f.querySelectorAll('.cell.del').length, folds: [...f.querySelectorAll('.fold')].map((x) => x.textContent), diffText: [...f.querySelectorAll('.cell pre.diff')].map((p) => p.textContent), summary: f.querySelector('details summary')?.textContent, reads: window.reads.slice() }; })()`);
  ok(nbv.chg === 1 && nbv.add === 1 && nbv.del === 0, "a notebook's diff: the changed cell and the added one", nbv);
  ok(nbv.diffText.some((t) => /- x = 1/.test(t) && /\+ x = 2/.test(t)) && nbv.diffText.some((t) => /\+ plot\(\)/.test(t)), "the changed cell's line diff, the added cell's code", nbv.diffText);
  ok(nbv.reads.join() === "nb.ipynb@1111111,nb.ipynb@2222222", "both sides read, at the base and the proposal commits", nbv.reads);
  ok(nbv.summary === "The notebook as proposed", "the notebook as proposed, under its own heading", nbv.summary);
  await sleep(800);
  const mount = await ev(`(() => { const d = document.querySelector('#p details'); d.open = true; const imgs = [...d.querySelectorAll('img')].map((i) => i.getAttribute('src')?.slice(0, 22)); const btns = [...d.querySelectorAll('button')]; return { imgs, enabled: btns.filter((b) => !b.disabled).length, scripts: d.querySelectorAll('script').length, ran: window.__ran ?? null, planted: !!document.getElementById('planted'), h1: d.querySelectorAll('h1').length, rawTitle: [...d.querySelectorAll('textarea, pre, .raw, code')].some((e) => /# Title/.test(e.value ?? e.textContent)), editable: [...d.querySelectorAll('textarea')].filter((t) => !t.readOnly && !t.disabled).length }; })()`);
  ok(mount.imgs.some((s) => s?.startsWith("data:image/png")) && mount.scripts === 0 && mount.ran === null, "the notebook as proposed: its picture shown; its html output's script and onerror never run", mount);
  ok(!mount.planted, "the notebook as proposed: an html output's markup isn't shown at all (outputs.ts's filter)", mount);
  ok(mount.h1 === 0 && mount.rawTitle, "the notebook as proposed: a Markdown cell shown as its text, not rendered (outputs.ts's filter)", mount);
  ok(mount.enabled === 0 && mount.editable === 0, "the notebook as proposed is read only: no button, nothing to type in", mount);

  // ---- a text file, a deletion, an addition, a picture
  await ev("window.clickFile('notes.txt')");
  await until("[...document.querySelectorAll('#p .file')][1].querySelector('pre.diff')");
  const txt = await ev(`(() => { const f = [...document.querySelectorAll('#p .file')][1]; return { minus: [...f.querySelectorAll('.l-')].map((x) => x.textContent), plus: [...f.querySelectorAll('.l\\\\+')].map((x) => x.textContent), nbGone: !document.querySelector('#p details') }; })()`);
  ok(txt.minus.join() === "- two" && txt.plus.join() === "+ TWO", "a text file line by line", txt);
  ok(txt.nbGone, "opening another file lets the notebook go (one file open at a time)", txt);
  await ev("window.clickFile('old.txt')");
  await until("[...document.querySelectorAll('#p .file')][2].querySelector('pre.diff')");
  ok((await ev(`[...[...document.querySelectorAll('#p .file')][2].querySelectorAll('.l-')].map((x) => x.textContent).join()`)) === "- gone" && (await ev("window.reads.slice(-1)[0]")) === "old.txt@1111111", "a deleted file: its lines removed, only the base read");
  await ev("window.clickFile('new.md')");
  await until("[...document.querySelectorAll('#p .file')][3].querySelector('pre.diff')");
  ok((await ev(`[...[...document.querySelectorAll('#p .file')][3].querySelectorAll('.l\\\\+')].map((x) => x.textContent).join()`)) === "+ fresh", "an added file: its lines added");
  await ev("window.clickFile('pic.png')");
  await until("[...document.querySelectorAll('#p .file')][4].querySelector('p')");
  ok((await ev(`[...document.querySelectorAll('#p .file')][4].querySelector('p').textContent`)) === "No preview for this kind of file.", "a picture: no preview, said so");

  // ---- bounds, failures, one open at a time, close
  await ev("window.open1({ big: 'notes.txt' })");
  await until("document.querySelectorAll('#p .file').length === 5");
  await ev("window.clickFile('notes.txt')");
  await until("[...document.querySelectorAll('#p .file')][1].querySelector('p')");
  ok((await ev(`[...document.querySelectorAll('#p .file')][1].querySelector('p').textContent`)) === "Too large to show here.", "a side past PROPOSAL_LIMITS.bytes: not shown, said so");
  await ev("window.open1({ wide: 'notes.txt' })");
  await until("document.querySelectorAll('#p .file').length === 5");
  await ev("window.clickFile('notes.txt')");
  await until("[...document.querySelectorAll('#p .file')][1].querySelector('p')", 15000);
  ok((await ev(`[...document.querySelectorAll('#p .file')][1].querySelector('p')?.textContent`)) === "Too large to show here.", "the bound is UTF-8 bytes: a side under it in characters, over it in bytes, isn't shown");
  // (a notebook at the bound, one byte over, and over only in UTF-8: fromFile and the component never see one past it)
  const nbAt = async (o) => {
    await ev(`window.calls = { fromFile: 0, mount: 0 }; window.open1(${JSON.stringify(o)})`);
    await until("document.querySelectorAll('#p .file').length === 5");
    await ev("window.clickFile('nb.ipynb')");
    await until("!!document.querySelector('#p .file p, #p .file .cell, #p .file details')", 30000);
    await sleep(500);
    return ev(`({ calls: window.calls, msg: [...document.querySelectorAll('#p .file')][0].querySelector('p')?.textContent ?? null, cells: [...document.querySelectorAll('#p .file')][0].querySelectorAll('.cell').length })`);
  };
  const L = await ev("window.L.bytes");
  const at = await nbAt({ nbBytes: L });
  ok(at.calls.fromFile === 2 && at.cells > 0 && at.msg !== "Too large to show here.", "an ASCII notebook of exactly PROPOSAL_LIMITS.bytes: admitted, read and diffed", at);
  const over = await nbAt({ nbBytes: L + 1 });
  ok(over.calls.fromFile === 0 && over.calls.mount === 0 && over.msg === "Too large to show here.", "an ASCII notebook one byte over: neither fromFile nor the component sees it", over);
  const wide = await nbAt({ nbFill: "\u6f22".repeat(1398102) });
  ok(wide.calls.fromFile === 0 && wide.calls.mount === 0 && wide.msg === "Too large to show here.", "a notebook under the bound in characters, over it in UTF-8 (1,398,102 of 漢): neither fromFile nor the component sees it", wide);
  await ev("window.open1({ failDiff: true })");
  await until("!!document.querySelector('#p .msg')");
  ok((await ev("document.querySelector('#p .msg').textContent")) === "Couldn't load the proposal.", "a source that fails: said so");
  await ev("window.open1({ slow: { 'notes.txt': 1500 } })");
  await until("document.querySelectorAll('#p .file').length === 5");
  await ev("window.clickFile('notes.txt')");
  await sleep(100);
  await ev("window.clickFile('new.md')");
  await sleep(2200);
  const one = await ev(`[...document.querySelectorAll('#p .file')].map((f) => f.querySelectorAll('pre.diff').length)`);
  ok(one.join() === "0,0,0,1,0", "a slow file overtaken by another open: only the newer is shown", one);
  await ev("window.open1({ slow: { 'notes.txt': 1000 } })");
  await until("document.querySelectorAll('#p .file').length === 5");
  await ev("window.clickFile('notes.txt')");
  await ev("window.view.close()");
  await sleep(1500);
  ok((await ev("document.getElementById('p').childElementCount")) === 0, "close: the panel emptied, and a read that ends after it adds nothing");
  await ev(`window.open1({ list: { ...${JSON.stringify(LIST)}, round: 1, files: [${JSON.stringify(LIST.files[1])}] } })`);
  ok(await until("!!document.querySelector('#p pre.diff')"), "a proposal of one file: opened at once");
  ok((await ev("document.querySelector('#p h3').textContent")) === "Proposal", "round 1 says Proposal");
  await ev("window.open1({ list: { ...{ base: 'a'.repeat(40), proposal: 'b'.repeat(40), round: 1, seq: 1, files: [] } } })");
  ok(await until("/No files changed/.test(document.querySelector('#p')?.textContent ?? '')"), "a proposal with no files: said so");

  try { ws.close(); } catch {}
  if (fails.length) console.error(`FAIL: ${fails.length} of ${checks} checks\n  ` + fails.join("\n  "));
  else { console.log(`ok: the proposal view, ${checks} checks`); code1 = 0; }
} finally {
  chrome.kill();
  server.stop(true);
  await sleep(200);
  rmSync(profile, { recursive: true, force: true });
  rmSync(site, { recursive: true, force: true });
}
process.exit(code1);
