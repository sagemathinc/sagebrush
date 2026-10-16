import test from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { join } from "node:path";

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

test("catalog gate 3: every Magma example prints exactly its expected output, in a fresh session (Node)", async () => {
  const examples = entries.flatMap((e) => e.examples.map((x) => ({ e, x })));
  assert.ok(examples.length >= 40, `${examples.length} examples`);
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
});
