// The real-time and full-size runs that anchor test-content.mjs's substitutions (amendment 3's delivery delta,
// daybreak3 4318d4b9): on a VM, not in CI.  Synthetic data only.  One mode per invocation:
//   node web/cloud/lti/vm-content-runs.mjs mix <seconds> [kind]       a sustained mix, 8 clients, real time; kind: success (all
//                                                               uploads, the default), failing (every call refused and
//                                                               tombstoned), uncertain (every call uncertain, resolved)
//   node web/cloud/lti/vm-content-runs.mjs recovery <keys per side>   recovery at full size: restored rows + their objects, the
//                                                               same number of post-restore orphans (one at the last prefix)
//   node web/cloud/lti/vm-content-runs.mjs barrier <minutes>          staggered uploads, one every 10 s, held to expiry; real-time
//                                                               checkpoints, each one's lateness (≤ 144 s)
//   node web/cloud/lti/vm-content-runs.mjs bound                      the worst-case checkpoint at ×1: its call and its tombstone
//                                                               each held past the 30 s deadline; then the chain recovers
// Miniflare's storage goes under $CONTENT_RUN_DIR (default ./content-run); a JSON report goes to $CONTENT_RUN_DIR/report-<mode>.json.
import { readFileSync, readdirSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { createHash, createHmac, generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { requestedGaps, timerAccounting, verifyBarrier, verifyBound, verifyMix, verifyRecovery } from "./vm-content-verify.mjs";
import { dispatch } from "../../miniflare-dispatch.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(here, "../../site/package.json"));
const { Miniflare, convertV4MiniflareOptions } = require("miniflare");
const [mode, arg] = process.argv.slice(2);
if (!["mix", "recovery", "barrier", "bound"].includes(mode)) throw new Error("mode: mix | recovery | barrier | bound");
const runDir = process.env.CONTENT_RUN_DIR ?? join(process.cwd(), "content-run");
mkdirSync(runDir, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hex = (n) => randomBytes(n).toString("hex");
const log = (...a) => console.log(new Date().toISOString(), ...a);
const failures = [];
const ok = (cond, what) => {
  log(cond ? "ok  " : "FAIL", what);
  if (!cond) failures.push(what);
};

const TOOL = "https://lti.vmtest";
const LTI_KEY = "lti-vm-key";
const TOOL_KEY = JSON.stringify({ ...generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ format: "jwk" }), kid: "tool1" });
const script = execFileSync("bun", ["build", join(here, "test-entry.ts"), "--format", "esm", "--target", "browser", "--external", "cloudflare:workers"], { encoding: "utf8" });
const objects = { LTI_REG: { className: "LtiReg", useSQLite: true }, LTI_SHARD: { className: "LtiLaunchShard", useSQLite: true }, LTI_COURSE: { className: "LtiCourse", useSQLite: true }, LTI_FLEET: { className: "LtiFleet", useSQLite: true }, LTI_GATE: { className: "LtiContentGate", useSQLite: true } };
const mf = new Miniflare(convertV4MiniflareOptions({
  resourcePersistencePath: join(runDir, `mf-${mode}`),
  workers: [{
    name: "lti", modules: true, script, compatibilityDate: "2026-10-01",
    bindings: { ENV: "vm-test", LTI_ORIGIN: TOOL, LTI_KEY, TOOL_KEY, LTI_SYNTHETIC_ENTITLEMENT: "1", MAPPING_BACKUP_KEY: "vm-backup-key", COCALC_ORIGIN: "https://cocalc.vmtest" },
    d1Databases: ["LTI_DB", "LTI_AUDIT", "LTI_CONTENT"], r2Buckets: ["LTI_BUNDLES"], durableObjects: objects, routes: ["lti.vmtest/*"],
    outboundService: () => new Response("not found", { status: 404 }),
    ratelimits: { LTI_PREAUTH: { namespace_id: "2201", simple: { limit: 1000000, period: 60 } } },
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
const cgate = async (m, ...args) => j(await tool("/__test/cgate", { method: "POST", body: JSON.stringify({ m, args }) }));
const seam = (op) => cgate("testSeam", op);
const q = (sql, ...p) => content.prepare(sql).bind(...p).first();
const sha256hex = (b) => createHash("sha256").update(b).digest("hex");
async function putBundle(owner, body) {
  const t = Date.now(), buf = Buffer.from(body);
  const meta = JSON.stringify({ actor_ref: "a", owner_ref: owner, request_id: randomUUID().replace(/-/g, ""), sha256: sha256hex(buf), size: buf.length });
  const sig = createHmac("sha256", LTI_KEY).update(`PUT\n/lti/admin/bundle\n${t}\n${meta}`).digest("hex");
  return tool("/lti/admin/bundle", { method: "PUT", headers: { "x-lti-time": String(t), "x-lti-signature": sig, "x-lti-meta": meta }, body: buf });
}
const issR = async (kind, owner) => {
  for (let i = 0; ; i++) {
    const t = await cgate("issue", kind, owner);
    if (t.ok || t.status !== 429 || i >= 100) return t;
    await sleep(250);
  }
};
const fenced = async (stmts) => {
  const t = await issR("wake", null);
  if (!t.ok) throw new Error(`issue ${JSON.stringify(t)}`);
  try {
    const r = await cgate("write", t.id, stmts);
    if (!r.ok) throw new Error(`write ${JSON.stringify(r).slice(0, 300)}`);
    return r;
  } finally {
    await cgate("giveBack", t.id);
  }
};
const D1NOW = "CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)";
// (§2.5's table with the A3-2 deltas and D3 r2's chain prune, +1 read and +1 written per page or lease write in steady state)
const NORMAL = { d1_calls: 41, statements: 82, rows_read: 37_116, rows_written: 3_074, r2_calls: 30, keys_listed: 10_000 };
const RECOVERY = { d1_calls: 101, statements: 214, rows_read: 287_296, rows_written: 43_196, r2_calls: 90, keys_listed: 40_000 };
const PAGE_READ = { sweep: 705, normal: 3006, recovery: 7006 };
const within = (s, b) => Object.entries(b).every(([k, v]) => s[k] <= v) && s.pages.every((p) => p.statements <= (p.kind === "sweep" ? 5 : 6) && p.rows_read <= (p.kind === "sweep" ? PAGE_READ.sweep : PAGE_READ[s.mode === "recovery" ? "recovery" : "normal"]));
const report = { mode, arg, started: new Date().toISOString(), host: process.env.HOSTNAME ?? null };

await seam({ checkpoints: mode === "barrier" ? "auto" : "manual" });
const probe = await cgate("probe");
report.probe = probe;
ok(probe.ok, `the probe: ${JSON.stringify(probe)}`);

if (mode === "mix") {
  // success: every op an upload (3 calls' weight); failing: an assignment write on a bundle nobody holds (refused by
  // trigger, tombstoned); uncertain: an assignment write whose every call answer is lost before sending (tombstoned).
  // 8 clients, at whatever rate the gate admits
  const seconds = Number(arg ?? 600), kind = process.argv[4] ?? "success";
  if (!["success", "failing", "uncertain"].includes(kind)) throw new Error("kind: success | failing | uncertain");
  let sha = null;
  if (kind === "uncertain") {
    const body = `synthetic bundle: vm uncertain ${randomUUID()}`;
    const r = await putBundle("mixU", body);
    if (r.status !== 200) throw new Error(`setup upload ${r.status}`);
    sha = sha256hex(Buffer.from(body));
    await seam({ seam: { op: "fail_before_send", count: 100_000_000, calls_only: true } });
  }
  const assignment = (owner, bundle_sha) => {
    const t = Date.now();
    const b = JSON.stringify({ request_id: randomUUID().replace(/-/g, ""), owner_ref: owner, actor_ref: "a", title: "T", runtime_policy: "either", max_points: 1, visibility: "institution", bundle_sha });
    const sig = createHmac("sha256", LTI_KEY).update(`POST\n/lti/admin/assignment\n${t}\n${b}`).digest("hex");
    return tool("/lti/admin/assignment", { method: "POST", headers: { "content-type": "application/json", "x-lti-time": String(t), "x-lti-signature": sig }, body: b });
  };
  const codes = {}, rts = [];
  let n = 0;
  // (the workload loop itself, measured immediately around it on the monotonic clock: setup never counts, VERIFY-4)
  const loopStarted = new Date().toISOString(), p0 = performance.now();
  const end = p0 + seconds * 1000;
  await Promise.all(Array.from({ length: 8 }, async (_, c) => {
    for (let i = 0; performance.now() < end; i++) {
      const s = Date.now();
      const r = kind === "success" ? await putBundle(`mix${c}-${i % 4}`, `synthetic bundle: vm mix ${c} ${i} ${randomUUID()}`)
        : kind === "failing" ? await assignment(`mixF${c}-${i % 4}`, "e".repeat(64))
        : await assignment("mixU", sha);
      const ms = Date.now() - s;
      n++;
      const code = r.status === 200 ? "200" : `${r.status}:${(await r.json().catch(() => ({}))).error ?? ""}`;
      codes[code] = (codes[code] ?? 0) + 1;
      // (the expected definitive outcomes: success 200; failing 404 no_bundle; uncertain 503 uncertain)
      if (r.status !== 429) rts.push(ms);
      else if (r.status === 429) await sleep(250);
    }
  }));
  const loopS = (performance.now() - p0) / 1000, loopFinished = new Date().toISOString();
  rts.sort((a, b) => a - b);
  const pct = (p) => rts[Math.min(rts.length - 1, Math.floor((p / 100) * rts.length))];
  const st = await cgate("testState");
  if (kind === "uncertain") await seam({ clear_seam: true });
  const want = { success: "200", failing: "404:no_bundle", uncertain: "503:uncertain" }[kind];
  report.mix = { kind, seconds, invocation: `vm-content-runs.mjs mix ${seconds} ${kind}`, started: loopStarted, finished: loopFinished, duration_s: loopS, owners: kind === "uncertain" ? 1 : 32, pending: st.calls.length, ops: n, codes, ops_per_s: (codes[want] ?? 0) / loopS, calls_per_s: (2 * (codes[want] ?? 0)) / loopS, rt_ms: { mean: Math.round(rts.reduce((a, b) => a + b, 0) / Math.max(1, rts.length)), p50: pct(50), p99: pct(99), max: rts.at(-1) }, R: st.R };
  // (judged by the verifier's rule: only the kind's outcome and 429:rate, nothing else; no call left unresolved)
  report.finished = new Date().toISOString();
  const bad = verifyMix(report, kind);
  ok(bad.length === 0 && st.calls.length === 0, `the ${kind} mix for ${seconds} s: no ticket expires waiting, every outcome definitive, only ${want} and 429:rate (${bad.join("; ") || "clean"}; ${JSON.stringify(report.mix)})`);
}

if (mode === "barrier") {
  // staggered uploads, one every 10 s, each held until it expires: one reaches < 110 s left every 10 s, so every
  // checkpoint's first attempt is postponed and the second revokes; none may start more than 144 s late
  const minutes = Number(arg ?? 30);
  const held = [];
  let refused = 0;
  // (the workload loop itself, measured immediately around it on the monotonic clock: setup never counts, VERIFY-4)
  const loopStarted = new Date().toISOString(), p0 = performance.now();
  const end = p0 + minutes * 60_000;
  while (performance.now() < end) {
    await seam({ bucket: "reset" });
    const t = await cgate("issue", "upload", `stagger${held.length % 50}`);
    if (t.ok) held.push(t.id);
    else refused++;
    await sleep(10_000);
  }
  const loopS = (performance.now() - p0) / 1000, loopFinished = new Date().toISOString();
  const st = await cgate("testState");
  // (D4 r3 §3: every attempt as the gate recorded it; a checkpoint's own firing delays are its first attempt's and,
  // if postponed, its second's; each done checkpoint: due → sent ≤ 135.1 s and due → end ≤ 197.2 s, plus those delays)
  const all = st.ckpt_history;
  const done = [];
  for (let i = 0; i < all.length; i++) {
    if (all[i].outcome !== "done") continue;
    const prev = all[i - 1]?.outcome === "postponed" ? all[i - 1] : null;
    done.push({ ...all[i], fire_delays_ms: [prev?.fire_delay_ms ?? 0, all[i].fire_delay_ms ?? 0] });
  }
  const fd = (h) => h.fire_delays_ms[0] + h.fire_delays_ms[1];
  const okEach = (h) => h.due_to_sent_ms <= 135_100 + fd(h) && h.due_to_end_ms <= 197_200 + fd(h) && h.protected_ms <= 64_200 && (h.txn_ms ?? []).every((t) => t <= 1000);
  report.barrier = {
    minutes, issued: held.length, refused_at_issue: refused, attempts: all.length,
    outcomes: all.reduce((a, h) => ((a[h.outcome] = (a[h.outcome] ?? 0) + 1), a), {}),
    done: done.length,
    invocation: `vm-content-runs.mjs barrier ${minutes}`, started: loopStarted, finished: loopFinished, duration_s: loopS,
    max: { decision_to_end_s: Math.max(0, ...done.map((h) => h.decision_to_end_ms)) / 1000, due_to_sent_s: Math.max(0, ...done.map((h) => h.due_to_sent_ms)) / 1000, due_to_end_s: Math.max(0, ...done.map((h) => h.due_to_end_ms)) / 1000, protected_s: Math.max(0, ...done.map((h) => h.protected_ms)) / 1000, txn_ms: Math.max(0, ...done.flatMap((h) => h.txn_ms ?? [])), fire_delay_ms: Math.max(0, ...all.map((h) => h.fire_delay_ms ?? 0)) },
    history: all,
  };
  void okEach;
  report.finished = new Date().toISOString();
  const badB = verifyBarrier(report, minutes >= 360 ? "6h" : "30min");
  ok(badB.length === 0, `the revoking barrier for ${minutes} min in real time (every attempt inspected: ${badB.join("; ") || "clean"}): ${done.length} checkpoints, each sent ≤ 135.1 s and ended ≤ 197.2 s after its due time plus its alarms' firing delays, protected ≤ 64.2 s, transactions ≤ 1 s (D4 r3) (${JSON.stringify(report.barrier.max)})`);
  for (const id of held) await cgate("giveBack", id);
}

if (mode === "bound") {
  // the #18 timing rulings' predeclared ×1 run (astra3 0ca0422a, daybreak3 71188d1b): the checkpoint's call and its
  // tombstone each held 35 s, past the 30 s deadline (×10's 3,500 ms, unscaled), due now; raw bounds; then the unresolved
  // chain clears within 2 × (1 s + 30 s) + 5 s = 67 s, refused meanwhile only as resolving, and the next write commits
  await seam({ seam: { op: "delay", ms: 35_000, count: 2 }, ckpt_next: Date.now() });
  const c = await cgate("checkpointNow");
  const t0 = Date.now();
  let t, refusals = 0;
  for (;;) {
    t = await cgate("issue", "assignment", "bound-after");
    if (t.ok || !(t.status === 429 && t.code === "resolving") || Date.now() - t0 > 67_000) break;
    refusals++;
    await sleep(200);
  }
  const chainMs = Date.now() - t0;
  const w = t.ok ? await cgate("write", t.id, [{ sql: "SELECT 1" }]) : null;
  const st = await cgate("testState");
  if (t.ok) await cgate("giveBack", t.id);
  report.bound = { invocation: "vm-content-runs.mjs bound", checkpoint: c, requested_gaps: requestedGaps(c), accounting: timerAccounting(c), chain: { ms: chainMs, resolving_refusals: refusals, issue: t.ok || t, write: w && (w.ok || w), calls: st.calls.length } };
  report.finished = new Date().toISOString();
  const badB = verifyBound(report);
  ok(badB.length === 0, `the worst-case checkpoint at ×1, raw: ${badB.join("; ") || "clean"} (${JSON.stringify({ outcome: c.outcome, protected_ms: c.protected_ms, interval_ms: c.interval_ms, decision_to_end_ms: c.decision_to_end_ms, due_to_end_ms: c.due_to_end_ms, gaps: c.gaps, sends: c.sends_in_protected, requested_gaps: report.bound.requested_gaps, accounting: report.bound.accounting.phases, chain: report.bound.chain })})`);
}

if (mode === "recovery") {
  // The full-size recovery (the run-3 rulings: daybreak3 c2f77025, astra3 e7a4fe94). Fail closed throughout: the first
  // failed prerequisite stops the run, recorded with its phase and raw result; the report is always written and the exit
  // is non-zero. The restore is emulated by the cut itself: the checkpoint, then at once the pause (no probe runs while
  // paused, and the orphans go to R2 only, through /__test/r2-fill, never the gate), proved by raw read-only checks
  // after the pause and again before the marker that the chain is still exactly at the checkpoint. Nothing is repaired.
  // Test only: RECOVERY_TEST_INJECT=post_k lands a probe between the checkpoint and the pause (the regression's negative);
  // RECOVERY_TEST_PROBE_DUE=1 makes an hourly probe due while paused, during the orphan build (the cut must hold).
  const N = Number(arg ?? 2_010_000);
  const INJECT = process.env.RECOVERY_TEST_INJECT ?? "", PROBE_DUE = process.env.RECOVERY_TEST_PROBE_DUE === "1";
  const iso = () => new Date().toISOString();
  report.env = { node: process.version, bun: execFileSync("bun", ["--version"], { encoding: "utf8" }).trim(), miniflare: require("miniflare/package.json").version, argv: process.argv.slice(1), cwd: process.cwd(), inject: INJECT || null, probe_due: PROBE_DUE, seams: "checkpoints: manual; no scale, no skew" };
  report.phases = {};
  report.runbook = {};
  report.cut_checks = [];
  let current = "setup";
  const begin = (name) => {
    current = name;
    report.phases[name] = { started: iso() };
  };
  const finish = (name, extra = {}) => Object.assign(report.phases[name], { finished: iso() }, extra);
  class Stop extends Error {}
  // (the first failure stands: a later one never overwrites it)
  const stop = (what, detail) => {
    if (!report.failed) report.failed = { phase: current, what, detail, at: iso() };
    throw new Stop(what);
  };
  const count = async (prefix) => {
    let n = 0, cursor;
    do {
      const l = await r2.list({ limit: 1000, cursor, prefix });
      n += l.objects.length;
      cursor = l.truncated ? l.cursor : undefined;
    } while (cursor);
    return n;
  };
  // the raw read-only cut check: the checkpoint and its nonce in the gate and as D1's row k; the D1 head exactly k, no
  // row above it; next_seq k + 1; paused; nothing live, queued, active, unresolved, ticketed or intended; the planned
  // populations exactly; probe_at unchanged since the last check (no probe ran)
  let lastProbeAt = null;
  const cutCheck = async (label, ck, nonce, objectsWant) => {
    const st = await cgate("testState"), qt = await cgate("quiet"), cps = await cgate("checkpoints", 20);
    const head = (await q("SELECT max(seq) AS m FROM gate_calls")).m;
    const above = (await q("SELECT count(*) AS n FROM gate_calls WHERE seq > ?", ck.k)).n;
    const rowK = await q("SELECT seq, kind, nonce FROM gate_calls WHERE seq = ?", ck.k);
    const held = (await q("SELECT count(*) AS n FROM bundles WHERE state = 'held'")).n;
    const bundles = (await q("SELECT count(*) AS n FROM bundles")).n;
    const objects = await count();
    const probeAt = st.probe_meta?.at ?? null;
    const c = { label, at: iso(), k: ck.k, nonce, gate_checkpoint: cps.find((x) => x.k === ck.k) ?? null, d1_row_k: rowK, d1_head: head, d1_rows_above_k: above, next_seq: st.next_seq, mode: st.mode, quiet: qt, calls: st.calls.length, tickets: st.tickets.length, intents: st.intents, active: st.active, hold: st.hold, ckpt: st.ckpt, held, bundles, objects, objects_want: objectsWant, probe_at: probeAt, probe_at_before: lastProbeAt };
    const bad = [];
    if (!(c.gate_checkpoint && c.gate_checkpoint.nonce === nonce)) bad.push("the checkpoint k and its nonce are not in the gate's log");
    if (!(rowK && rowK.kind === "checkpoint" && rowK.nonce === nonce)) bad.push("D1's row k is not this checkpoint");
    if (head !== ck.k || above !== 0) bad.push(`the D1 chain head is ${head}, with ${above} rows above k = ${ck.k}`);
    if (st.next_seq !== ck.k + 1) bad.push(`next_seq ${st.next_seq}, not k + 1 = ${ck.k + 1}`);
    if (st.mode !== "paused" || qt.quiet !== true) bad.push(`mode ${st.mode}, quiet ${qt.quiet}`);
    if (c.calls || c.tickets || c.intents || c.active || c.hold || c.ckpt !== "none" || qt.queued || qt.live) bad.push("live, queued, active, unresolved, ticket or intent state");
    if (held !== N || bundles !== N) bad.push(`${held} held of ${bundles} bundle rows, not ${N}`);
    if (objects !== objectsWant) bad.push(`${objects} objects, not ${objectsWant}`);
    if (lastProbeAt !== null && probeAt !== lastProbeAt) bad.push(`probe_at moved: ${lastProbeAt} → ${probeAt}`);
    c.ok = bad.length === 0;
    c.failures = bad;
    report.cut_checks.push(c);
    log(`cut check (${label}): ${c.ok ? "ok" : bad.join("; ")} (head ${head}, k ${ck.k}, next_seq ${st.next_seq}, ${held} held, ${objects} objects)`);
    if (!c.ok) stop(`cut check ${label}`, c);
    lastProbeAt = probeAt;
  };
  try {
    const OWNERS = Math.ceil(N / 20_100);
    if (!(Number.isSafeInteger(N) && N >= 1 && OWNERS <= 100)) stop("size", { N, OWNERS });
    const owners = Array.from({ length: OWNERS }, (_, i) => `vmowner${String(i).padStart(3, "0")}`);
    const digest = {};
    for (const o of owners) digest[o] = (await j(await tool(`/__test/bundle-key?owner=${o}&sha=${"0".repeat(64)}&token=${"0".repeat(32)}`))).key.split("/")[1];
    // (objects written from inside the Worker, 1,000 a request, 8 requests at once; R2 only)
    const putAll = async (keys) => {
      const batches = [];
      for (let i = 0; i < keys.length; i += 1000) batches.push(keys.slice(i, i + 1000));
      for (let i = 0; i < batches.length; i += 8)
        await Promise.all(batches.slice(i, i + 8).map(async (b) => {
          const r = await tool("/__test/r2-fill", { method: "POST", body: JSON.stringify({ keys: b }) });
          if (r.status !== 200) stop("r2-fill", { status: r.status, body: await r.text().catch(() => "") });
        }));
    };
    // 1. the restored population: rows (held) and their objects
    begin("build_restored");
    let made = 0;
    for (const o of owners) {
      const n = Math.min(20_100, N - made);
      if (n <= 0) break;
      await fenced([{ sql: "INSERT OR IGNORE INTO owners (owner_ref, created) VALUES (?, ?)", params: [o, Date.now()] }]);
      const rows = Array.from({ length: n }, () => ({ sha: hex(32), token: hex(16) }));
      for (let i = 0; i < rows.length; i += 10_000) {
        const stmts = [];
        for (let k = i; k < Math.min(i + 10_000, rows.length); k += 500)
          stmts.push({ sql: `INSERT INTO bundles (owner_ref, sha, size, state, token, deadline, due) SELECT ?, json_extract(value, '$.sha'), 1, 'reserved', json_extract(value, '$.token'), ${D1NOW}, NULL FROM json_each(?)`, params: [o, JSON.stringify(rows.slice(k, k + 500))] });
        await fenced(stmts);
      }
      await fenced([{ sql: `UPDATE bundles SET state = 'held', held_at = ${D1NOW}, due = NULL WHERE owner_ref = ? AND state = 'reserved'`, params: [o] }]);
      await putAll(rows.map((r) => `o/${digest[o]}/${r.sha}/${r.token}`));
      made += n;
      if ((made / 20_100) % 10 === 0 || made === N) log(`restored population: ${made} rows and objects`);
    }
    finish("build_restored", { rows: made });
    // 2. the checkpoint the restore returns to, then at once the pause
    begin("checkpoint_pause");
    const ck = await cgate("checkpointNow");
    report.runbook.checkpoint = { outcome: ck.outcome, k: ck.k, attempt: ck.attempt, sent: ck.sent };
    if (ck.outcome !== "done" || !Number.isSafeInteger(ck.k)) stop("checkpoint", ck);
    const nonce = (await cgate("checkpoints", 20)).find((x) => x.k === ck.k)?.nonce ?? null;
    report.runbook.checkpoint.nonce = nonce;
    if (!nonce) stop("checkpoint nonce", { k: ck.k });
    if (INJECT === "post_k") report.runbook.injected_probe = await cgate("probe");
    const pz = await cgate("pause");
    report.runbook.pause = pz;
    if (pz?.mode !== "paused") stop("pause", pz);
    let qt = null;
    for (let i = 0; i < 300; i++) {
      qt = await cgate("quiet");
      if (qt.quiet) break;
      await sleep(200);
    }
    report.runbook.quiet = qt;
    if (qt?.quiet !== true) stop("quiet within 60 s", qt);
    finish("checkpoint_pause", { k: ck.k });
    begin("cut_post_pause");
    await cutCheck("post-pause", ck, nonce, N);
    finish("cut_post_pause");
    // 3. the post-restore orphans, R2 only, the gate paused throughout
    begin("build_orphans");
    if (PROBE_DUE) {
      // (an hourly probe due while paused, during the fill: the alarm fires, and nothing may be sent)
      await seam({ probe: { ok: true, R: 29, at: Date.now() - 2 * 3600_000 } });
      lastProbeAt = (await cgate("testState")).probe_meta?.at ?? null;
      await seam({ alarm: true });
      await sleep(1500);
      report.runbook.probe_due = { probe_at: lastProbeAt };
    }
    const last = `o/${"f".repeat(32)}/${"f".repeat(64)}/${"f".repeat(32)}`;
    const sample = [last];
    for (let i = 0; i < N - 1; i += 100_000) {
      const chunk = Array.from({ length: Math.min(100_000, N - 1 - i) }, () => `o/${hex(16)}/${hex(32)}/${hex(16)}`);
      sample.push(chunk[0], chunk[chunk.length - 1]);
      await putAll(chunk);
      log(`orphans: ${i + chunk.length}`);
    }
    await r2.put(last, "s");
    finish("build_orphans", { orphans: N, sample: sample.length });
    begin("cut_pre_marker");
    await cutCheck("pre-marker", ck, nonce, 2 * N);
    finish("cut_pre_marker");
    // 4. the runbook: marker, recover, every wake, resume (each raw result recorded)
    begin("marker_recover");
    const m = await cgate("marker", ck.k);
    report.runbook.marker = m;
    if (m?.ok !== true) stop("marker", m);
    const rc = await cgate("recover");
    report.runbook.recover = rc;
    if (rc?.ok !== true || !Number.isSafeInteger(rc.recovery_id)) stop("recover", rc);
    finish("marker_recover", { recovery_id: rc.recovery_id });
    begin("wakes");
    const wakes = [];
    let done = false;
    for (let i = 0; i < 200 && !done; i++) {
      const lease = await fenced([{ sql: "UPDATE sweep_lease SET until = 0 WHERE one = 1" }]);
      if (!lease.ok) stop("lease reset", lease);
      const s = await j(await tool("/__test/content-wake", { method: "POST", body: "{}" }));
      wakes.push({ outcome: s.outcome, d1_calls: s.d1_calls, statements: s.statements, rows_read: s.rows_read, rows_written: s.rows_written, r2_calls: s.r2_calls, keys_listed: s.keys_listed, keys_deleted: s.keys_deleted, scan_pages: s.scan_pages, first: s.first, final: s.final, within: within(s, RECOVERY), max_page_read: Math.max(0, ...(s.pages ?? []).map((p) => p.rows_read)) });
      if (wakes.length % 10 === 0) log(`recovery wakes: ${wakes.length}, listed ${wakes.reduce((a, w) => a + w.keys_listed, 0)}`);
      if (s.outcome !== "ok") {
        report.wakes_so_far = wakes;
        stop(`wake ${i} outcome ${s.outcome}`, s);
      }
      const rs = await cgate("recoveryState");
      done = rs.done === true;
    }
    finish("wakes", { wakes: wakes.length, done });
    report.recovery_s = Math.round((Date.parse(report.phases.wakes.finished) - Date.parse(report.phases.wakes.started)) / 1000);
    const seen = (await q("SELECT count(*) AS n FROM bundles WHERE seen_cycle = ?", rc.recovery_id)).n;
    const vc = (await q("SELECT v FROM meta WHERE k = 'valid_cycle'")).v;
    const sampleLeft = (await Promise.all(sample.map((k) => r2.head(k)))).filter(Boolean).length;
    report.recovery = { keys: 2 * N, wakes: wakes.length, seen, valid_cycle: vc, orphan_sample: sample.length, orphan_sample_left: sampleLeft, deleted: wakes.reduce((a, w) => a + w.keys_deleted, 0), max: Object.fromEntries(["d1_calls", "statements", "rows_read", "rows_written", "r2_calls", "keys_listed", "max_page_read"].map((k) => [k, Math.max(...wakes.map((w) => w[k]))])), per_wake: wakes };
    if (!done) stop("recovery not done within 200 wakes", { wakes: wakes.length });
    ok(wakes.length <= Math.ceil((103 * 2 * N) / 4_020_000) && vc === rc.recovery_id, `recovery at full size: ${wakes.length} wakes (≤ 103 at 4.02M keys) in ${report.recovery_s} s`);
    ok(seen === N && sampleLeft === 0 && report.recovery.deleted === N, `every restored row seen (${seen}/${N}); every orphan deleted (${report.recovery.deleted}/${N}; sampled ${sample.length} incl. the last prefix, ${sampleLeft} left)`);
    begin("resume_final");
    const rz = await cgate("resume");
    report.runbook.resume = rz;
    if (rz?.ok !== true) stop("resume", rz);
    // the final state, raw: mode, the chain's position, nothing pending; the populations' disposition
    const st = await cgate("testState");
    report.final_state = { mode: st.mode, next_seq: st.next_seq, d1_head: (await q("SELECT max(seq) AS m FROM gate_calls")).m, calls: st.calls.length, tickets: st.tickets.length, intents: st.intents, active: st.active, held: (await q("SELECT count(*) AS n FROM bundles WHERE state = 'held'")).n, seen, valid_cycle: vc, objects: await count() };
    const fs = report.final_state;
    if (fs.mode !== "normal" || fs.calls || fs.tickets || fs.intents || fs.active || fs.held !== N || fs.objects !== N) stop("final state", fs);
    finish("resume_final");
    report.finished = iso();
    const badR = verifyRecovery(report, 2 * N);
    ok(wakes.every((w) => w.within) && badR.length === 0, `every wake within the recovery table, and the verifier passes (${badR.join("; ") || "clean"}; max ${JSON.stringify(report.recovery.max)})`);
  } catch (e) {
    if (!(e instanceof Stop) && !report.failed) report.failed = { phase: current, what: "exception", error: String(e?.message ?? e), stack: e?.stack ?? null, at: iso() };
    if (report.phases[current] && !report.phases[current].finished) report.phases[current].failed = iso();
    failures.push(`recovery stopped in ${report.failed.phase}: ${report.failed.what}`);
    log("FAIL", `recovery stopped in ${report.failed.phase}: ${report.failed.what} ${JSON.stringify(report.failed.detail ?? report.failed.error ?? "").slice(0, 2000)}`);
  }
}

report.finished = new Date().toISOString();
report.failures = failures;
writeFileSync(join(runDir, `report-${mode}.json`), JSON.stringify(report, null, 2));
log(failures.length ? `${failures.length} FAILED` : "all passed", join(runDir, `report-${mode}.json`));
await mf.dispose();
process.exit(failures.length ? 1 : 0);
