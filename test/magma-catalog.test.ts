import test from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { join } from "node:path";
import { prSample, sampleSkip, slowSkip } from "./slow-tests";

// Catalog gate 3 for Magma mode (catalog/magma/*.json): each example's code
// runs in a fresh Magma session of Sagebrush and must print exactly its
// `expected`.  (Magma code is translated by src/magma.ts, so the examples run
// here, through the CLI, rather than through lib/_catalog.py's in-process
// RUNNERS.)  Their output in Magma 2.18 itself was checked when they were
// written.
const cli = join(__dirname, "..", "src", "cli.js");
type Entry = { name: string; signature: string; examples: { code: string; expected: string }[] };
const entries: Entry[] = JSON.parse(execFileSync(process.execPath, [cli, "-c",
  "import json, _catalog as c\nprint(json.dumps([e for _, e in c.load('magma')]))"], { encoding: "utf8", maxBuffer: 64 * 2 ** 20 }));

function session(code: string): Promise<string> {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [cli, "--magma"], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    p.stdout.setEncoding("utf8").on("data", (d) => (out += d));
    p.stderr.resume();
    p.stdin.on("error", () => {});
    p.on("error", (e) => resolve(`(could not start: ${e})`));
    p.on("close", (code, signal) => resolve(code === 0 && signal === null ? out : `${out}(exit code ${code}, signal ${signal})`));
    p.stdin.end(code + "\n");
  });
}

// Each example in a fresh session, 8 at once.  All of them took 230 s (node-tests (4)) and 386 s (engine-node (4)) on a
// green master run (42597347825), so the whole gate is a slow test (test/slow-tests.ts: nightly, a dispatch, the
// full-ci label, and a pull request changing catalog/magma or this file); every pull request runs a fixed sample of
// PR_SAMPLE spread over the catalog's order.
const PR_SAMPLE = 6;
type Example = { e: Entry; x: Entry["examples"][number] };
const allExamples = (): Example[] => entries.flatMap((e) => e.examples.map((x) => ({ e, x })));
async function checkExamples(examples: Example[]) {
  const bad: string[] = [];
  let next = 0;
  const worker = async () => {
    while (next < examples.length) {
      const { e, x } = examples[next++];
      const got = await session(x.code);
      if (got !== x.expected) bad.push(`${e.name} ${e.signature}\n${x.code}\n--- expected\n${x.expected}--- got\n${got}`);
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));
  assert.deepEqual(bad, []);
}

test("catalog gate 3: every Magma example prints exactly its expected output, in a fresh session (Node)", { skip: slowSkip }, async () => {
  const examples = allExamples();
  assert.ok(examples.length >= 40, `${examples.length} examples`);
  await checkExamples(examples);
});

test(`catalog gate 3, a fixed sample of ${PR_SAMPLE} Magma examples: each prints exactly its expected output, in a fresh session (every pull request)`, { skip: sampleSkip }, async () => {
  const examples = allExamples();
  assert.ok(examples.length >= 40, `${examples.length} examples`);
  await checkExamples(prSample(examples, PR_SAMPLE));
});
