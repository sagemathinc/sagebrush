// ci: checks.3 order=61
// scripts/notebook-page.mjs: the notebook page as one file, its script (dist/sagebrush-app.js) back inline where the
// page names it. Exactly the old inline form, and refused where the page and the script don't agree: a missing script,
// one whose bytes aren't the hash the page names, and a page that names it twice. A page with no such tag is as it is.
// With a built web/dist, also the real page: back inline, it holds the script once, in its old place.
//   node scripts/test-notebook-page.mjs
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { APP_TAG, inlinePage, readPage } from "./notebook-page.mjs";

let n = 0;
const fails = [];
const check = (ok, what) => { n++; if (!ok) fails.push(what); };
const throws = (f, re) => { try { f(); return false; } catch (e) { return re.test(String(e?.message ?? e)); } };
const hash = (b) => createHash("sha256").update(b).digest("hex").slice(0, 16);

const dir = mkdtempSync(join(tmpdir(), "notebook-page-"));
try {
  const js = Buffer.from("(()=>{const a='</scr'+'ipt>';console.log(a)})();");
  writeFileSync(join(dir, "sagebrush-app.js"), js);
  const tag = `<script src="/sagebrush-app.js?h=${hash(js)}"></script>`;
  const page = `<!doctype html><html><head><style>x{}</style></head><body><p>a</p>${tag}<script>tail()</script></body></html>`;
  writeFileSync(join(dir, "index.html"), page);
  const want = page.replace(tag, `<script>${js}</script>`);
  check(readPage(join(dir, "index.html")).toString("latin1") === want, "back inline: exactly <script>…</script> in the tag's place, the rest unchanged");
  check(inlinePage(page, dir).equals(Buffer.from(want, "latin1")), "inlinePage of the text: the same bytes");
  // (a page that names no script: as it is, byte for byte)
  const plain = "<html><body><script>inline()</script></body></html>";
  check(inlinePage(Buffer.from(plain), dir).toString() === plain, "a page with no script tag: unchanged");
  // (the controls: each refused)
  check(throws(() => inlinePage(page.replace(hash(js), "0".repeat(16)), dir), /not the script the page names/), "a hash that isn't the script's: refused");
  check(throws(() => inlinePage(page.replace("</body>", tag + "</body>"), dir), /more than once/), "the script named twice: refused");
  const empty = mkdtempSync(join(tmpdir(), "notebook-page-none-"));
  try { check(throws(() => inlinePage(page, empty), /ENOENT|no such file/), "the script missing beside the page: refused"); }
  finally { rmSync(empty, { recursive: true, force: true }); }
  check(APP_TAG.test(tag) && !APP_TAG.test(tag.replace("?h=", "?x=")) && !APP_TAG.test(tag.replace(hash(js), hash(js).slice(1))), "the tag's form: /sagebrush-app.js?h= and 16 hex digits");
} finally {
  rmSync(dir, { recursive: true, force: true });
}

// (the built page, where there is one: its script named once by its hash, and, back inline, held once and whole)
const dist = new URL("../web/dist/", import.meta.url).pathname;
if (existsSync(join(dist, "sagebrush-app.js"))) {
  const html = readFileSync(join(dist, "index.html"), "latin1"), js = readFileSync(join(dist, "sagebrush-app.js"));
  const m = APP_TAG.exec(html);
  check(!!m && m[1] === hash(js), "web/dist: the page names its script by the script's hash");
  const whole = readPage(join(dist, "index.html"));
  check(whole.length === Buffer.byteLength(html, "latin1") - m[0].length + "<script></script>".length + js.length && whole.includes(js), "web/dist: back inline, the page holds the script whole, once");
  check(!/<script src="\/sagebrush-app\.js/.test(whole.toString("latin1")), "web/dist: back inline, no tag left");
}

if (fails.length) { for (const f of fails) console.log("FAIL " + f); process.exit(1); }
console.log(`${n}/${n} passed`);
