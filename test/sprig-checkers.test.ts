import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The value checkers behind Sprig's KNOWN classes (design/sprig-mvp.md §7.3) and their negative controls:
// sprig-tests/checker-controls.json holds, for each class, cases that must pass and planted wrong answers that must
// fail, and a control may also name why (a mismatch, different symbols, too few finite points), so it can't pass for
// the wrong reason. The checkers run inside Sagebrush (sprig-tests/checkers.py, on the Sage layer) and share no code
// with lib/_sprig/.
const root = join(__dirname, "..", "..");
const CLI = join(__dirname, "..", "src", "cli.js");
const CONTROLS = join(root, "sprig-tests", "checker-controls.json");
const CLASSES = ["term-order", "equivalent-form", "oracle-unevaluated", "oracle-wrong", "oracle-host-limit", "normalize"];

type Row = { name: string; class: string; expect: string; got: string; how: string; ok: boolean };

function run(controls: string): { status: number; rows: Row[] } {
  const p = spawnSync(process.execPath, [CLI, join(root, "sprig-tests", "checkers.py"), "--controls", controls], { encoding: "utf8", timeout: 120000 });
  assert.equal(p.stderr, "", p.stderr);
  return { status: p.status ?? -1, rows: JSON.parse(p.stdout) };
}

test("every checker gives each control its expected verdict, for the stated reason", () => {
  const { status, rows } = run(CONTROLS);
  const bad = rows.filter((r) => !r.ok).map((r) => `${r.name}: expected ${r.expect}, got ${r.got} (${r.how})`);
  assert.deepEqual(bad, []);
  assert.equal(status, 0);
});

test("every class has a control that must pass and a planted wrong answer that must fail", () => {
  const controls = JSON.parse(readFileSync(CONTROLS, "utf8")).controls as { class: string; expect: string }[];
  for (const k of CLASSES) {
    assert.ok(controls.some((c) => c.class === k && c.expect === "pass"), `${k}: no passing control`);
    assert.ok(controls.some((c) => c.class === k && c.expect === "fail"), `${k}: no planted wrong answer`);
  }
  // (the numeric path is exercised both ways, not only the symbolic one)
  assert.ok(controls.some((c: any) => c.force_numeric && c.expect === "pass"));
  assert.ok(controls.some((c: any) => c.force_numeric && c.expect === "fail"));
});

test("control: the run fails when a planted wrong answer is marked as passing", () => {
  // (the runner itself must fail, not only report: an inverted fixture is caught)
  const j = JSON.parse(readFileSync(CONTROLS, "utf8"));
  const planted = j.controls.find((c: any) => c.class === "equivalent-form" && c.expect === "fail");
  planted.expect = "pass";
  delete planted.how;
  const p = join(mkdtempSync(join(tmpdir(), "sprig-ctl-")), "controls.json");
  writeFileSync(p, JSON.stringify(j));
  const { status, rows } = run(p);
  assert.notEqual(status, 0);
  assert.ok(rows.some((r) => r.name === planted.name && !r.ok));
});

test("control: the run fails when a control passes for another reason than it names", () => {
  const j = JSON.parse(readFileSync(CONTROLS, "utf8"));
  const c = j.controls.find((x: any) => x.how === "mismatch");
  c.how = "^symbols$";
  const p = join(mkdtempSync(join(tmpdir(), "sprig-ctl-")), "controls.json");
  writeFileSync(p, JSON.stringify(j));
  const { status, rows } = run(p);
  assert.notEqual(status, 0);
  assert.ok(rows.some((r) => r.name === c.name && !r.ok));
});
