// ci: checks.3 order=97 runner=bun
// The docs' pages (web/build-docs.ts), built from web/docs into a temporary folder: /docs/ lists every section of every
// topic, with its search index; each topic's sections are anchors; every "Learn more" link in the app's sources
// (learnMore("<topic>#<id>"), web/docs-link.ts) names a page and an anchor that exist; a section without an id, or an
// id twice, is refused; and docsHref is the same origin's on the site, sagebrush.space's in the desktop app.
//   bun web/test-build-docs.mjs
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildDocs, renderTopic } from "./build-docs.ts";
import { docsHref, DOCS_SITE } from "./docs-link.ts";

const here = dirname(fileURLToPath(import.meta.url));
let failures = 0;
const check = (cond, name) => { console.log((cond ? "ok   " : "FAIL ") + name); if (!cond) failures++; };
const dirs = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "sb-docs-")); dirs.push(d); return d; };

try {
  const out = tmp();
  const urls = buildDocs(out);
  const topics = readdirSync(join(here, "docs")).filter((f) => f.endsWith(".md")).map((f) => f.slice(0, -3));
  check(topics.includes("storage") && urls.length === topics.length + 1 && urls.some((u) => u.url === "/docs/"), "a page per topic, and /docs/: " + urls.map((u) => u.url).join(" "));
  const ids = {};
  for (const t of topics) {
    const html = readFileSync(join(out, "docs", t + ".html"), "utf8");
    ids[t] = [...html.matchAll(/<h2 id="([a-z0-9-]+)">/g)].map((m) => m[1]);
    check(ids[t].length > 0 && !/\{#/.test(html), `docs/${t}: its sections are anchors, the {#id}s gone from the words: ` + ids[t].join(" "));
  }
  // (what the Storage panel no longer says itself: the docs say it, under the anchors its links name)
  const storage = readFileSync(join(out, "docs", "storage.html"), "utf8").replace(/<[^>]+>/g, "").replace(/&#39;/g, "'").replace(/\s+/g, " ");
  check(/doesn't include TimeTravel, old file versions, Trash, or this device's settings/.test(storage) && /Nothing of yours is cleared without asking/.test(storage) && /Outputs never leave this browser/.test(storage) && /deletes what sync keeps on the server/.test(storage), "docs/storage says what the panel used to: what an export leaves out, what is never cleared, what sync does, what Delete deletes");
  const index = readFileSync(join(out, "docs", "index.html"), "utf8");
  const listed = [...index.matchAll(/<li><a href="\/docs\/([a-z0-9-]+)#([a-z0-9-]+)">/g)].map((m) => `${m[1]}#${m[2]}`);
  const all = Object.entries(ids).flatMap(([t, l]) => l.map((i) => `${t}#${i}`));
  check(JSON.stringify(listed.sort()) === JSON.stringify([...all].sort()), "/docs/ links every section of every topic: " + listed.length);
  const data = JSON.parse(/<script type="application\/json" id="docs-index">([\s\S]*?)<\/script>/.exec(index)[1]);
  check(data.length === all.length && data.every((s) => s.title && s.text && !/[<>]|&#?\w+;/.test(s.title + s.text)), "…and its search index: each section's words, as plain text");
  check(/<input type="search" id="q"/.test(index) && /addEventListener\("input"/.test(index), "…with the search box and its script");
  check(!/&amp;#39;|&amp;amp;/.test(index), "…its words escaped once, not twice");

  // every "Learn more" in the app's sources names a topic and an anchor the build made
  const links = [];
  (function walk(d) {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name === "dist" || e.name === "site" || e.name.startsWith(".")) continue;
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(ts|mts|js)$/.test(e.name) && !e.name.startsWith("test-")) {
        const text = readFileSync(p, "utf8"), file = p.slice(here.length + 1);
        // (learnMore("topic"), and every "topic#id" string, however it reaches learnMore: a panel's helper passes it on)
        for (const m of text.matchAll(/learnMore\("([a-z0-9-]+)"/g)) links.push({ file, topic: m[1] });
        for (const m of text.matchAll(/"([a-z0-9-]+)#([a-z0-9-]+)"/g)) if (topics.includes(m[1])) links.push({ file, topic: m[1], id: m[2] });
      }
    }
  })(here);
  const bad = links.filter((l) => !ids[l.topic] || (l.id && !ids[l.topic].includes(l.id)));
  check(links.length >= 3 && bad.length === 0, `every Learn more link (${links.length}) names a page and an anchor that exist: ` + JSON.stringify(bad));

  // refused: a section without an id; an id twice
  let threw = "";
  try { renderTopic("x", "# X\n\n## No id\n\ntext\n"); } catch (e) { threw = String(e.message); }
  check(/has no \{#id\}/.test(threw), "a section without {#id} is refused: " + threw);
  threw = "";
  try { renderTopic("x", "# X\n\n## A {#a}\n\nt\n\n## B {#a}\n\nt\n"); } catch (e) { threw = String(e.message); }
  check(/#a twice/.test(threw), "an id twice is refused: " + threw);
  // (a rebuild drops a topic that's gone)
  const src = tmp();
  writeFileSync(join(src, "one.md"), "# One\n\n## A {#a}\n\nt\n");
  writeFileSync(join(src, "two.md"), "# Two\n\n## B {#b}\n\nt\n");
  const o2 = tmp();
  buildDocs(o2, src);
  rmSync(join(src, "two.md"));
  buildDocs(o2, src);
  check(statSync(join(o2, "docs", "one.html")).isFile() && !readdirSync(join(o2, "docs")).includes("two.html"), "a rebuild drops a topic that's gone");

  // where a link goes: the same origin on the site (DEV stays on DEV), sagebrush.space in the desktop app
  check(docsHref("storage#sync", { protocol: "https:" }) === "/docs/storage#sync" && docsHref("storage", { protocol: "http:" }) === "/docs/storage", "docsHref on the site: the same origin's /docs");
  check(docsHref("storage#sync", { protocol: "tauri:" }) === `${DOCS_SITE}/docs/storage#sync`, "…in the desktop app (tauri:): sagebrush.space's");
  globalThis.__TAURI__ = {};
  check(docsHref("storage", { protocol: "http:" }) === `${DOCS_SITE}/docs/storage`, "…and in the desktop app on http://tauri.localhost (Windows): sagebrush.space's");
  delete globalThis.__TAURI__;
} catch (e) {
  check(false, "the test threw: " + (e?.stack ?? e));
} finally {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
}
if (failures) { console.log(`${failures} failed`); process.exit(1); }
console.log("all passed");
