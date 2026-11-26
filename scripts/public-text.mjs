#!/usr/bin/env node
// Check tracked text against the existing debt, not a file-wide exemption. Moving a line within its file is
// harmless; duplicating it, changing it to another offending line, or putting it in another file is new debt.
//   node scripts/public-text.mjs              reject new occurrences
//   node scripts/public-text.mjs --prune      remove resolved occurrences from the baseline; never add any
//   node scripts/public-text.mjs --init       first baseline only (refuses to overwrite one)
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PATTERN = "sagebrush-(astra|daybreak|gpu|grader|macapp)[0-9]+|astra[0-9]+|daybreak[0-9]+|" + "/home/" + "user/|/scr" + "atch/";
export const BASELINE = "scripts/public-text-allowlist.json";

export function scan(root) {
  // git grep scans tracked working-tree text, including newly staged files; ignored/untracked build outputs and
  // binaries are not repository text. The baseline is data for this check, not an exemption for any other file.
  const result = spawnSync("git", ["grep", "-I", "-n", "-z", "--no-color", "-E", PATTERN, "--", ".", `:(exclude)${BASELINE}`],
    { cwd: root, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0 && result.status !== 1) throw new Error(result.stderr || `git grep exited ${result.status}`);
  const found = new Map();
  let at = 0;
  while (at < result.stdout.length) {
    const endPath = result.stdout.indexOf("\0", at), endNumber = result.stdout.indexOf("\0", endPath + 1);
    const endLine = result.stdout.indexOf("\n", endNumber + 1);
    if (endPath < 0 || endNumber < 0 || endLine < 0) throw new Error("invalid git grep output");
    const path = result.stdout.slice(at, endPath), line = Number(result.stdout.slice(endPath + 1, endNumber));
    const hash = createHash("sha256").update(result.stdout.slice(endNumber + 1, endLine)).digest("hex");
    const key = JSON.stringify([path, hash]);
    const old = found.get(key);
    if (old) old.lines.push(line);
    else found.set(key, { path, hash, lines: [line] });
    at = endLine + 1;
  }
  return found;
}

export function readBaseline(root) {
  const data = JSON.parse(readFileSync(resolve(root, BASELINE), "utf8"));
  if (data.version !== 1 || data.pattern !== PATTERN || !Array.isArray(data.entries)) throw new Error("invalid public-text baseline header");
  const allowed = new Map();
  for (const entry of data.entries) {
    if (typeof entry.path !== "string" || !/^[a-f0-9]{64}$/.test(entry.hash) || !Number.isSafeInteger(entry.count) || entry.count < 1)
      throw new Error("invalid public-text baseline entry");
    const key = JSON.stringify([entry.path, entry.hash]);
    if (allowed.has(key)) throw new Error("duplicate public-text baseline entry");
    allowed.set(key, entry.count);
  }
  return allowed;
}

export function additions(found, allowed) {
  return [...found].flatMap(([key, entry]) => entry.lines.slice(allowed.get(key) ?? 0).map((line) => `${entry.path}:${line}`));
}

function save(root, found) {
  const entries = [...found.values()].map(({ path, hash, lines }) => ({ path, hash, count: lines.length }))
    .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : a.hash.localeCompare(b.hash));
  const header = JSON.stringify({ version: 1, pattern: PATTERN }).slice(0, -1);
  writeFileSync(resolve(root, BASELINE), `${header},\n"entries":[\n${entries.map((entry) => JSON.stringify(entry)).join(",\n")}\n]}\n`);
}

export function main(argv) {
  if (argv.length > 1 || (argv.length && !["--prune", "--init"].includes(argv[0]))) throw new Error("usage: node scripts/public-text.mjs [--prune | --init]");
  const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  const found = scan(root);
  if (argv[0] === "--init") {
    if (existsSync(resolve(root, BASELINE))) throw new Error("baseline already exists; --prune can only shrink it");
    save(root, found);
  } else {
    const extra = additions(found, readBaseline(root));
    if (extra.length) {
      console.error(`public-text: ${extra.length} new offending line occurrence(s):\n${extra.join("\n")}\nReplace reviewer handles with the role and local paths with relative examples; do not expand the baseline.`);
      return 1;
    }
    if (argv[0] === "--prune") save(root, found);
  }
  console.log(`public-text: no new debt (${[...found.values()].reduce((n, x) => n + x.lines.length, 0)} existing line occurrences in ${new Set([...found.values()].map((x) => x.path)).size} files)`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = main(process.argv.slice(2)); }
  catch (error) { console.error(`public-text: ${error.message}`); process.exitCode = 1; }
}
