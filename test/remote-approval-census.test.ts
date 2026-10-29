import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";

// The writer census of remote approval, enforced on the sources: every key the approval checks by identity
// is replaced, never written, and only by its owner's writers.  Nothing is
// executed from the sources: each rule is checked on the text, and then on
// a copy with one planted fault, which the rule must reject.

const ROOT = join(__dirname, "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

// The lines of a block that starts with a line beginning with `header` (after its indent) and ends at
// the first later line that is its indent followed by "}" (the sources are formatted that way).
function block(src: string, header: string): { start: number; end: number; text: string } {
  const lines = src.split("\n");
  const start = lines.findIndex((l) => l.trimStart().startsWith(header));
  assert.ok(start >= 0, `no ${header}`);
  const indent = lines[start].length - lines[start].trimStart().length;
  let end = start + 1;
  while (end < lines.length && lines[end] !== " ".repeat(indent) + "}") end++;
  return { start, end, text: lines.slice(start, end + 1).join("\n") };
}
// The line numbers where a pattern matches.
const where = (src: string, re: RegExp) => src.split("\n").flatMap((l, i) => (re.test(l) ? [i] : []));
const inside = (i: number, b: { start: number; end: number }) => i > b.start && i < b.end;

// The editor text: notebook.js assigns a cell's editor text only in setText (which makes its text version).
function textRule(src: string): string[] {
  const set = block(src, "function setText(");
  const bad = where(src, /\.ta\.value\s*=(?![=>])/).filter((i) => !inside(i, set));
  if (!/cell\.version = Object\.freeze\(\{ text: cell\.ta\.value \}\)/.test(set.text)) bad.push(-1);
  return bad.map((i) => `ta.value assigned outside setText (line ${i + 1})`);
}
// The settings: every assignment of mode, meta or reactiveOn is followed (on its line, or the next) by gateCfg = null.
function settingsRule(src: string): string[] {
  const lines = src.split("\n");
  const out: string[] = [];
  lines.forEach((l, i) => {
    const re = /(?<![.\w])(mode|meta|reactiveOn)\s*=(?![=>])/g;
    for (let m: RegExpExecArray | null; (m = re.exec(l)); ) {
      if (/\blet\s*$/.test(l.slice(0, m.index))) continue; // (the declarations)
      const rest = l.slice(m.index) + "\n" + (lines[i + 1] ?? "");
      if (!/gateCfg = null/.test(rest)) out.push(`${m[1]} assigned without gateCfg = null (line ${i + 1})`);
    }
  });
  return out;
}
// The kernel record: remote-kernel.js assigns this.lc only in the constructor and setLc.
function lcRule(src: string): string[] {
  const ctor = block(src, "constructor("), set = block(src, "setLc(");
  return where(src, /this\.lc\s*=(?![=>])/).filter((i) => !inside(i, ctor) && !inside(i, set)).map((i) => `this.lc assigned outside the constructor and setLc (line ${i + 1})`);
}
// The scoping and errors maps, the registrations: notebook-reactive.ts never writes the scoping or errors map after assigning it,
// assigns them only in their writers, and never writes a field of a registration or an analysis.
function reactiveRule(src: string): string[] {
  const out: string[] = [];
  for (const i of where(src, /this\.(scoped|errorMap)\.(set|delete|clear)\(/)) out.push(`the scoping or errors map written in place (line ${i + 1})`);
  const eff = block(src, "private async effectiveCodes("), reset = block(src, "reset(): Promise<RunReport>"), setErrors = block(src, "private setErrors(");
  for (const i of where(src, /this\.scoped\s*=(?![=>])/)) if (!inside(i, eff) && !inside(i, reset)) out.push(`the scoping map assigned outside its writers (line ${i + 1})`);
  for (const i of where(src, /this\.errorMap\s*=(?![=>])/)) if (!inside(i, setErrors)) out.push(`the errors map assigned outside setErrors (line ${i + 1})`);
  for (const i of where(src, /this\.errorsView\s*=(?![=>])/)) if (!inside(i, setErrors)) out.push(`the errors view assigned outside setErrors (line ${i + 1})`);
  for (const i of where(src, /[\w)\]]\.(source|code|version|analysis|error)\s*=(?![=>])/)) out.push(`a registration's field written (line ${i + 1})`);
  for (const i of where(src, /\.(defs|refs|deleted|mutations|unbinds)\.(add|delete|clear)\(|\.imports\.(set|delete|clear)\(/)) out.push(`an analysis written (line ${i + 1})`);
  return out;
}
// The graph: notebook-graph.ts writes its collections only in build() (and its files only in setFiles, a
// copy), and build() ends by replacing the version.
function graphRule(src: string): string[] {
  const out: string[] = [];
  const build = block(src, "private build(): void"), files = block(src, "setFiles(");
  for (const i of where(src, /this\.(parentsOf|childrenOf|errorsOf|definersOf|updaters|deleters|versionNow)\s*=(?![=>])/)) if (!inside(i, build)) out.push(`a graph collection assigned outside build() (line ${i + 1})`);
  for (const i of where(src, /this\.files\s*=(?![=>])/)) if (!inside(i, files)) out.push(`the files assigned outside setFiles (line ${i + 1})`);
  if (!/this\.files = new Map\(/.test(files.text)) out.push("setFiles keeps the caller's map");
  const body = build.text.split("\n").slice(1, -1).map((l) => l.trim()).filter((l) => l && !l.startsWith("//"));
  if (body.at(-1) !== "this.versionNow = Object.freeze({});") out.push("build() does not end by replacing the version");
  if (!/this\.build\(\);\s*\n\s*\}/.test(block(src, "set(cells: GraphCell[])").text)) out.push("set() does not end in build()");
  return out;
}
// The test-only hooks: no production file sets them.
function productionFiles(): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(join(ROOT, d))) {
      const p = join(d, name);
      if (name === "node_modules" || name === "test" || name.startsWith("test-") || name.endsWith(".min.js")) continue;
      const st = statSync(join(ROOT, p));
      if (st.isDirectory()) walk(p);
      else if (/\.(ts|js|mjs)$/.test(name) && st.size < 4 << 20) out.push(p);
    }
  };
  walk("src");
  walk("web");
  return out;
}
const hooksRule = (src: string) => where(src, /\bsetTestHooks\(/).filter((i) => !/export function setTestHooks\(/.test(src.split("\n")[i])).map((i) => `a test hook set (line ${i + 1})`);

// Each rule, and a planted fault it must reject: [the file, the rule, the fault, the mutation].
const rules: [string, (s: string) => string[], string, (s: string) => string][] = [
  ["web/notebook/notebook.js", textRule, "the editor text written outside setText", (s) => s.replace("  function split(cell) {\n", "  function split(cell) {\n    cell.ta.value = \"\";\n")],
  ["web/notebook/notebook.js", settingsRule, "a settings write without gateCfg = null", (s) => s.replace("    mode = [\"python\", \"sage\", \"magma\", \"matlab\"].includes(m) ? m : \"python\";\n    gateCfg = null;\n", "    mode = [\"python\", \"sage\", \"magma\", \"matlab\"].includes(m) ? m : \"python\";\n")],
  ["web/notebook/remote-kernel.js", lcRule, "the kernel record written outside setLc", (s) => s.replace("  notSent(job, note) {\n", "  notSent(job, note) {\n    this.lc = Object.freeze({ ...this.lc });\n")],
  ["src/notebook-reactive.ts", reactiveRule, "the scoping map written in place", (s) => s.replace("    const reg = this.registered.get(id);\n    if (!reg) return undefined;\n    const names", "    const reg = this.registered.get(id);\n    if (!reg) return undefined;\n    this.scoped.delete(\"x\");\n    const names")],
  ["src/notebook-reactive.ts", reactiveRule, "the errors map written in place", (s) => s.replace("  private defsOf(id: string): string[] {\n", "  private defsOf(id: string): string[] {\n    this.errorMap.clear();\n")],
  ["src/notebook-reactive.ts", reactiveRule, "a registration's field written", (s) => s.replace("        if (prev.source !== source || prev.version !== version) this.registered.set(id, Object.freeze({ ...prev, source, version }));", "        if (prev.source !== source) (prev as any).source = source;")],
  ["src/notebook-graph.ts", graphRule, "build() not replacing the version", (s) => s.replace("    this.versionNow = Object.freeze({});\n  }\n", "  }\n")],
];

for (const [file, rule, mutant, mutate] of rules) {
  test(`the writer census: ${file} keeps it, and a planted fault (${mutant}) is rejected`, () => {
    const src = read(file);
    assert.deepEqual(rule(src), [], `${file}: the census`);
    const bad = mutate(src);
    assert.notEqual(bad, src, `${mutant}: the mutation applies`);
    assert.ok(rule(bad).length > 0, `${mutant}: the rule rejects it`);
  });
}

test("the test-only faults (the adapter's, approvals', the scheduler's and the client's) are set by no production file", () => {
  const files = productionFiles();
  assert.ok(files.includes(join("web", "notebook", "remote-gate.js")) && files.includes(join("src", "remote-approval.ts")), "(the scan sees the sources)");
  for (const f of files) assert.deepEqual(hooksRule(read(f)), [], f);
  assert.ok(hooksRule(read("web/notebook/remote-gate.js") + "\nsetTestHooks({ parentsSkip: true });\n").length > 0, "a planted call is rejected");
});
