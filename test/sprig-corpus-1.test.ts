import test from "node:test";
import { census, censusProblems, checkPartition, checkScopeAndKnown, known } from "./sprig-corpus-run";
import assert from "node:assert/strict";

// Sprig's corpus, partition 1 of 4 (design/sprig-mvp.md §7.5; test/sprig-corpus-run.ts says what is checked)
test("sprig-tests SCOPE.json and KNOWN.json follow their rules", () => {
  checkScopeAndKnown();
});

test("the census: no recorded output keeps a character the normalization doesn't cover, outside a KNOWN case", () => {
  assert.deepEqual(censusProblems(census(), known()), []);
});

test("the Sprig corpus, partition 1: every scoped case exact, or a known difference both ways", () => {
  const ms = checkPartition(1);
  console.log(`sprig corpus partition 1: ${ms} ms`);
});
