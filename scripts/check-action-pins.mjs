#!/usr/bin/env bun
// Every GitHub Action this repository runs is pinned to a commit: every `uses:`
// in .github/workflows/*.yml and .github/actions/**/action.yml must be
//   - a local action:            uses: ./path
//   - a container by digest:     uses: docker://image@sha256:<64 lowercase hex>
//   - an action at a commit:     uses: owner/repo[/path]@<40 lowercase hex> # v1.2.3
//                                                                (or # branch <name>)
// with the comment exactly that and nothing after it.  The same sha carries the
// same comment everywhere, and the same repository with the same comment the
// same sha, so a pin can't be moved (or its comment edited) in half the places.
//
// Closed: the YAML is parsed (Bun.YAML, every document; step and job-level
// `uses`), and the parser's `uses` must be exactly the raw text's block-form
// `uses:` lines outside block scalars, so a form the parser sees but the line
// rule doesn't (a flow mapping, a quoted key) fails, and so does the reverse.
//   bun scripts/check-action-pins.mjs [files...]       (default: the repo's)
//   bun scripts/check-action-pins.mjs --verify [files] (local only, uses gh:
//     re-resolves each comment's tag or branch and reports a moved pin)
// scripts/test-check-action-pins.mjs runs it on scripts/action-pins-fixtures.
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const SHA = /^[0-9a-f]{40}$/;
const COMMENT = /^# (v\d+\.\d+\.\d+|branch [A-Za-z0-9._/-]+)$/;
// a block-form `uses:` line: key (optionally after "- "), value, optional comment
const LINE = /^(\s*)(?:-\s+)?uses:\s+(\S+?)(?:\s+(#.*))?\s*$/;
// (uses as a KEY anywhere else: quoted, or inside a flow mapping)
const ANY_USES = /(?:^\s*(?:-\s*)?|[{,]\s*)["']?uses["']?\s*:/;
// a block scalar (run: |, script: >-, ...): its lines are text, not keys
const BLOCK_SCALAR = /^(\s*)(?:-\s+)?["']?[A-Za-z0-9_.-]+["']?:\s*[|>][-+0-9]*\s*(#.*)?$/;

function defaultFiles(root = ".") {
  const out = [];
  const wf = join(root, ".github/workflows");
  if (existsSync(wf)) for (const f of readdirSync(wf).sort()) if (/\.ya?ml$/.test(f)) out.push(join(wf, f));
  const walk = (dir) => {
    if (!existsSync(dir)) return;
    for (const f of readdirSync(dir).sort()) {
      const p = join(dir, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (f === "action.yml" || f === "action.yaml") out.push(p);
    }
  };
  walk(join(root, ".github/actions"));
  return out;
}

// every `uses` value the parser sees: job-level (reusable workflows), steps
// (workflows and composite actions' runs.steps)
function parsedUses(doc) {
  const found = [];
  const steps = (list) => {
    if (!Array.isArray(list)) return;
    for (const s of list) if (s && typeof s === "object" && "uses" in s) found.push(String(s.uses));
  };
  if (doc && typeof doc === "object") {
    for (const job of Object.values(doc.jobs ?? {})) {
      if (job && typeof job === "object") {
        if ("uses" in job) found.push(String(job.uses));
        steps(job.steps);
      }
    }
    steps(doc.runs?.steps);
  }
  return found;
}

// the raw text: block-form uses lines, and any other line naming uses as a key,
// outside block scalars (a run: | script mentioning uses: is not a key)
function rawUses(text) {
  const lines = text.split("\n");
  const block = [];
  const other = [];
  let scalarIndent = -1;
  lines.forEach((line, i) => {
    const indent = line.match(/^\s*/)[0].length;
    if (scalarIndent >= 0) {
      if (line.trim() === "" || indent > scalarIndent) return;
      scalarIndent = -1;
    }
    const r = line.match(BLOCK_SCALAR);
    if (r) {
      scalarIndent = r[1].length;
      return;
    }
    if (/^\s*#/.test(line)) return;
    const m = line.match(LINE);
    if (m) block.push({ n: i + 1, value: m[2], comment: m[3] ?? "" });
    else if (ANY_USES.test(line)) other.push({ n: i + 1, line: line.trim() });
  });
  return { block, other };
}

export function check(files) {
  const errors = [];
  const pins = [];
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    let docs;
    try {
      docs = Bun.YAML.parse(text);
    } catch (e) {
      errors.push(`${file}: not valid YAML (${e.message})`);
      continue;
    }
    // (a stream of several documents parses to an array of them)
    const all = text.split("\n").some((l) => /^---\s*$/.test(l)) && Array.isArray(docs) ? docs : [docs];
    const parsed = all.flatMap(parsedUses).sort();
    const { block, other } = rawUses(text);
    for (const o of other) errors.push(`${file}:${o.n}: a uses key not in block form ("uses: ref # comment" on its own line): ${o.line}`);
    const raw = block.map((b) => b.value.replace(/^["']|["']$/g, "")).sort();
    if (JSON.stringify(parsed) !== JSON.stringify(raw))
      errors.push(`${file}: the YAML has ${parsed.length} uses, the text ${raw.length} block-form uses lines; they must be the same (${JSON.stringify(parsed)} vs ${JSON.stringify(raw)})`);
    for (const b of block) {
      const v = b.value.replace(/^["']|["']$/g, "");
      const where = `${file}:${b.n}`;
      if (v.startsWith("./")) {
        if (b.comment) errors.push(`${where}: a local action takes no comment: ${b.comment}`);
        continue;
      }
      if (v.startsWith("docker://")) {
        if (!/@sha256:[0-9a-f]{64}$/.test(v)) errors.push(`${where}: a docker:// action must be pinned by @sha256:<64 lowercase hex>: ${v}`);
        continue;
      }
      const m = v.match(/^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)((?:\/[A-Za-z0-9_.-]+)*)@(.+)$/);
      if (!m) {
        errors.push(`${where}: not owner/repo[/path]@ref: ${v}`);
        continue;
      }
      const [, repo, , ref] = m;
      if (!SHA.test(ref)) {
        errors.push(`${where}: ${repo} is not pinned to a 40-hex lowercase commit sha: @${ref}`);
        continue;
      }
      if (!COMMENT.test(b.comment)) {
        errors.push(`${where}: the pin needs exactly "# vX.Y.Z" or "# branch <name>" after it, nothing more: ${JSON.stringify(b.comment)}`);
        continue;
      }
      pins.push({ where, repo, sha: ref, comment: b.comment });
    }
  }
  const bySha = new Map();
  const byRepoComment = new Map();
  for (const p of pins) {
    const a = bySha.get(p.sha);
    if (a && a.comment !== p.comment) errors.push(`${p.where}: ${p.sha} is "${p.comment}" here but "${a.comment}" at ${a.where}`);
    else if (!a) bySha.set(p.sha, p);
    const key = `${p.repo} ${p.comment}`;
    const b = byRepoComment.get(key);
    if (b && b.sha !== p.sha) errors.push(`${p.where}: ${p.repo} "${p.comment}" is ${p.sha} here but ${b.sha} at ${b.where}`);
    else if (!b) byRepoComment.set(key, p);
  }
  return { errors, pins };
}

function verify(pins) {
  const seen = new Map();
  for (const p of pins) seen.set(`${p.repo}@${p.sha}`, p);
  let moved = 0;
  for (const p of seen.values()) {
    const ref = p.comment.startsWith("# branch ") ? p.comment.slice(9) : p.comment.slice(2);
    let now = "";
    try {
      now = execFileSync("gh", ["api", `repos/${p.repo}/commits/${ref}`, "-q", ".sha"], { encoding: "utf8" }).trim();
    } catch (e) {
      now = `(gh failed: ${e.message.split("\n")[0]})`;
    }
    const ok = now === p.sha;
    if (!ok) moved++;
    console.log(`${ok ? "ok  " : "MOVED"} ${p.repo} ${ref}: pinned ${p.sha}, now ${now}`);
  }
  return moved;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const doVerify = args[0] === "--verify";
  const files = (doVerify ? args.slice(1) : args);
  const { errors, pins } = check(files.length ? files : defaultFiles());
  for (const e of errors) console.log(`FAIL ${e}`);
  if (errors.length) process.exit(1);
  console.log(`ok: ${pins.length} pinned uses, every one at a commit with its tag or branch named`);
  if (doVerify && verify(pins)) process.exit(1);
}
