// ci: web-sync.1 order=14
// Tests for the account's authority (web/remote/account.ts, step b2b), in Miniflare with the RemoteAccount Durable
// Object bound (SQLite storage, a logical clock) and a real D1 with web/share's migrations:
//
// - leases: kind-aware sizes (4 MiB runner, 16 MiB agent); at most 2 outstanding per remote; the 2 GiB UTC-day
//   budget exactly at its edge (the last lease that fits, then "budget"); a day's leases void at its end and today's
//   budget fresh; settling idempotent, never giving a grant back;
// - slots: at most 2 connected per account; the same remote's newer gen takes its own slot over, an older one never
//   takes it back; a release frees only the gen that holds it;
// - reporting: D1's remote_usage written by the alarm, once a minute, and only while there is something new.
//
//   node web/cloud/remote/test-account.mjs
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { migrations } from "../share/migrations.mjs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(here, "../../site/package.json"));
const { Miniflare, convertV4MiniflareOptions } = require("miniflare");

let failures = 0, count = 0;
function ok(cond, what) {
  count++;
  if (!cond) {
    failures++;
    console.log("FAIL", what);
  }
}
const MiB = 1024 * 1024, GiB = 1024 * MiB;
const script = execFileSync("bun", ["build", join(here, "test-account-entry.ts"), "--format", "esm", "--target", "browser", "--external", "cloudflare:workers"], { encoding: "utf8" });
const mf = new Miniflare(convertV4MiniflareOptions({
  workers: [{ name: "account", modules: true, script, compatibilityDate: "2026-10-01", d1Databases: ["SHARE_DB"],
    durableObjects: { REMOTE_ACCOUNT: { className: "TestRemoteAccount", useSQLite: true } } }],
}));
const db = await mf.getD1Database("SHARE_DB");
for (const { path: m } of migrations())
  for (const s of readFileSync(m, "utf8").replace(/--.*$/gm, "").split(";").map((s) => s.trim()).filter(Boolean)) await db.prepare(s).run();

const call = async (acct, op, body) => {
  const r = await mf.dispatchFetch(`https://t/a/${acct}/${op}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
};
const at = async (acct, ms) => (await mf.dispatchFetch(`https://t/a/${acct}/__clock?ms=${ms}`)).json();
const state = async (acct) => (await mf.dispatchFetch(`https://t/a/${acct}/__state`)).json();
const alarm = async (acct) => (await mf.dispatchFetch(`https://t/a/${acct}/__alarm`)).json();
const NOON = Date.UTC(2026, 10, 6, 12, 0, 0);
const MIDNIGHT = Date.UTC(2026, 10, 7, 0, 0, 0);

// ---- leases: sizes, outstanding, settle
{
  const a = "acct-sizes";
  const r1 = await call(a, "lease", { remote_id: "rA", kind: "runner", account: a });
  const g1 = await call(a, "lease", { remote_id: "gA", kind: "agent" });
  ok(r1.status === 200 && r1.body.bytes === 4 * MiB && r1.body.day === "2026-11-06" && g1.body.bytes === 16 * MiB,
    `leases: a runner's is 4 MiB, an agent's 16 MiB, stamped with the UTC day (${JSON.stringify(r1.body)}, ${g1.body.bytes})`);
  const r2 = await call(a, "lease", { remote_id: "rA", kind: "runner" });
  const r3 = await call(a, "lease", { remote_id: "rA", kind: "runner" });
  ok(r2.status === 200 && r3.status === 429 && r3.body.error === "leases", `leases: at most 2 outstanding per remote (${r3.status} ${r3.body.error})`);
  ok((await call(a, "settle", { id: r1.body.id, consumed: 1000 })).status === 200, "settle: ok");
  const r4 = await call(a, "lease", { remote_id: "rA", kind: "runner" });
  ok(r4.status === 200, "settling one frees its place among the outstanding");
  await call(a, "settle", { id: r1.body.id, consumed: 999999 }); // (again: no effect)
  await call(a, "settle", { id: r2.body.id, consumed: 10 * MiB }); // (more than granted: counted as the lease's bytes)
  const st = await state(a);
  const day = st.days.find((d) => d.day === "2026-11-06");
  ok(day.granted === 4 * MiB * 3 + 16 * MiB && day.consumed === 1000 + 4 * MiB, `settle: idempotent, capped at the lease, never refunding the grant (${JSON.stringify(day)})`);
  ok((await call(a, "settle", { id: "nope", consumed: 1 })).status === 404 && (await call(a, "settle", { id: r1.body.id, consumed: -1 })).status === 400
    && (await call(a, "lease", { remote_id: "r A", kind: "runner" })).status === 400 && (await call(a, "lease", { remote_id: "rA", kind: "constructor" })).status === 400,
    "requests: an unknown lease 404; a negative consumed, a bad id or kind 400");
}

// ---- the day budget at its edge, and the day's end
{
  const a = "acct-budget";
  const per = 4 * MiB, fits = Math.floor(2 * GiB / per); // (512 runner leases make exactly 2 GiB)
  let granted = 0, refused = null;
  for (let i = 0; i < fits + 1; i++) {
    const r = await call(a, "lease", { remote_id: `r${i % 300}x${Math.floor(i / 300)}`, kind: "runner" });
    if (r.status === 200) granted += r.body.bytes;
    else { refused = r; break; }
  }
  ok(granted === 2 * GiB && refused?.status === 429 && refused.body.error === "budget", `budget: exactly 2 GiB granted, then "budget" (${granted}, ${refused?.body?.error})`);
  // (an agent's 16 MiB never squeezes past the edge either)
  ok((await call(a, "lease", { remote_id: "g1", kind: "agent" })).body.error === "budget", "budget: an agent's lease past the edge is refused too");
  // (the day's end: yesterday's leases void (they don't count as outstanding), today's budget fresh)
  await at(a, MIDNIGHT);
  const t = await call(a, "lease", { remote_id: "r0x0", kind: "runner" });
  const t2 = await call(a, "lease", { remote_id: "r0x0", kind: "runner" });
  ok(t.status === 200 && t.body.day === "2026-11-07" && t2.status === 200, `midnight UTC: a fresh budget, yesterday's outstanding leases void (${JSON.stringify(t.body)})`);
  await at(a, MIDNIGHT - 1);
  ok((await call(a, "lease", { remote_id: "zz", kind: "runner" })).body.error === "budget", "one ms before midnight: still yesterday's spent budget");
}

// ---- slots
{
  const a = "acct-slots";
  ok((await call(a, "acquire", { remote_id: "r1", gen: 1 })).status === 200 && (await call(a, "acquire", { remote_id: "r2", gen: 1 })).status === 200, "slots: two remotes connect");
  const third = await call(a, "acquire", { remote_id: "r3", gen: 1 });
  ok(third.status === 429 && third.body.error === "connected", `slots: a third is refused (${third.status} ${third.body.error})`);
  ok((await call(a, "acquire", { remote_id: "r1", gen: 2 })).status === 200, "slots: the same remote's newer connection takes its own slot");
  ok((await call(a, "acquire", { remote_id: "r1", gen: 1 })).status === 409, "slots: an older gen never takes it back");
  ok((await call(a, "release", { remote_id: "r1", gen: 1 })).body.released === false && (await call(a, "acquire", { remote_id: "r3", gen: 1 })).status === 429,
    "slots: a late release (the old gen) frees nothing");
  ok((await call(a, "release", { remote_id: "r1", gen: 2 })).body.released === true && (await call(a, "acquire", { remote_id: "r3", gen: 1 })).status === 200,
    "slots: the holder's release frees it, and a third remote then connects");
  ok((await call(a, "acquire", { remote_id: "r4", gen: 0 })).status === 400 && (await call(a, "acquire", { remote_id: "r4", gen: 1.5 })).status === 400, "slots: a bad gen is 400");
}

// ---- reporting
{
  const a = "acct-report";
  // (a clock ahead of the real one: Miniflare runs an alarm whose time has passed at once)
  const LATER = Date.UTC(2030, 0, 15, 12, 0, 0);
  await at(a, LATER);
  await call(a, "lease", { remote_id: "r1", kind: "runner", account: a });
  let st = await state(a);
  ok(st.alarm === LATER + 60_000, `reporting: an alarm a minute later (${st.alarm})`);
  await alarm(a);
  const row = await db.prepare("SELECT * FROM remote_usage WHERE account = ?").bind(a).first();
  ok(row && row.day === "2030-01-15" && row.granted === 4 * MiB && row.consumed === 0, `reporting: D1 has the day's totals (${JSON.stringify(row)})`);
  st = await state(a);
  ok(st.days[0].reported === 4 * MiB, "reporting: what was said is remembered, so an alarm with nothing new writes nothing");
}

console.log(`${count - failures}/${count} account tests passed`);
await mf.dispose();
process.exit(failures ? 1 : 0);
