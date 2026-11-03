import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { moveNoReplace, MoveError } from "../src/fs-move";

// src/fs-move.ts, `sagebrush notebook`'s rename (api/rename, #531): never over another file, never losing one, with
// another program's writes interleaved between its steps, as astra's LOCAL-RENAME-3 did.
const dir = mkdtempSync(join(tmpdir(), "sb-fs-move-"));
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
let k = 0;
const fresh = () => { const d = join(dir, String(++k)); require("node:fs").mkdirSync(d); return d; };
const read = (p: string) => (existsSync(p) ? readFileSync(p, "utf8") : null);
// (an editor's atomic save: written beside, then renamed over the name)
const atomicSave = (p: string, text: string) => { writeFileSync(p + ".tmp-editor", text); renameSync(p + ".tmp-editor", p); };
const left = (d: string) => readdirSync(d).sort();

test("a plain move: the file at its new name, the old name gone, no staging file left", () => {
  const d = fresh(), a = join(d, "a.ipynb"), b = join(d, "b.ipynb");
  writeFileSync(a, "A");
  moveNoReplace(a, b);
  assert.equal(read(b), "A");
  assert.equal(read(a), null);
  assert.deepEqual(left(d), ["b.ipynb"]);
});

test("LOCAL-RENAME-3: another program saves the old name during the move: its save is kept, the moved file is the one before", () => {
  for (const step of ["staged", "linked"] as const) {
    const d = fresh(), a = join(d, "a.ipynb"), b = join(d, "b.ipynb");
    writeFileSync(a, "OLD");
    moveNoReplace(a, b, (s) => { if (s === step) atomicSave(a, "NEW SAVE"); });
    assert.equal(read(a), "NEW SAVE", `${step}: the other program's save of a.ipynb is kept, not removed`);
    assert.equal(read(b), "OLD", `${step}: b.ipynb holds the file as it was moved`);
    assert.deepEqual(left(d), ["a.ipynb", "b.ipynb"], `${step}: nothing else left`);
  }
});

test("the new name made meanwhile: refused (exists), that file untouched, the old one back at its name", () => {
  const d = fresh(), a = join(d, "a.ipynb"), b = join(d, "b.ipynb");
  writeFileSync(a, "MINE");
  assert.throws(() => moveNoReplace(a, b, (s) => { if (s === "staged") writeFileSync(b, "THEIRS"); }), (e: unknown) => e instanceof MoveError && e.code === "exists");
  assert.equal(read(b), "THEIRS");
  assert.equal(read(a), "MINE");
  assert.deepEqual(left(d), ["a.ipynb", "b.ipynb"]);
});

test("the new name AND the old one made meanwhile: refused (kept), nothing overwritten, the moved file kept at its staging name", () => {
  const d = fresh(), a = join(d, "a.ipynb"), b = join(d, "b.ipynb");
  writeFileSync(a, "MINE");
  assert.throws(() => moveNoReplace(a, b, (s) => { if (s === "staged") { writeFileSync(b, "THEIRS"); writeFileSync(a, "ALSO THEIRS"); } }), (e: unknown) => e instanceof MoveError && e.code === "kept" && !!e.stage && readFileSync(e.stage, "utf8") === "MINE");
  assert.equal(read(b), "THEIRS");
  assert.equal(read(a), "ALSO THEIRS");
  const staged = left(d).filter((f) => f.startsWith(".a.ipynb.sagebrush-rename-"));
  assert.equal(staged.length, 1);
  assert.equal(read(join(d, staged[0])), "MINE", "the file being moved isn't lost");
});

test("a name that isn't there: missing; another folder: refused", () => {
  const d = fresh();
  assert.throws(() => moveNoReplace(join(d, "x.ipynb"), join(d, "y.ipynb")), (e: unknown) => e instanceof MoveError && e.code === "missing");
  writeFileSync(join(d, "a.ipynb"), "A");
  require("node:fs").mkdirSync(join(d, "sub"));
  assert.throws(() => moveNoReplace(join(d, "a.ipynb"), join(d, "sub", "a.ipynb")), MoveError);
  assert.equal(read(join(d, "a.ipynb")), "A");
});
