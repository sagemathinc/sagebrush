// SageTeX S1 (plan sagetex-plan-r4): the code items of a document, and how each one's state is shown.
// The expander (demo-machine.mjs) marks every \sage, \sageplot, sageblock and sagesilent in expansion order; the
// renderer numbers them (sageItems) and asks here how each is shown. Nothing here executes anything: the page's
// executor (web/sage/executor.js) runs the ordered items in the runner, with consent, and sends back their states.
// SECURITY: every piece of document text and every message from the runner reaches the HTML only through esc();
// a result's LaTeX reaches only KaTeX (trust: false, through the renderer's math()); a plot only as an <img> whose
// src must be a base64 SVG data URL (checked here, again); results never enter the TeX expander.

// (2: each item compiled as Sage source, so 1/3 is exact (#706); results saved by wrapper 1 are run again)
export const WRAPPER_VERSION = "sbtx-wrapper-2";
export const MAX_CODE = 65536;            // bytes (UTF-8) of code per item (plan r4 section 8)
export const MAX_RESULT = 16384;          // bytes (UTF-8) of one \sage result
// a string's UTF-8 length, the one byte measure of every cap here and in the executor (astra C2, astra3 S1-A3-3);
// a lone surrogate counts 3, as TextEncoder writes it (U+FFFD)
export function utf8len(s) {
  let n = 0;
  for (const ch of String(s)) { const c = ch.codePointAt(0); n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4; }
  return n;
}
// ---- what a Run imported from the .tex's folder (Codex W01: an edited helper.py left the old results in use).
// A results file may record, as `deps`, every module its Run imported from the .tex's folder: [path relative to that
// folder, the file's SHA-256 (hex)], at most DEPS_MAX. Its readers (check, render, the editor) hash those files again:
// one changed or gone, and none of the file's results is used (its items not run, the file named). A results file
// without `deps` (an older one) is used as before. Real SageTeX doesn't track a helper either (its .sout keys on the
// .sage code alone): this is Sagebrush's own guarantee.
export const DEPS_MAX = 1000;
/** All the recorded files' bytes read to check or record them, in all (astra's DEP-READ-1): past it, not checked */
export const DEPS_BYTES = 64 * 2 ** 20;
/** A recorded path: relative, its segments neither empty nor "." nor "..", no backslash or control character. */
export function safeRel(p) {
  if (typeof p !== "string" || !p || p.length > 1024 || p.startsWith("/") || /[\\\u0000-\u001f\u007f]/.test(p)) return false;
  return p.split("/").every((s) => s !== "" && s !== "." && s !== "..");
}
/** The results file's `deps`: null if it has none (used as before); "incomplete" if its run couldn't record them all
 * (a file changed while it ran, one not readable, too many); "invalid" if it isn't the shape above or names a path
 * twice. Either of those: none of its results is used. */
export function depsOf(j) {
  if (!j || j.deps === undefined) return null;
  if (j.deps === "incomplete") return "incomplete";
  if (!Array.isArray(j.deps) || j.deps.length > DEPS_MAX) return "invalid";
  const seen = new Set();
  for (const d of j.deps) {
    if (!Array.isArray(d) || d.length !== 2 || !safeRel(d[0]) || typeof d[1] !== "string" || !/^[0-9a-f]{64}$/.test(d[1]) || seen.has(d[0])) return "invalid";
    seen.add(d[0]);
  }
  return j.deps;
}
/** The SHA-256 of `bytes`, hex. */
export async function sha256hex(bytes) {
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...h].map((b) => b.toString(16).padStart(2, "0")).join("");
}
// (the one reading rule, the CLI's and the editor's: each side's `read(rel, left)` gives the file's bytes, null if it
//  isn't a regular file inside the .tex's folder (gone, in the Trash, a link out of it), or "over" if it is larger than
//  what is left of DEPS_BYTES; the files are read in the record's order, the budget shared)
/** The first recorded file now changed or gone (its path), "over" if the budget ran out first, or null. */
/** A file of `size` bytes (its stat) read whole: `readAt(buf, at)` reads into `buf` from offset `at` and returns how
 * many bytes (0 at the end). Read to the end, at most one byte past `size`: a file that grew or shrank since its stat
 * (a short read, a prefix) is null, never hashed (astra's DEP-READ-1 r2). */
export function readComplete(readAt, size) {
  const buf = new Uint8Array(size + 1);
  let n = 0;
  for (let k; n < buf.length && (k = readAt(buf.subarray(n), n)) > 0; ) n += k;
  return n === size ? buf.subarray(0, n) : null;
}
export async function staleOf(deps, read, budget = DEPS_BYTES) {
  let left = budget;
  for (const [rel, h] of deps) {
    const b = await read(rel, left);
    if (b === "over") return "over";
    if (!b || (await sha256hex(b)) !== h) return rel;
    left -= b.length;
  }
  return null;
}
/** staleOf's twin for a synchronous reader and hash (the CLI's). */
export function staleOfSync(deps, read, hash, budget = DEPS_BYTES) {
  let left = budget;
  for (const [rel, h] of deps) {
    const b = read(rel, left);
    if (b === "over") return "over";
    if (!b || hash(b) !== h) return rel;
    left -= b.length;
  }
  return null;
}
/** Why a results file's results aren't used: a recorded file changed or gone, or its record unusable. */
export const staleWhy = (rel) => rel === "invalid" ? "the results file's record of what its run imported can't be read"
  : rel === "incomplete" ? "their run didn't record everything it imported (it stopped early, a file changed while it ran, or one couldn't be read)"
  : rel === "over" ? "what their run imported is too large to check here"
  : `${rel} changed or was removed since they were run`;

// (the code environments: SageTeX's, whose items' modes are block and silent, and PythonTeX's (step (a)), whose modes are
//  their names)
// (a PythonTeX result too large to read back (pipeline.mjs checks MAX_RESULT before any is tokenized): this error)
const pyBig = (st, it) => typeof st.latex !== "string" ? { s: "error", msg: "the result can't be shown" }
  : utf8len(st.latex) > MAX_RESULT && { s: "error", msg: (it.mode === "py" ? "the result" : "the printed output") + " is over " + MAX_RESULT / 1024 + " KiB" };
/** A PythonTeX item (\py, pycode, pyblock): run as Python, its result read back as TeX. */
export const isPy = (it) => /^py/.test(it.mode);
// Magma (a Sagebrush extension): \magma{}, magmablock, magmasilent. A Magma item's `latex` is the text Magma printed,
// shown as text, never read as TeX
export const isMagma = (it) => /^magma/.test(it.mode);
/** a "code item" in the counts: any item that isn't SageTeX's (one predicate for the CLI, check and the page) */
export const isNonSage = (it) => isPy(it) || isMagma(it);
const langOf = (it) => (isPy(it) ? "Python" : isMagma(it) ? "Magma" : "Sage");
export const UNSUPPORTED_ENVS = new Set(["sagecommandline", "sageexample"]);
export const isCodeEnv = (env) => /^(sage(block|silent)|py(code|block)|magma(block|silent))$/.test(env);

// Python's textwrap.dedent rule (plan r4 section 4): the longest common leading whitespace of the non-blank lines
// is removed; blank lines become empty. Two lines whose indentation differs inside the shared part (a tab against
// a space) is an error, not a guess.
export function dedent(text) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let prefix = null;
  for (const L of lines) {
    if (/^[ \t]*$/.test(L)) continue;
    const ws = /^[ \t]*/.exec(L)[0];
    if (prefix === null) { prefix = ws; continue; }
    let k = 0;
    while (k < prefix.length && k < ws.length && prefix[k] === ws[k]) k++;
    if (k < prefix.length && k < ws.length) return { err: "tabs" };
    prefix = prefix.slice(0, k);
  }
  if (prefix && prefix.includes("\t") && prefix.includes(" ")) return { err: "tabs" };
  const n = prefix ? prefix.length : 0;
  return { code: lines.map((L) => (/^[ \t]*$/.test(L) ? "" : L.slice(n))).join("\n") };
}

// one item from its marker: { mode: "sage" | "plot" | "block" | "silent", code?, opts, err?, name? }
export function itemOf(e) {
  if (e.k === "sage") {
    const it = { mode: e.mode, opts: e.opts || [] };
    if (e.err) { it.err = e.err; if (e.name) it.name = String(e.name).slice(0, 64); } else it.code = e.code;
    // (astra4 S1E01-A2: \sageplot's options are applied, or the item is refused before it runs, visibly)
    if (!it.err && it.mode === "plot") { const o = plotOptions(it.opts); if (o.ignored.length) { it.err = "plotopts"; it.name = o.ignored.join(", "); } }
    return it;
  }
  const it = { mode: e.env.replace(/^sage/, ""), opts: [] };
  if (e.inarg) it.err = "inarg";
  else if (e.unterminated) it.err = "unterminated";
  else if (e.truncated) it.err = "truncated";
  else {
    const d = dedent(e.text);
    if (d.err) it.err = d.err;
    else if (utf8len(d.code) > MAX_CODE) it.err = "toolong";
    else it.code = d.code;
  }
  if (it.mode === "block" || it.mode === "pyblock" || it.mode === "magmablock") it.shown = String(e.text).replace(/\r\n/g, "\n");
  return it;
}
// what makes two items the same code (the executor's identity uses the same key)
export const itemKey = (it) => JSON.stringify([it.mode, it.code === undefined ? null : it.code, it.opts, it.err || null, WRAPPER_VERSION]);

const only = (it) => "this preview supports only plain " + (it.mode === "py" ? "Python expressions inside \\py{}: " : it.mode === "magma" ? "Magma expressions inside \\magma{}: " : "Sage expressions inside \\sage{}: ");
const WHY = {
  cs: (it) => only(it) + "\\" + it.name + " is a TeX command",
  active: (it) => only(it) + it.name + " is an active character",
  unbalanced: () => "the argument is unbalanced (it runs to the end of the document)",
  par: (it) => "the argument runs past a blank line (a % starts a comment in TeX" + (it.mode === "sage" || it.mode === "plot" ? ": write mod(a, b))" : ")"),
  nobrace: () => "the argument must be in braces",
  empty: () => "the argument is empty",
  toolong: () => "the code is over 64 KiB (UTF-8)",
  inarg: () => "a code block inside a command's argument can't be read",
  unterminated: (it) => "no \\end{" + (isNonSage(it) ? "" : "sage") + it.mode + "}",
  truncated: () => "the code block is over 1 MiB",
  tabs: () => "the indentation mixes tabs and spaces",
  optstoolong: () => "the \\sageplot options are over 1 KiB",
  plotopts: (it) => "this preview supports only width= and height= (a length, or a fraction of \\textwidth) in \\sageplot's options, not: " + (it.name.length > 300 ? it.name.slice(0, 300) + "\u2026" : it.name),
  hidden: () => "this code is inside something the preview doesn't show (an unsupported command's argument, the preamble, or a dropped argument), so it can't be run here",
};
export const whyRejected = (it) => (WHY[it.err] ? WHY[it.err](it) : "the code can't be read") + ": not run";

// the state the page sent for item n, if it is for this very item (its key); otherwise "not run"
// a math region's failed or blocked items, shown after the formula (astra4 S1E01-A1: a boxed "?" alone hides why)
export function mathFailHtml(fails, esc) {
  return fails.map((f) => chip(f.st, esc, true, f.n)).join("");
}
// \sageplot's options (graphicx-style keys): width and height with a length or a fraction of \textwidth,
// \linewidth or \columnwidth are applied, bounded; anything else is shown as ignored, never silently dropped
// (astra4 S1E01-A2). -> { style, ignored: [text] }
const UNITS = { cm: "cm", mm: "mm", in: "in", pt: "pt", bp: "pt", em: "em", ex: "ex", px: "px" };
export function plotOptions(opts) {
  const dims = {}, ignored = [];
  const [keys, fmt] = opts || [];
  if (fmt !== undefined && fmt !== "") ignored.push("format [" + fmt + "]");
  for (const kv of String(keys || "").split(",").map((x) => x.trim()).filter(Boolean)) {
    const m = /^(width|height)\s*=\s*(.+)$/.exec(kv);
    let v = null;
    if (m) {
      const a = /^(\d*\.?\d+)\s*(cm|mm|in|pt|bp|em|ex|px)$/.exec(m[2].trim());
      const r = /^(\d*\.?\d+)?\s*\\(textwidth|linewidth|columnwidth)\s*$/.exec(m[2].trim());
      if (a && +a[1] > 0 && +a[1] <= 1000) v = String(+a[1]) + UNITS[a[2]];
      else if (r) { const f = r[1] === undefined ? 1 : +r[1]; if (f > 0 && f <= 1) v = String(Math.round(f * 1000) / 10) + "%"; }
    }
    if (v !== null && dims[m[1]] === undefined) dims[m[1]] = v;
    else ignored.push(kv);   // (unsupported, malformed, or the same key twice)
  }
  // (an explicit height is kept whatever the order; height:auto only when none is given, astra4 S1E02-A2)
  const css = [];
  if (dims.width !== undefined) css.push("width:" + dims.width);
  if (dims.height !== undefined) css.push("height:" + dims.height);
  else if (dims.width !== undefined) css.push("height:auto");
  return { style: css.join(";"), ignored };
}
// a results file's states (`sagebrush latex run`: [{key, s, latex?, src?, msg?}]) for these items, in order, as long
// as each is for the very item at its place (its key) and every one before it is too; only ok, error and blocked
// states, with the fields the renderer shows (each checked again where it is shown: inlineHtml, mathPart).
// Past that prefix (code changed since the Run), an item keeps its last value, "stale" (@sagebrush's Q3 ruling, Nov 8:
// the last values, marked stale, never "…" while the code is stale): the saved ok result of the same code, in order
// (an item whose code is unchanged, after an edit above it), or else the one at its place if that is of the same kind
// and its code is in the document no more (an item edited in place). A new item, or one whose last Run failed, is
// not run.
export function savedStates(items, saved) {
  const out = [];
  let k = 0;
  for (; k < items.length && k < saved.length; k++) {
    const x = saved[k];
    if (!x || typeof x !== "object" || x.key !== itemKey(items[k]) || !["ok", "error", "blocked", "stale"].includes(x.s)) break;
    out.push(shown(x, x.s));
  }
  const keys = items.map(itemKey), now = new Set(keys), unused = new Map();
  for (let j = k; j < saved.length; j++) {
    const x = saved[j];
    if (x && typeof x === "object" && (x.s === "ok" || x.s === "stale") && typeof x.key === "string") { if (!unused.has(x.key)) unused.set(x.key, []); unused.get(x.key).push(j); }
  }
  const taken = new Set();
  for (let i = k; i < items.length; i++) {
    let j = (unused.get(keys[i]) ?? []).find((q) => !taken.has(q));
    // (the result at i is never taken already: one taken by key is the code of an item still here, which `now` excludes)
    if (j === undefined && i < saved.length && (saved[i]?.s === "ok" || saved[i]?.s === "stale") && typeof saved[i].key === "string" && !now.has(saved[i].key) && sameKind(saved[i].key, items[i])) j = i;
    if (j === undefined) continue;
    taken.add(j);
    out[i] = { ...shown(saved[j], "stale"), key: keys[i] };
  }
  return out;
}
// (a saved state, only the fields the renderer shows)
function shown(x, s) {
  const st = { key: x.key, s };
  if (typeof x.latex === "string") st.latex = x.latex;
  if (typeof x.src === "string") st.src = x.src;
  if (typeof x.msg === "string") st.msg = x.msg.slice(0, 4000);
  if (Array.isArray(x.interacts)) st.interacts = x.interacts;
  if (Object.hasOwn(KEPT, x.why)) st.why = x.why;
  return st;
}
// (a saved key's item of the same kind as `it`: its mode, and the same wrapper)
function sameKind(key, it) {
  try { const a = JSON.parse(key); return Array.isArray(a) && a[0] === it.mode && a[4] === WRAPPER_VERSION; } catch { return false; }
}
/** What a stale value's mark says (its title). */
export const STALE_TITLE = "Changed since the last Run: Shift+Enter or Run updates it";
/** Why an item a Run didn't reach keeps its value from an earlier one (@sagebrush's ruling and board's words, Nov 12),
 *  by the reason the Run wrote (run-core keepLast, the results file's `why`): after a failed item, the Run stopped, or
 *  the session ended. Only these are shown as such a value's title. */
export const KEPT = {
  failed: "Not run this time: an item before it failed. This value is from an earlier run.",
  stopped: "Not run this time: the run was stopped. This value is from an earlier run.",
  ended: "Not run this time: the session ended. This value is from an earlier run.",
};
// (a stale value's title: why it was kept, if a Run kept it; else that its code changed)
export const staleTitle = (st) => (Object.hasOwn(KEPT, st?.why) ? KEPT[st.why] : STALE_TITLE);
export function stateOf(states, n, it) {
  if (it.err) return { s: "error", msg: whyRejected(it) };
  const s = states && states[n];
  if (s && s.key === itemKey(it)) return s;
  return { s: "notrun", msg: "not run" };
}

// inside a math region (plan r4 section 6): the placeholder this item contributes to the region's TeX string
// (a stale value is its last one; the renderer marks the whole region stale: render.mjs mathStale)
const TEX_ESC = { "\\": "\\textbackslash{}", "{": "\\{", "}": "\\}", $: "\\$", "&": "\\&", "#": "\\#", "^": "\\textasciicircum{}", _: "\\_", "%": "\\%", "~": "\\textasciitilde{}" };
export function mathPart(st, it) {
  if ((st.s === "ok" || st.s === "stale") && it.mode === "sage" && typeof st.latex === "string" && utf8len(st.latex) <= MAX_RESULT) return "{" + st.latex + "}";
  // (\magma in math: its one line as monospace text, every TeX special escaped)
  if ((st.s === "ok" || st.s === "stale") && it.mode === "magma" && typeof st.latex === "string" && utf8len(st.latex) <= MAX_RESULT && !st.latex.replace(/\n$/, "").includes("\n")) return "{\\text{\\texttt{" + st.latex.replace(/\n$/, "").replace(/[\\{}$&#^_%~]/g, (c) => TEX_ESC[c]) + "}}}";
  if (st.s === "pending" || st.s === "notrun") return "{\\text{…}}";
  return "{\\boxed{\\text{?}}}";
}

/** What an item after a failed one says, everywhere (board's M4): a failing item stops the rest. */
/** \magma's one-line rule (H6b's words) */
export const ONE_LINE = "\\magma{} shows one line: this value prints on several. Use magmablock.";
export const BLOCKED = "Not run: an item before this one failed (fix it and run again)";
const LABEL = { pending: "running…", notrun: "not run", error: "error", blocked: BLOCKED };
export const DATA_SVG = /^data:image\/svg\+xml;base64,[A-Za-z0-9+/]+={0,2}$/;
// n: the item's number in the document (1-based), named in the chip so a reader can tell which code it is about
function chip(st, esc, inline, n, lang = "Sage") {
  const cls = "sagechip s-" + (LABEL[st.s] ? st.s : "error");
  const msg = String(st.msg || LABEL[st.s] || "error").slice(0, 4000);
  const who = n ? lang + " item " + n + ": " : "";
  if (st.s === "error" && !inline) return '<pre class="' + cls + '">' + esc(who + msg) + "</pre>";
  // (the last line of a traceback; with the executor's "(... isn't defined here ...)" note, the line before it too)
  const lines = msg.split("\n").filter((l) => l.trim());
  const last = lines.length > 1 && /^\(/.test(lines[lines.length - 1]) ? lines.slice(-2).join(" ") : lines.pop() || "";
  return '<span class="' + cls + '" title="' + esc(who + msg) + '">' + esc((who + (st.s === "error" ? "error: " + last : msg)).slice(0, 600)) + "</span>";
}
// A Sage table() outside math (latex(table) is a tabular, which KaTeX can't set): drawn as the document's own tabular
// is, each cell's $…$ by KaTeX and its plain text as text. Only that simple form: a column spec of l, c, r and |,
// cells of plain text and $…$, rows ending in \\ and \hline rules. Anything else gives null and is set as math, as
// before. The result never enters the TeX expander.
const TABLE = /^\s*\\begin\{tabular\}\{([lcr|]+)\}([\s\S]*)\\end\{tabular\}\s*$/;
const TOK = /\$[^$]*\$|\\\\|\\hline(?![A-Za-z])|[&{}$\\]|[^$\\&{}]+/g;
export function sageTable(latex, esc, math) {
  const m = TABLE.exec(latex);
  if (!m) return null;
  // (each column's alignment; whether a rule stands before the first, and after each)
  const al = m[1].match(/[lcr]/g), bar = m[1].split(/[lcr]/).map((x) => x.includes("|")), rows = [{ cells: [""] }];
  if (!al) return null;
  for (const [t] of m[2].matchAll(TOK)) {
    const r = rows[rows.length - 1];
    if (t === "\\\\") rows.push({ cells: [""] });
    else if (t === "\\hline") r[r.cells.length === 1 && !r.cells[0].trim() ? "top" : "bottom"] = true;
    else if (t === "&") r.cells.push("");
    else if (t.length === 1 && "{}$\\".includes(t)) return null;
    else r.cells[r.cells.length - 1] += t;
  }
  const last = rows[rows.length - 1];
  if (last.cells.length === 1 && !last.cells[0].trim()) { rows.pop(); if (last.top && rows.length) rows[rows.length - 1].bottom = true; }
  if (!rows.length || rows.length > 500 || rows.some((r) => r.cells.length > al.length)) return null;
  // a cell: its $…$ runs as math, the text between them as text
  const cell = (x) => x.trim().split(/(\$[^$]*\$)/).map((p) => (p[0] === "$" && p.length > 1 ? math(p.slice(1, -1)) : esc(p))).join("");
  const rule = "1px solid currentColor";
  return '<table class="tabular sagetable' + (bar[0] ? " bl" : "") + '"><tbody>' + rows.map((r) => "<tr" + (r.top ? ' class="ht"' : "")
    + (r.bottom ? ' style="border-bottom:' + rule + '"' : "") + ">" + r.cells.map((x, k) => '<td class="al-' + al[k] + '"'
    + (bar[k + 1] ? ' style="border-right:' + rule + '"' : "") + ">" + cell(x) + "</td>").join("") + "</tr>").join("") + "</tbody></table>";
}

// outside math: \sage as standalone inline math (math: the renderer's KaTeX call), or a Sage table as a table;
// \sageplot as an image; a stale one is its last value, marked (class sagestale, its title saying why)
export function inlineHtml(st, it, esc, math, n) {
  const stale = st.s === "stale", ok = st.s === "ok" || stale;
  // (\py: its result was read back as TeX where it stands (demo-machine.mjs); only a state without one shows here)
  if (it.mode === "py") return ok && !pyBig(st, it) ? "" : chip(ok ? pyBig(st, it) : st, esc, true, n, "Python");
  // (\magma: what Magma printed, as text, in the text's monospace; one line only)
  if (it.mode === "magma") {
    const t = ok && typeof st.latex === "string" ? st.latex.replace(/\n$/, "") : null;
    if (t === null || utf8len(t) > MAX_RESULT) return chip(ok ? { s: "error", msg: "the result can't be shown" } : st, esc, true, n, "Magma");
    if (t.includes("\n")) return chip({ s: "error", msg: ONE_LINE }, esc, true, n, "Magma");
    return '<code class="magmaout' + (stale ? ' sagestale" title="' + esc(staleTitle(st)) : "") + '">' + esc(t) + "</code>";
  }
  if (ok && it.mode === "sage" && typeof st.latex === "string" && utf8len(st.latex) <= MAX_RESULT) {
    const h = sageTable(st.latex, esc, math) ?? math(st.latex);
    return stale ? '<span class="sagestale" title="' + esc(staleTitle(st)) + '">' + h + "</span>" : h;
  }
  if (ok && it.mode === "plot" && typeof st.src === "string" && DATA_SVG.test(st.src)) {
    const o = plotOptions(it.opts);
    if (o.ignored.length) return chip({ s: "error", msg: whyRejected({ err: "plotopts", name: o.ignored.join(", ") }) }, esc, true, n);
    return '<img class="sageplot' + (stale ? ' sagestale" title="' + esc(staleTitle(st)) : "") + '" alt="a plot" src="' + st.src + '"' + (o.style ? ' style="' + esc(o.style) + '"' : "") + ">";
  }
  return chip(ok ? { s: "error", msg: "the result can't be shown" } : st, esc, true, n);
}
// a code block: sageblock shows its code (as SageTeX typesets it), sagesilent nothing; both show a failed or
// not-yet-run state (a stale one, which ran, none: it has no value to keep), and the @interacts it made
export function blockHtml(st, it, esc, n) {
  let h = it.shown !== undefined ? '<pre class="verbatim code sageblock">' + esc(it.shown) + "</pre>" : "";
  if (st.s !== "ok" && st.s !== "stale") h += '<div class="sagestate">' + chip(st, esc, false, n, langOf(it)) + "</div>";
  else if (isNonSage(it) && pyBig(st, it)) h += '<div class="sagestate">' + chip(pyBig(st, it), esc, false, n, langOf(it)) + "</div>";
  // (magmablock: what Magma printed, under its code, as text)
  else if (it.mode === "magmablock" && st.latex) h += '<pre class="verbatim code magmaout' + (st.s === "stale" ? ' sagestale" title="' + esc(staleTitle(st)) : "") + '">' + esc(st.latex.replace(/\n$/, "")) + "</pre>";
  else h += interactsAt(st.interacts, esc, st.s === "stale" && staleTitle(st));
  return h;
}
// ---- @interact (a Sagebrush extension, William Nov 8: "@interact inside sagesilent/sageblock as a documented Sagebrush
// extension"; upstream SageTeX and Sage 10.10 raise NameError on it): an item's interacts as the Run kept them (run-core
// interactsOf) go into the HTML only as data, escaped JSON in a placeholder that says the item is interactive; the page's
// interact chunk (interact.ts, fetched only once a preview has one) draws them there, so the eager group doesn't carry
// the drawing (its cap: a lazy split, not a raise)
export function interactsAt(list, esc, stale = false) {
  if (!Array.isArray(list) || !list.length) return "";
  return '<div class="sageinteract-at"' + (stale ? ' data-stale="' + esc(stale) + '"' : "") + ' data-ia="' + esc(JSON.stringify(list.slice(0, 8))) + '"><div class="si-note">Interactive in Sagebrush</div></div>';
}
