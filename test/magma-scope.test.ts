import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { magmaToPython } from "../src/magma";

// The scope events of Magma functions (forward, define, read, assign,
// skipped or failed assignment, delete, local) in every order, against the
// outcome Magma 2.18 gives for each statement (test/magma-scope.json, made
// by scripts/magma-scope-table.py).  Each case runs three ways: all in one
// translation, each statement in its own (as notebook cells), and split in
// two; the outcomes must be Magma's every time.
const table = JSON.parse(readFileSync(join(__dirname, "..", "..", "test", "magma-scope.json"), "utf8"));
const cli = join(__dirname, "..", "src", "cli.js");

/** Runs the cases with each case's statements cut into translations by
 * `split`; the outcome of each statement, in order. */
function run(split: (n: number) => number[]): string[] {
  const translations: string[] = [];
  let k = 0;
  const cell = (stmts: string[], first: number) =>
    magmaToPython(stmts.map((s, j) => `print "@@${first + j}";\n${s}`).join("\n") + "\n", `<cell ${translations.length}>`, { recover: "session" });
  translations.push(magmaToPython(table.prelude.join("\n") + "\n", "<prelude>", { recover: "session" }));
  for (const c of table.cases) {
    const stmts: string[] = c.statements;
    let at = 0;
    for (const len of split(stmts.length)) {
      translations.push(cell(stmts.slice(at, at + len), k + at));
      at += len;
    }
    k += stmts.length;
  }
  const f = join(mkdtempSync(join(tmpdir(), "magma-scope-")), "cells.py");
  writeFileSync(f, translations.join("\n"));
  const r = spawnSync(process.execPath, [cli, f], { encoding: "utf8", maxBuffer: 1 << 26 });
  const cells = new Map<number, string[]>();
  let cur = -1;
  for (const line of r.stdout.split("\n")) {
    const m = /^@@(\d+)$/.exec(line.trim());
    if (m) cells.set((cur = Number(m[1])), []);
    else if (cur >= 0) cells.get(cur)!.push(line);
  }
  return Array.from({ length: k }, (_, j) => {
    const lines = cells.get(j);
    if (!lines) return "missing";
    const err = lines.find((l) => /error/i.test(l));
    return err !== undefined ? err.trim() : lines.filter((l) => l.trim()).join("\n");
  });
}

function check(name: string, split: (n: number) => number[]) {
  const got = run(split);
  const bad: string[] = [];
  let k = 0;
  for (const c of table.cases)
    c.statements.forEach((s: string) => {
      if (got[k] !== table.outcomes[k]) bad.push(`${name} ${c.name} ${JSON.stringify(s)}: Magma ${JSON.stringify(table.outcomes[k])}, Sagebrush ${JSON.stringify(got[k])}`);
      k++;
    });
  assert.deepEqual(bad.slice(0, 30), [], `${bad.length} differ`);
}

test("function scopes agree with Magma: each case in one translation", () => check("one", (n) => [n]));
test("function scopes agree with Magma: each statement its own translation (notebook cells)", () => check("each", (n) => Array(n).fill(1)));
test("function scopes agree with Magma: each case split in two translations", () =>
  check("halves", (n) => (n > 1 ? [Math.floor(n / 2), n - Math.floor(n / 2)] : [n])));
