// ci: web-sync.8 order=20 env=LTI_CONTENT_PART=1
// ci: web-sync.9 order=10 env=LTI_CONTENT_PART=2
// Tests for amendment 3 r15's A3-2 (plan-lti-r5 amendment 3 §2.4, §2.5, §7;
// the delivery delta 973bde2d; the A3-2 delta 70042e0f): checkpoints and the
// revoking barrier, delete intents, the sweep and the scan with their work
// bounds, and the restore runbook, in Miniflare against LtiContent, the
// LtiBundles bucket and LtiContentGate.  Synthetic data only.
//
// A Time Travel restore is simulated by a logical snapshot of LtiContent (every
// table's rows and every trigger), put back in one D1 batch in the same
// Miniflare instance, so a stale batch held from before the restore can still
// land after it (astra's r8 trace).  The gate's clock can run `scale` times real
// time; D1 and R2 calls are real.
//
// CI runs it in two parts, each its own job under 10 minutes (the cloud CI split, @sagebrush's ruling of Nov 9):
// LTI_CONTENT_PART=1, the checkpoints, delete intents, the sweep, the backstop scan, the restore recovery, D3 r2's
// below-threshold measurement, #18's regressions and D3 r2's steady state (its dense window and above-threshold
// measurement, checked against the below one, so both stay in one part); 2, the load (the barrier over time, the
// sustained mixes, recovery at scale), the restore that misses its checkpoint, and the verifier's fixtures.  Unset,
// both, in this order.  Each part runs the setup and the helpers between the sections: only the sections' own blocks
// (and D3 r2's below-threshold measurement) are split
//   node web/cloud/lti/test-content.mjs                  (LTI_CONTENT_PART=1 or 2 for one part)
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { createHash, createHmac, generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { dispatch } from "../../miniflare-dispatch.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const { verify, verifyBarrier, timerAccounting, requestedGaps, rawD4Failures, PROTECTED_MAX_MS } = await import(join(here, "vm-content-verify.mjs"));
const require = createRequire(join(here, "../../site/package.json"));
const { Miniflare, convertV4MiniflareOptions } = require("miniflare");

let failures = 0, count = 0;
const PART = process.env.LTI_CONTENT_PART ?? "";
if (PART !== "" && PART !== "1" && PART !== "2") {
  console.log(`FAIL LTI_CONTENT_PART is ${JSON.stringify(PART)}, not 1, 2 or unset`);
  process.exit(2);
}
const part = (n) => !PART || PART === n;
function ok(cond, what) {
  count++;
  if (!cond) {
    failures++;
    console.log("FAIL", what);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hex = (n) => randomBytes(n).toString("hex");

const TOOL = "https://lti.vmtest";
const LTI_KEY = "lti-test-key";
const toolKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const TOOL_KEY = JSON.stringify({ ...toolKeys.privateKey.export({ format: "jwk" }), kid: "tool1" });

const script = execFileSync("bun", ["build", join(here, "test-entry.ts"), "--format", "esm", "--target", "browser", "--external", "cloudflare:workers"], { encoding: "utf8" });
const objects = { LTI_REG: { className: "LtiReg", useSQLite: true }, LTI_SHARD: { className: "LtiLaunchShard", useSQLite: true }, LTI_COURSE: { className: "LtiCourse", useSQLite: true }, LTI_FLEET: { className: "LtiFleet", useSQLite: true }, LTI_GATE: { className: "LtiContentGate", useSQLite: true } };
const mf = new Miniflare(convertV4MiniflareOptions({
  workers: [{
    name: "lti", modules: true, script, compatibilityDate: "2026-10-01",
    bindings: { ENV: "vm-test", LTI_ORIGIN: TOOL, LTI_KEY, TOOL_KEY, LTI_SYNTHETIC_ENTITLEMENT: "1", MAPPING_BACKUP_KEY: "backup-test-key", COCALC_ORIGIN: "https://cocalc.vmtest" },
    d1Databases: ["LTI_DB", "LTI_AUDIT", "LTI_CONTENT"], r2Buckets: ["LTI_BUNDLES"], durableObjects: objects, routes: ["lti.vmtest/*"],
    outboundService: () => new Response("not found", { status: 404 }),
    ratelimits: { LTI_PREAUTH: { namespace_id: "2101", simple: { limit: 1000000, period: 60 } } },
  }],
}));

function splitSql(sql) {
  const out = [];
  let cur = [], inTrigger = false;
  for (const raw of sql.split("\n")) {
    const line = raw.replace(/--.*$/, "").trimEnd();
    if (!line.trim()) continue;
    cur.push(line);
    if (/^\s*CREATE\s+TRIGGER/i.test(line)) inTrigger = true;
    if (inTrigger ? /^\s*END;\s*$/i.test(line) : /;\s*$/.test(line)) {
      out.push(cur.join("\n").replace(/;\s*$/, ""));
      cur = [];
      inTrigger = false;
    }
  }
  return out;
}
async function migrate(db, dir) {
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort())
    for (const s of splitSql(readFileSync(join(dir, f), "utf8"))) await db.prepare(s).run();
}
await migrate(await mf.getD1Database("LTI_DB", "lti"), join(here, "migrations"));
await migrate(await mf.getD1Database("LTI_AUDIT", "lti"), join(here, "migrations", "audit"));
const content = await mf.getD1Database("LTI_CONTENT", "lti");
await migrate(content, join(here, "migrations", "content"));
const r2 = await mf.getR2Bucket("LTI_BUNDLES", "lti");

const tool = (path, init) => dispatch(mf, TOOL + path, { redirect: "manual", ...init });
const j = (r) => r.json();
async function admin(path, body) {
  const t = Date.now();
  const b = JSON.stringify({ request_id: randomUUID().replace(/-/g, ""), ...body });
  const sig = createHmac("sha256", LTI_KEY).update(`POST\n${path}\n${t}\n${b}`).digest("hex");
  return tool(path, { method: "POST", headers: { "content-type": "application/json", "x-lti-time": String(t), "x-lti-signature": sig }, body: b });
}
const sha256hex = (b) => createHash("sha256").update(b).digest("hex");
async function putBundle(owner, body) {
  const t = Date.now(), buf = Buffer.from(body);
  const meta = JSON.stringify({ actor_ref: "a", owner_ref: owner, request_id: randomUUID().replace(/-/g, ""), sha256: sha256hex(buf), size: buf.length });
  const sig = createHmac("sha256", LTI_KEY).update(`PUT\n/lti/admin/bundle\n${t}\n${meta}`).digest("hex");
  return tool("/lti/admin/bundle", { method: "PUT", headers: { "x-lti-time": String(t), "x-lti-signature": sig, "x-lti-meta": meta }, body: buf });
}
const cgate = async (m, ...args) => j(await tool("/__test/cgate", { method: "POST", body: JSON.stringify({ m, args }) }));
const seam = (op) => cgate("testSeam", op);
const gstate = () => cgate("testState");
const reset = () => seam({ bucket: "reset" });
const testGate = (name, on) => tool("/__test/gate", { method: "POST", body: JSON.stringify({ name, on, once: true }) });
const parkedOn = async (name) => {
  for (let i = 0; i < 1000 && !(await j(await tool(`/__test/gate?name=${name}`))).parked; i++) await sleep(10);
};
const wake = async (opts = {}) => j(await tool("/__test/content-wake", { method: "POST", body: JSON.stringify(opts) }));
const keyOf = async (owner, sha, token) => (await j(await tool(`/__test/bundle-key?owner=${owner}&sha=${sha}&token=${token}`))).key;
const q = (sql, ...p) => content.prepare(sql).bind(...p).first();
const qa = async (sql, ...p) => (await content.prepare(sql).bind(...p).all()).results;
const quota = (scope, kind) => q("SELECT count, bytes FROM quota WHERE scope = ? AND kind = ?", scope, kind);
const issR = async (kind, owner) => {
  for (let i = 0; ; i++) {
    const t = await cgate("issue", kind, owner);
    if (t.ok || t.status !== 429 || t.code === "rate" || i >= 60) return t;
    await sleep(200);
  }
};
const asg = async (body) => {
  for (let i = 0; ; i++) {
    await reset();
    const r = await admin("/lti/admin/assignment", { actor_ref: "a", title: "T", runtime_policy: "either", max_points: 5, visibility: "institution", ...body });
    if (r.status !== 429 || i >= 40) return r;
    await sleep(200);
  }
};
const upload = async (owner, body) => {
  for (let i = 0; ; i++) {
    await reset();
    const r = await putBundle(owner, body);
    if (r.status !== 429 || i >= 40) return r;
    await sleep(200);
  }
};
const held = async (owner, label = randomUUID()) => {
  const body = `synthetic bundle ${label}`;
  const r = await upload(owner, body);
  if (r.status !== 200) throw new Error(`upload ${r.status} ${await r.text()}`);
  const sha = sha256hex(Buffer.from(body));
  const row = await q("SELECT token FROM bundles WHERE owner_ref = ? AND sha = ?", owner, sha);
  return { sha, token: row.token, key: await keyOf(owner, sha, row.token), size: Buffer.byteLength(body) };
};
/** A fenced write from the test, as a wake or an operator would make it: a ticket, one gate.write, the ticket returned. */
const fenced = async (stmts, kind = "wake") => {
  const t = await issR(kind, kind === "wake" ? null : "test-owner");
  if (!t.ok) {
    const st = await gstate();
    throw new Error(`issue ${JSON.stringify(t)}; gate ${JSON.stringify({ mode: st.mode, R: st.R, ckpt: st.ckpt, calls: st.calls, probe_meta: st.probe_meta, mode_log: st.mode_log })}`);
  }
  try {
    return await cgate("write", t.id, stmts);
  } finally {
    await cgate("giveBack", t.id);
  }
};
// (the scheduled wake, its lease taken as if the last one ended: each test wake starts with the lease free)
const freeLease = () => fenced([{ sql: "UPDATE sweep_lease SET until = 0 WHERE one = 1" }]);
/** Age a bundle row on D1's own clock by `ms` (its deadline, held_at and due move back): time passing, for the sweep. */
const age = (token, ms) => fenced([{ sql: "UPDATE bundles SET deadline = deadline - ?, held_at = held_at - ?, due = due - ? WHERE token = ?", params: [ms, ms, ms, token] }]);

await seam({ checkpoints: "manual" });
// the first issue probes; every later probe-dependent test starts from a good one
const probe = await cgate("probe");
ok(probe.ok, `(the probe: ${JSON.stringify(probe)})`);

// ================= checkpoints (r9–r15)
if (part("1")) {
  // one checkpoint: the log row, two gaps of 2.0–2.1 s, issue paused throughout, nothing sent inside the gaps
  const s0 = await gstate();
  const t0 = Date.now();
  const cp = cgate("checkpointNow");
  await sleep(300);
  const during = await cgate("issue", "assignment", "ck1");
  // (a write queued during the interval waits for the whole of it)
  const tw = await issR("assignment", "ck0").catch(() => null);
  const cpr = await cp;
  const s1 = await gstate();
  const log = await cgate("checkpoints", 5);
  const row = await q("SELECT kind, nonce FROM gate_calls WHERE seq = ?", cpr.k);
  ok(cpr.outcome === "done" && log[0]?.k === cpr.k && row?.kind === "checkpoint" && row.nonce === log[0].nonce && Math.abs(log[0].d1_time - Date.now()) < 60_000, `a checkpoint writes its chain row and logs {k, nonce, d1_time} (${JSON.stringify(cpr)})`);
  ok(cpr.gaps?.length === 2 && cpr.gaps.every((g) => g >= 2000 && g <= 2120), `each quiet gap is 2.0 to 2.1 s (${cpr.gaps})`);
  ok(!during.ok && during.status === 429 && during.code === "checkpoint", `issue answers 429 throughout the interval (${JSON.stringify(during)})`);
  ok(s1.sends - s0.sends === 1 && Date.now() - t0 >= 4000, `nothing but the checkpoint is sent in the interval (${s1.sends - s0.sends} sends)`);
  if (tw?.ok) await cgate("giveBack", tw.id);

  // remaining time (daybreak3 r12): a ticket with 60 s left postpones the first attempt unless it returns within 10 s
  const t60 = await issR("assignment", "ck2");
  await seam({ issued_ago: { id: t60.id, ms: 60_000 } });
  const c60 = cgate("checkpointNow");
  await sleep(1000);
  await cgate("giveBack", t60.id);
  const r60 = await c60;
  ok(r60.outcome === "done", `a ticket with 60 s left holds the first attempt; once it returns, the checkpoint runs (${r60.outcome})`);

  // the 109/120 pair (daybreak3 r13/r14): attempt 1 postponed (issue resumed); attempt 2 revokes A and starts with B
  const A = await issR("assignment", "ck3");
  await seam({ issued_ago: { id: A.id, ms: 11_000 } });
  const p1 = await cgate("checkpointNow");
  // (A now has < 100 s left; B, issued now, has 120 s: the pair at the second attempt)
  const B = await issR("assignment", "ck4");
  const between = await issR("assignment", "ck5");
  const st1 = await gstate();
  ok(p1.outcome === "postponed" && between.ok && Math.abs(st1.ckpt_next - (Date.now() + 60_000)) < 15_000, `attempt 1, with a ticket at 109 s left, is postponed by 1 min, and issue resumes (${p1.outcome}, ${between.ok})`);
  await cgate("giveBack", between.id);
  const p2 = await cgate("checkpointNow");
  const wa = await cgate("write", A.id, [{ sql: "SELECT 1" }]), wb = await cgate("write", B.id, [{ sql: "SELECT 1" }]);
  ok(p2.outcome === "done" && p2.revoked === 1 && !wa.ok && wa.code === "ticket_expired" && wb.ok, `attempt 2 revokes the ticket with < 110 s left and starts at once with the other; the revoked one's next call is 409 ticket_expired (${JSON.stringify(p2)}, ${wa.code})`);
  const A2 = await issR("assignment", "ck3");
  ok(A2.ok && (await cgate("write", A2.id, [{ sql: "SELECT 1" }])).ok, "...and the revoked operation completes with a new ticket after the checkpoint");
  for (const t of [A, B, A2]) await cgate("giveBack", t.id);
  // a revoked upload's later hold is refused (its reservation is the sweep's)
  await testGate("bundle_before_hold", true);
  await reset();
  const upBody = "synthetic bundle: revoked upload";
  const up = putBundle("ownerRV", upBody);
  await parkedOn("bundle_before_hold");
  await seam({ ckpt_attempt: 1 });
  // (an upload ticket lives 11 min: make it one with < 110 s left)
  const live = (await gstate()).tickets.find((x) => x.kind === "upload");
  await seam({ issued_ago: { id: live.id, ms: 11 * 60_000 - 100_000 } });
  const p3 = await cgate("checkpointNow");
  await testGate("bundle_before_hold", false);
  const upr = await up;
  const rv = await q("SELECT state FROM bundles WHERE owner_ref = 'ownerRV' AND sha = ?", sha256hex(Buffer.from(upBody)));
  ok(p3.outcome === "done" && p3.revoked >= 1 && upr.status === 503 && rv?.state === "reserved", `a revoked upload's later hold is refused, and its row stays reserved for the sweep (${p3.revoked}, ${upr.status}, ${rv?.state})`);

  // a checkpoint whose queue doesn't drain within 10 s is postponed, and issue resumes (gate clock ×10)
  await seam({ scale: 10, seam: { op: "delay", ms: 1500, count: 1 } });
  const tq = await issR("assignment", "ck6");
  const inflight = cgate("write", tq.id, [{ sql: "SELECT 1" }]);
  await sleep(50);
  const pq = await cgate("checkpointNow");
  const after = await issR("assignment", "ck7");
  await inflight;
  await seam({ scale: 1, ckpt_attempt: 0 });
  ok(pq.outcome === "postponed" && after.ok, `a checkpoint whose queue doesn't drain within 10 s is postponed, and issue resumes (${pq.outcome})`);
  for (const t of [tq, after]) await cgate("giveBack", t.id);

  // the D4 r3 phase bounds, RAW (the #18 timing rulings, astra3 0ca0422a, daybreak3 71188d1b): the checkpoint call and its
  // tombstone each hit the 30 s deadline (gate clock ×10); rawD4Failures: two sends in the protected part, protected
  // ≤ 64,200 ms with no slack (CORR-PRIVATE18-TIMING-1, -2), decision → end ≤ 125.2 s, due → end ≤ 197.2 s plus its
  // alarms' firing delays (a direct call: due now, no alarm); each measured gap 1.99–2.3 s; separately, each REQUESTED gap in [2000, 2100] gate-ms
  // and the timer accounting valid. The accounting's adjusted figures (raw minus the overshoot of the checkpoint's own
  // awaited timers) are a diagnostic only, printed with every record on the TIMING line; the pass condition is raw.
  // A CONTROLLED LOWER-GAP RUNTIME CASE, not a worst-gap qualification (the ruling's option (c)): both requested gaps are
  // fixed at 2,000 ms (the gap_ms seam), so the requested work is 64,000 ms and the strict raw 64,200 keeps headroom for
  // ×10-amplified timer lateness. The upper endpoint (both gaps 2,100: requested work exactly 64,200) is proven by the
  // deterministic virtual case below; the random [2000, 2100] draw by the ×1 run and the first virtual case
  await seam({ scale: 10, seam: { op: "delay", ms: 3500, count: 2 }, ckpt_next: Date.now(), gap_ms: 2000 });
  const pb = await cgate("checkpointNow");
  await seam({ scale: 1, gap_ms: 0 });
  const pbAcc = timerAccounting(pb), pbGaps = requestedGaps(pb);
  const pbDiag = JSON.stringify({ outcome: pb.outcome, raw: { protected_ms: pb.protected_ms, decision_to_end_ms: pb.decision_to_end_ms, interval_ms: pb.interval_ms, due_to_end_ms: pb.due_to_end_ms, fire_delay_ms: pb.fire_delay_ms, gaps: pb.gaps, sends_in_protected: pb.sends_in_protected }, requested_gaps: pbGaps, accounting: pbAcc, marks: pb.marks, timers: pb.timers });
  console.log("TIMING bound x10", pbDiag);
  const pbRaw = rawD4Failures(pb);
  ok(pbRaw.length === 0 && pb.gaps.every((g) => g >= 1990 && g <= 2300), `D4 r3, raw (a controlled lower-gap runtime case, both gaps requested at 2,000): with both the checkpoint call and its tombstone at the 30 s deadline, two sends in the protected part, protected ≤ ${PROTECTED_MAX_MS} ms with no slack, decision → end ≤ 125.2 s, due → end ≤ 197.2 s plus firing delays, each measured gap 1.99–2.3 s (${pbRaw.join("; ") || "raw clean"}; ${pbDiag})`);
  ok(pbGaps.length === 2 && pbGaps.every((g) => g === 2000) && pbAcc.failures.length === 0, `...exactly two requested gaps, each exactly 2,000 gate-ms, and its timer accounting valid (diagnostic only: protected raw ${pbAcc.phases?.protected?.raw_ms}, overshoot ${pbAcc.phases?.protected?.overshoot_ms} gate-ms, adjusted ${pbAcc.phases?.protected?.adjusted_ms}; ${pbAcc.failures.join("; ") || "valid"})`);
  // (its batch and tombstone land late; the chain settles on the next call)
  await sleep(4000);
  const tz = await issR("assignment", "ck8");
  ok(tz.ok && (await cgate("write", tz.id, [{ sql: "SELECT 1" }])).ok && (await gstate()).calls.length === 0, "...and the chain then resolves and moves on");
  await cgate("giveBack", tz.id);

  // the requested-duration arithmetic, deterministic (astra3's ruling): a second attempt, nothing in flight, a healthy call,
  // on the virtual gate clock (each sleep advances it by exactly its length, a D1 call by nothing): each requested gap in
  // [2000, 2100]; each measured gap equal to its request; protected = the two requests exactly; decision → end = protected
  // (no in-flight wait); the accounting valid, with no overshoot on a virtual clock. "Equal" is within 0.001 ms: the gate
  // clock is ~1.8e12 ms, where a double's spacing is 2^-12 ms (0.00024 ms), so a difference of two readings may be off by
  // a few ulps; nothing timed is that small
  await seam({ bucket: "reset" });
  await sleep(1100);
  await seam({ ckpt_attempt: 1, virtual: true });
  const pv = await cgate("checkpointNow");
  await seam({ virtual: false, ckpt_attempt: 0 });
  const pvGaps = requestedGaps(pv), pvAcc = timerAccounting(pv);
  console.log("TIMING virtual", JSON.stringify({ outcome: pv.outcome, protected_ms: pv.protected_ms, decision_to_end_ms: pv.decision_to_end_ms, gaps: pv.gaps, requested_gaps: pvGaps, accounting: pvAcc }));
  ok(pv.outcome === "done" && pvGaps.length === 2 && pvGaps.every((g) => g >= 2000 && g <= 2100) && pv.gaps.length === 2 && Math.abs(pv.gaps[0] - pvGaps[0]) < 0.001 && Math.abs(pv.gaps[1] - pvGaps[1]) < 0.001 && Math.abs(pv.protected_ms - (pvGaps[0] + pvGaps[1])) < 0.001 && pv.decision_to_end_ms === pv.protected_ms && pvAcc.failures.length === 0 && pvAcc.phases.protected?.overshoot_ms === 0, `the requested-duration arithmetic on the virtual clock: protected = the two requested gaps exactly (${JSON.stringify({ outcome: pv.outcome, protected_ms: pv.protected_ms, decision_to_end_ms: pv.decision_to_end_ms, gaps: pv.gaps, requested: pvGaps, accounting: pvAcc })})`);

  // the UPPER ENDPOINT, deterministic (astra3, in the (c) ruling): both requested gaps exactly 2,100 ms (gap_ms), and the
  // checkpoint's call and its tombstone held past the deadline (the delay seam), on the virtual gate clock. Only sleeps
  // move that clock, so the arithmetic is read straight from the checkpoint's own timer records: in the protected part,
  // exactly the two gaps (2,100 each) and the two deadlines (the call's 30,000, the tombstone's shared 30,000), and no
  // other awaited timer (the internal token has refilled during the first gap), so the requested protected work is
  // 2,100 + 30,000 + 30,000 + 2,100 = 64,200 = PROTECTED_MAX_MS exactly. The ×100 scale only shortens the two real deadline
  // timers to 300 ms each; the delayed batches land later and the chain then clears. A 20 ms real-clock wait is injected
  // between the resolution's budget and its tombstone's send (resolve_gap_real_ms): real time moves no virtual gate time, so
  // the tombstone still asks for exactly 30,000 (sage's option (a); with the old real-clock deadline it asked 28,000, and a
  // single stray real ms gave the 29,900 of cloud #31's run 40256394473)
  await seam({ bucket: "reset" });
  await sleep(1100);
  await seam({ scale: 100, virtual: true, gap_ms: 2100, seam: { op: "delay", ms: 350, count: 2 }, ckpt_next: Date.now(), resolve_gap_real_ms: 20 });
  const pu = await cgate("checkpointNow");
  await seam({ virtual: false, scale: 1, gap_ms: 0, resolve_gap_real_ms: 0 });
  const puAcc = timerAccounting(pu);
  const puStart = pu.marks?.start?.mono, puEnd = pu.marks?.end?.mono;
  const puProt = (pu.timers ?? []).filter((t) => t.sched_mono >= puStart && t.resumed_mono <= puEnd);
  const puWork = puProt.reduce((a, t) => a + t.requested_gate_ms, 0);
  const puKinds = puProt.map((t) => `${t.label}:${t.requested_gate_ms}:${t.won}`);
  console.log("TIMING virtual upper endpoint", JSON.stringify({ outcome: pu.outcome, sends: pu.sends_in_protected, protected_timers: puKinds, requested_protected_work: puWork, accounting: puAcc }));
  ok(pu.outcome !== "done" && pu.sends_in_protected === 2 && JSON.stringify(requestedGaps(pu)) === "[2100,2100]" && puProt.length === 4 && JSON.stringify(puKinds) === JSON.stringify(["gap:2100:timer", "checkpoint:30000:timer", "tombstone:30000:timer", "gap:2100:timer"]) && puWork === PROTECTED_MAX_MS && puAcc.failures.length === 0, `the upper endpoint on the virtual clock: both gaps 2,100 and both deadlines held, the requested protected work is exactly ${PROTECTED_MAX_MS} ms (${JSON.stringify({ outcome: pu.outcome, sends: pu.sends_in_protected, timers: puKinds, work: puWork, accounting: puAcc.failures })})`);
  // (then the unresolved call clears, as in the runtime case: within 67 s, refused meanwhile only as resolving)
  const tUp = Date.now();
  let tUpI;
  for (;;) {
    tUpI = await cgate("issue", "assignment", "after-upper");
    if (tUpI.ok || !(tUpI.status === 429 && tUpI.code === "resolving") || Date.now() - tUp > 67_000) break;
    await sleep(200);
  }
  ok(tUpI.ok && (await gstate()).calls.length === 0, `...and the chain then clears (${JSON.stringify({ ms: Date.now() - tUp, issue: tUpI.ok || tUpI })})`);
  if (tUpI.ok) await cgate("giveBack", tUpI.id);

  // the log: each checkpoint deletes ≤ 2 rows older than 30 days; the alarm ≤ 500; full after cleanup → no checkpoint
  await seam({ ckpt_fill: 5, ckpt_fill_age_ms: 31 * 86400_000 });
  const n0 = (await gstate()).checkpoints;
  const cl = await cgate("checkpointNow");
  ok(cl.outcome === "done" && cl.cleaned === 2 && n0 >= 5, `each checkpoint deletes ≤ 2 log rows older than 30 days (${cl.outcome}, ${cl.cleaned} of 5)`);
  await seam({ ckpt_fill: 600, ckpt_fill_age_ms: 31 * 86400_000 });
  const n1 = (await gstate()).checkpoints;
  await seam({ alarm: true });
  await sleep(500);
  ok((await gstate()).checkpoints === n1 - 500, `the alarm deletes ≤ 500 old log rows (${n1} → ${(await gstate()).checkpoints})`);
  await seam({ ckpt_fill: 5000 - ((await gstate()).checkpoints - 100) });
  const atCap = await gstate();
  const s2 = atCap.sends;
  const full = await cgate("checkpointNow");
  ok(full.outcome === "full" && (await gstate()).checkpoints === atCap.checkpoints && (await gstate()).sends === s2, `at the 5,000-row cap after cleanup no checkpoint is written or sent (${full.outcome}, ${atCap.checkpoints})`);
  await seam({ ckpt_fill: 0 });
}

// ================= delete intents (CORR-LTI5A3-3)
if (part("1")) {
  const k = () => `o/${hex(16)}/${hex(32)}/${hex(16)}`;
  const w = await issR("wake", null);
  const i1 = await cgate("intent", w.id, [k(), k()]);
  ok(i1.ok && (await cgate("intents")).length === 1, "a live wake ticket's intent is admitted and stored");
  ok(!(await cgate("intent", w.id, ["o/not-a-key"])).ok && !(await cgate("intent", w.id, Array.from({ length: 1001 }, k))).ok, "an intent's keys are incarnation keys, ≤ 1,000");
  const a = await issR("assignment", "intent-owner");
  ok((await cgate("intent", a.id, [k()])).code === "ticket", "only a wake ticket may announce a delete");
  await cgate("giveBack", a.id);
  await cgate("resolveIntent", i1.id);
  ok((await cgate("intents")).length === 0, "a resolved intent is gone");
  // 20 unresolved: the 21st is refused (and no delete is issued: the wake stops at a refused intent, below)
  for (let i = 0; i < 20; i++) await cgate("intent", w.id, [k()]);
  const i21 = await cgate("intent", w.id, [k()]);
  ok(!i21.ok && i21.code === "intents_full" && (await cgate("intents")).length === 20, "with 20 unresolved intents stored, the 21st is refused");
  // paused: refused; an old normal wake's intent in recovering: refused
  await cgate("pause");
  ok((await cgate("intent", w.id, [k()])).code === "mode" || (await cgate("intents")).length === 20, "a paused gate refuses a new intent");
  await cgate("setMode", "recovering");
  ok((await cgate("intent", w.id, [k()])).code === "mode", "an old normal wake's delayed intent, arriving in recovering, is refused");
  await cgate("setMode", "normal");
  // (an operator closes them: here, every key's HEAD finds nothing, as none was ever written)
  for (const it of await cgate("intents")) {
    const r = await admin("/lti/admin/content-gate", { staff_ref: "staff1", op: "close-intent", intent_id: it.id });
    if (r.status !== 200) ok(false, `close-intent ${r.status}`);
  }
  ok((await cgate("intents")).length === 0, "an operator closes an intent after a HEAD of every key finds nothing");
  // LIMIT-PRIVATE18-2 (daybreak3): 20 unresolved intents of 1,000 maximum-width keys each: the suspect set at full size
  {
    const v8 = await import("node:v8"), vm = await import("node:vm");
    v8.setFlagsFromString("--expose-gc");
    const gc = vm.runInNewContext("gc");
    const ids = [];
    for (let i = 0; i < 20; i++) ids.push((await cgate("intent", w.id, Array.from({ length: 1000 }, k))).id);
    const stored = (await cgate("intents")).reduce((a, it) => a + JSON.stringify(it.keys).length, 0);
    const res = await tool("/__test/cgate", { method: "POST", body: JSON.stringify({ m: "recoveryState", args: [] }) });
    const text = await res.text();
    gc();
    const h0 = process.memoryUsage().heapUsed;
    const rs = JSON.parse(text);
    const tokens = new Set(rs.suspect);
    const h1 = process.memoryUsage().heapUsed;
    ok(ids.every(Boolean) && rs.suspect.length === 20_000 && tokens.size === 20_000 && rs.suspect.every((t) => /^[0-9a-f]{32}$/.test(t)), `LIMIT-PRIVATE18-2: 20 intents × 1,000 maximum-width keys: recoveryState carries exactly 20,000 suspect tokens (${rs.suspect.length})`);
    console.log("MEASURED suspect set", JSON.stringify({ stored_bytes: stored, transfer_bytes: text.length, heap_bytes: h1 - h0 }));
    ok(stored <= 2_800_000 && text.length <= 800_000 && h1 - h0 <= 4 * 1024 * 1024, `...stored ≤ 2.8 MB in the gate (${stored}), transferred ≤ 0.8 MB (${text.length}), and the wake's parse and set ≤ 4 MiB of heap (${h1 - h0})`);
    for (const id of ids) await cgate("resolveIntent", id);
    void tokens;
  }
  await cgate("giveBack", w.id);
}

// ================= the sweep (§2.4, §2.5): the state machine's ends, the due order, and its races
const wakes = [];
const W = async (opts = {}) => {
  await freeLease();
  const s = await wake(opts);
  wakes.push(s);
  return s;
};
// (§2.5's per-wake table, with the A3-2 deltas: D1's lease, +1 statement and +2 rows written; D3's rows read; D3 r2's
// chain prune: +1 read and +1 written per successful ordinary successor insert into a full, contiguous 1,000-row chain
// window, i.e. per lease and per page write: +21 normal, +51 recovery)
const NORMAL = { d1_calls: 41, statements: 82, rows_read: 37_116, rows_written: 3_074, r2_calls: 30, keys_listed: 10_000 };
const RECOVERY = { d1_calls: 101, statements: 214, rows_read: 287_296, rows_written: 43_196, r2_calls: 90, keys_listed: 40_000 };
// (rows read as D1 counts them, the A3-2 delta D3 (9b0373c9) and D3 r2: a json_each list's values twice and each
// matched row again, and the chain prune in steady state; per page ≤ 705 sweep, ≤ 3,006 normal scan, ≤ 7,006 recovery
// scan. Below the chain's 1,000 rows the old figures, 704 / 3,005 / 7,005, are pinned by the D3 r2 control)
const PAGE_READ = { sweep: 705, normal: 3006, recovery: 7006 };
const within = (s, b) => Object.entries(b).every(([k, v]) => s[k] <= v) && s.pages.every((p) => p.statements <= (p.kind === "sweep" ? 5 : 6) && p.rows_read <= (p.kind === "sweep" ? PAGE_READ.sweep : PAGE_READ[s.mode === "recovery" ? "recovery" : "normal"]));
const D1NOW = "CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)";
if (part("1")) {
  const OW = "ownerSW";
  // crash boundaries: a reservation whose put never ran, and one whose put landed but whose hold never ran
  const crashed = async (withObject) => {
    const body = `synthetic bundle: crashed ${randomUUID()}`, sha = sha256hex(Buffer.from(body)), token = hex(16);
    await fenced([
      { sql: "INSERT OR IGNORE INTO owners (owner_ref, created) VALUES (?, ?)", params: [OW, Date.now()] },
      { sql: "INSERT INTO bundles (owner_ref, sha, size, state, token, deadline, due) VALUES (?, ?, ?, 'reserved', ?, ?, ?) ON CONFLICT (owner_ref, sha) DO NOTHING", params: [OW, sha, body.length, token, Date.now() + 600_000, Date.now() + 600_000 + 3600_000] },
    ], "upload");
    const key = await keyOf(OW, sha, token);
    if (withObject) await r2.put(key, body);
    return { sha, token, key, size: body.length };
  };
  const q0 = await quota(OW, "bundles") ?? { count: 0, bytes: 0 };
  const c1 = await crashed(false), c2 = await crashed(true);
  const q1 = await quota(OW, "bundles");
  ok(q1.count === q0.count + 2 && q1.bytes === q0.bytes + c1.size + c2.size, "(two crashed reservations, charged)");
  let s = await W();
  ok(await q("SELECT 1 AS x FROM bundles WHERE token = ?", c1.token), "a reservation isn't swept before its deadline + 1 h");
  await age(c1.token, 2 * 3600_000);
  await age(c2.token, 2 * 3600_000);
  s = await W();
  const q2 = await quota(OW, "bundles");
  ok(s.outcome === "ok" && !(await q("SELECT 1 AS x FROM bundles WHERE token IN (?, ?)", c1.token, c2.token)) && !(await r2.head(c2.key)) && q2.count === q0.count && q2.bytes === q0.bytes, `a crash after reserve, and after the put but before the hold, is each swept: object deleted, row deleted, charge returned (${JSON.stringify({ outcome: s.outcome, deleted: s.keys_deleted })})`);
  ok(within(s, NORMAL), `(that wake within §2.5's normal bounds: ${JSON.stringify({ calls: s.d1_calls, statements: s.statements, r2: s.r2_calls })})`);

  // held with refs = 0 for 24 h: releasing (the first page), then its object and row (the next), its charge returned only then
  const h1 = await held(OW);
  const qh = await quota(OW, "bundles");
  await age(h1.token, 25 * 3600_000);
  s = await W({ failDeletes: 1 });
  const r1 = await q("SELECT state, tries, due FROM bundles WHERE token = ?", h1.token);
  const qh1 = await quota(OW, "bundles");
  ok(r1?.state === "releasing" && r1.tries === 1 && r1.due > Date.now() + 30_000 && (await r2.head(h1.key)) && qh1.count === qh.count && qh1.bytes === qh.bytes, `a held row unreferenced for 24 h goes releasing; a failed R2 delete keeps the row, its object and its charge, and moves its due later (${JSON.stringify(r1)})`);
  await age(h1.token, 3600_000);
  s = await W();
  const qh2 = await quota(OW, "bundles");
  ok(!(await q("SELECT 1 AS x FROM bundles WHERE token = ?", h1.token)) && !(await r2.head(h1.key)) && qh2.count === qh.count - 1 && qh2.bytes === qh.bytes - h1.size, "...and once its delete succeeds, the row goes and its charge is returned, only then");

  // a failing page doesn't block the rows behind it: 150 due reservations, the first page's delete failing
  const toks = Array.from({ length: 150 }, () => ({ sha: hex(32), token: hex(16) }));
  await fenced([
    { sql: "INSERT OR IGNORE INTO owners (owner_ref, created) VALUES (?, ?)", params: ["ownerBulk", Date.now()] },
    { sql: `INSERT INTO bundles (owner_ref, sha, size, state, token, deadline, due) SELECT ?, json_extract(value, '$.sha'), 1, 'reserved', json_extract(value, '$.token'), ${D1NOW} - 7200000, ${D1NOW} - 3600000 - json_extract(value, '$.i') FROM json_each(?)`, params: ["ownerBulk", JSON.stringify(toks.map((t, i) => ({ ...t, i: 150 - i })))] },
  ], "upload");
  s = await W({ failDeletes: 1 });
  const left = await qa("SELECT tries FROM bundles WHERE owner_ref = 'ownerBulk'");
  ok(s.sweep_pages >= 2 && left.length === 100 && left.every((r) => r.tries === 1), `a failing R2 delete moves its page's rows later and doesn't block the 50 behind them (${left.length} left)`);
  await fenced([{ sql: "UPDATE bundles SET due = due - 7200000 WHERE owner_ref = 'ownerBulk'" }]);
  s = await W();
  ok(!(await q("SELECT 1 AS x FROM bundles WHERE owner_ref = 'ownerBulk'")) && within(s, NORMAL), "...and a later wake takes them");

  // full sweep pages (100 rows each), for the measured worst case: 100 held unreferenced rows go releasing, then their
  // 100 deletes; and 100 expired reservations deleted
  const full = Array.from({ length: 200 }, () => ({ sha: hex(32), token: hex(16) }));
  await fenced([
    { sql: "INSERT OR IGNORE INTO owners (owner_ref, created) VALUES (?, ?)", params: ["ownerFull", Date.now()] },
    { sql: `INSERT INTO bundles (owner_ref, sha, size, state, token, deadline, due) SELECT ?, json_extract(value, '$.sha'), 1, 'reserved', json_extract(value, '$.token'), ${D1NOW} - 7200000, ${D1NOW} - 3600000 FROM json_each(?)`, params: ["ownerFull", JSON.stringify(full)] },
    { sql: `UPDATE bundles SET state = 'held', held_at = ${D1NOW} - 90000000, due = ${D1NOW} - 3600000 WHERE token IN (SELECT value FROM json_each(?))`, params: [JSON.stringify(full.slice(0, 100).map((x) => x.token))] },
  ], "upload");
  s = await W({ maxScanPages: 0 });
  ok(!(await q("SELECT 1 AS x FROM bundles WHERE owner_ref = 'ownerFull'")) && s.pages.filter((p) => p.rows === 100).length >= 2 && within(s, NORMAL), `full sweep pages: 100 moved, 100 + 100 deleted, within the table (${s.pages.map((p) => `${p.rows} rows: ${p.statements} st, ${p.rows_read} read, ${p.rows_written} written`).join("; ")})`);
  // the sweep and a revision insert race, both orders
  const hA = await held(OW), hB = await held(OW);
  await age(hA.token, 25 * 3600_000);
  await testGate("wake_sweep_batch", true);
  await freeLease();
  const wA = wake({ maxSweepPages: 1 });
  await parkedOn("wake_sweep_batch");
  const revA = await asg({ owner_ref: OW, bundle_sha: hA.sha });
  await testGate("wake_sweep_batch", false);
  await wA;
  const ra = await q("SELECT state, refs FROM bundles WHERE token = ?", hA.token);
  ok(revA.status === 200 && ra.state === "held" && ra.refs === 1, `the revision wins: its insert commits (refs 1) and the sweep's move changes nothing (${revA.status}, ${JSON.stringify(ra)})`);
  await age(hB.token, 25 * 3600_000);
  await W({ maxSweepPages: 1 });
  const revB = await asg({ owner_ref: OW, bundle_sha: hB.sha });
  ok((await q("SELECT state FROM bundles WHERE token = ?", hB.token))?.state === "releasing" && revB.status === 404, `the sweep wins: the bundle is releasing, and the revision is refused no_bundle (${revB.status})`);
  await W();

  // the release race (CORR-LTI5A3-2, astra's acceptance)
  const relBody = `synthetic bundle: release race ${randomUUID()}`, relSha = sha256hex(Buffer.from(relBody));
  const T1 = (async () => {
    const r = await upload(OW, relBody);
    if (r.status !== 200) throw new Error("upload T1");
    const row = await q("SELECT token FROM bundles WHERE owner_ref = ? AND sha = ?", OW, relSha);
    return { token: row.token, key: await keyOf(OW, relSha, row.token) };
  })();
  const t1 = await T1;
  await age(t1.token, 25 * 3600_000);
  await W({ maxSweepPages: 1 });
  ok((await q("SELECT state FROM bundles WHERE token = ?", t1.token))?.state === "releasing", "(T1 releasing)");
  await testGate("sweep_before_delete", true);
  await freeLease();
  const W1 = wake({ maxScanPages: 0 });
  await parkedOn("sweep_before_delete");
  // (W1's lease runs out while it is delayed; W2 finishes T1)
  const w2 = await W({ maxScanPages: 0 });
  const reup = await upload(OW, relBody);
  const t2row = await q("SELECT token, state FROM bundles WHERE owner_ref = ? AND sha = ?", OW, relSha);
  const aid2 = (await j(await asg({ owner_ref: OW, bundle_sha: relSha }))).aid;
  await content.prepare(`INSERT INTO quota (scope, kind, cap_count, cap_bytes) VALUES (?, 'placement_pins', 10000, 0), (?, 'dl_pins', 10000, 0) ON CONFLICT DO NOTHING`).bind("a".repeat(32), "a".repeat(32)).run();
  await content.prepare("INSERT INTO pins (kind, rid, item, aid, rev, created) VALUES ('placement', ?, 'race-placement', ?, 1, 0)").bind("a".repeat(32), aid2).run();
  const qr0 = await quota(OW, "bundles");
  await testGate("sweep_before_delete", false);
  await W1;
  const t2 = await q("SELECT token, state, refs FROM bundles WHERE owner_ref = ? AND sha = ?", OW, relSha);
  const t2key = await keyOf(OW, relSha, t2row.token);
  const qr1 = await quota(OW, "bundles");
  ok(w2.keys_deleted >= 1 && reup.status === 200 && t2.token === t2row.token && t2.token !== t1.token && t2.state === "held" && t2.refs === 1 && (await r2.head(t2key)) && !(await r2.head(t1.key)) && qr1.count === qr0.count && qr1.bytes === qr0.bytes, `CORR-LTI5A3-2: W1's late delete of T1 and its late row delete leave T2's object, row, refs and charge untouched (${JSON.stringify(t2)})`);
  // ...and with a crash at the R2/D1 boundary: a delete that landed but whose answer was lost is redone harmlessly
  const crBody = `synthetic bundle: boundary ${randomUUID()}`;
  await upload(OW, crBody);
  const cr = await q("SELECT token FROM bundles WHERE owner_ref = ? AND sha = ?", OW, sha256hex(Buffer.from(crBody)));
  const crKey = await keyOf(OW, sha256hex(Buffer.from(crBody)), cr.token);
  await age(cr.token, 25 * 3600_000);
  const qc0 = await quota(OW, "bundles");
  await W({ deleteThenFail: 1, maxScanPages: 0 });
  const crRow = await q("SELECT state, tries FROM bundles WHERE token = ?", cr.token);
  ok(crRow?.state === "releasing" && crRow.tries === 1 && !(await r2.head(crKey)) && (await quota(OW, "bundles")).count === qc0.count, `a crash between the R2 delete and its D1 step: the row stays releasing with its charge (${JSON.stringify(crRow)})`);
  await age(cr.token, 3600_000);
  await W({ maxScanPages: 0 });
  ok(!(await q("SELECT 1 AS x FROM bundles WHERE token = ?", cr.token)) && (await quota(OW, "bundles")).count === qc0.count - 1, "...and the next wake redoes the delete (already gone, harmless) and deletes the row: no lost or doubled delete");
  // (the deleted-then-failed delete's intent stays unresolved, its key suspect, until an operator closes it after a HEAD)
  for (const it of await cgate("intents")) await admin("/lti/admin/content-gate", { staff_ref: "staff1", op: "close-intent", intent_id: it.id });
  ok((await cgate("intents")).length === 0, "(its intent closed by the operator, every key's HEAD finding nothing)");
}

// ================= the backstop scan and the lease
if (part("1")) {
  const OW = "ownerSC";
  // the backstop race, order 1: an orphan listed; a fresh reserve, put and hold of the same (owner, sha); then the delete
  const bBody = `synthetic bundle: backstop ${randomUUID()}`, bSha = sha256hex(Buffer.from(bBody));
  const orphanKey = await keyOf(OW, bSha, hex(16));
  await r2.put(orphanKey, bBody);
  await testGate("scan_before_delete", true);
  await freeLease();
  const scan1 = wake({ orphanAgeMs: 0, maxSweepPages: 0 });
  await parkedOn("scan_before_delete");
  const fresh = await upload(OW, bBody);
  const fr = await q("SELECT token, state FROM bundles WHERE owner_ref = ? AND sha = ?", OW, bSha);
  await testGate("scan_before_delete", false);
  await scan1;
  const frKey = await keyOf(OW, bSha, fr.token);
  ok(fresh.status === 200 && !(await r2.head(orphanKey)) && (await r2.head(frKey)) && (await q("SELECT state FROM bundles WHERE token = ?", fr.token))?.state === "held", "CORR-LTI5A3-2 backstop, order 1: the orphan is deleted; the new incarnation (another key) survives, held with its bytes");
  // order 2: a fresh reserve and put; then the listing and check; then the hold
  const b2Body = `synthetic bundle: backstop 2 ${randomUUID()}`, b2Sha = sha256hex(Buffer.from(b2Body));
  await testGate("bundle_before_hold", true);
  await reset();
  const up2 = putBundle(OW, b2Body);
  await parkedOn("bundle_before_hold");
  const r2row = await q("SELECT token FROM bundles WHERE owner_ref = ? AND sha = ?", OW, b2Sha);
  const s2 = await W({ orphanAgeMs: 0, maxSweepPages: 0 });
  await testGate("bundle_before_hold", false);
  const up2r = await up2;
  ok(up2r.status === 200 && (await r2.head(await keyOf(OW, b2Sha, r2row.token))) && (await q("SELECT state FROM bundles WHERE token = ?", r2row.token))?.state === "held" && s2.outcome === "ok", "order 2: the scan finds the reserved row's token and deletes nothing of it; the hold then succeeds");
  // the backstop never deletes an object with a row; in normal mode it leaves a young orphan alone (the 24 h age gate)
  const young = await keyOf(OW, hex(32), hex(16));
  await r2.put(young, "young");
  await W({ maxSweepPages: 0 });
  ok(await r2.head(young), "in normal mode, an orphan younger than 24 h is left alone");
  await W({ maxSweepPages: 0, orphanAgeMs: 0 });
  ok(!(await r2.head(young)) && (await r2.head(frKey)), "...and once older, it is deleted; objects with rows never are");

  // two concurrent scheduled runs: one does the work, the other finds the lease taken
  await freeLease();
  const [x, y] = await Promise.all([wake({ maxScanPages: 0 }), wake({ maxScanPages: 0 })]);
  ok([x.outcome, y.outcome].sort().join() === "lease_taken,ok", `two concurrent wakes: one works, one finds the lease taken (${x.outcome}, ${y.outcome})`);
  // a restored sweep_lease with a future until delays a wake by ≤ 5 min (its until is D1's now + 5 min at most)
  await fenced([{ sql: `UPDATE sweep_lease SET until = ${D1NOW} + 300000 WHERE one = 1` }]);
  const lt = await wake({ maxScanPages: 0 });
  const until = (await q(`SELECT until - ${D1NOW} AS left FROM sweep_lease`)).left;
  ok(lt.outcome === "lease_taken" && until <= 300_000, `a lease with a future until refuses a wake for ≤ 5 min (${lt.outcome}, ${Math.round(until / 1000)} s left)`);

  // the scan's cursor: pages resume from the saved cursor, and the listing wraps (2,100 young orphans: three pages)
  const many = Array.from({ length: 2100 }, () => `o/${"0".repeat(32)}/${hex(32)}/${hex(16)}`).sort();
  for (let i = 0; i < many.length; i += 100) await Promise.all(many.slice(i, i + 100).map((k) => r2.put(k, "y")));
  const scan0 = await q("SELECT cursor, cycle FROM scan");
  const p1 = await W({ maxSweepPages: 0, maxScanPages: 1 });
  const c1 = await q("SELECT cursor, cycle FROM scan");
  const p2 = await W({ maxSweepPages: 0, maxScanPages: 1 });
  const c2 = await q("SELECT cursor, cycle FROM scan");
  ok(p1.keys_listed === 1000 && c1.cursor === many[999] && p2.keys_listed === 1000 && c2.cursor > c1.cursor && c2.cycle === scan0.cycle, `the scan saves its cursor after each page and the next wake resumes from it (${c1.cursor.slice(0, 12)}…, ${c2.cursor.slice(0, 12)}…)`);
  const p3 = await W({ maxSweepPages: 0 });
  const c3 = await q("SELECT cursor, cycle FROM scan");
  ok(c3.cursor === "" && c3.cycle === scan0.cycle + 1 && p3.keys_listed <= 10_000, `the listing's end wraps: cursor reset, cycle + 1 (${c3.cycle})`);
  // a crash between the orphans' delete and the cursor write (here: the delete fails): the page is listed again, nothing lost or doubled
  const before = (await r2.list({ prefix: `o/${"0".repeat(32)}/` })).objects.length;
  const f = await W({ maxSweepPages: 0, maxScanPages: 1, orphanAgeMs: 0, failDeletes: 1 });
  const cf = await q("SELECT cursor FROM scan");
  ok(f.outcome === "delete_failed" && cf.cursor === "" && (await r2.list({ prefix: `o/${"0".repeat(32)}/` })).objects.length === before, "a scan page whose delete fails writes no cursor: it is listed again");
  const g = await W({ maxSweepPages: 0, orphanAgeMs: 0 });
  // (the failed page's intent: its keys are gone now, so the operator's HEADs find nothing and it closes)
  for (const it of await cgate("intents")) await admin("/lti/admin/content-gate", { staff_ref: "staff1", op: "close-intent", intent_id: it.id });
  ok((await cgate("intents")).length === 0, "(the failed page's intent closed after its keys' HEADs found nothing)");
  ok((await r2.list({ prefix: `o/${"0".repeat(32)}/` })).objects.length === 0 && g.keys_deleted >= 2100 && within(g, NORMAL), `...and the next wake deletes every orphan once, within the normal bounds (${g.keys_deleted} deleted, ${g.statements} statements, ${g.r2_calls} R2 calls)`);
  ok(wakes.every((s) => within(s, NORMAL)), `every normal wake so far stayed within §2.5's table, statements per invocation ≤ 82 (max ${Math.max(...wakes.map((s) => s.statements))})`);
}

// ================= recovery after an LtiContent restore (§2.5's runbook; astra's r6 and r8 traces; CORR-LTI5A3-3)
// The restore helper (astra3's conditions on the logical-restore swap): one D1 batch rolls LtiContent back exactly
// (every trigger dropped, every table emptied and reloaded, the triggers recreated after the load, so no counter
// fires twice); the gate and the held stale batches live on outside it; and the restored schema, rows and counters
// are asserted equal to the snapshot before any stale request is released.
const snapshotContent = async () => {
  const schema = await qa("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE '\\_cf\\_%' ESCAPE '\\' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY type, name");
  const tables = schema.filter((r) => r.type === "table").map((r) => r.name);
  const rows = {};
  for (const t of tables) rows[t] = (await qa(`SELECT * FROM ${t}`)).map((r) => JSON.stringify(r)).sort();
  return { schema, tables, rows };
};
const restoreContent = async (snap) => {
  const triggers = snap.schema.filter((r) => r.type === "trigger");
  const stmts = [];
  for (const tr of triggers) stmts.push(content.prepare(`DROP TRIGGER IF EXISTS ${tr.name}`));
  for (const t of snap.tables) stmts.push(content.prepare(`DELETE FROM ${t}`));
  for (const t of snap.tables) {
    const rows = snap.rows[t].map((r) => JSON.parse(r));
    if (!rows.length) continue;
    const cols = Object.keys(rows[0]);
    for (let i = 0; i < rows.length; i += 200) stmts.push(content.prepare(`INSERT INTO ${t} (${cols.join(", ")}) SELECT ${cols.map((c) => `json_extract(value, '$.${c}')`).join(", ")} FROM json_each(?)`).bind(JSON.stringify(rows.slice(i, i + 200))));
  }
  for (const tr of triggers) stmts.push(content.prepare(tr.sql));
  await content.batch(stmts);
  const now = await snapshotContent();
  return JSON.stringify(now) === JSON.stringify(snap);
};
const waitQuiet = async () => {
  for (let i = 0; i < 200; i++) {
    const s = await cgate("quiet");
    if (s.quiet) return s;
    await sleep(100);
  }
  return cgate("quiet");
};
const recoverAll = async () => {
  const out = [];
  for (let i = 0; i < 20; i++) {
    const s = await W();
    out.push(s);
    if ((await cgate("recoveryState")).done) break;
  }
  return out;
};
const ownerKeyed = async (owner, sha) => {
  const row = await q("SELECT token, state, refs, seen_cycle FROM bundles WHERE owner_ref = ? AND sha = ?", owner, sha);
  return row && { ...row, key: await keyOf(owner, sha, row.token) };
};

// ================= D3 r2: the rows read and written per page, in both chain regimes (the D3 r2 ruling: daybreak3
// e5fc5902, astra3). gate_calls_keep prunes the row at NEW.seq - 1000 after each chain insert: in a full, contiguous,
// retained 1,000-row window, each successful ordinary successor insert (a gate.write, probe or checkpoint, or a
// resolution's tombstone) prunes exactly one row, +1 read and +1 written; below 1,000 rows it prunes none. Each page
// records whether it made its fenced write and that write's own chain statement's rows; nothing is inferred from order
const chainWindow = async () => {
  const r = await q("SELECT count(*) AS n, min(seq) AS lo, max(seq) AS hi, sum(kind = 'marker') AS markers FROM gate_calls");
  return { count: r.n, min: r.lo, max: r.hi, markers: r.markers ?? 0 };
};
// (the measured worst sweep pages: 100 held unreferenced rows go releasing, then their 100 deletes; and 100 expired
// reservations deleted)
const fullSweepPop = async (owner) => {
  const full = Array.from({ length: 200 }, () => ({ sha: hex(32), token: hex(16) }));
  await fenced([
    { sql: "INSERT OR IGNORE INTO owners (owner_ref, created) VALUES (?, ?)", params: [owner, Date.now()] },
    { sql: `INSERT INTO bundles (owner_ref, sha, size, state, token, deadline, due) SELECT ?, json_extract(value, '$.sha'), 1, 'reserved', json_extract(value, '$.token'), ${D1NOW} - 7200000, ${D1NOW} - 3600000 FROM json_each(?)`, params: [owner, JSON.stringify(full)] },
    { sql: `UPDATE bundles SET state = 'held', held_at = ${D1NOW} - 90000000, due = ${D1NOW} - 3600000 WHERE token IN (SELECT value FROM json_each(?))`, params: [JSON.stringify(full.slice(0, 100).map((x) => x.token))] },
  ], "upload");
};
// (the measured worst scan pages: n held rows with their objects, one owner, so at least one 1,000-key page lies wholly
// inside them, every key found)
const scanPop = async (owner, n) => {
  const rows = Array.from({ length: n }, () => ({ sha: hex(32), token: hex(16) }));
  await fenced([{ sql: "INSERT OR IGNORE INTO owners (owner_ref, created) VALUES (?, ?)", params: [owner, Date.now()] }]);
  for (let i = 0; i < n; i += 5000) {
    const stmts = [];
    for (let k = i; k < Math.min(i + 5000, n); k += 500) stmts.push({ sql: `INSERT INTO bundles (owner_ref, sha, size, state, token, deadline, due) SELECT ?, json_extract(value, '$.sha'), 1, 'reserved', json_extract(value, '$.token'), ${D1NOW} + 86400000, NULL FROM json_each(?)`, params: [owner, JSON.stringify(rows.slice(k, k + 500))] });
    await fenced(stmts);
  }
  await fenced([{ sql: `UPDATE bundles SET state = 'held', held_at = ${D1NOW}, due = NULL WHERE owner_ref = ? AND state = 'reserved'`, params: [owner] }]);
  const digest = (await keyOf(owner, "0".repeat(64), "0".repeat(32))).split("/")[1];
  const keys = rows.map((r) => `o/${digest}/${r.sha}/${r.token}`);
  for (let i = 0; i < keys.length; i += 200) await Promise.all(keys.slice(i, i + 200).map((k) => r2.put(k, "s")));
};
// (one wake, measured: the chain window before and after, the lease's and every page's rows and chain rows)
const d3Wake = async (label, opts) => {
  const before = await chainWindow();
  const s = await W(opts);
  const after = await chainWindow();
  const pages = s.pages.map((p) => ({ kind: p.kind, rows: p.rows, wrote: p.wrote, rows_read: p.rows_read, rows_written: p.rows_written, chain_read: p.chain_read, chain_written: p.chain_written }));
  return { label, mode: s.mode, outcome: s.outcome, before, after, lease: s.lease, pages };
};
const d3Worst = (ms, kind, rows) => {
  const ps = ms.flatMap((m) => m.pages.filter((p) => p.kind === kind && p.rows === rows));
  return { pages: ps.length, read: Math.max(-1, ...ps.map((p) => p.rows_read)), written: Math.max(-1, ...ps.map((p) => p.rows_written)), all_wrote: ps.every((p) => p.wrote) };
};
// (the lease and every page that wrote: their chain statements' rows, which must be one value per regime)
const d3Chain = (ms) => {
  const c = [...ms.map((m) => m.lease).filter(Boolean).map((l) => [l.chain_read, l.chain_written]), ...ms.flatMap((m) => m.pages.filter((p) => p.wrote).map((p) => [p.chain_read, p.chain_written]))];
  return { n: c.length, read: [...new Set(c.map((x) => x[0]))], written: [...new Set(c.map((x) => x[1]))] };
};
// (the three page kinds, each on a fresh population: a full sweep, a normal scan over 2,000 found keys, and a recovery
// cycle over them, with no restore: the checkpoint, the pause, the marker at k, recover, resume)
const d3Measure = async (side) => {
  const tag = side === "below" ? "B" : "A";
  await fullSweepPop(`ownerD3sw${tag}`);
  const sweep = await d3Wake(`${side}: full sweep`, { maxScanPages: 0 });
  await scanPop(`ownerD3sc${tag}`, 2000);
  const normal = await d3Wake(`${side}: normal scan`, { maxSweepPages: 0 });
  const ck = await cgate("checkpointNow");
  await cgate("pause");
  await waitQuiet();
  const mk = await cgate("marker", ck.k), rc = await cgate("recover");
  const rec = [];
  for (let i = 0; i < 20; i++) {
    rec.push(await d3Wake(`${side}: recovery scan`, { maxSweepPages: 0 }));
    if ((await cgate("recoveryState")).done) break;
  }
  const rz = await cgate("resume");
  const all = [sweep, normal, ...rec];
  const out = { side, runbook: { checkpoint: ck.outcome, k: ck.k, marker: mk.ok, recover: rc.ok, resume: rz.ok }, windows: all.map((m) => [m.label, m.before, m.after]), sweep: d3Worst([sweep], "sweep", 100), normal: d3Worst([normal], "scan", 1000), recovery: d3Worst(rec, "scan", 1000), chain: d3Chain(all), measurements: all };
  console.log(`D3 ${side}`, JSON.stringify({ ...out, measurements: undefined }));
  return out;
};
if (part("1")) {
  const OR = "ownerRC";
  // ---- the population before the checkpoint
  const Ha = await held(OR), Hb = await held(OR), Hc = await held(OR), Hd = await held(OR);
  const Aa = (await j(await asg({ owner_ref: OR, bundle_sha: Ha.sha, title: "Aa" }))).aid;
  // (Ab, Ac, Ad: rev 1 on Hb, Hc, Hd, rev 2 on Ha, so rev 1 can be collected after the checkpoint)
  const two = async (sha, title) => {
    const aid = (await j(await asg({ owner_ref: OR, bundle_sha: sha, title }))).aid;
    await asg({ owner_ref: OR, aid, expected_rev: 1, bundle_sha: Ha.sha, title });
    return aid;
  };
  const Ab = await two(Hb.sha, "Ab"), Ac = await two(Hc.sha, "Ac"), Ad = await two(Hd.sha, "Ad");
  // a reservation whose put lands but whose hold comes after the checkpoint (a late put for a restored reserved row)
  const rBody = `synthetic bundle: reserved at the checkpoint ${randomUUID()}`, rSha = sha256hex(Buffer.from(rBody));
  await testGate("bundle_before_hold", true);
  await reset();
  const lateHold = putBundle(OR, rBody);
  await parkedOn("bundle_before_hold");
  // ---- the checkpoint, and the database as Time Travel would restore it to d1_time + 1 s
  const ck = await cgate("checkpointNow");
  const snap = await snapshotContent();
  ok(ck.outcome === "done" && snap.rows.gate_calls.some((r) => JSON.parse(r).seq === ck.k), `(the checkpoint k = ${ck.k}, and the snapshot at it)`);
  // (the first three calls after it, k + 1 to k + 3, tombstoned on the live timeline, their batches held back)
  const lates = [];
  for (let i = 0; i < 3; i++) {
    await seam({ seam: { op: "late", count: 1 } });
    lates.push(await asg({ owner_ref: OR, bundle_sha: Ha.sha, title: `stale ${i}` }));
  }
  ok(lates.every((r) => r.status === 503), "(three calls tombstoned on the live timeline, their batches held back)");
  // ---- after it: the hold lands; collections release Hb, Hc and Hd; new uploads; three stale calls tombstoned
  await testGate("bundle_before_hold", false);
  ok((await lateHold).status === 200, "(the late hold commits on the live timeline)");
  const collect = (aid) => fenced([{ sql: "DELETE FROM assignment_revisions WHERE aid = ? AND rev = 1", params: [aid] }]);
  await collect(Ab);
  await W({ maxScanPages: 0 }); // Hb's object deleted and its row with it
  await collect(Ac);
  await W({ maxScanPages: 0, failDeletes: 1 }); // Hc's delete fails: intent unresolved, the object still there
  const hcIntent = (await cgate("intents")).find((i) => i.keys.includes(Hc.key));
  ok(hcIntent && (await r2.head(Hc.key)), "(Hc: its delete never landed; its intent is unresolved)");
  // (Hd: a wake's delete in flight when pause is called: it lands, and its intent is never resolved)
  await collect(Ad);
  await testGate("wake_before_resolve", true);
  await freeLease();
  const inflightWake = wake({ maxScanPages: 0 });
  await parkedOn("wake_before_resolve");
  const N1 = await held(OR), N2 = await held(OR);
  // ---- late continuations of every kind (CORR-LTI5A3-3's acceptance): parked before issue and while awaiting the write
  const conts = {};
  const park = async (name, start) => {
    await testGate(name, true);
    conts[name] = start();
    await parkedOn(name);
  };
  await park("bundle_before_reserve", () => upload(OR, `synthetic bundle: late reserve ${randomUUID()}`));
  await park("assignment_before_issue", () => asg({ owner_ref: OR, bundle_sha: Ha.sha, title: "late before issue" }));
  await park("assignment_before_write", () => asg({ owner_ref: OR, bundle_sha: Ha.sha, title: "late before write" }));
  await testGate("bundle_before_hold", true);
  await reset();
  conts.bundle_before_hold = putBundle(OR, `synthetic bundle: late hold ${randomUUID()}`);
  await parkedOn("bundle_before_hold");
  // (the wake parked before its resolve is the wake page in flight)

  // ---- 1. pause; 2. quiet: every live ticket expires (the gate's clock moves 12 min), nothing outstanding
  await cgate("pause");
  ok(!(await cgate("quiet")).quiet, "paused with continuations holding tickets: not quiet (live > 0)");
  await seam({ skew: 12 * 60_000 });
  const qt = await waitQuiet();
  ok(qt.quiet && qt.live === 0 && qt.calls === 0, `quiet: paused, live 0, no call outstanding (${JSON.stringify(qt)})`);
  // ---- 3. the restore, and astra's r8 trace: two stale calls land at k + 1 and k + 2 before the marker
  ok(await restoreContent(snap), "the restore is exact: schema, rows and counters equal the snapshot, before any stale request is released");
  ok((await cgate("quiet")).mode === "paused", "the gate's mode survives the D1 restore (separate storage)");
  const landed = await cgate("testReleaseLate", 2);
  ok(landed.every((x) => x === "committed"), `two stale tombstoned calls land right after the restore, at k + 1 and k + 2 (${landed})`);
  const m1 = await cgate("marker", ck.k);
  ok(!m1.ok && m1.code === "redo", `the marker (from k, with the checkpoint's nonce) aborts: redo the restore (${JSON.stringify(m1)})`);
  ok(await restoreContent(snap), "the redone restore is exact again");
  const m2 = await cgate("marker", ck.k);
  ok(m2.ok, `...and the redone restore's marker commits (${JSON.stringify(m2)})`);
  const after = await cgate("testReleaseLate");
  ok(after.length === 1 && after[0] !== "committed" && !(await q("SELECT 1 AS x FROM assignments WHERE title LIKE 'stale %'")), `after the marker every old-timeline call aborts (${after})`);
  // ---- 4. recover; the late continuations, released now, change nothing in the restored database
  const rc = await cgate("recover");
  ok(rc.ok && rc.recovery_id === 1, `recover: a new recovery id from the gate's counter (${JSON.stringify(rc)})`);
  const rs = await cgate("recoveryState");
  ok(rs.suspect.includes(Hc.token) && rs.suspect.includes(Hd.token), "the unresolved intents' keys are the suspect set (as tokens): a failed delete's (Hc), and a wake killed with its delete outstanding (Hd)");
  const beforeConts = await snapshotContent();
  for (const name of Object.keys(conts)) await testGate(name, false);
  await testGate("wake_before_resolve", false);
  const results = await Promise.all(Object.values(conts));
  await inflightWake;
  const afterConts = await snapshotContent();
  ok(results.every((r) => r.status === 503 || r.status === 429) && JSON.stringify(afterConts.rows) === JSON.stringify(beforeConts.rows), `each late continuation (upload reserve and hold, assignment before issue and write, a wake page) is refused, and no restored row changes (${results.map((r) => r.status)})`);
  // ---- 5–6. recovery wakes: 40 scan pages a wake, no age gate; the cycle's end advances valid_cycle
  const rw = await recoverAll();
  const vc = (await q("SELECT v FROM meta WHERE k = 'valid_cycle'")).v;
  ok(rw.at(-1).final && rw[0].first && vc === 1 && (await q("SELECT recovery FROM scan")).recovery === 1, `the recovery cycle completes: first wake resets the scan row, the last advances valid_cycle (${rw.length} wakes)`);
  ok(rw.every((s) => s.mode === "recovery" && within(s, RECOVERY)), `every recovery wake stays within §2.5's recovery bounds (max ${Math.max(...rw.map((s) => s.statements))} statements)`);
  const a = await ownerKeyed(OR, Ha.sha), b = await ownerKeyed(OR, Hb.sha), c = await ownerKeyed(OR, Hc.sha), r = await ownerKeyed(OR, rSha);
  ok(a.seen_cycle === 1 && b.state === "held" && b.seen_cycle === 0 && c.state === "held" && c.seen_cycle === 0, `a restored held row whose object is gone (Hb), and a suspect key (Hc), are never marked seen (${a.seen_cycle}, ${b.seen_cycle}, ${c.seen_cycle})`);
  ok(!(await r2.head(N1.key)) && !(await r2.head(N2.key)), "every post-restore orphan is deleted (no age gate in recovery)");
  ok(r?.state === "reserved", `a late put for a restored reserved row never becomes held (${r?.state})`);
  // ---- 7. resume; usable is derived
  ok((await cgate("resume")).ok, "resume reopens uploads and assignment writes once the cycle is reported");
  await seam({ skew: 0 });
  const useB = await asg({ owner_ref: OR, bundle_sha: Hb.sha, title: "on Hb" }), useC = await asg({ owner_ref: OR, bundle_sha: Hc.sha, title: "on Hc" }), useA = await asg({ owner_ref: OR, bundle_sha: Ha.sha, title: "on Ha" });
  ok(useB.status === 404 && useC.status === 404 && useA.status === 200, `after resume, an unseen restored held row and a suspect one are unusable; a seen one is usable (${useB.status}, ${useC.status}, ${useA.status})`);
  const Hn = await held(OR);
  ok((await ownerKeyed(OR, Hn.sha)).seen_cycle === 1 && (await asg({ owner_ref: OR, bundle_sha: Hn.sha, title: "on Hn" })).status === 200, "a hold after resume sets the current valid_cycle");
  // (the late put's reserved row is removed by the ordinary sweep after its deadline + 1 h, with its bytes)
  await age(r.token, 2 * 3600_000);
  await W({ maxScanPages: 0 });
  ok(!(await q("SELECT 1 AS x FROM bundles WHERE token = ?", r.token)) && !(await r2.head(r.key)), "...and its row and bytes are removed by the reservation sweep");
  void Aa;

  // ---- a second recovery: the suspect keys persist through resume; recovery ids never repeat
  const ck2 = await cgate("checkpointNow");
  const snap2 = await snapshotContent();
  await cgate("pause");
  await waitQuiet();
  ok(await restoreContent(snap2), "(a second restore, exact)");
  ok((await cgate("marker", ck2.k)).ok, "(its marker)");
  const rc2 = await cgate("recover");
  const rs2 = await cgate("recoveryState");
  ok(rc2.ok && rc2.recovery_id === 2 && rs2.suspect.includes(Hc.token), `suspect keys persist through resume and a second recovery; the recovery id is new (${rc2.recovery_id})`);
  const rw2 = await recoverAll();
  ok((await cgate("recoveryState")).done && rw2.every((s) => within(s, RECOVERY)) && (await ownerKeyed(OR, Hc.sha)).seen_cycle < 2, "(the second cycle completes; Hc is still never seen)");
  ok((await cgate("resume")).ok, "(resumed)");
  // an intent closes only when every key's HEAD finds nothing
  const hc = (await cgate("intents")).find((i) => i.keys.includes(Hc.key));
  const cl1 = await admin("/lti/admin/content-gate", { staff_ref: "staff1", op: "close-intent", intent_id: hc.id });
  await r2.delete(Hc.key);
  const cl2 = await admin("/lti/admin/content-gate", { staff_ref: "staff1", op: "close-intent", intent_id: hc.id });
  ok(cl1.status === 409 && cl2.status === 200 && !(await cgate("intents")).some((i) => i.id === hc.id), `an intent can be closed only when every key's HEAD finds nothing (${cl1.status}, ${cl2.status})`);
  ok((await ownerKeyed(OR, Hc.sha)).seen_cycle < (await q("SELECT v FROM meta WHERE k = 'valid_cycle'")).v, "...and closing it never makes the suspect row usable");

}

// ================= D3 r2's below-threshold control: after the first recovery tests (which expect theirs to be the first),
// with the chain still below 1,000 rows (asserted)
const d3Below = part("1") ? await d3Measure("below") : null;
if (part("1")) {
  const b = d3Below;
  // (below the threshold the window needn't be contiguous: with max(seq) < 1,000, NEW.seq - 1000 < 0, so the prune deletes
  // nothing; earlier restores leave gaps here)
  const allBelow = b.windows.every(([, x, y]) => x.max < 1000 && y.max < 1000);
  ok(b.runbook.checkpoint === "done" && b.runbook.marker && b.runbook.recover && b.runbook.resume && allBelow, `D3 r2 below-threshold control: every measurement with max(seq) below 1,000, so no prune (${JSON.stringify(b.windows.map(([l, x, y]) => [l, x.count, x.min, x.max, x.markers, y.max]))})`);
  ok(b.sweep.pages >= 2 && b.sweep.read === 704 && b.sweep.written === 301 && b.sweep.all_wrote, `D3 r2 below: the worst full sweep page reads 704 and writes 301, the old figures (${JSON.stringify(b.sweep)})`);
  ok(b.normal.pages >= 1 && b.normal.read === 3005 && b.normal.written === 2 && b.normal.all_wrote, `D3 r2 below: the worst normal scan page reads 3,005 and writes 2 (${JSON.stringify(b.normal)})`);
  ok(b.recovery.pages >= 1 && b.recovery.read === 7005 && b.recovery.written === 1002 && b.recovery.all_wrote, `D3 r2 below: the worst recovery scan page reads 7,005 and writes 1,002 (${JSON.stringify(b.recovery)})`);
  ok(b.chain.n >= 4 && b.chain.read.length === 1 && b.chain.written.length === 1, `D3 r2 below: the lease's and every page write's chain statement, one value (${JSON.stringify(b.chain)})`);
}

// ================= #18 review: regressions (astra3's CORR-LTI18-1..3; the delta D4 r3 13070df0)
if (part("1")) {
  const OR = "ownerR18";
  // CORR-LTI18-1: marker → recover → pause → resume must stay closed until a recovery completes
  const ck1 = await cgate("checkpointNow");
  await cgate("pause");
  await waitQuiet();
  ok((await cgate("marker", ck1.k)).ok && (await cgate("recover")).ok, "(CORR-LTI18-1 setup: marker, recover)");
  await cgate("pause");
  const bypass = await cgate("resume");
  ok(!bypass.ok && (await cgate("quiet")).mode === "paused", `CORR-LTI18-1: a pause during an unfinished recovery can't be resumed into normal (${JSON.stringify(bypass)})`);
  await waitQuiet();
  const again = await cgate("recover");
  ok(again.ok, `...only a recover again (a new recovery id: ${again.recovery_id})`);
  await recoverAll();
  ok((await cgate("resume")).ok && (await cgate("quiet")).mode === "normal", "...and once that recovery completes, resume reopens");

  // CORR-LTI18-2: after a restore to head k while the gate's next_seq is past k + 1, a due hourly probe sends nothing
  // while paused; quiet holds and the marker commits
  const sha = (await held(OR)).sha;
  const ck2 = await cgate("checkpointNow");
  const snap = await snapshotContent();
  await asg({ owner_ref: OR, bundle_sha: sha, title: "after k 1" });
  await asg({ owner_ref: OR, bundle_sha: sha, title: "after k 2" });
  await cgate("pause");
  await waitQuiet();
  ok(await restoreContent(snap), "(CORR-LTI18-2 setup: restored to head k, the gate's next_seq beyond k + 1)");
  await seam({ probe: { ok: true, R: probe.R, at: Date.now() - 2 * 3600_000 } });
  const s0 = (await gstate()).sends;
  await seam({ alarm: true });
  const direct = await cgate("probe");
  await sleep(1500);
  const s1 = (await gstate()).sends, qt = await cgate("quiet");
  ok(s1 === s0 && qt.quiet && !direct.ok, `CORR-LTI18-2: paused, neither the alarm's due probe nor a direct one sends anything (${s1 - s0} sends), and the gate stays quiet`);
  const mk = await cgate("marker", ck2.k);
  ok(mk.ok, `...so the marker commits as the first write after the restore (${JSON.stringify(mk)})`);
  ok((await cgate("recover")).ok, "(recover)");
  await recoverAll();
  ok((await cgate("resume")).ok, "(resumed)");
  await seam({ probe: { ok: true, R: probe.R } });

  // CORR-LTI18-3 (D4 r2 76a47612): the second attempt with one slow call in flight (≈ 25 s, below the deadline) and two
  // queued, on a ×10 gate clock (×100 before daybreak3's 56aec859 ruling, whose sibling audit found the same ≈ 0.6 s of
  // real headroom there; the delays ×10 to match): the queued calls wait at the front and start only after the protected
  // part (then commit); exactly one call is sent in it; it lasts ≤ 64.2 s; decision to end ≤ 125.2 s (D4 r3); every ticket
  // live at its start has ≥ 110 s (one under the margin is revoked there; one above commits after)
  const slowCase = async (delayMs, label) => {
    await seam({ scale: 10, bucket: "reset" });
    const ups = [];
    for (let i = 0; i < 3; i++) ups.push(await issR("upload", `slow${label}${i}`));
    const A = await issR("assignment", `slowA${label}`), U = await issR("upload", `slowU${label}`);
    // (the internal token full first, so the decision comes at once, while the first write is in flight; D4 r3
    // takes the token before the decision)
    await sleep(1100);
    await seam({ seam: { op: "delay", ms: delayMs, count: 1, writes_only: true }, ckpt_attempt: 1 });
    const writes = ups.map((t) => cgate("write", t.id, [{ sql: "SELECT 1" }]));
    await sleep(20);
    const c = await cgate("checkpointNow");
    const wr = await Promise.all(writes);
    const wa = await cgate("write", A.id, [{ sql: "SELECT 1" }]), wu = await cgate("write", U.id, [{ sql: "SELECT 1" }]);
    await seam({ scale: 1 });
    const before = await q("SELECT kind FROM gate_calls WHERE seq = ?", c.k - 1);
    const afterW = (await q("SELECT count(*) AS n FROM gate_calls WHERE seq > ? AND kind = 'write'", c.k)).n;
    for (const t of [...ups, A, U]) await cgate("giveBack", t.id);
    return { c, wr, wa, wu, before, afterW };
  };
  const t3 = await slowCase(2500, "a");
  ok(t3.c.outcome === "done" && t3.wr.every((r) => r.ok) && t3.before?.kind === "write" && t3.afterW >= 2, `D4 r2: the call in flight finishes before the checkpoint; the two queued calls wait and commit after it, unrevoked (${t3.wr.map((r) => r.ok || r.code)}; ${t3.afterW} writes after k)`);
  ok(t3.c.sends_in_protected === 1 && t3.c.protected_ms <= 64_200 && t3.c.decision_to_end_ms <= 125_200 && t3.c.min_left_at_start >= 110_000, `D4 r2: one call sent in the protected part; protected ≤ 64.2 s, decision to end ≤ 125.2 s, every ticket live at the start ≥ 110 s (${JSON.stringify({ sends: t3.c.sends_in_protected, protected: t3.c.protected_ms, decision_to_end: t3.c.decision_to_end_ms, min_left: t3.c.min_left_at_start })})`);
  ok(!t3.wa.ok && t3.wa.code === "ticket_expired" && t3.wu.ok, `D4 r2: a ticket under the margin at the start is revoked there; one with ≥ 110 s commits after (${t3.wa.code}, ${t3.wu.ok})`);
  // astra3's handoff (D4 r1's finding): the call in flight finishes at decision + 9.9 s, just as a queued one would
  // take over; under r2 it waits, so decision to end stays ≤ 125.2 s with one send in the protected part
  const th = await slowCase(990, "h");
  ok(th.c.outcome === "done" && th.c.sends_in_protected === 1 && th.c.decision_to_end_ms <= 125_200 && th.wr.every((r) => r.ok) && th.afterW >= 2, `D4 r2, the handoff: a queued call reaching the front at decision + 9.9 s waits for the protected part (${JSON.stringify({ decision_to_end: th.c.decision_to_end_ms, sends: th.c.sends_in_protected, after: th.afterW })})`);
  // astra3's D4-2 trace (D4 r3 §4, the weaker guarantee): six retained assignment tickets (120 s each) wait out a hold
  // of ≈ 5 s, then run one at a time, each ≈ 28 s (below the 30 s deadline): the fifth ticket expires DURING its call
  // (which commits: definitive), the sixth AT THE FRONT (409 ticket_expired); the sixth's operation restarts with a new
  // ticket, and every operation's effect lands exactly once
  await seam({ scale: 50, bucket: "reset" });
  const lease0 = (await q("SELECT until FROM sweep_lease")).until;
  const bump = [{ sql: "UPDATE sweep_lease SET until = until + 1 WHERE one = 1" }];
  const six = [];
  for (let i = 0; i < 6; i++) six.push(await issR("assignment", `d42-${i}`));
  await seam({ hold: true });
  const doneAt = [];
  const runs = six.map((t, i) => cgate("write", t.id, bump).then((o) => ((doneAt[i] = Date.now()), o)));
  await sleep(20);
  await seam({ skew: 5000, seam: { op: "delay", ms: 560, count: 6, writes_only: true } });
  // (the gate's clock at the release: ×50 from here, so each completion's gate time follows from its real time)
  const rel = await gstate();
  const relReal = Date.now(), relGate = rel.probe_meta.now;
  await seam({ hold: false });
  const outs = await Promise.all(runs);
  const tk = (await gstate()).tickets;
  await seam({ skew: 0, scale: 1, clear_seam: true });
  const gateDone = (i) => relGate + (doneAt[i] - relReal) * 50;
  const expiresOf = (i) => tk.find((x) => x.id === six[i].id)?.expires ?? 0;
  const atFront = outs.filter((o) => !o.ok && o.code === "ticket_expired").length;
  const during = outs.filter((o, i) => o.ok && gateDone(i) > expiresOf(i)).length;
  ok(atFront >= 1 && during >= 1 && outs.every((o) => o.ok || o.code === "ticket_expired"), `D4-2: after a hold, retained tickets' slow queued writes: at least one ticket expires DURING its call (the call commits: definitive) and at least one AT THE FRONT (409 ticket_expired) (${atFront} at the front, ${during} during a call; ${outs.map((o) => o.ok || o.code)})`);
  const redo = await issR("assignment", "d42-redo");
  const rr = await cgate("write", redo.id, bump);
  const lease1 = (await q("SELECT until FROM sweep_lease")).until;
  ok(rr.ok && lease1 - lease0 === outs.filter((o) => o.ok).length + 1 && lease1 - lease0 === 6 - atFront + 1, `D4-2: the expired operation restarts with a new ticket, and every operation's effect lands exactly once, with no duplicate (+${lease1 - lease0}: ${outs.filter((o) => o.ok).length} committed + 1 restarted)`);
  for (const t of [...six, redo]) await cgate("giveBack", t.id);
  // D4 r3's fail-closed budget: the margin re-check's transaction reports an overrun; the attempt is abandoned (an
  // alert, nothing sent, the hold released, the next attempt in 1 min), never a checkpoint inside the bound
  await seam({ txn_overrun: "recheck" });
  const sAb = (await gstate()).sends;
  const ab = await cgate("checkpointNow");
  const after = await issR("assignment", "after-abandon");
  const wAb = await cgate("write", after.id, [{ sql: "SELECT 1" }]);
  const stAb = await gstate();
  ok(ab.outcome === "abandoned" && ab.sent === false && stAb.sends - sAb === 1 && wAb.ok && Math.abs(stAb.ckpt_next - (Date.now() + 60_000)) < 15_000, `D4 r3: an overrun of a checkpoint transaction's budget abandons the attempt: nothing sent, the hold released, retried in 1 min (${JSON.stringify({ outcome: ab.outcome, txn_ms: ab.txn_ms })})`);
  await cgate("giveBack", after.id);
  // CORR-LTI18-4 (astra3): a resolution's final read that never answers. (a) A running write's: its answer is lost after
  // commit, its tombstone completes, its read is parked; the second attempt's hold must still end within the bound:
  // the resolution is unresolved within its shared budget, the record kept, the hold released, nothing sent past it,
  // and no later write passes the unresolved call. (b) The checkpoint's own: its answer lost, its read parked; the
  // attempt fails within the bound with the hold released and the record kept. On a ×10 gate clock (×100 before
  // daybreak3's 56aec859 ruling: each ≈ 60–64 s of gate time left ≈ 0.6 s of real headroom to 125.2 s there)
  const bounded = (p, ms) => Promise.race([p, sleep(ms).then(() => ({ outcome: "TIMED OUT (unbounded)" }))]);
  for (const which of ["running write", "checkpoint's own"]) {
    await seam({ scale: 10, bucket: "reset" });
    await sleep(1100);
    const W = await issR("upload", `park-${which[0]}`);
    let wp = null;
    if (which === "running write") {
      await seam({ seam: { op: "drop_answer", count: 1 }, park_read: 1, ckpt_attempt: 1 });
      wp = cgate("write", W.id, [{ sql: "SELECT 1" }]);
      await sleep(30);
    } else {
      await seam({ seam: { op: "drop_answer", count: 1 }, park_read: 1, ckpt_attempt: 0 });
    }
    const c = await bounded(cgate("checkpointNow"), 15_000);
    const st = await gstate();
    const later = await cgate("issue", "assignment", `after-park-${which[0]}`);
    await seam({ scale: 1 });
    ok(c.outcome !== "done" && c.outcome !== "TIMED OUT (unbounded)" && c.decision_to_end_ms <= 125_200 && st.ckpt === "none" && st.calls.length === 1 && !later.ok && later.code === "resolving", `CORR-LTI18-4 (${which}): a final read that never answers leaves the call unresolved within the shared budget, the record kept, the hold released within decision + 125.2 s, and the next issue refused as resolving (${JSON.stringify({ outcome: c.outcome, decision_to_end_ms: c.decision_to_end_ms, ckpt: st.ckpt, calls: st.calls.length, later: later.code })})`);
    if (which === "checkpoint's own") ok(c.sent === true && c.sends_in_protected >= 1, "...the checkpoint's own call was sent, then its uncertain resolution bounded");
    // (and the chain then resolves: the read answers on the next attempt; the queued work proceeds)
    let left = 1;
    for (let i = 0; i < 40 && left; i++) {
      await sleep(300);
      const t = await cgate("issue", "assignment", `drain-park-${which[0]}`);
      if (t.ok) await cgate("giveBack", t.id);
      left = (await gstate()).calls.length;
    }
    if (wp) await bounded(wp, 5000);
    ok(left === 0, `...then the chain resolves the call and moves on (${which})`);
    await cgate("giveBack", W.id);
    await seam({ ckpt_attempt: 0 });
  }
  // ...and an uncertain call in flight at the decision, its call and tombstone each at the 30 s deadline: the
  // checkpoint isn't sent past an unresolved call; it ends at once, and decision-to-end ≤ 125.2 s. On a ×10 gate clock
  // (daybreak3's 56aec859 ruling), the delays 3,500 ms real (35 s gate, past each 30 s deadline): the nominal ≈ 60 s of
  // gate time takes ≈ 6 s real and leaves ≈ 6.4 s of real scheduler headroom to the bound, not ≈ 0.64 s at ×100
  await seam({ scale: 10, bucket: "reset" });
  const F = await issR("upload", "inflight");
  await seam({ seam: { op: "delay", ms: 3500, count: 2 }, ckpt_attempt: 1 });
  const fw = cgate("write", F.id, [{ sql: "SELECT 1" }]);
  await sleep(20);
  const c4 = await cgate("checkpointNow");
  await fw;
  await seam({ scale: 1 });
  console.log("TIMING d4 in-flight unresolved", JSON.stringify({ outcome: c4.outcome, decision_to_end_ms: c4.decision_to_end_ms, protected_ms: c4.protected_ms, interval_ms: c4.interval_ms, sent: c4.sent, accounting: timerAccounting(c4), marks: c4.marks, timers: c4.timers }));
  ok(c4.outcome === "failed" && c4.decision_to_end_ms <= 125_200 && c4.sent === false, `D4: with the call in flight still unresolved at the start, no checkpoint is sent and the attempt ends within decision + 125.2 s (${JSON.stringify({ outcome: c4.outcome, decision_to_end: c4.decision_to_end_ms })})`);
  // (TEST-PRIVATE18-D4-CHAIN-1, daybreak3: what must happen, and by when. The call is unresolved. A resolution attempt
  // (an issue's resolveSoon, or the alarm armed RESOLVE_RETRY_MS = 5 s ahead) takes one internal token (≤ 1 s) and has
  // one 30 s budget for its tombstone and read; an attempt left unresolved re-arms the alarm 5 s ahead. So the chain
  // clears within two attempts and the retry between them: 2 × (1 s + 30 s) + 5 s = 67 s. Until then, the only refusal
  // an issue may give is 429 resolving: any other (as the 429 rate a clock step back's bucket debt gave) fails at once)
  const tChain = Date.now();
  let Fr, refusals = 0;
  for (;;) {
    Fr = await cgate("issue", "assignment", "after-inflight");
    if (Fr.ok || !(Fr.status === 429 && Fr.code === "resolving") || Date.now() - tChain > 67_000) break;
    refusals++;
    await sleep(200);
  }
  const chainMs = Date.now() - tChain;
  const FrW = Fr.ok ? await cgate("write", Fr.id, [{ sql: "SELECT 1" }]) : null;
  const FrSt = await gstate();
  ok(Fr.ok && FrW?.ok && FrSt.calls.length === 0 && chainMs <= 67_000, `...and the chain then resolves and moves on, within 2 × (1 s + 30 s) + 5 s = 67 s, refused meanwhile only as resolving (${JSON.stringify({ ms: chainMs, resolving_refusals: refusals, issue: Fr.ok || Fr, write: FrW && (FrW.ok || FrW), calls: FrSt.calls, ckpt: FrSt.ckpt, alarm_in_ms: FrSt.alarm === null ? null : FrSt.alarm - Date.now() }).slice(0, 1500)})`);
  if (Fr.ok) await cgate("giveBack", Fr.id);
  await cgate("giveBack", F.id);
  await seam({ ckpt_attempt: 0 });
  // TEST-PRIVATE18-D4-CHAIN-1's cause: a bucket last touched ahead of the gate's clock, which then steps back (as the ×100
  // test clock's return to ×1 does; as a wall clock may), must not count the step as debt. The env bucket, touched
  // 5 gate-seconds ahead (50 ms real at ×100), and an owner's, touched just as far ahead: the next issues are admitted
  await seam({ scale: 100, bucket: "reset" });
  await sleep(50);
  const dbt1 = await cgate("issue", "upload", "debt-owner");
  await seam({ scale: 1 });
  const dbt2 = await cgate("issue", "assignment", "debt-other");
  const dbt3 = await cgate("issue", "upload", "debt-owner");
  ok(dbt1.ok && dbt2.ok && dbt3.ok, `TEST-PRIVATE18-D4-CHAIN-1: a gate clock that stepped back past a bucket's last refill counts as no time passed, never as debt: the env and owner buckets admit the next issues (${JSON.stringify([dbt1, dbt2, dbt3].map((t) => t.ok || t))})`);
  for (const t of [dbt1, dbt2, dbt3]) if (t.ok) await cgate("giveBack", t.id);
  // TEST-PRIVATE18-REVOKE-1 (daybreak3, astra3): revocation is monotone. An upload ticket (one write accepted first: it is
  // usable) and a wake ticket (one delete intent admitted first), each left < 110 s, are revoked by a second attempt's
  // entry; after the checkpoint, its hold released, the gate clock steps back 60 s, so each is time-live again. Neither
  // can act: the write is refused 409 ticket_spent with no send, and the delete intent is refused
  await seam({ bucket: "reset" });
  const rvKey = `o/${"a".repeat(32)}/${"b".repeat(64)}/${"c".repeat(32)}`;
  const RU = await issR("upload", "revoke-u"), RW = await issR("wake", null);
  const ru0 = await cgate("write", RU.id, [{ sql: "SELECT 1" }]);
  const ri0 = await cgate("intent", RW.id, [rvKey]);
  if (ri0.ok) await cgate("resolveIntent", ri0.id);
  const st0 = await gstate();
  for (const t of [RU, RW]) await seam({ issued_ago: { id: t.id, ms: st0.tickets.find((x) => x.id === t.id).expires - st0.probe_meta.now - 50_000 } });
  // (no alarm inside the window: its cleanup would delete the revoked rows, and a missing ticket is refused anyway, so the
  // window where a revoked row still exists would go untested)
  await seam({ ckpt_attempt: 1, alarm_in: 3600_000 });
  const rc = await cgate("checkpointNow");
  await seam({ skew: -60_000 });
  const st1 = await gstate();
  const exp = (id) => st1.tickets.find((x) => x.id === id)?.expires ?? 0;
  const liveAgain = exp(RU.id) > st1.probe_meta.now && exp(RW.id) > st1.probe_meta.now;
  const rw = await cgate("write", RU.id, [{ sql: "SELECT 1" }]);
  const ri = await cgate("intent", RW.id, [rvKey]);
  const st2 = await gstate();
  if (ri.ok) await cgate("resolveIntent", ri.id);
  await seam({ skew: 0, ckpt_attempt: 0, rearm: true });
  for (const t of [RU, RW]) await cgate("giveBack", t.id);
  ok(RU.ok && RW.ok && ru0.ok && ri0.ok && rc.outcome === "done" && rc.revoked >= 2 && liveAgain, `(TEST-PRIVATE18-REVOKE-1 setup: both tickets usable before, both revoked by the checkpoint (${rc.outcome}, ${rc.revoked} revoked), both rows still there and time-live again after the 60 s step back (${JSON.stringify({ rows: [RU.id, RW.id].map((id) => !!st1.tickets.find((x) => x.id === id)), expires_minus_now: [exp(RU.id) - st1.probe_meta.now, exp(RW.id) - st1.probe_meta.now] })}))`);
  ok(!rw.ok && rw.status === 409 && rw.code === "ticket_spent" && st2.sends === st1.sends && !ri.ok && ri.code === "ticket", `TEST-PRIVATE18-REVOKE-1: after a backward clock step, a revoked ticket stays revoked: its write is refused 409 ticket_spent with no send, its delete intent refused (${JSON.stringify({ write: rw.ok || rw, sends: st2.sends - st1.sends, intent: ri.ok || ri })})`);
  // BOUND-PRIVATE18-D4-1 (daybreak3): one item stuck in flight past the failsafe's deadline, on a virtual gate clock
  // (now() stands still; each sleep advances it by exactly its length, so the polls' timing is deterministic): the
  // attempt is abandoned AT decision + 2 × 30 s + 1 s, never a poll past it; the hold released, nothing sent, the retry
  // armed in 1 min, and decision → end within its cap, so within 125.2 s
  await seam({ bucket: "reset" });
  await sleep(1100);
  await seam({ ckpt_attempt: 1, stuck_active: true, virtual: true });
  const sStuck = (await gstate()).sends;
  const cs = await bounded(cgate("checkpointNow"), 15_000);
  const stStuck = await gstate();
  await seam({ stuck_active: false, virtual: false, ckpt_attempt: 0 });
  const vNow = stStuck.probe_meta.now;
  ok(cs.outcome === "abandoned" && cs.sent === false && stStuck.sends === sStuck && !stStuck.hold && stStuck.ckpt === "none" && stStuck.ckpt_next === vNow + 60_000, `BOUND-PRIVATE18-D4-1: an item stuck in flight past the failsafe's deadline: the attempt is abandoned, the hold released, nothing sent, the retry armed in 1 min (${JSON.stringify({ outcome: cs.outcome, sent: cs.sent, sends: stStuck.sends - sStuck, hold: stStuck.hold, retry_in: stStuck.ckpt_next - vNow })})`);
  ok(cs.decision_to_end_ms === 61_000 && cs.decision_to_end_ms <= 125_200, `BOUND-PRIVATE18-D4-1: abandoned exactly at decision + 61 s on the virtual clock, no poll sleeping past the deadline, so decision → end ≤ 125.2 s (${cs.decision_to_end_ms} ms)`);
  const afterStuck = await issR("assignment", "after-stuck");
  ok(afterStuck.ok && (await cgate("write", afterStuck.id, [{ sql: "SELECT 1" }])).ok, "...and once the item ends, the queue moves on");
  await cgate("giveBack", afterStuck.id);
}

// ================= D3 r2's steady state (part 1, after the below-threshold control: the cloud CI split keeps D3 r2's
// two measurements, whose checks compare them, in one part; before the split it ran inside the load section, after the
// barrier and the mixes: its dense window is made by probes either way)
if (part("1")) {
  // ---- D3 r2's steady state: first a dense window, 1,000 retained, contiguous, ordinary chain rows (probes, 20 calls
  // each), then the same three page kinds on fresh populations: every write pays the prune, +1 read and +1 written
  let dense = await chainWindow();
  for (let i = 0; i < 200 && !(dense.count === 1000 && dense.max - dense.min + 1 === 1000 && dense.markers === 0); i++) {
    await cgate("probe");
    dense = await chainWindow();
  }
  console.log("D3 dense window", JSON.stringify(dense));
  ok(dense.count === 1000 && dense.max - dense.min + 1 === 1000 && dense.markers === 0, `D3 r2: a dense window first: 1,000 retained, contiguous, ordinary chain rows (${JSON.stringify(dense)})`);
  const d3Above = await d3Measure("above");
  {
    const a = d3Above, b = d3Below;
    const full = a.windows.every(([, x, y]) => x.count === 1000 && x.max - x.min + 1 === 1000 && y.count === 1000 && y.max - y.min + 1 === 1000);
    ok(full, `D3 r2 above: every measurement in a full, contiguous 1,000-row window (${JSON.stringify(a.windows.map(([l, x, y]) => [l, x.count, x.min, x.max, x.markers, y.count, y.max]))})`);
    ok(a.chain.n >= 4 && a.chain.read.length === 1 && a.chain.written.length === 1 && a.chain.read[0] === b.chain.read[0] + 1 && a.chain.written[0] === b.chain.written[0] + 1, `D3 r2 above: the lease's and every page write's chain statement reads and writes exactly one row more than below (${JSON.stringify({ below: b.chain, above: a.chain })})`);
    ok(a.sweep.pages >= 2 && a.sweep.read === 705 && a.sweep.written === 302 && a.sweep.all_wrote, `D3 r2 above: the worst full sweep page (it writes) reads 705 and writes 302 (${JSON.stringify(a.sweep)})`);
    ok(a.normal.pages >= 1 && a.normal.read === 3006 && a.normal.written === 3 && a.normal.all_wrote, `D3 r2 above: the worst normal scan page reads 3,006 and writes 3 (${JSON.stringify(a.normal)})`);
    ok(a.recovery.pages >= 1 && a.recovery.read === 7006 && a.recovery.written === 1003 && a.recovery.all_wrote, `D3 r2 above: the worst recovery scan page reads 7,006 and writes 1,003 (${JSON.stringify(a.recovery)})`);
  }
}

// ================= load: the barrier over time, the sustained mixes, and recovery at (scaled) size
if (part("2")) {
  // ---- the revoking barrier over time (daybreak3 r13/r14): staggered uploads, one reaching < 110 s every 10 s, held
  // and never returned, on a ×30 gate clock for 30 gate-minutes; no checkpoint is ever more than 144 s late
  await seam({ scale: 30, bucket: "reset" });
  await seam({ ckpt_next: Date.now(), checkpoints: "auto" });
  // (started by the runtime's own alarm, armed now: a direct alarm() call here ran beside the scheduled one, which then
  // found a checkpoint in progress and recorded it skipped (CI run 40163980154))
  await seam({ rearm: true });
  const heldTickets = [];
  const barStarted = new Date().toISOString(), bp0 = performance.now();
  while (performance.now() - bp0 < 60_000) {
    await reset();
    const t = await cgate("issue", "upload", `stagger${heldTickets.length % 50}`);
    if (t.ok) heldTickets.push(t.id);
    await sleep(333);
  }
  const barS = (performance.now() - bp0) / 1000, barFinished = new Date().toISOString();
  const allHist = (await gstate()).ckpt_history;
  await seam({ checkpoints: "manual", scale: 1 });
  for (const id of heldTickets) await cgate("giveBack", id);
  // (D4 r3 §3: from each checkpoint's due time, to its call sent ≤ 135.1 s and to its end ≤ 197.2 s, each plus the
  // firing delays of its own alarms (the first attempt's and the postponement's), reported separately)
  const hist = [];
  for (let i = 0; i < allHist.length; i++) {
    if (allHist[i].outcome !== "done") continue;
    const prev = allHist[i - 1]?.outcome === "postponed" ? allHist[i - 1] : null;
    hist.push({ ...allHist[i], fire_delays_ms: [prev?.fire_delay_ms ?? 0, allHist[i].fire_delay_ms ?? 0] });
  }
  // (the VM evidence's own verifier, every attempt inspected: decision → end ≤ 125.2 s, the transaction counts, D4 r3)
  const vb = verifyBarrier({ mode: "barrier", started: barStarted, finished: new Date().toISOString(), probe: { ok: true, R: 29 }, barrier: { minutes: 30, invocation: "test-content.mjs barrier compressed30", started: barStarted, finished: barFinished, duration_s: barS, history: allHist } }, "compressed30");
  ok(hist.length >= 2 && vb.length === 0 && hist.some((h) => h.revoked > 0), `(the verifier: ${vb.join("; ") || "clean"})` + `staggered uploads held for 30 gate-minutes: ${hist.length} checkpoints, each sent ≤ 135.1 s and ended ≤ 197.2 s after its due time, plus its alarms' firing delays (D4 r3) (${JSON.stringify(hist.map((h) => ({ sent_s: Math.round(h.due_to_sent_ms / 1000), end_s: Math.round(h.due_to_end_ms / 1000), fire_ms: h.fire_delays_ms, revoked: h.revoked })))})`);

  // ---- the sustained mixes (shortened in CI; 10 min real time on the VM): at the bucket's rate, with 8 clients
  const mix = async (name, op, seconds = 15) => {
    const codes = {};
    let n = 0, rt = 0;
    const end = Date.now() + seconds * 1000;
    await Promise.all(Array.from({ length: 8 }, async (_, c) => {
      while (Date.now() < end) {
        const s = Date.now();
        const r = await op(c, n++);
        rt += Date.now() - s;
        const code = r.status === 429 ? "429" : `${r.status}:${r.code ?? ""}`;
        codes[code] = (codes[code] ?? 0) + 1;
        if (r.status === 429) await sleep(200);
      }
    }));
    const st = await gstate();
    const bad = Object.keys(codes).filter((k) => /ticket_expired|resolving|ticket_spent|vanished/.test(k));
    ok(bad.length === 0 && st.calls.length === 0, `sustained ${name}: no ticket expires waiting, every outcome definitive (${JSON.stringify(codes)}; ${n} ops, mean round trip ${Math.round(rt / Math.max(1, n))} ms)`);
  };
  await mix("worst success mix (all uploads)", async (c, i) => {
    const r = await putBundle(`mixU${c}`, `synthetic bundle: mix ${c} ${i} ${randomUUID()}`);
    return { status: r.status, code: r.status === 200 ? "" : (await r.json().catch(() => ({}))).error };
  });
  await mix("all calls failing (each tombstoned)", async (c) => {
    const r = await admin("/lti/admin/assignment", { owner_ref: `mixF${c}`, actor_ref: "a", title: "T", runtime_policy: "either", max_points: 1, visibility: "institution", bundle_sha: "e".repeat(64) });
    return { status: r.status, code: (await r.json().catch(() => ({}))).error };
  });
  const sa = await held("mixA");
  await seam({ seam: { op: "fail_before_send", count: 1_000_000, calls_only: true } });
  await mix("all calls uncertain (each resolved by a tombstone)", async () => {
    const r = await admin("/lti/admin/assignment", { owner_ref: "mixA", actor_ref: "a", title: "T", runtime_policy: "either", max_points: 1, visibility: "institution", bundle_sha: sa.sha });
    return { status: r.status, code: (await r.json().catch(() => ({}))).error };
  });
  await seam({ clear_seam: true });

  // ---- recovery at scale, proportionally: 20,500 restored keys + 20,500 post-restore orphans (41 pages), an orphan at
  // the last possible prefix; ≤ ceil(103 × 41,000 / 4.02M) = 2 wakes, each within the recovery table at full page size
  const N = 20_500, owners = ["ownerScaleA", "ownerScaleB"];
  const digest = {};
  for (const o of owners) digest[o] = (await keyOf(o, "0".repeat(64), "0".repeat(32))).split("/")[1];
  const restored = Array.from({ length: N }, (_, i) => ({ owner: owners[i % 2], sha: hex(32), token: hex(16) }));
  const t1 = Date.now();
  for (const o of owners) {
    const mine = restored.filter((r) => r.owner === o);
    await fenced([{ sql: "INSERT OR IGNORE INTO owners (owner_ref, created) VALUES (?, ?)", params: [o, Date.now()] }]);
    for (let i = 0; i < mine.length; i += 5000) {
      const stmts = [];
      for (let k = i; k < Math.min(i + 5000, mine.length); k += 500)
        stmts.push({ sql: `INSERT INTO bundles (owner_ref, sha, size, state, token, deadline, due) SELECT ?, json_extract(value, '$.sha'), 1, 'reserved', json_extract(value, '$.token'), ${D1NOW} + 86400000, ${D1NOW} + 90000000 FROM json_each(?)`, params: [o, JSON.stringify(mine.slice(k, k + 500).map((r) => ({ sha: r.sha, token: r.token })))] });
      await fenced(stmts, "wake");
    }
  }
  const putAll = async (keys) => {
    for (let i = 0; i < keys.length; i += 200) await Promise.all(keys.slice(i, i + 200).map((k) => r2.put(k, "s")));
  };
  await putAll(restored.map((r) => `o/${digest[r.owner]}/${r.sha}/${r.token}`));
  const ckS = await cgate("checkpointNow");
  const snapS = await snapshotContent();
  const orphans = Array.from({ length: N - 1 }, () => `o/${hex(16)}/${hex(32)}/${hex(16)}`).concat([`o/${"f".repeat(32)}/${"f".repeat(64)}/${"f".repeat(32)}`]);
  await putAll(orphans);
  const buildMs = Date.now() - t1;
  // (a normal wake over this population first: 10 scan pages of 1,000, within the normal table at full size)
  const nw = await W({ maxSweepPages: 0 });
  ok(nw.scan_pages === 10 && nw.keys_listed === 10_000 && within(nw, NORMAL), `a full normal wake: 10 scan pages, 10,000 keys, within §2.5's normal table (${JSON.stringify({ calls: nw.d1_calls, statements: nw.statements, read: nw.rows_read, written: nw.rows_written, r2: nw.r2_calls })})`);
  await cgate("pause");
  await waitQuiet();
  ok(await restoreContent(snapS), `(the scaled restore, exact; built in ${Math.round(buildMs / 1000)} s)`);
  ok((await cgate("marker", ckS.k)).ok && (await cgate("recover")).ok, "(marker, recover)");
  const rid = (await cgate("recoveryState")).recovery_id;
  const tR = Date.now();
  const sw = await recoverAll();
  const left = (await r2.list({ prefix: `o/${"f".repeat(32)}/` })).objects.length;
  const seen = (await q("SELECT count(*) AS n FROM bundles WHERE owner_ref IN (?, ?) AND seen_cycle = ?", ...owners, rid)).n;
  const allOrphansGone = (await Promise.all(orphans.slice(0, 200).map((k) => r2.head(k)))).every((x) => !x);
  ok((await cgate("recoveryState")).done && sw.length <= 2 && left === 0 && allOrphansGone && seen === N, `recovery at scale: ${sw.length} wakes (≤ 2), every orphan deleted including the last prefix's, every restored row seen (${seen}/${N}; ${Math.round((Date.now() - tR) / 1000)} s)`);
  ok(sw.every((s) => within(s, RECOVERY)), `...each wake within the recovery table at full page size (${sw.map((s) => `${s.scan_pages} pages, ${s.statements} statements, ${s.rows_written} rows written, ${s.r2_calls} R2 calls`).join("; ")})`);
  ok((await cgate("resume")).ok, "(resumed)");
  // (measured worst pages, by kind and mode: the rows read and written D1 itself reports)
  const worst = (ws, kind, f) => Math.max(0, ...ws.flatMap((w) => w.pages.filter((p) => p.kind === kind).map((p) => p[f])));
  const all = [...wakes, nw].filter((w) => w.mode === "normal");
  const rec = [...wakes, ...sw].filter((w) => w.mode === "recovery");
  console.log("MEASURED", JSON.stringify({
    normal: { sweep_read: worst(all, "sweep", "rows_read"), sweep_written: worst(all, "sweep", "rows_written"), scan_read: worst(all, "scan", "rows_read"), scan_written: worst(all, "scan", "rows_written"), wake_read: Math.max(...all.map((w) => w.rows_read)), wake_written: Math.max(...all.map((w) => w.rows_written)), wake_statements: Math.max(...all.map((w) => w.statements)) },
    recovery: { sweep_read: worst(rec, "sweep", "rows_read"), scan_read: worst(rec, "scan", "rows_read"), scan_written: worst(rec, "scan", "rows_written"), wake_read: Math.max(...rec.map((w) => w.rows_read)), wake_written: Math.max(...rec.map((w) => w.rows_written)), wake_statements: Math.max(...rec.map((w) => w.statements)), wake_calls: Math.max(...rec.map((w) => w.d1_calls)) },
  }));
}

// ================= last: a restore that misses its checkpoint (it leaves the runbook stopped)
if (part("2")) {
  // ---- a restore that misses the checkpoint: the marker aborts; three misses stop the runbook
  const early = await snapshotContent();
  const ck3 = await cgate("checkpointNow");
  await cgate("pause");
  await waitQuiet();
  const misses = [];
  for (let i = 0; i < 4; i++) {
    await restoreContent(early);
    misses.push((await cgate("marker", ck3.k)).code);
  }
  ok(misses.join() === "missed,missed,stopped,stopped", `a restore to a time that misses the checkpoint makes the marker abort; three misses stop the runbook (${misses})`);
  const rcS = await cgate("recover"), rsS = await cgate("resume");
  ok(!rcS.ok && !rsS.ok && (await cgate("quiet")).mode === "paused", `the stopped runbook stays closed: no recover without a marker, and no resume after a restore was attempted (${rcS.code}, ${rsS.code})`);
}

// ================= the VM evidence verifier's own negative fixtures (daybreak3 VERIFY-1..3, astra3)
if (part("2")) {
  const t0 = "2026-10-25T00:00:00.000Z", t10 = "2026-10-25T00:10:01.000Z", t30 = "2026-10-25T00:30:01.000Z";
  const at = (s) => new Date(Date.parse(t0) + s * 1000).toISOString();
  const probeOk = { ok: true, R: 29 };
  // (the loop measured inside the run: from 0.5 s to 600.6 s, monotonic 600.1 s)
  const goodMix = { mode: "mix", started: t0, finished: t10, probe: probeOk, mix: { kind: "success", seconds: 600, invocation: "vm-content-runs.mjs mix 600 success", started: at(0.5), finished: at(600.6), duration_s: 600.1, R: 29, owners: 32, pending: 0, ops: 23000, codes: { 200: 8700, "429:rate": 14300 } } };
  ok(verify(goodMix, "mix:success").length === 0, "verifier: a good mix passes");
  const bad = (what, r, expect) => ok(verify(r, expect).length > 0, `verifier refuses ${what}`);
  bad("daybreak3's example mix (no kind, ops ≠ sum, a negative count)", { mode: "mix", started: t0, finished: t10, probe: probeOk, mix: { seconds: 600, ops: 999, codes: { 200: 1, "429:rate": -7 } } }, "mix:success");
  bad("a mix of another kind than expected", { ...goodMix, mix: { ...goodMix.mix, kind: "failing" } }, "mix:success");
  bad("a mix shorter than 600 s by its timestamps", { ...goodMix, finished: "2026-10-25T00:09:00.000Z" }, "mix:success");
  bad("a mix with any other 429", { ...goodMix, mix: { ...goodMix.mix, ops: 23001, codes: { ...goodMix.mix.codes, "429:busy": 1 } } }, "mix:success");
  bad("a mix with no unresolved count recorded", { ...goodMix, mix: { ...goodMix.mix, pending: undefined } }, "mix:success");
  bad("a mix that never saturated", { ...goodMix, mix: { ...goodMix.mix, ops: 100, codes: { 200: 100 } } }, "mix:success");
  bad("a mix with a failed probe", { ...goodMix, probe: { ok: false, R: 0 } }, "mix:success");
  // (astra3's TEST-PRIVATE18-VERIFY-4: setup inside the outer timestamps never counts as the workload)
  const goodU = { ...goodMix, mix: { ...goodMix.mix, kind: "uncertain", invocation: "vm-content-runs.mjs mix 600 uncertain", owners: 1, ops: 9000, codes: { "503:uncertain": 2900, "429:rate": 6100 } } };
  ok(verify(goodU, "mix:uncertain").length === 0, "verifier: a good one-owner uncertain mix passes");
  const mixWith = (o, r = {}) => ({ ...goodMix, ...r, mix: { ...goodMix.mix, ...o } });
  const mixBad = (what, o, r) => bad(what, mixWith(o, r), "mix:success");
  mixBad("astra3's mix: 1 s configured and looped, inside outer timestamps spanning 601 s", { seconds: 1, invocation: "vm-content-runs.mjs mix 1 success", started: at(599), finished: at(600), duration_s: 1 });
  mixBad("a mix with a long setup and a short loop (600 s configured, 60 s looped)", { started: at(540), finished: at(600), duration_s: 60 });
  mixBad("a mix whose loop is 1 s short of its configured 600 s", { started: at(1), finished: at(600), duration_s: 599 });
  mixBad("a mix whose loop ran far past its configuration", { seconds: 600, started: at(0), finished: at(900), duration_s: 900 }, { finished: at(901) });
  mixBad("a mix whose loop duration disagrees with its own timestamps", { duration_s: 610 });
  mixBad("a mix whose loop lies outside the run's timestamps", { started: at(-5) });
  mixBad("a mix with no loop timestamps", { started: undefined, finished: undefined });
  mixBad("a mix with no loop duration", { duration_s: undefined });
  mixBad("a mix with a non-finite loop duration", { duration_s: Infinity });
  // (daybreak3's TEST-PRIVATE18-VERIFY-1-R2: the configured workload, one field at a time)
  mixBad("a mix configured for 0 s", { seconds: 0, invocation: "vm-content-runs.mjs mix 0 success" });
  mixBad("a mix configured for 599 s", { seconds: 599, invocation: "vm-content-runs.mjs mix 599 success" });
  mixBad("a mix with no configured seconds", { seconds: undefined });
  mixBad("a mix with string seconds", { seconds: "600" });
  mixBad("a mix whose invocation doesn't match its configuration", { invocation: "vm-content-runs.mjs mix 60 success" });
  mixBad("a mix with no invocation", { invocation: undefined });
  mixBad("a mix at R = 0", { R: 0 });
  mixBad("a mix with no R", { R: undefined });
  mixBad("a mix at R = 30", { R: 30 });
  mixBad("a mix with no owners", { owners: undefined });
  mixBad("a mix with 0 owners", { owners: 0 });
  mixBad("a mix with -32 owners", { owners: -32 });
  mixBad("a mix with string owners", { owners: "32" });
  mixBad("a success mix over 1 owner", { owners: 1 });
  bad("an uncertain mix over 32 owners", { ...goodU, mix: { ...goodU.mix, owners: 32 } }, "mix:uncertain");
  bad("an uncertain mix with no owners", { ...goodU, mix: { ...goodU.mix, owners: undefined } }, "mix:uncertain");
  bad("an unknown kind named like a property", goodMix, "mix:constructor");
  const att = (o) => ({ outcome: "done", attempt: 1, due_at: 1000, fire_delay_ms: 5, due_to_sent_ms: 14_000, due_to_end_ms: 20_000, decision_to_end_ms: 6_000, protected_ms: 4_200, txn_ms: [1], sent: true, ...o });
  const goodBar = { mode: "barrier", started: t0, finished: t30, probe: probeOk, barrier: { minutes: 30, invocation: "vm-content-runs.mjs barrier 30", started: at(0.5), finished: at(1800.6), duration_s: 1800.1, history: [att({ due_at: 1 }), att({ due_at: 2 }), { outcome: "postponed", attempt: 1, due_at: 3, fire_delay_ms: 2 }, att({ attempt: 2, due_at: 3, txn_ms: [1, 1] })] } };
  ok(verify(goodBar, "barrier:30min").length === 0, "verifier: a good barrier passes");
  bad("astra3's example barrier (minutes 0, an empty history)", { mode: "barrier", started: t0, finished: t0, probe: probeOk, barrier: { minutes: 0, history: [] } }, "barrier:30min");
  bad("a barrier shorter than its profile by its timestamps", { ...goodBar, finished: "2026-10-25T00:20:00.000Z" }, "barrier:30min");
  const barWith = (o, r = {}) => ({ ...goodBar, ...r, barrier: { ...goodBar.barrier, ...o } });
  // (astra3's TEST-PRIVATE18-VERIFY-4: a long setup, a short loop, inside outer timestamps spanning 30 min)
  bad("a barrier with a long setup and a 10-min loop", barWith({ started: at(1200), finished: at(1800), duration_s: 600 }), "barrier:30min");
  // (daybreak3's TEST-PRIVATE18-VERIFY-2-R2: six-hour timestamps, but the body's minutes or invocation wrong)
  const t6 = at(21_700);
  const good6 = barWith({ minutes: 360, invocation: "vm-content-runs.mjs barrier 360", started: at(0.5), finished: at(21_600.6), duration_s: 21_600.1, history: Array.from({ length: 36 }, (_, i) => att({ due_at: i + 1 })) }, { finished: t6 });
  ok(verify(good6, "barrier:6h").length === 0, "verifier: a good six-hour barrier passes");
  bad("six-hour timestamps with the body's minutes 30", { ...good6, barrier: { ...good6.barrier, minutes: 30 } }, "barrier:6h");
  bad("six-hour timestamps with the body's minutes 0", { ...good6, barrier: { ...good6.barrier, minutes: 0 } }, "barrier:6h");
  bad("six-hour timestamps with no body minutes", { ...good6, barrier: { ...good6.barrier, minutes: undefined } }, "barrier:6h");
  bad("six-hour timestamps with the 30-min invocation", { ...good6, barrier: { ...good6.barrier, invocation: "vm-content-runs.mjs barrier 30" } }, "barrier:6h");
  bad("six-hour timestamps with no invocation", { ...good6, barrier: { ...good6.barrier, invocation: undefined } }, "barrier:6h");
  bad("six-hour timestamps with a 30-min duration_s", { ...good6, barrier: { ...good6.barrier, duration_s: 1800 } }, "barrier:6h");
  bad("six-hour timestamps with a negative duration_s", { ...good6, barrier: { ...good6.barrier, duration_s: -1 } }, "barrier:6h");
  bad("six-hour timestamps with a string duration_s", { ...good6, barrier: { ...good6.barrier, duration_s: "21600" } }, "barrier:6h");
  bad("six-hour timestamps with no duration_s", { ...good6, barrier: { ...good6.barrier, duration_s: undefined } }, "barrier:6h");
  bad("a duration_s 3 s off its own timestamps (tolerance 2 s)", barWith({ duration_s: 1803.2 }), "barrier:30min");
  bad("a six-hour body judged as the 30-min barrier", good6, "barrier:30min");
  bad("an unknown profile named like a property", goodBar, "barrier:constructor");
  bad("a 30-min barrier judged as the 6 h client", goodBar, "barrier:6h");
  bad("an attempt numbered 3", { ...goodBar, barrier: { ...goodBar.barrier, history: [...goodBar.barrier.history, att({ attempt: 3 })] } }, "barrier:30min");
  bad("a second attempt with no postponed first of the same due time", { ...goodBar, barrier: { ...goodBar.barrier, history: [att({ due_at: 1 }), att({ due_at: 2 }), att({ attempt: 2, due_at: 9, txn_ms: [1, 1] })] } }, "barrier:30min");
  bad("a negative timing", { ...goodBar, barrier: { ...goodBar.barrier, history: [att({ due_at: 1 }), att({ due_at: 2, protected_ms: -1 })] } }, "barrier:30min");
  bad("a missing transaction", { ...goodBar, barrier: { ...goodBar.barrier, history: [att({ due_at: 1 }), att({ due_at: 2, txn_ms: [] })] } }, "barrier:30min");
  bad("an abandoned attempt", { ...goodBar, barrier: { ...goodBar.barrier, history: [...goodBar.barrier.history, { outcome: "abandoned", attempt: 1, due_at: 9, fire_delay_ms: 0 }] } }, "barrier:30min");
  const wk = { outcome: "ok", d1_calls: 80, statements: 150, rows_read: 200_000, rows_written: 30_000, r2_calls: 80, keys_listed: 40_000, max_page_read: 7_005 };
  const cut = (label, objects) => ({ label, ok: true, k: 561, d1_head: 561, d1_rows_above_k: 0, next_seq: 562, mode: "paused", held: 40_000, objects });
  const goodRec = { mode: "recovery", started: t0, finished: t30, probe: probeOk, recovery: { keys: 80_000, wakes: 2, seen: 40_000, deleted: 40_000, valid_cycle: 1, orphan_sample: 3, orphan_sample_left: 0, per_wake: [wk, wk] },
    cut_checks: [cut("post-pause", 40_000), cut("pre-marker", 80_000)], runbook: { checkpoint: { outcome: "done", k: 561 }, pause: { mode: "paused" }, quiet: { quiet: true }, marker: { ok: true, seq: 562 }, recover: { ok: true, recovery_id: 1 }, resume: { ok: true } },
    final_state: { mode: "normal", calls: 0, tickets: 0, intents: 0, held: 40_000, objects: 40_000, seen: 40_000 } };
  ok(verify(goodRec, "recovery:80000").length === 0, "verifier: a good recovery passes");
  bad("astra3's empty recovery (all zero, no wakes)", { mode: "recovery", started: t0, finished: t0, probe: probeOk, recovery: { keys: 0, wakes: 0, seen: 0, deleted: 0, orphan_sample: 0, orphan_sample_left: 0, per_wake: [] } }, "recovery:0");
  bad("a recovery of another size than expected", goodRec, "recovery:4020000");
  bad("a recovery with a wake over the table", { ...goodRec, recovery: { ...goodRec.recovery, per_wake: [wk, { ...wk, statements: 215 }] } }, "recovery:80000");
  // (D3 r2's recovery table: a steady-state page of 7,006 rows read passes, 7,007 fails)
  ok(verify({ ...goodRec, recovery: { ...goodRec.recovery, per_wake: [wk, { ...wk, max_page_read: 7_006, rows_read: 287_296 }] } }, "recovery:80000").length === 0, "verifier: a recovery wake at D3 r2's bounds (7,006 per page, 287,296 per wake) passes");
  bad("a recovery wake with a page of 7,007 rows read", { ...goodRec, recovery: { ...goodRec.recovery, per_wake: [wk, { ...wk, max_page_read: 7_007 }] } }, "recovery:80000");
  bad("a recovery wake of 287,297 rows read", { ...goodRec, recovery: { ...goodRec.recovery, per_wake: [wk, { ...wk, rows_read: 287_297 }] } }, "recovery:80000");
  bad("a recovery whose history doesn't match its wake count", { ...goodRec, recovery: { ...goodRec.recovery, wakes: 3 } }, "recovery:80000");
  // (the run-3 rulings: the runner's fail-closed record, its cut checks, its raw runbook results, its final state)
  bad("a recovery that recorded a failure", { ...goodRec, failed: { phase: "cut_post_pause", what: "cut check post-pause" } }, "recovery:80000");
  bad("a recovery with rows above k at its pre-marker cut check (run 3's 40 probe rows)", { ...goodRec, cut_checks: [goodRec.cut_checks[0], { ...goodRec.cut_checks[1], d1_head: 601, d1_rows_above_k: 40 }] }, "recovery:80000");
  bad("a recovery with only one cut check", { ...goodRec, cut_checks: [goodRec.cut_checks[0]] }, "recovery:80000");
  bad("a recovery whose marker failed", { ...goodRec, runbook: { ...goodRec.runbook, marker: { ok: false, code: "redo" } } }, "recovery:80000");
  bad("a recovery whose recovery id isn't the valid cycle", { ...goodRec, runbook: { ...goodRec.runbook, recover: { ok: true, recovery_id: 2 } } }, "recovery:80000");
  bad("a recovery that never resumed", { ...goodRec, runbook: { ...goodRec.runbook, resume: undefined } }, "recovery:80000");
  bad("a recovery whose final state has orphans left", { ...goodRec, final_state: { ...goodRec.final_state, objects: 40_001 } }, "recovery:80000");
  bad("an unknown expectation", goodRec, "barrier");
  // (the scaled-clock lateness accounting, pure: #18's timing rulings. At ×10: a gap requested 2,050 gate-ms = 205 ms
  // real that resumed 5 ms late (50 gate-ms), the call's deadline timer 1 ms late (10), the tombstone's timer on time, a
  // gap 2,000 on time; an entry poll before the decision is outside the protected part)
  const tm = (o) => ({ kind: "sleep", label: "gap", scale: 10, virtual: false, won: "timer", sched_wall: 1, sched_gate: 1, resumed_gate: 2, ...o });
  const rec = (kind, label, req, s, el, won = "timer") => { const over = won === "timer" ? Math.max(0, el - req) : 0; return tm({ kind, label, won, requested_real_ms: req, requested_gate_ms: req * 10, sched_mono: s, fired_mono: won === "timer" ? s + Math.min(el, req) : null, resumed_mono: s + el, elapsed_real_ms: el, overshoot_real_ms: over, overshoot_gate_ms: over * 10 }); };
  const goodAcc = { protected_ms: 64_210, decision_to_end_ms: 64_310, interval_ms: 64_500,
    marks: { t0: { mono: 0 }, decision: { mono: 10 }, start: { mono: 20 }, end: { mono: 6_441 } },
    timers: [rec("sleep", "entry_poll", 5, 1, 5), rec("sleep", "gap", 205, 20, 210), rec("deadline", "checkpoint", 3000, 230, 3001), rec("deadline", "tombstone", 3000, 3231, 3000), rec("sleep", "gap", 200, 6231, 200)] };
  const ga = timerAccounting(goodAcc);
  ok(ga.failures.length === 0 && ga.phases.protected.overshoot_ms === 60 && ga.phases.protected.adjusted_ms === 64_150 && ga.phases.interval.timers === 5 && ga.phases.protected.timers === 4 && JSON.stringify(requestedGaps(goodAcc)) === "[2050,2000]", `timer accounting: a valid record set reconciles; only the protected part's own timers count there (${JSON.stringify(ga)})`);
  const accBad = (what, mut) => {
    const c = JSON.parse(JSON.stringify(goodAcc));
    mut(c);
    ok(timerAccounting(c).failures.length > 0, `timer accounting refuses ${what}`);
  };
  accBad("a negative value", (c) => (c.timers[1].overshoot_real_ms = -1));
  accBad("a non-finite value", (c) => (c.timers[2].elapsed_real_ms = null));
  accBad("an unknown kind", (c) => (c.timers[0].kind = "nap"));
  accBad("an elapsed time that doesn't reconcile with its stamps", (c) => (c.timers[1].elapsed_real_ms += 1));
  accBad("an overshoot that doesn't reconcile", (c) => (c.timers[1].overshoot_real_ms = 50));
  accBad("a wrong unit conversion (gate overshoot ≠ real × scale)", (c) => (c.timers[1].overshoot_gate_ms = 5));
  accBad("a wrong requested conversion", (c) => (c.timers[1].requested_gate_ms = 205));
  accBad("overlapping (double-counted) intervals", (c) => c.timers.push({ ...c.timers[2] }));
  accBad("a timer that won but never fired", (c) => (c.timers[2].fired_mono = null));
  accBad("a timer whose work won but fired", (c) => { c.timers[3].won = "work"; c.timers[3].overshoot_real_ms = 0; c.timers[3].overshoot_gate_ms = 0; });
  accBad("a sleep not won by its timer", (c) => { c.timers[1].won = "work"; c.timers[1].fired_mono = null; c.timers[1].overshoot_real_ms = 0; c.timers[1].overshoot_gate_ms = 0; });
  accBad("an adjusted figure below zero", (c) => (c.protected_ms = 10));
  accBad("missing records", (c) => delete c.timers);
  {
    // (a deadline whose D1 work won subtracts nothing)
    const c = JSON.parse(JSON.stringify(goodAcc));
    c.timers[3] = rec("deadline", "tombstone", 3000, 3231, 2900, "work");
    const a = timerAccounting(c);
    ok(a.failures.length === 0 && a.phases.protected.overshoot_ms === 60, `timer accounting: a deadline whose work won subtracts nothing (${JSON.stringify(a.phases.protected)})`);
  }
  // (the predeclared ×1 worst case's verifier, bound:x1: a synthetic report at scale 1)
  const r1 = (kind, label, req, s, el, won = "timer") => ({ ...rec(kind, label, req, s, el, won), scale: 1, requested_gate_ms: req, overshoot_gate_ms: won === "timer" ? Math.max(0, el - req) : 0 });
  const bc = { outcome: "failed", sent: true, sends_in_protected: 2, protected_ms: 64_150, interval_ms: 64_900, decision_to_end_ms: 64_150, due_to_end_ms: 65_000, fire_delay_ms: 0, gaps: [2050, 2080],
    marks: { t0: { mono: 0 }, decision: { mono: 700 }, start: { mono: 700 }, end: { mono: 64_850 } },
    timers: [r1("sleep", "token", 600, 10, 600), r1("sleep", "gap", 2050, 700, 2050), r1("deadline", "checkpoint", 30_000, 2750, 30_000), r1("deadline", "tombstone", 30_000, 32_750, 30_000), r1("sleep", "gap", 2080, 62_760, 2080)] };
  const goodBound = { mode: "bound", started: t0, finished: t10, probe: probeOk, bound: { invocation: "vm-content-runs.mjs bound", checkpoint: bc, chain: { ms: 1500, resolving_refusals: 4, issue: true, write: true, calls: 0 } } };
  ok(verify(goodBound, "bound:x1").length === 0, `verifier: a good ×1 bound report passes (${verify(goodBound, "bound:x1").join("; ")})`);
  const bnd = (what, mut) => {
    const r = JSON.parse(JSON.stringify(goodBound));
    mut(r.bound);
    bad(what, r, "bound:x1");
  };
  // (CORR-PRIVATE18-TIMING-1, -2: the raw protected bound has no slack, in both gates; a boundary control at 64,200 and
  // 64,201, and the old +500 predicate as a mutation, which accepted 64,201)
  const rawAt = (ms) => ({ ...bc, protected_ms: ms, decision_to_end_ms: ms });
  ok(PROTECTED_MAX_MS === 64_200 && rawD4Failures(rawAt(64_200)).length === 0 && rawD4Failures(rawAt(64_201)).length === 1, `the raw D4 check: protected 64,200 ms passes, 64,201 fails (${rawD4Failures(rawAt(64_201)).join("; ")})`);
  const oldX10 = (c) => c.outcome !== "done" && c.sent === true && c.sends_in_protected === 2 && c.protected_ms <= 64_200 + 500 && c.decision_to_end_ms <= 125_200 && c.due_to_end_ms <= 197_200 + (c.fire_delay_ms ?? 0);
  ok(oldX10(rawAt(64_201)) === true && rawD4Failures(rawAt(64_201)).length > 0, "mutation: the old ×10 predicate (64,200 + 500) accepted 64,201; the corrected check refuses it");
  const atB = (ms) => { const r = JSON.parse(JSON.stringify(goodBound)); r.bound.checkpoint.protected_ms = ms; r.bound.checkpoint.decision_to_end_ms = ms; return r; };
  ok(verify(atB(64_200), "bound:x1").length === 0, `bound:x1: protected 64,200 ms passes (${verify(atB(64_200), "bound:x1").join("; ")})`);
  bad("a ×1 bound with protected 64,201 ms (the old verifier's 64,700 accepted it)", atB(64_201), "bound:x1");
  bnd("a ×1 bound with protected 64,701 ms", (b) => (b.checkpoint.protected_ms = 64_701));
  bnd("a ×1 bound with interval 74,701 ms", (b) => (b.checkpoint.interval_ms = 74_701));
  bnd("a ×1 bound with one send in the protected part", (b) => (b.checkpoint.sends_in_protected = 1));
  bnd("a ×1 bound that was done", (b) => (b.checkpoint.outcome = "done"));
  bnd("a ×1 bound with a requested gap of 1,999", (b) => { b.checkpoint.timers[1] = r1("sleep", "gap", 1999, 700, 1999); });
  bnd("a ×1 bound with a timer at scale 10", (b) => (b.checkpoint.timers[0].scale = 10));
  bnd("a ×1 bound whose chain took 67,001 ms", (b) => (b.chain.ms = 67_001));
  bnd("a ×1 bound whose next write failed", (b) => (b.chain.write = { ok: false }));
  const { spawnSync } = await import("node:child_process");
  // the recovery runner's cut (the run-3 rulings), the real runner on a small population (300 restored + 300 orphans):
  // (a) an hourly probe due while paused, its alarm firing during the orphan fill: no probe is sent, the cut holds at
  // both checks, and the run completes and passes the verifier; (b) a probe landing between the checkpoint and the
  // pause (run 3's failure, made deterministic): the runner stops at the post-pause cut check, writes its report with the
  // phase and the rows above k, and exits non-zero, before any orphan is built
  {
    const { mkdtempSync, readFileSync: rf } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const runRunner = (env) => {
      const dir = mkdtempSync(join(tmpdir(), "rec-runner-"));
      const r = spawnSync(process.execPath, [join(here, "vm-content-runs.mjs"), "recovery", "300"], { env: { ...process.env, CONTENT_RUN_DIR: dir, ...env }, encoding: "utf8", timeout: 600_000 });
      let rep = null;
      try { rep = JSON.parse(rf(join(dir, "report-recovery.json"), "utf8")); } catch {}
      return { status: r.status, rep, tail: `${r.stdout ?? ""}${r.stderr ?? ""}`.slice(-1500) };
    };
    const a = runRunner({ RECOVERY_TEST_PROBE_DUE: "1" });
    const va = a.rep ? verify(a.rep, "recovery:600") : ["no report"];
    ok(a.status === 0 && va.length === 0 && a.rep.runbook?.probe_due && a.rep.cut_checks?.every((c) => c.ok && c.d1_rows_above_k === 0), `runner: an hourly probe due while paused during the orphan fill sends nothing; both cut checks hold at k; the run completes and verifies (${JSON.stringify({ status: a.status, verifier: va, cuts: a.rep?.cut_checks?.map((c) => [c.label, c.ok, c.d1_head, c.k, c.probe_at, c.probe_at_before]) })} ${a.status ? a.tail : ""})`);
    const b = runRunner({ RECOVERY_TEST_INJECT: "post_k" });
    const cb = b.rep?.cut_checks?.[0];
    ok(b.status !== 0 && b.rep?.failed?.phase === "cut_post_pause" && cb && cb.ok === false && cb.d1_rows_above_k > 0 && b.rep.cut_checks.length === 1 && !b.rep.phases?.build_orphans && !b.rep.runbook?.marker, `runner: a chain row landing after k before the pause stops the run at the post-pause cut check, recorded, non-zero, before the orphan build and the marker (${JSON.stringify({ status: b.status, failed: b.rep?.failed?.phase, what: b.rep?.failed?.what, above: cb?.d1_rows_above_k, head: cb?.d1_head, k: cb?.k })})`);
  }
  const cli = spawnSync(process.execPath, [join(here, "vm-content-verify.mjs")], { encoding: "utf8" });
  ok(cli.status !== 0, `verifier: a zero-input CLI fails (status ${cli.status})`);
}

console.log(`${count - failures}/${count} passed`);
await mf.dispose();
process.exit(failures ? 1 : 0);
