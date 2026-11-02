import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, copyFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseFragment } from "parse5";
import { render } from "../web/markdown";
import { buildIndex, hook, MAX_DEPTH } from "../web/myst";

// Jupytext MyST notebooks (plan-myst-notebooks r3): the reader, web/notebook/myst.js, and the renderer of their
// directives and roles, web/myst, on two chapters of the pcimc book (test/myst/, CC BY-SA, with its author's
// permission) and on vectors; the numbering against what the book's own build shows (test/myst/built-book.json);
// and what the renderer writes, parsed as a browser parses it, against payloads in every place a value goes.

const dir = __dirname + "/../../test/myst/";
// (ES modules the browser loads: copies for node, in a folder that says they're modules, imported for real, as tsc
// would make import() a require; myst.js imports ./myst-head.js)
const copies = mkdtempSync(join(tmpdir(), "sb-myst-"));
writeFileSync(join(copies, "package.json"), '{"type":"module"}\n');
for (const f of ["myst.js", "myst-head.js"]) copyFileSync(__dirname + "/../../web/notebook/" + f, join(copies, f));
const copy = join(copies, "myst.js");
const load = () => new Function("u", "return import(u)")(pathToFileURL(copy).href);
let n = 0;
const newId = () => `c${n++}`;
const CHAPTERS = { "03-Number_Theory": { chapter: 3, markdown: 139 }, "09-Improving_DL": { chapter: 9, markdown: 52 } } as const;
const head = (fm: string) => `---\n${fm}\n---\n`;
const MYST_FM = "jupytext:\n  text_representation:\n    extension: .md\n    format_name: myst\nkernelspec:\n  display_name: SageMath 10.7\n  language: sage\n  name: sage-10.7";

// a chapter's Markdown cells rendered as the notebook renders them: one index, each cell with its hook
function renderAll(doc: any) {
  const md = doc.cells.filter((c: any) => c.type === "markdown");
  const idx = buildIndex(md.map((c: any) => ({ id: c.id, text: c.code })), doc.metadata.sagebrush.myst.chapter ?? 0);
  return { idx, html: md.map((c: any) => render(c.code, { myst: hook(idx, c.id) })).join("\n") };
}
const text = (s: string) => s.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ").trim();

test("R-1: the reader on two chapters: every code cell, the Markdown between, nothing lost", async () => {
  const { fromMyst, mystBody, isMystHead } = await load();
  for (const [name, want] of Object.entries(CHAPTERS)) {
    const t = readFileSync(dir + name + ".md", "utf8");
    assert.ok(isMystHead(t.slice(0, 4096)), `${name}: MyST by its first 4 KiB`);
    const doc = fromMyst(name + ".md", t, newId);
    const fences = (t.match(/^```\{code-cell\}/gm) ?? []).length;
    assert.equal(doc.cells.filter((c: any) => !c.type).length, fences, `${name}: a code cell per code-cell fence`);
    assert.equal(doc.cells.filter((c: any) => c.type === "markdown").length, want.markdown, `${name}: its Markdown cells`);
    assert.ok(doc.cells.every((c: any) => c.type || !/^```/m.test(c.code)), `${name}: no fence line inside a code cell`);
    assert.equal(doc.mode, "sage");
    assert.equal(doc.metadata.sagebrush.myst.chapter, want.chapter);
    assert.equal(doc.metadata.kernelspec.name, "sage-10.7");
    assert.equal(doc.metadata.jupytext.text_representation.format_name, "myst");
    // (the no-loss invariant: the cells and what lies between them give the body back, byte for byte)
    assert.equal(mystBody(doc), t.slice(t.indexOf("\n---", 4) + 5), `${name}: the cells give the body back`);
  }
});

test("R-1: which files are MyST (the 4 KiB rule), and the reader's edge cases", async () => {
  const { fromMyst, mystBody, isMystHead } = await load();
  const body = "# Title\n\n```{code-cell} ipython3\n1 + 1\n```\n";
  assert.ok(isMystHead(head(MYST_FM) + body), "a MyST front matter");
  assert.ok(!isMystHead("# Just Markdown\n\n```{code-cell}\n1\n```\n"), "Markdown without front matter: not MyST");
  assert.ok(!isMystHead(head("title: x") + body), "front matter without jupytext: not MyST");
  assert.ok(!isMystHead(head("jupytext:\n  text_representation:\n    format_name: markdown") + body), "another jupytext format: not MyST");
  assert.ok(!isMystHead(head(MYST_FM + "\nfiller: " + "x".repeat(4200)) + body), "front matter longer than 4 KiB: not MyST");
  assert.ok(!isMystHead("﻿" + head(MYST_FM) + body), "a byte-order mark: not MyST (line 1 must be exactly ---)");
  assert.ok(!isMystHead("# x\n" + head(MYST_FM) + body), "format_name: myst outside the front matter: not MyST");
  assert.ok(!isMystHead(head(MYST_FM).replace(/\n---\n$/, "\n") + body), "an unclosed front matter: not MyST");
  assert.throws(() => fromMyst("x.md", "# not myst\n", newId), /not a Jupytext MyST notebook/);
  // the 4 KiB rule in UTF-8 bytes, cut before decoding (astra's finding on 911e5662): the whole text and its first
  // 4096 bytes decoded, as the file browser reads them, always give the same answer
  const enc = new TextEncoder(), dec = new TextDecoder();
  const head4k = (s: string) => dec.decode(enc.encode(s).subarray(0, 4096));
  // a front matter padded so its closing "---\n" ends at exactly `bytes` UTF-8 bytes into the file
  const padded = (bytes: number, fill: string, eol = "\n") => {
    const fm = (pad: string) => ["---", ...MYST_FM.split("\n"), `title: ${pad}`, "---", ""].join(eol);
    let pad = "";
    while (enc.encode(fm(pad + fill)).length <= bytes) pad += fill;
    while (enc.encode(fm(pad + "x")).length <= bytes) pad += "x";
    const t = fm(pad);
    assert.equal(enc.encode(t).length, bytes, `the vector's front matter is ${bytes} bytes`);
    return t + "Text.\n\n```{code-cell} ipython3\n1\n```\n".replace(/\n/g, eol);
  };
  const cjk = head(MYST_FM + "\ntitle: " + "界".repeat(1500)) + body;
  assert.ok(cjk.length < 4096 && enc.encode(cjk).length > 4096, "astra's vector: under 4096 code units, over 4096 bytes");
  // (a CJK character straddling the cut: its first two bytes the head's last two, the closing line after it)
  const straddle = (() => {
    const pre = ["---", ...MYST_FM.split("\n"), "title: "].join("\n");
    const k = 4094 - enc.encode(pre).length;
    const t = pre + "x".repeat(k) + "界\n---\n" + body;
    assert.deepEqual([...enc.encode(t).subarray(4094, 4097)], [...enc.encode("界")], "the straddle vector: 界 at bytes 4094..4096");
    return t;
  })();
  for (const [what, t, want] of [
    ["a 1500-character CJK title (over 4096 bytes)", cjk, false],
    ["a front matter of 4095 bytes (ASCII)", padded(4095, "a"), true],
    ["a front matter of exactly 4096 bytes (ASCII)", padded(4096, "a"), true],
    ["a front matter of 4097 bytes (ASCII)", padded(4097, "a"), false],
    ["a front matter of 4095 bytes (CJK)", padded(4095, "界"), true],
    ["a front matter of exactly 4096 bytes (CJK)", padded(4096, "界"), true],
    ["a front matter of 4097 bytes (CJK)", padded(4097, "界"), false],
    ["a CJK character straddling the cut, the closing line after it", straddle, false],
    ["CRLF: 4095 bytes with its CRs", padded(4095, "a", "\r\n"), true],
    ["CRLF: exactly 4096 bytes with its CRs", padded(4096, "a", "\r\n"), true],
    ["CRLF: 4097 bytes with its CRs, the cut between its last \\r and \\n (under 4096 as LF)", padded(4097, "a", "\r\n"), false],
  ] as const) {
    assert.equal(isMystHead(t), want, `${what}: the whole text`);
    assert.equal(isMystHead(head4k(t)), want, `${what}: its first 4096 bytes, decoded`);
    if (want) assert.ok(fromMyst("v.md", t, newId).cells.length > 0, `${what}: read`);
    else assert.throws(() => fromMyst("v.md", t, newId), /not a Jupytext MyST notebook/, `${what}: refused by the reader too`);
  }
  // CRLF: read as LF (said in the reader), the invariant against the LF text
  const crlf = (head(MYST_FM) + body).replace(/\n/g, "\r\n");
  assert.ok(isMystHead(crlf), "CRLF front matter: MyST");
  const d0 = fromMyst("x.md", crlf, newId);
  assert.equal(mystBody(d0), body, "CRLF: the cells give the LF body back");
  // a 4-backtick code-cell fence; options as lines and as a --- block; +++ with JSON; a code-cell fence inside a directive
  const tricky = [
    "Intro text.", "", "````{code-cell} ipython3", ":tags: [hide-input, x]", "```", "inside", "```", "````", "",
    "+++ {\"jp-MarkdownHeadingCollapsed\": true}", "", "## Section", "", ":::{note}", "```{code-cell} ipython3", "not a cell", "```", ":::", "",
    "```{code-cell} ipython3", "---", "tags: shown", "---", "2 + 2", "```", "", "+++", "", "End.", "",
  ].join("\n");
  const d = fromMyst("t.md", head(MYST_FM) + tricky, newId);
  const kinds = d.cells.map((c: any) => c.type ?? "code");
  assert.deepEqual(kinds, ["markdown", "code", "markdown", "code", "markdown"], "the cells: " + kinds.join(", "));
  assert.equal(d.cells[1].code, "```\ninside\n```", "a 4-backtick fence keeps a 3-backtick fence inside");
  assert.deepEqual(d.cells[1].metadata, { tags: ["hide-input", "x"] }, "option lines as metadata");
  assert.deepEqual(d.cells[2].metadata, { "jp-MarkdownHeadingCollapsed": true }, "+++'s JSON as the next Markdown cell's metadata");
  assert.ok(d.cells[2].code.includes("not a cell"), "a code-cell fence inside a directive is Markdown");
  assert.deepEqual(d.cells[3].metadata, { tags: "shown" }, "a --- block of options as metadata");
  assert.equal(mystBody(d), tricky, "the tricky body given back byte for byte");
  // a file without +++ and without code: one Markdown cell
  const one = fromMyst("o.md", head(MYST_FM) + "Only text.\n", newId);
  assert.deepEqual(one.cells.map((c: any) => [c.type, c.code]), [["markdown", "Only text."]]);
  // the front matter's closed grammar: anchors, aliases, tags and flow collections are not understood, never run
  const odd = fromMyst("odd.md", head(MYST_FM + "\nx: &a [1, 2]\ny: *a\nz: !!python/object x\n__proto__:\n  polluted: yes") + "Text.\n", newId);
  assert.equal(odd.metadata.jupytext.text_representation.format_name, "myst");
  assert.equal(({} as any).polluted, undefined, "no prototype touched");
});

test("R-2: every directive and role the book uses is drawn; an unknown one shown as its text", () => {
  const cell = [
    ":::{prf:theorem} Long Division", ":label: th-ld", "Body with $x$.", ":::", "",
    "::::{prf:proof}", "Because.", "::::", "",
    ":::{prf:definition} Thing", ":nonumber:", "A thing.", ":::", "",
    "```{math}", ":label: eq-a", "a = b", "```", "",
    "```{math}", "c = d", "```", "",
    ":::{note}", "A note.", ":::", ":::{warning}", "W.", ":::", ":::{important}", "I.", ":::", ":::{admonition} Homework", ":class: dropdown", "Do it.", ":::", "",
    "```{table} A table", "| a | b |", "|---|---|", "| 1 | 2 |", "```", "",
    "```{figure} ./images/x.png", ":alt: a picture", "Its caption.", "```", "",
    "```{tableofcontents}", "```", "",
    "(sec-x)=", "## A Section", "",
    "See {prf:ref}`th-ld`, {prf:ref}`the theorem <th-ld>`, {prf:ref}`eq-a`, {prf:ref}`sec-x`, {prf:ref}`elsewhere`, {math}`y^2` and {eval}`A`.", "",
    ":::{weird-directive} arg", "<b>body</b>", ":::",
  ].join("\n");
  const idx = buildIndex([{ id: "a", text: cell }], 3);
  const html = render(cell, { myst: hook(idx, "a", new Map([["A", "90497"]])) });
  const has = (re: RegExp, what: string) => assert.match(html, re, what);
  has(/<aside class="myst-box myst-prf myst-theorem" role="note" aria-label="Theorem 3\.1 Long Division" data-myst-anchor="1"><p class="myst-title"><b class="myst-kind">Theorem 3\.1<\/b> \(Long Division\)<\/p>/, "a theorem: numbered, titled, anchored");
  has(/<aside class="myst-box myst-proof"[^>]*><p class="myst-title"><i>Proof\.<\/i><\/p><p>Because\.<\/p>\n<p class="myst-qed">∎<\/p><\/aside>/, "a proof, with its ∎");
  has(/<b class="myst-kind">Definition<\/b> \(Thing\)/, ":nonumber: drops the number");
  has(/<div class="myst-eq" data-myst-anchor="2"><div class="math display" data-tex="a = b">a = b<\/div><span class="myst-eqno">\(3\.1\)<\/span><\/div>/, "a labelled equation, numbered");
  has(/<div class="math display" data-tex="c = d">c = d<\/div>\n(?!<span)/, "an unlabelled equation, unnumbered");
  for (const [f, w] of [["info", "Note"], ["warning", "Warning"], ["emphasis", "Important"]]) has(new RegExp(`<aside class="myst-box myst-${f}"[^>]*><p class="myst-title"><b class="myst-kind">${w}</b></p>`), `${w}: its family, its word`);
  has(/<details class="myst-box myst-neutral myst-dropdown"><summary class="myst-title"><b class="myst-kind">Homework<\/b><\/summary>/, "an admonition with a title and :class: dropdown: a closed details");
  has(/<figure class="myst-table"><figcaption>A table<\/figcaption><table>/, "a table with its caption");
  has(/<figure class="myst-figure"><p>a picture<\/p>\n<figcaption><p>Its caption\.<\/p>/, "a figure: a relative picture isn't shown (safeImage), its alt text and caption are");
  has(/The book's table of contents: open _toc\.yml's chapters from the file browser\./, "tableofcontents: the note (P1)");
  has(/<span class="myst-target" data-myst-anchor="3"><\/span>/, "a (label)= target: an opaque anchor");
  has(/<a href="#" class="myst-ref" data-myst-ref="th-ld">Theorem 3\.1<\/a>, <a href="#" class="myst-ref" data-myst-ref="th-ld">the theorem<\/a>, <a href="#" class="myst-ref" data-myst-ref="eq-a">\(3\.1\)<\/a>, <a href="#" class="myst-ref" data-myst-ref="sec-x">A Section<\/a>/, "references: by number, by their text, an equation, a section");
  has(/<span class="myst-ref-missing">elsewhere \(in another chapter\)<\/span>/, "a reference to another chapter (P1): said");
  has(/<span class="math" data-tex="y\^2">y\^2<\/span>/, "{math} inline");
  has(/<span class="myst-eval">90497<\/span>/, "{eval}: its stored result, as text");
  has(/<div class="myst-box myst-unknown"><p class="myst-title">weird-directive<\/p><pre>:::\{weird-directive\} arg\n&lt;b&gt;body&lt;\/b&gt;\n:::<\/pre><\/div>/, "an unknown directive: shown as its text, escaped");
  // without the hook (an ordinary notebook), the same text is ordinary Markdown: no MyST markup at all
  assert.ok(!/myst-/.test(render(cell)), "no hook: nothing of MyST");
});

test("R-3: the numbering and references as the book's own build shows them", async () => {
  const { fromMyst } = await load();
  const built = JSON.parse(readFileSync(dir + "built-book.json", "utf8"));
  // (the build's typography: ' as ’; and sphinx-proof's proofs have no title paragraph)
  const norm = (s: string) => s.replace(/[’‘]/g, "'").replace(/\s+/g, " ").trim();
  for (const name of Object.keys(CHAPTERS)) {
    const b = built.chapters[name];
    const doc = fromMyst(name + ".md", readFileSync(dir + name + ".md", "utf8"), newId);
    const { html } = renderAll(doc);
    const titles = [...html.matchAll(/<(p|summary) class="myst-title">([\s\S]*?)<\/\1>/g)].map((m) => text(m[2])).filter((t) => t !== "Proof.");
    assert.deepEqual(titles, b.titles.map(norm), `${name}: every box's title, in order`);
    const eqnos = [...html.matchAll(/myst-eqno">\((.*?)\)</g)].map((m) => `(${m[1]})`);
    assert.deepEqual(eqnos, b.eqnos, `${name}: the equations' numbers`);
    const refs = [...html.matchAll(/class="myst-ref"[^>]*>([\s\S]*?)<\/a>/g)].map((m) => norm(text(m[1])));
    const theirs = new Set(b.refs.map(norm));
    assert.deepEqual(refs.filter((r) => !theirs.has(r)), [], `${name}: every reference reads as the book's does`);
    assert.ok(refs.length > 0, `${name}: references drawn`);
  }
});

// ---- what the renderer writes, parsed as a browser parses it
const ELEMENTS = new Set("aside p b i div span a details summary figure figcaption pre code table thead tbody tr th td em strong img br hr ul ol li h1 h2 h3 h4 h5 h6 blockquote".split(" "));
const ATTRS = new Set(["class", "role", "aria-label", "data-myst-anchor", "data-myst-ref", "data-tex", "href", "src", "alt", "title", "style", "data-lang", "align"]);
const CLASS = /^(myst-[a-z-]+|math|display|code)$/;
function problems(html: string): string[] {
  const out: string[] = [];
  const walk = (nd: any) => {
    if (nd.tagName) {
      if (nd.namespaceURI !== "http://www.w3.org/1999/xhtml" || !ELEMENTS.has(nd.tagName)) out.push(`element <${nd.tagName}>`);
      for (const a of nd.attrs ?? []) {
        if (!ATTRS.has(a.name)) out.push(`attribute ${a.name} on <${nd.tagName}>`);
        if (a.name === "class" && !a.value.split(/\s+/).every((c: string) => CLASS.test(c))) out.push(`class=${JSON.stringify(a.value)}`);
        if (a.name === "data-myst-anchor" && !/^\d+$/.test(a.value)) out.push(`anchor ${JSON.stringify(a.value)}`);
        if (a.name === "href" && a.value !== "#" && !/^(https?:|mailto:)/i.test(a.value.replace(/[\u0000- ]/g, ""))) out.push(`href=${JSON.stringify(a.value)}`);
        if (a.name === "src" && !/^(https:|data:image\/(png|jpe?g|gif|webp))/i.test(a.value)) out.push(`src=${JSON.stringify(a.value)}`);
        if (a.name === "style" && !/^(max-width: (25|50|75|100)%(; )?)?(text-align: (left|center|right))?$/.test(a.value)) out.push(`style=${JSON.stringify(a.value)}`);
      }
    }
    for (const c of nd.childNodes ?? []) walk(c);
    if (nd.content) walk(nd.content);
  };
  walk(parseFragment(html));
  return out;
}

const PAYLOADS = [`"><img src=x onerror=alert(1)>`, `'onmouseover='alert(1)`, `<script>alert(1)</script>`, `javascript:alert(1)`, `&#106;avascript:alert(1)`, `\u0000\u0007" <x>`, `__proto__`, `constructor`, `toString`];

test("R-5: payloads in every place a value goes: the output stays inert", () => {
  const cells: { id: string; text: string }[] = [];
  for (const [i, p] of PAYLOADS.entries()) {
    cells.push({ id: `p${i}`, text: [
      `:::{prf:theorem} ${p}`, `:label: ${p.replace(/\s/g, "")}`, `:class: ${p}`, `body ${p}`, ":::", "",
      `\`\`\`{math}`, `:label: m${i}${p.replace(/\s/g, "")}`, `${p}`, "```", "",
      `:::{admonition} ${p}`, `:class: dropdown ${p}`, ":::", "",
      `\`\`\`{figure} ${p}`, `:alt: ${p}`, `:width: ${p}`, `:align: ${p}`, `${p}`, "```", "",
      `\`\`\`{figure} javascript:alert(1)`, "```", "", `\`\`\`{figure} //evil.example/x.png`, "```", "", `\`\`\`{figure} data:text/html,<script>1</script>`, "```", "",
      `(${p.replace(/[\s()]/g, "")})=`, `# ${p}`, "",
      `{prf:ref}\`${p}\` {prf:ref}\`${p} <${p.replace(/[<>]/g, "")}>\` {eval}\`${p}\` {math}\`${p}\` {${"unknown"}}\`${p}\``, "",
      `:::{${"made-up"}} ${p}`, p, ":::",
    ].join("\n") });
  }
  // duplicate labels, and labels named as Object's own properties
  cells.push({ id: "dup", text: ":::{prf:lemma}\n:label: __proto__\nx\n:::\n\n:::{prf:lemma}\n:label: __proto__\ny\n:::\n\n(constructor)=\n# C\n\n(constructor)=\n# D\n\n{prf:ref}`toString`" });
  const idx = buildIndex(cells, 1);
  const evals = new Map(PAYLOADS.map((p) => [p.trim(), p]));
  const found: string[] = [];
  for (const c of cells) for (const pr of problems(render(c.text, { myst: hook(idx, c.id, evals) }))) found.push(`${c.id}: ${pr}`);
  assert.deepEqual(found, [], "nothing but the allowed elements, attributes, classes, anchors and addresses");
  // (on its own: the payloads above used __proto__ as a label first)
  const dupIdx = buildIndex([cells.at(-1)!], 1);
  const dup = render(cells.at(-1)!.text, { myst: hook(dupIdx, "dup") });
  assert.equal((dup.match(/Duplicate label: __proto__/g) ?? []).length, 1, "a second __proto__ label: said once, the first kept");
  assert.equal((dup.match(/Duplicate label: constructor/g) ?? []).length, 1, "a second constructor target: said once");
  assert.match(dup, /myst-ref-missing">toString \(in another chapter\)/, "a reference to toString: not an inherited property");
  // nesting: drawn to MAX_DEPTH, then shown as text (escaped), never deeper
  const nest = (k: number): string => (k === 0 ? `<img src=x onerror=alert(1)>` : `${":".repeat(3 + k)}{note}\n${nest(k - 1)}\n${":".repeat(3 + k)}`);
  const deep = render(nest(MAX_DEPTH + 1), { myst: hook(buildIndex([{ id: "d", text: nest(MAX_DEPTH + 1) }], 0), "d") });
  assert.deepEqual(problems(deep), [], "a nest past MAX_DEPTH: inert");
  assert.equal((deep.match(/class="myst-box myst-info"/g) ?? []).length, MAX_DEPTH, `${MAX_DEPTH} levels drawn`);
  assert.match(deep, /myst-unknown/, "...the next shown as text");
});
