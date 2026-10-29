// SageTeX S1 (plan sagetex-plan-r4): the code items of a document, and how each one's state is shown.
// The expander (demo-machine.mjs) marks every \sage, \sageplot, sageblock and sagesilent in expansion order; the
// renderer numbers them (sageItems) and asks here how each is shown. Nothing here executes anything: the page's
// executor (web/sage/executor.js) runs the ordered items in the runner, with consent, and sends back their states.
// SECURITY: every piece of document text and every message from the runner reaches the HTML only through esc();
// a result's LaTeX reaches only KaTeX (trust: false, through the renderer's math()); a plot only as an <img> whose
// src must be a base64 SVG data URL (checked here, again); results never enter the TeX expander.

export const WRAPPER_VERSION = "sbtx-wrapper-1";
export const MAX_CODE = 65536;            // bytes (UTF-8) of code per item (plan r4 section 8)
export const MAX_RESULT = 16384;          // bytes (UTF-8) of one \sage result
// a string's UTF-8 length, the one byte measure of every cap here and in the executor (astra C2, astra3 S1-A3-3);
// a lone surrogate counts 3, as TextEncoder writes it (U+FFFD)
export function utf8len(s) {
  let n = 0;
  for (const ch of String(s)) { const c = ch.codePointAt(0); n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4; }
  return n;
}
const SAGE_ENVS = new Set(["sageblock", "sagesilent"]);
export const UNSUPPORTED_ENVS = new Set(["sagecommandline", "sageexample"]);
export const isCodeEnv = (env) => SAGE_ENVS.has(env);

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
  const it = { mode: e.env === "sageblock" ? "block" : "silent", opts: [] };
  if (e.inarg) it.err = "inarg";
  else if (e.unterminated) it.err = "unterminated";
  else if (e.truncated) it.err = "truncated";
  else {
    const d = dedent(e.text);
    if (d.err) it.err = d.err;
    else if (utf8len(d.code) > MAX_CODE) it.err = "toolong";
    else it.code = d.code;
  }
  if (it.mode === "block") it.shown = String(e.text).replace(/\r\n/g, "\n");
  return it;
}
// what makes two items the same code (the executor's identity uses the same key)
export const itemKey = (it) => JSON.stringify([it.mode, it.code === undefined ? null : it.code, it.opts, it.err || null, WRAPPER_VERSION]);

const WHY = {
  cs: (it) => "this preview supports only plain Sage expressions inside \\sage{}: \\" + it.name + " is a TeX command",
  active: (it) => "this preview supports only plain Sage expressions inside \\sage{}: " + it.name + " is an active character",
  unbalanced: () => "the argument is unbalanced (it runs to the end of the document)",
  par: () => "the argument runs past a blank line (a % starts a comment in TeX: write mod(a, b))",
  nobrace: () => "the argument must be in braces",
  empty: () => "the argument is empty",
  toolong: () => "the code is over 64 KiB (UTF-8)",
  inarg: () => "a code block inside a command's argument can't be read",
  unterminated: (it) => "no \\end{" + (it.mode === "block" ? "sageblock" : "sagesilent") + "}",
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
export function stateOf(states, n, it) {
  if (it.err) return { s: "error", msg: whyRejected(it) };
  const s = states && states[n];
  if (s && s.key === itemKey(it)) return s;
  return { s: "notrun", msg: "not run" };
}

// inside a math region (plan r4 section 6): the placeholder this item contributes to the region's TeX string
export function mathPart(st, it) {
  if (st.s === "ok" && it.mode === "sage" && typeof st.latex === "string" && utf8len(st.latex) <= MAX_RESULT) return "{" + st.latex + "}";
  if (st.s === "pending" || st.s === "notrun") return "{\\text{…}}";
  return "{\\boxed{\\text{?}}}";
}

const LABEL = { pending: "running…", notrun: "not run", error: "error", blocked: "not run: an earlier item failed" };
const DATA_SVG = /^data:image\/svg\+xml;base64,[A-Za-z0-9+/]+={0,2}$/;
// n: the item's number in the document (1-based), named in the chip so a reader can tell which code it is about
function chip(st, esc, inline, n) {
  const cls = "sagechip s-" + (LABEL[st.s] ? st.s : "error");
  const msg = String(st.msg || LABEL[st.s] || "error").slice(0, 4000);
  const who = n ? "Sage item " + n + ": " : "";
  if (st.s === "error" && !inline) return '<pre class="' + cls + '">' + esc(who + msg) + "</pre>";
  // (the last line of a traceback; with the executor's "(... isn't defined here ...)" note, the line before it too)
  const lines = msg.split("\n").filter((l) => l.trim());
  const last = lines.length > 1 && /^\(/.test(lines[lines.length - 1]) ? lines.slice(-2).join(" ") : lines.pop() || "";
  return '<span class="' + cls + '" title="' + esc(who + msg) + '">' + esc((who + (st.s === "error" ? "error: " + last : msg)).slice(0, 600)) + "</span>";
}
// outside math: \sage as standalone inline math (math: the renderer's KaTeX call), \sageplot as an image
export function inlineHtml(st, it, esc, math, n) {
  if (st.s === "ok" && it.mode === "sage" && typeof st.latex === "string" && utf8len(st.latex) <= MAX_RESULT) return math(st.latex);
  if (st.s === "ok" && it.mode === "plot" && typeof st.src === "string" && DATA_SVG.test(st.src)) {
    const o = plotOptions(it.opts);
    if (o.ignored.length) return chip({ s: "error", msg: whyRejected({ err: "plotopts", name: o.ignored.join(", ") }) }, esc, true, n);
    return '<img class="sageplot" alt="a plot" src="' + st.src + '"' + (o.style ? ' style="' + esc(o.style) + '"' : "") + ">";
  }
  return chip(st.s === "ok" ? { s: "error", msg: "the result can't be shown" } : st, esc, true, n);
}
// a code block: sageblock shows its code (as SageTeX typesets it), sagesilent nothing; both show a failed or
// not-yet-run state
export function blockHtml(st, it, esc, n) {
  let h = it.mode === "block" ? '<pre class="verbatim code sageblock">' + esc(it.shown || "") + "</pre>" : "";
  if (st.s !== "ok") h += '<div class="sagestate">' + chip(st, esc, false, n) + "</div>";
  return h;
}
