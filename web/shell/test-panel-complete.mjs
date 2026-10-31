// web/shell/complete.ts's pure functions (plan-term-help-tab r3.1 §5: U1-U7, T-H2), each case with its own id: the
// control runs (K*) compare the exact set of failing ids.  The literal encoding (U3) is judged by just-bash's own
// parser (test/vendor/just-bash-3.6.0): the completed word must parse to ONE literal word equal to the path.
//   bun web/shell/test-panel-complete.mjs        (prints "ok   ID" / "FAIL ID :: why"; exit 1 on any FAIL)
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  SHELL_COMMANDS, BUILTINS, PANEL_COMMANDS, commandNames, compgen, tabAction, wordAt, tabWord, encodeWord, splitPath,
  commonPrefix, matches, complete, candidateBlock, BLOCK_NAMES, BLOCK_BYTES, lsColourable, colourLs,
} from "./complete.ts";

const root = join(import.meta.dir, "..", "..");
const require = createRequire(import.meta.url);
const { Bash, parse } = require(join(root, "test/vendor/just-bash-3.6.0/index.cjs"));

const fails = [];
let n = 0;
const check = (id, ok, why = "") => {
  n++;
  if (ok) console.log(`ok   ${id}`);
  else {
    fails.push(id);
    console.log(`FAIL ${id} :: ${why}`.slice(0, 400));
  }
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ---------------------------------------------------------------- U1 the word at the caret
{
  const w = (line) => wordAt(line, line.length);
  check("U1.a", same(w("ca"), { start: 0, first: true, ctx: "none", literal: "ca" }), JSON.stringify(w("ca")));
  check("U1.b", w("cat no")?.first === false && w("cat no")?.literal === "no" && w("cat no")?.start === 4, JSON.stringify(w("cat no")));
  for (const [id, line] of [["U1.c", "x; ca"], ["U1.d", "x && ca"], ["U1.e", "x || ca"], ["U1.f", "x | ca"], ["U1.g", "(ca"]])
    check(id, w(line)?.first === true && w(line)?.literal === "ca", `${line}: ${JSON.stringify(w(line))}`);
  check("U1.h", w("cat > ou")?.first === false, JSON.stringify(w("cat > ou")));
  check("U1.i", w("cat ") === null && w("cat |") === null, "after a space or an operator: no word");
  check("U1.j", same(w("cat 'my d"), { start: 4, first: false, ctx: "single", literal: "my d" }), JSON.stringify(w("cat 'my d")));
  check("U1.k", same(w('cat "a\\$b'), { start: 4, first: false, ctx: "double", literal: "a$b" }), JSON.stringify(w('cat "a\\$b')));
  check("U1.l", w("cat my\\ d")?.literal === "my d", JSON.stringify(w("cat my\\ d")));
  // (TH-C1: a caret inside a quoted word that goes on after it: a true mid-word, declined; at the line's end: completed)
  const q1 = "cat 'alpha beta'", q2 = 'cat "alpha beta"';
  check("U1.m", tabWord(q1, 10) === null && tabWord(q2, 10) === null && tabAction(q1, 10, 10, false) === "complete", "inside a quote, before its space: declined");
  check("U1.n", tabWord("cat 'alp", 8)?.literal === "alp" && tabWord('cat "alp', 8)?.literal === "alp" && tabWord("cat alp", 7)?.literal === "alp", "an open quote at the line's end, or unquoted: completed");
}

// ---------------------------------------------------------------- U2 candidates, the common prefix, the block
{
  const cs = [{ name: "notes.csv" }, { name: "notebook.ipynb" }, { name: "other" }];
  check("U2.a", same(matches(cs, "note", true).map((c) => c.name), ["notes.csv", "notebook.ipynb"]), "prefix match");
  check("U2.b", commonPrefix(["notes.csv", "notebook.ipynb"]) === "note" && commonPrefix(["a\ud83d\ude00", "a\ud83d\ude01"]) === "a", "lcp, never half a pair");
  const w = wordAt("cat note", 8);
  check("U2.c", complete("cat note", 8, w, cs) === "list", "two matches, nothing new: the list");
  const w2 = wordAt("cat no", 6);
  check("U2.d", same(complete("cat no", 6, w2, cs), { line: "cat note", caret: 8 }), JSON.stringify(complete("cat no", 6, w2, cs)));
  const many = Array.from({ length: 150 }, (_, i) => `f${String(i).padStart(3, "0")}`);
  const b = candidateBlock(many);
  check("U2.n", b.split("  ").filter((x) => /^f\d{3}$/.test(x)).length === BLOCK_NAMES && b.endsWith("…and 50 more"), b.slice(-40));
  const long = Array.from({ length: 50 }, (_, i) => `${"x".repeat(300)}${i}`);
  const kb = candidateBlock(long);
  const shownK = kb.split("  ").filter((x) => x.startsWith("x")).length;
  const bytesOf = (s) => new TextEncoder().encode(s).length;
  check("U2.k", bytesOf(kb) <= BLOCK_BYTES && shownK < 50 && kb.endsWith(`…and ${50 - shownK} more`), `${shownK} shown, ${bytesOf(kb)} bytes`);
  // (TH-C2: 34 distinct 254-byte names: the whole block, footer included, at most 8 192 bytes, and as many names as fit)
  const n34 = Array.from({ length: 34 }, (_, i) => String(i).padStart(2, "0") + "y".repeat(252));
  const b34 = candidateBlock(n34), s34 = b34.split("  ").filter((x) => x.length === 254).length;
  const more34 = (k) => n34.slice(0, k).join("  ") + `  …and ${34 - k} more`;
  check("U2.k2", bytesOf(b34) <= BLOCK_BYTES && b34.endsWith(`…and ${34 - s34} more`) && bytesOf(more34(s34 + 1)) > BLOCK_BYTES, `${s34} shown, ${bytesOf(b34)} bytes`);
  // (multibyte: names of 2-byte characters; never a cut character, the block within the cap)
  const mb = Array.from({ length: 40 }, (_, i) => "é".repeat(126) + String(i).padStart(2, "0"));
  const bm = candidateBlock(mb);
  // (the exact cap: a block of exactly BLOCK_BYTES is kept, with and without its footer, and one byte more is not;
  // a name of 2-byte characters exactly at the cap is kept whole and one character over it is left out, never cut)
  const a = "a".repeat(BLOCK_BYTES - bytesOf("  …and 1 more")), h = "b".repeat((BLOCK_BYTES - 2) / 2), e = "é".repeat(BLOCK_BYTES / 2);
  const exact = [
    [[h, h], `${h}  ${h}`], [[h, h + "b"], `${h}  …and 1 more`],
    [[a, "z".repeat(16)], `${a}  …and 1 more`], [[a + "a", "z".repeat(16)], "…and 2 more"],
    [[e], e], [[e + "é"], "…and 1 more"],
  ];
  check("U2.k4", exact.every(([n, want]) => candidateBlock(n) === want) && bytesOf(`${a}  …and 1 more`) === BLOCK_BYTES && bytesOf(e) === BLOCK_BYTES, exact.map(([n, want]) => `${candidateBlock(n) === want ? "ok" : "BAD"} ${bytesOf(candidateBlock(n))}`).join(", "));
  check("U2.k3", bytesOf(bm) <= BLOCK_BYTES && !bm.includes("\ufffd") && bm.split("  ").filter((x) => x.startsWith("é")).every((x) => mb.includes(x)), `${bytesOf(bm)} bytes`);
}

// ---------------------------------------------------------------- U3 the literal encoding, judged by just-bash's parser
const NAMES = ["plain.txt", "my dir", "a;b", "a;touch m", "it's", 'say "hi"', "back\\slash", "$(touch m)", "`touch m`", "$HOME", "*", "x!y", "#tag", "a&b|c<d>e(f)", "q$(touch m)", "r`touch m`"];
// (the parsed word's literal value, or null if any part of it isn't literal)
function literalOf(word) {
  let v = "";
  for (const p of word.parts) {
    if (p.type === "Literal" || p.type === "SingleQuoted" || p.type === "Escaped") v += p.value;
    else if (p.type === "DoubleQuoted") {
      for (const q of p.parts) {
        if (q.type !== "Literal" && q.type !== "Escaped") return null;
        v += q.value;
      }
    } else return null;
  }
  return v;
}
// (one simple command `cat WORD`: the word's literal value, or why not)
function roundTrip(line) {
  let ast;
  try {
    ast = parse(line);
  } catch (e) {
    return { why: "parse error: " + e.message };
  }
  const st = ast.statements;
  if (st.length !== 1 || st[0].pipelines.length !== 1 || st[0].pipelines[0].commands.length !== 1) return { why: "more than one command" };
  const c = st[0].pipelines[0].commands[0];
  if (c.type !== "SimpleCommand" || c.args.length !== 1 || c.redirections.length) return { why: "not one argument: " + JSON.stringify(c).slice(0, 200) };
  const v = literalOf(c.args[0]);
  return v === null ? { why: "not literal: " + JSON.stringify(c.args[0]).slice(0, 200) } : { value: v };
}
// (the first character of `name`, typed as a literal in the context)
const typed = (ch, ctx) => (ctx === "none" ? (/[A-Za-z0-9._]/.test(ch) ? ch : "\\" + ch) : ctx === "single" ? "'" + ch : '"' + ("$`\"\\".includes(ch) ? "\\" + ch : ch));
for (const [ctx, tag] of [["none", "u"], ["single", "s"], ["double", "d"]]) {
  for (const name of NAMES) {
    const line = "cat " + typed(name[0], ctx);
    const w = wordAt(line, line.length);
    const r = w && complete(line, line.length, w, [{ name }]);
    const id = `U3.${tag}:${name}`;
    if (!r || r === "list") {
      check(id, false, `no completion (${JSON.stringify(w)})`);
      continue;
    }
    const rt = roundTrip(r.line.trimEnd());
    check(id, rt.value === name && r.line.endsWith(" "), `${JSON.stringify(r.line)}: ${rt.why ?? JSON.stringify(rt.value)}`);
  }
}
// (C-1: the whole word is re-encoded, the typed prefix too: `cat "q` -> `cat "q\$(touch m)" `)
{
  const line = 'cat "q';
  const r = complete(line, line.length, wordAt(line, line.length), [{ name: "q$(touch m)" }]);
  check("U3.d:whole-word", r && r !== "list" && r.line === 'cat "q\\$(touch m)" ', JSON.stringify(r));
}
// U3.x the declines
{
  const decl = (id, line, cands) => {
    const w = wordAt(line, line.length);
    const r = w ? complete(line, line.length, w, cands) : null;
    check(id, r === null, JSON.stringify(r));
  };
  decl("U3.x:newline", "cat a", [{ name: "a\nb" }]);
  decl("U3.x:tab", "cat a", [{ name: "a\tb" }]);
  decl("U3.x:cr", "cat a", [{ name: "a\rb" }]);
  decl("U3.x:esc", "cat a", [{ name: "a\x1bb" }]);
  decl("U3.x:del", "cat a", [{ name: "a\x7fb" }]);
  for (const [k, line] of [["dollar", "cat $H"], ["backtick", "cat `x"], ["star", "cat *a"], ["question", "cat ?a"], ["bracket", "cat [a"], ["brace", "cat {a"], ["tilde", "cat ~a"], ["hash", "cat #a"]])
    decl(`U3.x:prefix-${k}`, line, [{ name: k }, { name: "a" }, { name: "x" }]);
  decl("U3.x:dash", "cat -", [{ name: "-rf" }]);
  const line = "cat ./-";
  const r = complete(line, line.length, wordAt(line, line.length), [{ name: "-rf" }]);
  check("U3.x':dot-dash", r && r !== "list" && r.line === "cat ./-rf ", JSON.stringify(r));
}

// ---------------------------------------------------------------- U4 dot-files and the top's Trash
{
  const cs = [{ name: ".hidden" }, { name: "Trash", dir: true }, { name: "Taxes", dir: true }, { name: "visible" }];
  check("U4.a", !matches(cs, "", true).some((c) => c.name === ".hidden") && matches(cs, ".", true).some((c) => c.name === ".hidden"), "dot-names only with a dot");
  check("U4.b", !matches(cs, "", true, true).some((c) => c.name === "Trash") && matches(cs, "T", true, true).some((c) => c.name === "Trash"), "the top's Trash only once typed");
  check("U4.c", matches(cs, "", true, false).some((c) => c.name === "Trash"), "a Trash elsewhere is an ordinary name");
}

// ---------------------------------------------------------------- U5 the colouriser
{
  const kinds = { "/h": { d: "folder", "nb.ipynb": "notebook", "b.board": "board", f: "file" }, "/h/d": { x: "file", y: "folder" } };
  const kindOf = (dir, name) => kinds[dir]?.[name];
  const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
  const out = "b.board\nd\nf\nnb.ipynb\nnot-there\n";
  const c = colourLs(out, "/h", false, () => null, kindOf);
  check("U5.a", c.includes("\x1b[1;34md\x1b[0m") && c.includes("\x1b[32mnb.ipynb\x1b[0m") && c.includes("\x1b[35mb.board\x1b[0m") && !/\x1b\[[0-9;]*mf\x1b/.test(c) && !c.includes("\x1b[1;34mdx") && colourLs("dx\n", "/h", false, () => null, kindOf) === "dx\n", JSON.stringify(c));
  check("U5.b", strip(c) === out, "text unchanged");
  check("U5.c", c.includes("\nnot-there\n") && c.includes("\nf\n"), "unknown and plain lines untouched");
  const R = ".:\nd\nf\n\n./d:\nx\ny\n";
  const cr = colourLs(R, null, true, (h) => (h === "." ? "/h" : h === "./d" ? "/h/d" : null), kindOf);
  check("U5.d", cr.includes("\x1b[1;34md\x1b[0m") && cr.includes("\x1b[1;34my\x1b[0m") && strip(cr) === R && cr.includes("\n./d:\n"), JSON.stringify(cr));
  const argv = (s) => s.split(" ");
  check("U5.e", same(lsColourable(argv("ls")), []) && same(lsColourable(argv("ls -aF d")), ["d"]) && same(lsColourable(argv("ls -1 -R")), []) &&
    lsColourable(argv("ls -l")) === null && lsColourable(argv("ls -la")) === null && lsColourable(argv("ls --color")) === null && lsColourable(null) === null && lsColourable(argv("cat x")) === null,
    "only ls with -a -A -1 -F -R; a pipe or a redirect is never a plain argv (words() gives null)");
  check("U5.f", colourLs("d/\n", "/h", false, () => null, kindOf) === "\x1b[1;34md/\x1b[0m\n", "-F's folder slash");
}

// ---------------------------------------------------------------- U6 the Tab gate
{
  check("U6.a", tabAction("", 0, 0, false) === "default" && tabAction("   ", 2, 2, false) === "default", "empty");
  check("U6.b", tabAction("cat", 1, 1, false) === "default", "mid-word");
  check("U6.c", tabAction("cat ", 4, 4, false) === "default", "after a space");
  check("U6.d", tabAction("cat", 0, 3, false) === "default", "a selection");
  check("U6.e", tabAction("cat", 3, 3, true) === "default", "running");
  check("U6.f", tabAction("cat", 3, 3, false) === "complete" && tabAction("cat x y", 5, 5, false) === "complete", "at a word's end");
}

// ---------------------------------------------------------------- U7 compgen typed alone
{
  check("U7.a", same(compgen(["-c", "ca"]), { out: "caller\ncat\n", code: 0 }), JSON.stringify(compgen(["-c", "ca"])));
  check("U7.b", same(compgen(["-c", "zz"]), { out: "", code: 1 }), "no match: exit 1");
  check("U7.c", compgen(["-b"]).out.split("\n").includes("cd") && !compgen(["-b"]).out.split("\n").includes("ls"), "builtins only");
  check("U7.d", same(compgen(["-A", "command", "op"]), { out: "open\n", code: 0 }) && same(compgen(["-A", "builtin", "ec"]), { out: "echo\n", code: 0 }), "-A forms");
  check("U7.e", compgen(["-f", "x"]) === null && compgen(["-c", "a", "b"]) === null && compgen([]) === null, "anything else is bash's");
}

// ---------------------------------------------------------------- T-H2 the lists equal their sources
{
  const src = readFileSync(join(root, "optional/bash/src/shell.js"), "utf8");
  const m = /export const COMMANDS = \[([\s\S]*?)\];/.exec(src);
  const shellCmds = m ? [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]) : [];
  check("T-H2.a", same([...shellCmds].sort(), [...SHELL_COMMANDS].sort()), `shell.js ${shellCmds.length}, panel ${SHELL_COMMANDS.length}`);
  const help = (await new Bash({}).exec("help")).stdout;
  const listed = help.split("\n").slice(4).join(" ").split(/\s+/).filter(Boolean).sort();
  check("T-H2.b", same(listed, [...BUILTINS].sort()), `help ${listed.length}, panel ${BUILTINS.length}: ${listed.filter((x) => !BUILTINS.includes(x))} / ${BUILTINS.filter((x) => !listed.includes(x))}`);
  check("T-H2.c", ["clear", "reset", "open", "ps", "top", "help"].every((c) => PANEL_COMMANDS.includes(c) && commandNames().includes(c)) && commandNames().includes("ls") && commandNames().includes("cd"), "panel + shell + builtins");
}

console.log(fails.length ? `test-panel-complete: ${fails.length} of ${n} FAILED: ${fails.join(" ")}` : `test-panel-complete: all ${n} checks pass`);
process.exit(fails.length ? 1 : 0);
