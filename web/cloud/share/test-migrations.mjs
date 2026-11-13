// ci: web-sync.1 order=15
// Tests for web/cloud/share/migrations.mjs: the merged order of the share database's migrations, and its refusals.
//   node web/cloud/share/test-migrations.mjs
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrations } from "./migrations.mjs";

let failures = 0;
const ok = (c, what) => { if (!c) { failures++; console.log("FAIL " + what); } };
const names = (ms) => ms.map((m) => m.name).join(",");

// (the repository's own: core's 0001-0005, then this directory's 0006-0010, contiguous)
const real = migrations();
ok(names(real) === "0001_init.sql,0002_purge_indexes.sql,0003_sync_accounts.sql,0004_version_titles.sql,0005_upload_receipts.sql,0006_admin_visibility.sql,0007_client_floor.sql,0008_activity.sql,0009_remotes.sql,0010_remote_usage.sql,0011_remote_agents.sql", `the repository's order: ${names(real)}`);
ok(real.slice(0, 5).every((m) => m.path.includes(join("web", "share", "migrations"))) && real.slice(5).every((m) => m.path.includes(join("web", "cloud", "share", "migrations"))), "each from its own directory");

const root = mkdtempSync(join(tmpdir(), "share-migrations-"));
const dirs = (spec) => spec.map((files, i) => {
  const d = join(root, String(Math.random()).slice(2), String(i));
  mkdirSync(d, { recursive: true });
  for (const f of files) writeFileSync(join(d, f), "-- x\n");
  return d;
});
const throws = (spec, re, what) => {
  try { migrations(dirs(spec)); ok(false, `${what}: no error`); } catch (e) { ok(re.test(String(e.message)), `${what}: ${e.message}`); }
};
try {
  ok(names(migrations(dirs([["0001_a.sql", "0003_c.sql"], ["0002_b.sql", "0004_d.sql", "notes.txt"]]))) === "0001_a.sql,0002_b.sql,0003_c.sql,0004_d.sql", "interleaved across the two directories, by name; other files ignored");
  throws([["0001_a.sql", "0002_b.sql"], ["0002_x.sql"]], /two migrations numbered 0002/, "a number in both directories");
  throws([["0001_a.sql", "0001_b.sql"], []], /two migrations numbered 0001/, "a number twice in one directory");
  throws([["0001_a.sql", "0002_b.sql"], ["0004_d.sql"]], /migration 0003 is missing/, "a gap");
  throws([["0002_b.sql"], []], /migration 0001 is missing/, "no 0001");
  throws([["0001_a.sql"], ["7_b.sql"]], /without a four-digit number/, "a malformed name");
} finally {
  rmSync(root, { recursive: true, force: true });
}
console.log(failures ? `${failures} failed` : "all passed");
process.exit(failures ? 1 : 0);
