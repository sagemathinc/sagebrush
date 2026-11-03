// ci: checks.3 order=96 runner=bun
// The examples gallery's pages (web/build-examples.ts, plan-examples-gallery §3, U7 PR 3), built from the fixture
// corpus (test/fixtures/examples) into a temporary folder: every page and file it writes, the catalog and the
// sitemap's URLs; the previews inert (A4: no script, no handler, an example's text escaped, its HTML sanitized, its
// images <img>s of data: URLs); a LaTeX preview's stylesheet put back only where its marker names the corpus's one
// copy (r4.1); the ZIPs readable, the same bytes as the files, the same bytes every build.
//   bun web/test-build-examples.mjs
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";
import { buildExamplesInto, latexPreview, notebookHtml, outputHtml, zip, esc } from "./build-examples.ts";
import { sitemapXml } from "./build-sitemap.ts";
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
function unzip(buf) {
  const out = new Map();
  let i = 0;
  while (buf.readUInt32LE(i) === 0x04034b50) {
    const csize = buf.readUInt32LE(i + 18), usize = buf.readUInt32LE(i + 22), nlen = buf.readUInt16LE(i + 26), xlen = buf.readUInt16LE(i + 28);
    const name = buf.subarray(i + 30, i + 30 + nlen).toString("utf8");
    const data = inflateRawSync(buf.subarray(i + 30 + nlen + xlen, i + 30 + nlen + xlen + csize));
    if (data.length !== usize) throw new Error(name + ": size");
    out.set(name, data);
    i += 30 + nlen + xlen + csize;
  }
  if (buf.readUInt32LE(i) !== 0x02014b50) throw new Error("no central directory after the members");
  return out;
}
for (const id of ids) {
  const dir = join(FIX, id);
  const m = JSON.parse(readFileSync(join(dir, "example.json"), "utf8"));
  const z = unzip(readFileSync(join(out, "examples", id, `${id.split("/")[1]}.zip`)));
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
  check(!/<[a-z][^>]*?\son[a-z]+\s*=/i.test(h.replace(/data:[^"]+/g, "")), `${f}: no event handler`);
}
const lp = readFileSync(join(out, "examples", "latex", "article", "index.html"), "utf8");
check(/<iframe class="latex" src="preview\.html" sandbox="" /.test(lp), "a LaTeX preview is framed with sandbox=\"\" (nothing allowed)");
const nbp = readFileSync(join(out, "examples", "notebook", "hello-python", "index.html"), "utf8");
check(/<img class="out-img" src="data:image\/svg\+xml;base64,/.test(nbp), "a notebook's SVG output is an <img> of a data: URL");

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

// ---- the ZIP writer alone: empty, UTF-8 names, deterministic
const z1 = zip([{ name: "a/ü.txt", bytes: Buffer.from("hi") }, { name: "b.bin", bytes: Buffer.alloc(0) }]);
const back = unzip(z1);
check(back.get("a/ü.txt")?.toString() === "hi" && back.get("b.bin")?.length === 0, "a UTF-8 name and an empty file come back");
check(z1.equals(zip([{ name: "a/ü.txt", bytes: Buffer.from("hi") }, { name: "b.bin", bytes: Buffer.alloc(0) }])), "the same files, the same ZIP");

console.log(`${n - fails.length}/${n} passed`);
if (fails.length) process.exit(1);
