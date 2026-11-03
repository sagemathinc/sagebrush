// ci: checks.3 order=98 runner=bun
// The editors' old example lists as a bundle carries them (web/examples/legacy.ts legacySource, web/build.ts's
// plugin): the generated module evaluates to exactly the lists read from the corpus, its texts String.raw templates
// (each backslash once, as the lists were written by hand), and rawLiteral falls back to JSON where a template
// wouldn't read back the same.
//   bun web/examples/test-examples-legacy.mjs
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { latexExamples, legacySource, notebookExamples, rawLiteral } from "./legacy.ts";

let n = 0;
const fails = [];
const check = (ok, what) => {
  n++;
  if (!ok) {
    fails.push(what);
    console.log("FAIL " + what);
  }
};
const src = legacySource();
const f = join(mkdtempSync(join(process.env.TMPDIR || tmpdir(), "examples-legacy-")), "legacy.mjs");
writeFileSync(f, src);
const gen = await import(f);
check(JSON.stringify(gen.notebookExamples()) === JSON.stringify(notebookExamples()), "the generated notebook lists equal the corpus's");
check(JSON.stringify(gen.latexExamples()) === JSON.stringify(latexExamples()), "the generated LaTeX list equals the corpus's");
check(src.includes("String.raw`\\documentclass") && !src.includes("\\\\documentclass"), "a LaTeX text is a String.raw template, its backslashes once");
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
  const dir = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "examples-legacy-b-"));
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
console.log(`${n - fails.length}/${n} passed`);
if (fails.length) process.exit(1);
