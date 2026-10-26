#!/usr/bin/env node
// The architecture article (articles/architecture/): its board,
// architecture.board.json, is the one source.  This script writes the
// article's pages from it, README.md and 01-the-map.md, so the plain-HTML
// article (indexable, readable without the board) always says what the
// board says, and checks the board's links:
//
//   node scripts/architecture-article.mjs --write   write the pages from the board
//   node scripts/architecture-article.mjs --check   fail if a page differs from what
//                                                   --write would write, or a link is bad
//
// Every link (a note's `ref`, or a GitHub link in any text) must be a
// permalink into this repository, github.com/sagemathinc/sagebrush/blob/<commit>/<path>,
// at ONE commit, the one named by the start note's "Last updated <date>, at
// sagebrush `<commit>`."  Each path must exist at that commit (git, no
// network), and a line anchor #La-Lb must be within the file.  When the
// commit isn't in this clone (CI's checkout is shallow), --check fetches that
// one commit (`git fetch --depth=1 origin <commit>`) and checks again; with
// --no-fetch it fails instead.  The refresh recipe is
// articles/architecture/REFRESH.txt.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
export const DIR = "articles/architecture";
export const BOARD = `${DIR}/architecture.board.json`;
export const VIEWER = `/board/?doc=/${BOARD}`;
const REPO = "https://github.com/sagemathinc/sagebrush";
const PERMALINK = /^https:\/\/github\.com\/sagemathinc\/sagebrush\/blob\/([0-9a-f]{40})\/([A-Za-z0-9._\/-]+?)(\?plain=1)?(#L(\d+)(?:-L(\d+))?|#[a-z0-9-]+)?$/;
const UPDATED = /Last updated (\d{4}-\d{2}-\d{2}), at sagebrush `([0-9a-f]{8})`\./;

const DESCRIPTION = "A map of how Sagebrush is built: the Rust engine, pyjs (Python compiled to JavaScript), the browser app, the command line, sync, sharing, the servers and the checks, each with a link to the code that shows it best.";
const DISCLOSURE = "Written by Claude Opus 5.5, an AI model made by Anthropic, from the code and design notes of the Sagebrush project, led by William Stein (SageMath, Inc.).";

/** The board's items, depth first, in page order (groups before their children). */
export function items(doc) {
  const out = [];
  const visit = (list) => {
    for (const n of list ?? []) {
      out.push(n);
      if (n.kind === "group") visit(n.children);
    }
  };
  visit(doc.nodes);
  return out;
}

/** Every string in the document (for links written in text). */
function strings(v, out = []) {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => strings(x, out));
  else if (v && typeof v === "object") Object.values(v).forEach((x) => strings(x, out));
  return out;
}

/**
 * The board's links and its pinned commit, or the problems with them.  `git(args)` runs git
 * in the repository (a parameter, for tests); `exists(commit)` says whether the commit is here.
 */
export function checkLinks(doc, git) {
  const problems = [];
  const start = items(doc).find((n) => n.id === "start");
  const updated = start && UPDATED.exec(start.text ?? "");
  if (!updated) problems.push('the start note must say "Last updated YYYY-MM-DD, at sagebrush `<8 hex>`."');
  // Every note's ref is a permalink, whatever it starts with.  In text, a link to GitHub (by its
  // parsed host, any scheme or case) must be one too; other web links are prose's business, and a
  // Markdown link target may only be a web, site-relative or in-page address (no javascript:, data:, ...).
  const links = [];
  for (const n of items(doc)) if (n.ref !== undefined) links.push({ where: `note ${n.id}`, url: String(n.ref) });
  const githubHost = (h) => /(^|\.)github\.com$|(^|\.)githubusercontent\.com$/.test(h);
  for (const s of strings(doc)) {
    for (const m of s.matchAll(/\]\(\s*<?([^)\s>]+)/g)) if (!/^(https?:\/\/|\/|#)/i.test(m[1]) && /^[a-z][a-z0-9+.-]*:/i.test(m[1])) problems.push(`text: a link to ${m[1]}: only web, site-relative or in-page links`);
    for (const m of s.matchAll(/\bjavascript:/gi)) problems.push(`text: "${m[0]}" in a note's text`);
    for (const m of s.matchAll(/\bhttps?:\/\/[^\s)"'<>\]]+/gi)) {
      let host = "";
      try { host = new URL(m[0]).hostname.toLowerCase(); } catch { problems.push(`text: ${m[0]} isn't a valid address`); continue; }
      if (githubHost(host) && !links.some((l) => l.url === m[0])) links.push({ where: "text", url: m[0] });
    }
  }
  const commits = new Set();
  const parsed = [];
  for (const l of links) {
    const m = PERMALINK.exec(l.url);
    if (!m) {
      problems.push(`${l.where}: ${l.url} is not a permalink into ${REPO} (https://github.com/sagemathinc/sagebrush/blob/<40-hex commit>/<path>)`);
      continue;
    }
    commits.add(m[1]);
    parsed.push({ ...l, commit: m[1], path: m[2], from: m[5] && Number(m[5]), to: m[5] && Number(m[6] ?? m[5]) });
  }
  if (commits.size > 1) problems.push(`the links are pinned to ${commits.size} commits (${[...commits].map((c) => c.slice(0, 8)).join(", ")}): pin them all to one`);
  const commit = [...commits][0];
  if (updated && commit && !commit.startsWith(updated[2])) problems.push(`"Last updated" names ${updated[2]}, but the links are pinned to ${commit.slice(0, 8)}`);
  let missing = false;
  if (commit && problems.length === 0) {
    try { git(["cat-file", "-e", `${commit}^{commit}`]); } catch { missing = true; }
    if (missing) problems.push(`commit ${commit} isn't in this clone (run without --no-fetch, or git fetch origin ${commit})`);
  }
  if (commit && problems.length === 0) {
    for (const l of parsed) {
      let text;
      try {
        if (git(["cat-file", "-t", `${l.commit}:${l.path}`]).trim() !== "blob") throw new Error("not a file");
        text = l.from ? git(["cat-file", "blob", `${l.commit}:${l.path}`]) : "";
      } catch {
        problems.push(`${l.where}: ${l.path} is not a file at ${l.commit.slice(0, 8)}`);
        continue;
      }
      if (l.from) {
        const lines = text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
        if (!(l.from >= 1 && l.from <= l.to && l.to <= lines)) problems.push(`${l.where}: ${l.path}#L${l.from}-L${l.to} is outside its ${lines} lines at ${l.commit.slice(0, 8)}`);
      }
    }
  }
  return { problems, commit, missing, date: updated?.[1], links: parsed.length };
}

const codeLink = (url) => {
  const m = PERMALINK.exec(url);
  const label = m ? m[2] + (m[5] ? `, lines ${m[5]}${m[6] ? "–" + m[6] : ""}` : "") : url;
  return `[\`${label}\`](${url})`;
};
const header = (title) => [`<!-- description: ${DESCRIPTION} -->`, `<!-- disclosure: ${DISCLOSURE} -->`, `<!-- (written from architecture.board.json by scripts/architecture-article.mjs: edit the board, then run it with --write) -->`, `# ${title}`, ""];

/** The article's pages, {file: text}, from the board. */
export function pages(doc, { commit, date }) {
  const stamp = `Last updated ${date}, at sagebrush [\`${commit.slice(0, 8)}\`](${REPO}/tree/${commit}).`;
  const start = items(doc).find((n) => n.id === "start");
  // (a region is a titled group of notes; untitled groups only arrange the page)
  const regions = items(doc).filter((n) => n.kind === "group" && n.title && n.children.every((c) => c.kind !== "group"));
  const loose = items(doc).filter((n) => n.kind !== "group" && n.id !== "start" && !regions.some((r) => r.children.includes(n)));
  const text = (s) => s.replace(UPDATED, "").trim();
  const map = [...header("The map"), stamp, "", `This page is the text of the [interactive board](${VIEWER}), region by region. On the board, zoom in on a note for the details shown here under it, and press Play for the reading path.`, ""];
  map.push(`## ${start.title}`, "", text(start.text), "");
  if (start.detail) map.push(start.detail, "");
  if (start.ref) map.push(`Start with ${codeLink(start.ref)}.`, "");
  for (const n of loose) map.push(`## ${n.title}`, "", n.text, "");
  for (const r of regions) {
    map.push(`## ${r.title}`, "");
    for (const n of r.children) {
      map.push(`### ${n.title}`, "", n.text, "");
      if (n.detail) map.push(n.detail, "");
      if (n.ref) map.push(`Source: ${codeLink(n.ref)}`, "");
    }
  }
  const readme = [...header("The architecture"),
    "How Sagebrush is built, as one map: the Rust engine, pyjs (Python 3.14 compiled to JavaScript), the browser app, the command line, sync, sharing, the servers, and the checks every change passes. Each part has a few short notes, and each note links to the one file that best shows its idea, pinned to a commit.",
    "",
    `**[Open the map as an interactive board](${VIEWER})**: pan, zoom in for details, and press Play for a guided tour. It works on a phone too.`,
    "",
    `1. [The map](01-the-map.md): the board's text, region by region, for reading without the board.`,
    "",
    stamp,
    "The map is refreshed when the architecture changes, and every link in it is checked against the repository at that commit.",
    ""];
  return { [`${DIR}/README.md`]: readme.join("\n"), [`${DIR}/01-the-map.md`]: map.join("\n") };
}

function main(argv) {
  const write = argv.includes("--write"), check = argv.includes("--check"), noFetch = argv.includes("--no-fetch");
  if (write === check) {
    console.error("usage: node scripts/architecture-article.mjs --write | --check [--no-fetch]");
    return 2;
  }
  const git = (args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 << 20 });
  const doc = JSON.parse(readFileSync(join(root, BOARD), "utf8"));
  let r = checkLinks(doc, git);
  if (r.missing && !noFetch) {
    console.error(`architecture-article: fetching ${r.commit.slice(0, 8)}, which this clone doesn't have`);
    execFileSync("git", ["fetch", "--quiet", "--no-tags", "--depth=1", "origin", r.commit], { cwd: root, stdio: "inherit" });
    r = checkLinks(doc, git);
  }
  if (r.problems.length) {
    for (const p of r.problems) console.error(`architecture-article: ${p}`);
    return 1;
  }
  const out = pages(doc, r);
  let stale = 0;
  for (const [file, text] of Object.entries(out)) {
    let now = null;
    try { now = readFileSync(join(root, file), "utf8"); } catch {}
    if (now === text) continue;
    if (write) writeFileSync(join(root, file), text);
    else {
      console.error(`architecture-article: ${file} differs from the board: run node scripts/architecture-article.mjs --write`);
      stale++;
    }
  }
  if (stale) return 1;
  console.log(`architecture-article: ${r.links} links at ${r.commit.slice(0, 8)}, ${write ? "pages written" : "pages match the board"}`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exitCode = main(process.argv.slice(2));
