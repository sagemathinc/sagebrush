// ci: web-runner order=22 chrome
// Real shared page helpers: a never-resolving in-page evaluation must fail in
// milliseconds, name the expression, and leave the next call usable.
import assert from "node:assert/strict";
import { browser as a14Browser } from "./agents/a14-cases.mjs";
import { browser as journalBrowser } from "./board/test-board-journal-lib.mjs";

const expression = "new Promise(() => {})";
let a14, journal;
try {
  a14 = await a14Browser();
  const page = await a14.tab();
  let start = performance.now();
  await assert.rejects(page.ev(expression, {}, 100), /A14.send\(Runtime.evaluate new Promise.*timed out after [\d.]+ s/);
  assert(performance.now() - start < 2000);
  assert.equal(await page.ev("2 + 2"), 4);
  start = performance.now();
  await assert.rejects(page.until(expression, 100), /A14.(until|send).*timed out after [\d.]+ s/);
  assert(performance.now() - start < 2000);

  journal = await journalBrowser();
  const tab = await journal.tab("deadline test");
  start = performance.now();
  await assert.rejects(tab.until(expression, 100), /journal.(until|send).*new Promise.*timed out after [\d.]+ s/);
  assert(performance.now() - start < 2000);
  assert.equal(await tab.ev("3 + 3"), 6);
  await tab.close();
  console.log("test-page-deadlines: A14 and journal hung evaluations/polls fail promptly; healthy calls still work");
} finally {
  await a14?.close();
  await journal?.close();
}
