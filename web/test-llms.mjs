// llms.txt and the board format page (web/llms.txt, web/board-format.md), as
// built into web/site/public by `bun web/build.ts`:
// - every https://sagebrush.space/ link names a file the site serves, and a
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

// a path on the site, as the files the site serves
function served(path) {
  const p = decodeURIComponent(path.replace(/[?#].*$/, ""));
  // the atlas's pages are rendered by the site's Worker (web/site/src/index.ts)
  if (p === "/atlas" || p.startsWith("/atlas/")) return existsSync(join(pub, "atlas", "llms.txt"));
  if (p === "" || p === "/") return existsSync(join(pub, "index.html"));
  if (p.endsWith("/")) return existsSync(join(pub, p, "index.html"));
  return existsSync(join(pub, p)) || existsSync(join(pub, p, "index.html"));
}

if (!hasSite) console.log("site absent: llms.txt and board-format.md are not checked in the site");
else for (const file of ["llms.txt", "board-format.md"]) {
  check(existsSync(join(pub, file)), `${file} is built into the site`);
  const text = readFileSync(join(here, file), "utf8");
  const links = new Set([...text.matchAll(/https:\/\/sagebrush\.space(\/[^\s)`"'<>]*)?/g)].map((m) => m[1] ?? "/"));
  for (const raw of links) {
    const path = raw.replace(/[.,;:]+$/, "");
    let ok = served(path);
    // a fragment on an HTML page must name an element there (not #c=... share links on the notebook)
    const frag = path.match(/^([^#?]*)#([A-Za-z][\w-]*)$/);
    if (ok && frag) {
      const f = join(pub, decodeURIComponent(frag[1]), frag[1].endsWith("/") || frag[1] === "" ? "index.html" : "");
      ok = existsSync(f) && new RegExp(`id=["']${frag[2]}["']`).test(readFileSync(f, "utf8"));
    }
    check(ok, `${file}: https://sagebrush.space${path}`);
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

if (failed) {
  console.log(`${failed} failed`);
  process.exit(1);
}
console.log("all passed");
