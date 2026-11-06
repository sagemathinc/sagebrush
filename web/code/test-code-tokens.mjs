// web/code/tokens.ts (1a): a code file's tokens join to its text exactly, in every language, whatever the text (HTML
// in it, entities, unclosed strings and comments, random characters); Python, Sage and MATLAB are the notebook's own
// colors; anything a highlighter can't give back exactly is one plain token. No browser needed.
//   bun web/code/test-code-tokens.mjs
import { tokensOf, tokensFromHtml, langOf, CODE_LANGS } from "./tokens.ts";

let checks = 0, failed = 0;
const check = (ok, what) => { checks++; if (!ok) { failed++; console.log("FAIL " + what); } };
const LANGS = ["python", "sage", "matlab", "magma", "js", "json", "text"];
const joined = (t) => t.map((x) => x[1]).join("");

const samples = [
  "",
  "x = 1\n",
  "def f(a):\n    return a ** 2  # square\n",
  "s = '<script>alert(1)</script>'\nprint(\"&amp; &lt; </span>\")\n",
  "</script><img src=x onerror=alert(1)>",
  "x = 2^10\ny = 3^^5\n",
  "% a comment\nA = [1 2; 3 4]';\ndisp('it''s')\n%{\nblock\n%}\n",
  "f := function(n) return n^2; end function;\n// c\n/* block */ \"str\"\n",
  "const a = `t ${b}`; // c\n/* open",
  "{\"a\": [1, -2.5e3, true, null], \"b\": \"x\\\"y\"}",
  "'''unclosed\nstill",
  "\"unclosed",
  "tabs\tand\r\nCRLF\r\n",
  "aé中😀b",
];
// random text: printable ASCII with quotes, brackets and < & heavy
let seed = 7;
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
const alphabet = "abc xyz019\n\t'\"`#%/*<>&;:=()[]{}^.,-\\";
for (let k = 0; k < 300; k++) {
  let s = "";
  const n = Math.floor(rnd() * 120);
  for (let i = 0; i < n; i++) s += alphabet[Math.floor(rnd() * alphabet.length)];
  samples.push(s);
}

for (const lang of LANGS) for (const s of samples) check(joined(tokensOf(s, lang)) === s, `${lang}: tokens join to the text: ${JSON.stringify(s).slice(0, 80)}`);
// highlighted where the language has a highlighter
const py = tokensOf("def f(x):\n    return 1  # c\n", "python");
check(py.some(([c, t]) => c === "hk" && t === "def") && py.some(([c]) => c === "hc") && py.some(([c, t]) => c === "hf" && t === "f"), "python: def a keyword, f a name being defined, # a comment: " + JSON.stringify(py));
const m = tokensOf("% c\nx = 'a';\n", "matlab");
check(m.some(([c]) => c === "hc") && m.some(([c]) => c === "hs"), "matlab: a comment and a string: " + JSON.stringify(m));
const mg = tokensOf("f := function(n) return n; end function; // c", "magma");
check(mg.some(([c, t]) => c === "hk" && t === "function") && mg.some(([c]) => c === "hc"), "magma: function a keyword, // a comment");
const j = tokensOf('{"a": 1, "b": true}', "json");
check(j.some(([c, t]) => c === "hs" && t === '"a"') && j.some(([c, t]) => c === "hn" && t === "1") && j.some(([c, t]) => c === "hk" && t === "true"), "json: strings, numbers, literals");
check(tokensOf("plain <b>text</b>", "text").length === 1, "text: one plain token");
// the adapter refuses anything not the highlighters' exact shape, or not giving back the source
check(tokensFromHtml('<span class="hk">def</span>\n', "def") !== null, "adapter: the highlighter's shape is read");
check(tokensFromHtml('<b>x</b>', "x") === null, "adapter: another tag is refused");
check(tokensFromHtml('<span class="hk" onclick="x">def</span>', "def") === null, "adapter: another attribute is refused");
check(tokensFromHtml("abc\n", "abd") === null, "adapter: text that doesn't give back the source is refused");
check(tokensFromHtml("a &lt;b&gt; &amp;\n", "a <b&gt; &") !== null, "adapter: only &lt; and &amp; are unescaped (the highlighters escape only those)");
// the extensions
for (const [ext, lang] of Object.entries(CODE_LANGS)) check(langOf("/a/b" + ext) === lang && langOf("/X" + ext.toUpperCase()) === lang, `langOf ${ext}`);
check(langOf("/a.ipynb") === null && langOf("/a.tex") === null && langOf("/a.md") === null && langOf("/py") === null, "langOf: notebooks, .tex, .md and names without an extension aren't the code page's");

console.log(failed ? `${failed} of ${checks} failed` : `ok: code tokens, ${checks} checks`);
process.exit(failed ? 1 : 0);
