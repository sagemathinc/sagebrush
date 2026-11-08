import test from "node:test";
import { checkPartition, checkScopeAndKnown } from "./rill-corpus-run";

// Rill's corpus, partition 1 of 4 (design/rill.md §7.5; test/rill-corpus-run.ts says what is checked)
test("rill-tests SCOPE.json and KNOWN.json follow their rules", () => {
  checkScopeAndKnown();
});

test("the Rill corpus, partition 1: every scoped case exact, or a known difference both ways", () => {
  const ms = checkPartition(1);
  console.log(`rill corpus partition 1: ${ms} ms`);
});
