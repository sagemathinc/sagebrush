// The notebook as a component (web/notebook), in headless Chromium: the embed
// page (web/embed) runs code; changes made elsewhere (a store's subscribe)
// are applied in place, keeping the caret of the cell being edited and the
// outputs; edits reach the store; and the same notebook open in two tabs of
// the full page stays in step.  Serve web/dist first:
//   bun web/build.ts && (cd web/dist && python3 ../serve.py 8765) &
//   node web/test-notebook-component.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const base = process.env.SB_URL ?? "http://127.0.0.1:8765/";
const profile = mkdtempSync(join(tmpdir(), "sb-component-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", "--disable-gpu", "--remote-debugging-port=9339", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
let targets;
for (let i = 0; i < 100; i++) { try { targets = await (await fetch("http://127.0.0.1:9339/json")).json(); break; } catch { await sleep(100); } }
const ok = (c, msg) => { console.log((c ? "ok   " : "FAIL ") + msg); if (!c) process.exitCode = 1; };

// a connection to one tab
async function tab(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((r) => (ws.onopen = r));
  let n = 0; const waiting = new Map();
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result ?? m.error); waiting.delete(m.id); } };
  const send = (method, params = {}) => new Promise((r) => { const id = ++n; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
  const ev = async (expression) => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 500)); return r.result?.value; };
  const until = async (expr, ms = 30000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(expr)) return true; await sleep(100); } throw new Error("timeout: " + expr); };
  return { ws, send, ev, until };
}

try {
  const a = await tab(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
  // ---- the embed page
  await a.send("Page.navigate", { url: new URL("embed/", base).href });
  await a.until("window.demo && document.querySelectorAll('#nb .cell').length === 3");
  ok(await a.ev("!!document.querySelector('#nb.sbnb .cell.markdown.rendered')"), "the component shows the store's cells, Markdown rendered");
  await a.until("window.demo.kernel.ready");
  await a.ev("demo.nb.run(demo.nb.cells()[1])");
  ok((await a.ev("demo.nb.cells()[1].out.textContent")).includes("274177 * 67280421310721"), "its kernel runs a cell: factor(2^64 + 1)");
  await a.ev("demo.nb.run(demo.nb.cells()[2])");
  ok(await a.ev("!!demo.nb.cells()[2].out.querySelector('figure.plot svg')"), "...and draws a plot");
  // edits reach the store (half a second later)
  await a.ev("demo.nb.setInput(demo.nb.cells()[1], 'factor(2^32 + 1)')");
  await a.until("demo.store.doc.cells[1].code === 'factor(2^32 + 1)'", 3000);
  ok(true, "an edit reaches the store");
  // a change made elsewhere: a new first cell, the second edited, the third deleted
  const r = await a.ev(`(() => {
    const nb = demo.nb, c = nb.cells(), ta = c[1].ta;
    const out = c[1].out.textContent;
    ta.focus(); ta.setSelectionRange(3, 3);
    const doc = nb.snapshot();
    doc.cells = [{ id: "remote1", code: "1 + 1" }, doc.cells[0], { ...doc.cells[1], code: "factor(2^32 + 1)  # from elsewhere" }];
    demo.store.push(doc);
    const now = nb.cells();
    return { n: now.length, first: now[0].ta.value, id0: now[0].id, edited: now[2].ta.value, caret: now[2].ta.selectionStart, focused: document.activeElement === now[2].ta, sameEl: now[2].ta === ta, outKept: now[2].out.textContent === out };
  })()`);
  ok(r.n === 3 && r.first === "1 + 1" && r.id0 === "remote1" && r.edited === "factor(2^32 + 1)  # from elsewhere", "a change from elsewhere adds, edits and deletes cells by id: " + JSON.stringify(r));
  ok(r.sameEl && r.focused && r.caret === 3 && r.outKept, "...in place: the cell being edited keeps its focus, caret and output");
  // the component's own state after it: no echo back to the store
  await sleep(800);
  ok(await a.ev("demo.store.doc.cells[0].id === 'remote1' && demo.store.doc.cells.length === 3"), "the store and the notebook agree after the change");
  // raw cells and cell metadata (tags, ...) are kept through edits (audit F8)
  const raw = await a.ev(`(async () => {
    const nb = demo.nb, doc = nb.snapshot();
    doc.cells = [{ id: "raw1", type: "raw", code: "\\\\section{Results}", metadata: { raw_mimetype: "text/latex" } },
                 { ...doc.cells[0], metadata: { tags: ["parameters"] } }];
    demo.store.push(doc);
    const [r, c] = nb.cells();
    await nb.run(r);
    nb.setInput(c, "2 + 2");
    nb.flush();
    const s = demo.store.doc.cells;
    return { cls: r.el.classList.contains("raw"), out: r.out.textContent, sel: r.typeSel.value, type: s[0].type, rawMeta: s[0].metadata?.raw_mimetype, tags: s[1].metadata?.tags?.join(), code: s[1].code };
  })()`);
  ok(raw.cls && raw.out === "" && raw.sel === "raw" && raw.type === "raw" && raw.rawMeta === "text/latex" && raw.tags === "parameters" && raw.code === "2 + 2", "raw cells stay raw and are not run; cell metadata survives an edit: " + JSON.stringify(raw));

  // systematic review DOC-F1..F3: loaded outputs survive a save as they were,
  // a failed save is retried, an unsaved local edit survives a remote change
  const rev = await a.ev(`(async () => {
    const nb = demo.nb, st = demo.store, doc = nb.snapshot();
    const outs = [{ output_type: "execute_result", execution_count: 3, data: { "text/plain": "1/7", "application/json": { exact: "1/7" } }, metadata: { precision: "exact" } },
                  { output_type: "error", ename: "ValueError", evalue: "undefined", traceback: ["ValueError: undefined"] }];
    doc.cells = [{ id: "o1", code: "1/7", outputs: outs, n: 3 }, { id: "o2", code: "x = 1" }];
    st.push(doc);
    nb.setMeta({ name: "renamed" });
    nb.flush();
    await new Promise((r) => setTimeout(r, 50));
    const kept = JSON.stringify(st.doc.cells[0].outputs) === JSON.stringify(outs);
    const orig = st.save.bind(st);
    let calls = 0;
    st.save = (d) => (++calls === 1 ? Promise.reject(new Error("disk full")) : orig(d));
    nb.setInput(nb.cells()[1], "x = 2");
    nb.flush();
    await new Promise((r) => setTimeout(r, 50));
    nb.flush();
    await new Promise((r) => setTimeout(r, 50));
    st.save = orig;
    const retried = calls === 2 && st.doc.cells[1].code === "x = 2";
    nb.setInput(nb.cells()[1], "x = 9007199254740993");
    const remote = structuredClone(st.doc);
    remote.cells[0].code = "1/9";
    st.push(remote);
    await new Promise((r) => setTimeout(r, 900));
    const merged = nb.cells()[0].ta.value === "1/9" && nb.cells()[1].ta.value === "x = 9007199254740993" && st.doc.cells[1].code === "x = 9007199254740993";
    return { kept, retried, calls, merged };
  })()`);
  ok(rev.kept && rev.retried && rev.merged, "loaded outputs are saved as they were; a failed save is retried; an unsaved edit survives a remote change: " + JSON.stringify(rev));

  // ---- the full page, in two tabs: the same notebook stays in step
  await a.send("Page.navigate", { url: base });
  await a.until("window.sagebrush && document.querySelectorAll('.cell').length > 0 && document.querySelector('#status').textContent.startsWith('ready')");
  await a.ev("document.querySelector('[data-f=new]').click()");
  await a.until("document.querySelector('#nbname').value === 'Untitled'");
  await sleep(700);
  const t2 = await (await fetch("http://127.0.0.1:9339/json/new?" + encodeURIComponent(base), { method: "PUT" })).json();
  const b = await tab(t2.webSocketDebuggerUrl);
  await b.until("window.sagebrush && document.querySelector('#nbname').value === 'Untitled' && document.querySelectorAll('.cell').length === 1");
  await a.ev("(() => { const nb = sagebrush.notebook; nb.setInput(nb.cells()[0], 'x = 6 * 7'); nb.addCell('print(x)'); })()");
  await b.until("[...document.querySelectorAll('.cell textarea')].map(t => t.value).join('|') === 'x = 6 * 7|print(x)'", 5000);
  ok(true, "two tabs with the same notebook: edits in one appear in the other");
  await b.ev("(() => { const nb = sagebrush.notebook; nb.setInput(nb.cells()[1], 'print(x + 1)'); })()");
  await a.until("document.querySelectorAll('.cell textarea')[1]?.value === 'print(x + 1)'", 5000);
  ok(true, "...both ways");
  await b.ev("document.querySelector('#nbname').value = 'Shared work'; document.querySelector('#nbname').dispatchEvent(new Event('input'))");
  await sleep(900);
  ok(await a.ev("sagebrush.notebook.meta.name === 'Shared work' && document.querySelector('#nbname').value === 'Shared work'"), "the notebook's name travels with it");
  b.ws.close();
  a.ws.close();
} catch (e) {
  console.log("ERROR", e.message);
  process.exitCode = 1;
} finally {
  chrome.kill();
  setTimeout(() => rmSync(profile, { recursive: true, force: true }), 500);
}
