// The comments CLI (scripts/latex-comments.mjs) on real files in a temp folder: the agent's side of the loop (a person
// comments; the agent lists, edits the .tex with an ordinary write, reattaches, replies, resolves), the lock (LC-T2:
// held, "locked"; released only by its owner) and two CLI processes at once (both comments kept).
//   bun web/latex/test-latex-comments-cli.mjs
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const CLI = new URL("../../scripts/latex-comments.mjs", import.meta.url).pathname;
const run = (...a) => new Promise((res) => { const p = spawn(process.execPath, [CLI, ...a]); let o = "", e = ""; p.stdout.on("data", (d) => (o += d)); p.stderr.on("data", (d) => (e += d)); p.on("close", (code) => res({ code, out: o, err: e, json: (() => { try { return JSON.parse(o); } catch { return null; } })(), error: (() => { try { return JSON.parse(e).error; } catch { return null; } })() })); });
const results = [];
const check = (name, ok, detail) => { results.push([name, !!ok]); if (!ok) console.log("FAIL", name, JSON.stringify(detail)?.slice(0, 600)); };
const dir = mkdtempSync(join(tmpdir(), "sb-latex-comments-")), tex = join(dir, "paper.tex"), side = tex + ".comments.json";
const TEX = "\\documentclass{article}\n\\begin{document}\nLet $n$ be even. Then $n^2$ is even.\n\nThe sum of two odd numbers is even.\nAnd the sum of two even numbers is even.\n\\end{document}\n";
writeFileSync(tex, TEX);
try {
  // the person's comments (here through the CLI, as person:wstein)
  const amb = await run("add", tex, "--quote", "is even.", "--text", "?", "--author", "person:wstein");
  check("cli-add-ambiguous-quote-refused", amb.code === 1 && amb.error?.code === "ambiguous" && amb.error.detail.candidates.length === 3 && !existsSync(side), amb.error);
  const c1 = await run("add", tex, "--quote", "The sum of two odd numbers is even.", "--text", "Prove this.", "--author", "person:wstein");
  const c2 = await run("add", tex, "--quote", "is even.", "--occurrence", "1", "--text", "Why is n^2 even?", "--author", "person:wstein");
  check("cli-add", c1.code === 0 && c1.json.status === "exact" && c2.code === 0 && c2.json.range.start.line === 3, { c1: c1.err, c2: c2.err });
  const noAuthor = await run("add", tex, "--quote", "Let", "--text", "x");
  check("cli-write-needs-author", noAuthor.code === 1 && noAuthor.error?.code === "invalid");
  // the agent lists, then rewrites the first commented sentence with an ordinary file write
  const l1 = await run("list", tex);
  check("cli-list", l1.code === 0 && l1.json.threads.length === 2 && l1.json.threads.every((t) => t.status === "exact" && t.first.author === "person:wstein"), l1.json);
  writeFileSync(tex, TEX.replace("The sum of two odd numbers is even.", "The sum of two odd numbers $2a+1$ and $2b+1$ is $2(a+b+1)$, which is even."));
  const l2 = await run("list", tex);
  const t1 = l2.json.threads.find((t) => t.id === c1.json.id);
  check("cli-after-agent-edit-changed", t1.status === "changed" && t1.range.start.line === 5, t1);
  const rp = await run("reply", tex, c1.json.id, "--text", "Done: wrote out 2a+1 and 2b+1.", "--author", "agent:claude");
  const rs = await run("resolve", tex, c1.json.id, "--author", "agent:claude");
  const sh = await run("show", tex, c1.json.id);
  check("cli-reply-resolve-show", rp.code === 0 && rs.code === 0 && sh.json.resolved === true && sh.json.messages.length === 2 && sh.json.messages[1].agent === true, sh.json);
  // the agent adds a sentence that repeats the second comment's quote with the same context: ambiguous, then reattached
  writeFileSync(tex, readFileSync(tex, "utf8").replace("\\end{document}", "Let $n$ be even. Then $n^2$ is even.\n\\end{document}"));
  const l3 = await run("list", tex);
  const t2 = l3.json.threads.find((t) => t.id === c2.json.id);
  check("cli-duplicate-ambiguous", t2.status === "ambiguous" && t2.candidates.length >= 2, t2);
  const ra = await run("reattach", tex, c2.json.id, "--occurrence", "1", "--author", "agent:claude");
  check("cli-reattach", ra.code === 0 && ra.json.status === "exact" && ra.json.range.start.line === 3, ra.json ?? ra.err);
  const pretty = await run("list", tex, "--all", "--pretty");
  check("cli-pretty", pretty.code === 0 && /\(agent\)/.test(pretty.out) && /resolved/.test(pretty.out), pretty.out.slice(0, 300));
  // the lock: held by someone else, "locked" (never broken); after release, writes work
  writeFileSync(side + ".lock", JSON.stringify({ pid: 1, host: "elsewhere", time: new Date().toISOString(), token: "k_other" }));
  const t0 = Date.now(), lk = await run("reply", tex, c2.json.id, "--text", "x", "--author", "agent:claude");
  check("LC-T2-cli-locked-fails-closed", lk.code === 1 && lk.error?.code === "locked" && existsSync(side + ".lock") && JSON.parse(readFileSync(side + ".lock", "utf8")).token === "k_other", { err: lk.error, ms: Date.now() - t0 });
  rmSync(side + ".lock");
  // two CLI processes adding at once: both comments kept
  const [a, b] = await Promise.all([run("add", tex, "--quote", "documentclass", "--text", "A", "--author", "agent:a"), run("add", tex, "--quote", "begin{document}", "--text", "B", "--author", "agent:b")]);
  const l4 = await run("list", tex);
  check("LC-T2-cli-two-processes-both-kept", a.code === 0 && b.code === 0 && l4.json.threads.length === 3 && !existsSync(side + ".lock"), { a: a.error, b: b.error, n: l4.json?.threads.length });
} finally { rmSync(dir, { recursive: true, force: true }); }
const failed = results.filter(([, ok]) => !ok).map(([n]) => n);
console.log(failed.length ? `FAIL: ${failed.length} of ${results.length}: ${failed.join(", ")}` : `ok: the comments CLI, ${results.length} checks`);
process.exit(failed.length ? 1 : 0);
