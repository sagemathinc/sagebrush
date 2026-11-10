// ci: checks.3 order=105 runner=bun
// (checks.3: after the job's final build-cli, as this runs the session's script in build/cli/pyjs.cjs --sage, with node;
// bun runs the rest: web/notebook's runner and kernel are ES modules in .js files; about 4 s)
// The editor's Run (run-core.mjs), without a browser: the session's script run in the CLI's own Sage (the same
// engine's Python and preparser as the page's runner), its printed results parsed and turned into the results file's
// states; then those states shown by the renderer's own rule (sagetex.mjs savedStates/stateOf). William's case: a
// value, a computation, a name defined again later (page order), a failing item, which stops the rest, a plot as an
// SVG; and the parts alone: refused items, a session that stopped,
// unreadable lines, bounds, a traceback without the script's frames.
//   node scripts/build-cli.mjs && bun web/latex/test-latex-run.mjs
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { seenOf, driver, runnable, parseOutput, statesOf, BLOCKED, resultsText, msgOf, MARK, RUN_LIMITS, RESULTS_FORMAT, runAndSave, sessionOf, sandboxEngine, SANDBOX_FAILED, folderFiles, runIn, DEPS_MARK, parseDeps, depsWith, wsReader, checkedResults } from "./run-core.mjs";
import { Engine, installPythontex } from "./engine/pipeline.mjs";
import * as pythontexCode from "./engine/pythontex.mjs";
import { itemKey, savedStates, stateOf, WRAPPER_VERSION, MAX_RESULT, safeRel, depsOf, staleOf, staleOfSync, sha256hex, readComplete, DEPS_MAX, inlineHtml, blockHtml, mathPart } from "./engine/sagetex.mjs";
import { interactsOf, interactsHtml, INTERACT_LIMITS } from "./interact.ts";

const results = [];
const check = (name, ok, detail) => { results.push([name, !!ok]); if (!ok) console.log("FAIL", name, JSON.stringify(detail)?.slice(0, 900)); };
// (an item as the worker's check sends it: its key, and its code unless refused)
// (the renderer's item, as itemOf makes it: a refused one has no code)
const real = (mode, code, extra = {}) => (extra.err ? { mode, opts: [], ...extra } : { mode, code, opts: [] });
const item = (mode, code, extra = {}) => { const it = real(mode, code, extra); return { mode, err: it.err ?? null, key: itemKey(it), ...(it.err ? {} : { code }), ...(it.name ? { name: it.name } : {}) }; };

// ---- the parts alone
{
  const its = [item("silent", "x = 1"), item("sage", "x", { err: "cs", name: "foo" }), item("sage", "x")];
  check("runnable: a refused item isn't sent, nor anything after it (it fails, which stops the rest)", JSON.stringify(runnable(its)) === JSON.stringify([{ mode: "silent", code: "x = 1" }]), runnable(its));
  const st = statesOf(its, [{ s: "ok" }], "");
  check("statesOf: a refused item says why, the next one is not run (M4)", st[1].s === "error" && /TeX command/.test(st[1].msg) && st[2].s === "blocked" && st[2].msg === BLOCKED, st);
  check("statesOf: every state has its item's key", st.every((s, k) => s.key === its[k].key), st);
  const cut = statesOf([item("silent", "a"), item("sage", "b")], [{ s: "ok" }], "the run was stopped");
  check("statesOf: an item after the session stopped says so", cut[1].s === "error" && cut[1].msg === "not run: the run was stopped", cut);
  const big = statesOf([item("sage", "b")], [{ s: "ok", latex: "x".repeat(MAX_RESULT + 1) }], "");
  check("statesOf: a result over MAX_RESULT is an error", big[0].s === "error" && /over/.test(big[0].msg), big);
  const notSvg = statesOf([item("plot", "p")], [{ s: "ok", svg: "<script>alert(1)</script>" }], "");
  check("statesOf: a plot that isn't an SVG is an error", notSvg[0].s === "error" && !notSvg[0].src, notSvg);
  const bigSvg = statesOf([item("plot", "p")], [{ s: "ok", svg: "<svg>" + "x".repeat(RUN_LIMITS.svg) }], "");
  check("statesOf: a plot over the SVG limit is an error", bigSvg[0].s === "error", bigSvg);
  const svg = statesOf([item("plot", "p")], [{ s: "ok", svg: "<svg xmlns='http://www.w3.org/2000/svg'>é</svg>" }], "");
  check("statesOf: a plot becomes a base64 SVG data URL (UTF-8)", svg[0].s === "ok" && /^data:image\/svg\+xml;base64,[A-Za-z0-9+/]+=*$/.test(svg[0].src) && Buffer.from(svg[0].src.split(",")[1], "base64").toString() === "<svg xmlns='http://www.w3.org/2000/svg'>é</svg>", svg);
  const out = `hello\n${MARK}{"s": "ok"}\n${MARK}not json\n${MARK}3\nbye`;
  const got = parseOutput(out);
  check("parseOutput: only marked lines; an unreadable one is an error", got.length === 3 && got[0].s === "ok" && got[1].s === "error" && got[2].s === "error", got);
  const tb = 'Traceback (most recent call last):\n  File "<cell>", line 15, in <module>\n    _sx_r = {"s": "ok"}\n  File "<string>", line 1, in <module>\n    y\nNameError: name \'y\' is not defined\n';
  check("msgOf: the script's own frames are dropped", msgOf(tb) === 'Traceback (most recent call last):\n  File "<string>", line 1, in <module>\n    y\nNameError: name \'y\' is not defined', msgOf(tb));
  const j = JSON.parse(resultsText(st));
  check("resultsText: results v1 of this wrapper", j.format === RESULTS_FORMAT && j.version === 1 && j.wrapper === WRAPPER_VERSION && j.items.length === 3, j);
  // (the code reaches the script only as base64: quotes, newlines and backslashes can't end its string)
  const evil = '"); import os; ("\n\\x1eSBTX{}';
  const d = driver([{ mode: "silent", code: evil }]);
  check("driver: code only as base64", !d.includes("import os") && !d.includes('"); '), d.slice(0, 200));
}

// ---- values kept while their code is stale (@sagebrush's Q3 ruling, Nov 8: the last values, marked stale, never "…")
{
  const SVG = "data:image/svg+xml;base64,PHN2Zy8+";
  const ok = (it, f = {}) => ({ key: itemKey(it), s: "ok", ...f });
  const A = real("silent", "a = 3"), B = real("sage", "a^2"), P = real("plot", "plot(x^a)"), C = real("sage", "7");
  const saved = [ok(A), ok(B, { latex: "9" }), ok(P, { src: SVG }), ok(C, { latex: "7" })];
  const kinds = (st, its) => its.map((it, k) => stateOf(st, k, it).s);
  const A2 = real("silent", "a = 4");
  const st1 = savedStates([A2, B, P, C], saved);
  check("stale: an item edited in place, and every one after it, keep their last values, stale", JSON.stringify(kinds(st1, [A2, B, P, C])) === JSON.stringify(["stale", "stale", "stale", "stale"]) && stateOf(st1, 1, B).latex === "9" && stateOf(st1, 2, P).src === SVG, st1);
  check("stale: unchanged items before the edit stay ok", JSON.stringify(kinds(savedStates([A, B, P, real("sage", "8")], saved), [A, B, P, real("sage", "8")])) === JSON.stringify(["ok", "ok", "ok", "stale"]), null);
  check("stale: each stale state carries its item's own key (the renderer's stateOf takes it)", st1.every((s, k) => s.key === itemKey([A2, B, P, C][k])), st1);
  const N = real("sage", "1 + 1");
  const st2 = savedStates([N, A, B, P, C], saved);
  check("stale: an item inserted before the others is not run; the others keep their own values (by their code)", JSON.stringify(kinds(st2, [N, A, B, P, C])) === JSON.stringify(["notrun", "stale", "stale", "stale", "stale"]) && stateOf(st2, 2, B).latex === "9" && stateOf(st2, 4, C).latex === "7", st2);
  const B2 = real("sage", "a^3");
  check("stale: an edited \\sage keeps the value of the one it replaced, at its place", stateOf(savedStates([A2, B2, P, C], saved), 1, B2).latex === "9", null);
  const failed = [ok(A), { key: itemKey(B), s: "error", msg: "NameError" }, ok(C, { latex: "7" })];
  check("stale: an item whose last Run failed has no value to keep: not run", kinds(savedStates([A2, B2, C], failed), [A2, B2, C]).join() === "stale,notrun,stale", null);
  const asPlot = real("plot", "a^2");
  check("stale: an item of another kind at the place is not given the old value (a \\sage's value to a \\sageplot)", stateOf(savedStates([A, asPlot, P, C], saved), 1, asPlot).s === "notrun", null);
  const old = [ok(A), { ...ok(B, { latex: "9" }), key: JSON.stringify(["sage", "a^2", [], null, "sbtx-wrapper-1"]) }];
  check("stale: a value from another wrapper isn't kept at an edited place", stateOf(savedStates([A2, B2], old), 1, B2).s === "notrun", null);
  // (as the renderer shows them: the value, marked; a stale code block no "not run" chip)
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const sh = inlineHtml(stateOf(st1, 1, B), B, esc, (l) => "<m>" + l + "</m>", 2);
  check("stale: a \\sage value shown, marked (class sagestale, its title)", /^<span class="sagestale" title="Changed since the last Run[^"]*"><m>9<\/m><\/span>$/.test(sh), sh);
  const ph = inlineHtml(stateOf(st1, 2, P), P, esc, (l) => l, 3);
  check("stale: a plot shown, marked", /^<img class="sageplot sagestale" title="[^"]+" alt="a plot" src="data:image\/svg\+xml;base64,PHN2Zy8\+">$/.test(ph), ph);
  check("stale: a stale code block shows no chip", blockHtml(stateOf(st1, 0, A2), A2, esc, 1) === "", null);
  check("stale: in math, the last value", mathPart(stateOf(st1, 1, B), B) === "{9}", null);
  check("stale: a stale plot's src is still checked (only a base64 SVG data URL)", !/<img/.test(inlineHtml({ key: itemKey(P), s: "stale", src: "javascript:1" }, P, esc, (l) => l, 3)), null);
}
// (the mapping's rules one by one, grader's #874 probe scenarios, each with head's value: by key once per saved result,
//  in order; by position only for an ok result of the same kind and wrapper whose code is gone)
{
  const r = (mode, code) => ({ mode, code, opts: [] });
  const ok = (it, f = {}) => ({ key: itemKey(it), s: "ok", ...f });
  const show = (st, its) => its.map((it, k) => { const s = stateOf(st, k, it); return s.s + (s.latex ? ":" + s.latex : ""); }).join(" ");
  const A = r("sage", "a"), B = r("sage", "b"), C = r("sage", "c"), N = r("sage", "new"), X = r("sage", "x"), Pl = r("plot", "p");
  const cases = [
    ["an unchanged item whose last Run failed, after an edit above it: not run (an error is no value)", [C, B], [ok(A, { latex: "1" }), { key: itemKey(B), s: "error", msg: "E" }], "stale:1 notrun"],
    ["the same code twice after an insert: each saved result used once, in order", [N, X, X], [ok(X, { latex: "x1" }), ok(X, { latex: "x2" })], "notrun stale:x1 stale:x2"],
    ["by position only when the old code is gone (it is still here: kept for its own item)", [C, A], [ok(A, { latex: "1" }), ok(B, { latex: "2" })], "notrun stale:1"],
    ["more copies than saved results: the extra one is not run", [N, X, X, X], [ok(X, { latex: "x1" }), ok(X, { latex: "x2" })], "notrun stale:x1 stale:x2 notrun"],
    ["an item edited in place, after an unchanged one: the old value by position", [A, C], [ok(A, { latex: "1" }), ok(B, { latex: "2" })], "ok:1 stale:2"],
    ["a result in the current prefix is never taken again by a later copy", [A, N, A], [ok(A, { latex: "1" }), ok(B, { latex: "2" })], "ok:1 stale:2 notrun"],
    ["by position from an errored result: not run", [C], [{ key: itemKey(A), s: "error", msg: "E" }], "notrun"],
    ["by position from another kind: not run", [Pl], [ok(A, { latex: "1" })], "notrun"],
    ["by position from another wrapper: not run", [C], [{ ...ok(A, { latex: "1" }), key: JSON.stringify(["sage", "a", [], null, "sbtx-wrapper-1"]) }], "notrun"],
  ];
  for (const [what, its, saved, want] of cases) { const got = show(savedStates(its, saved), its); check("stale: " + what, got === want, { got, want }); }
}
// (the renderer's math region (render.mjs mathStale), grader's #874 R4/R5: a region with a stale \sage value is marked as
//  a whole; a region after it, with no stale value, is not; a render with nothing stale marks nothing)
{
  const doc = (code) => "\\documentclass{article}\n\\usepackage{sagetex}\n\\begin{document}\n$a = \\sage{" + code + "}$ and $x^2$.\n\\end{document}\n";
  const items = new Engine({}).update(doc("1+1"), { cold: true }).sageItems;
  const saved = [{ key: itemKey(items[0]), s: "ok", latex: "2" }];
  const html = (code) => new Engine({ sage: { saved } }).update(doc(code), { cold: true }).chunks.join("");
  const fresh = html("1+1"), stale = html("1+2");
  const regions = (h) => h.split('<span class="sagestale"').length - 1;
  check("stale math: a render with its value current marks nothing", regions(fresh) === 0 && /2/.test(fresh), fresh.slice(0, 300));
  check("stale math: its \\sage edited, the region keeps the last value, marked once; the next region ($x^2$) is not", regions(stale) === 1 && /<span class="sagestale" title="Changed since the last Run[^"]*"><span class="katex/.test(stale) && !/<span class="sagestale"[^>]*>(?:(?!<\/span>).)*x\^\{?2/.test(stale.split('<span class="sagestale"')[1]?.split("and")[1] ?? ""), stale.slice(0, 500));
}


// ---- the script in Sage (the CLI's own: build/cli/pyjs.cjs --sage)
const CLI = new URL("../../build/cli/pyjs.cjs", import.meta.url).pathname;
if (!existsSync(CLI)) {
  console.log("FAIL: no build/cli/pyjs.cjs: run node scripts/build-cli.mjs first");
  process.exit(1);
}
const sage = (code) => new Promise((res) => {
  const dir = mkdtempSync(join(tmpdir(), "sb-latex-run-")), f = join(dir, "run.sage");
  writeFileSync(f, code);
  const p = spawn("node", [CLI, "--sage", f], { cwd: dir });
  let o = "", e = "";
  p.stdout.on("data", (x) => (o += x)); p.stderr.on("data", (x) => (e += x));
  p.on("close", (c) => { rmSync(dir, { recursive: true, force: true }); res({ code: c, out: o, err: e }); });
});
// ---- PythonTeX, step (a): \py, pycode and pyblock run by the editor's Run (run-core's driver, in the CLI's own Sage),
// as plain Python in a namespace of their own; their results read back as TeX by the preview: the oracle's document,
// against real PythonTeX's PDF (pdflatex, pythontex, pdflatex; its pdftotext, ¡b¿ being OT1's < and >)
{
  installPythontex(pythontexCode);
  const src = "\\documentclass{article}\n\\usepackage{pythontex}\n\\begin{document}\nA: \\py{2**10}.\n\\begin{pycode}\nx = 7\nprint(r\"B: \\textbf{\" + str(x*6) + \"}.\")\n\\end{pycode}\nC: \\py{x}.\n\\begin{pyblock}\ny = x + 1\nprint(y)\n\\end{pyblock}\nD: \\printpythontex\nE: \\py{'<b>'}.\n\\end{document}\n";
  const its = new Engine().update(src).sageItems.map((it) => ({ mode: it.mode, code: it.code, err: it.err ?? null, key: itemKey(it) }));
  // (plain Python, not Sage: 2**10 an int, 1/2 a float, and Sage's names not defined; the Sage items' session apart)
  const r = await sage(driver(runnable(its.concat([{ mode: "py", code: "(1/2, type(2**10).__name__, 'QQ' in globals())", key: "k" }]))));
  const st = statesOf(its, parseOutput(r.out), "");
  check("pythontex: the session ran, each item ok", r.code === 0 && st.length === 5 && st.every((x) => x.s === "ok"), [r.err.slice(-400), st]);
  check("pythontex: plain Python in its own namespace", parseOutput(r.out)[5]?.latex === "(0.5, 'int', False)", parseOutput(r.out)[5]);
  const html = new Engine({ sage: { saved: st } }).update(src, { cold: true }).chunks.join(" ");
  const text = html.replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ").trim();
  check("pythontex: the oracle's text, word for word (but <b> for the PDF's font artifacts)", text === "A: 1024. B: 42. C: 7. y = x + 1 print(y) D: 8 E: <b>.", text);
}
// ---- @interact in a Run (a Sagebrush extension: William, Nov 8), in the CLI's own Sage: each interact an item makes is
// kept with its result, its controls and what its function printed and showed at the defaults; the runtime's own host
// and display are back after the Run
{
  const spec = [
    ["silent", "@interact\ndef h(k=slider(1, 5, 1, 2), name='x', on=True):\n    print('k^2 =', k^2)\n    show(plot(sin(k*x), (x, 0, pi)))"],
    ["sage", "1 + 1"],
    ["block", "@interact\ndef g(c=selector(['red', 'blue'])):\n    print(c)\nprint('after')"],
    ["silent", "print(type(__builtins__.__pyjs_host__ if hasattr(__builtins__, '__pyjs_host__') else None))"],
  ];
  const its = spec.map((a) => item(...a));
  const r = await sage(driver(runnable(its)) + "\nimport builtins\nprint('HOSTBACK', getattr(builtins, '__pyjs_host__', None) is not _sx_host, getattr(builtins, '__pyjs_display__', None) is not _sx_disp)");
  const st = statesOf(its, parseOutput(r.out), "", interactsOf);
  const h = st[0].interacts?.[0];
  check("interact: none kept without the interact chunk's check (statesOf not given it)", statesOf(its, parseOutput(r.out), "").every((x) => !x.interacts), null);
  check("interact: the session ran", r.code === 0, r.err.slice(-600));
  check("interact: kept with its item: its controls at their defaults (a slider, an input box, a checkbox)", st[0].s === "ok" && st[0].interacts?.length === 1 && h.name === "h" &&
    JSON.stringify(h.controls.map((c) => [c.kind, c.name, c.value])) === JSON.stringify([["slider", "k", 2], ["input", "name", "x"], ["checkbox", "on", true]]) && h.controls[0].min === 1 && h.controls[0].max === 5, st[0]);
  check("interact: what its function printed at the defaults", h?.out === "k^2 = 4\n", h?.out);
  check("interact: what it showed (a plot, as a base64 SVG data URL)", h?.shows?.length === 1 && /^data:image\/svg\+xml;base64,/.test(h.shows[0].src ?? ""), h?.shows?.map((x) => String(x.src ?? x.text).slice(0, 60)));
  check("interact: an item without one has none; the next interact is its own item's", !st[1].interacts && st[1].latex === "2" && st[2].interacts?.[0]?.name === "g" && st[2].interacts[0].controls[0].kind === "selector" && st[2].interacts[0].out === "red\n", st.slice(1, 3));
  check("interact: the runtime's own host and display are back after the Run", /HOSTBACK True True/.test(r.out), r.out.split("\n").filter((l) => l.startsWith("HOSTBACK")));
  // (the session's output is unchecked input: interactsOf keeps only known kinds and fields, bounded; a "plot" that isn't an
  //  SVG is never an image)
  const bad = interactsOf([{ spec: { id: 1, name: "f", controls: [{ kind: "script", name: "x" }, { kind: "slider", name: "n", value: 3, min: 0, max: "9;evil" }] }, out: "x".repeat(INTERACT_LIMITS.text + 10), shows: [{ svg: "<script>alert(1)</script>" }, { text: 7 }] }, ...Array(20).fill({ spec: {} })]);
  check("interact: only known control kinds, numeric bounds only; text bounded; a non-SVG show is no image; at most INTERACT_LIMITS.n", bad.length === INTERACT_LIMITS.n && bad[0].controls.length === 1 && bad[0].controls[0].max === undefined && bad[0].out.length === INTERACT_LIMITS.text && !bad[0].shows[0].src && bad[0].shows[1].text === "", bad[0]);
  // (as the renderer shows them: controls drawn, not live; the output; the note; everything escaped)
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const html = interactsHtml(st[0].interacts);
  check("interact: drawn as disabled controls at their defaults, the output, and the note", /<input type="range" disabled min="1" max="5" step="1" value="2"><span class="si-v">2<\/span>/.test(html) && /<input type="checkbox" disabled checked>/.test(html) && /<pre class="si-out">k\^2 = 4\n<\/pre>/.test(html) && /<img class="sageplot" alt="a plot" src="data:image\/svg\+xml;base64,/.test(html) && /<div class="si-note">Interactive in Sagebrush<\/div>/.test(html), html.slice(0, 400));
  const evil = interactsHtml([{ id: 1, controls: [{ kind: "input", name: '"><script>', value: '"><img src=x onerror=alert(1)>' }, { kind: "selector", options: ["<b>"], value: 0 }], out: "<script>", shows: [{ src: "javascript:alert(1)" }] }]);
  check("interact: names, values, options and output escaped; a src that isn't a base64 SVG is never an image", !/<script>|<img src=x|<b>|javascript:/.test(evil), evil);
  // (agents-ui's #926 A1/A2: a "text" control (text_control, fixed) is a line of text, as the notebook draws it, and
  //  nothing when empty; a "color" one a color control, only for a #rrggbb value, else the text box)
  const kinds = (controls) => interactsHtml([{ id: 1, controls, out: "", shows: [] }]);
  const tx = kinds([{ kind: "text", name: "", label: "", value: "Choose <n>" }]), fx = kinds([{ kind: "text", name: "n", label: "n", value: "" }]);
  check("interact: a text control is a line of its text (escaped), no label, no box; an empty one (fixed) nothing",
    tx.includes('<div class="si-t">Choose &lt;n&gt;</div>') && !/<input|si-l/.test(tx) && !/<input|si-l|si-t/.test(fx), { tx, fx });
  const col = kinds([{ kind: "color", name: "c", label: "c", value: "#1f77b4" }]), colBad = kinds([{ kind: "color", name: "c", label: "c", value: 'red" onclick="x' }]);
  check("interact: a color control drawn as one (#rrggbb only); any other value the text box, escaped",
    col.includes('<input type="color" disabled value="#1f77b4">') && !colBad.includes('type="color"') && colBad.includes('<input type="text" disabled value="red&quot; onclick=&quot;x">'), { col, colBad });
  // (grader's #926 C3: a valid colour followed by more is not a colour: the escaped text box)
  const colTail = kinds([{ kind: "color", name: "c", label: "c", value: '#1f77b4" onclick="x' }]);
  check("interact: a colour value with anything after its #rrggbb is the escaped text box, never a colour control",
    !colTail.includes('type="color"') && colTail.includes('<input type="text" disabled value="#1f77b4&quot; onclick=&quot;x">'), colTail);
  // (grader's #926 I6/I7: a selector's default is the option selected; a list slider shows its default's label)
  const sel = kinds([{ kind: "selector", name: "c", label: "c", options: ["a", "b", "c"], value: 1 }]), lsl = kinds([{ kind: "slider", name: "t", label: "t", labels: ["p", "q", "r"], min: 0, max: 2, step: 1, value: 1 }]);
  check("interact: a selector's default option selected; a list slider shows its default's label",
    sel.includes('<option value="0">a</option><option value="1" selected>b</option><option value="2">c</option>') && lsl.includes('value="1"><span class="si-v">q</span>'), { sel, lsl });
  // (grader's #926 R8: interacts only on an item that ran to its result: its session result ok but its state an error,
  //  a plot that isn't an SVG, keeps none)
  const ia1 = [{ spec: { id: 1, name: "f", controls: [] }, out: "", shows: [] }];
  const badPlot = statesOf([item("plot", "p")], [{ s: "ok", svg: "<b>not svg</b>", interacts: ia1 }], "", interactsOf);
  check("interact: none kept on an item whose state is an error (a plot that isn't an SVG)", badPlot[0].s === "error" && !badPlot[0].interacts, badPlot);
  check("interact: a stale one is marked as stale values are", /^<div class="sageinteract sagestale" title="Changed since the last Run/.test(interactsHtml(st[0].interacts, true)), null);
  // (the worker's renderer: a placeholder holding them as escaped JSON, said interactive, for the page's chunk to draw)
  const at = blockHtml(stateOf(savedStates([real(...spec[0])], st.slice(0, 1)), 0, real(...spec[0])), real(...spec[0]), esc, 1);
  const data = /^<div class="sageinteract-at" data-ia="([^"]*)"><div class="si-note">Interactive in Sagebrush<\/div><\/div>$/.exec(at);
  const unesc = (t) => t.replace(/&(amp|lt|gt|quot);/g, (_, e) => ({ amp: "&", lt: "<", gt: ">", quot: '"' })[e]);
  check("interact: a sagesilent's block is a placeholder holding its interacts (escaped JSON), said interactive", !!data && JSON.stringify(JSON.parse(unesc(data[1]))) === JSON.stringify(st[0].interacts), at.slice(0, 200));
}
// (grader's #926 R1, R3, R8, I6/I7 in the CLI's own Sage: at most 8 interacts kept an item, the 9th run once as without a host; the
// item's own output back after an interact's function ran; an item that raises after its interact keeps none; a
// selector's and a list slider's defaults)
{
  const spec = [
    ["silent", "@interact\ndef s(c=selector(['a', 'b', 'c'], default='b'), t=slider(['p', 'q', 'r'], default='q')):\n    pass"],
    ["silent", Array.from({ length: 9 }, (_, n) => `@interact\ndef f${n}(k=slider(0, 1, 1, 0)):\n    global RAN${n}\n    RAN${n} = True\n`).join("")],
    ["silent", "@interact\ndef a(k=slider(0, 1, 1, 0)):\n    print('in a')\nimport sys\n_AFTER = sys.stdout is _sx_buf\nprint('after')"],
    // (last: a failing item stops the rest)
    ["silent", "@interact\ndef e(k=slider(0, 1, 1, 0)):\n    print('in e')\nraise ValueError('after the interact')"],
  ];
  const its = spec.map((a) => item(...a));
  const r = await sage(driver(runnable(its)) + "\nprint('PINS', 'RAN7' in globals(), 'RAN8' in globals(), _AFTER)");
  const got = parseOutput(r.out), st = statesOf(its, got, "", interactsOf);
  const pins = (r.out.split("\n").find((l) => l.startsWith("PINS")) ?? "").split(" ");
  const sh = interactsHtml(st[0].interacts ?? []);
  check("interact (Sage): a selector's default selected, a list slider at its default's label", st[0].s === "ok" && /<option value="1" selected>b<\/option>/.test(sh) && /value="1"><span class="si-v">q<\/span>/.test(sh), { st0: st[0], err: r.err.slice(-400) });
  check("interact (Sage): an item that raises after its interact: its error, no interacts, no placeholder", st[3].s === "error" && /after the interact/.test(st[3].msg) && !st[3].interacts &&
    !blockHtml(stateOf(savedStates([real(...spec[3])], st.slice(3, 4)), 0, real(...spec[3])), real(...spec[3]), (x) => String(x), 1).includes("sageinteract-at"), st[3]);
  check("interact (Sage): at most 8 kept an item; the 9th not kept, run once at its defaults as on Sage's command line", got[1]?.interacts?.length === 8 && got[1].interacts.every((x) => x.spec?.name !== "f8") && pins[1] === "True" && pins[2] === "True", { n: got[1]?.interacts?.length, pins });
  check("interact (Sage): after an interact's function, the item's own output is back (its later print isn't the interact's)", pins[3] === "True" && st[2].interacts?.[0]?.out === "in a\n", { pins, out: st[2].interacts?.[0]?.out });
}
{
  const spec = [
    ["silent", "var('t')\nx = 2^10"],
    ["sage", "x"],
    ["sage", "integrate(t^2, t, 0, 1)"],
    ["block", "x = 7\nprint('not a result')"],
    ["sage", "x"],
    ["plot", "plot(sin(t), (t, 0, 3))"],
  ];
  const its = spec.map((a) => item(...a)), reals = spec.map((a) => real(...a));
  const r = await sage(driver(runnable(its)));
  const st = statesOf(its, parseOutput(r.out), "");
  const show = (k) => stateOf(savedStates(reals, st), k, reals[k]);
  check("sage: the session ran", r.code === 0, r.err.slice(-600));
  check("sage: \\sage{x} is 1024", st[1].s === "ok" && st[1].latex === "1024", st[1]);
  check("sage: integrate is \\frac{1}{3}", st[2].s === "ok" && st[2].latex === "\\frac{1}{3}", st[2]);
  check("sage: x defined again later is 7 (page order)", st[4].s === "ok" && st[4].latex === "7", st[4]);
  check("sage: an item's own printing isn't a result", !r.out.split("\n").some((l) => l === "not a result"), r.out.slice(0, 300));
  check("sage: the plot is an SVG data URL", st[5].s === "ok" && /^data:image\/svg\+xml;base64,/.test(st[5].src ?? ""), { ...st[5], src: String(st[5].src).slice(0, 80) });
  // (a failing item stops the rest, every language (@sagebrush's ruling, Nov 10): the script ends at it, and each later
  //  item says so, board's M4; a refused item is a failure too, and nothing after it is sent)
  {
    const fs = [["silent", "y = 1/0"], ["sage", "y"], ["sage", "1+1"]].map((a) => item(...a));
    const fr = await sage(driver(runnable(fs)));
    const fst = statesOf(fs, parseOutput(fr.out), "");
    check("stop: 1/0 shows ZeroDivisionError", fst[0].s === "error" && /ZeroDivisionError/.test(fst[0].msg) && !/<cell>|_sx_/.test(fst[0].msg), fst[0]);
    check("stop: the script ends at the failed item (one result printed)", fr.code === 0 && parseOutput(fr.out).length === 1, parseOutput(fr.out));
    check("stop: each later item is not run, saying why (M4)", fst.slice(1).every((x) => x.s === "blocked" && x.msg === BLOCKED) && BLOCKED === "Not run: an item before this one failed (fix it and run again)", fst);
    const rs = [["sage", "1"], ["sage", "x", { err: "cs", name: "foo" }], ["sage", "2"]].map((a) => item(...a));
    const rr = await sage(driver(runnable(rs)));
    const rst = statesOf(rs, parseOutput(rr.out), "");
    check("stop: a refused item says why, and stops the rest; nothing after it is sent", runnable(rs).length === 1 && rst[0].s === "ok" && rst[1].s === "error" && /TeX command/.test(rst[1].msg) && rst[2].s === "blocked" && rst[2].msg === BLOCKED, rst);
    // (a session that ended for another reason keeps its own words)
    const ended = statesOf(rs.slice(0, 1).concat([item("sage", "3")]), [], "");
    check("stop: a session that ended keeps its own words, not M4", ended.every((x) => x.s === "error" && /the session ended before this item/.test(x.msg)), ended);
  }
  check("sage: every state is shown by the renderer's rule (keys match, in order)", savedStates(reals, st).length === its.length, null);
  check("sage: the renderer shows 1024 for item 2", show(1).s === "ok" && show(1).latex === "1024", show(1));
  // Sage's arithmetic in every item (#706, a wrong answer: each item was exec'd as Python, 1/3 a float, an exact sum
  // short of its 10^-24 term): the values Sage gives (sage -c on the same lines; latex() as Sage writes it)
  {
    const ex = await sage(driver([
      { mode: "block", code: "a = 1/3\nb = 2^3\nc = 5^^3\nR.<t> = QQ[]\nL = sum(1/10^factorial(j) for j in range(1, 5))" },
      { mode: "sage", code: "a" }, { mode: "sage", code: "b" }, { mode: "sage", code: "c" }, { mode: "sage", code: "L" },
      { mode: "sage", code: " 1/2 + 1/3 " }, { mode: "sage", code: "(t+1)^2" },
    ]));
    const v = parseOutput(ex.out).map((g) => g.s === "ok" ? g.latex ?? "" : "error: " + String(g.msg).slice(-120));
    check("sage: exact as Sage: 1/3, 2^3, 5^^3 (xor), the sum with its 10^-24 term, 1/2 + 1/3, (t+1)^2 over QQ",
      JSON.stringify(v) === JSON.stringify(["", "\\frac{1}{3}", "8", "6", "\\frac{110001000000000000000001}{1000000000000000000000000}", "\\frac{5}{6}", "t^{2} + 2 t + 1"]), v);
  }
  // a second Run in the same session starts from the session's first globals: a name of the first Run is gone
  const two = await sage(driver([{ mode: "silent", code: "z = 5" }]) + driver([{ mode: "sage", code: "z" }]));
  const g2 = parseOutput(two.out);
  check("sage: a second Run doesn't see the first Run's names", g2.length === 2 && g2[0].s === "ok" && g2[1].s === "error" && /NameError/.test(g2[1].msg), g2);
  // (and a Sage name the first Run redefined, or a var() it made, is as Sage has it again)
  const three = await sage(driver([{ mode: "silent", code: "x = 7\nvar('w')" }]) + driver([{ mode: "sage", code: "x" }, { mode: "sage", code: "w" }]));
  const g3 = parseOutput(three.out);
  check("sage: a second Run sees Sage's own x, not the first Run's", g3.length === 3 && g3[1].s === "ok" && g3[1].latex === "x" && g3[2].s === "error" && /NameError/.test(g3[2].msg), g3);
}

// ---- LATEX-RUN-1 (astra): a Run that is no longer current writes nothing; a newer results file is never replaced
// A workspace as page.ts uses it (web/workspace/api.ts's rules: write's fid and base checked, and its admit asked,
// holding the lock; create refuses a path that's taken, and an aborted signal), with holds at each wait.
const gate = () => { let open; const p = new Promise((r) => (open = r)); return { p, open }; };
const dec = (b) => new TextDecoder().decode(b);
function fakeWs() {
  const files = new Map(), holds = {};
  let fids = 0;
  const wait = async (name) => { const h = holds[name]; if (h) { delete holds[name]; h.reached?.(); await h.p; } };
  const err = (code) => Object.assign(new Error(code), { code });
  return {
    files, holds,
    hold(name) { const g = gate(), r = gate(); holds[name] = { p: g.p, reached: r.open }; return { reached: r.p, open: g.open }; },
    put(p, text) { const f = files.get(p); files.set(p, { fid: f ? f.fid : "r" + ++fids, rev: f ? f.rev + 1 : 0, text }); },
    replace(p, text) { files.set(p, { fid: "r" + ++fids, rev: 0, text }); },
    async pathOfFile() { await wait("pathOfFile"); return { ok: true, path: "/paper.tex" }; },
    async stat(p) { await wait("stat"); const f = files.get(p); return f ? { fid: f.fid, rev: f.rev, path: p } : undefined; },
    async write(p, bytes, opts = {}) {
      await wait("write");   // (the lock taken: from here on, what this call checks is what it writes over)
      const f = files.get(p);
      opts.admit?.({ op: "write", role: "target", path: p, entry: f, chain: [] });
      if (!f) throw err("notfound");
      if (opts.fid !== undefined && f.fid !== opts.fid) throw err("conflict");
      if (opts.base !== undefined && f.rev !== opts.base) throw err("conflict");
      files.set(p, { fid: f.fid, rev: f.rev + 1, text: dec(bytes) });
    },
    async createByPerson(p, o) {
      await wait("create");
      if (o.signal?.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
      if (files.has(p)) throw err("exists");
      files.set(p, { fid: "r" + ++fids, rev: 0, text: dec(o.content) });
    },
  };
}
const RP = "/paper.tex.results.json";
const runItems = [item("silent", "a = 1"), item("sage", "a")];
// (a Run: its session's answer is `latex` for the \sage item; `holdExec` holds the session's run)
function startRun(ws, latex, opts = {}) {
  const life = { live: true, ac: new AbortController() };
  const exec = async () => { if (opts.holdExec) await opts.holdExec; return { out: `${MARK}{"s": "ok"}\n${MARK}${JSON.stringify({ s: "ok", latex })}\n`, stopped: "" }; };
  const p = runAndSave({ items: runItems, session: async () => ({}), exec, ws, fid: "tex1", current: () => life.live && (!opts.gen || opts.gen.n === opts.my), signal: life.ac.signal, max: 2 ** 20, now: () => 0 });
  return { p, dispose() { life.live = false; life.ac.abort(); } };
}
const shown = (ws) => { const f = ws.files.get(RP); return f ? JSON.parse(f.text).items[1].latex : null; };
{
  // the stale Run's wait at each step: the session's run, the .tex's path, the results file's stat, the write's lock
  for (const step of ["exec", "pathOfFile", "stat", "write"]) {
    const ws = fakeWs();
    ws.put(RP, resultsText([]));   // (an earlier results file)
    const g = gate();
    const h = step === "exec" ? null : ws.hold(step);
    const old = startRun(ws, "OLD", step === "exec" ? { holdExec: g.p } : {});
    if (h) await h.reached; else await new Promise((r) => setTimeout(r, 5));
    old.dispose();   // (the page closed, or another file opened in it)
    const now = await startRun(ws, "NEW").p;
    g.open(); h?.open();
    const r = await old.p;
    check(`RUN-1 ${step}: the newer Run wrote its results`, now.ok === true, now);
    check(`RUN-1 ${step}: the disposed Run writes nothing over them`, r.stale === true && shown(ws) === "NEW", { r, shown: shown(ws) });
  }
  // a newer Run on the same page (its number) makes the older one stale too
  {
    const ws = fakeWs(), g = gate(), gen = { n: 1 };
    const old = startRun(ws, "OLD", { holdExec: g.p, gen, my: 1 });
    await new Promise((r) => setTimeout(r, 5));
    gen.n = 2;
    const now = await startRun(ws, "NEW", { gen, my: 2 }).p;
    g.open();
    const r = await old.p;
    check("RUN-1 generation: a superseded Run writes nothing", now.ok && r.stale === true && shown(ws) === "NEW", { r, shown: shown(ws) });
  }
  // (grader's T561-ADMIT) disposed while the write waits for the lock, nothing written meanwhile: only the admit
  // inside the lock refuses it
  {
    const ws = fakeWs();
    ws.put(RP, resultsText([]));
    const before = ws.files.get(RP).text;
    const h = ws.hold("write");
    const old = startRun(ws, "OLD");
    await h.reached;
    old.dispose();
    h.open();
    const r = await old.p;
    check("RUN-1 locked admit alone: disposed in the write lock, nothing written", r.stale === true && ws.files.get(RP).text === before && ws.files.get(RP).rev === 0, { r, rev: ws.files.get(RP).rev });
  }
  // still current, but the file was written meanwhile (another tab's Run): pinned by its revision, not replaced
  {
    const ws = fakeWs();
    ws.put(RP, resultsText([]));
    const h = ws.hold("write");
    const old = startRun(ws, "OLD");
    await h.reached;
    ws.put(RP, JSON.stringify({ items: [{}, { latex: "OTHER TAB" }] }));
    h.open();
    const r = await old.p;
    check("RUN-1 base: a results file written meanwhile isn't replaced", /changed meanwhile/.test(r.msg ?? "") && shown(ws) === "OTHER TAB", { r, shown: shown(ws) });
  }
  // another file put at the results path meanwhile: pinned by its fid
  {
    const ws = fakeWs();
    ws.put(RP, resultsText([]));
    const h = ws.hold("write");
    const old = startRun(ws, "OLD");
    await h.reached;
    ws.replace(RP, JSON.stringify({ items: [{}, { latex: "REPLACEMENT" }] }));
    h.open();
    const r = await old.p;
    check("RUN-1 fid: a file put at the path meanwhile isn't replaced", /changed meanwhile/.test(r.msg ?? "") && shown(ws) === "REPLACEMENT", { r, shown: shown(ws) });
  }
  // no results file yet, and one made meanwhile: the create refuses, nothing is written over it
  {
    const ws = fakeWs(), h = ws.hold("create");
    const old = startRun(ws, "OLD");
    await h.reached;
    ws.put(RP, JSON.stringify({ items: [{}, { latex: "MADE MEANWHILE" }] }));
    h.open();
    const r = await old.p;
    check("RUN-1 create: one made meanwhile isn't written over", /changed meanwhile/.test(r.msg ?? "") && shown(ws) === "MADE MEANWHILE", { r, shown: shown(ws) });
  }
  // disposed while the create waits: nothing is made
  {
    const ws = fakeWs(), h = ws.hold("create");
    const old = startRun(ws, "OLD");
    await h.reached;
    old.dispose();
    h.open();
    const r = await old.p;
    check("RUN-1 create: a disposed Run makes no file", r.stale === true && !ws.files.has(RP), { r, files: [...ws.files.keys()] });
  }
  // a Run that is current writes (the control for the cases above), a new file and over its own earlier one
  {
    const ws = fakeWs();
    const a = await startRun(ws, "FIRST").p, b = await startRun(ws, "SECOND").p;
    check("RUN-1: a current Run writes its results, then the next one over them", a.ok && b.ok && shown(ws) === "SECOND" && ws.files.get(RP).rev === 1, { a, b, shown: shown(ws) });
  }
  // the control: 9cedc1b5's sequence (live checked only before the session ran; then the path, the stat and an
  // unconditional write, or create then write on "exists"), in the same case as "RUN-1 pathOfFile": it overwrites
  {
    const ws = fakeWs();
    ws.put(RP, resultsText([]));
    let live = true;
    const old9 = async (latex) => {
      if (!live) return;
      const states = statesOf(runItems, parseOutput(`${MARK}{"s": "ok"}\n${MARK}${JSON.stringify({ s: "ok", latex })}\n`), "");
      const bytes = new TextEncoder().encode(resultsText(states));
      const at = await ws.pathOfFile("tex1");
      const rp = at.path + ".results.json", e = await ws.stat(rp).catch(() => undefined);
      if (e && !e.trashed) await ws.write(rp, bytes);
      else { try { await ws.createByPerson(rp, { content: bytes }); } catch (err) { if (err?.code === "exists") await ws.write(rp, bytes); else throw err; } }
    };
    const h = ws.hold("pathOfFile");
    const p = old9("OLD");
    await h.reached;
    live = false;
    await startRun(ws, "NEW").p;
    h.open();
    await p;
    check("RUN-1 control: 9cedc1b5's sequence writes the old results over the newer ones", shown(ws) === "OLD", shown(ws));
  }
}

// ---- LATEX-RUN-2 (astra): the session in the runner only, never a plain worker of the page's own origin
// web/notebook's own RunnerWorker and WorkerKernel, in a fake page: a frame that loads, then is given the worker's
// script (fetched here: `fetchOk` says whether it is there) and answers as the runner page does (`answers`).
{
  const made = { workers: 0, runners: [] };
  globalThis.location = new URL("http://localhost/sagebrush/");
  globalThis.Worker = class { constructor() { made.workers++; throw new Error("a plain worker was made"); } };
  const frameMode = { fetchOk: false, answers: false };
  // (answered after the frame has loaded, as on a network: the runner is waiting for it by then)
  globalThis.fetch = async (u) => (await new Promise((r) => setTimeout(r, 10)), frameMode.fetchOk ? { ok: true, status: 200, text: async () => "// the worker" } : { ok: false, status: 404, text: async () => "" });
  globalThis.document = {
    body: { appendChild(f) { setTimeout(() => f.fire("load"), 1); } },
    createElement() {
      const ls = {};
      return {
        style: {}, setAttribute() {}, remove() {}, addEventListener(t, f) { (ls[t] ??= []).push(f); }, fire(t) { for (const f of ls[t] ?? []) f(); },
        contentWindow: {
          postMessage(m, _o, ports) {
            if (!frameMode.answers || !ports?.[0]) return;
            const port = ports[0];
            port.postMessage({ runnerReady: 1 });
            // (the interpreter: ready, then any code it is sent is done)
            port.onmessage = (e) => { const d = e.data; if (d?.code !== undefined) port.postMessage({ id: d.id, done: true, ms: 1 }); };
            setTimeout(() => port.postMessage({ ready: true, version: "test" }), 1);
          },
        },
      };
    },
  };
  const { RunnerWorker } = await import("../notebook/runner-worker.js");
  const { WorkerKernel } = await import("../notebook/worker-kernel.js");
  const mod = { RunnerWorker: class extends RunnerWorker { constructor(src, o) { made.runners.push(o); super(src, o); } }, WorkerKernel };
  const eng = sandboxEngine(mod, new URL("http://localhost/sagebrush/"));
  const session = sessionOf(eng, 3000);
  const t0 = Date.now();
  const first = await session().then(() => "started", (e) => e.message);
  check("RUN-2: a runner whose worker can't load fails closed, with the message", first === SANDBOX_FAILED && Date.now() - t0 < 2500, { first, ms: Date.now() - t0 });
  check("RUN-2: no plain worker, and the runner was given no fallback", made.workers === 0 && made.runners.length >= 1 && made.runners.every((o) => !o || o.fallback === undefined), made);
  // a frame that loads but never answers (an error page): no fallback after the runner's own timers, the start's
  // deadline says the message
  frameMode.fetchOk = true;
  const t1 = Date.now();
  const second = await session().then(() => "started", (e) => e.message);
  check("RUN-2: a frame that never answers fails closed at the deadline", second === SANDBOX_FAILED && Date.now() - t1 >= 2900, { second, ms: Date.now() - t1 });
  check("RUN-2: still no plain worker after the runner's timers", made.workers === 0, made);
  // the frame there now: the next Run starts a new runner, and runs in it
  frameMode.answers = true;
  const third = await session().then((k) => k, (e) => e.message);
  check("RUN-2: a later Run starts the sandbox again and it runs", typeof third === "object" && third.ready === true, typeof third === "string" ? third : "ready");
  const ran = typeof third === "object" ? await new Promise((res) => third.execute("1", { mode: "sage" }, { start() {}, out() {}, display() {}, interact() {}, clear() {}, done: (ms, o) => res(!o?.error), stopped: () => res(false), skipped: () => res(false) })) : false;
  check("RUN-2: code runs in that runner; still no plain worker", ran === true && made.workers === 0 && made.runners.every((o) => !o || o.fallback === undefined) && made.runners.length === 3, made);
  third?.worker?.terminate?.();
}

// ---- the .tex's folder (Codex friction: a helper beside the .tex): the working folder and last on sys.path, as real
// SageTeX has it; each Run imports the folder's modules afresh (an edited helper, an edited package's child, a deleted
// helper), and a Run in another folder doesn't see the first one's. Four Runs in one session (the script's runs one
// after another, as the page's are), the files changed between them as putFolder changes them
{
  const root = mkdtempSync(join(tmpdir(), "sb-latex-folder-")), A = join(root, "a"), B = join(root, "b");
  for (const d of [A, join(A, "pkg"), B]) mkdirSync(d, { recursive: true });
  writeFileSync(join(A, "helper.py"), "def v():\n    return 1\n");
  writeFileSync(join(A, "pkg", "__init__.py"), "");
  writeFileSync(join(A, "pkg", "child.py"), "V = 10\n");
  // (a module of the standard library's name beside the .tex: the standard one is imported, the folder being last)
  writeFileSync(join(A, "statistics.py"), "SHADOW = 1\n");
  writeFileSync(join(B, "other.py"), "W = 5\n");
  // (B's own helper.py, of the same name as A's: B's is the one imported)
  writeFileSync(join(B, "helper.py"), "def v():\n    return 7\n");
  const py = (s) => `\n${s}\n`;
  const runs = [
    driver([
      { mode: "silent", code: "import sys, os\nsys.modules.pop('statistics', None)\npre = 'statistics' in sys.modules\nimport statistics, helper, pkg.child" },
      { mode: "sage", code: "(pre, hasattr(statistics, 'median'), hasattr(statistics, 'SHADOW'))" },
      { mode: "sage", code: "(helper.v(), pkg.child.V)" },
      { mode: "sage", code: `(os.getcwd() == ${JSON.stringify(A)}, sys.path[-1] == ${JSON.stringify(A)}, sys.path.count(${JSON.stringify(A)}))` },
    ], A),
    py(`open(${JSON.stringify(join(A, "helper.py"))}, "w").write("def v():\\n    return 2\\n")\nopen(${JSON.stringify(join(A, "pkg", "child.py"))}, "w").write("V = 20\\n")`),
    driver([{ mode: "silent", code: "import helper, pkg.child" }, { mode: "sage", code: "(helper.v(), pkg.child.V)" }], A),
    py(`import os as _o\n_o.remove(${JSON.stringify(join(A, "helper.py"))})`),
    driver([{ mode: "silent", code: "import helper" }], A),
    driver([
      { mode: "silent", code: "import sys, os\nimport other, helper" },
      { mode: "sage", code: `(other.W, os.getcwd() == ${JSON.stringify(B)}, sys.path.count(${JSON.stringify(A)}), sys.path[-1] == ${JSON.stringify(B)}, helper.v())` },
      { mode: "silent", code: "import pkg.child" },
    ], B),
  ];
  const r = await sage(runs.join("\n"));
  const got = parseOutput(r.out);
  // (Codex W01: each Run's last line, the modules it imported from its folder; the deps lines aren't results)
  const depLines = r.out.split("\n").filter((l) => l.startsWith(DEPS_MARK)).map((l) => JSON.parse(l.slice(DEPS_MARK.length)));
  // (astra's DEP-PARTIAL-COMMIT-1: the driver prints each item's line before its result: a result printed always
  //  follows a line naming what it used)
  const marked = r.out.split("\n").filter((l) => l.startsWith(MARK));
  check("DEP-PARTIAL-COMMIT-1: the driver prints each item's deps line just before its result", marked.length === 20 && marked.every((l, i) => l.startsWith(DEPS_MARK) === (i % 2 === 0)), marked.map((l) => (l.startsWith(DEPS_MARK) ? "D" : "R")).join(""));
  rmSync(root, { recursive: true, force: true });
  // (a tuple's LaTeX without Sage's \\left( \\right))
  const lx = (i) => String(got[i]?.latex ?? got[i]?.msg ?? JSON.stringify(got[i])).replace(/\\left|\\right/g, "");
  check("folder: the standard library's statistics wins over a statistics.py beside the .tex (imported cold: not vacuous)", /\\mathrm\{False\}, \\mathrm\{True\}, \\mathrm\{False\}/.test(lx(1)), { r1: lx(1), err: r.err.slice(-300) });
  check("folder: a helper and a package's child beside the .tex are imported", /\(1, 10\)/.test(lx(2)), lx(2));
  check("folder: the working folder is the .tex's, last on sys.path, once", /\\mathrm\{True\}, \\mathrm\{True\}, 1/.test(lx(3)), lx(3));
  check("folder: the next Run imports them afresh (an edited helper, an edited package child)", /\(2, 20\)/.test(lx(5)), lx(5));
  check("folder: a deleted helper is gone at the next Run", got[6]?.s === "error" && /No module named .?helper/.test(got[6]?.msg ?? ""), got[6]);
  check("W01: each Run names the modules it imported from its folder (a package's files too), and those of no other folder; the deps lines aren't results",
    // (one line after each item: Run 1's four, Run 2's two, Run 3's one, Run 4's three; each Run's last one counts)
    depLines.length === 10 && JSON.stringify(depLines[0]) === JSON.stringify(["helper.py", "pkg/__init__.py", "pkg/child.py"]) && JSON.stringify(depLines[3]) === JSON.stringify(depLines[0]) && JSON.stringify(depLines[5]) === JSON.stringify(depLines[0]) && JSON.stringify(depLines[6]) === "[]" && JSON.stringify(depLines[9]) === JSON.stringify(["helper.py", "other.py"]) && JSON.stringify(parseDeps(r.out)) === JSON.stringify(["helper.py", "other.py"]) && got.length === 10, { depLines, n: got.length });
  check("folder: a Run in another folder imports its own (its own helper.py of the same name), and not the first folder's (off sys.path, its modules dropped)", /\(5, \\mathrm\{True\}, 0, \\mathrm\{True\}, 7\)/.test(lx(8)) && got[9]?.s === "error" && /No module named .?pkg/.test(got[9]?.msg ?? ""), { r8: lx(8), r9: got[9] });
}

// ---- one Run at a time in the session (daybreak3, astra): a Run waiting for another puts nothing in the worker while
// that one runs (the worker reads files between the messages of a run, its packages' fetch for one); the next one's
// folder replaces the last one's whole (another folder's paths deleted); a Run cancelled while it waits runs nothing;
// cancelling the one running stops only it; a worker started again is given, first, no right to change files, then the
// admitted folder again. A kernel, worker and workspace of the test's own
{
  const posts = [], log = [];
  let onStartFn = null, gen = 0;
  const worker = () => { const g = ++gen; return { gen: g, postMessage: (m) => posts.push({ g, m }) }; };
  class FakeKernel {
    constructor(o) { onStartFn = o.onStart; this.ready = false; }
    start() { this.worker = worker(); onStartFn(this.worker); this.ready = true; }
    post(m) { this.worker?.postMessage(m); }
    on() { return () => {}; }
    interrupt() { log.push("interrupt " + running); }
  }
  let running = null;
  const s = sessionOf({ module: async () => ({ WorkerKernel: FakeKernel }), worker: () => null }, 1000);
  const tree = { a: { dir: "/A", files: [["/A/doc.tex", new Uint8Array([1])], ["/A/helper.py", new Uint8Array([2])]] }, b: { dir: "/B", files: [["/B/doc.tex", new Uint8Array([3])]] } };
  const ws = { pathOfFile: async (fid) => ({ ok: true, path: tree[fid].dir + "/doc.tex" }), stat: async () => undefined, createByPerson: async () => ({}), write: async () => ({}) };
  const holds = {};
  const run = (fid, signal) => runAndSave({
    items: [item("silent", "x = 1")], ws, fid, current: () => true, signal, max: 1 << 20, now: () => 0,
    session: s, store: s, serial: s.serial, folder: async () => tree[fid],
    exec: (k, code) => { running = fid; log.push("exec " + fid + " " + /"\/[AB]"/.test(Buffer.from(code.match(/_sx_d = _sx_json\.loads\(_sx_b64\.b64decode\("([^"]*)"\)/)?.[1] ?? "", "base64").toString()) ); return new Promise((r) => (holds[fid] = () => { running = null; r({ out: "", stopped: "" }); })); },
  });
  // (each wait bounded: a Run that never ends fails its check here, not the whole test)
  const within = (p, ms = 5000) => Promise.race([p, new Promise((r) => setTimeout(() => r({ timedOut: true }), ms))]);
  const putsOf = (from) => posts.slice(from).filter((p) => p.m.fsPut !== undefined).map((p) => [p.m.fsPut, p.m.data === null ? null : "bytes"]);
  const pA = run("a");
  for (let i = 0; i < 50 && !holds.a; i++) await new Promise((r) => setTimeout(r, 5));
  const afterA = posts.length, first = posts[0]?.m;
  const pB = run("b");
  await new Promise((r) => setTimeout(r, 30));
  const whileA = putsOf(afterA);
  const abC = new AbortController(), pC = run("a", abC.signal);
  await new Promise((r) => setTimeout(r, 10));
  abC.abort();
  holds.a();
  const rA = await within(pA);
  for (let i = 0; i < 50 && !holds.b; i++) await new Promise((r) => setTimeout(r, 5));
  const forB = putsOf(afterA);
  // (B running: its own Run cancelled stops it, and only it)
  const abB = new AbortController();
  const nowLog = log.length;
  check("serial: the worker's first message is no right to change files", first && first.fsWritable === false, first);
  check("serial: a Run waiting for another puts nothing in the worker while that one runs", whileA.length === 0, whileA);
  check("serial: the next folder replaces the last whole: the other folder's paths deleted, its own put", JSON.stringify(forB) === JSON.stringify([["/A/doc.tex", null], ["/A/helper.py", null], ["/B/doc.tex", "bytes"]]), forB);
  holds.b?.();
  const rB = await within(pB), rC = await within(pC);
  check("serial: a Run cancelled while it waits runs nothing", rC.stale === true && log.filter((l) => l.startsWith("exec")).length === 2, { rC, log });
  check("serial: each script given its own folder", log.filter((l) => l.startsWith("exec")).every((l) => l.endsWith("true")) && rA.ok && rB.ok, { log, rA, rB });
  // (cancelling the Run whose script runs: interrupt, only while it runs)
  const pD = run("a", abB.signal);
  for (let i = 0; i < 50 && running !== "a"; i++) await new Promise((r) => setTimeout(r, 5));
  abB.abort();
  holds.a();
  await within(pD);
  check("serial: cancelling the Run whose script runs stops that script, once", log.slice(nowLog).filter((l) => l.startsWith("interrupt")).join(",") === "interrupt a", log.slice(nowLog));
  // (the worker started again: no right to change files first, then the admitted folder (A's, the last), nothing else)
  const before = posts.length, w2 = worker();
  onStartFn(w2);
  const again = posts.slice(before).filter((p) => p.g === w2.gen).map((p) => p.m.fsWritable === false ? "ro" : p.m.fsPut);
  check("restart: a new worker is given no right to change files, then the last admitted folder", JSON.stringify(again) === JSON.stringify(["ro", "/A/doc.tex", "/A/helper.py"]), again);
}

// ---- the folder read (folderFiles, William's H2): only the files the document's code names (the modules it imports,
// the quoted paths of files there) and those its named .py files name in turn, from the .tex's folder only (a sibling
// whose name starts the same isn't in it); each named file's bytes read or none (one unreadable: nothing runs), within
// its bounds counted on the named files only (a folder of many files the code never names runs); and a .tex moved to
// another folder while its Run waited: nothing runs
{
  const enc = new TextEncoder();
  // (each entry [path, size or its text, in the cloud only]; `grown`: a file's size now, larger than when it was listed)
  const bounds = [];
  const mkws = (entries, unreadable = null, grown = {}) => ({
    list: async () => entries.map(([path, v, remote]) => ({ path, kind: "file", size: typeof v === "string" ? enc.encode(v).length : v, ...(remote ? { remote: true } : {}) })),
    readUpTo: async (p, max) => {
      bounds.push(max);
      if (p === unreadable) throw new Error("gone");
      const v = entries.find((e) => e[0] === p)[1], n = grown[p] ?? (typeof v === "string" ? enc.encode(v).length : v);
      if (n > max) throw Object.assign(new Error(p + " is larger than " + max + " bytes"), { code: "limit" });
      return { content: typeof v === "string" && !grown[p] ? enc.encode(v) : new Uint8Array(n) };
    },
  });
  const paths = (r) => JSON.stringify(r.files?.map(([p]) => p));
  // (/Ab/x.py and /Abh.py: beside the folder, not in it; /Abh.py, cut after the folder's "/A/", reads as h.py, which the code names)
  const ok = await folderFiles(mkws([["/A/doc.tex", 3], ["/A/sub/h.py", 2], ["/A/unused.dat", 5], ["/Ab/x.py", 1], ["/Abh.py", 1]]), "/A/doc.tex", ["from sub.h import f\nimport x, h"]);
  const okBounds = bounds.splice(0);
  check("folderFiles: each read bounded by what is left of the bound (grader's Z5: never unbounded)", JSON.stringify(okBounds) === JSON.stringify([64 * 2 ** 20, 64 * 2 ** 20 - 3]), okBounds);
  check("folderFiles: the .tex itself, and a package the code imports (sub, its .py files), from the .tex's folder only (a sibling of a like name not in it); nothing it doesn't name", ok.dir === "/A" && paths(ok) === JSON.stringify(["/A/doc.tex", "/A/sub/h.py"]), ok);
  const named = await folderFiles(mkws([["/A/doc.tex", 3], ["/A/data.csv", 2], ["/A/fig/w.png", 2], ["/A/other.csv", 2], ["/A/helper.py", 1]]), "/A/doc.tex", ["d = load('data.csv')\nimg = \"./fig/w.png\"\nimport helper as h"]);
  check("folderFiles: a quoted path of a file there (./ or not), and a module imported (helper.py); the others unread", paths(named) === JSON.stringify(["/A/doc.tex", "/A/data.csv", "/A/fig/w.png", "/A/helper.py"]) && bounds.splice(0).length === 4, named);
  // (what a named .py names in turn: its imports and quoted paths, until nothing new)
  const closure = await folderFiles(mkws([["/A/doc.tex", 3], ["/A/helper.py", "import util\ns = open('in.txt').read()\n"], ["/A/util.py", "x = 'deep.txt'\n"], ["/A/in.txt", 2], ["/A/deep.txt", 2], ["/A/junk.txt", 2]]), "/A/doc.tex", ["from helper import s"]);
  bounds.splice(0);
  check("folderFiles: what the named .py files name in turn, to the end (helper.py, util.py, in.txt, deep.txt), nothing else", JSON.stringify(closure.files?.map(([p]) => p).sort()) === JSON.stringify(["/A/deep.txt", "/A/doc.tex", "/A/helper.py", "/A/in.txt", "/A/util.py"]), closure);
  // (daybreak3's #975 ENGINE: an import after ";" or a one-line suite's ":" is one too)
  const inline = await folderFiles(mkws([["/A/doc.tex", 3], ["/A/helper.py", 1], ["/A/util.py", 1], ["/A/other.py", 1]]), "/A/doc.tex", ["x = 1; import helper\nif True: from util import f"]);
  bounds.splice(0);
  check("folderFiles: an import after \";\" or a one-line suite's \":\" (helper.py, util.py), not only at a line's start", paths(inline) === JSON.stringify(["/A/doc.tex", "/A/helper.py", "/A/util.py"]), inline);
  // (daybreak3's #975 ENGINE: no code at all (every item refused): the .tex still given, so the folder the code runs in exists)
  const none = await folderFiles(mkws([["/A/doc.tex", 3], ["/A/helper.py", 1]]), "/A/doc.tex", []);
  bounds.splice(0);
  check("folderFiles: no code at all: the .tex given all the same, nothing else", paths(none) === JSON.stringify(["/A/doc.tex"]), none);
  // (grader's TESTS975-1: a .sage file the code names is followed too: what it names and imports is given)
  const sage = await folderFiles(mkws([["/A/doc.tex", 3], ["/A/lib.sage", "x = open('data.txt').read()\nimport util\n"], ["/A/data.txt", 2], ["/A/util.py", 1], ["/A/junk.txt", 1]]), "/A/doc.tex", ["load('lib.sage')"]);
  bounds.splice(0);
  check("folderFiles: a named .sage file followed (TESTS975-1): the .tex, lib.sage, the data.txt it reads and the util it imports, nothing else", JSON.stringify(sage.files?.map(([p]) => p).sort()) === JSON.stringify(["/A/data.txt", "/A/doc.tex", "/A/lib.sage", "/A/util.py"]), sage);
  // (William's case: many files, none named: runs, none read)
  const lots = await folderFiles(mkws([["/A/doc.tex", 3], ...Array.from({ length: 600 }, (_, k) => ["/A/f" + k + ".dat", 200000])]), "/A/doc.tex", ["1 + 1"]);
  check("folderFiles: a folder of 600 files (over 100 MB) the code never names: runs, none of them read (the .tex only)", paths(lots) === JSON.stringify(["/A/doc.tex"]) && !lots.msg && bounds.splice(0).length === 1, { msg: lots.msg });
  // (a named file only in the cloud: not given to Sage, not read, counted (board's COPY advisory: so the Run can say so))
  const cloud = await folderFiles(mkws([["/A/doc.tex", 3], ["/A/h.py", 2, true], ["/A/sub/g.py", 2, true], ["/A/k.py", 2]]), "/A/doc.tex", ["import h, k"]);
  const cloudReads = bounds.splice(0);
  check("folderFiles: a named file only in the cloud isn't given or read, and is counted; one not named isn't counted", paths(cloud) === JSON.stringify(["/A/doc.tex", "/A/k.py"]) && cloud.remote === 1 && ok.remote === 0 && cloudReads.length === 2, { cloud, cloudReads });
  const unread = await folderFiles(mkws([["/A/doc.tex", 3], ["/A/h.py", 2]], "/A/h.py"), "/A/doc.tex", ["import h"]);
  check("folderFiles: a named file that can't be read: nothing runs (no partial folder)", !unread.files && /couldn't be read/.test(unread.msg ?? ""), unread);
  const many = await folderFiles(mkws([["/A/doc.tex", 1], ["/A/a.py", 1], ["/A/b.py", 1], ["/A/c.py", 1], ["/A/z.dat", 1]]), "/A/doc.tex", ["import a, b, c"], { files: 2, bytes: 100 });
  const heavy = await folderFiles(mkws([["/A/doc.tex", 60], ["/A/a.py", 60], ["/A/b.py", 60]]), "/A/doc.tex", ["import a, b"], { files: 10, bytes: 100 });
  const grownWs = mkws([["/A/doc.tex", 10], ["/A/a.py", 10]], null, { "/A/a.py": 500 });
  const grown = await folderFiles(grownWs, "/A/doc.tex", ["import a"], { files: 10, bytes: 100 });
  const seven = await folderFiles(mkws([["/A/doc.tex", 1], ...["a", "b", "c", "d", "e", "f", "g"].map((n) => ["/A/" + n + ".py", 1])]), "/A/doc.tex", ["import a, b, c, d, e, f, g"], { files: 7, bytes: 100 });
  check("folderFiles: past the count, at most 5 files, in the order first named, then \"and more\" (the walk stops counting there)", seven.msg === "Not run: the code uses over 7 files, and Sage here can be given at most 7: doc.tex, a.py, b.py, c.py, d.py and more.", seven);
  // (past the bytes: the largest first, with their sizes as the file browser shows them, at most 5, then how many more)
  const sz = await folderFiles(mkws([["/A/doc.tex", 10], ["/A/a.py", 300], ["/A/b.csv", 2048], ["/A/c.py", 5], ["/A/d.py", 7], ["/A/e.py", 1500000], ["/A/f.py", 9]]), "/A/doc.tex", ["import a, c, d, e, f\nload('b.csv')"], { files: 50, bytes: 1500000 });
  check("folderFiles: past the bytes, the largest of those seen first with their sizes (the file browser's form), at most 5, then \"and more\" when the list is cut (6 seen)", sz.msg === "Not run: the code uses over 1.430511474609375 MB of files, and Sage here can be given at most 1.430511474609375 MB: e.py (1.4 MB), b.csv (2.0 KB), a.py (300 B), doc.tex (10 B), d.py (7 B) and more.", sz);
  // (board's #975 R1: nothing more to say, no "and more": the .tex and one named file past the bound, refused unread)
  const two = await folderFiles(mkws([["/A/doc.tex", 10], ["/A/data.csv", 100 * 2 ** 20]]), "/A/doc.tex", ["d = load('data.csv')"]);
  check("folderFiles: past the bytes with the whole list shown: no \"and more\"", two.msg === "Not run: the code uses over 64 MB of files, and Sage here can be given at most 64 MB: data.csv (100.0 MB), doc.tex (10 B).", two);
  bounds.splice(0);
  check("folderFiles: a named file grown past the bound since it was listed: refused by the bounded read, nothing runs", !grown.files && /Sage here can be given at most/.test(grown.msg ?? ""), grown);
  check("folderFiles: past the count or the bytes of the named files, nothing runs, the bound and the files named", !many.files && many.msg === "Not run: the code uses over 2 files, and Sage here can be given at most 2: doc.tex, a.py, b.py and more."
    && !heavy.files && heavy.msg === "Not run: the code uses over 0.000095367431640625 MB of files, and Sage here can be given at most 0.000095367431640625 MB: doc.tex (60 B), a.py (60 B).", { many, heavy });
  // (moved while its Run waited for the session: refused, nothing run)
  let moved = false, execd = 0;
  const s2 = sessionOf({ module: async () => ({ WorkerKernel: class { constructor(o) { this.o = o; this.ready = false; } start() { this.worker = { postMessage() {} }; this.o.onStart(this.worker); this.ready = true; } post() {} on() { return () => {}; } } }), worker: () => null }, 1000);
  const r = await runAndSave({
    items: [item("silent", "x = 1")], current: () => true, max: 1 << 20, now: () => 0, fid: "f",
    ws: { pathOfFile: async () => ({ ok: true, path: moved ? "/B/doc.tex" : "/A/doc.tex" }), stat: async () => undefined, createByPerson: async () => ({}) },
    session: async () => { const k = await s2(); moved = true; return k; }, store: s2, serial: s2.serial, folder: async () => ({ dir: "/A", files: [] }),
    exec: async () => { execd++; return { out: "", stopped: "" }; },
  });
  check("runAndSave: the .tex moved to another folder while its Run waited: nothing runs, it says so", execd === 0 && /moved/.test(r.msg ?? ""), { r, execd });
  // (daybreak3's #975 ENGINE: every item refused, so no code: the .tex is still put in the session, through putFolder,
  //  so the folder the driver changes into exists)
  const puts = [];
  const s3 = sessionOf({ module: async () => ({ WorkerKernel: class { constructor(o) { this.o = o; this.ready = false; } start() { this.worker = { postMessage() {} }; this.o.onStart(this.worker); this.ready = true; } post(m) { if (m.fsPut) puts.push(m.fsPut); } on() { return () => {}; } } }), worker: () => null }, 1000);
  const wsR = { pathOfFile: async () => ({ ok: true, path: "/A/doc.tex" }), stat: async () => undefined, createByPerson: async () => ({}),
    list: async () => [{ path: "/A/doc.tex", kind: "file", size: 3 }, { path: "/A/helper.py", kind: "file", size: 1 }], readUpTo: async (p) => ({ content: new Uint8Array(p.endsWith(".tex") ? 3 : 1) }) };
  const refused = await runAndSave({
    items: [item("sage", "x", { err: "cs", name: "foo" })], current: () => true, max: 1 << 20, now: () => 0, fid: "f", ws: wsR,
    session: s3, store: s3, serial: s3.serial, folder: async (codes) => folderFiles(wsR, "/A/doc.tex", codes), exec: async () => ({ out: "", stopped: "" }),
  });
  check("runAndSave: every item refused (no code): the .tex still put in the session (putFolder), nothing else", JSON.stringify(puts) === JSON.stringify(["/A/doc.tex"]), { puts, refused });
  // (the folder's files only in the cloud: the Run's result counts them, for the status line)
  moved = false;
  const rc = await runAndSave({
    items: [item("silent", "x = 1")], current: () => true, max: 1 << 20, now: () => 0, fid: "f",
    ws: { pathOfFile: async () => ({ ok: true, path: "/A/doc.tex" }), stat: async () => undefined, createByPerson: async () => ({}) },
    session: s2, store: s2, serial: s2.serial, folder: async () => ({ dir: "/A", files: [], remote: 2 }),
    exec: async () => ({ out: MARK + JSON.stringify({ s: "ok" }) + "\n", stopped: "" }),
  });
  check("runAndSave: the folder's files only in the cloud counted in the result", rc.ok && rc.remote === 2, rc);
  // (grader's #926 R10: the document edited while the interact chunk loaded (its check, fetched only for a Run with an
  //  interact): the Run is stale, nothing written, as without one)
  let cur = true, wrote = 0;
  const ri = await runAndSave({
    items: [item("silent", "x = 1")], current: () => cur, max: 1 << 20, now: () => 0, fid: "f",
    ws: { pathOfFile: async () => ({ ok: true, path: "/A/doc.tex" }), stat: async () => undefined, createByPerson: async () => { wrote++; return {}; }, write: async () => { wrote++; return {}; } },
    session: s2, store: s2, serial: s2.serial, folder: async () => ({ dir: "/A", files: [] }),
    exec: async () => ({ out: MARK + JSON.stringify({ s: "ok", interacts: [{ spec: { id: 1, name: "f", controls: [] }, out: "", shows: [] }] }) + "\n", stopped: "" }),
    interacts: async () => { cur = false; return { interactsOf }; },
  });
  check("runAndSave: the document changed while the interact chunk loaded: the Run is stale, nothing written", ri.stale === true && wrote === 0, { ri, wrote });
  // (astra's #937 r2 note 3: a Run's interact ids carry the generation of the interpreter its script ran in, taken
  //  there: one started again while the script ran is -1 (its interacts gone); one started again later, while the
  //  results are saved, doesn't relabel them)
  const genRun = async (during, after) => {
    const kk = { generation: 5, interrupt() {} };
    const r = await runAndSave({
      items: [item("silent", "x = 1")], current: () => true, max: 1 << 20, now: () => 0, fid: "f",
      ws: { pathOfFile: async () => ({ ok: true, path: "/A/doc.tex" }), stat: async () => undefined, createByPerson: async () => ({}), write: async () => ({}) },
      session: async () => kk, store: { sent: new Set(), snapshot: [] }, folder: async () => ({ dir: "/A", files: [] }),
      exec: async () => { if (during) kk.generation++; return { out: MARK + JSON.stringify({ s: "ok", interacts: [{ spec: { id: 1, name: "f", controls: [] }, out: "", shows: [] }] }) + "\n", stopped: "" }; },
      interacts: async () => { if (after) kk.generation++; return { interactsOf }; },
    });
    return { ok: r.ok, ids: [...(r.interactIds ?? [])], gen: r.interactIds?.gen };
  };
  const gSame = await genRun(false, false), gDuring = await genRun(true, false), gAfter = await genRun(false, true);
  check("runAndSave: a Run's interact ids carry its script's interpreter generation; -1 if it was started again during the script; not relabelled by a restart while saving",
    gSame.ok && gSame.ids.join() === "1" && gSame.gen === 5 && gDuring.gen === -1 && gAfter.ok && gAfter.gen === 5, { gSame, gDuring, gAfter });
}

// ---- a Run's own Stop (astra's LATEX-QUEUE-STOP-1): stopped while it waits for another Run, it runs nothing, and the
// one running isn't interrupted; stopped while its script runs, that script is interrupted, once, and what ran written
{
  const log = [];
  let running = null;
  class K { constructor(o) { this.o = o; this.ready = false; } start() { this.worker = { postMessage() {} }; this.o.onStart(this.worker); this.ready = true; } post() {} on() { return () => {}; } interrupt() { log.push("interrupt " + running); } }
  const s = sessionOf({ module: async () => ({ WorkerKernel: K }), worker: () => null }, 1000);
  const ws = { pathOfFile: async () => ({ ok: true, path: "/Q/doc.tex" }), stat: async () => undefined, createByPerson: async () => ({}) };
  const holds = {};
  const within = (p, ms = 5000) => Promise.race([p, new Promise((r) => setTimeout(() => r({ timedOut: true }), ms))]);
  const run = (tag, stop) => runAndSave({ items: [item("silent", "x = 1")], ws, fid: "f", current: () => true, max: 1 << 20, now: () => 0, stop,
    session: s, store: s, serial: s.serial, folder: async () => ({ dir: "/Q", files: [] }),
    exec: () => { running = tag; log.push("exec " + tag); return new Promise((r) => (holds[tag] = () => { running = null; r({ out: "", stopped: "" }); })); } });
  const pA = run("A");
  for (let i = 0; i < 50 && !holds.A; i++) await new Promise((r) => setTimeout(r, 5));
  const stopB = new AbortController(), pB = run("B", stopB.signal);
  await new Promise((r) => setTimeout(r, 20));
  stopB.abort();
  const afterStop = log.slice();
  holds.A();
  const rA = await within(pA), rB = await within(pB);
  check("Stop: a Run stopped while it waits runs nothing, and the Run running isn't interrupted", !afterStop.includes("interrupt A") && !log.includes("exec B") && /Stopped before it ran/.test(rB.msg ?? "") && rA.ok, { log, rA, rB });
  // (through runIn itself (astra's LATEX-STOP-RESULT-1, daybreak3): the kernel's callbacks as a real session calls them,
  //  one item's result printed and then the run ended early: interrupted (this Run's Stop), the session's error, the
  //  results past the bound: what ran is written, the rest not run, never "Stopped before it ran")
  const two = [item("sage", "1 + 1"), item("sage", "2 + 2")];
  const ranOne = MARK + JSON.stringify({ s: "ok", latex: "2" }) + "\n";
  K.prototype.execute = function (code, opts, cb) { running = "C"; log.push("exec C"); holds.C = (outcome, extra = "") => { running = null; cb.out(ranOne + extra, false); cb.done(0, outcome); }; };
  const runTwo = (stop, max = 1 << 20) => runAndSave({ items: two, ws, fid: "f", current: () => true, max, now: () => 0, stop,
    session: s, store: s, serial: s.serial, folder: async () => ({ dir: "/Q", files: [] }), exec: runIn });
  const stopC = new AbortController(), pC = runTwo(stopC.signal);
  for (let i = 0; i < 50 && running !== "C"; i++) await new Promise((r) => setTimeout(r, 5));
  stopC.abort();
  holds.C({ interrupted: true });
  const rC = await within(pC);
  check("Stop (through runIn): a Run stopped while its script runs: that script interrupted, once; what ran written, the rest not run", log.filter((l) => l === "interrupt C").length === 1 && rC.ok === true && rC.states?.[0]?.s === "ok" && rC.states?.[0]?.latex === "2" && rC.states?.[1]?.s === "error" && /the run was stopped/.test(rC.states?.[1]?.msg ?? ""), { log, rC });
  const pE = runTwo(undefined);
  for (let i = 0; i < 50 && running !== "C"; i++) await new Promise((r) => setTimeout(r, 5));
  holds.C({ error: true });
  const rE = await within(pE);
  check("runAndSave (through runIn): the session's error after one item: what ran written, never \"Stopped before it ran\"", rE.ok === true && rE.states?.[0]?.latex === "2" && /the session stopped with an error/.test(rE.states?.[1]?.msg ?? ""), rE);
  // (the printed results past runIn's bound: the bound is the results file's too, so one big enough for the file and
  //  smaller than what was printed)
  const pL = runTwo(undefined, 4096);
  for (let i = 0; i < 50 && running !== "C"; i++) await new Promise((r) => setTimeout(r, 5));
  holds.C({}, "x".repeat(5000));
  const rL = await within(pL);
  check("runAndSave (through runIn): the printed results past the bound: what ran written, never \"Stopped before it ran\"", rL.ok === true && rL.states?.[0]?.latex === "2" && /the results are too large/.test(rL.states?.[1]?.msg ?? ""), rL);
}

// ---- (Codex W01) the results' record of what their Run imported: its shape (safe relative paths, SHA-256 hex), the
// hashes from the bytes the session was given, and a changed or missing file found
{
  const enc = (t) => new TextEncoder().encode(t);
  check("W01 safeRel: relative paths only, no . or .. segment, no backslash", safeRel("h.py") && safeRel("pkg/child.py") && !safeRel("/h.py") && !safeRel("../h.py") && !safeRel("a/./b") && !safeRel("a//b") && !safeRel("a\\b") && !safeRel(""), null);
  const h1 = await sha256hex(enc("v = 1\n"));
  check("W01 depsOf: none, valid, invalid", depsOf({}) === null && JSON.stringify(depsOf({ deps: [["h.py", h1]] })) === JSON.stringify([["h.py", h1]]) && depsOf({ deps: [["../h.py", h1]] }) === "invalid" && depsOf({ deps: [["h.py", "x"]] }) === "invalid" && depsOf({ deps: "h.py" }) === "invalid", null);
  const files = { "h.py": enc("v = 1\n") };
  const read = async (rel) => files[rel] ?? null;
  const same = await staleOf([["h.py", h1]], read);
  files["h.py"] = enc("v = 2\n");
  const changed = await staleOf([["h.py", h1]], read);
  delete files["h.py"];
  const gone = await staleOf([["h.py", h1]], read);
  check("W01 staleOf: the same file: none; changed or gone: that file", same === null && changed === "h.py" && gone === "h.py", { same, changed, gone });
  const deps = await depsWith(["h.py", "pkg/c.py"], [["/A/h.py", enc("v = 1\n")], ["/A/pkg/c.py", enc("x")]], "/A");
  const root = await depsWith(["h.py"], [["/h.py", enc("v = 1\n")]], "/");
  const missing = await depsWith(["h.py", "missing.py"], [["/A/h.py", enc("v = 1\n")]], "/A"), none = await depsWith(null, [], "/A");
  check("W01 depsWith: hashes from the bytes the session was given (a folder or the top); a file it didn't have, or no record at all: incomplete", JSON.stringify(deps.map((d) => d[0])) === JSON.stringify(["h.py", "pkg/c.py"]) && deps[0][1] === h1 && root.length === 1 && root[0][1] === h1 && missing === "incomplete" && none === "incomplete", { deps, root, missing, none });
  // (a Run writes them: its session's deps line, hashed from the bytes it was given, into the results file it writes)
  {
    let written = null;
    const sW = sessionOf({ module: async () => ({ WorkerKernel: class { constructor(o) { this.o = o; this.ready = false; } start() { this.worker = { postMessage() {} }; this.o.onStart(this.worker); this.ready = true; } post() {} on() { return () => {}; } } }), worker: () => null }, 1000);
    const rW = await runAndSave({ items: [item("silent", "from h import v")], current: () => true, max: 1 << 20, now: () => 0, fid: "f",
      ws: { pathOfFile: async () => ({ ok: true, path: "/W/d.tex" }), stat: async () => undefined, createByPerson: async (p, o) => { written = JSON.parse(new TextDecoder().decode(o.content)); return {}; } },
      session: sW, store: sW, serial: sW.serial, folder: async () => ({ dir: "/W", files: [["/W/d.tex", enc("x")], ["/W/h.py", enc("v = 1\n")]] }),
      exec: async () => ({ out: DEPS_MARK + JSON.stringify(["h.py"]) + "\n" + MARK + JSON.stringify({ s: "ok" }) + "\n", stopped: "" }) });
    check("W01: a Run's results file records what it imported, hashed from the bytes it was given", rW.ok && JSON.stringify(written?.deps) === JSON.stringify([["h.py", h1]]) && written.items.length === 1, { rW, written });
  }
  // (the record's rules (astra's DEP-READ-1): a path twice, or "incomplete": not used; the reading budget shared)
  check("W01 depsOf: a path named twice is invalid; an incomplete record is incomplete", depsOf({ deps: [["h.py", h1], ["h.py", h1]] }) === "invalid" && depsOf({ deps: "incomplete" }) === "incomplete", null);
  const big = { "a.py": new Uint8Array(60), "b.py": new Uint8Array(60) };
  const a60 = await sha256hex(big["a.py"]);
  const over = await staleOf([["a.py", a60], ["b.py", a60]], async (rel, left) => (big[rel].length > left ? "over" : big[rel]), 100);
  check("W01 staleOf: the files read within one budget: past it, \"over\" (not checked: not used)", over === "over", over);
  // (grader's #804 S3, S4, S7: the record's bounds and shape, exactly: DEPS_MAX entries are a record, one more isn't;
  //  a hash is 64 hex digits, no fewer; staleOfSync (the CLI's) shares one budget across the files, as staleOf does)
  const many = (n) => ({ deps: Array.from({ length: n }, (_, k) => ["f" + k + ".py", h1]) });
  check("W01 depsOf: DEPS_MAX entries are a record; DEPS_MAX + 1 are invalid", Array.isArray(depsOf(many(DEPS_MAX))) && depsOf(many(DEPS_MAX + 1)) === "invalid", { max: DEPS_MAX });
  check("W01 depsOf: a hash of 63 hex digits is invalid", depsOf({ deps: [["h.py", h1.slice(1)]] }) === "invalid" && Array.isArray(depsOf({ deps: [["h.py", h1]] })), null);
  const overSync = staleOfSync([["a.py", a60], ["b.py", a60]], (rel, left) => (big[rel].length > left ? "over" : big[rel]), () => a60, 100);
  check("W01 staleOfSync: the files read within one budget: past it, \"over\"", overSync === "over", overSync);
  // (astra's DEP-READ-1 r2: the CLI's reader reads a file whole: stat 1, now 6 bytes (grew): null, no prefix hashed;
  //  stat 6, now 2 (shrank): null; reads of a byte at a time: the whole file)
  const fileOf = (bytes, step = 1 << 20) => (buf, at) => { const k = Math.min(step, buf.length, Math.max(0, bytes.length - at)); buf.set(bytes.subarray(at, at + k)); return k; };
  const six = enc("v = 1\n");
  const grew = readComplete(fileOf(six), 1), shrank = readComplete(fileOf(six.subarray(0, 2)), 6), whole = readComplete(fileOf(six, 1), 6), empty = readComplete(fileOf(new Uint8Array(0)), 0);
  check("DEP-READ-1 readComplete: a file grown or shrunk since its stat: null (no prefix); read a byte at a time: whole", grew === null && shrank === null && whole && (await sha256hex(whole)) === h1 && empty?.length === 0, { grew, shrank, whole: whole?.length });
  const wsT = { readUpTo: async (p, max) => { if (p.endsWith("t.py")) return { entry: { trashed: true }, content: enc("x") }; if (p.endsWith("big.py")) throw Object.assign(new Error("x"), { code: "limit" }); return { entry: {}, content: enc("ok") }; } };
  const rd = wsReader(wsT, "/A");
  check("W01 wsReader: a file in the Trash isn't there; one past the bound is \"over\"", (await rd("t.py", 10)) === null && (await rd("big.py", 10)) === "over" && (await rd("h.py", 10))?.length === 2, null);
  // (daybreak3's ENGINE-DEPS-PARTIAL-1: a Run whose first item imported the helper and whose second was stopped: its
  //  results file records the helper (from the line after item 1); the helper edited, item 1's result isn't used)
  {
    let written = null;
    const sP = sessionOf({ module: async () => ({ WorkerKernel: class { constructor(o) { this.o = o; this.ready = false; } start() { this.worker = { postMessage() {} }; this.o.onStart(this.worker); this.ready = true; } post() {} on() { return () => {}; } } }), worker: () => null }, 1000);
    // (a file's entry changes with every write, as the workspace's does: `rev` counts them; `updated`, a time in ms,
    //  may not change (daybreak3's ENGINE-SEEN-REV-1), so here it never does)
    const writes = new Map();
    const files = new Proxy({ "/P/d.tex": enc("x"), "/P/h.py": enc("v = 1\n"), "/P/d.tex.results.json": enc("{}") }, { set: (t, k, v) => { writes.set(k, (writes.get(k) ?? 0) + 1); t[k] = v; return true; } });
    const ws = { pathOfFile: async () => ({ ok: true, path: "/P/d.tex" }), stat: async (p) => (files[p] ? { fid: p, rev: writes.get(p) ?? 0, updated: 0, size: files[p].length } : undefined), createByPerson: async (p, o) => { written = JSON.parse(new TextDecoder().decode(o.content)); return {}; }, write: async (p, bytes) => { written = JSON.parse(new TextDecoder().decode(bytes)); return { ok: true }; },
      readUpTo: async (p, max) => { if (!files[p]) throw new Error("gone"); if (files[p].length > max) throw Object.assign(new Error("x"), { code: "limit" }); return { entry: {}, content: files[p] }; } };
    const rP = await runAndSave({ items: [item("silent", "from h import v"), item("sage", "v")], current: () => true, max: 1 << 20, now: () => 0, fid: "f",
      ws, session: sP, store: sP, serial: sP.serial, folder: async () => ({ dir: "/P", files: Object.entries(files) }),
      exec: async () => ({ out: DEPS_MARK + JSON.stringify(["h.py"]) + "\n" + MARK + JSON.stringify({ s: "ok" }) + "\n", stopped: "the run was stopped" }) });
    const c1 = await checkedResults(ws, "/P/d.tex.results.json", await ws.stat("/P/d.tex.results.json"), written, "/P");
    files["/P/h.py"] = enc("v = 2\n");
    const c2 = await checkedResults(ws, "/P/d.tex.results.json", await ws.stat("/P/d.tex.results.json"), written, "/P");
    check("ENGINE-DEPS-PARTIAL-1: item 1 imports the helper, item 2 stopped: the results record it; the helper edited, item 1 isn't used", rP.ok && JSON.stringify(written?.deps?.map((d) => d[0])) === JSON.stringify(["h.py"]) && c1.stale === null && c1.saved.length === 2 && c2.stale === "h.py" && c2.saved.length === 0, { written: written?.deps, c1: c1.stale, c2: c2.stale });
    // (results printed but no record of what was imported: incomplete, never an older file's no record)
    written = null;
    await runAndSave({ items: [item("silent", "x = 1")], current: () => true, max: 1 << 20, now: () => 0, fid: "f",
      ws, session: sP, store: sP, serial: sP.serial, folder: async () => ({ dir: "/P", files: Object.entries(files) }),
      exec: async () => ({ out: MARK + JSON.stringify({ s: "ok" }) + "\n", stopped: "" }) });
    check("DEP-SNAPSHOT-1: results without a record of what their Run imported are written as incomplete", written?.deps === "incomplete", written?.deps);
    // (astra's DEP-SEEN-1, daybreak3's ENGINE-SEEN-COMMIT-1: the helper changed while it is checked: nothing used, nothing
    //  seen; checked again, it is stale)
    files["/P/h.py"] = enc("v = 1\n");
    const rec = { format: RESULTS_FORMAT, version: 1, wrapper: WRAPPER_VERSION, items: [{ key: "k", s: "ok" }], deps: [["h.py", h1]] };
    const orig = ws.readUpTo;
    ws.readUpTo = async (p, max) => { const r = await orig(p, max); if (p.endsWith("h.py")) files["/P/h.py"] = enc("v = 9\n"); return r; };
    const mid = await checkedResults(ws, "/P/d.tex.results.json", await ws.stat("/P/d.tex.results.json"), rec, "/P");
    ws.readUpTo = orig;
    const again = await checkedResults(ws, "/P/d.tex.results.json", await ws.stat("/P/d.tex.results.json"), rec, "/P");
    check("DEP-SEEN-1: a recorded file changed while it is checked: nothing used, nothing counted as seen; checked again, stale", mid.seen === null && mid.saved.length === 0 && again.stale === "h.py" && again.seen !== null && again.saved.length === 0, { mid, again: { stale: again.stale, seen: !!again.seen } });
    // (daybreak3's ENGINE-SEEN-REV-1: a helper rewritten, same size, in the same ms (fid, updated, size all the same):
    //  its rev differs, so nothing is used or seen; checked again, stale)
    files["/P/h.py"] = enc("v = 1\n");
    const before = (await ws.stat("/P/h.py")).rev;
    ws.readUpTo = async (p, max) => { const r = await orig(p, max); if (p.endsWith("h.py")) files["/P/h.py"] = enc("v = 7\n"); return r; };
    const same = await checkedResults(ws, "/P/d.tex.results.json", await ws.stat("/P/d.tex.results.json"), rec, "/P");
    ws.readUpTo = orig;
    const st2 = await ws.stat("/P/h.py"), retry = await checkedResults(ws, "/P/d.tex.results.json", await ws.stat("/P/d.tex.results.json"), rec, "/P");
    check("ENGINE-SEEN-REV-1: same fid, updated, size, another rev: nothing used, nothing seen; checked again, stale", st2.updated === 0 && st2.size === 6 && st2.rev === before + 1 && same.saved.length === 0 && same.seen === null && retry.stale === "h.py" && retry.saved.length === 0, { same: { saved: same.saved.length, seen: same.seen }, retry: retry.stale });
    // (astra's DEP-PARTIAL-COMMIT-1: item 2 imported b.py and printed its result, then Stop: saved with b.py recorded,
    //  never with item 1's list alone; and a result with no line of its own before it: incomplete)
    files["/P/a.py"] = enc("a"); files["/P/b.py"] = enc("b");
    const two = (out) => runAndSave({ items: [item("silent", "import a"), item("silent", "import b")], current: () => true, max: 1 << 20, now: () => 0, fid: "f",
      ws, session: sP, store: sP, serial: sP.serial, folder: async () => ({ dir: "/P", files: Object.entries(files) }), exec: async () => ({ out, stopped: "the run was stopped" }) });
    const R = MARK + JSON.stringify({ s: "ok" }) + "\n", D = (l) => DEPS_MARK + JSON.stringify(l) + "\n";
    written = null; await two(D(["a.py"]) + R + D(["a.py", "b.py"]) + R);
    const ok2 = written?.deps;
    written = null; await two(D(["a.py"]) + R + R);
    const unmatched = written?.deps;
    check("DEP-PARTIAL-COMMIT-1: Stop after item 2's result: b.py recorded; a result without its own line: incomplete", JSON.stringify(ok2?.map((d) => d[0])) === JSON.stringify(["a.py", "b.py"]) && unmatched === "incomplete" && parseDeps(D(["a.py"]) + R + R) === null && JSON.stringify(parseDeps(D(["a.py"]) + R + D(["a.py"]))) === JSON.stringify(["a.py"]), { ok2, unmatched });
    // (grader's #804 R4: a recorded file moved to the Trash (its entry otherwise the same) changes what is seen, so the
    //  page checks again; R6: the results file itself changed while it is checked: nothing used, nothing seen; R10: a
    //  Run whose items printed no result records nothing of what it imported)
    {
      const trashed = new Set();
      const wsT2 = { stat: async (p) => (files[p] ? { fid: p, rev: writes.get(p) ?? 0, updated: 0, size: files[p].length, ...(trashed.has(p) ? { trashed: true } : {}) } : undefined) };
      const eR = await ws.stat("/P/d.tex.results.json");
      const k1 = await seenOf(wsT2, eR, "/P", [["h.py", h1]]);
      trashed.add("/P/h.py");
      const k2 = await seenOf(wsT2, eR, "/P", [["h.py", h1]]);
      check("W01 seenOf: a recorded file moved to the Trash is seen as changed", typeof k1 === "string" && k1 !== k2, { k1, k2 });
      files["/P/h.py"] = enc("v = 1\n");
      const e0 = await ws.stat("/P/d.tex.results.json");
      ws.readUpTo = async (p, max) => { const r = await orig(p, max); if (p.endsWith("h.py")) files["/P/d.tex.results.json"] = enc("{ }"); return r; };
      const midR = await checkedResults(ws, "/P/d.tex.results.json", e0, rec, "/P");
      ws.readUpTo = orig;
      check("W01 checkedResults: the results file changed while it is checked: nothing used, nothing seen", midR.seen === null && midR.saved.length === 0, { seen: midR.seen, saved: midR.saved.length });
      written = null;
      await runAndSave({ items: [item("silent", "import h")], current: () => true, max: 1 << 20, now: () => 0, fid: "f",
        ws, session: sP, store: sP, serial: sP.serial, folder: async () => ({ dir: "/P", files: Object.entries(files) }),
        exec: async () => ({ out: DEPS_MARK + JSON.stringify(["h.py"]) + "\n", stopped: "the run was stopped" }) });
      check("W01 runAndSave: a Run whose items printed no result records nothing of what it imported", written && written.deps === undefined, written && { deps: written.deps, items: written.items?.length });
    }
  }
  check("W01 resultsText: deps only when there are some", !("deps" in JSON.parse(resultsText([]))) && JSON.stringify(JSON.parse(resultsText([], [["h.py", h1]])).deps) === JSON.stringify([["h.py", h1]]), null);
}

// ---- (grader's Z2, Z3, Z7, Z9 on #794) a Run stopped while queued reads nothing (not even the .tex's recheck) and
// runs nothing; one stopped while its recheck is under way stops there, before the folder goes in; a file whose
// listed size alone is past the bound is refused unread; a file in the Trash isn't given
{
  const enc = (t) => new TextEncoder().encode(t);
  let reads = 0, recheckHold = null, execs = 0;
  const sZ = sessionOf({ module: async () => ({ WorkerKernel: class { constructor(o) { this.o = o; this.ready = false; } start() { this.worker = { postMessage() {} }; this.o.onStart(this.worker); this.ready = true; } post() {} on() { return () => {}; } } }), worker: () => null }, 1000);
  const ws = { pathOfFile: async () => { reads++; if (recheckHold) await recheckHold; return { ok: true, path: "/Z/doc.tex" }; }, stat: async () => undefined, createByPerson: async () => ({}) };
  const runZ = (stop) => runAndSave({ items: [item("silent", "x = 1")], ws, fid: "f", current: () => true, max: 1 << 20, now: () => 0, stop,
    session: sZ, store: sZ, serial: sZ.serial, folder: async () => ({ dir: "/Z", files: [["/Z/doc.tex", enc("x")]] }), exec: async () => { execs++; return { out: "", stopped: "" }; } });
  const within = (p, ms = 5000) => Promise.race([p, new Promise((r) => setTimeout(() => r({ timedOut: true }), ms))]);
  // (Z2: a Run ahead holds the session's turn; this one, stopped while it waits, makes no read at all)
  let releaseAhead;
  const ahead = sZ.serial(() => new Promise((r) => (releaseAhead = r)));
  const stopQ = new AbortController(), pQ = runZ(stopQ.signal);
  await new Promise((r) => setTimeout(r, 20));
  stopQ.abort();
  const readsBefore = reads;
  releaseAhead(); await ahead;
  const rQ = await within(pQ);
  check("Z2: a Run stopped while it waits for its turn reads nothing (not even the .tex's recheck) and runs nothing", /Stopped before it ran/.test(rQ.msg ?? "") && reads === readsBefore && execs === 0, { rQ, reads, readsBefore, execs });
  // (Z3: stopped while its recheck is under way: it stops there; the folder isn't put in, the script isn't run)
  let releaseRecheck;
  recheckHold = new Promise((r) => (releaseRecheck = r));
  const stopR = new AbortController(), pR = runZ(stopR.signal);
  for (let i = 0; i < 50 && reads === readsBefore; i++) await new Promise((r) => setTimeout(r, 5));
  stopR.abort(); recheckHold = null; releaseRecheck();
  const rR = await within(pR);
  check("Z3: a Run stopped while its .tex is being rechecked stops there: nothing put in, nothing run", /Stopped before it ran/.test(rR.msg ?? "") && execs === 0 && sZ.sent.size === 0, { rR, execs, sent: [...sZ.sent] });
  // (Z7: a file whose listed size alone is past the bound: refused, never read)
  let fileReads = 0;
  const big = await folderFiles({ list: async () => [{ path: "/Z/g.py", kind: "file", size: 10 }, { path: "/Z/h.py", kind: "file", size: 500 }],
    readUpTo: async (p, max) => { fileReads++; return { content: new Uint8Array(p.endsWith("h.py") ? 500 : 10) }; } }, "/Z/doc.tex", ["import g, h"], { files: 10, bytes: 100 });
  check("Z7: a named file whose listed size is past the bound is refused unread (only the one before it read)", !big.files && /Sage here can be given at most/.test(big.msg ?? "") && fileReads === 1, { big, fileReads });
  // (Z9: a helper.py in the Trash isn't given to the session, so it can't be imported)
  const tr = await folderFiles({ list: async () => [{ path: "/Z/doc.tex", kind: "file", size: 1 }, { path: "/Z/helper.py", kind: "file", size: 1, trashed: true }],
    readUpTo: async () => ({ content: new Uint8Array(1) }) }, "/Z/doc.tex", ["import helper"]);
  check("Z9: a helper.py in the Trash isn't given to the session, even named", JSON.stringify(tr.files?.map(([p]) => p)) === JSON.stringify(["/Z/doc.tex"]), tr);
}

const bad = results.filter(([, ok]) => !ok);
console.log(`${results.length - bad.length}/${results.length} passed`);
process.exit(bad.length ? 1 : 0);
