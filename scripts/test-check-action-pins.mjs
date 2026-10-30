#!/usr/bin/env bun
// scripts/check-action-pins.mjs on fixed workflows (scripts/action-pins-fixtures):
// each must pass or fail as listed, with the failure naming the right rule, so
// a guard that lets everything through (or nothing) can't pass.
//   bun scripts/test-check-action-pins.mjs
import { check } from "./check-action-pins.mjs";
import { join } from "node:path";

const dir = join(import.meta.dir, "action-pins-fixtures");
// [file, expected: "ok" or a fragment the first error must contain]
const cases = [
  ["good.yml", "ok"],
  ["tag.yml", "not pinned to a 40-hex"],
  ["short-sha.yml", "not pinned to a 40-hex"],
  ["upper-hex.yml", "not pinned to a 40-hex"],
  ["no-comment.yml", "needs exactly"],
  ["comment-trailing.yml", "needs exactly"],
  ["comment-bad.yml", "needs exactly"],
  ["flow-mapping.yml", "not in block form"],
  ["quoted-key.yml", "not in block form"],
  ["docker-tag.yml", "@sha256"],
  ["same-sha-two-comments.yml", "here but"],
  ["same-tag-two-shas.yml", "here but"],
  ["local-with-comment.yml", "local action takes no comment"],
  ["job-level-tag.yml", "not pinned to a 40-hex"],
  ["second-document.yml", "not pinned to a 40-hex"],
  ["composite-action.yml", "not pinned to a 40-hex"],
  // (a step used twice through an alias: the parser sees two uses, the text
  // one line; they must agree. One alias use passes: the line it points to
  // is itself checked)
  ["alias-step.yml", "the YAML has"],
];
let bad = 0;
for (const [file, want] of cases) {
  const { errors } = check([join(dir, file)]);
  const got = errors.length ? errors[0] : "ok";
  const pass = want === "ok" ? errors.length === 0 : errors.length > 0 && errors.some((e) => e.includes(want));
  console.log(`${pass ? "ok  " : "FAIL"} ${file}: ${got.replace(dir + "/", "")}`);
  if (!pass) {
    bad++;
    if (errors.length > 1) for (const e of errors.slice(1)) console.log(`       ${e}`);
  }
}
if (bad) {
  console.log(`FAIL: ${bad} of ${cases.length} fixtures`);
  process.exit(1);
}
console.log(`ok: all ${cases.length} fixtures`);
