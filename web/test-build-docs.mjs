// ci: checks.3 order=97 runner=bun
// The docs' pages (web/build-docs.ts), built from web/docs into a temporary folder: /docs/ lists every section of every
// topic, with its search index; each topic's sections are anchors; every "Learn more" link in the app's sources
// (learnMore("<topic>#<id>"), web/docs-link.ts) names a page and an anchor that exist; the search, run (the page's own
// script over a stand-in DOM); words that look like markup stay text; a page's canonical and description; a section
// without an id, or an id twice, is refused; and learnMore's link: the same origin's on the site, sagebrush.space's
// in the desktop app, a new tab with noopener.
//   bun web/test-build-docs.mjs
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildDocs, renderTopic } from "./build-docs.ts";
import { docsHref, learnMore, DOCS_SITE } from "./docs-link.ts";

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
  check(/doesn't include TimeTravel, old file versions, Trash, or this device's settings/.test(storage) && /Sagebrush clears only caches it can fetch or compute again/.test(storage) && /deletes what sync keeps on the server/.test(storage), "docs/storage: export exclusions, cache-only clearing, and deleting synced data");
  check(/Data files: the contents of files such as CSV tables and images sync between your devices/.test(storage), "docs/storage: data-file contents sync between devices");
  check(/Notebook cells: only their code and text sync/.test(storage) && /Cell outputs aren't included in notebook sync, TimeTravel, or a push to GitHub/.test(storage), "docs/storage: notebook outputs stay out of notebook sync, TimeTravel and GitHub pushes");
  check(/Saving an output as a separate data file makes it part of data-file sync/.test(storage) && !/Outputs never leave this browser/.test(storage), "docs/storage: an output saved as a data file can sync; no blanket output-locality claim");
  // (the old-sync advice, a data-loss warning, now one click from the panel: the docs' #sync-off keeps both its step and
  // its warning, sync-client's N1 on d0f1a3e6)
  const syncOff = /When sync is off in this browser#? ([\s\S]*?)$/.exec(storage)?.[1] ?? "";
  check(/clear this site's data in your browser's settings/.test(syncOff) && /Export everything first/.test(syncOff) && /clearing site data deletes this browser's copy of your files/.test(syncOff), "docs/storage#sync-off: how to use sync again, and to export everything first, because clearing site data deletes this browser's copy");
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
      else if (/\.(ts|mts|js|html)$/.test(e.name) && !e.name.startsWith("test-")) {
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

  // ---- the search itself, run: the built index's own inline script over a small stand-in DOM (its list items, the box,
  // "Nothing matches.", the address), the grader's X1-X6, X19 on d0f1a3e6
  {
    const s2 = tmp();
    writeFileSync(join(s2, "alpha.md"), "# Alpha\n\n## Sync off {#both}\n\nWhen sync is off here.\n\n## Sync only {#one}\n\nAbout sync.\n\n## Quiet {#body}\n\nA TimeTravel zebra lives only in this text.\n");
    const o3 = tmp();
    buildDocs(o3, s2);
    const html = readFileSync(join(o3, "docs", "index.html"), "utf8");
    const script = /<script>\n([\s\S]*?)<\/script>/.exec(html)?.[1] ?? "";
    const json = /<script type="application\/json" id="docs-index">([\s\S]*?)<\/script>/.exec(html)[1];
    const page = (href) => {
      const items = [...html.matchAll(/<li>/g)].map(() => ({ hidden: false }));
      const listeners = [];
      const q = { value: "", addEventListener: (type, f) => { if (type === "input") listeners.push(f); } };
      const none = { hidden: true };
      const loc = { href };
      const document = { getElementById: (id) => (id === "docs-index" ? { textContent: json } : id === "q" ? q : id === "none" ? none : null), querySelectorAll: (sel) => (sel === "ul.toc li" ? items : []) };
      const history = { replaceState: (_s, _t, u) => { loc.href = String(u); } };
      new Function("document", "location", "history", script)(document, loc, history);
      const type = (v) => { q.value = v; for (const f of listeners) f(); };
      const shown = () => items.map((li, i) => (li.hidden ? null : JSON.parse(json)[i].id)).filter(Boolean);
      return { q, none, loc, type, shown, items };
    };
    check(script.length > 0 && JSON.parse(json).length === 3, "(the index's inline script and its three sections)");
    const t = page("https://sagebrush.space/docs/");
    check(JSON.stringify(t.shown()) === JSON.stringify(["both", "one", "body"]) && t.none.hidden, "with no query, every section is shown and \"Nothing matches.\" hidden");
    t.type("sync off");
    check(JSON.stringify(t.shown()) === JSON.stringify(["both"]), "two words: only the section with both (not the one with only \"sync\"): " + JSON.stringify(t.shown()));
    t.type("SYNC");
    check(JSON.stringify(t.shown()) === JSON.stringify(["both", "one"]), "an upper-case query matches regardless of case: " + JSON.stringify(t.shown()));
    t.type("zebra");
    check(JSON.stringify(t.shown()) === JSON.stringify(["body"]), "a word only in a section's text finds it: " + JSON.stringify(t.shown()));
    t.type("timetravel");
    check(JSON.stringify(t.shown()) === JSON.stringify(["body"]), "a lower-case query finds a capitalized word (TimeTravel) in a section's text: the words searched are lower-cased too: " + JSON.stringify(t.shown()));
    t.type("zebra");
    check(new URL(t.loc.href).searchParams.get("q") === "zebra", "typing keeps the query in the address (?q=): " + t.loc.href);
    t.type("nothing-like-this");
    check(t.shown().length === 0 && t.none.hidden === false, "a query matching nothing: every item hidden, \"Nothing matches.\" shown");
    t.type("");
    check(t.shown().length === 3 && t.none.hidden === true && !new URL(t.loc.href).searchParams.has("q"), "clearing it: all shown again, the message hidden, ?q= gone");
    const t2 = page("https://sagebrush.space/docs/?q=sync");
    check(t2.q.value === "sync" && JSON.stringify(t2.shown()) === JSON.stringify(["both", "one"]), "/docs/?q=sync on load: the box says sync, the list filtered: " + JSON.stringify(t2.shown()));
  }

  // ---- escaping in the index: a section whose words are </script><b>& (written as entities in its markdown) stays text,
  // and can't end the JSON block (the grader's X7, X8)
  {
    const s4 = tmp();
    writeFileSync(join(s4, "evil.md"), "# Evil\n\n## Bad &lt;/script&gt;&lt;b&gt; &amp; title {#bad}\n\nText &lt;/script&gt;&lt;b&gt; &amp; more.\n");
    const o4 = tmp();
    buildDocs(o4, s4);
    const html = readFileSync(join(o4, "docs", "index.html"), "utf8");
    const block = /<script type="application\/json" id="docs-index">([\s\S]*?)<\/script>/.exec(html)[1];
    let data = null;
    try { data = JSON.parse(block); } catch {}
    check(!!data && data[0].title === "Bad </script><b> & title" && data[0].text === "Text </script><b> & more.", "the JSON block parses whole, its words the literal characters: " + JSON.stringify(data));
    const li = /<li>([\s\S]*?)<\/li>/.exec(html)[1];
    check(li.includes("Bad &lt;/script&gt;&lt;b&gt; &amp; title") && li.includes("Text &lt;/script&gt;&lt;b&gt; &amp; more.") && !/<b>|<\/script>/.test(li), "the list item shows them as text, escaped once: " + li);
  }

  // ---- a topic page's head: its own canonical address and the description from its <!-- description: --> comment
  {
    const raw = readFileSync(join(out, "docs", "storage.html"), "utf8");
    const want = /^<!--\s*description:\s*([\s\S]*?)-->/.exec(readFileSync(join(here, "docs", "storage.md"), "utf8"))[1].replace(/\s+/g, " ").trim();
    check(raw.includes('<link rel="canonical" href="https://sagebrush.space/docs/storage">'), "a topic page's canonical address is its own (https://sagebrush.space/docs/storage)");
    check(want.length > 20 && raw.includes(`<meta name="description" content="${want.replace(/'/g, "'")}">`), "…and its description is the one its source gives: " + want);
  }

  // ---- learnMore: a link into the docs, opened in a new tab without a handle back to the app (a minimal document)
  {
    globalThis.document = { createElement: (tag) => ({ tagName: tag.toUpperCase() }) };
    globalThis.location = { protocol: "https:" };
    const a = learnMore("storage#sync");
    check(a.tagName === "A" && a.href === "/docs/storage#sync" && a.target === "_blank" && a.rel === "noopener" && a.textContent === "Learn more" && a.className === "learn", "learnMore(\"storage#sync\"): /docs/storage#sync, target _blank, rel noopener: " + JSON.stringify(a));
    delete globalThis.document;
    delete globalThis.location;
  }

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
