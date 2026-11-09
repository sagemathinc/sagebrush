// ci: web-sync.1 order=16
// Tests for web/share/serve-dev.mjs's devVariant: which share server and migrations it runs, and its refusals (a set
// variable naming no file never falls back to this directory's).
//   node web/share/test-serve-dev-variant.mjs
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { devVariant } from "./serve-dev.mjs";

const here = dirname(fileURLToPath(import.meta.url));
let failures = 0;
const ok = (c, what) => { if (!c) { failures++; console.log("FAIL " + what); } };
const refuses = (env, re, what) => {
  try { devVariant(env); ok(false, `${what}: accepted`); } catch (e) { ok(re.test(String(e.message)), `${what}: ${e.message}`); }
};
const entry = join(here, "test-entry.ts");
const m1 = join(here, "migrations", "0001_init.sql"), m2 = join(here, "migrations", "0002_purge_indexes.sql");

const d = devVariant({});
ok(d.entry === entry && d.expect === "core", "the default: this directory's test entry, expecting core");
ok(d.migrations.length >= 5 && d.migrations[0] === m1 && d.migrations.every((m, i) => i === 0 || d.migrations[i - 1] < m), "the default migrations: this directory's, in name order");
const e = devVariant({ SHARE_DEV_ENTRY: entry, SHARE_DEV_MIGRATIONS: JSON.stringify([m2, m1]), SHARE_DEV_EXPECT: "hosted" });
ok(e.entry === entry && e.migrations.join() === [m2, m1].join() && e.expect === "hosted", "the variables: that entry, those migrations in the order given, that expectation");
refuses({ SHARE_DEV_ENTRY: entry }, /set together/, "an entry alone");
refuses({ SHARE_DEV_MIGRATIONS: JSON.stringify([m1]) }, /set together/, "migrations alone");
refuses({ SHARE_DEV_ENTRY: join(here, "no-such-entry.ts"), SHARE_DEV_MIGRATIONS: JSON.stringify([m1]) }, /SHARE_DEV_ENTRY: no such file/, "a missing entry");
refuses({ SHARE_DEV_ENTRY: here, SHARE_DEV_MIGRATIONS: JSON.stringify([m1]) }, /SHARE_DEV_ENTRY: no such file/, "an entry that is a directory");
refuses({ SHARE_DEV_ENTRY: entry, SHARE_DEV_MIGRATIONS: JSON.stringify([m1, join(here, "migrations", "9999_none.sql")]) }, /SHARE_DEV_MIGRATIONS: no such file/, "a missing migration");
refuses({ SHARE_DEV_ENTRY: entry, SHARE_DEV_MIGRATIONS: "[oops" }, /isn't a JSON array/, "malformed JSON");
refuses({ SHARE_DEV_ENTRY: entry, SHARE_DEV_MIGRATIONS: "[]" }, /non-empty JSON array/, "an empty list");
refuses({ SHARE_DEV_ENTRY: entry, SHARE_DEV_MIGRATIONS: JSON.stringify([entry]) }, /\.sql paths/, "a non-.sql path");
refuses({ SHARE_DEV_ENTRY: "", SHARE_DEV_MIGRATIONS: JSON.stringify([m1]) }, /set together/, "an empty entry");
refuses({ SHARE_DEV_EXPECT: "both" }, /"core" or "hosted"/, "an unknown expectation");
console.log(failures ? `${failures} failed` : "all passed");
process.exit(failures ? 1 : 0);
