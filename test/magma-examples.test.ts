import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The examples of the Magma index (lib/_magma_docsearch.py EXAMPLES): each
// runs in a fresh Magma session of Sagebrush and must print exactly what the
// example shows, so an example can't go stale.  Magma 2.18's output for the
// same input (test/magma-examples.json, made by
// scripts/magma-examples-table.py, Magma run as a black box) must be the same
// too, except for the names listed in MAGMA_DIFFERS.
const cli = join(__dirname, "..", "src", "cli.js");
const root = join(__dirname, "..", "..");
const examples: Record<string, string> = JSON.parse(spawnSync(process.execPath, [cli, "-m", "_magma_docsearch", "--examples"], { encoding: "utf8" }).stdout);
const magma: Record<string, string> = JSON.parse(readFileSync(join(root, "test", "magma-examples.json"), "utf8")).magma;

// where Magma 2.18 prints something else, and why (none now: the index
// has only Magma's own intrinsics, with Magma's meaning)
const MAGMA_DIFFERS: Record<string, string> = {};

const inputs = (example: string) => example.split("\n").filter((l) => l.startsWith("> ")).map((l) => l.slice(2));

// as scripts/magma-examples-table.py program() and transcript()
const program = (lines: string[]) => lines.map((l, k) => `print "@@${k}";\n${l}\n`).join("") + 'print "@@end";\n';
function transcript(lines: string[], out: string): string | null {
  const parts = out.split(/^@@(?:\d+|end)\n/m).slice(1);
  if (parts.length !== lines.length + 1) return null;
  const text: string[] = [];
  lines.forEach((l, k) => {
    text.push("> " + l);
    if (parts[k].trim()) text.push(...parts[k].replace(/\n+$/, "").split("\n"));
  });
  return text.join("\n");
}

function sagebrush(lines: string[]): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [cli, "--magma"], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    p.stdout.setEncoding("utf8").on("data", (d) => (out += d));
    p.on("error", reject);
    p.on("close", () => resolve(transcript(lines, out)));
    p.stdin.end(program(lines));
  });
}

test("every Magma index example prints what it shows, in a fresh session", async () => {
  const names = Object.keys(examples).sort();
  assert.ok(names.length >= 158, `${names.length} examples`);
  const bad: string[] = [];
  let next = 0;
  const worker = async () => {
    while (next < names.length) {
      const n = names[next++];
      const got = await sagebrush(inputs(examples[n]));
      if (got !== examples[n]) bad.push(`${n}:\n--- example\n${examples[n]}\n--- Sagebrush\n${got}`);
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));
  assert.deepEqual(bad, []);
});

test("Magma 2.18 prints the same for every example but the listed ones", () => {
  assert.deepEqual(Object.keys(magma).sort(), Object.keys(examples).sort());
  const bad: string[] = [];
  for (const [n, ex] of Object.entries(examples)) {
    const same = magma[n] === ex;
    if (n in MAGMA_DIFFERS ? same : !same) bad.push(`${n}: ${same ? "now the same in Magma (remove it from MAGMA_DIFFERS)" : `Magma prints\n${magma[n]}`}`);
  }
  assert.deepEqual(bad, []);
});

test("the index carries each example, and the search box's Insert takes its input", () => {
  const index = JSON.parse(spawnSync(process.execPath, [cli, "-m", "_magma_docsearch", "--index"], { encoding: "utf8" }).stdout);
  // docExamples from web/index.html, as the page runs it
  const html = readFileSync(join(root, "web", "index.html"), "utf8");
  const src = /^function docExamples\(doc, lang\) \{[\s\S]*?^\}/m.exec(html)![0];
  const docExamples = new Function(`${src}; return docExamples;`)() as (doc: string, lang: string) => string;
  for (const e of index) {
    const lines = inputs(examples[e.name]);
    assert.equal(e.examples, lines.length, e.name);
    assert.ok(e.doc.startsWith(e.summary + "\n\nExample:\n\n"), e.name);
    assert.equal(docExamples(e.doc, "magma"), lines.join("\n"), e.name);
  }
});

test("a Hecke operator, whose matrix isn't computed, refuses to print (it printed a Python object)", () => {
  const src = "S := CuspidalSubspace(ModularSymbols(11, 2, 1));\nT := HeckeOperator(S, 3);\nT;\nCoefficients(CharacteristicPolynomial(T));\n";
  const r = spawnSync(process.execPath, [cli, "--magma"], { input: src, encoding: "utf8" });
  assert.match(r.stdout, /Runtime error: the matrix of a Hecke operator is not supported yet/);
  assert.doesNotMatch(r.stdout, /object at 0x/);
  assert.match(r.stdout, /\[ 1, 1 \]\n$/);
});
