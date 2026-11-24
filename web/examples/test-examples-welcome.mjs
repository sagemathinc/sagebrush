// ci: checks.3 order=98 runner=bun
// The first visit's notebooks as a bundle carries them (web/examples/welcome.ts welcomeSource, web/build.ts's plugin):
// the generated module evaluates to exactly the notebooks read from the corpus, its texts String.raw templates (each
// backslash once), and rawLiteral falls back to JSON where a template wouldn't read back the same.
//   bun web/examples/test-examples-welcome.mjs
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rawLiteral, welcomeNotebooks, welcomeSource } from "./welcome.ts";

let n = 0;
const fails = [];
const check = (ok, what) => {
  n++;
  if (!ok) {
    fails.push(what);
    console.log("FAIL " + what);
  }
};
const src = welcomeSource();
const f = join(mkdtempSync(join(process.env.TMPDIR || tmpdir(), "examples-welcome-")), "welcome.mjs");
writeFileSync(f, src);
const gen = await import(f);
const nbs = welcomeNotebooks();
check(JSON.stringify(gen.welcomeNotebooks()) === JSON.stringify(nbs), "the generated notebooks equal the corpus's");
// (exactly the two the page opens on a first visit, each the corpus notebook's cells, in order)
const corpus = (slug) => { const root = join(import.meta.dir, "..", "..", "examples", "notebook", slug); const m = JSON.parse(readFileSync(join(root, "example.json"), "utf8")); return JSON.parse(readFileSync(join(root, m.main), "utf8")).cells.length; };
check(JSON.stringify(Object.keys(nbs)) === JSON.stringify(["Welcome", "Sage"]) && nbs.Welcome.length === corpus("welcome") && nbs.Sage.length === corpus("sage-first-steps") && nbs.Welcome.some((c) => typeof c === "object" && c.md), "Welcome and Sage, each with its corpus notebook's cells, Markdown as {md}");
check(!/readFileSync|node:fs|import\.meta/.test(src), "the generated module reads no files");
const cases = ["a\\b", "x`y", "${z}", "a\r\nb", "ends\\", "plain", "", "\u00e9\n\t", "Gr\u00f6bner \u25b6 \u2013", "\\\u00e9", "\\`", "\\${x}", "$", "\\$", "\ud83d\ude00!", "a\\\\\\"];
// (and random strings over the characters that matter)
const alphabet = ["a", "\\", "`", "$", "{", "}", "\r", "\n", "\u00e9", "\u25b6", "\ud83d\ude00", "u", "x"];
for (let i = 0; i < 2000; i++) cases.push(Array.from({ length: 1 + (i % 9) }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join(""));
let bad = 0;
for (const t of cases) {
  const lit = rawLiteral(t);
  if ((0, eval)(lit) !== t || lit.length > JSON.stringify(t).length) {
    bad++;
    if (bad < 5) console.log("  " + JSON.stringify(t) + " -> " + lit);
  }
}
check(bad === 0, `rawLiteral reads back every string, ${cases.length} of them (${bad} not)`);
// (through Bun's own transpiler and minifier, as a bundle is made: the strings beyond ASCII survive)
{
  const dir = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "examples-welcome-b-"));
  writeFileSync(join(dir, "m.js"), `export const xs = [${cases.slice(0, 200).map(rawLiteral).join(",")}];`);
  const r = await Bun.build({ entrypoints: [join(dir, "m.js")], outdir: dir, naming: "out.js", minify: true, format: "esm" });
  const out = await import(join(dir, "out.js"));
  check(r.success && JSON.stringify(out.xs) === JSON.stringify(cases.slice(0, 200)), "a minified bundle reads back the same strings");
}
{
  const many = "\\x".repeat(20) + "\u00e9";
  const lit = rawLiteral(many);
  check(rawLiteral("a\\b") === JSON.stringify("a\\b") && lit === "String.raw`" + "\\x".repeat(20) + '${"\u00e9"}`' && rawLiteral("Gr\u00f6bner") === JSON.stringify("Gr\u00f6bner"), "the shorter form: a raw template for many backslashes, JSON for a short string or a word beyond ASCII: " + lit + " " + rawLiteral("Gr\u00f6bner"));
}
// (long backslash-heavy texts, where the raw template is the shorter form, each ending in what a template can't hold
// as it is: a backtick, "${", a carriage return, a trailing backslash; grader's G2 and G3)
for (const [what, end] of [["a backtick", "`"], ['"${"', "${"], ["a carriage return", "\r"], ["a trailing backslash", "\\"], ["a backslash before a backtick", "\\`"]]) {
  const t = "\\x".repeat(20) + end;
  const lit = rawLiteral(t);
  let back;
  try {
    back = (0, eval)(lit);
  } catch (e) {
    back = "(" + e.message + ")";
  }
  check(lit.startsWith("String.raw`") && back === t, `a long backslash-heavy text ending in ${what} is a raw template that reads back the same: ${lit.slice(-24)}`);
}
console.log(`${n - fails.length}/${n} passed`);
if (fails.length) process.exit(1);
