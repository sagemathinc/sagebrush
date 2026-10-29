#!/usr/bin/env node
// Comments on a LaTeX file on disk (plan latex-comments r4.2 §3, §7.2, §8.3): paper.tex's comments are in
// paper.tex.comments.json beside it. The same core as the page and the MCP tools (web/latex/comments-core.mjs).
//   node scripts/latex-comments.mjs list    paper.tex [--all] [--cursor JSON] [--pretty]
//   node scripts/latex-comments.mjs show    paper.tex <thread> [--pretty]
//   node scripts/latex-comments.mjs add     paper.tex (--quote "…" [--occurrence n] | --range L:C-L:C) --text "…" --author agent:<name>
//   node scripts/latex-comments.mjs reply   paper.tex <thread> --text "…" --author agent:<name>
//   node scripts/latex-comments.mjs resolve paper.tex <thread> [--reopen] --author agent:<name>
//   node scripts/latex-comments.mjs reattach paper.tex <thread> (--occurrence n | --quote "…" [--occurrence n] | --range L:C-L:C) --author …
// Output: JSON (or a readable form with --pretty). Errors: JSON {error: {code, message, detail}} on stderr, exit 1.
// Writing: an exclusive lock file (paper.tex.comments.json.lock, never broken automatically: "locked" names its
// holder), a temp file written and fsynced, the sidecar checked to be what was read, then an atomic rename; a
// changed sidecar (a writer without the lock) is a conflict, retried by the core (5 attempts, one 10 s deadline).
import { readFileSync, writeFileSync, renameSync, unlinkSync, openSync, closeSync, fsyncSync, existsSync } from "node:fs";
import { dirname, basename, resolve as resolvePath } from "node:path";
import { hostname } from "node:os";
import * as C from "../web/latex/comments-core.mjs";

const args = process.argv.slice(2);
const cmd = args.shift(), tex = args.shift();
const opt = (name) => { const i = args.indexOf("--" + name); return i >= 0 ? args[i + 1] : undefined; };
const flag = (name) => args.includes("--" + name);
const BOOL = ["--all", "--pretty", "--reopen"];
const positional = args.filter((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1].startsWith("--") && !BOOL.includes(args[i - 1])));
const out = (v) => { process.stdout.write((flag("pretty") ? readable(v) : JSON.stringify(v, null, 1)) + "\n"); };
const die = (e) => { process.stderr.write(JSON.stringify({ error: { code: e.code ?? "error", message: e.message, detail: e.detail } }) + "\n"); process.exit(1); };

function readable(v) {
  const one = (t) => {
    const where = t.range ? `${t.range.start.line}:${t.range.start.col}-${t.range.end.line}:${t.range.end.col}` : "(not placed)";
    const head = `${t.id}  [${t.resolved ? "resolved" : "open"}, ${t.status}${t.reason ? ": " + t.reason : ""}]  ${where}\n  “${t.quote}”`;
    const cands = (t.candidates ?? []).map((c, k) => `  candidate ${k + 1}: ${c.range.start.line}:${c.range.start.col}-${c.range.end.line}:${c.range.end.col}`).join("\n");
    const ms = Array.isArray(t.messages) ? t.messages.map((m) => `  ${m.author}${m.agent ? " (agent)" : ""}, ${m.time}:\n    ${m.text.replace(/\n/g, "\n    ")}`).join("\n")
      : [t.first, t.last].filter(Boolean).map((m) => `  ${m.author}${m.agent ? " (agent)" : ""}: ${m.text}`).join("\n") + (t.messages > 2 ? `\n  (${t.messages} messages: show ${t.id})` : "");
    return [head, cands, ms].filter(Boolean).join("\n");
  };
  if (v.threads) return v.threads.map(one).join("\n\n") + (v.more ? `\n\n(more: --cursor '${JSON.stringify(v.cursor)}')` : "") || "(no comments)";
  return one(v);
}

if (!cmd || !tex || ["-h", "--help"].includes(cmd)) { process.stdout.write(readFileSync(new URL(import.meta.url), "utf8").split("\n").slice(1, 10).map((l) => l.replace(/^\/\/ ?/, "")).join("\n") + "\n"); process.exit(cmd ? 0 : 2); }
const texPath = resolvePath(tex), side = texPath + ".comments.json", lock = side + ".lock";
const file = { fid: null, path: texPath };
const readText = () => { try { return readFileSync(texPath, "utf8"); } catch { die(new C.CommentsError("missing", "no file " + tex)); } };
const readSide = () => (existsSync(side) ? readFileSync(side, "utf8") : null);
const range = (s) => { const m = /^(\d+):(\d+)-(\d+):(\d+)$/.exec(s ?? ""); if (!m) die(new C.CommentsError("invalid", "a range is L:C-L:C")); return { start: { line: +m[1], col: +m[2] }, end: { line: +m[3], col: +m[4] } }; };
const author = () => { const a = opt("author"); if (!a || !/^(person|agent):\S/.test(a)) die(new C.CommentsError("invalid", "--author person:<name> or agent:<name> is required to write")); return a; };

// the lock: exclusive create, never broken automatically; released only by its owner (its token checked)
const token = C.newId("k");
async function withLock(deadline, f) {
  for (;;) {
    try { const fd = openSync(lock, "wx"); writeFileSync(fd, JSON.stringify({ pid: process.pid, host: hostname(), time: C.now(), token })); closeSync(fd); break; }
    catch (e) {
      if (e.code !== "EEXIST") throw e;
      if (Date.now() + 100 >= deadline) { let h = {}; try { h = JSON.parse(readFileSync(lock, "utf8")); } catch {} die(new C.CommentsError("locked", "the comments file is locked by another comments command; if none is running, delete " + lock, { holder: h, lock })); }
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  try { return await f(); }
  finally { try { if (JSON.parse(readFileSync(lock, "utf8")).token === token) unlinkSync(lock); else process.stderr.write(JSON.stringify({ warning: "the lock isn't ours any more; left in place", lock }) + "\n"); } catch {} }
}
// the io the core retries over: read gives the sidecar and its own text as `base`; write replaces it atomically, and
// only if it is still exactly what was read (else: conflict)
const io = {
  read: async () => { const content = readSide(); return { content, base: content }; },
  write: async (content, base) => {
    const tmp = side + ".tmp." + process.pid;
    const fd = openSync(tmp, "w"); writeFileSync(fd, content); fsyncSync(fd); closeSync(fd);
    if (readSide() !== base) { unlinkSync(tmp); const e = new Error("the comments file changed while it was written"); e.code = "conflict"; throw e; }
    renameSync(tmp, side);
    try { const d = openSync(dirname(side), "r"); fsyncSync(d); closeSync(d); } catch {}
  },
};
async function write(op, draft) {
  const deadline = Date.now() + C.LIMITS.deadlineMs;
  return withLock(deadline, () => C.update(io, op, { file, draft, deadlineMs: Math.max(1, deadline - Date.now()) }));
}

try {
  const text = readText();
  if (cmd === "list") out(C.list(C.parse(readSide(), file), text, { all: flag("all"), cursor: opt("cursor") ? JSON.parse(opt("cursor")) : null }));
  else if (cmd === "show") out(C.show(C.parse(readSide(), file), text, positional[0]));
  else if (cmd === "add") {
    const body = opt("text"), who = author();
    const span = C.locateSpan(text, opt("range") ? { range: range(opt("range")) } : { quote: opt("quote"), occurrence: opt("occurrence") ? +opt("occurrence") : undefined });
    const r = await write((d) => C.addThread(d, { anchor: C.makeAnchor(text, span.start, span.end), text: body ?? "", author: who }), body);
    out(C.show(r.doc, text, r.id));
  } else if (cmd === "reply") { const body = opt("text"), who = author(); const r = await write((d) => C.reply(d, positional[0], { text: body ?? "", author: who }), body); out(C.show(r.doc, text, r.id)); }
  else if (cmd === "resolve") { const who = author(); const r = await write((d) => C.setResolved(d, positional[0], !flag("reopen"), { author: who })); out(C.show(r.doc, text, r.id)); }
  else if (cmd === "reattach") {
    const who = author(), id = positional[0];
    let span;
    if (opt("range")) span = C.locateSpan(text, { range: range(opt("range")) });
    else if (opt("quote")) span = C.locateSpan(text, { quote: opt("quote"), occurrence: opt("occurrence") ? +opt("occurrence") : undefined });
    else { const t = C.show(C.parse(readSide(), file), text, id), c = (t.candidates ?? [])[+(opt("occurrence") ?? 0) - 1]; if (!c) die(new C.CommentsError("invalid", "--occurrence n names one of the thread's candidates (" + (t.candidates?.length ?? 0) + ")")); span = c.offsets; }
    const r = await write((d) => C.reattach(d, id, C.makeAnchor(text, span.start, span.end), { author: who }));
    out(C.show(r.doc, text, r.id));
  } else die(new C.CommentsError("invalid", "unknown command " + cmd));
} catch (e) { die(e); }
