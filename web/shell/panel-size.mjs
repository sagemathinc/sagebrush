// The Terminal's size gate (plan-term-xterm r2.7 §4, daybreak2's ruling): the actual built web/dist/shell/terminal.js,
// as web/build.ts made it (CI's pinned bun), never a synthetic bundle: its raw bytes and Node's gzip -9 bytes, each
// under its own absolute ceiling.  It replaces E5.6's figure for the panel's own code, which stopped meaning anything
// once the chunk carries xterm.  Also pinned: the chunk is a lazy module of its own (index.html only names it for a
// dynamic import, at the Terminal's first open, never at first paint), the site serves the same bytes, and the CLI's
// embedded page doesn't carry it.
//   bun web/build.ts && bun web/shell/panel-size.mjs        (prints the figures; exit 1 on a failure)
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { readPage } from "../../scripts/notebook-page.mjs";

// (daybreak2 rules the ceilings from the landing measurement with CI's bun 1.4.4: PR 2 r4 (e8153082) measured 459 209 B
// raw and 127 554 B gzip -9 (Node 24.21.0's zlib); daybreak2 approved 460 600 / 127 970 on r4, headroom 1 391 / 416,
// about 0.3%.  r3's were 457 400 / 126 790 for 456 001 / 126 381.  The Terminal commands' hook (ShellHost's commands
// and size options, each command's narrow port into its run) measured 462 055 / 128 381 on master 7ebd72f4's
// 460 540 / 127 822 (+1 515 / +559); daybreak2 ruled the ceilings at that measurement + 64.  Tab staying in the
// Terminal, with Esc then Tab as the way out (the key row's too), measured 462 134 / 128 412 merged on master 760c4bdd:
// the ceilings at that measurement + 64)
// (the Terminal's more and less, the pager and its line scan: measured 466 305 / 130 005 on master f5e10d8b's
// 462 134 / 128 412 (+4 171 / +1 593, bun 1.4.4, Node 24.21.0's gzip -9); daybreak2 ruled the ceilings at that
// measurement + 64.  With no pager opened after Stop or the end during a paged command's stderr, and less's back
// keeping the replaced screen in the scrollback: 466 427 / 130 041 merged on master 06ebf6d5's 462 134 / 128 412
// (+4 293 / +1 629); the ceilings at that measurement + 64)
// (cp copying notebooks and boards, each measured, then duplicated under a snapshot: measured 467 816 / 130 499 merged on
// master 30ee6c33's 466 427 / 130 041 (+1 389 / +458); the ceilings at that measurement + 64)
// (the review page's run note and the branch store's listing by blob id, reached through the workspace: measured by
// CI 467 929 / 130 508 against 467 816 / 130 499 (+113 / +9); the ceilings at that measurement + 64)
// (help's first lines saying the Terminal is its own shell, not a full Unix system, and `cmd 2>&1` for the order of
// errors: measured 468 049 / 130 575 on master e67b0a8c's 467 929 / 130 508 (+120 / +67); the ceilings at that
// measurement + 64)
const LIMIT_RAW = 468113, LIMIT_GZIP = 130639;
const root = join(import.meta.dir, "..", "..");
const dist = join(root, "web", "dist");
const fails = [];
const chunk = join(dist, "shell", "terminal.js");
if (!existsSync(chunk)) {
  console.log("panel-size: FAIL\n  web/dist/shell/terminal.js is missing: run bun web/build.ts first");
  process.exit(1);
}
const js = readFileSync(chunk);
// (gzip by Node's zlib, level 9, as the binding figures are: this script may run under bun, whose zlib differs)
const gz = Number(execFileSync("node", ["-e", "process.stdout.write(String(require('zlib').gzipSync(require('fs').readFileSync(process.argv[1]), { level: 9 }).length))", chunk], { encoding: "utf8" }));
console.log(`panel-size: web/dist/shell/terminal.js: ${js.length} B raw (ceiling ${LIMIT_RAW}), ${gz} B gzip -9 by Node (ceiling ${LIMIT_GZIP})`);
if (js.length > LIMIT_RAW) fails.push(`${js.length} B raw is over ${LIMIT_RAW}`);
if (!(gz > 0) || gz > LIMIT_GZIP) fails.push(`${gz} B gzipped is over ${LIMIT_GZIP}`);
if (!/export\s*\{[^}]*\bopenTerminal\b/.test(js.toString("utf8"))) fails.push("the chunk doesn't export openTerminal");

// lazy: the page names the chunk only as a dynamic import's specifier, never as a script or a static import
// (the page as one file: its script, dist/sagebrush-app.js, back inline where the page names it: scripts/notebook-page.mjs)
const page = readPage(join(dist, "index.html")).toString("utf8");
if (!page.includes('"./shell/terminal.js"')) fails.push("index.html no longer names ./shell/terminal.js for its dynamic import");
if (/<script[^>]*src=["']?\.?\/?shell\/terminal\.js/.test(page) || /import\s[^;(]*from\s*["']\.?\/?shell\/terminal\.js/.test(page) || /<link[^>]*shell\/terminal\.js/.test(page))
  fails.push("index.html loads shell/terminal.js at first paint (a script, a static import or a preload)");
// the site serves the same bytes (a site build only)
const site = join(root, "web", "site", "public", "shell", "terminal.js");
if (existsSync(join(root, "web", "site", "public", "index.html"))) {
  if (!existsSync(site) || !readFileSync(site).equals(js)) fails.push("web/site/public/shell/terminal.js isn't the built chunk");
}
// the CLI's embedded page doesn't carry it (the CLI's page has no Terminal)
const webGen = join(root, "build", "cli", "web.gen.js");
if (existsSync(webGen) && /["']shell\/terminal\.js["']\s*:/.test(readFileSync(webGen, "utf8"))) fails.push("the CLI's embedded assets carry shell/terminal.js");

if (fails.length) {
  console.log("panel-size: FAIL\n  " + fails.join("\n  "));
  process.exit(1);
}
console.log("panel-size: ok");
