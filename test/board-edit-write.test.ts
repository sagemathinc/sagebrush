import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { writeOnce, recoverAtStart, Slots, hashOf, isSidecar, realFs } from "../src/board-edit-write";

// `board open --edit`'s save (plan-board-open-edit r7 §5.2): steps W1-W7, on a real directory, with an outside
// writer put at each step; the sidecar slots (§5.7); and the recovery at start.  No observed version is lost,
// and nothing invalid is written over.
const A = Buffer.from('{"v":"A"}\n'), T = Buffer.from('{"v":"T"}\n'), C = Buffer.from('{"v":"C"}\n'), D = Buffer.from('{"v":"D"}\n');
let n = 0;
const setup = (content = A) => {
  const dir = fs.mkdtempSync(join(tmpdir(), "sb-edit-write-"));
  const file = join(dir, "b.board.json");
  fs.writeFileSync(file, content, { mode: 0o640 });
  fs.chmodSync(file, 0o640);
  return { dir, file, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
};
const sidecars = (dir: string, file: string) => fs.readdirSync(dir).filter((x) => isSidecar(file, x)).sort();
// (an atomic replace by another program: its own temp file renamed over FILE, a new inode)
const replace = (file: string, bytes: Buffer) => { const t = file + ".other" + n++; fs.writeFileSync(t, bytes); fs.renameSync(t, file); };
// (a write in place: same inode)
const inPlace = (file: string, bytes: Buffer) => fs.writeFileSync(file, bytes);

test("board open --edit save: a clean save; prev retained with P's old bytes; FILE's mode kept", () => {
  const { dir, file, cleanup } = setup();
  try {
    const slots = new Slots(8);
    const r = writeOnce(file, T, hashOf(A), slots);
    assert.equal(r.saved, true);
    assert.deepEqual(fs.readFileSync(file), T);
    assert.equal(fs.statSync(file).mode & 0o777, 0o640);
    assert.ok(r.saved && fs.readFileSync(r.prev).equals(A));
    assert.deepEqual(sidecars(dir, file).length, 1); // (prev only: no tmp, no prev2)
    assert.equal(slots.used, 1); // (prev's slot, held until it is unlinked)
  } finally { cleanup(); }
});

test("board open --edit save: FILE changed before W2: its bytes returned to ingest, nothing written", () => {
  const { dir, file, cleanup } = setup();
  try {
    const slots = new Slots(8);
    const r = writeOnce(file, T, hashOf(A), slots, { step: (s) => { if (s === "W2") replace(file, C); } });
    assert.equal(r.saved, false);
    assert.ok(!r.saved && r.why === "changed" && r.bytes.equals(C));
    assert.deepEqual(fs.readFileSync(file), C);
    assert.deepEqual(sidecars(dir, file), []);
    assert.equal(slots.used, 0);
  } finally { cleanup(); }
});

test("board open --edit save: FILE deleted before W1 or W2: held as deleted, nothing created", () => {
  for (const at of ["W1", "W2", "W3"] as const) {
    const { dir, file, cleanup } = setup();
    try {
      const slots = new Slots(8);
      const r = writeOnce(file, T, hashOf(A), slots, { step: (s) => { if (s === at) fs.unlinkSync(file); } });
      assert.ok(!r.saved && r.why === "deleted", at);
      assert.equal(fs.existsSync(file), false, at);
      assert.deepEqual(sidecars(dir, file), [], at);
      assert.equal(slots.used, 0, at);
    } finally { cleanup(); }
  }
});

test("board open --edit save: astra's r5 interleaving: in place to C, then replaced by D, before W4", () => {
  const { dir, file, cleanup } = setup();
  try {
    const slots = new Slots(8);
    const r = writeOnce(file, T, hashOf(A), slots, { step: (s) => { if (s === "W4") { inPlace(file, C); replace(file, D); } } });
    // (C, read by W4 from prev, is an observed version; prev retained; D, now at FILE, handled separately; nothing lost)
    assert.ok(!r.saved && r.why === "classified");
    assert.ok(!r.saved && r.why === "classified" && r.bytes.equals(C));
    assert.ok(!r.saved && r.why === "classified" && fs.readFileSync(r.prev).equals(C));
    assert.deepEqual(fs.readFileSync(file), D);
    assert.equal(sidecars(dir, file).length, 1);
    assert.equal(slots.used, 1);
  } finally { cleanup(); }
});

test("board open --edit save: invalid bytes in FILE between W2 and W3: found at W4, never written over", () => {
  const { dir, file, cleanup } = setup();
  try {
    const slots = new Slots(8);
    const bad = Buffer.from('{"v": "half');
    const r = writeOnce(file, T, hashOf(A), slots, { step: (s) => { if (s === "W3") inPlace(file, bad); } });
    assert.ok(!r.saved && r.why === "classified" && r.bytes.equals(bad));
    assert.deepEqual(fs.readFileSync(file), bad); // (never written over)
    assert.equal(sidecars(dir, file).length, 1);
  } finally { cleanup(); }
});

test("board open --edit save: FILE replaced between W3 and W5: the replacement restored, the save abandoned", () => {
  const { dir, file, cleanup } = setup();
  try {
    const slots = new Slots(8);
    const r = writeOnce(file, T, hashOf(A), slots, { step: (s) => { if (s === "W5") replace(file, D); } });
    assert.ok(!r.saved && r.why === "replaced");
    assert.deepEqual(fs.readFileSync(file), D); // (D restored at FILE)
    assert.ok(!r.saved && r.why === "replaced" && fs.readFileSync(r.prev).equals(A)); // (prev: the inode classified)
    assert.equal(sidecars(dir, file).length, 1);
    assert.equal(slots.used, 1);
  } finally { cleanup(); }
});

test("board open --edit save: a new FILE between W5 and W6: kept, never replaced; prev kept", () => {
  const { dir, file, cleanup } = setup();
  try {
    const slots = new Slots(8);
    const r = writeOnce(file, T, hashOf(A), slots, { step: (s) => { if (s === "W6") fs.writeFileSync(file, D); } });
    assert.ok(!r.saved && r.why === "eexist");
    assert.deepEqual(fs.readFileSync(file), D);
    assert.ok(!r.saved && r.why === "eexist" && r.kept.every((p) => fs.existsSync(p)));
    assert.equal(sidecars(dir, file).length, 1); // (prev; no tmp)
    assert.equal(slots.used, 1);
  } finally { cleanup(); }
});

test("board open --edit save: a handle opened before the save writes into prev afterwards: prev changes, retained", () => {
  const { file, cleanup } = setup();
  try {
    const fd = fs.openSync(file, "r+");
    const slots = new Slots(8);
    const r = writeOnce(file, T, hashOf(A), slots);
    assert.ok(r.saved);
    fs.writeSync(fd, Buffer.from('{"v":"Z"}\n'), 0, 10, 0);
    fs.closeSync(fd);
    // (FILE is the save; prev, still kept, has the late write: §5.3's watch reads it)
    assert.deepEqual(fs.readFileSync(file), T);
    assert.ok(r.saved && fs.readFileSync(r.prev).toString() === '{"v":"Z"}\n');
  } finally { cleanup(); }
});

test("board open --edit save: three slots or nothing starts; exactly three is enough", () => {
  for (const [max, used, ok] of [[2, 0, false], [3, 0, true], [8, 6, false], [8, 5, true]] as const) {
    const { dir, file, cleanup } = setup();
    try {
      const slots = new Slots(max);
      slots.used = used;
      const r = writeOnce(file, T, hashOf(A), slots);
      assert.equal(r.saved, ok, `${max}/${used}`);
      if (!ok) {
        assert.ok(!r.saved && r.why === "slots");
        assert.deepEqual(sidecars(dir, file), []);
        assert.deepEqual(fs.readFileSync(file), A);
      }
      // (the logical reservations equal the sidecars on disk, above what was used before)
      assert.equal(slots.used - used, sidecars(dir, file).length, `${max}/${used}`);
    } finally { cleanup(); }
  }
});

test("board open --edit save: a crash at each step, then recovery at start: nothing lost, nothing deleted", () => {
  for (const at of ["W2", "W3", "W4", "W5", "W6", "W7"] as const) {
    const { dir, file, cleanup } = setup();
    try {
      const slots = new Slots(8);
      // (a crash: the process stops at this step; and then, if FILE is gone, the recovery restores it)
      assert.throws(() => writeOnce(file, T, hashOf(A), slots, { step: (s) => { if (s === at) throw new Error("crash"); } }));
      const before = sidecars(dir, file);
      const fresh = new Slots(8);
      const r = recoverAtStart(file, fresh, true);
      assert.equal(r.leftovers.length, before.length, at);
      assert.equal(fresh.used, before.length, at);
      assert.ok(fs.existsSync(file), `${at}: FILE present after recovery`);
      // (FILE is A or T, never anything else; every leftover kept)
      const now = fs.readFileSync(file);
      assert.ok(now.equals(A) || now.equals(T), at);
      assert.deepEqual(sidecars(dir, file), before, `${at}: nothing deleted`);
    } finally { cleanup(); }
  }
});

test("board open --edit save: the real filesystem adapter does what it says", () => {
  const { dir, file, cleanup } = setup();
  try {
    const p = join(dir, "x");
    realFs.writeFile(p, Buffer.from("x"), 0o600);
    assert.equal(fs.statSync(p).mode & 0o777, 0o600);
    assert.throws(() => realFs.writeFile(p, Buffer.from("y"), 0o600)); // (never over an existing file)
    assert.throws(() => realFs.link(p, file)); // (no replace)
  } finally { cleanup(); }
});
