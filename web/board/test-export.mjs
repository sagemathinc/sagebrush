// Download as HTML (web/board/export.ts): each board exported from the
// site opens from a file, offline (the network off), with its pages, math
// (KaTeX's fonts inline) and printing; exported again from that file, it is
// the same file.  A board with code, offline and without Python in it,
// asks the network only for its engine, and says why its code can't run
// (test-offline.mjs: the engine in files).  Its scripts have nothing in
// them that would end them early.  Serve web/dist first (python3
// web/serve.py 8765), then
//   node web/board/test-export.mjs [doc.json ...]
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const docs = process.argv.slice(2).length ? process.argv.slice(2) : ["examples/primes.json", "examples/sagebrush.json", "examples/mermaid.md", "examples/live.json"];
const base = process.env.SB_URL ?? "http://127.0.0.1:8765/";
const port = Number(process.env.CDP_PORT ?? 9453), sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dir = mkdtempSync(join(tmpdir(), "sb-export-")), profile = mkdtempSync(join(tmpdir(), "sb-export-prof-"));
const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", `--remote-debugging-port=${port}`, "--window-size=1280,800", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
let targets;
for (let i = 0; i < 300; i++) { try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); break; } catch { await sleep(100); } }
const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let n = 0; const waiting = new Map(); let errors = [], requests = [];
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result ?? m.error); waiting.delete(m.id); }
  if (m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails?.exception?.description ?? JSON.stringify(m.params.exceptionDetails));
  if (m.method === "Log.entryAdded" && m.params.entry.level === "error" && !/favicon/.test(m.params.entry.url ?? "")) errors.push(m.params.entry.text + " " + (m.params.entry.url ?? ""));
  if (m.method === "Network.requestWillBeSent" && !/^(data|blob|file):/.test(m.params.request.url)) requests.push(m.params.request.url);
};
const send = (method, params = {}) => new Promise((r) => { const id = ++n; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (expression) => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400)); return r.result.value; };
const until = async (expr, ms = 20000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(expr).catch(() => false)) return; await sleep(50); } throw new Error("timeout: " + expr); };
const fails = [];
// (each board's document as shown, and the file it was downloaded as)
const shown = new Map(), files = new Map();
const check = (ok, what) => { if (!ok) fails.push(what); };
try {
  for (const m of ["Page.enable", "Runtime.enable", "Log.enable", "Network.enable"]) await send(m);
  for (const doc of docs) {
    errors = [];
    await send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    await send("Page.navigate", { url: `${base}board/?doc=${encodeURIComponent(doc)}` });
    await until("window.sagebrush?.board?.snapshot().items.length > 0", 60000);
    const html = await ev("window.sagebrush.board.exportHtml()");
    shown.set(doc, await ev("JSON.stringify(window.sagebrush.board.snapshot().doc)"));
    const s0 = await ev("(() => { const s = window.sagebrush.board.snapshot(); return { pages: s.pages, items: s.items.length, math: JSON.stringify(s.doc).includes('$'), code: JSON.stringify(s.doc).includes('\"code\":') }; })()");
    check(!/offline/i.test(await ev("document.querySelector('[data-sbb=html]').textContent")), `${doc}: the menu says the file works offline`);
    // (its scripts: nothing in them ends them early, and no "<!--", after which
    // a "<script" in them would keep the page from loading)
    const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    check(scripts.length >= 3 && scripts.every((t) => !/<!--|<\/script/i.test(t)), `${doc}: a script in the file has "<!--" or "</script" in it`);
    const file = join(dir, doc.split("/").pop().replace(/\.\w+$/, "") + ".html");
    writeFileSync(file, html);
    files.set(doc, file);
    // the file, offline (after a blank page: no request of the site's page,
    // such as its code engine's, made late, is counted as the file's)
    await send("Page.navigate", { url: "about:blank" });
    await until("location.href === 'about:blank' && document.readyState === 'complete'", 5000);
    await sleep(300);
    await send("Network.emulateNetworkConditions", { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    requests = [];
    await send("Page.navigate", { url: "file://" + file });
    await until("window.sagebrush?.board?.snapshot().items.length > 0", 30000);
    await sleep(500);
    const s1 = await ev("(() => { const s = window.sagebrush.board.snapshot(); return { pages: s.pages, items: s.items.length, title: document.title }; })()");
    check(s1.pages === s0.pages && s1.items === s0.items, `${doc}: the file shows ${s1.items} items on ${s1.pages} pages, not ${s0.items} on ${s0.pages}`);
    check(!(await ev("document.querySelector('[data-sbb=examples]').hidden === false")), `${doc}: Examples shown in the file`);
    // code, offline, without Python in the file: it says why it can't run (only when there is code)
    const said = await until("!document.querySelector('[data-sbb=tour]').hidden && /can't run here/.test(document.querySelector('[data-sbb=say]').textContent)", s0.code ? 20000 : 1500).then(() => true, () => false);
    check(said === s0.code, s0.code ? `${doc}: offline, the file doesn't say why its code can't run` : `${doc}: the file says code can't run, with no code`);
    // math, typeset with KaTeX's own fonts (inline)
    if (s0.math) {
      const id = await ev("(() => { const d = window.sagebrush.board.snapshot(); const p = d.doc.pages ? d.doc.pages[d.page] : d.doc; const walk = (ns) => { for (const n of ns) { if (n.kind === 'group') { const r = walk(n.children); if (r) return r; } else if (/\\$/.test((n.text ?? '') + (n.detail ?? ''))) return n.id; } }; return walk(p.nodes); })()");
      if (id) {
        await ev(`window.board.focus([${JSON.stringify(id)}], true)`);
        await until("document.querySelectorAll('.board-note .katex').length > 0", 10000).catch(() => {});
        check(await ev("document.querySelectorAll('.board-note .katex').length > 0"), `${doc}: no math typeset in the file`);
        await ev("document.fonts.ready");
        check(await ev("[...document.fonts].some((f) => f.family.includes('KaTeX') && f.status === 'loaded')"), `${doc}: KaTeX's fonts not loaded from the file`);
      }
    }
    if (s0.pages > 1) {
      await ev("window.sagebrush.board.page(1)");
      check((await ev("window.sagebrush.board.snapshot().page")) === 1, `${doc}: the file's second page`);
      await ev("window.sagebrush.board.page(0)");
    }
    // printing
    const sheets = await ev("window.sagebrush.board.print({ dialog: false })");
    const pdf = await send("Page.printToPDF", { preferCSSPageSize: true, printBackground: true });
    const pages = (Buffer.from(pdf.data ?? "", "base64").toString("latin1").match(/\/Type\s*\/Page(?![s\w])/g) ?? []).length;
    check(sheets === s0.pages && pages === sheets, `${doc}: the file printed ${sheets} sheets, ${pages} PDF pages, for ${s0.pages} pages`);
    await ev("document.getElementById('board-print')?.remove()");
    // exported again, from the file: the same file
    const again = await ev("window.sagebrush.board.exportHtml()");
    check(again === html, `${doc}: exported again from the file, ${again.length} bytes, not the same ${html.length}`);
    // (but for its engine, with code: offline, those fail)
    const engine = /\/engine\/[0-9a-f]{20}\//;
    check(!requests.filter((u) => !(s0.code && engine.test(u))).length, `${doc}: the file asked the network for ${requests.slice(0, 3).join(", ")}`);
    check(!errors.filter((e) => !(s0.code && engine.test(e))).length, `${doc}: errors in the file: ${errors.slice(0, 3).join(" | ")}`);
    console.log(`${doc}: ${(html.length / 1024).toFixed(0)} KB, ${s1.items} items, ${s1.pages} page(s), ${sheets} sheet(s)`);
  }

  // Ctrl/Cmd+S: Download as HTML, not the page's own Save (William)
  errors = [];
  await send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  const keyS = async (modifiers) => {
    await send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "s", code: "KeyS", windowsVirtualKeyCode: 83, modifiers });
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: "s", code: "KeyS", windowsVirtualKeyCode: 83, modifiers });
  };
  const dialogOpen = () => ev("document.querySelector('[data-sbb=htmldlg]').open");
  await send("Page.navigate", { url: `${base}board/?doc=${encodeURIComponent("examples/live.json")}` });
  await until("window.sagebrush?.board?.snapshot().items.length > 0", 60000);
  // (its code run first: the dialog shows what the file would carry, so it
  // opens only when what was asked for has run, which under load is slow)
  check(await until("window.sagebrush.board.outputs().then((os) => os.length > 0)", 90000).then(() => true, () => false), "examples/live.json's code did not run");
  for (const [mod, name] of [[2, "Ctrl"], [4, "Cmd"]]) {
    await keyS(mod);
    await until("document.querySelector('[data-sbb=htmldlg]').open", 10000).catch(() => {});
    check(await dialogOpen(), `${name}+S on a board with code does not open Download as HTML's dialog`);
    await ev("document.querySelector('[data-sbb=htmldlg]').close(), 1");
  }
  // (a board without code: the file at once; the links clicked to download, counted)
  const S = { title: "Saved", nodes: [{ id: "n", title: "Note", text: "Its text", x: 0, y: 0, w: 300 }] };
  await ev(`window.sagebrush.board.load(${JSON.stringify(S)}).then(() => 1)`);
  await ev("window.__got = []; HTMLAnchorElement.prototype.click = function () { window.__got.push(this.download); }; 1");
  await keyS(2);
  await until("window.__got.length === 1", 5000).catch(() => {});
  check((await ev("window.__got.join()")).endsWith(".html") && !(await dialogOpen()), "Ctrl+S on a board without code does not download its HTML at once: " + await ev("window.__got.join()"));
  // (a note being written: what is written is kept first, and is in the file)
  await ev("window.sagebrush.board.editing(true), 1");
  await ev("(() => { const r = window.board.clientRect('n'); const x = r.left + 20, y = r.top + 12; document.elementFromPoint(x, y).dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: x, clientY: y })); return 1; })()");
  await until("window.board.editing === 'n' && document.activeElement === document.querySelector('.board-editing .be-title')", 3000);
  await ev("(() => { const t = document.querySelector('.board-editing .be-title'); t.setSelectionRange(t.value.length, t.value.length); return 1; })()");
  await send("Input.insertText", { text: " kept" });
  await keyS(2);
  await until("window.__got.length === 2", 5000).catch(() => {});
  check(await ev("window.__got.length === 2 && !window.board.editing && window.sagebrush.board.snapshot().doc.nodes[0].title === 'Note kept'"), "Ctrl+S while a note is written: not kept first, or not downloaded: " + JSON.stringify(await ev("({ got: window.__got, editing: window.board.editing, title: window.sagebrush.board.snapshot().doc.nodes[0].title })")));
  // (an exported file is itself the saved board: there Ctrl/Cmd+S is the
  // browser's, its ⋯ menu still downloading it again, CORR-2C4-1)
  await send("Page.navigate", { url: "file://" + files.get("examples/primes.json") });
  await until("window.sagebrush?.board?.snapshot().items.length > 0", 30000);
  await ev("window.__got = []; HTMLAnchorElement.prototype.click = function () { window.__got.push(this.download); }; window.__kept = []; document.addEventListener('keydown', (e) => window.__kept.push(e.defaultPrevented)); 1");
  await keyS(2);
  await sleep(500);
  const exported = await ev("({ got: window.__got, kept: window.__kept, dialog: document.querySelector('[data-sbb=htmldlg]').open, menu: !document.querySelector('[data-sbb=html]').hidden })");
  check(!exported.got.length && JSON.stringify(exported.kept) === "[false]" && !exported.dialog && exported.menu, "in an exported file, Ctrl+S is the browser's (nothing downloaded, nothing prevented), the menu's Download as HTML still there: " + JSON.stringify(exported));
  check(!errors.length, "errors: " + errors.join(" | "));

  // A board downloaded as HTML, opened again on the site (Open…, or
  // dropped): the board it holds, as it was; never the file's page itself
  // (fromhtml.ts).  Anything else in HTML is refused, and nothing of it runs.
  errors = [];
  await send("Page.navigate", { url: `${base}board/?doc=${encodeURIComponent("examples/primes.json")}` });
  await until("window.sagebrush?.board?.snapshot().items.length > 0", 60000);
  const docJson = () => ev("JSON.stringify(window.sagebrush.board.snapshot().doc)");
  const sayText = () => ev("document.querySelector('[data-sbb=say]').textContent");
  // (through the Open… menu's file chooser, as a person picks a file)
  const pick = async (file) => {
    const { root } = await send("DOM.getDocument", { depth: 0 });
    const { nodeId } = await send("DOM.querySelector", { nodeId: root.nodeId, selector: "[data-sbb=openfile]" });
    await send("DOM.setFileInputFiles", { files: [file], nodeId });
  };
  for (const [doc, file] of files) {
    await ev(`window.sagebrush.board.load(${JSON.stringify(S)}).then(() => 1)`);
    await pick(file);
    await until(`window.sagebrush.board.snapshot().doc.title !== ${JSON.stringify(S.title)}`, 10000).catch(() => {});
    check((await docJson()) === shown.get(doc), `${doc}, downloaded as HTML and opened again: not the same board: ${(await docJson()).slice(0, 120)}`);
  }
  // hostile files: none of their scripts or markup runs; only a Sagebrush export's board opens
  const GEN = '<meta name="generator" content="Sagebrush boards (sagebrush.space/board), exported 2026-10-14">';
  const bad = `<img src=x onerror="window.__pwn=1"><script>window.__pwn=1</script>`;
  const docTag = (json) => `<script type="application/json" id="sb-doc">${json}</script>`;
  const markup = { title: "Marked <img src=x onerror=window.__pwn=2>", nodes: [{ id: "x", title: "<script>window.__pwn=3</script>", text: "<img src=x onerror=window.__pwn=4> and [a link](javascript:window.__pwn=5)", x: 0, y: 0, w: 300 }] };
  const HOSTILE = [
    ["an ordinary page", `<!doctype html><html><head><title>Page</title></head><body>${bad}<p>Hello</p></body></html>`, false],
    ["a page without the generator", `<!doctype html><html><head></head><body>${bad}${docTag(JSON.stringify(S))}</body></html>`, false],
    ["an export whose JSON is broken", `<!doctype html><html><head>\n${GEN}</head><body>${bad}${docTag('{"title": "Broken", "nodes": [')}</body></html>`, false],
    ["an export whose JSON is no board", `<!doctype html><html><head>\n${GEN}</head><body>${bad}${docTag('{"title": "No nodes"}')}</body></html>`, false],
    ["an export whose board has markup in it", `<!doctype html><html><head>\n${GEN}${bad}</head><body>${bad}${docTag(JSON.stringify(markup).replace(/</g, "\\u003c"))}</body></html>`, true],
  ];
  for (const how of ["picked", "dropped"]) {
    for (const [what, text, opens] of HOSTILE) {
      await ev(`window.sagebrush.board.load(${JSON.stringify(S)}).then(() => (window.__pwn = 0, 1))`);
      const before = await docJson();
      if (how === "picked") {
        const f = join(dir, "hostile.html");
        writeFileSync(f, text);
        await pick(f);
      } else {
        await ev(`(() => { const dt = new DataTransfer(); dt.items.add(new File([${JSON.stringify(text)}], "hostile.html", { type: "text/html" })); document.querySelector(".board").dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true })); return 1; })()`);
      }
      if (opens) {
        await until("window.sagebrush.board.snapshot().doc.title.startsWith('Marked')", 10000).catch(() => {});
        await ev("window.board.focus(undefined, true), 1");
        await sleep(500);
        check(await ev("window.sagebrush.board.snapshot().doc.nodes[0].title === '<script>window.__pwn=3</script>' && [...document.querySelectorAll('.board-note b')].some((b) => b.textContent === '<script>window.__pwn=3</script>') && !document.querySelector('.board-note img, .board-note script, .board-note a[href^=javascript]')"), `${what}, ${how}: its board opens, its markup shown as text: ` + await ev("document.querySelector('.board-note')?.innerHTML.slice(0, 200) ?? 'no note'"));
      } else {
        await until("/could not be shown/.test(document.querySelector('[data-sbb=say]').textContent)", 5000).catch(() => {});
        check((await docJson()) === before && /could not be shown: not a board/.test(await sayText()), `${what}, ${how}: not refused, saying why: ` + (await sayText()).slice(0, 160));
      }
      check(!(await ev("window.__pwn")), `${what}, ${how}: something of the file ran: __pwn = ${await ev("window.__pwn")}`);
    }
  }

  // a file refused for what it says (its format, its ids): what it said is
  // shown as text, never as Markdown, so no picture of it is fetched and no
  // link of it made (SEC-36E-1; JSON as well as a board as HTML)
  const PROBE = "![probe](https://example.invalid/leak)";
  const REFUSED = [
    ["a JSON board whose format is Markdown", JSON.stringify({ format: PROBE, nodes: [] }), "its format is"],
    ["a board as HTML whose format is Markdown", `<!doctype html><html><head>\n${GEN}</head><body>${docTag(JSON.stringify({ format: PROBE, nodes: [] }).replace(/</g, "\\u003c"))}</body></html>`, "its format is"],
    ["a board whose ids are Markdown links", JSON.stringify({ nodes: [{ id: "[x](javascript:window.__pwn=7)" }, { id: "[x](javascript:window.__pwn=7)" }] }), "[x](javascript:window.__pwn=7)"],
  ];
  requests = [];
  for (const how of ["picked", "dropped"]) {
    for (const [what, text, says] of REFUSED) {
      await ev(`window.sagebrush.board.load(${JSON.stringify(S)}).then(() => (window.__pwn = 0, 1))`);
      if (how === "picked") {
        const f = join(dir, "refused.json");
        writeFileSync(f, text);
        await pick(f);
      } else {
        await ev(`(() => { const dt = new DataTransfer(); dt.items.add(new File([${JSON.stringify(text)}], "refused.json", { type: "application/json" })); document.querySelector(".board").dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true })); return 1; })()`);
      }
      await until("/could not be shown/.test(document.querySelector('[data-sbb=say]').textContent)", 5000).catch(() => {});
      await sleep(300);
      const said = await ev("(() => { const e = document.querySelector('[data-sbb=say]'); return { text: e.textContent, markup: e.querySelectorAll('img, a, code, em').length, strong: e.querySelector('strong')?.textContent }; })()");
      check(said.markup === 0 && said.strong === "This board could not be shown:" && said.text.includes(says) && (what.includes("format") ? said.text.includes(PROBE) : true), `${what}, ${how}: refused, what it said shown as text: ` + JSON.stringify(said));
      check(!(await ev("window.__pwn")), `${what}, ${how}: something of the file ran`);
    }
  }
  // a file past the largest the board reads (128 MB): refused by its size, before it is read (HARD-36E-2)
  {
    const big = join(dir, "big.json");
    writeFileSync(big, "");
    truncateSync(big, 128 * 2 ** 20 + 1);
    for (const how of ["picked", "dropped"]) {
      await ev(`window.sagebrush.board.load(${JSON.stringify(S)}).then(() => 1)`);
      const before = await docJson();
      if (how === "picked") await pick(big);
      else await ev(`(() => { const dt = new DataTransfer(); dt.items.add(new File([new Uint8Array(128 * 2 ** 20 + 1)], "big.json", { type: "application/json" })); document.querySelector(".board").dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true })); return 1; })()`);
      await until("/too large/.test(document.querySelector('[data-sbb=say]').textContent)", 10000).catch(() => {});
      check((await docJson()) === before && /could not be shown: too large to open: 129 MB \(at most 128 MB\)/.test(await sayText()), `a file past 128 MB, ${how}: refused by its size: ` + (await sayText()).slice(0, 160));
    }
  }
  check(!requests.some((u) => u.includes("example.invalid")), "no picture a refused file names is fetched: " + requests.filter((u) => u.includes("example.invalid")).join(", "));
  check(!errors.filter((e) => !/example\.invalid/.test(e)).length, "errors: " + errors.join(" | "));
} catch (e) {
  fails.push(String(e?.stack ?? e));
  if (errors.length) fails.push("page errors: " + errors.join(" | "));
} finally {
  ws.close();
  chrome.kill();
  try { rmSync(profile, { recursive: true, force: true }); if (!process.env.KEEP) rmSync(dir, { recursive: true, force: true }); else console.log("files in", dir); } catch {}
}
if (fails.length) { console.log("FAIL\n  " + fails.join("\n  ")); process.exit(1); }
console.log("ok");
