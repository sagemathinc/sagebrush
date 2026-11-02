import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseFragment } from "parse5";
import { render } from "../web/markdown";
import { buildIndex, hook } from "../web/myst";
import { parseToc, buildBook, titleOf, BOUNDS, type BookCap, type Book } from "../web/myst/book";
import { badChapterName, chapterFile, resolveIn, insideOf } from "../web/workspace/book-names";

// MyST notebooks P2, the book (plan-myst-notebooks-p2 r2): the _toc.yml reader and its refusals, the bounds, the book
// index (numbers from the TOC, labels as each chapter numbers them, the I/O it does), cross-chapter references
// against the published book (test/myst/built-book-p2.json), precedence, the cache, a stopped build, the names'
// rules at their own interfaces (D1, D2, D4), and what the renderer writes for a book, parsed as a browser parses it.

const dir = __dirname + "/../../test/myst/";
const enc = (s: string) => new TextEncoder().encode(s);
// (the reader, web/notebook/myst.js, an ES module: a copy for node importing tsc's build of ./myst-head.js, as
// test/myst-notebooks.test.ts does)
const copies = mkdtempSync(join(tmpdir(), "sb-mystbook-"));
writeFileSync(join(copies, "package.json"), '{"type":"module"}\n');
const reader = readFileSync(__dirname + "/../../web/notebook/myst.js", "utf8");
writeFileSync(join(copies, "myst.js"), reader.replace('from "./myst-head.js"', `from ${JSON.stringify(pathToFileURL(__dirname + "/../web/notebook/myst-head.js").href)}`));
const load = () => new Function("u", "return import(u)")(pathToFileURL(join(copies, "myst.js")).href);
const FIXTURE = ["00-Intro", "03-Number_Theory", "07-Computing_DL", "08-CRT_Bezout", "09-Improving_DL"];
const MYST_FM = "---\njupytext:\n  text_representation:\n    extension: .md\n    format_name: myst\nkernelspec:\n  language: sage\n  name: sage-10.7\n---\n";

// A capability over files in memory, as the page's does it (web/workspace/book-cap.ts): has() by name (no content),
// read() refusing past `max` as readUpTo does; every read recorded
let books = 0;
function fakeCap(files: Map<string, Uint8Array>, self: string, book = `/book${++books}`) {
  const reads: string[] = [];
  let alive = true;
  const cap: BookCap = {
    // (each its own book: the asset's cache holds one book, keyed by it; tests don't share it unless they say so)
    book,
    self,
    live: () => alive,
    has: async (n) => files.has(n),
    read: async (n, max) => {
      reads.push(n);
      const b = files.get(n);
      if (!b) return { refused: "missing" };
      return b.length > max ? { refused: "large" } : { bytes: b };
    },
    open: async () => "opened",
    take: () => null,
  };
  return { cap, reads, kill: () => { alive = false; } };
}
const fixtureFiles = () => new Map<string, Uint8Array>([["_toc.yml", readFileSync(dir + "_toc.yml")], ...FIXTURE.map((c) => [c + ".md", readFileSync(dir + c + ".md")] as [string, Uint8Array])]);
const go = async (cap: BookCap) => buildBook(cap, new AbortController().signal);
const bookOf = (r: any): Book => { assert.ok(r && "book" in r, `a book: ${JSON.stringify(r)}`); return r.book; };

test("R-1: pcimc's _toc.yml read by the closed grammar: its root, its parts, its order", () => {
  const r = parseToc(readFileSync(dir + "_toc.yml", "utf8"));
  assert.ok("toc" in r, JSON.stringify(r));
  const t = (r as any).toc;
  assert.equal(t.root, "00-Intro");
  assert.deepEqual(t.parts.map((p: any) => [p.caption, p.numbered, p.chapters.length]), [["Chapters", true, 17], ["Endmatter", false, 1]]);
  assert.equal(t.parts[0].chapters[8], "09-Improving_DL");
  assert.deepEqual(t.parts[1].chapters, ["18-Homework"]);
  // (the other accepted forms: chapters without parts (unnumbered, as jupyter-book has them), quoted values, comments)
  const flat = parseToc('# a book\nformat: jb-book\nroot: "intro"\nchapters:\n- file: a\n  # between\n- file: \'b.md\'\n');
  assert.deepEqual(flat, { toc: { root: "intro", parts: [{ caption: "", numbered: false, chapters: ["a", "b.md"] }] } });
  const nested = parseToc("format: jb-book\nparts:\n  - caption: A\n    numbered: true\n    chapters:\n      - file: x/a\n  - chapters:\n    - file: c\n    caption: B\n");
  assert.deepEqual(nested, { toc: { root: null, parts: [{ caption: "A", numbered: true, chapters: ["x/a"] }, { caption: "B", numbered: false, chapters: ["c"] }] } });
});

test("R-1: every other TOC refused whole, before any chapter is read", async () => {
  const bad: [string, RegExp][] = [
    ["format: jb-book\nroot: x\nsections:\n- file: a\n", /isn't read/],
    ["format: jb-book\nparts:\n- caption: A\n  sections:\n  - file: a\n", /isn't read/],
    ["format: jb-book\ntitle: My book\n", /isn't read/],
    ["format: jb-article\nroot: x\n", /jb-book/],
    ["root: x\n", /format/],
    ["format: jb-book\nroot: x # a comment\n", /not a plain or quoted value/],
    ["format: jb-book\nroot: &a x\n", /not a plain or quoted value/],
    ["format: jb-book\nroot: *a\n", /not a plain or quoted value/],
    ["format: jb-book\nroot: !!str x\n", /not a plain or quoted value/],
    ["format: jb-book\nchapters: [a, b]\n", /not a plain or quoted value/],
    ["format: jb-book\nroot: {file: x}\n", /not a plain or quoted value/],
    ["format: jb-book\nroot: |\n  x\n", /not a plain or quoted value/],
    ["format: jb-book\nroot: \"a\\\"b\"\n", /not a plain or quoted value/],
    ["---\nformat: jb-book\n", /not "key: value"/],
    ["format: jb-book\nroot: x\nroot: y\n", /twice/],
    ["format: jb-book\n\troot: x\n", /a tab/],
    ["format: jb-book\nchapters:\n- file: a\n  title: A\n", /only/],
    ["format: jb-book\nchapters:\n- url: https://x\n", /file/],
    ["format: jb-book\nparts:\n- caption: A\n  numbered: 2\n", /true or false/],
    ["format: jb-book\nparts:\n- caption: A\nchapters:\n- file: a\n", /isn't read here/],
    ["format: jb-book\nchapters:\n- file: ../x\n", /dot-segment/],
    ["format: jb-book\nchapters:\n- file: /elsewhere/secret\n", /absolute/],
    ["format: jb-book\nchapters:\n- file: https://x/y\n", /scheme/],
    ["format: jb-book\nchapters:\n- file: //host/x\n", /authority/],
    ["format: jb-book\nchapters:\n- file: file:x\n", /scheme/],
    ["format: jb-book\nchapters:\n- file: a\\b\n", /absolute/],
    ["format: jb-book\nroot: a/./b\n", /dot-segment/],
  ];
  for (const [toc, why] of bad) {
    const r = parseToc(toc);
    assert.ok("refused" in r && why.test((r as any).refused), `${JSON.stringify(toc)}: refused (${why}), got ${JSON.stringify(r)}`);
    // (and through a build: the TOC read, nothing after it)
    const f = fakeCap(new Map([["_toc.yml", enc(toc)], ["a.md", enc(MYST_FM + "# A\n")]]), "a.ipynb");
    const b = await go(f.cap);
    assert.ok(b && "refused" in b, `${JSON.stringify(toc)}: the build refused`);
    assert.deepEqual(f.reads, ["_toc.yml"], `${JSON.stringify(toc)}: no read past the refusal`);
  }
});

test("D1, D2's rule at its own interface: each name refused with its reason; extensions settled", () => {
  const codes: [string, string | null][] = [
    ["07-Computing_DL", null], ["part/ch.md", null], ["a b", null],
    ["../x", "dot-segment"], ["a/../b", "dot-segment"], ["./a", "dot-segment"], ["a//b", "dot-segment"], ["a/", "dot-segment"],
    ["/elsewhere/secret", "absolute"], ["\\x", "absolute"], ["a\\b", "absolute"],
    ["//host/x", "authority"], ["\\\\host\\x", "authority"],
    ["https://x", "scheme"], ["file:x", "scheme"], ["javascript:alert(1)", "scheme"],
    ["a\u0000b", "control"], ["a\nb", "control"], ["a\u007fb", "control"],
    ["x".repeat(255), null], ["x".repeat(256), "length"], ["é".repeat(128), "length"],
    [Array(8).fill("d").join("/"), null], [Array(9).fill("d").join("/"), "segments"],
  ];
  for (const [n, want] of codes) assert.equal(badChapterName(n), want, JSON.stringify(n.slice(0, 40)));
  assert.equal(chapterFile("07-Computing_DL"), "07-Computing_DL.md");
  assert.equal(chapterFile("x/a.MD"), "x/a.MD");
  assert.equal(chapterFile("notes.txt"), null);
  assert.equal(chapterFile("ch.ipynb"), null);
  // resolveIn: the rule, the extension, normPath, the folder; D4 alone, on a resolved path
  assert.deepEqual(resolveIn("/b", "07-Computing_DL", true), { path: "/b/07-Computing_DL.md" });
  assert.deepEqual(resolveIn("/b", "_toc.yml", false), { path: "/b/_toc.yml" });
  assert.deepEqual(resolveIn("/b", "notes.txt", true), { refused: "extension" });
  assert.deepEqual(resolveIn("/b", "x.bin", false), { refused: "extension" });
  assert.deepEqual(resolveIn("/b", "/elsewhere/secret", true), { refused: "absolute" });
  assert.deepEqual(resolveIn("/b", "../x.md", false), { refused: "dot-segment" });
  assert.deepEqual(insideOf("/b", "/elsewhere/secret.md"), { refused: "outside" });
  assert.deepEqual(insideOf("/b", "/bb/x.md"), { refused: "outside" });
  assert.deepEqual(insideOf("/b", "/b/x.md"), { path: "/b/x.md" });
});

test("bounds at equality accepted, one over refused, nothing read past a refusal", async () => {
  const pad = (s: string, n: number) => s + "#".repeat(n - enc(s).length - 1) + "\n";
  // the TOC: 64 KiB / +1
  for (const [size, ok] of [[BOUNDS.toc, true], [BOUNDS.toc + 1, false]] as const) {
    const toc = pad("format: jb-book\nchapters:\n- file: a\n", size);
    assert.equal(enc(toc).length, size);
    const f = fakeCap(new Map([["_toc.yml", enc(toc)], ["a.md", enc(MYST_FM + "# A\n")]]), "a.ipynb");
    const r = await go(f.cap);
    assert.equal(!!r && "book" in r, ok, `a TOC of ${size} B`);
    assert.deepEqual(f.reads, ok ? ["_toc.yml", "a.md"] : ["_toc.yml"]);
  }
  // a scalar: 255 / 256 bytes
  assert.ok("toc" in parseToc(`format: jb-book\nroot: ${"r".repeat(255)}\n`));
  assert.ok("refused" in parseToc(`format: jb-book\nroot: ${"r".repeat(256)}\n`));
  // 8 / 9 segments
  assert.ok("toc" in parseToc(`format: jb-book\nroot: ${Array(8).fill("d").join("/")}\n`));
  assert.ok("refused" in parseToc(`format: jb-book\nroot: ${Array(9).fill("d").join("/")}\n`));
  // chapters: 200 / 201 (the root counts)
  const many = (n: number) => "format: jb-book\nroot: r\nchapters:\n" + Array.from({ length: n - 1 }, (_, i) => `- file: c${i}\n`).join("");
  assert.ok("toc" in parseToc(many(200)));
  assert.deepEqual(parseToc(many(201)), { refused: "large" });
  // a chapter: 2 MiB / +1
  for (const [size, ok] of [[BOUNDS.chapter, true], [BOUNDS.chapter + 1, false]] as const) {
    const md = pad(MYST_FM + "# A\n", size);
    const f = fakeCap(new Map([["_toc.yml", enc("format: jb-book\nchapters:\n- file: a\n- file: b\n")], ["a.md", enc(md)], ["b.md", enc(MYST_FM + "# B\n")]]), "b.ipynb");
    const r = await go(f.cap);
    assert.equal(!!r && "book" in r, ok, `a chapter of ${size} B`);
    assert.deepEqual(f.reads, ok ? ["_toc.yml", "a.md", "b.md"] : ["_toc.yml", "a.md"]);
  }
  // all chapters: 32 MiB / +1 (16 of 2 MiB, then one more byte)
  const big = enc(pad(MYST_FM + "# C\n", BOUNDS.chapter));
  for (const [extra, ok] of [[0, true], [1, false]] as const) {
    const files = new Map<string, Uint8Array>();
    let toc = "format: jb-book\nchapters:\n";
    for (let i = 0; i < 16; i++) { files.set(`c${i}.md`, big); toc += `- file: c${i}\n`; }
    if (extra) { files.set("z.md", enc("x")); toc += "- file: z\n"; }
    files.set("_toc.yml", enc(toc));
    const f = fakeCap(files, "c0.ipynb");
    const r = await go(f.cap);
    assert.equal(!!r && "book" in r, ok, `16 × 2 MiB${extra ? " + 1 B" : ""}`);
    assert.equal(f.reads.length, 1 + 16, "no read past 32 MiB");
  }
  // labels: 20,000 / 20,001
  for (const [n, ok] of [[BOUNDS.labels, true], [BOUNDS.labels + 1, false]] as const) {
    const md = MYST_FM + Array.from({ length: n }, (_, i) => `(l${i})=\n`).join("");
    const f = fakeCap(new Map([["_toc.yml", enc("format: jb-book\nchapters:\n- file: a\n")], ["a.md", enc(md)]]), "x.ipynb");
    const r = await go(f.cap);
    assert.equal(!!r && "book" in r, ok, `${n} labels`);
  }
});

test("the fixture's book: numbers by the TOC (missing chapters keep their places), its own chapter, its I/O exactly", async () => {
  const f = fakeCap(fixtureFiles(), "09-Improving_DL.ipynb");
  const book = bookOf(await go(f.cap));
  assert.deepEqual(f.reads, ["_toc.yml", "00-Intro.md", "03-Number_Theory.md", "07-Computing_DL.md", "08-CRT_Bezout.md", "09-Improving_DL.md"], "1 TOC read + 1 per present .md, in order");
  assert.deepEqual(book.chapters.map((c) => [c.entry, c.number, c.present]), [
    ["00-Intro", 0, true], ...Array.from({ length: 17 }, (_, i) => {
      const e = ["01-WhatIsCrypto", "02-Python", "03-Number_Theory", "04-Modular_Arithmetic", "05-Powers", "06-DH_and_ElGamal", "07-Computing_DL", "08-CRT_Bezout", "09-Improving_DL", "10-RSA", "11-Primality", "12-Factorization", "13-Square_Roots", "14-Quad_Sieve_Index_Calc", "15-Digital_Signatures", "16-Elliptic_Curves", "17-AES"][i];
      return [e, i + 1, FIXTURE.includes(e)];
    }), ["18-Homework", 0, false],
  ]);
  assert.equal(book.chapters[book.own].entry, "09-Improving_DL");
  // (each present chapter's number by the TOC is its name's, as P1 numbered it alone)
  for (const c of book.chapters.filter((c) => c.present)) assert.equal(c.number, +(/^(\d+)-/.exec(c.entry)![1]), c.entry);
  assert.deepEqual(book.chapters.filter((c) => c.present).map((c) => c.title), ["About this Book", "Number Theory", "Computing Discrete Logs", "The Chinese Remainder Theorem and Generalized Bezout's Lemma", "Improvements on Computations of Discrete Logs"]);
  // a rebuild: the same reads again (the cache saves indexing, not reading)
  f.reads.length = 0;
  bookOf(await go(f.cap));
  assert.equal(f.reads.length, 6);
});

// a chapter's Markdown cells rendered in its book, as the notebook renders them: [target chapter, text] of its book links
async function bookRefs(name: string, files = fixtureFiles()) {
  const { fromMyst } = await load();
  let k = 0;
  const doc = fromMyst(name + ".md", new TextDecoder().decode(files.get(name + ".md")!), () => `c${k++}`);
  const book = bookOf(await go(fakeCap(files, name + ".ipynb").cap));
  const md = doc.cells.filter((c: any) => c.type === "markdown");
  const idx = buildIndex(md.map((c: any) => ({ id: c.id, text: c.code })), book.chapters[book.own].number);
  const html = md.map((c: any) => render(c.code, { myst: hook(idx, c.id, undefined, book) })).join("\n");
  const links = [...html.matchAll(/<a href="#" class="myst-ref myst-ref-book" data-myst-ref="([^"]*)">([\s\S]*?)<\/a>/g)].map((m) => {
    const lab = m[1].replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
    return [book.chapters[book.labels.get(lab)!.chapter].entry, text(m[2])];
  });
  return { book, html, links };
}
const text = (s: string) => s.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ").trim();
const norm = (s: string) => s.replace(/[’‘]/g, "'").replace(/\s+/g, " ").trim();

test("R-3: the 10 cross-chapter references among the fixture's chapters read as the published book's, in order", async () => {
  const built = JSON.parse(readFileSync(dir + "built-book-p2.json", "utf8"));
  let all = 0;
  const want: Record<string, number> = { "00-Intro": 3, "03-Number_Theory": 0, "07-Computing_DL": 0, "08-CRT_Bezout": 1, "09-Improving_DL": 6 };
  for (const name of FIXTURE) {
    const { links } = await bookRefs(name);
    // (the published page's links to other chapters' pages, in order: ours must be among them, in that order)
    const theirs: [string, string][] = built.chapters[name].refs.filter((r: any) => r.to !== "here").map((r: any) => [r.to.replace(/\.html$/, ""), norm(r.text)]);
    let j = 0;
    for (const [to, t] of links) {
      while (j < theirs.length && !(theirs[j][0] === to && theirs[j][1] === norm(t))) j++;
      assert.ok(j < theirs.length, `${name}: "${t}" → ${to}, in the published page's order`);
      j++;
    }
    assert.equal(links.length, want[name], `${name}: its cross-chapter references into the fixture's chapters`);
    all += links.length;
  }
  assert.equal(all, 10);
});

test("{tableofcontents} in the book: a nav, an ol per part, the open chapter current, missing ones by name", async () => {
  const book = bookOf(await go(fakeCap(fixtureFiles(), "09-Improving_DL.ipynb").cap));
  const html = render("```{tableofcontents}\n```", { myst: hook(buildIndex([], 9), "x", undefined, book) });
  assert.match(html, /^<nav class="myst-toc" aria-label="Contents">/);
  const items = [...html.matchAll(/<li>([\s\S]*?)<\/li>/g)].map((m) => [/<a /.test(m[1]) ? "link" : /aria-current="page"/.test(m[1]) ? "current" : "text", text(m[1])]);
  assert.deepEqual(items[0], ["link", "About this Book"]);
  assert.deepEqual(items[3], ["link", "3 · Number Theory"]);
  assert.deepEqual(items[4], ["text", "4 · 04-Modular_Arithmetic (not in this folder)"]);
  assert.deepEqual(items[9], ["current", "9 · Improvements on Computations of Discrete Logs"]);
  assert.deepEqual(items[17], ["text", "17 · 17-AES (not in this folder)"]);
  assert.deepEqual(items[18], ["text", "18-Homework (not in this folder)"]);
  assert.equal(items.length, 19);
  assert.deepEqual([...html.matchAll(/<p class="myst-toc-part">(.*?)<\/p>/g)].map((m) => m[1]), ["Chapters", "Endmatter"]);
  // without a book: P1's note
  assert.match(render("```{tableofcontents}\n```", { myst: hook(buildIndex([], 9), "x") }), /open _toc\.yml's chapters from the file browser/);
});

test("precedence: a label in two chapters, the open one's own label, a chapter of another kind, a non-MyST chapter", async () => {
  const thm = (lab: string, title: string) => `\`\`\`{prf:theorem} ${title}\n:label: ${lab}\nBody.\n\`\`\`\n`;
  const files = new Map<string, Uint8Array>([
    ["_toc.yml", enc("format: jb-book\nparts:\n- caption: P\n  numbered: true\n  chapters:\n  - file: a\n  - file: b\n  - file: c.ipynb\n  - file: d\n  - file: e\n")],
    ["a.md", enc(MYST_FM + "# A\n" + thm("dup", "In A") + thm("onlyA", "Only A"))],
    ["b.md", enc(MYST_FM + "# B\n" + thm("dup", "In B") + thm("mine", "B's"))],
    ["c.ipynb", enc("{}")],
    ["d.md", enc("# Not MyST\n(dlab)=\n")],
    ["e.md", enc(MYST_FM + "# E\n" + thm("mine", "E's own") + "{prf:ref}`dup` {prf:ref}`mine` {prf:ref}`onlyA` {prf:ref}`dlab`\n")],
  ]);
  const f = fakeCap(files, "e.ipynb");
  const book = bookOf(await go(f.cap));
  // (c) listed, never read, no labels; (d) read, listed, not MyST, no labels
  assert.deepEqual(f.reads, ["_toc.yml", "a.md", "b.md", "d.md", "e.md"]);
  assert.deepEqual(book.chapters.map((c) => [c.entry, c.number, c.present, c.myst]), [["a", 1, true, true], ["b", 2, true, true], ["c.ipynb", 3, false, false], ["d", 4, true, false], ["e", 5, true, true]]);
  assert.equal(book.labels.has("dlab"), false);
  // (a) the first in the TOC's order, said; (b) the open notebook's own label wins
  assert.deepEqual(book.labels.get("dup"), { chapter: 0, kind: "prf:theorem", display: "Theorem 1.1" });
  assert.ok(book.dups.has("dup") && book.dups.has("mine"));
  const body = MYST_FM.length;
  const md = new TextDecoder().decode(files.get("e.md")!).slice(body);
  const idx = buildIndex([{ id: "e", text: md }], 5);
  const html = render(md, { myst: hook(idx, "e", undefined, book) });
  assert.match(html, /class="myst-ref myst-ref-book" data-myst-ref="dup">Theorem 1\.1<\/a><span class="myst-note"> \(label in two chapters\)<\/span>/);
  assert.match(html, /<a href="#" class="myst-ref" data-myst-ref="mine">Theorem 5\.1<\/a>/, "the open notebook's own, not B's");
  assert.match(html, /class="myst-ref myst-ref-book" data-myst-ref="onlyA">Theorem 1\.2<\/a>/);
  assert.match(html, /myst-ref-missing">dlab \(in another chapter\)/);
});

test("the cache: a chapter edited between builds shows its new display (keyed by its bytes, not its name)", async () => {
  const files = new Map<string, Uint8Array>([
    ["_toc.yml", enc("format: jb-book\nparts:\n- caption: P\n  numbered: true\n  chapters:\n  - file: a\n  - file: b\n")],
    ["a.md", enc(MYST_FM + "# A\n```{prf:theorem} T\n:label: x\nB.\n```\n")],
    ["b.md", enc(MYST_FM + "# B\n")],
  ]);
  const f = fakeCap(files, "b.ipynb", "/cached");
  assert.equal(bookOf(await go(f.cap)).labels.get("x")?.display, "Theorem 1.1");
  files.set("a.md", enc(MYST_FM + "# A\n```{prf:algorithm} T\n:label: x\nB.\n```\n"));
  assert.equal(bookOf(await go(f.cap)).labels.get("x")?.display, "Algorithm 1.1", "the edit seen");
});

test("g2: a build stopped between chapters (the document switched) reads nothing more and publishes nothing", async () => {
  const f = fakeCap(fixtureFiles(), "09-Improving_DL.ipynb");
  const ctl = new AbortController();
  let n = 0;
  (globalThis as any).__sbBookHold = async (phase: string) => { if (phase === "before-read" && ++n === 2) ctl.abort(); };
  try {
    const r = await buildBook(f.cap, ctl.signal);
    assert.equal(r, null, "stopped: no book");
    assert.deepEqual(f.reads, ["_toc.yml", "00-Intro.md"], "after the switch, no chapter read");
  } finally { delete (globalThis as any).__sbBookHold; }
  // (and a capability no longer live: the same)
  const g = fakeCap(fixtureFiles(), "09-Improving_DL.ipynb");
  let m = 0;
  (globalThis as any).__sbBookHold = async (phase: string) => { if (phase === "before-read" && ++m === 2) g.kill(); };
  try {
    assert.equal(await buildBook(g.cap, new AbortController().signal), null);
    assert.deepEqual(g.reads, ["_toc.yml", "00-Intro.md"]);
  } finally { delete (globalThis as any).__sbBookHold; }
});

test("titleOf: the first # heading outside fenced blocks", () => {
  assert.equal(titleOf("```{code-cell}\n# not a title\n```\n\n# The Title #\n"), "The Title");
  assert.equal(titleOf("text\n## sub\n"), "");
});

// ---- what the renderer writes for a book, parsed as a browser parses it, against payloads in the TOC and chapters
const ELEMENTS = new Set("aside p b i div span a nav ol li code".split(" "));
const ATTRS = new Set(["class", "role", "aria-label", "aria-current", "data-myst-anchor", "data-myst-ref", "data-myst-chapter", "href"]);
function problems(html: string): string[] {
  const out: string[] = [];
  const walk = (nd: any) => {
    if (nd.tagName) {
      if (!ELEMENTS.has(nd.tagName)) out.push(`element <${nd.tagName}>`);
      for (const a of nd.attrs ?? []) {
        if (!ATTRS.has(a.name)) out.push(`attribute ${a.name}`);
        if (a.name === "href" && a.value !== "#") out.push(`href=${JSON.stringify(a.value)}`);
        if (a.name === "data-myst-chapter" && !/^\d+$/.test(a.value)) out.push(`chapter ${JSON.stringify(a.value)}`);
        if (a.name === "class" && !a.value.split(/\s+/).every((c: string) => /^myst-[a-z-]+$/.test(c))) out.push(`class=${JSON.stringify(a.value)}`);
      }
    }
    for (const c of nd.childNodes ?? []) walk(c);
  };
  walk(parseFragment(html));
  return out;
}

test("R-5: payloads in a TOC's captions and names, chapters' titles and labels, drawn inert", async () => {
  const P = `"><img src=x onerror=alert(1)><script>alert(2)</script>&amp;'`;
  const files = new Map<string, Uint8Array>([
    ["_toc.yml", enc(`format: jb-book\nparts:\n- caption: '${P.replace(/'/g, "")}'\n  numbered: true\n  chapters:\n  - file: a\n  - file: '${P.replace(/['/\\]/g, "").slice(0, 60)}'\n  - file: e\n`)],
    ["a.md", enc(MYST_FM + `# ${P}\n` + "```{prf:theorem} " + P + "\n:label: __proto__\nB.\n```\n```{prf:theorem} T\n:label: constructor\nB.\n```\n```{prf:theorem} T\n:label: " + P.replace(/\s/g, "") + "\nB.\n```\n")],
    ["e.md", enc(MYST_FM + "# E\n")],
  ]);
  const book = bookOf(await go(fakeCap(files, "e.ipynb").cap));
  assert.ok(book.labels.has("__proto__") && book.labels.has("constructor"), "labels named like Object's own, as data");
  const src = "```{tableofcontents}\n```\n\n{prf:ref}`__proto__` {prf:ref}`constructor` {prf:ref}`" + P.replace(/\s/g, "").replace(/`/g, "") + "` {prf:ref}`toString`\n";
  const html = render(src, { myst: hook(buildIndex([], 3), "x", undefined, book) });
  assert.deepEqual(problems(html), []);
  assert.ok(!/<script|onerror=/i.test(html.replace(/&lt;script|onerror=alert\(1\)&gt;/g, "")), "no live script or handler");
  assert.match(html, /myst-ref-missing">toString \(in another chapter\)/, "an inherited name isn't a label");
});
