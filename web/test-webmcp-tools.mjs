// The notebook page's WebMCP tools for the notebook and the person's files (sim runs 2 and 3: APP-webmcp-file-ops,
// APP-report-export-agent, APP-set-language-agent, APP-csv-upload-agent, APP-add_markdown), in headless Chromium against
// the built site. William, Nov 2: agents must see and verify anything they do, so each check reads back what a tool
// says against what is there: the notebook open, its file in the person's files, the file's bytes, the cells.
//   bun web/build.ts, then node web/test-webmcp-tools.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { devtoolsPort } from "./test-port.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = mkdtempSync(join(tmpdir(), "sb-webmcp-tools-"));
const serve = spawn("python3", [join(here, "serve.py"), "0"], { stdio: ["ignore", "pipe", "inherit"] });
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
const ev = async (expression) => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 500)); return r.result?.value; };
const until = async (expr, ms = 60000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(expr).catch(() => false)) return true; await sleep(200); } return false; };
const fails = [];
let checks = 0;
const check = (ok, what) => { checks++; console.log((ok ? "ok   " : "FAIL ") + what); if (!ok) fails.push(what); };
// (a tool, as a browser with WebMCP would call it: its answer's text parts, and whether it is an error)
const call = (name, args = {}) => ev(`window.__tools[${JSON.stringify(name)}].execute(${JSON.stringify(args)}).then((r) => ({ error: !!r.isError, texts: r.content.filter((c) => c.type === "text").map((c) => c.text) }))`);
const json = async (name, args) => { const r = await call(name, args); if (r.error) throw new Error(`${name}: ${r.texts[0]}`); return JSON.parse(r.texts[0]); };
const files = () => ev(`window.sagebrush.workspace.list("/", { recursive: true }).then((l) => l.map((e) => e.path))`);
const TOOLS = ["search_docs", "run_python", "read_notebook", "add_markdown", "notebook_info", "new_notebook", "rename_notebook", "set_language", "export_notebook", "list_files", "read_file", "write_file", "edit_notebook", "notebook_graph", "verify_notebook", "set_interact"];
try {
  for (const m of ["Page.enable", "Runtime.enable"]) await send(m);
  await send("Page.addScriptToEvaluateOnNewDocument", { source: `navigator.modelContext = { registerTool(t) { (window.__tools ??= {})[t.name] = t; } };` });
  await send("Page.navigate", { url: `http://127.0.0.1:${port}/` });
  check(await until("!!window.__tools?.notebook_info && !!window.sagebrush?.workspace && !!document.querySelector('#cells textarea')"), "the page registers its tools and opens the person's files");
  const names = await ev("Object.keys(window.__tools)");
  check(TOOLS.every((t) => names.includes(t)), `every tool is registered (${names.join(", ")})`);

  // notebook_info: what is open
  let info = await json("notebook_info");
  check(info.name === "Welcome" && info.language === "python" && info.cells > 0, `notebook_info: the Welcome notebook, Python (${JSON.stringify(info)})`);
  check(await until(`window.__tools.notebook_info.execute({}).then((r) => JSON.parse(r.content[0].text).path === "/Welcome.ipynb")`, 15000), "notebook_info: its path in the person's files once saved there");

  // new_notebook: opened, in its language, with its cells, in the files
  check((await call("new_notebook", { language: "fortran" })).error, "new_notebook: an unknown language is refused");
  check((await call("new_notebook", { nme: "x" })).texts[0].startsWith('unknown argument "nme"'), "new_notebook: a misspelled argument is said, not ignored");
  info = await json("new_notebook", { name: "Agent work", language: "sage", cells: ["factor(2^10 - 1)"] });
  check(info.name === "Agent work" && info.language === "sage" && info.code_cells === 1 && info.path === "/Agent work.ipynb", `new_notebook: named, Sage, its cell, its file (${JSON.stringify(info)})`);
  check((await ev(`({ name: document.querySelector("#nbname").value, mode: sagebrush.notebook.mode, code: sagebrush.notebook.cells()[0].ta.value })`)).code === "factor(2^10 - 1)", "…and it is the notebook open in the page");
  check((await files()).includes("/Welcome.ipynb"), "…and the notebook before it is still in the files");

  // set_language: refused with code; a notebook with no code changes
  const sl = await call("set_language", { language: "python" });
  check(sl.error && /has code, so its language isn't changed: open a new_notebook/.test(sl.texts[0]) && (await ev("sagebrush.notebook.mode")) === "sage", "set_language: a notebook with code keeps its language, and the answer says what to do");

  // rename_notebook: the name and the file
  info = await json("rename_notebook", { name: "Mersenne factors" });
  check(info.name === "Mersenne factors" && info.path === "/Mersenne factors.ipynb", `rename_notebook: its name and its file's new path (${JSON.stringify(info)})`);
  const after = await files();
  check(after.includes("/Mersenne factors.ipynb") && !after.includes("/Agent work.ipynb"), "…the file browser has the new name, not the old");
  check((await ev(`document.querySelector("#nbname").value`)) === "Mersenne factors", "…and the page shows it");

  // add_markdown: a wrong argument is said; the answer has the cell's id
  const bad = await call("add_markdown", { txt: "# Title" });
  check(bad.error && bad.texts[0].startsWith('unknown argument "txt"'), `add_markdown: a wrong argument name is refused (${bad.texts[0]})`);
  check(!(await ev(`sagebrush.notebook.cells().some((c) => c.ta.value === "undefined")`)), "…and no cell says \"undefined\"");
  const md = await json("add_markdown", { text: "## Results\n\n$2^{10}-1 = 3 \\cdot 11 \\cdot 31$" });
  const ids = await ev(`sagebrush.notebook.cells().map((c) => c.id)`);
  check(typeof md.id === "string" && ids.includes(md.id) && md.reused_empty_cell === false && /Results/.test(md.rendered), `add_markdown: its cell's id, in the notebook, and what it renders (${JSON.stringify(md).slice(0, 120)})`);

  // a fresh notebook: set_language with no code; the reused empty cell said
  info = await json("new_notebook", { name: "Data" });
  check(info.language === "sage" && info.code_cells === 1, "new_notebook: by default in the language of the notebook before");
  info = await json("set_language", { language: "python" });
  check(info.language === "python" && (await ev("sagebrush.notebook.mode")) === "python" && (await ev(`document.querySelector("#mode").value`)) === "python", "set_language: a notebook with no code changes, and the page's language menu says so");
  const md2 = await json("add_markdown", { text: "# Data" });
  check(md2.reused_empty_cell === true && (await ev(`sagebrush.notebook.cells().length`)) === 1, "add_markdown: reusing the empty cell is said");

  // write_file / read_file / list_files: a CSV in the person's files, read by code
  check((await call("write_file", { path: "/data.csv" })).error, "write_file: text or base64 is required");
  check((await call("write_file", { path: "/x.ipynb", text: "{}" })).error, "write_file: not a notebook");
  const w1 = await json("write_file", { path: "/data.csv", text: "x,y\n1,2\n3,5\n" });
  check(w1.entry?.path === "/data.csv" && w1.entry.kind === "file" && w1.entry.size === 12, `write_file: the file's entry (${JSON.stringify(w1)})`);
  const r1 = await json("read_file", { path: "/data.csv" });
  check(r1.text === "x,y\n1,2\n3,5\n", "read_file: its text, as written");
  const w2 = await json("write_file", { path: "/data.csv", text: "x,y\n1,2\n3,5\n8,13\n" });
  check(w2.entry.size === 17 && (await json("read_file", { path: "/data.csv" })).text.endsWith("8,13\n"), "write_file: an existing file is replaced");
  const w3 = await json("write_file", { path: "/blob.bin", base64: "AP8Q" });
  const r3 = await json("read_file", { path: "/blob.bin" });
  check(w3.entry.size === 3 && r3.base64 === "AP8Q", `write_file and read_file: bytes as base64 (${JSON.stringify(r3)})`);
  const run = await ev(`window.__tools.run_python.execute({ code: "rows = [l.split(',') for l in open('data.csv').read().splitlines()]\\nprint(len(rows), rows[-1])" }).then((r) => r.content.filter((c) => c.type === "text").map((c) => c.text).join(" "))`);
  check(/4 \[.8., .13.\]/.test(run), `code in the notebook reads the file write_file put there (${run.slice(0, 600)})`);
  const lf = await json("list_files", { folder: "/" });
  check(["/data.csv", "/blob.bin", "/Data.ipynb", "/Mersenne factors.ipynb"].every((p) => lf.entries.some((e) => e.path === p)), `list_files: the file browser's entries (${lf.entries.map((e) => e.path).join(", ")})`);
  check((await call("read_file", { path: "/nope.txt" })).error, "read_file: a missing file is an error");

  // export_notebook: the file's text, to check; html is a standalone report with the outputs and no script
  await ev(`window.__tools.run_python.execute({ code: "print(6 * 7)" })`);
  const plot = await ev(`window.__tools.run_python.execute({ code: "import matplotlib.pyplot as plt\\nplt.plot([1, 4, 9])\\nplt.show()" }).then((r) => r.content.map((c) => c.type))`);
  const ip = await call("export_notebook", { format: "ipynb" });
  const meta = JSON.parse(ip.texts[0]), nbf = JSON.parse(ip.texts[1]);
  check(meta.file === "Data.ipynb" && meta.bytes > 0 && nbf.nbformat === 4 && nbf.cells.some((c) => String(c.source).includes("print(6 * 7)")), `export_notebook ipynb: the file's name and its JSON (${JSON.stringify(meta)})`);
  const py = await call("export_notebook", { format: "script" });
  check(JSON.parse(py.texts[0]).file === "Data.py" && py.texts[1].includes("print(6 * 7)"), "export_notebook script: the .py");
  const html = await call("export_notebook", { format: "html" });
  const h = html.texts[1];
  check(JSON.parse(html.texts[0]).file === "Data.html" && /^<!doctype html>/.test(h) && h.includes("<h1>Data</h1>") && /42/.test(h) && h.includes("print(6 * 7)"), "export_notebook html: a standalone page with the code and its output");
  check(!/<script|<iframe|\son[a-z]+=/i.test(h), "…with no script, frame or handler");
  check(plot.includes("image") && /<img [^>]*src="data:image\/png;base64,|<svg[\s>]/.test(h), `…and the plot as an image (run_python's answer: ${plot.join(", ")})`);
  check((await call("export_notebook", { format: "pdf" })).error, "export_notebook: an unknown format is refused");
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
