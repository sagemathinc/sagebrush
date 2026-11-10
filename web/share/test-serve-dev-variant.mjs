// ci: web-sync.1 order=16
// Tests for web/share/serve-dev.mjs's devVariant: which share server and migrations it runs, and its refusals (a set
// variable naming no file never falls back to this directory's).
//   node web/share/test-serve-dev-variant.mjs
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { devVariant, startDev } from "./serve-dev.mjs";

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

// startDev's ports (the EADDRINUSE of master 1246a589): both servers listen before anything else starts, so a port of 0
// is held from the moment it is chosen.  Each row stops startDev from its onBound hook (both ports held, no Worker built
// yet), so no row waits on anything but the listens themselves.
const STOP = new Error("stopped at onBound");
const takes = (port) => new Promise((resolve) => {
  const s = createServer();
  s.once("error", (e) => resolve(e.code));
  s.listen(port, "127.0.0.1", () => s.close(() => resolve("listened")));
});
const portOf = (url) => Number(new URL(url).port);
let bound = null, held = null, early = null;
// (bounded, so a request left open fails this row rather than hanging the run)
const answer = async (url) => { try { const r = await fetch(url + "/", { signal: AbortSignal.timeout(10_000) }); return `${r.status} ${await r.text()}`; } catch (e) { return `no answer (${e.name})`; } };
const r0 = await startDev({ sitePort: 0, filesPort: 0, onBound: async (b) => { bound = b; held = [await takes(portOf(b.site)), await takes(portOf(b.files))]; early = [await answer(b.site), await answer(b.files)]; throw STOP; } }).then(() => "resolved", (e) => e);
ok(r0 === STOP && bound && /^http:\/\/127\.0\.0\.1:\d+$/.test(bound.site) && /^http:\/\/127\.0\.0\.1:\d+$/.test(bound.files) && portOf(bound.site) > 0 && portOf(bound.files) > 0 && portOf(bound.site) !== portOf(bound.files), `ports 0: two distinct ports chosen by the system, the URLs made from them, before the Worker: ${JSON.stringify(bound)}`);
ok(JSON.stringify(held) === '["EADDRINUSE","EADDRINUSE"]', `...and held from then on: another listen on either is refused (${JSON.stringify(held)})`);
ok(JSON.stringify(bound?.addresses) === '["127.0.0.1","127.0.0.1"]', `...both listening on the loopback address only (${JSON.stringify(bound?.addresses)})`);
ok(JSON.stringify(early) === '["503 starting","503 starting"]', `...and a request before the Worker is up is answered 503 "starting", never left open (${JSON.stringify(early)})`);
ok(JSON.stringify([await takes(portOf(bound.site)), await takes(portOf(bound.files))]) === '["listened","listened"]', "...and released when startDev fails after binding (both servers closed)");
// a failure in the Worker's stage, after both ports are held (an entry that doesn't build): both released too
const bad = mkdtempSync(join(tmpdir(), "serve-dev-bad-"));
const badEntry = join(bad, "test-entry.ts");
writeFileSync(badEntry, "export default {{{ this doesn't build\n");
const saved = { e: process.env.SHARE_DEV_ENTRY, m: process.env.SHARE_DEV_MIGRATIONS, x: process.env.SHARE_DEV_EXPECT };
Object.assign(process.env, { SHARE_DEV_ENTRY: badEntry, SHARE_DEV_MIGRATIONS: JSON.stringify([m1]), SHARE_DEV_EXPECT: "core" });
let wb = null;
const r3 = await startDev({ sitePort: 0, filesPort: 0, onBound: async (b) => { wb = b; } }).then(() => "resolved", (e) => e);
for (const [k, v] of [["SHARE_DEV_ENTRY", saved.e], ["SHARE_DEV_MIGRATIONS", saved.m], ["SHARE_DEV_EXPECT", saved.x]]) if (v === undefined) delete process.env[k]; else process.env[k] = v;
rmSync(bad, { recursive: true, force: true });
ok(r3 instanceof Error && r3 !== STOP && wb !== null, `the Worker's stage failing after both ports are held (an entry that doesn't build): startDev rejects (${String(r3?.message ?? r3).split("\n")[0].slice(0, 80)})`);
ok(wb && JSON.stringify([await takes(portOf(wb.site)), await takes(portOf(wb.files))]) === '["listened","listened"]', "...and both ports are released (both servers closed)");
// an explicit port still works, and a taken one is refused as an error startDev returns, never an unhandled event
const blocker = createServer();
const taken = await new Promise((r) => blocker.listen(0, "127.0.0.1", () => r(blocker.address().port)));
let reached = false;
const r1 = await startDev({ sitePort: 0, filesPort: taken, onBound: async () => { reached = true; throw STOP; } }).then(() => "resolved", (e) => e);
ok(r1?.code === "EADDRINUSE" && !reached, `an explicit port already taken: startDev rejects with EADDRINUSE before onBound (${r1?.code ?? r1})`);
blocker.close();
let explicit = null;
const free = await new Promise((r) => { const s = createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => r(p)); }); });
const r2 = await startDev({ sitePort: free, filesPort: 0, onBound: async (b) => { explicit = b; throw STOP; } }).then(() => "resolved", (e) => e);
ok(r2 === STOP && explicit?.site === `http://127.0.0.1:${free}`, `an explicit free port: the site listens on exactly it (${explicit?.site})`);
console.log(failures ? `${failures} failed` : "all passed");
process.exit(failures ? 1 : 0);
