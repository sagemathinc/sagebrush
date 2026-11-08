import test from "node:test";
import { checkPartition, checkScopeAndKnown } from "./rill-corpus-run";

// Rill's corpus, partition 2 of 4 (design/rill.md §7.5; test/rill-corpus-run.ts says what is checked)
test("rill-tests SCOPE.json and KNOWN.json follow their rules", () => {
  checkScopeAndKnown();
});

test("the Rill corpus, partition 2: every scoped case exact, or a known difference both ways", () => {
  const ms = checkPartition(2);
  console.log(`rill corpus partition 2: ${ms} ms`);
});
