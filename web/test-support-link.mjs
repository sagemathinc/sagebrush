// The Support entry (William, Oct 31): the notebook page's ⋯ menu has one plain link to CoCalc's support form, in a new
// tab. It adds no query, fragment or page data, and rel withholds the opener and the referrer. No script. It and
// "How cells run" tell a screen reader they open in a new tab.
// The whole tag must equal one exact literal, so any other attribute, in any quoting or case (an on* handler, style,
// download), fails. Checked in web/index.html and web/dist/index.html; under CI the dist page must exist.
//   node web/test-support-link.mjs
//   SUPPORT_LINK_PAGE=<a copy of index.html> node web/test-support-link.mjs     (a control: one page only)
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
let checks = 0;
const fails = [];
const ok = (cond, what) => {
  checks++;
  if (!cond) {
    fails.push(what);
    console.log("FAIL " + what);
  }
};

const TAG =
  '<a role="menuitem" id="supportlink" href="https://cocalc.ai/support/new" target="_blank" rel="noopener noreferrer" title="Ask for help: CoCalc\'s support form, in a new tab">';

function check(file) {
  const html = readFileSync(file, "utf8");
  // (one mention of supportlink in the page, in any case, so a second or altered copy can't hide beside the exact one)
  const n = html.match(/supportlink/gi)?.length ?? 0;
  ok(n === 1, `one: ${file}: exactly one #supportlink (${n})`);
  if (n !== 1) return;
  const tag = html.match(/<a\b[^>]*supportlink[^>]*>/i)?.[0] ?? "";
  ok(tag === TAG, `exact: ${file}: #supportlink is the exact tag (${JSON.stringify(tag)})`);
  // (in the ⋯ menu, as a menu item: between its opening tag and its close)
  const menu = html.match(/<div id="moremenu"[\s\S]*?<\/div>/)?.[0] ?? "";
  ok(tag !== "" && menu.includes(tag), `inside: ${file}: #supportlink is inside #moremenu`);
  // (the menu's two external links say so to a screen reader, in the page's own visually hidden .sr class; the visible
  // label is unchanged: @sagebrush, Oct 31)
  for (const [id, label] of [["supportlink", "Support ↗"], ["howruns", "How cells run ↗"]]) {
    const body = html.match(new RegExp(`<a\\b[^>]*id="${id}"[^>]*>([\\s\\S]*?)</a>`))?.[1] ?? null;
    ok(body === `${label}<span class="sr"> (opens in a new tab)</span>`, `new-tab: ${file}: #${id} reads "${label}" and, to a screen reader, "(opens in a new tab)" (${JSON.stringify(body)})`);
  }
  ok(/^\s*\.sr \{ position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset\(50%\); white-space: nowrap; \}$/m.test(html), `sr-class: ${file}: the .sr class is the visually hidden one`);
}

let pages;
if (process.env.SUPPORT_LINK_PAGE) pages = [process.env.SUPPORT_LINK_PAGE];
else {
  const dist = join(here, "dist", "index.html");
  // (CI builds the page before this test: a missing dist page there is a failure, not a skip)
  if (process.env.CI) ok(existsSync(dist), `dist: ${dist} exists under CI`);
  pages = [join(here, "index.html"), ...[dist].filter(existsSync)];
}
for (const p of pages) check(p);
console.log(`${checks - fails.length}/${checks} passed (${pages.length} page${pages.length === 1 ? "" : "s"})`);
process.exit(fails.length ? 1 : 0);
