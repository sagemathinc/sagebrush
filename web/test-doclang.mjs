// ci: web-browser/notebook order=110
// The notebook's language, which only its user changes: the search box finds
// the functions of the notebook's language only (Sage's library in a Sage
// notebook, MATLAB's built-ins in a MATLAB one, and says there is no search in
// a Python one); a function's examples are inserted only into a notebook of
// its language, never switching it; choosing another language for a notebook
// with code asks first, and cancelling keeps the language. The agents'
// search_docs tool (WebMCP) finds every language's functions, whatever the
// notebook's, marking those of another language.
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
  // (the results, and the line a search with no match shows; not the Request link after them)
  return ev(`[...document.querySelectorAll("#docresults li:not(.req)")].map((li) => li.textContent)`);
};
const mode = () => ev("window.sagebrush.notebook.mode");
// (the language menu's tooltip: what the selected language does, sage's n8 walkthrough)
const tip = () => ev(`document.querySelector("#mode").title`);

try {
  await send("Runtime.enable");
  await send("Page.enable");
  // (the page's WebMCP tools, kept as it registers them: a stand-in for the browser's navigator.modelContext)
  await send("Page.addScriptToEvaluateOnNewDocument", { source: "Object.defineProperty(navigator, 'modelContext', { value: { registerTool(t) { (window.__sbTools ??= {})[t.name] = t; } } });" });
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
  check(/^MATLAB mode:/.test(await tip()), "the menu's tooltip is MATLAB's: " + JSON.stringify(await tip()));

  let hits = await search("galois group");
  check(!hits.some((t) => /galois/i.test(t)), "in a MATLAB notebook, the search has no Sage functions: " + JSON.stringify(hits[0]?.slice(0, 80)));
  hits = await search("linspace");
  // (a MATLAB catalog entry shows its signature, "y = linspace(x1, x2)")
  check(hits.some((t) => /^(?:\S+ = )?linspace\b/.test(t)), "and finds MATLAB's: " + JSON.stringify(hits[0]?.slice(0, 60)));

  await choose("sage");
  check(/^Sage mode:/.test(await tip()), "the menu's tooltip is Sage's: " + JSON.stringify(await tip()));
  hits = await search("galois group");
  check(hits.some((t) => /galois_group/.test(t)), "in a Sage notebook, it finds Sage's functions");
  check(!(await ev(`[...document.querySelectorAll("#docresults li")].some((li) => li.textContent.startsWith("linspace("))`)), "and no MATLAB ones");

  await choose("python");
  check(/^Python mode:/.test(await tip()) && !/Sage/.test(await tip()), "the menu's tooltip is Python's, with no Sage line: " + JSON.stringify(await tip()));
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
  check(/^Sage mode:/.test(await tip()), "…and its tooltip is still Sage's: " + JSON.stringify(await tip()));

  // (a Sage function opened in a MATLAB notebook: its examples can't be inserted there)
  answer = true;
  await choose("matlab");
  await sleep(300);
  check(await mode() === "matlab", "Yes changes it");

  // a catalog entry's examples are its own (catalog/SCHEMA.md), inserted with
  // the imports they need, and run so in a fresh notebook (CORR-012-1)
  answer = true;
  await ev(`(window.sagebrush.notebook.load({ mode: "python", cells: [] }), 1)`);
  await until(`window.sagebrush.notebook.mode === "python" && window.sagebrush.notebook.cells().every((c) => c.ta.value.trim() === "")`);
  await search("linspace");
  await ev(`[...document.querySelectorAll("#docresults li[role=option]")].find((li) => li.textContent.startsWith("numpy.linspace(")).dispatchEvent(new MouseEvent("mousedown", { bubbles: true }))`);
  await until(`document.querySelector("#docdlg").open`);
  await ev(`document.querySelector("#docinsert").click()`);
  const want = "import numpy as np\n\nnp.linspace(0, 1, 5)";
  await until(`window.sagebrush.notebook.cells().some((c) => c.ta.value === ${JSON.stringify(want)})`).catch(() => {});
  check(await ev(`window.sagebrush.notebook.cells().some((c) => c.ta.value === ${JSON.stringify(want)})`), "a Python catalog entry's example is inserted with its imports");
  // (run, in this fresh notebook: shift-enter in the inserted cell)
  await ev(`(() => { const c = window.sagebrush.notebook.cells().find((c) => c.ta.value === ${JSON.stringify(want)}); c.ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true })); return 1; })()`);
  await until(`[...document.querySelectorAll(".cell .out")].some((o) => /0\\.25/.test(o.textContent) || /Error/.test(o.textContent))`, 60000).catch(() => {});
  const out = await ev(`[...document.querySelectorAll(".cell .out")].map((o) => o.textContent).join(" | ")`);
  check(/array\(\[0\.\s+, 0\.25, 0\.5 , 0\.75, 1\.\s+\]\)/.test(out) && !/Error/.test(out), "and it runs there: " + JSON.stringify(out.slice(0, 120)));
  await ev(`(() => { const i = document.querySelector("#docsearch"); i.value = ""; return 1; })()`);

  // the agents' search_docs: every language's functions, whatever the notebook's (agent simulation run 2)
  const tool = (args) => ev(`window.__sbTools.search_docs.execute(${JSON.stringify(args)}).then((r) => ({ err: !!r.isError, text: r.content.map((c) => c.text).join("\\n") }))`);
  check(await mode() === "python", "(a Python notebook for the tool's checks)");
  let r = await tool({ query: "prime_range" });
  check(/^prime_range\(.*\)  \[Sage\]/m.test(r.text) && /This notebook is Python/.test(r.text) && /sage=true \(Sage\)/.test(r.text), "in a Python notebook, search_docs finds a Sage function, marked [Sage]: " + JSON.stringify(r.text.slice(0, 160)));
  r = await tool({ query: "minimal polynomial" });
  check(/minimal_polynomial/.test(r.text), "and Sage's minimal_polynomial: " + JSON.stringify(r.text.slice(0, 120)));
  r = await tool({ query: "linspace" });
  check(/^numpy\.linspace\(/m.test(r.text.split("\n")[0]) && !/^numpy\.linspace\(.*\[Python\]/m.test(r.text), "the notebook's own language's results are first and unmarked: " + JSON.stringify(r.text.slice(0, 120)));
  r = await tool({ query: "prime_range", language: "python" });
  check(!/^prime_range/m.test(r.text) && !r.err, "language narrows the search to one index: " + JSON.stringify(r.text.slice(0, 80)));
  r = await tool({ query: "prime_range", language: "fortran" });
  check(r.err && /No documentation search for "fortran"/.test(r.text), "an unknown language is an error naming the choices: " + JSON.stringify(r.text.slice(0, 120)));
  answer = true;
  await choose("sage");
  r = await tool({ query: "linspace" });
  check(/numpy\.linspace\(.*\)  \[Python\]/.test(r.text) && /sage=false \(Python\)/.test(r.text), "in a Sage notebook, it finds NumPy's, marked [Python]: " + JSON.stringify(r.text.slice(0, 160)));

  // Each catalog result shows its status; a Partly or Not yet function, and a search with no match, can be asked
  // for: the prefilled coverage-request issue, in a new tab (web/docsearch.ts requestUrl)
  const ask = (mode, name) => "https://github.com/sagemathinc/sagebrush/issues/new?template=coverage-request.yml&labels=coverage-request&title=" + encodeURIComponent(`[Request] ${mode}: ${name}`) + "&mode=" + mode + "&name=" + encodeURIComponent(name);
  answer = true;
  await choose("matlab");
  await search("eig");
  const eig = await ev(`(() => { const li = [...document.querySelectorAll("#docresults li[role=option]")].find((li) => /\\beig\\(/.test(li.querySelector(".sig").textContent)); return li && li.querySelector(".badge.st-partly")?.textContent; })()`);
  check(eig === "Partly", "a partial MATLAB function shows Partly: " + JSON.stringify(eig));
  await search("audioread");
  const ar = await ev(`(() => { const li = [...document.querySelectorAll("#docresults li[role=option]")].find((li) => /audioread/.test(li.querySelector(".sig").textContent)); return li && [li.querySelector(".badge.st-not-yet")?.textContent, li.querySelector(".sum").textContent]; })()`);
  check(ar?.[0] === "Not yet" && /^Instead: /.test(ar[1]), "an absent one shows Not yet, and what to use instead: " + JSON.stringify(ar));
  const more = await ev(`(() => { const a = document.querySelector("#docresults li.req a"); return a && [a.textContent, a.href, a.target, a.rel]; })()`);
  check(more?.[0] === "Not what you need? Request “audioread” in MATLAB" && more[1] === ask("MATLAB", "audioread") && more[2] === "_blank" && more[3] === "noopener noreferrer", "after the results, a request for the query, in a new tab: " + JSON.stringify(more));
  await ev(`[...document.querySelectorAll("#docresults li[role=option]")].find((li) => /audioread/.test(li.textContent)).dispatchEvent(new MouseEvent("mousedown", { bubbles: true }))`);
  await until(`document.querySelector("#docdlg").open`);
  const dlg = await ev(`[!document.querySelector("#docrequest").hidden, document.querySelector("#docrequest").href, document.querySelector("#docbody").textContent.split("\\n")[0]]`);
  check(dlg[0] && dlg[1] === ask("MATLAB", "audioread") && dlg[2] === "Not yet in Sagebrush.", "its page says Not yet, with Request: " + JSON.stringify(dlg));
  await ev(`document.querySelector("#docclose").click()`);
  await search("eig");
  await ev(`[...document.querySelectorAll("#docresults li[role=option]")].find((li) => /\\beig\\(/.test(li.querySelector(".sig").textContent)).dispatchEvent(new MouseEvent("mousedown", { bubbles: true }))`);
  await until(`document.querySelector("#docdlg").open`);
  const pdlg = await ev(`[!document.querySelector("#docrequest").hidden, document.querySelector("#docbody").textContent.split("\\n").slice(0, 2)]`);
  check(pdlg[0] && pdlg[1][0] === "Partly in Sagebrush:" && /^- /.test(pdlg[1][1]), "a Partly one's page lists what differs, with Request: " + JSON.stringify(pdlg));
  await ev(`document.querySelector("#docclose").click()`);
  await search("numel");
  await ev(`[...document.querySelectorAll("#docresults li[role=option]")].find((li) => /\\bnumel\\(/.test(li.querySelector(".sig").textContent)).dispatchEvent(new MouseEvent("mousedown", { bubbles: true }))`);
  await until(`document.querySelector("#docdlg").open`);
  check(await ev(`document.querySelector("#docrequest").hidden && document.querySelector("#docbody").textContent.startsWith("Works in Sagebrush.")`), "a function that works says so, with no Request");
  await ev(`document.querySelector("#docclose").click()`);
  hits = await search("zzqq nothing");
  const none = await ev(`(() => { const a = document.querySelector("#docresults li.req a"); return a && [a.textContent, a.href]; })()`);
  check(hits.length === 1 && /No MATLAB function/.test(hits[0]) && none?.[0] === "Request “zzqq nothing” in MATLAB" && none[1] === ask("MATLAB", "zzqq nothing"), "a search with no match offers its request: " + JSON.stringify([hits, none]));
  r = await tool({ query: "audioread", language: "matlab" });
  check(/\[Not yet\]/.test(r.text) && r.text.includes("request it: " + ask("MATLAB", "audioread")), "search_docs gives agents the status and the request: " + JSON.stringify(r.text.slice(0, 200)));
  r = await tool({ query: "zzqq nothing", language: "matlab" });
  check(r.text.includes(ask("MATLAB", "zzqq nothing")), "and the request on a miss: " + JSON.stringify(r.text.slice(0, 200)));
  check(await ev(`document.querySelector("#docresults li.req a")?.dataset.requestUrl`) === ask("MATLAB", "zzqq nothing"), "the request link carries its URL as data-request-url too");

  // The real system's names the index lacks (docs-upstream-<mode>.json, web/upstream-names.mts): one MATLAB has
  // and Sagebrush hasn't is Not yet, with Request; documented results come before every one of them
  const row = (name) => ev(`(() => { const li = [...document.querySelectorAll("#docresults li[role=option]")].find((li) => li.querySelector(".sig").textContent.replace(/(Works|Partly|Not yet)$/, "") === ${JSON.stringify(name)}); return li && [li.querySelector(".badge")?.textContent ?? null, li.querySelector(".sum").textContent, li.dataset.status ?? null]; })()`);
  await search("fir1");
  let fir = await row("fir1");
  check(fir?.[0] === "Not yet" && fir[1] === "Not in Sagebrush yet: MATLAB's Signal Processing Toolbox has it." && fir[2] === "not-yet", "a toolbox function MATLAB has is Not yet, with its toolbox: " + JSON.stringify(fir));
  check(await ev(`document.querySelector("#docsearch").dataset.upstream`) === "loaded", "the search box says the upstream names were loaded (data-upstream)");
  await ev(`[...document.querySelectorAll("#docresults li[role=option]")].find((li) => li.querySelector(".sig").textContent.startsWith("fir1")).dispatchEvent(new MouseEvent("mousedown", { bubbles: true }))`);
  await until(`document.querySelector("#docdlg").open`);
  const fdlg = await ev(`[!document.querySelector("#docrequest").hidden, document.querySelector("#docrequest").href, document.querySelector("#docrequest").dataset.requestUrl, document.querySelector("#docbody").textContent, document.querySelector("#doctitle").textContent]`);
  check(fdlg[0] && fdlg[1] === ask("MATLAB", "fir1") && fdlg[2] === fdlg[1] && fdlg[3] === "Not in Sagebrush yet: MATLAB's Signal Processing Toolbox has it." && fdlg[4] === "fir1", "its page says so, with Request for it: " + JSON.stringify(fdlg));
  await ev(`document.querySelector("#docclose").click()`);
  await search("svd");
  const svd = await ev(`[...document.querySelectorAll("#docresults li[role=option]")].map((li) => [li.querySelector(".sig").textContent, li.dataset.status ?? ""])`);
  check(/\bsvd\(/.test(svd[0]?.[0]) && svd[0][1] === "partly", "MATLAB's svd is Partly, first: " + JSON.stringify(svd.slice(0, 2)));
  r = await tool({ query: "fir1", language: "matlab" });
  check(/^fir1  \[Not yet\]/m.test(r.text) && r.text.includes("request it: " + ask("MATLAB", "fir1")), "search_docs gives agents fir1's status and its request: " + JSON.stringify(r.text.slice(0, 200)));
  answer = true;
  await ev(`(window.sagebrush.notebook.load({ mode: "python", cells: [] }), 1)`);
  await until(`window.sagebrush.notebook.mode === "python"`);
  await search("abc.ABC");
  const abc = await row("abc.ABC");
  check(abc?.[0] === null && abc[1] === "In Sagebrush; not documented here yet." && abc[2] === null, "a name Sagebrush has undocumented shows no status: " + JSON.stringify(abc));
  await search("asyncio.run");
  const arun = await row("asyncio.run");
  check(arun?.[0] === "Not yet" && arun[1] === "Not in Sagebrush yet: Python has it.", "a Python name Sagebrush hasn't is Not yet: " + JSON.stringify(arun));
  await choose("sage");
  await search("AbelianGroup");
  const ag = await row("AbelianGroup");
  check(ag?.[0] === "Not yet", "so is a Sage one: " + JSON.stringify(ag));
  await choose("magma");
  await search("AGDecode");
  const agd = await row("AGDecode");
  check(agd?.[0] === "Not yet" && agd[1] === "Not in Sagebrush yet: Magma has it.", "and a Magma one: " + JSON.stringify(agd));

  // A query that names an area of the language shows that area's line above the results: its title, its badge, its
  // evidence and Request for it (web/coverage-areas.mts); results below it still open as before
  await choose("sage");
  await search("elliptic curves");
  const arow = await ev(`(() => { const li = document.querySelector("#docresults li.area"); const a = li?.querySelector("a"); return li && [li.dataset.area, li.querySelector(".sig").textContent, li === document.querySelector("#docresults").firstElementChild, li.getAttribute("role"), a?.href, a?.dataset.requestUrl, a?.target]; })()`);
  check(arow?.[0] === "elliptic-curves" && /^Elliptic curves/.test(arow[1]) && arow[2] && arow[3] === null && arow[4] === ask("Sage", "Elliptic curves") && arow[5] === arow[4] && arow[6] === "_blank", "a query naming an area shows its line first, not as a result, with Request for it: " + JSON.stringify(arow));
  const firstSig = await ev(`document.querySelector("#docresults li[role=option] .sig")?.textContent`);
  await ev(`document.querySelector("#docresults li[role=option]").dispatchEvent(new MouseEvent("mousedown", { bubbles: true }))`);
  await until(`document.querySelector("#docdlg").open`);
  check(firstSig && (await ev(`document.querySelector("#doctitle").textContent`)) === firstSig.replace(/(Works|Partly|Not yet)$/, "").replace(/\d+ examples?$/, "").replace(/open problem$/, ""), "the first result below it still opens itself: " + JSON.stringify(firstSig?.slice(0, 60)));
  await ev(`document.querySelector("#docclose").click()`);
  await search("zzqq nothing");
  check(!(await ev(`!!document.querySelector("#docresults li.area")`)), "a query naming no area shows none");
  // (an area that matches with no function under it: "No single ...", and its own Request only, no second one)
  await choose("matlab");
  hits = await search("dynamic code");
  const lone = await ev(`[!!document.querySelector("#docresults li.area[data-area=language-dynamic]"), [...document.querySelectorAll("#docresults li.none:not(.req)")].map((li) => li.textContent), document.querySelectorAll("#docresults li.req").length]`);
  check(lone[0] && JSON.stringify(lone[1]) === JSON.stringify(["No single MATLAB function's documentation has all of these words."]) && lone[2] === 0, "an area with no function under it says no single function matched, with the area's Request only: " + JSON.stringify(lone));
  r = await tool({ query: "linear algebra", language: "matlab" });
  check(/^Area: Arrays and matrices|^Area: Linear algebra/.test(r.text) && r.text.includes("request more of it: "), "search_docs gives agents the area line first: " + JSON.stringify(r.text.slice(0, 160)));
  check(errors.length === 0, "no exceptions" + (errors.length ? ": " + errors.slice(0, 2).join(" | ") : ""));
} finally {
  ws.close(); chrome.kill();
}
console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);
