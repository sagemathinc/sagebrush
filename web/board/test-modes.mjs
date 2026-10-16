// Code items in several languages on one board (codes.ts, doc.ts; William's
// item 16, option A): an item's own `mode`, else the board's; each language
// its own interpreter, made when its first item runs; names shared, and
// reruns, only within a language (a name from another is that language's
// undefined name); a badge only on an item whose language is not the
// board's; the board's language changed: the items without their own move
// to it.  A board in one language has one interpreter, as before.  Serve
// web/dist first (python3 web/serve.py 8765), then
//   node web/board/test-modes.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devtoolsPort } from "../test-port.mjs";

const base = process.env.SB_URL ?? "http://127.0.0.1:8765/";
let port = Number(process.env.CDP_PORT) || 0, sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = mkdtempSync(join(tmpdir(), "sb-modes-"));
const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", `--remote-debugging-port=${port}`, "--window-size=1280,900", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
if (!port) port = await devtoolsPort(profile);
let targets;
for (let i = 0; i < 300; i++) { try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); break; } catch { await sleep(100); } }
const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let n = 0; const waiting = new Map(); const errors = [];
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result ?? m.error); waiting.delete(m.id); }
  if (m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails?.exception?.description ?? JSON.stringify(m.params.exceptionDetails));
};
const send = (method, params = {}) => new Promise((r) => { const id = ++n; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (expression) => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400)); return r.result.value; };
const until = async (expr, ms = 10000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(expr).catch(() => false)) return true; await sleep(100); } return false; };
const fails = [];
let checks = 0;
const check = (ok, what) => { checks++; if (!ok) fails.push(what); };
const B = "window.sagebrush.board";
const outputs = () => ev(`${B}.outputs().then((os) => Object.fromEntries(os.map((o) => [o.id, { state: o.state, output: o.output.trim() }])))`);
const engines = () => ev("document.querySelectorAll('.board-code-engine').length");
const settled = (ids) => until(`${B}.outputs().then((os) => ${JSON.stringify(ids)}.every((id) => { const o = os.find((x) => x.id === id); return o && (o.state === '' || o.state === 'failed' || o.state === 'error'); }))`, 90000);

try {
  for (const m of ["Page.enable", "Runtime.enable"]) await send(m);
  // (a board of one language first: one interpreter)
  await send("Page.navigate", { url: `${base}board/?runner=0&fresh=${Math.random()}` });
  if (!(await until(`${B}?.snapshot().items.length > 0`, 60000))) throw new Error("the board did not open");
  await ev(`${B}.load(${JSON.stringify({ title: "One", nodes: [{ id: "p", code: "1 + 1" }] })}).then(() => 1)`);
  check(await settled(["p"]), "(the one-language board ran)");
  check((await engines()) === 1, "a board in one language: one interpreter: " + (await engines()));

  // three languages: Python (the board's), Sage and MATLAB items
  await send("Page.navigate", { url: `${base}board/?runner=0&fresh=${Math.random()}` });
  await until(`${B}?.snapshot().items.length > 0`, 60000);
  const DOC = { title: "Languages", nodes: [
    { id: "a", title: "myval in Python", code: "myval = 6" },
    { id: "b", title: "myval * 7", code: "print(myval * 7)" },
    { id: "s1", title: "y in Sage", mode: "sage", code: "y = factor(12)" },
    { id: "s2", title: "y", mode: "sage", code: "print(y)" },
    { id: "s3", title: "myval in Sage?", mode: "sage", code: "print(myval)" },
    { id: "m1", title: "MATLAB", mode: "matlab", code: "z = 3;\ndisp(z * 2)" },
  ] };
  await ev(`${B}.load(${JSON.stringify(DOC)}).then(() => 1)`);
  check(await settled(["a", "b", "s1", "s2", "s3", "m1"]), "(every item ran: " + JSON.stringify(await outputs()) + ")");
  let o = await outputs();
  check(o.b?.output === "42", "a Python item reads a Python name: " + JSON.stringify(o.b));
  check(o.s2?.output === "2^2 * 3", "a Sage item reads a Sage name, in Sage: " + JSON.stringify(o.s2));
  check(o.m1?.output === "6", "a MATLAB item runs in MATLAB: " + JSON.stringify(o.m1));
  check(o.s3?.state === "failed" && /NameError|not defined/.test(o.s3.output), "a Python name in a Sage item: Sage's undefined name, nothing shared: " + JSON.stringify(o.s3));
  check((await engines()) === 3, "three languages: three interpreters: " + (await engines()));
  // the badge: only on the items in a language not the board's
  // (in id order: the order they are drawn in is the board's, not this test's)
  const badges = await ev("Object.fromEntries([...document.querySelectorAll('.board-lang')].map((b) => [[...window.board.cache].find(([, e]) => e.contains(b))?.[0], b.textContent]).sort(([x], [y]) => (x < y ? -1 : 1)))");
  check(JSON.stringify(badges) === JSON.stringify({ m1: "MATLAB", s1: "Sage", s2: "Sage", s3: "Sage" }), "a language badge on the Sage and MATLAB items only: " + JSON.stringify(badges));
  // a change in one language reruns its dependents there only
  await ev(`${B}.edit((d) => { d.nodes.find((n) => n.id === "s1").code = "y = factor(30)"; }).then(() => 1)`);
  check(await until(`${B}.outputs().then((os) => os.find((x) => x.id === 's2')?.output.trim() === '2 * 3 * 5')`, 60000), "an edit to a Sage item reruns what reads it in Sage: " + JSON.stringify((await outputs()).s2));
  o = await outputs();
  check(o.b?.output === "42", "...and the Python items are as they were");
  // the board's language changed to Sage: its items without their own move to Sage, where x is now shared
  await ev(`${B}.edit((d) => { d.mode = "sage"; }).then(() => 1)`);
  check(await until(`${B}.outputs().then((os) => os.find((x) => x.id === 's3')?.output.trim() === '6')`, 90000), "the board's language now Sage: the Python items run in Sage, and s3 reads their myval: " + JSON.stringify(await outputs()));
  const badges2 = await ev("[...document.querySelectorAll('.board-lang')].map((b) => b.textContent).join()");
  check(badges2 === "MATLAB", "...and only MATLAB is badged now: " + badges2);
  // the document as written: an item's mode kept, the board's too
  const kept = await ev(`(() => { const d = ${B}.snapshot().doc; return [d.mode, d.nodes.find((n) => n.id === 's1').mode, d.nodes.find((n) => n.id === 'a').mode ?? null]; })()`);
  check(JSON.stringify(kept) === JSON.stringify(["sage", "sage", null]), "the document keeps each item's own mode: " + JSON.stringify(kept));
  // a mode that is not a language: left out (the board's)
  const cleaned = await ev(`(() => { ${B}.load({ nodes: [{ id: "q", code: "1", mode: "cobol" }, { id: "r", text: "no code", mode: "sage" }] }); const d = ${B}.snapshot().doc; return [d.nodes[0].mode ?? null, d.nodes[1].mode ?? null]; })()`);
  check(JSON.stringify(cleaned) === "[null,null]", "a mode not a language, or on a note without code, is left out: " + JSON.stringify(cleaned));

  // an item moved to another language: its stored preview (the other
  // language's output) is not shown held as this one's; it runs there (astra)
  const PV = { title: "Preview", nodes: [{ id: "pv", code: "print(2^3)", preview: { at: "2026-10-15T10:00:00Z", ms: 12000, total: 12000, outputs: [{ output_type: "stream", name: "stdout", text: "STALE 1\n" }] } }] };
  await ev(`${B}.load(${JSON.stringify(PV)}).then(() => 1)`);
  check(await until(`${B}.outputs().then((os) => /STALE/.test(os.find((x) => x.id === 'pv')?.output ?? ''))`, 30000), "(an item with a stored preview: shown, held: " + JSON.stringify(await outputs()) + ")");
  await ev(`${B}.edit((d) => { d.nodes[0].mode = "sage"; }).then(() => 1)`);
  check(await until(`${B}.outputs().then((os) => { const o = os.find((x) => x.id === 'pv'); return o?.state === '' && o.output.trim() === '8'; })`, 90000), "moved to Sage: run there (2^3 is 8), not its Python preview held: " + JSON.stringify((await outputs()).pv));

  check(!errors.length, "no errors: " + errors.join(" | "));
} catch (e) {
  fails.push(String(e?.stack ?? e));
} finally {
  chrome.kill();
  await sleep(200);
  rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
console.log(`${checks - fails.length}/${checks} checks passed`);
for (const f of fails) console.log("FAIL", f);
process.exit(fails.length ? 1 : 0);
