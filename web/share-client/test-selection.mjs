// The Share dialog's selection model (web/share-client/selection.ts,
// share-ux-plan r2 §1, §4): stable order, touched boxes, shift ranges,
// Select all/none, generations, the upload snapshot, the bounds.
//   bun web/share-client/test-selection.mjs
import { Selection, reasonText } from "./selection.ts";

let checks = 0;
const fails = [];
const ok = (cond, what) => {
  checks++;
  if (!cond) {
    fails.push(what);
    console.log("FAIL " + what);
  }
};
const files = [{ path: "/z.csv", size: 10 }, { path: "/a.csv", size: 5 }, { path: "/m/b.npy", size: 7 }, { path: "/nb.ipynb", size: 3 }];
const fresh = (gen = 1) => new Selection(gen, { path: "/nb.ipynb", size: 3 }, files);
const checked = (s) => s.rows.filter((r) => r.checked).map((r) => r.path);
const R = { kind: "opened", cell: 0 };

{
  const s = fresh();
  ok(JSON.stringify(s.rows.map((r) => r.path)) === JSON.stringify(["/nb.ipynb", "/a.csv", "/m/b.npy", "/z.csv"]), "the notebook first, then files by path (one stable order)");
  ok(JSON.stringify(checked(s)) === JSON.stringify(["/nb.ipynb"]), "only the notebook checked at first");
  ok(s.toggle(0).length === 0 && s.rows[0].checked, "the notebook can't be unchecked");
}
{
  const s = fresh();
  ok(s.suggest(1, "/z.csv", R) && s.row("/z.csv").checked && s.row("/z.csv").reason === R, "a suggestion checks an untouched box, with its reason");
  const order = s.rows.map((r) => r.path).join();
  ok(order === "/nb.ipynb,/a.csv,/m/b.npy,/z.csv", "...and moves no row");
  ok(!s.suggest(2, "/a.csv", R) && !s.row("/a.csv").checked, "a suggestion from another generation is ignored");
  ok(!s.suggest(1, "/nope.csv", R), "a path not in the list is ignored");
}
{
  const s = fresh();
  s.toggle(1); // check /a.csv
  s.toggle(1); // and uncheck it again: touched
  ok(!s.suggest(1, "/a.csv", R) && !s.row("/a.csv").checked, "a box the user touched is never changed by a suggestion");
}
{
  const s = fresh();
  s.all(false);
  ok(!s.suggest(1, "/a.csv", R) && !s.suggest(1, "/z.csv", R) && JSON.stringify(checked(s)) === '["/nb.ipynb"]', "after Select none, no suggestion checks anything (every box touched)");
  s.all(true);
  ok(checked(s).length === 4, "Select all checks every box");
}
{
  const s = fresh();
  s.toggle(1); // anchor at /a.csv, checked
  const changed = s.toggle(3, true); // shift to /z.csv: all become checked
  ok(JSON.stringify(changed) === "[2,3]" && checked(s).length === 4, "a shift range sets every row from the anchor to the clicked one");
  ok(s.rows.slice(1).every((r) => r.touched), "...and every member is touched");
  s.toggle(3, true); // from anchor 3 to 3: uncheck z
  ok(!s.row("/z.csv").checked && s.row("/m/b.npy").checked, "the anchor moves to the last row toggled");
  const s2 = fresh();
  s2.toggle(3);
  s2.toggle(1, true);
  ok(checked(s2).length === 4, "a range works upwards too");
}
{
  const s = fresh();
  s.toggle(1);
  const snap = s.snapshot();
  ok(Object.isFrozen(snap) && snap.length === 2 && snap[0].notebook && snap[1].path === "/a.csv", "the upload snapshot: the checked rows, frozen");
  ok(s.toggle(2).length === 0 && !s.suggest(1, "/z.csv", R) && (s.all(true), checked(s).length === 2), "while frozen, nothing changes a box");
  s.thaw();
  ok(s.toggle(2).length === 1, "after the upload, the boxes work again");
}
{
  const s = fresh();
  s.all(true);
  let sum = s.summary({ maxFiles: 10 });
  ok(sum.files === 4 && sum.of === 4 && sum.bytes === 25 && sum.sizesKnown && sum.over === null, "the summary: files, of, bytes");
  ok(/at most 3 files/.test(s.summary({ maxFiles: 3 }).over), "over the file count");
  ok(/z\.csv is larger/.test(s.summary({ maxFiles: 10, maxFileBytes: 8 }).over), "over the largest file");
  ok(/storage/.test(s.summary({ maxFiles: 10, bytesLeft: 20 }).over), "over the storage left");
  const u = new Selection(1, { path: "/nb.ipynb" }, [{ path: "/x" }]);
  u.all(true);
  sum = u.summary({ maxFiles: 10, bytesLeft: 0 });
  ok(!sum.sizesKnown && sum.over === null, "unknown sizes (the legacy store): no storage bound claimed");
}
ok(reasonText({ kind: "read", cell: 2 }) === "read when the 3rd cell last ran", "reason: read");
ok(reasonText({ kind: "opened", cell: 0 }) === "opened in the 1st cell" && reasonText({ kind: "named", cell: 10 }) === "named in the 11th cell", "reasons: opened, named, ordinals");
ok(reasonText({ kind: "imported", by: "/a.py" }) === "imported by a.py" && reasonText({ kind: "opened", by: "/b.py" }) === "opened in b.py", "reasons by a module");

// ---- #172 r2's review, CORR-172-ASTRA-3: the notebook has the per-file bound too
{
  const s = new Selection(1, { path: "/big.ipynb", size: 200 }, []);
  ok(/big\.ipynb is larger than your plan's largest file/.test(s.summary({ maxFiles: 10, maxFileBytes: 100 }).over ?? ""), `a notebook over the largest file, alone: over (${JSON.stringify(s.summary({ maxFiles: 10, maxFileBytes: 100 }).over)})`);
  ok(s.summary({ maxFiles: 10, maxFileBytes: 200 }).over === null, "...and at the limit, not (control)");
  ok(s.summary({ maxFiles: 1 }).over === null && s.rows[0].checked, "the file count and the notebook's mandatory check unchanged");
}

console.log(`${checks - fails.length}/${checks} passed`);
process.exit(fails.length ? 1 : 0);
