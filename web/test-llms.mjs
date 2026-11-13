// ci: checks.3 order=40
// llms.txt and the board format page (web/llms.txt, web/board-format.md), as
// built into web/site/public by `bun web/build.ts`:
// - every link to the site (relative, /path; or https://sagebrush.space/path, only where marked absolute) names a
//   file the site serves, and a
//   #fragment on an HTML page names an element id on it;
// - the board format page's example is a board that parses and renders.
// Run after the build: node web/test-llms.mjs
import { readFileSync, existsSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { hasSite, siteDir } from "./site-dir.mts";

const here = dirname(fileURLToPath(import.meta.url));
// (the site's built files, which web/build.ts writes only when web/site/ is here: a core-only checkout skips their
// checks, saying so; the board format page's example below is checked either way)
const pub = join(siteDir, "public");
let failed = 0;
const check = (ok, what) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failed++;
};

// /version.json (web/build.ts): what the deploy is, for agents: the core commit, the build time and ids
if (hasSite) {
  let v = null;
  try { v = JSON.parse(readFileSync(join(pub, "version.json"), "utf8")); } catch {}
  check(!!v && /^[0-9a-f]{40}$/.test(v.core ?? "") && !Number.isNaN(Date.parse(v.built)) && /^[0-9a-f]{16}$/.test(v.engine ?? "") && /^[0-9a-f]+$/.test(v.build ?? "") && typeof v.latex === "boolean" && ["shipped", "test", "off"].includes(v.latexMode),
    "version.json: the core commit, the build time, the engine's and library's ids, the LaTeX flag and mode: " + JSON.stringify(v));
  const h = readFileSync(join(pub, "_headers"), "utf8");
  check(/^\/version\.json\n  Cache-Control: no-store\n  Access-Control-Allow-Origin: \*$/m.test(h), "version.json: never cached, readable from any origin (_headers)");
}

// a path on the site, as the files the site serves
function served(path) {
  const p = decodeURIComponent(path.replace(/[?#].*$/, ""));
  // the atlas's pages are rendered by the site's Worker (web/site/src/index.ts)
  if (p === "/atlas" || p.startsWith("/atlas/")) return existsSync(join(pub, "atlas", "llms.txt"));
  if (p === "" || p === "/") return existsSync(join(pub, "index.html"));
  if (p.endsWith("/")) return existsSync(join(pub, p, "index.html"));
  // (an article's page is served at its name without .html, as the articles link it: web/build-articles.ts's url)
  return existsSync(join(pub, p)) || existsSync(join(pub, p, "index.html")) || (p.startsWith("/articles/") && existsSync(join(pub, p + ".html")));
}

if (!hasSite) console.log("site absent: llms.txt and board-format.md are not checked in the site");
else for (const file of ["llms.txt", "board-format.md"]) {
  check(existsSync(join(pub, file)), `${file} is built into the site`);
  const text = readFileSync(join(here, file), "utf8");
  // (links are relative to the site serving the file, so DEV's name DEV's files: @sagebrush, Nov 2. An absolute
  // https://sagebrush.space link stays only where another site must use it, and says so: "absolute")
  for (const line of text.split("\n")) if (/https:\/\/sagebrush\.space\//.test(line)) check(/absolute/.test(line), `${file}: an absolute sagebrush.space link says why it is absolute: ${line.slice(0, 100)}`);
  const links = new Set([
    ...[...text.matchAll(/https:\/\/sagebrush\.space(\/[^\s)`"'<>]*)?/g)].map((m) => m[1] ?? "/"),
    // (not in an HTML comment: the generated sections' markers, <!-- /fields -->)
    ...[...text.replace(/<!--[\s\S]*?-->/g, "").matchAll(/(?<=[\s(`])(\/(?!\/)[^\s)`"'<>]*)/g)].map((m) => m[1]),
  ]);
  for (const raw of links) {
    const path = raw.replace(/[.,;:]+$/, "");
    let ok = served(path);
    // a fragment on an HTML page must name an element there (not #c=... share links on the notebook)
    const frag = path.match(/^([^#?]*)#([A-Za-z][\w-]*)$/);
    if (ok && frag) {
      const f = join(pub, decodeURIComponent(frag[1]), frag[1].endsWith("/") || frag[1] === "" ? "index.html" : "");
      ok = existsSync(f) && new RegExp(`id=["']${frag[2]}["']`).test(readFileSync(f, "utf8"));
    }
    check(ok, `${file}: ${path}`);
  }
}

// the example board on the format page: valid JSON, a board, and it renders
const fmt = readFileSync(join(here, "board-format.md"), "utf8");
const m = fmt.match(/```json\n([\s\S]*?)```/);
check(!!m, "board-format.md has a JSON example");
if (m) {
  let doc = null;
  try { doc = JSON.parse(m[1]); } catch (e) { check(false, `the example parses: ${e.message}`); }
  if (doc) {
    check(doc.format === "sagebrush-board" && doc.version === 1, "the example starts with the format header");
    const dir = mkdtempSync(join(tmpdir(), "sb-llms-")), f = join(dir, "example.board.json");
    writeFileSync(f, m[1]);
    const cli = join(here, "..", "build", "cli", "pyjs.cjs");
    try {
      execFileSync("node", [cli, "board", "render", f, "-o", join(dir, "example.svg")], { stdio: "pipe" });
      check(existsSync(join(dir, "example.svg")), "the example renders (sagebrush board render)");
    } catch (e) {
      check(false, `the example renders: ${String(e.stderr || e.message).slice(0, 300)}`);
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

// `sagebrush --help` (src/cli.ts), where an agent starts: it names the examples gallery and File > Examples… (sim run 12:
// an agent never met the word), and each sagebrush.space link in it names what the site serves
{
  const help = execFileSync("node", [join(here, "..", "build", "cli", "pyjs.cjs"), "--help"], { encoding: "utf8" });
  check(/^Examples: https:\/\/sagebrush\.space\/examples\/ \(in the page: File > Examples…\)$/m.test(help), "sagebrush --help names the examples gallery and File > Examples…");
  if (hasSite) for (const m of help.matchAll(/https:\/\/sagebrush\.space(\/[^\s)`"'<>]*)/g)) check(served(m[1].replace(/[.,;:]+$/, "")), `sagebrush --help: ${m[1]}`);
}

if (failed) {
  console.log(`${failed} failed`);
  process.exit(1);
}
console.log("all passed");
