// The notebook's language, which only its user changes: the search box finds
// the functions of the notebook's language only (Sage's library in a Sage
// notebook, MATLAB's built-ins in a MATLAB one, and says there is no search in
// a Python one); a function's examples are inserted only into a notebook of
// its language, never switching it; choosing another language for a notebook
// with code asks first, and cancelling keeps the language.
//   bun web/build.ts && python3 web/serve.py 8765 &   node web/test-doclang.mjs
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devtoolsPort } from "./test-port.mjs";

const url = process.env.SB_URL ?? "http://127.0.0.1:8765/";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (ok, what) => { console.log((ok ? "ok   " : "FAIL ") + what); if (!ok) failed++; };

let port = Number(process.env.CDP_PORT) || 0;
const profile = mkdtempSync(join(tmpdir(), "sb-doclang-"));
const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", "--disable-gpu", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
if (!port) port = await devtoolsPort(profile);
let targets;
for (let i = 0; i < 300; i++) { try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); break; } catch { await sleep(100); } }
const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let n = 0; const waiting = new Map(); const errors = []; const dialogs = [];
// (what a confirm() answers: set before each change of language)
let answer = false;
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result ?? m.error); waiting.delete(m.id); }
  if (m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails?.exception?.description ?? JSON.stringify(m.params.exceptionDetails));
  if (m.method === "Page.javascriptDialogOpening") { dialogs.push(m.params.message); send("Page.handleJavaScriptDialog", { accept: answer }); }
};
const send = (method, params = {}) => new Promise((r) => { const id = ++n; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r?.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300));
  return r?.result?.value;
};
// (60 s: the crowd runs of CI load the machine, and the Sage index is large)
const until = async (e, ms = 60000) => { const t = Date.now(); for (;;) { const v = await ev(e).catch(() => null); if (v) return v; if (Date.now() - t > ms) return null; await sleep(100); } };
// (the language chosen in the menu, as a person chooses it; when it is to
// change, waited for, as the notebook may load the language's library first)
const choose = async (m, changes = true) => {
  await ev(`(() => { const s = document.querySelector("#mode"); s.value = ${JSON.stringify(m)}; s.dispatchEvent(new Event("change")); return 1; })()`);
  if (changes) await until(`window.sagebrush.notebook.mode === ${JSON.stringify(m)}`);
};
// (a condition of the test's own state, waited for)
const waitFor = async (f, ms = 20000) => { const t = Date.now(); while (!f() && Date.now() - t < ms) await sleep(100); };
// (the search box's results for a query: the box is emptied first, which
// hides the list, so that the list shown after typing is this query's, not
// the last one's still there while the language's index loads)
const search = async (q) => {
  await ev(`(() => { const i = document.querySelector("#docsearch"); i.focus(); i.value = ""; i.dispatchEvent(new Event("input")); return 1; })()`);
  await until(`document.querySelector("#docresults").hidden`);
  await ev(`(() => { const i = document.querySelector("#docsearch"); i.value = ${JSON.stringify(q)}; i.dispatchEvent(new Event("input")); return 1; })()`);
  await until(`!document.querySelector("#docresults").hidden && document.querySelector("#docresults").children.length > 0`);
  return ev(`[...document.querySelectorAll("#docresults li")].map((li) => li.textContent)`);
};
const mode = () => ev("window.sagebrush.notebook.mode");

try {
  await send("Runtime.enable");
  await send("Page.enable");
  await send("Page.navigate", { url });
  await until("!!window.sagebrush?.notebook");
  await sleep(500);
  // (an empty Python notebook to begin with: the page opens on its welcome notebook)
  await ev(`(window.sagebrush.notebook.load({ mode: "python", cells: [] }), 1)`);
  // (until the welcome notebook has gone: with its code still there, a change of language asks)
  await until(`window.sagebrush.notebook.mode === "python" && window.sagebrush.notebook.cells().every((c) => c.ta.value.trim() === "")`);
  // an empty notebook: its language changes without a question
  answer = false;
  await choose("matlab");
  check(await mode() === "matlab" && dialogs.length === 0, "an empty notebook's language changes without a question");

  let hits = await search("galois group");
  check(!hits.some((t) => /galois/i.test(t)), "in a MATLAB notebook, the search has no Sage functions: " + JSON.stringify(hits[0]?.slice(0, 80)));
  hits = await search("linspace");
  check(hits.some((t) => t.startsWith("linspace")), "and finds MATLAB's: " + JSON.stringify(hits[0]?.slice(0, 60)));

  await choose("sage");
  hits = await search("galois group");
  check(hits.some((t) => /galois_group/.test(t)), "in a Sage notebook, it finds Sage's functions");
  check(!(await ev(`[...document.querySelectorAll("#docresults li")].some((li) => li.textContent.startsWith("linspace("))`)), "and no MATLAB ones");

  await choose("python");
  hits = await search("galois group");
  check(!hits.some((t) => /galois/i.test(t)), "in a Python notebook, the search has no Sage functions: " + JSON.stringify(hits[0]?.slice(0, 80)));
  hits = await search("linspace");
  check(hits.some((t) => t.startsWith("numpy.linspace")), "and finds NumPy's: " + JSON.stringify(hits[0]?.slice(0, 60)));
  // (the catalog's entries list their examples, catalog/SCHEMA.md: counted
  // as the older indexes' counts, and none for a name with no entry)
  const lin = hits.find((t) => t.startsWith("numpy.linspace("));
  check(/1 example(?!s)/.test(lin ?? "") && !/object/.test(lin ?? ""), "a catalog entry shows its examples' count: " + JSON.stringify(lin?.slice(0, 120)));
  hits = await search("amax");
  const amax = hits.find((t) => t.startsWith("numpy.amax"));
  check(!!amax && !/example/.test(amax), "a public name with no catalog entry shows none: " + JSON.stringify(amax?.slice(0, 120)));

  // a function's examples: inserted only into a notebook of its language, which never changes
  await choose("sage");
  await search("galois_group");
  const listed = await until(`!!document.querySelector("#docresults li[role=option]")`);
  check(!!listed, "a Sage function is listed to open");
  if (listed) await ev(`document.querySelector("#docresults li[role=option]").dispatchEvent(new MouseEvent("mousedown", { bubbles: true }))`);
  await until(`document.querySelector("#docdlg").open`);
  check(await ev(`!document.querySelector("#docinsert").hidden`), "a Sage function's examples can be inserted into a Sage notebook");
  await ev(`document.querySelector("#docinsert").click()`);
  await until(`window.sagebrush.notebook.cells().some((c) => c.ta.value.includes("galois_group"))`);
  check(await mode() === "sage" && await ev(`window.sagebrush.notebook.cells().some((c) => c.ta.value.includes("galois_group"))`), "inserted, the notebook stays Sage");

  // a notebook with code: choosing another language asks, and No keeps it
  answer = false;
  await choose("matlab", false);
  await waitFor(() => dialogs.length > 0);
  await sleep(300);
  check(dialogs.length === 1 && /from Sage to MATLAB/.test(dialogs[0]), "with code, choosing another language asks first: " + JSON.stringify(dialogs[0]?.slice(0, 70)));
  check(await mode() === "sage" && await ev(`document.querySelector("#mode").value`) === "sage", "No keeps the notebook's language, and the menu shows it");

  // (a Sage function opened in a MATLAB notebook: its examples can't be inserted there)
  answer = true;
  await choose("matlab");
  await sleep(300);
  check(await mode() === "matlab", "Yes changes it");

  // a catalog entry's examples are its own (catalog/SCHEMA.md), inserted as they are
  answer = true;
  await choose("python");
  await search("linspace");
  await ev(`[...document.querySelectorAll("#docresults li[role=option]")].find((li) => li.textContent.startsWith("numpy.linspace(")).dispatchEvent(new MouseEvent("mousedown", { bubbles: true }))`);
  await until(`document.querySelector("#docdlg").open`);
  await ev(`document.querySelector("#docinsert").click()`);
  await until(`window.sagebrush.notebook.cells().some((c) => c.ta.value === "np.linspace(0, 1, 5)")`).catch(() => {});
  check(await ev(`window.sagebrush.notebook.cells().some((c) => c.ta.value === "np.linspace(0, 1, 5)")`), "a Python catalog entry's example is inserted into a Python notebook");
  await ev(`(() => { const i = document.querySelector("#docsearch"); i.value = ""; return 1; })()`);
  check(errors.length === 0, "no exceptions" + (errors.length ? ": " + errors.slice(0, 2).join(" | ") : ""));
} finally {
  ws.close(); chrome.kill();
}
console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);
