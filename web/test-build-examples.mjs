// ci: checks.3 order=96 runner=bun
// The examples gallery's pages (web/build-examples.ts, plan-examples-gallery §3, U7 PR 3), built from the fixture
// corpus (test/fixtures/examples) into a temporary folder: every page and file it writes, the catalog and the
// sitemap's URLs; the previews inert (A4: no script, no handler, an example's text escaped, its HTML sanitized, its
// images <img>s of data: URLs); a LaTeX preview's stylesheet put back only where its marker names the corpus's one
// copy (r4.1); the ZIPs readable, the same bytes as the files, the same bytes every build.
//   bun web/test-build-examples.mjs
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync, cpSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";
import { buildExamplesInto, latexPreview, notebookHtml, outputHtml, zip, esc, handlerIn, SITE_CAPS } from "./build-examples.ts";
import { sitemapXml, buildSitemap, ROBOTS } from "./build-sitemap.ts";
import { sha256, fontsMark, filesJson } from "../scripts/examples-lib.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const FIX = join(here, "..", "test", "fixtures", "examples");
let n = 0;
const fails = [];
const check = (ok, what) => {
  n++;
  if (!ok) {
    fails.push(what);
    console.log("FAIL " + what);
  }
};
const throws = (f, re, what) => {
  try {
    f();
    check(false, what + " (did not throw)");
  } catch (e) {
    check(re.test(String(e?.message ?? e)), what + ": " + e?.message);
  }
};
const walk = (d, rel = "") => readdirSync(join(d, rel)).flatMap((f) => (statSync(join(d, rel, f)).isDirectory() ? walk(d, join(rel, f)) : [join(rel, f)]));
const tmp = () => mkdtempSync(join(process.env.TMPDIR || tmpdir(), "examples-site-"));

// ---- the fixture corpus, built
const out = tmp();
const urls = await buildExamplesInto(out, FIX);
const files = walk(join(out, "examples")).sort();
const ids = ["board/hello", "latex/article", "notebook/hello-python", "notebook/sage-basics"];
for (const id of ids) {
  const slug = id.split("/")[1];
  for (const f of ["index.html", "files.json", `${slug}.zip`]) check(files.includes(join(id, f)), `${id}/${f} written`);
}
check(files.includes("latex/article/preview.html"), "the LaTeX preview is served beside its page");
for (const p of ["index.html", "index.json", "board/index.html", "latex/index.html", "notebook/index.html"]) check(files.includes(p), `${p} written`);
const pageUrls = files.filter((f) => f.endsWith("index.html")).map((f) => "/examples/" + f.replace(/index\.html$/, ""));
check(JSON.stringify(urls.map((u) => u.url).sort()) === JSON.stringify(pageUrls.sort()), "the URLs returned for the sitemap are exactly the pages written: " + JSON.stringify(urls.map((u) => u.url)));
check(sitemapXml(urls).split("<loc>").length - 1 === pageUrls.length, "the sitemap lists every page");
throws(() => sitemapXml([{ url: "/a", date: "x" }, { url: "/a", date: "x" }]), /\/a twice/, "a URL twice in the sitemap is refused");

// the catalog
const cat = JSON.parse(readFileSync(join(out, "examples", "index.json"), "utf8"));
check(cat.format === "sagebrush-examples" && cat.v === 1, "index.json's header");
check(JSON.stringify(cat.examples.map((e) => e.id)) === JSON.stringify(ids), "index.json has every example once, sorted: " + cat.examples.map((e) => e.id));
for (const e of cat.examples) {
  const fj = readFileSync(join(out, "examples", e.id, "files.json"), "utf8");
  check(e.files_sha256 === sha256(fj), `${e.id}: the catalog names its files.json by sha256`);
  check(e.url === `/examples/${e.id}/`, `${e.id}: its URL`);
}
check(cat.examples.find((e) => e.id === "notebook/sage-basics").mode === "sage", "a notebook's mode is in the catalog");

// files.json and the ZIP: the same bytes as the files (A6), the same ZIP every build
// unzip() reads a ZIP as a strict reader does, through its central directory: the end record's counts, size and
// offset; each central entry's local header at its offset (no gap, no overlap), with the same name, CRC and sizes;
// each member's CRC-32 (its own table here, not the writer's crc32.ts) over the inflated bytes.
const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (b) => {
  let c = 0xffffffff;
  for (const x of b) c = CRC[(c ^ x) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function unzip(buf) {
  const e = buf.length - 22;
  if (e < 0 || buf.readUInt32LE(e) !== 0x06054b50) throw new Error("no end record (or a comment after it)");
  const onDisk = buf.readUInt16LE(e + 8), total = buf.readUInt16LE(e + 10), cdSize = buf.readUInt32LE(e + 12), cdOff = buf.readUInt32LE(e + 16);
  if (buf.readUInt16LE(e + 4) !== 0 || buf.readUInt16LE(e + 6) !== 0 || onDisk !== total) throw new Error("the end record's disk counts");
  if (cdOff + cdSize !== e) throw new Error("the central directory doesn't end where the end record starts");
  const out = new Map();
  let c = cdOff, next = 0;
  for (let k = 0; k < total; k++) {
    if (buf.readUInt32LE(c) !== 0x02014b50) throw new Error(`central entry ${k}: no signature`);
    const method = buf.readUInt16LE(c + 10), crc = buf.readUInt32LE(c + 16), csize = buf.readUInt32LE(c + 20), usize = buf.readUInt32LE(c + 24);
    const nlen = buf.readUInt16LE(c + 28), xlen = buf.readUInt16LE(c + 30), clen = buf.readUInt16LE(c + 32), at = buf.readUInt32LE(c + 42);
    const name = buf.subarray(c + 46, c + 46 + nlen).toString("utf8");
    if (at !== next) throw new Error(`${name}: its local header is at ${at}, not ${next} (a gap or an overlap)`);
    if (buf.readUInt32LE(at) !== 0x04034b50) throw new Error(`${name}: no local header at its offset`);
    const lnlen = buf.readUInt16LE(at + 26), lxlen = buf.readUInt16LE(at + 28);
    if (buf.subarray(at + 30, at + 30 + lnlen).toString("utf8") !== name) throw new Error(`${name}: the local header names another file`);
    if (buf.readUInt16LE(at + 8) !== method || buf.readUInt32LE(at + 14) !== crc || buf.readUInt32LE(at + 18) !== csize || buf.readUInt32LE(at + 22) !== usize) throw new Error(`${name}: the local header's CRC or sizes differ from the central entry's`);
    const raw = buf.subarray(at + 30 + lnlen + lxlen, at + 30 + lnlen + lxlen + csize);
    const data = method === 8 ? inflateRawSync(raw) : method === 0 ? Buffer.from(raw) : null;
    if (!data) throw new Error(`${name}: method ${method}`);
    if (data.length !== usize) throw new Error(`${name}: ${data.length} bytes, not ${usize}`);
    if (crc32(data) !== crc) throw new Error(`${name}: CRC-32 ${crc32(data).toString(16)}, not ${crc.toString(16)}`);
    if (out.has(name)) throw new Error(`${name} twice`);
    out.set(name, data);
    next = at + 30 + lnlen + lxlen + csize;
    c += 46 + nlen + xlen + clen;
  }
  if (next !== cdOff) throw new Error(`the members end at ${next}, not at the central directory (${cdOff})`);
  if (c !== e) throw new Error(`the central directory holds more than the end record's ${total} entries`);
  return out;
}
for (const id of ids) {
  const dir = join(FIX, id);
  const m = JSON.parse(readFileSync(join(dir, "example.json"), "utf8"));
  let z = new Map();
  try {
    z = unzip(readFileSync(join(out, "examples", id, `${id.split("/")[1]}.zip`)));
    check(true, `${id}: its ZIP reads through the central directory, every CRC-32 right`);
  } catch (e) {
    check(false, `${id}: its ZIP reads through the central directory, every CRC-32 right: ${e.message}`);
  }
  check(JSON.stringify([...z.keys()]) === JSON.stringify(m.files), `${id}: the ZIP has the manifest's files, in its order`);
  check(m.files.every((f) => z.get(f)?.equals(readFileSync(join(dir, f)))), `${id}: the ZIP's bytes are the files'`);
  const fj = JSON.parse(readFileSync(join(out, "examples", id, "files.json"), "utf8"));
  check(fj.id === id && JSON.stringify(fj.files) === JSON.stringify(filesJson(dir, m).files), `${id}: files.json is the files' sizes and hashes`);
}
const out2 = tmp();
await buildExamplesInto(out2, FIX);
check(files.every((f) => readFileSync(join(out, "examples", f)).equals(readFileSync(join(out2, "examples", f)))), "two builds write the same bytes, every file");

// ---- inert pages (A4)
const pages = files.filter((f) => f.endsWith(".html")).map((f) => [f, readFileSync(join(out, "examples", f), "utf8")]);
for (const [f, h] of pages) {
  const scripts = [...h.matchAll(/<script\b[^>]*>/gi)].map((m) => m[0]);
  check(scripts.every((s) => s === '<script type="application/ld+json">' || s === '<script src="/alpha-banner.js" defer>'), `${f}: no script but its JSON-LD and the site's notice: ${scripts}`);
  check(!handlerIn(h), `${f}: no event handler`);
}
const lp = readFileSync(join(out, "examples", "latex", "article", "index.html"), "utf8");
check(/<iframe class="latex" src="preview\.html" sandbox="" /.test(lp), "a LaTeX preview is framed with sandbox=\"\" (nothing allowed)");
const nbp = readFileSync(join(out, "examples", "notebook", "hello-python", "index.html"), "utf8");
check(/<img class="out-img" src="data:image\/svg\+xml;base64,/.test(nbp), "a notebook's SVG output is an <img> of a data: URL");

check(handlerIn('<p><img src="x" onerror="a()"></p>') && handlerIn("<div\nonclick='a()'>") && !handlerIn('<meta content="x onerror=y">') && !handlerIn("<p>a onload=b</p>"), "the handler check reads attribute names, not values or text");
// one output at a time: escaped, sanitized, images as data: URLs
const evil = "<script>alert(1)</script><img src=x onerror=alert(2)>";
check(outputHtml({ output_type: "stream", name: "stdout", text: evil }) === `<pre class="out">${esc(evil)}</pre>`, "a stream is text, escaped");
const html = outputHtml({ output_type: "display_data", data: { "text/html": evil + '<a href="javascript:alert(3)">x</a><b>ok</b>' } });
check(!/<script|onerror|javascript:/i.test(html) && html.includes("<b>ok</b>"), "text/html goes through the sanitizer: " + html);
const svg = outputHtml({ output_type: "display_data", data: { "image/svg+xml": `<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>`, "text/plain": '"><script>' } });
check(/^<img class="out-img" src="data:image\/svg\+xml;base64,[A-Za-z0-9+/=]+" alt="&quot;&gt;&lt;script&gt;" /.test(svg), "an SVG with a script is only an <img>'s data: URL, its alt text escaped: " + svg.slice(0, 120));
check(outputHtml({ output_type: "display_data", data: { "image/png": "not base64!", "text/plain": "p" } }) === '<pre class="out">p</pre>', "a PNG that isn't base64 shows its text instead");
const tl = outputHtml({ output_type: "display_data", data: { "text/latex": "$$\\href{javascript:alert(1)}{x} + \\frac12$$" } });
check(!/javascript:/i.test(tl.replace(/\\href\{javascript:alert\(1\)\}/g, "")) && !/<a /.test(tl), "text/latex by KaTeX, trust: false: no link: " + tl.slice(0, 160));
const md = notebookHtml({ cells: [{ cell_type: "markdown", source: `# T\n\n${evil}\n\n[a](javascript:alert(4)) ![p](https://example.com/x.png) $x^2$` }] });
check(!/<script|onerror|javascript:|example\.com/i.test(md) && md.includes("<h1>T</h1>") && md.includes('class="katex"'), "Markdown: its HTML sanitized, a javascript: link and a remote picture dropped, math typeset: " + md.slice(0, 200));
const code = notebookHtml({ cells: [{ cell_type: "code", source: evil, outputs: [] }] });
check(code.includes(esc(evil)) && !code.includes("<script>"), "code is text, escaped");

// ---- the LaTeX preview's stylesheet (r4.1): put back only where the marker names the corpus's one copy
const css = "@font-face{font-display:block;font-family:KaTeX_X}.katex{}";
const committed = `<!doctype html>${fontsMark(sha256(css))}<p>doc</p>`;
check(latexPreview(committed, css) === `<!doctype html><style>${css}</style><p>doc</p>`, "the stylesheet goes back exactly where its marker is, nothing else changed");
throws(() => latexPreview(committed, css + " "), /names .* not examples\/shared\/katex-preview\.css/, "a marker naming another stylesheet is refused");
throws(() => latexPreview(committed + fontsMark(sha256(css)), css), /2 stylesheet markers, not 1/, "two markers are refused");
throws(() => latexPreview("<p>none</p>", css), /0 stylesheet markers, not 1/, "no marker is refused");
throws(() => latexPreview(committed + "<script>x</script>", css), /holds a script/, "a preview with a script is refused");
// (and the build refuses a corpus whose preview names another stylesheet)
const bad = join(tmp(), "examples");
cpSync(FIX, bad, { recursive: true });
writeFileSync(join(bad, "shared", "katex-preview.css"), "@font-face{}");
let refused = null;
try {
  await buildExamplesInto(tmp(), bad);
} catch (e) {
  refused = String(e.message);
}
check(/marker names .* not examples\/shared\/katex-preview\.css/.test(refused ?? ""), "the build refuses a preview whose marker isn't the corpus's stylesheet: " + refused);

// ---- A4: a title closing the JSON-LD's script, and markup in a summary, in the generated page; A6: main's sha256
{
  const c = join(tmp(), "examples");
  cpSync(FIX, c, { recursive: true });
  const mf = join(c, "notebook", "hello-python", "example.json");
  const m = JSON.parse(readFileSync(mf, "utf8"));
  m.title = 'T </script><script>alert(1)</script> & "q"';
  m.summary = "<img src=x onerror=alert(2)> </ScRiPt >";
  writeFileSync(mf, JSON.stringify(m));
  const o = tmp();
  await buildExamplesInto(o, c);
  const h = readFileSync(join(o, "examples", "notebook", "hello-python", "index.html"), "utf8");
  const ld = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(h)?.[1] ?? "";
  check(!/[<>&]/.test(ld) && JSON.parse(ld).name === m.title, "the JSON-LD holds the title with <, > and & as \\u escapes, and parses back to it");
  check(([...h.matchAll(/<\/script/gi)].length === 2) && !/<script>alert/i.test(h) && !h.includes("<img src=x"), "the title and summary are escaped everywhere else in the page");
  const cat = readFileSync(join(o, "examples", "index.html"), "utf8");
  check(!/<script>alert|<img src=x/i.test(cat), "and in the lists");
  const sha = JSON.parse(readFileSync(join(o, "examples", "notebook", "hello-python", "files.json"), "utf8")).files.find((f) => f.path === m.main).sha256;
  check(h.includes(`<meta name="sagebrush-example-main" content="${m.main} sha256:${sha}">`), "the page names the sha256 of the main its preview was built from (A6)");
}

// ---- plan section 5's caps on what the site serves (the parts budgets.json's site/examples row doesn't bind alone)
check(SITE_CAPS.preview === 1048576 && SITE_CAPS.previews === 125829120 && SITE_CAPS.zips === 62914560 && SITE_CAPS.catalog === 204800, "the caps are the plan's: 1 MiB a preview, 120 MiB of previews, 60 MiB of ZIPs, 200 KiB of catalog");
for (const [cap, re] of [
  [{ ...SITE_CAPS, preview: 10000 }, /latex\/article: its preview is \d+ bytes, more than 10000/],
  [{ ...SITE_CAPS, previews: 20000 }, /the previews \(every page\) are \d+ bytes, more than 20000/],
  [{ ...SITE_CAPS, zips: 1000 }, /the ZIPs are \d+ bytes, more than 1000/],
  [{ ...SITE_CAPS, catalog: 100 }, /index\.json is \d+ bytes, more than 100/],
]) {
  let why = null;
  try {
    await buildExamplesInto(tmp(), FIX, cap);
  } catch (e) {
    why = String(e.message);
  }
  check(re.test(why ?? ""), "the build refuses a site over a cap: " + why);
}

// ---- the ZIP writer alone: empty, UTF-8 names, deterministic
const z1 = zip([{ name: "a/ü.txt", bytes: Buffer.from("hi") }, { name: "b.bin", bytes: Buffer.alloc(0) }]);
let back = new Map();
try {
  back = unzip(z1);
} catch (e) {
  check(false, "the writer's ZIP reads strictly: " + e.message);
}
check(back.get("a/ü.txt")?.toString() === "hi" && back.get("b.bin")?.length === 0, "a UTF-8 name and an empty file come back");
check(z1.equals(zip([{ name: "a/ü.txt", bytes: Buffer.from("hi") }, { name: "b.bin", bytes: Buffer.alloc(0) }])), "the same files, the same ZIP");
// (and unzip() refuses what a strict reader refuses: grader's E19-E22, each one field of z1 zeroed)
{
  const cdOff = z1.readUInt32LE(z1.length - 6), second = z1.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]), cdOff + 1);
  const e = z1.length - 22;
  for (const [zero, what, re] of [
    [(b) => b.writeUInt32LE(0, 14), "the first member's local CRC", /local header's CRC or sizes differ/],
    [(b) => b.writeUInt32LE(0, second + 42), "the second member's local-header offset", /not \d+ \(a gap or an overlap\)/],
    [(b) => b.writeUInt32LE(0, cdOff + 16), "the first member's central CRC", /local header's CRC or sizes differ/],
    [(b) => b.writeUInt16LE(0, e + 10), "the end record's total count", /disk counts/],
    [(b) => (b.writeUInt16LE(0, e + 8), b.writeUInt16LE(0, e + 10)), "both of the end record's counts", /the members end at 0, not at the central directory/],
  ]) {
    const bad = Buffer.from(z1);
    zero(bad);
    throws(() => unzip(bad), re, `a ZIP with ${what} zeroed is refused`);
  }
  const both = Buffer.from(z1);
  both.writeUInt32LE(0, 14);
  both.writeUInt32LE(0, cdOff + 16);
  throws(() => unzip(both), /CRC-32 [0-9a-f]+, not 0/, "a ZIP whose CRCs agree but are wrong is refused by the CRC-32");
}

// ---- grader's E27: a LaTeX example's main source, escaped in its page (markup in it reaches the page only as text)
{
  const c = join(tmp(), "examples");
  cpSync(FIX, c, { recursive: true });
  const hostile = "</code></pre><a href=x>link</a><form action=y><iframe src=z></iframe>";
  writeFileSync(join(c, "latex", "article", "main.tex"), readFileSync(join(c, "latex", "article", "main.tex"), "utf8") + "% " + hostile + "\n");
  const o = tmp();
  await buildExamplesInto(o, c);
  const h = readFileSync(join(o, "examples", "latex", "article", "index.html"), "utf8");
  check(h.includes(esc(hostile)) && !/<a href=x|<form|<iframe src=z/.test(h), "a LaTeX example's main source is text in its page: its </code></pre>, link, form and iframe escaped");
}

// ---- grader's S2: the sitemap the build writes lists the gallery (buildSitemap, into a folder of the test's own)
{
  const site = tmp();
  const art = [{ url: "/", date: "2026-11-05" }, { url: "/articles/a/", date: "2026-11-05" }];
  const got = await buildSitemap({ out: site, articles: () => art, examples: (o) => buildExamplesInto(o, FIX), docs: () => [] });
  const xml = readFileSync(join(site, "sitemap.xml"), "utf8");
  const locs = [...xml.matchAll(/<loc>https:\/\/sagebrush\.space([^<]*)<\/loc>/g)].map((m) => m[1]).sort();
  const want = [...art.map((u) => u.url), ...pageUrls].sort();
  check(JSON.stringify(locs) === JSON.stringify(want), "sitemap.xml lists the articles' pages and every gallery page, /examples/ too: " + locs.join(" "));
  check(got.length === want.length && /Sitemap: https:\/\/sagebrush\.space\/sitemap\.xml/.test(readFileSync(join(site, "robots.txt"), "utf8")), "buildSitemap returns those URLs and writes robots.txt naming the sitemap");
}

// ---- shares are never indexed (William, Nov 12): no share URL, nor its API's, is ever in the sitemap, and robots.txt
// blocks none of them (a fetcher robots.txt blocks never sees a share's noindex, and its link preview needs its page)
{
  const share = ["/s/abcdefghijk2", "/s/abcdefghijk2@" + "a".repeat(16), "/s/", "/api/share/c/abcdefghijk2", "/auth/login", "/c/abcdefghijk2/" + "0".repeat(64)];
  const refused = share.filter((u) => { try { sitemapXml([{ url: u, date: "2026-11-13" }]); return false; } catch (e) { return /never listed/.test(e.message); } });
  check(refused.length === share.length, "the sitemap refuses a share's page, a pinned version, /s/, the share API, sign-in and the files' paths: " + JSON.stringify(share.filter((u) => !refused.includes(u))));
  check(sitemapXml([{ url: "/sales/", date: "2026-11-13" }, { url: "/articles/s/", date: "2026-11-13" }]).includes("/sales/"), "...and only those: /sales/ and /articles/s/ are listed");
  const site = tmp();
  await buildSitemap({ out: site, articles: () => [{ url: "/", date: "2026-11-05" }], examples: async () => [], docs: () => [] });
  const robots = readFileSync(join(site, "robots.txt"), "utf8");
  check(robots === ROBOTS && !/disallow/i.test(robots) && /^User-agent: \*\nAllow: \/\n/.test(robots), "robots.txt allows everything and disallows nothing (no share path blocked): " + JSON.stringify(robots));
  // (the site as this checkout built it, where web/site/ is here)
  const built = join(here, "site", "public");
  if (existsSync(join(built, "robots.txt")) && existsSync(join(built, "sitemap.xml"))) {
    const r = readFileSync(join(built, "robots.txt"), "utf8"), x = readFileSync(join(built, "sitemap.xml"), "utf8");
    check(!/disallow/i.test(r) && ![...x.matchAll(/<loc>[^<]*<\/loc>/g)].some((m) => /<loc>https:\/\/sagebrush\.space\/(s|api|auth|c)(\/|@|<)/.test(m[0])), "the built site's robots.txt disallows nothing, and its sitemap.xml lists no share URL");
  } else console.log("(the built site's robots.txt and sitemap.xml: not built here)");
}

// ---- grader's E26: a rebuild into the same folder drops an example the corpus no longer has
{
  const c = join(tmp(), "examples");
  cpSync(FIX, c, { recursive: true });
  const o = tmp();
  await buildExamplesInto(o, c);
  check(statSync(join(o, "examples", "notebook", "sage-basics")).isDirectory(), "(the example is built once)");
  rmSync(join(c, "notebook", "sage-basics"), { recursive: true });
  await buildExamplesInto(o, c);
  const left = walk(join(o, "examples"));
  check(!left.some((f) => f.startsWith(join("notebook", "sage-basics"))) && !readFileSync(join(o, "examples", "index.json"), "utf8").includes("sage-basics"), "a rebuild drops an example removed from the corpus: no page, file or catalog entry is left");
}

console.log(`${n - fails.length}/${n} passed`);
if (fails.length) process.exit(1);
