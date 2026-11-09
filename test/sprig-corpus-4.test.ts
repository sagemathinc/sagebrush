import test from "node:test";
import { checkPartition, checkScopeAndKnown } from "./sprig-corpus-run";

// Sprig's corpus, partition 4 of 4 (design/sprig-mvp.md §7.5; test/sprig-corpus-run.ts says what is checked)
test("sprig-tests SCOPE.json and KNOWN.json follow their rules", () => {
  checkScopeAndKnown();
});

test("the Sprig corpus, partition 4: every scoped case exact, or a known difference both ways", () => {
  const ms = checkPartition(4);
  console.log(`sprig corpus partition 4: ${ms} ms`);
});
