// The files browser.mjs gives the page (sidecar.mjs): regular files only, within the caps, and a symlink is never
// followed, whether it is there when the files are chosen or put in a chosen file's place afterwards.
//
//   node bench/notebooks/test-sidecar.mjs      (exit 0 when every check passes)
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync, appendFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSidecar, selectSidecars } from "./sidecar.mjs";

const root = mkdtempSync(join(tmpdir(), "sbsc-"));
let failed = 0;
const check = (ok, what) => { if (!ok) { failed++; console.error("FAIL:", what); } };
try {
  const outside = join(root, "outside");
  const dir = join(root, "nb");
  mkdirSync(outside);
  mkdirSync(dir);
  // (the same size as a.txt, so that a.txt swapped for a symlink to it is refused by the no-follow open, not the size check)
  writeFileSync(join(outside, "sentinel.txt"), "HELLO");
  writeFileSync(join(dir, "a.txt"), "hello");
  writeFileSync(join(dir, "b.csv"), "1,2\n");
  writeFileSync(join(dir, "x.ipynb"), "{}");
  writeFileSync(join(dir, ".hidden"), "h");
  mkdirSync(join(dir, "sub"));
  symlinkSync(join(outside, "sentinel.txt"), join(dir, "link.txt"));
  symlinkSync(outside, join(dir, "linkdir"));
  execFileSync("mkfifo", [join(dir, "pipe")]);

  // chosen: the regular files only, in name order
  const chosen = selectSidecars(dir);
  check(JSON.stringify([...chosen]) === JSON.stringify([["a.txt", 5], ["b.csv", 4]]), `chosen ${JSON.stringify([...chosen])}`);
  check(readSidecar(dir, chosen, "a.txt")?.toString() === "hello", "a chosen file is read");
  for (const name of ["link.txt", "linkdir", "pipe", "sub", ".hidden", "x.ipynb", "../outside/sentinel.txt"]) {
    check(readSidecar(dir, chosen, name) === null, `${name} is not served`);
  }

  // a chosen file replaced by a symlink out of the folder, or a FIFO, or grown: not served
  unlinkSync(join(dir, "a.txt"));
  symlinkSync(join(outside, "sentinel.txt"), join(dir, "a.txt"));
  check(readSidecar(dir, chosen, "a.txt") === null, "a chosen file swapped for a symlink is not served");
  unlinkSync(join(dir, "a.txt"));
  execFileSync("mkfifo", [join(dir, "a.txt")]);
  check(readSidecar(dir, chosen, "a.txt") === null, "a chosen file swapped for a FIFO is not served (and doesn't hang)");
  appendFileSync(join(dir, "b.csv"), "3,4\n");
  check(readSidecar(dir, chosen, "b.csv") === null, "a chosen file that grew is not served");

  // the caps: files and bytes
  const capped = mkdtempSync(join(root, "cap-"));
  for (const [f, n] of [["1", 10], ["2", 10], ["3", 10], ["4", 1]]) writeFileSync(join(capped, f), "x".repeat(n));
  check(JSON.stringify([...selectSidecars(capped, { files: 2 }).keys()]) === '["1","2"]', "at most `files` files");
  check(JSON.stringify([...selectSidecars(capped, { bytes: 25 }).keys()]) === '["1","2","4"]', "at most `bytes` bytes in all");
} finally {
  rmSync(root, { recursive: true, force: true });
}
if (failed) process.exit(1);
console.log("sidecar: all checks pass");
