// The Support entry (William, Oct 31): the notebook page's ⋯ menu has one plain link to CoCalc's support form, in a new
// tab, that tells the other site nothing. No script, no query string, no user data: href, target and rel exactly.
// Checked in web/index.html, and in web/dist/index.html when a build has written it.
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

const WANT = { role: "menuitem", id: "supportlink", href: "https://cocalc.ai/support/new", target: "_blank", rel: "noopener noreferrer" };

function check(file) {
  const html = readFileSync(file, "utf8");
  const tags = html.match(/<a\b[^>]*\bid="supportlink"[^>]*>/g) ?? [];
  ok(tags.length === 1, `${file}: exactly one #supportlink (${tags.length})`);
  if (tags.length !== 1) return;
  const tag = tags[0];
  // (every attribute, by name: the expected ones exactly, plus a title, and nothing else, so no on* handler or style)
  const attrs = Object.fromEntries([...tag.matchAll(/\s([a-z-]+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));
  for (const [k, v] of Object.entries(WANT)) ok(attrs[k] === v, `${file}: #supportlink ${k}="${v}" (${JSON.stringify(attrs[k])})`);
  const extra = Object.keys(attrs).filter((k) => !(k in WANT) && k !== "title");
  ok(extra.length === 0, `${file}: #supportlink has no other attribute (${extra.join(", ")})`);
  ok(!/[?#]/.test(attrs.href ?? ""), `${file}: #supportlink's href has no query or fragment`);
  // (in the ⋯ menu, as a menu item: between its opening tag and its close)
  const menu = html.match(/<div id="moremenu"[\s\S]*?<\/div>/)?.[0] ?? "";
  ok(menu.includes(tag), `${file}: #supportlink is inside #moremenu`);
}

const pages = process.env.SUPPORT_LINK_PAGE ? [process.env.SUPPORT_LINK_PAGE] : [join(here, "index.html"), ...[join(here, "dist", "index.html")].filter(existsSync)];
for (const p of pages) check(p);
console.log(`${checks - fails.length}/${checks} passed (${pages.length} page${pages.length === 1 ? "" : "s"})`);
process.exit(fails.length ? 1 : 0);
