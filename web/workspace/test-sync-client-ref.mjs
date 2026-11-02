// The sync client's cases (sync-client-cases.js: design/sync-client.md §3, C1, L2, L3, L4) in headless Chromium against
// core's reference server (web/sync-protocol/reference-server.ts), in this process: the sender lock, the account
// socket, hello/welcome/index/pull_index, ops and acks, lost acks, refusals (the rebuild asked for, never done here),
// pace and backoff, blobs check, PUT and GET, and docWire's claim.  The page is served by a small front here, which
// also proxies the site's sync API to the reference server (the account socket too) on the page's own origin, keeps
// the session cookie, and can drop, fake or hold what passes, as a network or a server would (/__ctl).  The cloud
// repository runs the same cases against its own server in Miniflare (its web/sync/test-workspace-sync-client.mjs),
// through a front with the same /__ctl.  This file reads only core: nothing under web/{site,files,share,sync,lti}.
// The 2 cases that need the cloud's plan limits (storageFull, tooLarge) are skipped by name, each saying so.
//   SYNC_REQUIRE_CLAIM=1 CHROME=google-chrome bun web/workspace/test-sync-client-ref.mjs
import { spawn } from "node:child_process";
import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync, mkdtempSync, rmSync, writeFileSync, copyFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { devtoolsPort } from "../test-port.mjs";
import { ReferenceServer } from "../sync-protocol/reference-server.ts";
import { checkFgen } from "../sync-protocol/doc-protocol.ts";
import { clientOf, toB64 } from "../sync-protocol/protocol.ts";

// (the reference server has the claim protocol, so a refused doc_claim must be a failed check, never the legacy path:
// this runner refuses to start without the flag rather than run the cases without it)
if (process.env.SYNC_REQUIRE_CLAIM !== "1") {
  console.error("FAIL: this runner needs SYNC_REQUIRE_CLAIM=1 (the reference server has the claim protocol)");
  process.exit(1);
}

const here = dirname(fileURLToPath(import.meta.url));
const J = JSON.stringify;
// (each case signs in its own account, so none sees another's log)
const ACCOUNTS = Array.from({ length: 89 }, (_, i) => `c1c1c1c1-${String(i).padStart(4, "0")}-4c1c-8c1c-c1c1c1c1c1${String(i).padStart(2, "0")}`);
// (the cloud's fake CoCalc gives FULL a small storage and SMALL small files; the reference server has no plan limits,
// so the two cases that use them are skipped here, by name)
const FULL = ACCOUNTS[87], SMALL = ACCOUNTS[88];
// (the control pages' accounts: their own, so no case of the main run sees a control's log)
// (each control page takes its own 3 of them, by its place in CONTROL_PAGES)
const CTL_ACCOUNTS = Array.from({ length: 30 }, (_, i) => `d0d0d0d0-${String(i).padStart(4, "0")}-4d0d-8d0d-d0d0d0d0d0${String(i).padStart(2, "0")}`);
const CLOUD_ONLY = ["storageFull", "tooLarge"];
// (the cases that download a blob through the redirect to /__files/: a full run must show such downloads)
const DOWNLOADS = ["downloadBasic", "downloadChecks", "downloadStale", "downloadBudget", "downloadStale2"];
const ONLY = process.env.ONLY ?? "";
const selected = (name) => !ONLY || ONLY.split(",").includes(name);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** what the run is waiting on, for any failure's message */
let waitingOn = "(nothing yet)";
/** `p`, or a rejection naming `what` once `ms` pass without an answer. */
const bounded = (p, what, ms) => { let t; return Promise.race([p, new Promise((_, no) => { t = setTimeout(() => no(new Error(`no answer within ${ms} ms: ${what}`)), ms); })]).finally(() => clearTimeout(t)); };
const CALL_MS = 30_000;

// ---- 3b's diagnostic budgets (plan csp3b-accountswitch-diag r2-r8): the page's own bounds (window.__budgets, which
// switch the cases into their diagnostic mode), the control pages' small ones, and the whole test's bound computed from
// this table: RUN_LIMIT_S may raise it, never lower it (the runner refuses to start)
/** the main page: a step 15 s, a case's cleanup 15 s; case bounds report-only in the pilot (enforceCase false) */
const MAIN_BUDGETS = { STEP_MS: 15_000, CLEANUP_MS: 15_000, CASE_MS: {}, CASE_FLOOR_MS: 30_000, enforceCase: false };
/** the control pages: they test mechanics, not magnitudes */
const CONTROL_BUDGETS = { STEP_MS: 2_000, CLEANUP_MS: 5_000, CASE_MS: { kM1: 30_000, kO1: 15_000 }, CASE_FLOOR_MS: 5_000, enforceCase: true };
/** a page's transition (navigation and readiness), its barrier's late observation (the confirmation's share inside it),
 * the main run in the pilot, and reporting */
const T_PAGE_S = 30, LATE_OBS_MS = 15_000, CONFIRM_MS = 3_000, PILOT_MAIN_S = 3600, REPORT_S = 60;
/** each page's run, after it ends: its answer read, once */
const FETCH_S = 5;
/** the control pages, in order, each control with its case allowance (s); every page is a fresh navigation */
const CONTROL_PAGES = [
  { page: "P1", cases: [["kR1", 5], ["kR2", 5], ["kL1", 5], ["kB", 5], ["kD", 5], ["kF", 5], ["kH", 5], ["kI", 5], ["kU1", 5], ["kW1", 5], ["kO1", 15]] },
  { page: "P2", cases: [["kA", 5]] },
  { page: "P3", cases: [["kC", 5], ["kG", 5]] },
  { page: "P4", cases: [["kE", 5]] },
  { page: "P5", cases: [["kJ", 5]] },
  { page: "P6", cases: [["kL2", 5]] },
  { page: "P7", cases: [["kM1", 30]] },
  { page: "P8", cases: [["kM2", 5]] },
  { page: "RES1", cases: [["kRES1", 5]] },
  { page: "P9", cases: [["kS1", 5]] },
];
/** the runner's own resource controls, each row enforced as a bound */
/** each row is enforced: its work under a real deadline, then a drain of what it acquired within ROW_DRAIN_S */
const SELF_TEST_ROWS = [["the control account's setup, then K-U2 to K-U5", 5], ["K-MSG1", 5], ["the row owner's negative", 4], ["the row owner's late-scope negative", 3], ["the rows' late sweep", 1]];
const ROW_DRAIN_S = 1;
const pageAllowanceS = (p) => T_PAGE_S + p.cases.reduce((s, [, c]) => s + c + CONTROL_BUDGETS.CLEANUP_MS / 1000, 0) + LATE_OBS_MS / 1000;
const CONTROLS_S = CONTROL_PAGES.reduce((s, p) => s + pageAllowanceS(p), 0) + SELF_TEST_ROWS.reduce((s, [, r]) => s + r, 0);
/** setup's existing bounds: the bundle, the DevTools port, the page list (300 tries of 5 s and 100 ms), the DevTools
 * socket, Runtime.enable */
const SETUP_S = 120 + 60 + 300 * 5.1 + 10 + CALL_MS / 1000;
/** the final cleanup's stages (7, each STAGE_MS 15 s), and the backstop past them: from the work deadline
 * (LIMIT_S - BACKSTOP_S) the cleanup has TEARDOWN_S, and the process exits at LIMIT_S at the latest */
const TEARDOWN_S = 7 * 15;
const BACKSTOP_S = TEARDOWN_S + 15;
/** r8 (daybreak2's DB2-R7-T1): the disposal's fixtures D1-D8 in the self-test: D3-D5 each spend their 300 ms slot on
 * the real clock (0.9 s); D1, D2, D6, D7 return at once; D8 runs on a controlled clock (no waits). With scheduling
 * overhead: an explicit 2 s */
const DISPOSAL_FIXTURES_S = 2;
/** the whole test, start to exit: every margin is inside it */
const REQUIRED_S = Math.ceil(SETUP_S + CONTROLS_S + DISPOSAL_FIXTURES_S + (CONTROL_PAGES.length + 1) * FETCH_S + T_PAGE_S + PILOT_MAIN_S + LATE_OBS_MS / 1000 + REPORT_S + BACKSTOP_S);
if (process.env.RUN_LIMIT_S !== undefined && !(Number(process.env.RUN_LIMIT_S) >= REQUIRED_S)) {
  console.error(`FAIL: RUN_LIMIT_S=${process.env.RUN_LIMIT_S} is under the whole test's bound, ${REQUIRED_S} s (controls ${CONTROLS_S} s, the pilot's main run ${PILOT_MAIN_S} s)`);
  process.exit(1);
}
const LIMIT_S = process.env.RUN_LIMIT_S !== undefined ? Number(process.env.RUN_LIMIT_S) : REQUIRED_S;
/** r6 §4: the one stop-path run's switch, read once here; any other value is refused */
const CONTROL_STOP = process.env.CONTROL_STOP ?? null;
if (CONTROL_STOP !== null && CONTROL_STOP !== "upstreamCloseFailure") {
  console.error(`FAIL: CONTROL_STOP=${CONTROL_STOP} is not a control this runner has (upstreamCloseFailure)`);
  process.exit(1);
}

// ---- the front: the page, and the site's sync API proxied to the reference server, with what the cases ask of it (ctl)

const ref = new ReferenceServer();
/** the front's own origin (the page's): every request to the reference server is made on it, so the URLs it answers
 * with (the blob GET's 303 to /__files/<sha>) are the page's own */
let origin = "";
let jar = "";
// (the account the session is now: its hash, for the binding checks)
let session = null;
/** the signed-in account's id (the session's), which the front's GET /api/share/me answers */
let sessionAccount = null;
const hashOf = (id) => createHash("sha256").update("sagebrush-account\n" + id).digest("hex");
const ctl = {
  /** answers faked for the next `ops` messages, instead of the server's: [{code, detail}] */
  fakeOps: [],
  /** acks with ops dropped (the next n), then the socket closed if closeAfterDrop */
  dropAcks: 0, closeAfterDrop: false,
  /** connections closed as soon as they open (the next n) */
  closeOnOpen: 0,
  /** the next welcome changed: {generation?, next_dseq?} */
  rewriteWelcome: null,
  /** PUTs held until released */
  holdPut: false,
  /** GETs of the user-content files (/__files) held until released */
  holdGet: false,
  /** answers for the next `rebuilt` messages, instead of the server's (the reference server has no `rebuilt`: the server
   * half is the cloud's): [{ack: {floor, count}} | {code, detail} | {hold: true}] (default: an ack with floor = through) */
  rebuilt: [],
  /** `rebuilt` sent on to the real server (the reference server: it answers "unknown message"), not answered here */
  rebuiltReal: false,
  /** the next n unasked-for index pages (a hello's) dropped */
  dropIndex: 0,
  /** the next n pulled index pages (answers to pull_index) dropped */
  dropPulled: 0,
  /** the next n pulled index pages answered {ops: [], more: true} instead (a page that moves nothing) */
  emptyMore: 0,
  /** HTTP answers faked: [{method, path (a part of it), status, body, times}] */
  fakeHttp: [],
  /** answers faked for the next pull_index requests: [{code, detail}] */
  fakePull: [],
  /** the session switched to this account just before the next socket upgrade, or the next PUT, is forwarded (as
   * another tab signing in would) */
  switchOnUpgrade: null, switchOnPut: null,
  /** the next PUT answered with this, after `ms`: {ms, status, body} (a late answer) */
  delayFakePut: null,
  /** the server's own index_changed passed on to the page.  The reference server sends them, to an account's other
   * sockets after ops that move its head, as the cloud's account object does (plan-sync-index-changed r1).  Off by
   * default, so each case decides when the page hears of a change (it injects notices with `notice`): the server's are
   * dropped and counted (log.serverNotices) */
  serverNotices: false,
  // (3b's control-only faults, used only by the control pages (sync-client-cases.js, CONTROL_CASES); reset doesn't
  // clear them, the between-page barrier's newPage() does, after a passing barrier)
  /** closeAll rejects (K-E) */
  closeAllReject: false,
  /** the proof route's quiet answers {error: "unknown"}, as a front without the registry would (K-M2; set in process) */
  quietUnknown: false,
  /** the next drained(n) starts an op tagged n that completes 1 s later (K-L2) */
  armLate: false,
  /** the next probe fails right after its socket is acquired (K-U1; one-shot, consumed by probe) */
  probeFailAfterConnect: false,
  /** socket upgrades refused before anything is acquired (K-RES1: the stopped page's client can't reopen one) */
  refuseUpgrades: false,
};
/** every open proxied socket's closer */
const closers = new Set();
/** every open proxied socket's sender to the page (a notice injected as the server would send it, D8) */
const toPage = new Set();
const log = { sent: [], got: [], http: [], sockets: 0, open: 0, putsNow: 0, maxPuts: 0, ops: [], bindings: [], rebuilt: [], serverNotices: 0, fgenRefused: 0, batchesUp: 0 };
const held = [];
/** the server's own index_changed dropped by the front over the whole run (log.serverNotices is per case: reset) */
let serverNoticesDropped = 0;
/** over the whole run: /__files/ GETs answered 200 (the downloads through the redirect), and answers that would have sent
 * the page to another origin (a Location, or a 3xx, not on the front's own) */
const front = { files200: 0, leaks: [], requests: 0, filesXSync: [], filesPreflights: 0 };
const resetLog = () => Object.assign(log, { sent: [], got: [], http: [], sockets: 0, putsNow: 0, maxPuts: 0, ops: [], bindings: [], rebuilt: [], serverNotices: 0, fgenRefused: 0, batchesUp: 0 });

// ---- 3b's front registry (plan r3 §2, r4 §1, r5 §1): every front await in flight, by label and epoch tag, so the page
// can prove the front quiet before the next case, and late completions (after their epoch was drained or abandoned) are
// seen.  Separate from `log`: reset and resetLog never clear it.  The proof commands have their own route (proof(),
// below), answered synchronously and never registered, so a quiet never sees itself.

/** the id of the front operation the current code runs in (undefined: none) */
const opNow = new AsyncLocalStorage();
const reg = {
  /** id -> {id, label, tag, startMs} */
  inflight: new Map(),
  /** completions in a drained or abandoned tag: {label, tag, endMs} */
  late: [],
  seq: 0,
  /** the tag new operations get: "pre" before the page's first epoch, then "<n>", then "c<n>" after drained(n) */
  tag: "pre",
  /** tag -> "drained" | "abandoned" */
  done: new Map(),
  /** request or answer bodies read outside any front operation (readBody) */
  untrackedReads: 0,
  /** proof commands answered on this page (K-M1: none in legacy) */
  proofs: 0,
};
const lateTag = (tag) => reg.done.has(tag);
/** One front operation ended: out of the registry, and late if its tag was drained or abandoned by then */
const opEnded = (id) => {
  const e = reg.inflight.get(id);
  if (!e) return;
  reg.inflight.delete(id);
  if (lateTag(e.tag)) reg.late.push({ label: e.label, tag: e.tag, endMs: Math.round(performance.now()) });
};
/** `thunk()` as one registered front operation, tagged with the epoch current when it starts */
async function frontOp(label, thunk) {
  const id = ++reg.seq;
  reg.inflight.set(id, { id, label, tag: reg.tag, startMs: performance.now() });
  try {
    return await opNow.run(id, thunk);
  } finally {
    opEnded(id);
  }
}
/** the current operation's label, once it's known (a /__ctl request's command is known only after its body is read) */
const relabel = (label) => { const e = reg.inflight.get(opNow.getStore()); if (e) e.label = label; };
/** Every request or answer body the front reads: what `r.text()` or `r.arrayBuffer()` returns, unchanged; a read outside
 * any front operation is counted (an untracked read, which the between-page barrier refuses) */
const readBody = (r, kind) => {
  if (opNow.getStore() === undefined) reg.untrackedReads++;
  return kind === "text" ? r.text() : r.arrayBuffer();
};

// ---- 3b's upstream sockets (plan r6 §1, r7 §2-§4): every RefSocket the front acquires is in `ups` from the moment
// ref.connect returns it until its one close; probe's and a failed upgrade's in a finally, a page socket's handed to its
// pair in place (owner "pair"), never out of the registry.  Each close's socket is kept for the barrier's confirmation
// (closed, and no message still running on it).  The harness's resource controls pass their own (scoped) registry,
// ledger and list; nothing a request carries can.

/** id -> {id, up, owner: "probe" | "preupgrade" | "pair"} */
const ups = new Map();
/** this page's closed upstream sockets, confirmed by the barrier, emptied by newPage() */
const closedUps = [];
/** the releases of the reference server's batch holds the run armed (armRefHold), released by the barrier */
const refHolds = new Set();
let upSeq = 0;
/** One upstream socket closed, once: out of its registry, onto the confirmation list, and a close that throws kept in the
 * ledger, naming its owner.  Never throws.  (A RefSocket already closing returns at once, ref :103-104: not a failure.) */
function closeUp(entry, code, reason, own = {}) {
  const registry = own.reg ?? ups, ledger = own.ledger ?? closeFailures, closed = own.closed ?? closedUps;
  if (!registry.has(entry.id)) return;
  registry.delete(entry.id);
  closed.push(entry.up);
  try { entry.up.close(code, reason); } catch (e) { ledger.push(`the upstream ${entry.owner} socket (${why(e)})`); }
}
/** A batch hold on the reference server (ref.controls.holdForward), its release kept for the barrier: the only caller */
const armRefHold = (doc, client, holds = refHolds) => {
  // (an ended self-test row's holds take nothing more: refused before anything is armed)
  if (holds.ended) throw new Error("the self-test row had ended");
  const release = ref.controls.holdForward(doc, client);
  holds.add(release);
  return release;
};
const releaseRefHolds = (holds) => { for (const r of [...holds]) { holds.delete(r); try { r(); } catch {} } };

const upstream = (method, path, headers, body) => frontOp(`upstream ${method} ${path}`, async () => {
  const h = new Headers({ origin, ...headers });
  if (jar) h.set("cookie", jar);
  const r = await ref.fetch(new Request(origin + path, { method, headers: h, body, redirect: "manual" }));
  const c = r.headers.getSetCookie?.().map((x) => x.split(";")[0]).find((x) => x.startsWith("__Host-sb_session="));
  if (c) {
    jar = c;
    if (path === "/auth/dev") try { const a = JSON.parse(String(body)).account_id; session = hashOf(a); sessionAccount = a; } catch {}
  }
  return r;
});

const signInAs = (account_id) => frontOp("signInAs", () => upstream("POST", "/auth/dev", { "content-type": "application/json" }, JSON.stringify({ token: "dev-token", account_id })));

/** The account socket, for the front's two users (the page's proxied socket and probe): the reference server's
 * RefSocket (its messages and its close as callbacks, onmessage(text) and onclose(code, reason)), or its refusal.
 * Registered in `ups` (or `own.reg`) under `owner` the moment it's acquired. */
const connectUp = (owner, own = {}) => frontOp("ref.connect", async () => {
  // (an ended self-test row's scope acquires nothing: refused before the connect; own.connectDelayMs is row 3's
  // harness-only delay, so its connect can straddle the row's end)
  if (own.ended) throw new Error("the self-test row had ended");
  // (a scoped acquisition in flight is counted on its scope until it ends, either way: the rows' late proof requires 0)
  const scoped = own.reg !== undefined;
  if (scoped) own.acquiring = (own.acquiring ?? 0) + 1;
  let s;
  try {
    if (own.connectDelayMs) await sleep(own.connectDelayMs);
    s = await ref.connect(own.cookie ?? (jar || null));
  } finally {
    if (scoped) own.acquiring--;
  }
  if (typeof s.send !== "function") return { refused: s };
  const entry = { id: ++upSeq, up: s, owner };
  (own.reg ?? ups).set(entry.id, entry);
  // (a self-test row's scope that has ended (its row past its deadline) takes nothing more: closed, and refused)
  if (own.ended) { closeUp(entry, 1000, "row ended", own); throw new Error("the self-test row had ended"); }
  // (what the server sends before its user takes over (the page's socket opens a moment later) is kept, not dropped:
  // the user's onmessage replaces this, and then takes what was kept, in order)
  const buf = [];
  let early = null;
  s.onmessage = (text) => buf.push(text);
  s.onclose = (code, reason) => { early = [code, reason]; };
  return { up: s, entry, buf, early: () => early };
});

// a second device, from here: its own socket on the same account.  `own`: the harness's resource controls only (their
// scoped registry, ledger, list and session); control() passes the request's body alone.
const probe = (body, own = {}) => frontOp("probe", async () => {
  const { ops = [], device = "0f0f0f0f0f0f0f0f" } = body ?? {};
  const c = await connectUp("probe", own);
  if (c.refused) return { status: c.refused.status };
  try {
    if (ctl.probeFailAfterConnect) { ctl.probeFailAfterConnect = false; throw new Error("injected: probe failed after connect"); }
    const ws = c.up;
    const got = [];
    let wake = null;
    ws.onmessage = (text) => { got.push(JSON.parse(text)); wake?.(); };
    for (const text of c.buf.splice(0)) ws.onmessage(text);
    const next = async (f, ms = 5000) => {
      const t = Date.now();
      for (;;) {
        const i = got.findIndex(f);
        if (i >= 0) return got.splice(i, 1)[0];
        if (Date.now() - t > ms) return null;
        await new Promise((ok) => { wake = ok; setTimeout(ok, 50); });
      }
    };
    ws.send(JSON.stringify({ t: "hello", v: 2, device, name: "probe", index_after: 0 }));
    const welcome = await next((m) => m.t === "welcome");
    const index = [];
    let page = await next((m) => m.t === "index");
    for (let req = 1; page; req++) {
      index.push(...page.ops);
      if (!page.more) break;
      ws.send(JSON.stringify({ t: "pull_index", req, after: index.at(-1).seq }));
      page = await next((m) => m.t === "index" && m.req === req);
    }
    let ack = null;
    if (ops.length) {
      ws.send(JSON.stringify({ t: "ops", req: 1000, ops }));
      ack = await next((m) => m.req === 1000);
    }
    ws.close(1000, "done");
    return { welcome, index, ack };
  } finally {
    // (after the normal path's own close, this one finds the socket closing: a no-op, nothing kept; on any other path it
    // is the close)
    closeUp(c.entry, 1000, "done", own);
  }
});

/** The registry as the page's proof reads it */
const quietNow = () => {
  const inflight = [...reg.inflight.values()].map((e) => ({ label: e.label, tag: e.tag, ageMs: Math.round(performance.now() - e.startMs) }));
  return {
    inflight, pendingLate: inflight.filter((e) => lateTag(e.tag)), closers: closers.size, held: held.length, late: reg.late, epoch: reg.tag,
    closeFailures: closeFailures.length, untrackedReads: reg.untrackedReads, ups: ups.size, refHolds: refHolds.size,
    unconfirmed: closedUps.filter((u) => !(u.closed === true && u.inflight === 0)).length,
    armed: { probeFailAfterConnect: !!ctl.probeFailAfterConnect }, open: log.open, putsNow: log.putsNow,
  };
};
/** the proof commands: a closed set, on their own route, GET /__proof/<cmd>?n=<int>[&phase=cleanup] */
const PROOF_COMMANDS = ["quiet", "epoch", "drained", "abandon"];
/** K-L2's armed op: tagged `tag` (it starts before the mark), registered as any operation, ended 1 s later */
const armedLate = (tag) => { const id = ++reg.seq; reg.inflight.set(id, { id, label: "armed late", tag, startMs: performance.now() }); setTimeout(() => opEnded(id), 1000); };
/** A proof command, answered synchronously: nothing on this path awaits, reads a body, or registers */
function proof(req, u) {
  const cmd = u.pathname.slice("/__proof/".length);
  if (!PROOF_COMMANDS.includes(cmd)) return new Response(null, { status: 404 });
  if (req.method !== "GET") return new Response(null, { status: 405 });
  const ns = u.searchParams.get("n"), phase = u.searchParams.get("phase");
  const n = Number(ns);
  if (cmd !== "quiet" && !(ns !== null && /^(0|[1-9][0-9]{0,8})$/.test(ns))) return Response.json({ error: "invalid", detail: "n" }, { status: 400 });
  if (phase !== null && !(cmd === "drained" && phase === "cleanup")) return Response.json({ error: "invalid", detail: "phase" }, { status: 400 });
  reg.proofs++;
  if (cmd === "quiet") return Response.json(ctl.quietUnknown ? { error: "unknown" } : quietNow());
  if (cmd === "epoch") { reg.tag = String(n); return Response.json({ epoch: reg.tag }); }
  if (cmd === "drained") {
    if (phase === "cleanup") { reg.done.set(`c${n}`, "drained"); return Response.json({ drained: `c${n}`, epoch: reg.tag }); }
    if (ctl.armLate) { ctl.armLate = false; armedLate(String(n)); }
    // (drained(n): n drained, and from now on every new operation is cleanup's, tagged c<n>, never late for n)
    reg.done.set(String(n), "drained");
    reg.tag = `c${n}`;
    return Response.json({ drained: String(n), epoch: reg.tag });
  }
  // abandon(n): n, and c<n> unless already drained, abandoned
  reg.done.set(String(n), "abandoned");
  if (reg.done.get(`c${n}`) !== "drained") reg.done.set(`c${n}`, "abandoned");
  return Response.json({ abandoned: String(n), epoch: reg.tag });
}

async function control(body) {
  switch (body.cmd) {
    case "set": Object.assign(ctl, body.set); return { ok: true };
    case "log": { const out = JSON.parse(JSON.stringify(log)); if (body.reset) resetLog(); return out; }
    case "closeAll": { if (ctl.closeAllReject) throw new Error("injected: closeAll rejected"); const n = closers.size; for (const f of [...closers]) f(1000); return { closed: n }; }
    case "release": { const n = held.length; for (const f of held.splice(0)) f(); return { released: n }; }
    case "probe": return probe(body);
    // (index_changed notices, as the account object sends them (plan-sync-index-changed r1), `times` of them to every
    // open socket: the client's side is tested by injecting them here; the server's own are dropped unless
    // ctl.serverNotices)
    // (a frame of the server's own, pushed to every page socket as the server would push it (no req): 2c-3's docWire)
    case "frame": { let sent = 0; for (const f of toPage) { f(JSON.stringify(body.frame)); sent++; } return { sent }; }
    case "notice": { let sent = 0; for (let i = 0; i < (body.times ?? 1); i++) for (const f of toPage) { f(JSON.stringify({ t: "index_changed", head: body.head })); sent++; } return { sent }; }
    case "reset": Object.assign(ctl, { fakeOps: [], dropAcks: 0, closeAfterDrop: false, closeOnOpen: 0, rewriteWelcome: null, holdPut: false, holdGet: false, rebuilt: [], rebuiltReal: false, dropIndex: 0, dropPulled: 0, emptyMore: 0, fakeHttp: [], fakePull: [], switchOnUpgrade: null, switchOnPut: null, delayFakePut: null, serverNotices: false }); for (const f of held.splice(0)) f(); resetLog(); return { ok: true };
    // (3b's control-only commands: a held wait released only by release/reset or the barrier (K-B, K-R1); a timer
    // (K-I, K-J); K-L2's armed late op; K-R2's reset of exactly its one untracked read)
    case "hang": await new Promise((ok) => held.push(ok)); return { ok: true };
    case "slow": await sleep(Number(body.ms) || 0); return { ok: true };
    case "armLate": ctl.armLate = true; return { ok: true };
    case "untrackedReset": {
      if (!Number.isInteger(body.to) || reg.untrackedReads !== body.to + 1) return { error: "not exactly one untracked read since", to: body.to, now: reg.untrackedReads };
      reg.untrackedReads = body.to;
      return { ok: true };
    }
    default: return { error: "unknown" };
  }
}

/** The headers of an answer passed to the page, without those the front sets itself; a Location (or a 3xx) that isn't
 * on the front's own origin, or the files origin's /__files/, is counted as a leak of another origin, and the run fails
 * on any.  The blob GET's 303 to /__files/ is sent to the files origin, as PROD's goes to files.cocalcusercontent.com */
function pageHeaders(r, path) {
  const h = {};
  r.headers.forEach((v, k) => { if (k !== "set-cookie" && k !== "content-length" && k !== "content-encoding") h[k] = v; });
  let loc = r.headers.get("location");
  if (loc !== null && filesOrigin) {
    const l = new URL(loc, origin);
    if (l.origin === origin && l.pathname.startsWith("/__files/")) loc = h.location = filesOrigin + l.pathname + l.search;
  }
  const at = loc !== null ? new URL(loc, origin) : null;
  const ours = at !== null && (at.origin === origin || (at.origin === filesOrigin && at.pathname.startsWith("/__files/")));
  if ((loc !== null || (r.status >= 300 && r.status < 400)) && !ours) front.leaks.push(`${r.status} ${path} -> ${loc}`);
  return h;
}

// The user-content files on an origin of their own, as on PROD: the blob GET's 303 goes there (pageHeaders), and its
// CORS is the files Worker's exactly (cloud web/sync/server.ts handleSyncFiles): the page's origin allowed, a preflight
// allowing only `range`.  So a download whose request carries any other header fails in the browser, as every one of
// William's did (Nov 1 2026: the client sent its x-sync-* binding headers on the GET, the 303 carried them across, and
// the preflight refused them; B5).  Any x-sync-* header seen here fails the run.
let filesServer = null, filesOrigin = "";
const filesCors = () => ({ "access-control-allow-origin": origin, vary: "origin", "access-control-expose-headers": "content-length, content-range" });
async function filesServe(req) {
  const u = new URL(req.url);
  const sent = [...req.headers.keys()].filter((k) => k.startsWith("x-sync-"));
  const asked = (req.headers.get("access-control-request-headers") ?? "").toLowerCase();
  if (sent.length || asked.includes("x-sync-")) front.filesXSync.push(`${req.method} ${u.pathname.slice(0, 20)}: ${sent.join(",") || asked}`);
  if (!u.pathname.startsWith("/__files/")) return new Response("not found", { status: 404, headers: filesCors() });
  if (req.method === "OPTIONS") {
    front.filesPreflights++;
    return new Response(null, { status: 204, headers: { ...filesCors(), "access-control-allow-methods": "GET, HEAD", "access-control-allow-headers": "range", "access-control-max-age": "600" } });
  }
  const r = await serve(new Request(origin + u.pathname + u.search, { method: req.method }));
  const h = new Headers(r.headers);
  for (const [k, v] of Object.entries(filesCors())) h.set(k, v);
  return new Response(r.body, { status: r.status, headers: h });
}

/** A status that carries no body (the Fetch rule: a body there is a TypeError), as /auth/dev's 204 */
const NULL_BODY = [101, 103, 204, 205, 304];
/** An answer to the page: `body`, unless the status, or a HEAD, carries none */
const respond = (status, body, headers, method) => new Response(NULL_BODY.includes(status) || method === "HEAD" ? null : body, { status, headers });
/** The reference server's answer passed on: its body read only when it may have one */
const passOn = async (r, path, method) => respond(r.status, NULL_BODY.includes(r.status) || method === "HEAD" ? null : await readBody(r, "arrayBuffer"), pageHeaders(r, path), method);

let site = "";
/** Every request: a proof command (its own route, classified from the URL alone, before anything is read or awaited)
 * or K-R2's untracked-read probe, else one registered front operation from its first statement, its body reads
 * included */
function serve(req, server) {
  // (r6: every request the front receives, counted first, whatever it is: K-M1 proves from this count that its page
  // made none while its run ran)
  front.requests++;
  const u = new URL(req.url);
  const p = u.pathname;
  if (p.startsWith("/__proof/")) return proof(req, u);
  // (control-only, K-R2: a body read outside any operation, counted; never awaited here)
  if (p === "/__untracked") { readBody(req, "text").catch(() => {}); return Response.json({ untrackedReads: reg.untrackedReads }); }
  return frontOp(`http ${req.method} ${p}`, () => serveOp(req, server, u, p));
}
async function serveOp(req, server, u, p) {
  try {
    if (p === "/" || p === "/ws.js" || p === "/cases.js" || p === "/ctl.html") {
      return new Response(Bun.file(join(site, p === "/" ? "index.html" : p.slice(1))), { headers: { "content-type": p.endsWith(".js") ? "text/javascript" : "text/html" } });
    }
    if (p === "/__ctl") {
      const body = JSON.parse((await readBody(req, "text")) || "{}");
      relabel(`ctl ${body.cmd}`);
      return Response.json(await control(body));
    }
    // the account socket, proxied message by message (websocket, below), so the cases can drop, fake or close
    if (p === "/api/sync/v1/account" && (req.headers.get("upgrade") ?? "").toLowerCase() === "websocket") {
      if (ctl.refuseUpgrades) return new Response("refused (control)", { status: 503, headers: { connection: "close" } });
      log.sockets++;
      if (ctl.switchOnUpgrade) {
        await signInAs(ctl.switchOnUpgrade);
        ctl.switchOnUpgrade = null;
        log.switchedUpgrade = (log.switchedUpgrade ?? 0) + 1;
      }
      const c = await connectUp("preupgrade").catch(() => null);
      if (!c || c.refused) return new Response("refused", { status: c?.refused.status ?? 502, headers: { connection: "close" } });
      // (the socket stays in `ups` as "preupgrade" until its pair takes it (websocket.open); not handed, it's closed
      // here, whatever happened)
      let handed = false;
      try {
        // (the session's account when this socket was opened: the one it is authenticated as)
        handed = server.upgrade(req, { data: { up: c.up, entry: c.entry, buf: c.buf, early: c.early, socketSession: session, helloAccount: null } });
      } finally {
        if (!handed) closeUp(c.entry, 1000, "no upgrade");
      }
      if (handed) return undefined;
      return new Response("no upgrade", { status: 400 });
    }
    // (the user-content files: the reference server's blob GET answers 303 to /__files/<sha> on the origin it was asked
    // on, the front's; served by the reference server's own route, through this branch, so the cases can hold them.
    // The cloud's front also forwarded the query and a range here; the reference server ignores both, and no case sends
    // a range, so neither is forwarded)
    if (p.startsWith("/__files/")) {
      const entry = { method: req.method, path: p, files: true };
      log.http.push(entry);
      if (ctl.holdGet) await frontOp("held GET", () => new Promise((ok) => held.push(ok)));
      const h = new Headers();
      if (jar) h.set("cookie", jar);
      const r = await frontOp(`ref.fetch ${req.method} /__files`, () => ref.fetch(new Request(origin + p, { method: req.method, headers: h })));
      entry.status = r.status;
      if (r.status === 200) front.files200++;
      return passOn(r, p, req.method);
    }
    if (!p.startsWith("/api/") && !p.startsWith("/auth/")) return new Response(null, { status: 404 });
    const body = req.method === "GET" || req.method === "HEAD" ? undefined : Buffer.from(await readBody(req, "arrayBuffer"));
    const isPut = req.method === "PUT";
    const entry = { method: req.method, path: p, bytes: body?.length ?? 0, ...(p.endsWith("/blobs/check") ? { check: JSON.parse(body.toString()).blobs.length } : {}) };
    log.http.push(entry);
    const fake = ctl.fakeHttp.find((f) => f.method === req.method && (!f.path || p.includes(f.path)) && f.times > 0);
    if (fake) {
      fake.times--;
      entry.status = fake.status;
      entry.faked = true;
      return respond(fake.status, JSON.stringify(fake.body ?? {}), { "content-type": "application/json" }, req.method);
    }
    if (isPut && ctl.delayFakePut) {
      const f = ctl.delayFakePut;
      ctl.delayFakePut = null;
      entry.faked = true;
      await new Promise((r) => setTimeout(r, f.ms));
      entry.status = f.status;
      return respond(f.status, JSON.stringify(f.body ?? {}), { "content-type": "application/json" }, req.method);
    }
    if (isPut && ctl.switchOnPut) {
      await signInAs(ctl.switchOnPut);
      ctl.switchOnPut = null;
      entry.switched = true;
    }
    if (isPut || entry.check !== undefined) Object.assign(entry, { session, bind: req.headers.get("x-sync-account") ?? null });
    if (isPut) {
      log.putsNow++;
      log.maxPuts = Math.max(log.maxPuts, log.putsNow);
      if (ctl.holdPut) await frontOp("held PUT", () => new Promise((ok) => held.push(ok)));
    }
    // (the cloud's GET /api/share/me, which the client asks before every connection (sync-client.ts, connect): the
    // reference server serves only /api/sync/ and /auth/dev, so the front answers it for the session it holds, as the
    // cloud's site does; forwarded, it was a 404, and the client never connected)
    if (p === "/api/share/me" && req.method === "GET") {
      entry.status = sessionAccount ? 200 : 401;
      return sessionAccount ? Response.json({ account_id: sessionAccount }) : Response.json({ error: "sign in first" }, { status: 401 });
    }
    const headers = {};
    for (const k of ["content-type", "content-length", "x-sync-account", "x-sync-generation"]) { const v = req.headers.get(k); if (v !== null) headers[k] = v; }
    // (the reference server reads a PUT's length from its header: the page's, forwarded; else the body's own)
    if (isPut && headers["content-length"] === undefined) headers["content-length"] = String(body.length);
    let r;
    try {
      r = await upstream(req.method, p + u.search, headers, body);
    } finally {
      if (isPut) log.putsNow--;
    }
    entry.status = r.status;
    return passOn(r, p, req.method);
  } catch (e) {
    return new Response(String(e), { status: 500 });
  }
}

const okCode = (c) => (c === 1000 || (c >= 3000 && c <= 4999) ? c : 1000);
/** every proxied pair's close failure over the run, whoever called the closer (the cases' paths ignore what it returns;
 * the cleanup reports these, so a failure before the cleanup still fails the run) */
const closeFailures = [];
/** over the run: page sockets already closing or closed when their pair was closed, so not closed again (reported) */
const closeSkips = { n: 0 };
/** One proxied pair's closer: both sides closed, once (`first` runs then); says what failed, each side tried whatever
 * the other did (empty when both closed, or when it had already closed them), and keeps each failure in `ledger` */
const pairCloser = (up, client, first, ledger = closeFailures, skips = closeSkips) => {
  let closed = false;
  return (code = 1000) => {
    if (closed) return [];
    closed = true;
    first();
    const bad = [];
    try { up.close(1000, "proxy"); } catch (e) { bad.push(`the server's side (${why(e)})`); }
    // (a page socket already closing or closed (readyState 2 or 3), as when the page closed first, isn't closed again:
    // a benign double close is not a failure)
    if (client.readyState === 2 || client.readyState === 3) skips.n++;
    else try { client.close(okCode(code), "proxy"); } catch (e) { bad.push(`the page's side (${why(e)})`); }
    ledger.push(...bad);
    return bad;
  };
};
/** the page's server-side sockets not yet seen closed (websocket.close): the front's stop ends any left first */
const pageSockets = new Set();
const websocket = {
  open(client) {
    pageSockets.add(client);
    const d = client.data, up = d.up;
    // (the upstream socket handed to its pair in place: it never leaves `ups`; the pair's close takes it out, right
    // before pairCloser's own close of it, whose failure pairCloser keeps)
    d.entry.owner = "pair";
    log.open++;
    d.closeBoth = pairCloser(up, client, () => { closers.delete(d.closeBoth); log.open--; ups.delete(d.entry.id); closedUps.push(up); });
    closers.add(d.closeBoth);
    d.send = (text) => { try { client.send(text); } catch {} };
    toPage.add(d.send);
    if (ctl.closeOnOpen > 0) {
      ctl.closeOnOpen--;
      return d.closeBoth(1000);
    }
    up.onmessage = (text) => {
      let m;
      try { m = JSON.parse(text); } catch { m = {}; }
      log.got.push({ t: m.t, req: m.req, ops: m.t === "ack" ? m.ops : m.t === "index" ? m.ops?.length : undefined, code: m.code });
      if (m.t === "index_changed" && !ctl.serverNotices) {
        log.serverNotices++;
        serverNoticesDropped++;
        // (marked as filtered, never as `dropped`: the cases' `g.dropped` means a drop they asked for)
        log.got.at(-1).filtered = true;
        return;
      }
      if (m.t === "welcome" && ctl.rewriteWelcome) {
        Object.assign(m, ctl.rewriteWelcome);
        ctl.rewriteWelcome = null;
        d.send(JSON.stringify(m));
        return;
      }
      if (m.t === "index" && m.req !== undefined && ctl.emptyMore > 0) {
        ctl.emptyMore--;
        log.got.at(-1).faked = true;
        d.send(JSON.stringify({ t: "index", req: m.req, ops: [], more: true }));
        return;
      }
      if (m.t === "index" && m.req !== undefined && ctl.dropPulled > 0) {
        ctl.dropPulled--;
        log.got.at(-1).dropped = true;
        return;
      }
      if (m.t === "index" && m.req === undefined && ctl.dropIndex > 0) {
        ctl.dropIndex--;
        log.got.at(-1).dropped = true;
        return;
      }
      if (m.t === "ack" && m.ops && ctl.dropAcks > 0) {
        ctl.dropAcks--;
        log.got.at(-1).dropped = true;
        if (ctl.closeAfterDrop) d.closeBoth(1000);
        return;
      }
      d.send(text);
    };
    up.onclose = (code) => d.closeBoth(code);
    for (const text of d.buf.splice(0)) up.onmessage(text);
    // (a close the server made before this socket opened, kept, then passed on)
    const early = d.early();
    if (early) up.onclose(...early);
  },
  message(client, data) {
    const d = client.data, up = d.up;
    const text = typeof data === "string" ? data : Buffer.from(data).toString();
    let m;
    try { m = JSON.parse(text); } catch { m = {}; }
    log.sent.push(m.t === "ops" ? { t: "ops", req: m.req, dseqs: m.ops.map((o) => o.dseq), json: m.ops.map((o) => JSON.stringify(o)), at: Date.now() } : { t: m.t, req: m.req, index_after: m.index_after, after: m.after, at: Date.now() });
    if (m.t === "hello") d.helloAccount = m.account ?? null;
    // (every batch checked as the canonical reference server checks it (§5.8: one generation for each client in its
    // patches, and no other): a failing one is refused here, routed to its request, and never forwarded)
    if (m.t === "batch") {
      let why = null;
      try { checkFgen(m.fgen, new Set((Array.isArray(m.patches) ? m.patches : []).map((p) => clientOf(String(p?.id ?? ""))))); } catch (e) { why = String(e?.message ?? e); }
      if (why !== null) {
        log.fgenRefused++;
        d.send(JSON.stringify({ t: "error", req: m.req, code: "invalid", detail: { message: why } }));
        return;
      }
    }
    if (m.t === "ops") log.bindings.push({ session: d.socketSession, hello: d.helloAccount, dseqs: m.ops.map((o) => o.dseq) });
    if (m.t === "ops") log.ops.push(...m.ops.map((o) => JSON.stringify(o)));
    if (m.t === "rebuilt" && ctl.rebuiltReal) log.rebuilt.push({ through: m.through, answer: "server", at: Date.now() });
    if (m.t === "rebuilt" && !ctl.rebuiltReal) {
      const f = ctl.rebuilt.shift() ?? { ack: { floor: m.through, count: 0 } };
      log.rebuilt.push({ through: m.through, answer: f, at: Date.now() });
      const answer = () => d.send(JSON.stringify(f.ack ? { t: "ack", req: m.req, rebuilt: f.ack } : { t: "error", req: m.req, code: f.code, detail: f.detail ?? { message: "faked" } }));
      if (f.hold) held.push(() => { f.ack = f.ack ?? { floor: m.through, count: 0 }; answer(); });
      else answer();
      return;
    }
    if (m.t === "pull_index" && ctl.fakePull.length) {
      const f = ctl.fakePull.shift();
      d.send(JSON.stringify({ t: "error", req: m.req, code: f.code, detail: f.detail ?? { message: "faked" } }));
      return;
    }
    if (m.t === "ops" && ctl.fakeOps.length) {
      const f = ctl.fakeOps.shift();
      // (hold: answered only when the test releases it, after it has seen the client's sender idle)
      const answer = () => d.send(JSON.stringify({ t: "error", req: m.req, code: f.code, detail: f.detail ?? { message: "faked" } }));
      if (f.hold) held.push(answer);
      else answer();
      return;
    }
    // (the one place a page's frame goes upstream: batches counted here, so a case can tell a refused batch was never
    // forwarded)
    if (m.t === "batch") log.batchesUp++;
    try { up.send(text); } catch {}
  },
  close(client, code) {
    pageSockets.delete(client);
    toPage.delete(client.data.send);
    client.data.closeBoth?.(code);
  },
};

// ---- Chrome, driven over the DevTools protocol, as the other workspace tests are; every wait bounded and named, one
// cleanup however the run ends

const fails = [];
/** the runner's own controls (of its cleanup), beside the page's checks */
const controls = [];
const control1 = (ok, what) => { controls.push(what); if (!ok) fails.push(what); };
const sockets = [];
let server = null, chrome = null, profile = null;
/** how Chrome ended, once it has: {exit: [code, signal]}, or {error} for a spawn that failed (never an observed exit) */
let chromeEnded = Promise.resolve(null);
const why = (e) => String(e?.code ?? e?.message ?? e);
/** A process stopped and seen to end: TERM, up to 5 s for its end, then KILL and up to 5 s more; says which.  A kill
 * that throws is a stop only on ESRCH (it had gone); any other error is a failure, said.  An `error` end (a spawn that
 * failed) is never taken for an exit. */
const stopChrome = async (p = chrome, ended = () => chromeEnded) => {
  if (!p?.pid) return { ok: true, said: "never started" };
  if (p.exitCode !== null || p.signalCode !== null) return { ok: true, said: "had exited" };
  for (const [sig, name] of [["SIGTERM", "TERM"], ["SIGKILL", "KILL"]]) {
    try { p.kill(sig); } catch (e) { if (e?.code !== "ESRCH") return { ok: false, said: `${name} failed (${why(e)})` }; }
    const end = await Promise.race([ended(), sleep(5000).then(() => undefined)]);
    if (end?.exit) return { ok: true, said: `exited on ${name}` };
    if (end?.error) return { ok: false, said: `ended with an error (${why(end.error)})` };
  }
  return { ok: false, said: "NOT seen to exit" };
};
/** The proxied pairs still open closed now; the stage fails on any close that failed, now or earlier in the run (the
 * ledger keeps those after their closer has left the registry) */
const proxiedStage = (registry, ledger) => {
  const all = [...registry];
  for (const f of all) try { f(1000); } catch (e) { ledger.push(why(e)); }
  return ledger.length ? { ok: false, said: `NOT all closed (${ledger.join(", ")})` } : { ok: true, said: `${all.length} closed` };
};
/** The upstream sockets still registered closed now; the stage fails if any was left, or a close failed */
const upstreamStage = () => {
  // (any batch hold still armed released first: the cleanup runs however the run ended)
  releaseRefHolds(refHolds);
  const left = [...ups.values()], n0 = closeFailures.length;
  for (const e of left) closeUp(e, 1000, "cleanup");
  const bad = closeFailures.slice(n0);
  return left.length || bad.length ? { ok: false, said: `NOT clean (${left.length} left open${bad.length ? ": " + bad.join(", ") : ""})` } : { ok: true, said: "none left open" };
};

// ---- 3b's between-page barrier (plan r4 §2, r5 §2, r6 §2, r7 §1): in this process, after every page, before any
// navigation: its own release and close, a bounded late observation, the upstream residue, the confirmation (each closed
// upstream socket closed AND idle), then a pure verdict; a failing verdict stops the whole test

/** the run's own barrier state; a resource control passes a scoped one of the same shape */
const runState = () => ({
  ups, ledger: closeFailures, closed: closedUps, refHolds, inflight: reg.inflight, held, closers,
  open: () => log.open, untracked: () => reg.untrackedReads, armed: () => !!ctl.probeFailAfterConnect, snap: pageSnap,
});
/** the page's start: the ledger's length and the untracked reads (newPage()) */
let pageSnap = { ledger: 0, untracked: 0 };
/** Step 1: every held waiter and armed batch hold released, every proxied pair closed (what each says kept) */
const releaseAndClose = (s) => {
  for (const f of s.held.splice(0)) try { f(); } catch {}
  releaseRefHolds(s.refHolds);
  for (const f of [...s.closers]) try { f(1000); } catch (e) { s.ledger.push(why(e)); }
};
/** Step 4: up to `ms` for every closed upstream socket to be closed with no message still running on it (ref
 * RefSocket.closed is a close timer, :107-110; inflight counts a message until its handler ends, :302-307) */
const confirmClosed = async (s, ms) => {
  const t = performance.now();
  const open = () => s.closed.filter((u) => !(u.closed === true && u.inflight === 0));
  while (open().length && performance.now() - t < ms) await sleep(20);
  return { unconfirmed: open().filter((u) => u.closed !== true).map(() => "upstream close unconfirmed"), busy: open().filter((u) => u.closed === true).map((u) => `upstream socket busy after close (inflight ${u.inflight})`) };
};
/** What the verdict reads, now */
const barrierInput = (s, extra = {}) => ({
  inflight: [...s.inflight.values()].map((e) => `${e.label}@${e.tag}`), closers: s.closers.size, held: s.held.length, open: s.open(),
  newCloseFailures: s.ledger.slice(s.snap.ledger), untrackedDelta: s.untracked() - s.snap.untracked, ups: s.ups.size, armed: s.armed(),
  residue: [], unconfirmed: [], busy: [], ...extra,
});
/** The barrier's verdict: a pure function of what it read; passes only on operation AND resource quiescence */
const barrierVerdict = (x) => {
  const items = [];
  if (x.inflight.length) items.push(`inflight ${x.inflight.length} (${x.inflight.join(", ")})`);
  if (x.closers) items.push(`closers ${x.closers}`);
  if (x.held) items.push(`held ${x.held}`);
  if (x.open) items.push(`log.open ${x.open}`);
  for (const f of x.newCloseFailures) items.push(`close failure: ${f}`);
  if (x.untrackedDelta) items.push(`untracked reads ${x.untrackedDelta > 0 ? "+" : ""}${x.untrackedDelta}`);
  items.push(...x.residue);
  if (x.ups) items.push(`upstream registry ${x.ups}`);
  items.push(...x.unconfirmed, ...x.busy);
  if (x.armed) items.push("probe injection left armed");
  return { ok: items.length === 0, items };
};
/** The whole barrier on `s`: release and close, the late observation (completions then are late: the page's epoch is
 * abandoned first, for the run's own state), the residue closed and named, the confirmation, the input for the verdict */
async function barrierSteps(s, { lateObsMs = LATE_OBS_MS, confirmMs = CONFIRM_MS, own = null } = {}) {
  const before = { inflight: s.inflight.size, closers: s.closers.size, held: s.held.length, ups: s.ups.size, open: s.open() };
  if (s.inflight === reg.inflight && !reg.done.has(reg.tag)) reg.done.set(reg.tag, "abandoned");
  releaseAndClose(s);
  const t = performance.now();
  while (s.inflight.size && performance.now() - t < lateObsMs - confirmMs) await sleep(50);
  const residue = [];
  for (const e of [...s.ups.values()]) { residue.push(`upstream ${e.owner} ${e.id} left open`); closeUp(e, 1000, "barrier", own ?? {}); }
  const c = await confirmClosed(s, confirmMs);
  return { before, ...barrierInput(s, { residue, ...c }) };
}
/** The next page may start: the epoch states and the page's lists cleared, the snapshots taken, the control-only
 * faults off (only after a passing barrier) */
const newPage = () => {
  reg.done.clear();
  reg.late = [];
  reg.tag = "pre";
  reg.proofs = 0;
  closedUps.length = 0;
  pageSnap = { ledger: closeFailures.length, untracked: reg.untrackedReads };
  Object.assign(ctl, { closeAllReject: false, quietUnknown: false, armLate: false, refuseUpgrades: false });
};

/** Each closed; any that throws is said */
const closeEach = (list, f) => { const bad = []; for (const s of list) try { f(s); } catch (e) { bad.push(why(e)); } return bad.length ? { ok: false, said: `NOT all closed (${bad.join(", ")})` } : { ok: true, said: `${list.length} closed` }; };
const removeDir = (d) => { if (!d) return { ok: true, said: "never made" }; try { rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); return { ok: true, said: "removed" }; } catch (e) { return { ok: false, said: `NOT removed (${why(e)})` }; } };
/** Stages run one after another, each whatever the ones before it did: a stage that throws, says it failed, or doesn't
 * end within `ms`, is a failure, named; none is skipped.  Never rejects, and ends within (stages x ms).  Says each
 * stage, and whether all were done. */
const STAGE_MS = 15_000;
const runStages = async (stages, ms = STAGE_MS) => {
  const out = [];
  for (const [name, f] of stages) {
    try { const r = await bounded(Promise.resolve().then(f), name, ms); out.push({ name, ok: !!r?.ok, said: r?.said ?? "(said nothing)" }); }
    catch (e) { out.push({ name, ok: false, said: `threw (${why(e)})` }); }
  }
  return { line: "cleanup: " + out.map((s) => `${s.name} ${s.said}`).join("; "), ok: out.every((s) => s.ok) };
};
let cleaned = null;
/** Everything this run started, ended, and what it made, removed: once, however the run ends (its end, a failure, the
 * watchdog or SIGTERM), every stage attempted. */
const cleanup = () => (cleaned ??= runStages([
  ["DevTools sockets", () => closeEach(sockets, (s) => s.close())],
  ["proxied sockets", () => proxiedStage(closers, closeFailures)],
  ["upstream sockets", () => upstreamStage()],
  ["Chrome", () => stopChrome()],
  // (r9: Bun 1.3.14's server.stop(true) stayed pending in local runs on a websocket count that never fell, though every
  // page socket's open and close had been seen; so the stop is PROVED by what can be observed: it settles, or else no
  // request is pending, no page socket is open, and the listener refuses a fresh connection; else it isn't proved)
  ["front", async () => {
    if (!server) return { ok: true, said: "never started" };
    const stopping = server.stop(true);
    if (await Promise.race([stopping.then(() => true), sleep(2000).then(() => false)])) return { ok: true, said: "stopped" };
    const pend = { requests: server.pendingRequests, websockets: server.pendingWebSockets, open: pageSockets.size };
    let probe = "answered";
    try { await bounded(fetch(origin + "/", { signal: AbortSignal.timeout(2000) }), "the front's refusal probe", 3000); } catch (e) { probe = String(e?.code ?? e?.message ?? e).slice(0, 120); }
    const refused = /ConnectionRefused|ECONNREFUSED/.test(probe);
    const ok = refused && pend.requests === 0 && pend.open === 0;
    return { ok, said: ok ? `stopped (proved: the listener refuses (${probe}); no request pending; no page socket open; Bun's pendingWebSockets ${pend.websockets} not awaited)` : `NOT proved stopped: ${J({ ...pend, probe })}` };
  }],
  ["files origin", async () => {
    if (!filesServer) return { ok: true, said: "never started" };
    const stopped = await Promise.race([filesServer.stop(true).then(() => true), sleep(2000).then(() => false)]);
    return { ok: stopped, said: stopped ? "stopped" : `NOT stopped: ${filesServer.pendingRequests} requests pending` };
  }],
  ["profile", () => removeDir(profile)],
  ["site", () => removeDir(site)],
]).catch((e) => ({ line: `cleanup: rejected (${why(e)})`, ok: false })));
/** The run ended from outside its flow (the watchdog, SIGTERM): said, cleaned up, exit 1. */
const endNow = async (why) => {
  console.error(`FAIL: ${why}; waiting on: ${waitingOn}`);
  // (a backstop past the cleanup's own bound: the run ends even if the cleanup somehow doesn't)
  setTimeout(() => { console.error(`FAIL: the cleanup didn't end within ${BACKSTOP_S} s`); process.exit(1); }, BACKSTOP_S * 1000);
  console.error("  " + (await cleanup()).line);
  process.exit(1);
};
// (the watchdog, armed before anything starts: at the work deadline, LIMIT_S - BACKSTOP_S, the run is ended, named, and
// its cleanup and the backstop past it end inside LIMIT_S: RUN_LIMIT_S is the whole test's bound, start to exit)
setTimeout(() => endNow(`the run didn't end by its work deadline, ${LIMIT_S - BACKSTOP_S} s (RUN_LIMIT_S ${LIMIT_S} s, with ${BACKSTOP_S} s for the cleanup)`), (LIMIT_S - BACKSTOP_S) * 1000).unref();
process.once("SIGTERM", () => endNow("ended by SIGTERM"));

// ---- 3b's resource controls, in this process before the page (plan r6 §3, r7 §1-§4, r8 §1-§2): real RefSockets on a
// control account of their own (signed in on the reference server itself and enabled: the front's jar and session are
// never touched), each control on scoped state (registry, ledger, closed list, holds), the run's own state unchanged by
// all of them, exactly; then the barrier verdict's pure fixtures

async function resourceControls() {
  const runCounts = () => J([ups.size, closeFailures.length, closedUps.length, refHolds.size]);
  const before = runCounts();
  const scoped = (cookie) => ({ reg: new Map(), ledger: [], closed: [], refHolds: new Set(), cookie });
  const stateOf = (own) => ({
    ups: own.reg, ledger: own.ledger, closed: own.closed, refHolds: own.refHolds, inflight: new Map(), held: [], closers: new Set(),
    open: () => 0, untracked: () => 0, armed: () => false, snap: { ledger: 0, untracked: 0 },
  });
  const isSocket = (c) => typeof c?.up?.send === "function";
  /** each control's own zero delta on the run's four structures */
  const zeroDelta = (name, b0) => control1(runCounts() === b0, `(control) ${name}: the run's own ups, closeFailures, closedUps and refHolds unchanged: ${b0} -> ${runCounts()}`);
  /** A self-test row (DB2-1): `body(row)` under a real work deadline (the row's allowance less ROW_DRAIN_S); then,
   * however it ended, the row's drain: its restores run, every hold it armed released, every socket it acquired
   * closed, all confirmed closed and idle within ROW_DRAIN_S.  A row that misses its deadline fails, named; whatever it
   * still does afterwards acquires nothing (its scopes are ended: connectUp closes and refuses a late socket). */
  const runRow = async (name, allowanceS, body, workS = allowanceS - ROW_DRAIN_S) => {
    // (once the row has ended (its deadline passed, its drain begun), a late scope() is refused, and a late onDrain()
    // runs at once: a losing body that goes on can acquire nothing and install nothing that is never undone)
    const row = {
      owns: [], restores: [], ended: false, late: [],
      scope(c) { if (this.ended) { this.late.push("scope"); throw new Error("the self-test row had ended"); } const o = scoped(c); this.owns.push(o); return o; },
      onDrain(f) { if (this.ended) { this.late.push("onDrain"); try { f(); } catch {} return; } this.restores.push(f); },
    };
    const t0 = performance.now();
    let outcome = "ok";
    try { await bounded(Promise.resolve().then(() => body(row)), name, workS * 1000); }
    catch (e) { outcome = /^no answer within /.test(e?.message ?? "") ? "timed out" : `threw (${why(e)})`; }
    row.ended = true;
    for (const f of row.restores.splice(0)) try { f(); } catch {}
    for (const o of row.owns) { o.ended = true; o.refHolds.ended = true; releaseRefHolds(o.refHolds); for (const e of [...o.reg.values()]) closeUp(e, 1000, "row drain", o); }
    const drainEnd = performance.now() + ROW_DRAIN_S * 1000, undrained = [];
    for (const o of row.owns) { const c = await confirmClosed(stateOf(o), Math.max(0, drainEnd - performance.now())); undrained.push(...c.unconfirmed, ...c.busy); }
    const ms = Math.round(performance.now() - t0);
    allRows.push(row);
    return { outcome, undrained, ms, inTime: ms <= allowanceS * 1000, row };
  };
  /** One absolute deadline across a WHOLE row (DB2-R4-1): `left()` bounds every wait after runRow (its continuation,
   * its confirmations) by what remains, with ROW_MARGIN_MS kept back for the timers' own granularity; `end()` refuses
   * a row that overran its allowance anyway, stopping the whole test */
  const ROW_MARGIN_MS = 100;
  const wholeRow = ([name, s]) => {
    const t0 = performance.now(), last = t0 + s * 1000 - ROW_MARGIN_MS;
    return {
      left: () => Math.max(0, last - performance.now()),
      end: () => {
        const ms = Math.round(performance.now() - t0);
        if (ms > s * 1000) throw new Error(`a self-test row overran its ${s} s allowance (${ms} ms); the whole test stops: ${name}`);
        return ms;
      },
    };
  };
  /** The late proof's verdict (astra r4): a negative's continuation must have come, no scoped acquisition may still be
   * in flight, and every socket closed and idle; anything else is unproved losing work */
  const lateItems = (x) => [
    ...(x.resumed === false ? ["its continuation never came"] : []),
    ...(x.acquiring ? [`${x.acquiring} acquisition(s) still in flight`] : []),
    ...(x.unconfirmed ?? []),
  ];
  /** Unproved late work stops the WHOLE test here, before any later row or the browser */
  const proveLate = (name, x) => { const items = lateItems(x); if (items.length) throw new Error(`a self-test row's losing work is unproved; the whole test stops: ${name}: ${items.join("; ")}`); };
  /** every row run, for the late sweep: a socket that a losing body's connect acquired after its row's drain is closed
   * by connectUp (own.ended) onto its scope's closed list; the sweep confirms every such socket closed and idle */
  const allRows = [];
  /** A normal row's line; a row that didn't end ok, in time and drained stops the WHOLE test here: its losing work isn't
   * proved safe (only the negatives, which prove it, may time out) */
  const rowLine = (r, [name, s]) => {
    const what = `(control) row "${name}": ${r.outcome}, drained${r.undrained.length ? " NOT: " + J(r.undrained) : ""}, ${r.ms} ms of its ${s} s`;
    control1(r.outcome === "ok" && !r.undrained.length && r.inTime, what);
    if (!(r.outcome === "ok" && !r.undrained.length && r.inTime)) throw new Error("a self-test row failed; the whole test stops: " + what);
  };
  const account = "ctl-u-" + crypto.randomUUID();
  const cookie = "__Host-sb_session=" + ref.signIn(account);
  let enabled = false;
  // (row 1: the setup, then K-U2 to K-U5)
  rowLine(await runRow(SELF_TEST_ROWS[0][0], SELF_TEST_ROWS[0][1], async (row) => {
    let said = "";
    try {
      const en = await bounded(ref.fetch(new Request("http://ref.control/api/sync/v1/enable", { method: "POST", headers: { cookie } })), "the control account's enable", 2000);
      const text = await bounded(en.text(), "the control account's enable (its answer)", 2000);
      said = `${en.status} ${text}`;
      enabled = en.status === 200 && text === J({ state: "active", generation: 1 });
    } catch (e) { said = `threw (${why(e)})`; }
    control1(enabled, "(control) the control account enabled before any control socket: exactly {state: active, generation: 1}: " + said);
    if (!enabled) return;
    // K-U2: a probe-owned socket its owner never closed, nothing in flight: the barrier fails, naming it, and closes it
    {
      const z = runCounts(), own = row.scope(cookie), c = await connectUp("probe", own);
      const x = isSocket(c) ? await barrierSteps(stateOf(own), { lateObsMs: 1000, confirmMs: 1000, own }) : null;
      const v = x && barrierVerdict(x);
      zeroDelta("K-U2", z);
      control1(isSocket(c) && !v.ok && J(v.items) === J([`upstream probe ${c.entry.id} left open`]) && c.up.closed === true && c.up.inflight === 0, "(control) K-U2: a probe socket left open with nothing in flight fails the barrier, named, and the barrier closes it: " + J({ socket: isSocket(c) ? "real" : c?.refused, items: v?.items }));
    }
    // K-U3: the same for a socket acquired for an upgrade whose pair never opened
    {
      const z = runCounts(), own = row.scope(cookie), c = await connectUp("preupgrade", own);
      const x = isSocket(c) ? await barrierSteps(stateOf(own), { lateObsMs: 1000, confirmMs: 1000, own }) : null;
      const v = x && barrierVerdict(x);
      zeroDelta("K-U3", z);
      control1(isSocket(c) && !v.ok && J(v.items) === J([`upstream preupgrade ${c.entry.id} left open`]) && c.up.closed === true, "(control) K-U3: an upgrade's socket left unhanded fails the barrier, named, and is closed: " + J({ socket: isSocket(c) ? "real" : c?.refused, items: v?.items }));
    }
    // K-U4: a close that throws: one ledger entry naming the owner, the verdict fails on exactly that (the real socket,
    // closed by the control itself, confirmed through the wrapper)
    {
      const z = runCounts(), own = row.scope(cookie), c = await connectUp("probe", own);
      let v = null;
      if (isSocket(c)) {
        const real = c.up;
        c.entry.up = { send: (t) => real.send(t), close() { throw Object.assign(new Error("injected"), { code: "EPIPE" }); }, get closed() { return real.closed; }, get inflight() { return real.inflight; } };
        closeUp(c.entry, 1000, "control", own);
        real.close(1000, "control");
        v = barrierVerdict(await barrierSteps(stateOf(own), { lateObsMs: 1000, confirmMs: 1000, own }));
      }
      zeroDelta("K-U4", z);
      control1(isSocket(c) && J(own.ledger) === J(["the upstream probe socket (EPIPE)"]) && !v.ok && J(v.items) === J(["close failure: the upstream probe socket (EPIPE)"]) && c.up.closed === true, "(control) K-U4: an upstream close that throws is kept, naming its owner, and fails the barrier on exactly that: " + J({ ledger: own.ledger, items: v?.items }));
    }
    // K-U5: a normal probe on the enabled account: its two closes (its own, then the finally's no-op), nothing kept,
    // nothing left, its answer's shape unchanged
    {
      const z = runCounts(), own = row.scope(cookie);
      // (RefSocket's prototype, from a socket closed at once, before the spy is installed; the spy is removed in the
      // finally, and by the row's drain if the probe never ends)
      const tmp = await ref.connect(cookie);
      const RefSocket = Object.getPrototypeOf(tmp);
      tmp.close(1000, "control");
      const close0 = RefSocket.close;
      row.onDrain(() => { RefSocket.close = close0; });
      // (never installed once the row has ended: a body past its deadline installs nothing its drain won't undo)
      if (row.ended) throw new Error("the self-test row had ended");
      let calls = 0, p = null;
      RefSocket.close = function (...a) { if (this.account?.id === account) calls++; return close0.apply(this, a); };
      try { p = await probe({}, own); } catch (e) { p = { threw: why(e) }; } finally { RefSocket.close = close0; }
      const sock = own.closed[0];
      const t = performance.now();
      while (sock && !(sock.closed === true && sock.inflight === 0) && performance.now() - t < 1000) await sleep(20);
      zeroDelta("K-U5", z);
      control1(J(Object.keys(p ?? {})) === J(["welcome", "index", "ack"]) && p.welcome !== null && p.welcome?.state === "active" && calls === 2 && own.ledger.length === 0 && own.reg.size === 0 && own.closed.length === 1 && sock.closed === true && sock.inflight === 0, "(control) K-U5: a normal probe: an active welcome, two closes (its own, then the no-op), nothing kept or left: " + J({ keys: Object.keys(p ?? {}), state: p?.welcome?.state, threw: p?.threw, calls, ledger: own.ledger, left: own.reg.size }));
    }
  }), SELF_TEST_ROWS[0]);
  // (row 2: K-MSG1) a real batch admitted and held across its socket's close: closed is not quiescence
  rowLine(await runRow(SELF_TEST_ROWS[1][0], SELF_TEST_ROWS[1][1], async (row) => {
    if (!enabled) return control1(false, "(control) K-MSG1: not run (the control account isn't enabled)");
    const z = runCounts(), own = row.scope(cookie), steps = [];
    const c = await connectUp("probe", own);
    let v1 = null, v2 = null, busyAfterClose = null;
    try {
      if (isSocket(c)) {
        const ws = c.up, got = [];
        ws.onmessage = (text) => got.push(JSON.parse(text));
        for (const text of c.buf.splice(0)) ws.onmessage(text);
        const next = async (f, ms = 1000) => { const t = performance.now(); for (;;) { const m = got.find(f); if (m) return m; if (performance.now() - t > ms) return null; await sleep(10); } };
        const doc = crypto.randomUUID(), client = "ctlmsg1", id = "1".padStart(11, "0") + "_" + client;
        ws.send(J({ t: "hello", v: 2, device: "c0c0c0c0c0c0c0c0", name: "ctl", index_after: 0, generation: 1 }));
        const welcome = await next((m) => m.t === "welcome" || m.t === "error");
        steps.push(["welcome", welcome?.t === "welcome" && welcome.state === "active" && welcome.generation === 1]);
        ws.send(J({ t: "doc_claim", req: 1, epoch: 1, doc, client }));
        const claim = await next((m) => m.req === 1);
        const fgen = claim?.claim?.fgen;
        steps.push(["claim", claim?.t === "ack" && Number.isInteger(fgen)]);
        if (steps.every(([, ok]) => ok)) {
          armRefHold(doc, client, own.refHolds);
          const payload = new TextEncoder().encode(J({ patch: [id], userId: 0 }));
          ws.send(J({ t: "batch", req: 2, doc, epoch: 1, fgen: { [client]: fgen }, patches: [{ cseq: 1, id, parents: [], size: payload.length }], body: toB64(payload) }));
          const t = performance.now();
          while (ws.inflight !== 1 && !got.some((m) => m.req === 2) && performance.now() - t < 1000) await sleep(10);
          const refused = got.find((m) => m.req === 2);
          steps.push([refused ? `the batch answered first (${refused.code ?? refused.t})` : "the batch held (inflight 1)", !refused && ws.inflight === 1]);
        }
        closeUp(c.entry, 1000, "control", own);
        const t = performance.now();
        while (ws.closed !== true && performance.now() - t < 1000) await sleep(10);
        busyAfterClose = ws.closed === true ? ws.inflight : null;
        const s = stateOf(own);
        v1 = barrierVerdict(barrierInput(s, await confirmClosed(s, 1000)));
        releaseAndClose(s);
        v2 = barrierVerdict(barrierInput(s, await confirmClosed(s, 1000)));
        steps.push(["after the release", ws.inflight === 0]);
      }
    } finally {
      // (its hold released, and its socket closed, on any path out of the control; the row's drain does the same if
      // the control never gets here)
      releaseRefHolds(own.refHolds);
      if (c?.entry) closeUp(c.entry, 1000, "control", own);
    }
    zeroDelta("K-MSG1", z);
    control1(isSocket(c) && steps.every(([, ok]) => ok) && busyAfterClose === 1 && !v1.ok && J(v1.items) === J(["upstream socket busy after close (inflight 1)"]) && v2.ok && own.refHolds.size === 0, "(control) K-MSG1: a batch admitted and held across its socket's close: closed with inflight 1 fails the barrier as busy, exactly; released, it passes: " + J({ socket: isSocket(c) ? "real" : c?.refused, steps, busyAfterClose, first: v1?.items, then: v2?.items }));
  }), SELF_TEST_ROWS[1]);
  // (row 3: the row owner's own negative) a row whose body acquires a real socket and a batch hold, then stalls past
  // its work deadline (0.5 s): the row ends "timed out", and its drain closes the socket (closed and idle) and releases
  // the hold.  The body then RESUMES after the drain (at 0.8 s) and tries every capability again: a new scope, a socket
  // on its ended scope, a hold on its ended holds.  Each is refused; nothing reaches the run's own state.
  {
    const z = runCounts(), whole = wholeRow(SELF_TEST_ROWS[2]);
    let sock = null, holds = null, lateDone, scope3 = null;
    const lateSaid = [], late = new Promise((ok) => { lateDone = ok; });
    const r = enabled
      ? await runRow(SELF_TEST_ROWS[2][0], SELF_TEST_ROWS[2][1], async (row) => {
          const own = row.scope(cookie);
          holds = own.refHolds;
          const c = await connectUp("probe", own);
          sock = c.up ?? null;
          armRefHold(crypto.randomUUID(), "ctlneg1", own.refHolds);
          // (a second connect started now (0 s + its acquisition), delayed 700 ms inside connectUp, so it completes after
          // the row's end and drain: connectUp closes it and throws; the sweep below must find it closed and idle)
          // (the delay is read synchronously by connectUp's first statements, then cleared: the call sees the live scope,
          // so its check after the connect finds it ended)
          own.connectDelayMs = 700;
          const straddle = connectUp("probe", own).then(() => "acquired (WRONG)", (e) => `refused: ${e?.message ?? e}`);
          own.connectDelayMs = 0;
          scope3 = own;
          await sleep(800);
          lateSaid.push(`straddling socket: ${await straddle}`);
          for (const [what, f] of [["scope", () => row.scope(cookie)], ["socket", () => connectUp("probe", own)], ["hold", () => armRefHold(crypto.randomUUID(), "ctlneg1b", own.refHolds)]]) {
            try { await f(); lateSaid.push(`${what}: acquired (WRONG)`); } catch (e) { lateSaid.push(`${what}: refused`); }
          }
          lateDone();
        }, 0.5)
      : null;
    let resumed = true;
    if (r) await bounded(late, "the negative's resumption", whole.left()).catch(() => { resumed = false; lateSaid.push("never resumed"); });
    if (r) proveLate(SELF_TEST_ROWS[2][0], { resumed, acquiring: scope3?.acquiring ?? 0 });
    zeroDelta("the row owner's negative", z);
    // (the straddling socket: acquired after the drain, closed by connectUp onto the scope's closed list; confirmed
    // here closed and idle, bounded, and again by the late sweep)
    const straddled = scope3?.closed[1] ?? null;
    const st = scope3 ? await confirmClosed(stateOf(scope3), whole.left()) : null;
    if (st) proveLate(SELF_TEST_ROWS[2][0], { unconfirmed: [...st.unconfirmed, ...st.busy] });
    const ms3 = whole.end();
    control1(r !== null && J(lateSaid) === J(["straddling socket: refused: the self-test row had ended", "scope: refused", "socket: refused", "hold: refused"]) && scope3.closed.length === 2 && straddled?.closed === true && straddled.inflight === 0 && !st.unconfirmed.length && !st.busy.length && r.outcome === "timed out" && !r.undrained.length && r.inTime && ms3 <= SELF_TEST_ROWS[2][1] * 1000 && sock?.closed === true && sock.inflight === 0 && holds?.size === 0 && r.row.owns.length === 1 && r.row.owns.every((o) => o.reg.size === 0 && o.ended), `(control) row "${SELF_TEST_ROWS[2][0]}": a row that stalls past its deadline ends, named, is drained, and its resumption after the drain is refused everything: ` + J({ totalMs: ms3, allowanceS: SELF_TEST_ROWS[2][1], outcome: r?.outcome, undrained: r?.undrained, ms: r?.ms, closed: sock?.closed, inflight: sock?.inflight, holds: holds?.size, late: lateSaid }));
  }
  // (row 4: the late-scope negative) a row whose body stalls BEFORE it takes any scope, past its 0.5 s deadline, then
  // asks for a scope, a socket and a hold, and installs a restore: the scope is refused (the row has ended), so nothing
  // is acquired, and the late restore runs at once; the control waits (bounded) for that late continuation
  {
    const z = runCounts(), whole = wholeRow(SELF_TEST_ROWS[3]);
    let lateDone, lateSaid = null, restored = false;
    const late = new Promise((ok) => { lateDone = ok; });
    const r = enabled
      ? await runRow(SELF_TEST_ROWS[3][0], SELF_TEST_ROWS[3][1], async (row) => {
          await sleep(700);
          try {
            row.onDrain(() => { restored = true; });
            const own = row.scope(cookie);
            await connectUp("probe", own);
            armRefHold(crypto.randomUUID(), "ctlneg2", own.refHolds);
            lateSaid = "acquired (WRONG)";
          } catch (e) { lateSaid = `refused: ${e?.message ?? e}`; }
          lateDone();
        }, 0.5)
      : null;
    let resumed = true;
    if (r) await bounded(late, "the late-scope negative's continuation", whole.left()).catch(() => { resumed = false; lateSaid ??= "never came"; });
    if (r) proveLate(SELF_TEST_ROWS[3][0], { resumed, acquiring: r.row.owns.reduce((n, o) => n + (o.acquiring ?? 0), 0) });
    const ms4 = whole.end();
    zeroDelta("the row owner's late-scope negative", z);
    control1(r !== null && r.outcome === "timed out" && !r.undrained.length && r.inTime && ms4 <= SELF_TEST_ROWS[3][1] * 1000 && r.row.owns.length === 0 && restored && J(r.row.late) === J(["onDrain", "scope"]) && lateSaid === "refused: the self-test row had ended", `(control) row "${SELF_TEST_ROWS[3][0]}": a body that goes on past its row's end gets no scope, acquires nothing, and its late restore runs at once: ` + J({ totalMs: ms4, allowanceS: SELF_TEST_ROWS[3][1], outcome: r?.outcome, ms: r?.ms, owns: r?.row.owns.length, late: r?.row.late, restored, said: lateSaid }));
  }
  // (row 5: the rows' late sweep) every socket any row's scope ever closed, late ones included, confirmed closed and
  // idle within 1 s; anything not stops the WHOLE test (a losing body's work not proved safe)
  {
    const whole = wholeRow(SELF_TEST_ROWS[4]), left = [];
    // (the front's own registry too: before the page starts, any operation still in flight is a row's)
    if (reg.inflight.size) left.push(`front operations still in flight: ${[...reg.inflight.values()].map((e) => e.label).join(", ")}`);
    for (const row of allRows) for (const o of row.owns) {
      if (o.acquiring) left.push(`${o.acquiring} acquisition(s) still in flight`);
      const c = await confirmClosed(stateOf(o), whole.left());
      left.push(...c.unconfirmed, ...c.busy);
    }
    const ms5 = whole.end();
    const what = `(control) row "${SELF_TEST_ROWS[4][0]}": every row's sockets, late ones included, closed and idle: ${left.length ? "NOT " + J(left) : "all"}, ${ms5} ms`;
    control1(!left.length, what);
    if (left.length) throw new Error("a self-test row left work running; the whole test stops: " + what);
  }
  control1(runCounts() === before, "(control) the resource controls left the run's own state exactly as it was (ups, closeFailures, closedUps, refHolds): " + before + " -> " + runCounts());
  // the verdict's pure fixtures, B1-B9
  const base = { inflight: [], closers: 0, held: 0, open: 0, newCloseFailures: [], untrackedDelta: 0, ups: 0, armed: false, residue: [], unconfirmed: [], busy: [] };
  const fx = [
    ["B1", { closers: 1 }, ["closers 1"]],
    ["B2", { newCloseFailures: ["the server's side (EPIPE)"] }, ["close failure: the server's side (EPIPE)"]],
    ["B3", { held: 1 }, ["held 1"]],
    ["B4", { untrackedDelta: 1 }, ["untracked reads +1"]],
    ["B5", {}, []],
    ["B6", { ups: 1 }, ["upstream registry 1"]],
    ["B7", { residue: ["upstream probe 7 left open"] }, ["upstream probe 7 left open"]],
    ["B8", { unconfirmed: ["upstream close unconfirmed"] }, ["upstream close unconfirmed"]],
    ["B9", { busy: ["upstream socket busy after close (inflight 1)"] }, ["upstream socket busy after close (inflight 1)"]],
  ];
  // the late proof's pure fixtures, L1-L4: an overdue continuation, a pending acquisition, an unconfirmed socket are
  // each unproved; and a stop leaves the work after it undone (its sentinel unset)
  for (const [name, x, n] of [["L1", { resumed: false }, 1], ["L2", { resumed: true, acquiring: 1 }, 1], ["L3", { resumed: true, unconfirmed: ["upstream close unconfirmed"] }, 1], ["L4", { resumed: true, acquiring: 0, unconfirmed: [] }, 0]]) {
    const items = lateItems(x);
    let stopped = false, sentinel = false;
    try { proveLate(name, x); sentinel = true; } catch { stopped = true; }
    control1(items.length === n && stopped === (n > 0) && sentinel === (n === 0), `(control) ${name}: the late proof on ${J(x)}: ${items.length ? "unproved, the test stops, the work after it undone: " + J(items) : "proved, the work after it runs"}`);
  }
  for (const [name, x, items] of fx) {
    const v = barrierVerdict({ ...base, ...x });
    control1(v.ok === (items.length === 0) && J(v.items) === J(items), `(control) ${name}: the barrier's verdict on ${J(x)}: ${v.ok ? "pass" : "fail " + J(v.items)}`);
  }
  // (r7, the disposal's pure fixtures D1-D7, one control line each (the ok line's count 66 -> 73): a protocol error, an
  // errorText, an acknowledged navigation whose document never changes (a delayed disposal), a changed loader whose
  // page still has the cases' globals, another loader than the navigation's, an unanswered navigation each stop the
  // test with the work after it undone (its sentinel unset); only D7, all observed, lets the work after it run)
  {
    const old = { loaderId: "L1", url: "http://127.0.0.1/ctl.html?p=P7" }, ack = { frameId: "F", loaderId: "L2" };
    const io = ({ nav = ack, after = { loaderId: "L2", url: "about:blank" }, empty = true }) => {
      let reads = 0;
      return { frame: async () => (reads++ === 0 ? old : after), navigate: async () => { if (nav instanceof Error) throw nav; return nav; }, probe: async () => empty };
    };
    const dx = [
      ["D1", { nav: { code: -32000, message: "Cannot navigate to invalid URL" } }, false],
      ["D2", { nav: { frameId: "F", loaderId: "L2", errorText: "net::ERR_ABORTED" } }, false],
      ["D3", { after: old }, false],
      ["D4", { empty: false }, false],
      ["D5", { after: { loaderId: "L3", url: "about:blank" } }, false],
      ["D6", { nav: new Error("no answer within 300 ms: Page.navigate") }, false],
      ["D7", {}, true],
    ];
    for (const [name, x, proves] of dx) {
      const d = await disposePage(io(x), 300);
      let stopped = false, sentinel = false;
      try { requireDisposed(name, d); sentinel = true; } catch { stopped = true; }
      control1(d.ok === proves && stopped === !proves && sentinel === proves, `(control) ${name}: a failed control page's disposal on ${J(x)}: ${d.ok ? "proved, the work after it runs" : "unproved, the test stops, the work after it undone"} (${d.said})`);
    }
    // (r8, astra's D2 r7 REVISE: D8, LATE observations, on a controlled clock (no timer races): each answer is valid-
    // looking, but the call that returns it moves the clock to the slot's exact end (300 of 300 ms). (a) the probe's true
    // at the end; (b) the frame read before the navigation at the end: no navigation may be sent; (c) the committed-
    // looking frame at the end: no probe may be sent. Each must be unproved, stop the test through requireDisposed and
    // leave the work after it undone (its sentinel unset). One control line, so the ok line's count is 74)
    const lateAt = { a: "probe", b: "frame0", c: "frame1" }, d8 = [];
    let d8ok = true;
    for (const [k, at] of Object.entries(lateAt)) {
      let t = 0, reads = 0;
      const calls = { frame: 0, navigate: 0, probe: 0 };
      const clock = () => t;
      const lio = {
        frame: async () => { calls.frame++; const r = reads++ === 0 ? old : { loaderId: "L2", url: "about:blank" }; if ((at === "frame0" && reads === 1) || (at === "frame1" && reads === 2)) t += 300; return r; },
        navigate: async () => { calls.navigate++; return ack; },
        probe: async () => { calls.probe++; if (at === "probe") t += 300; return true; },
      };
      const d = await disposePage(lio, 300, clock);
      let stopped = false, sentinel = false;
      try { requireDisposed(`D8${k}`, d); sentinel = true; } catch { stopped = true; }
      const noMore = at === "frame0" ? calls.navigate === 0 && calls.probe === 0 : at === "frame1" ? calls.probe === 0 : calls.probe === 1;
      const ok = !d.ok && /the slot of 300 ms ran out/.test(d.said) && stopped && !sentinel && noMore;
      d8ok &&= ok;
      d8.push(`(${k}) late ${at}: ${ok ? "" : "WRONG: "}${d.ok ? "proved" : "unproved"}, ${stopped ? "the test stops" : "NOT stopped"}, the work after it ${sentinel ? "RAN" : "undone"}, calls ${J(calls)} (${d.said})`);
    }
    control1(d8ok, "(control) D8: a valid-looking observation at the slot's end is unproved and stops the test: " + d8.join("; "));
  }
  return enabled ? cookie : null;
}

/** r7 (astra's and astra5's D2 r6 REVISE): a control page that didn't end, disposed of by navigating it to about:blank,
 * the disposal PROVED inside one slot of `ms` from the start, or not at all. From the CDP Page domain (devtools-protocol
 * pdl/domains/Page.pdl at dfad77069330a9188771bb64a32d18853a10b012): navigate returns frameId, loaderId ("omitted in
 * case of same-document navigation") and errorText ("present if and only if navigation has failed"); getFrameTree's
 * Frame has loaderId ("Identifier of the loader associated with this frame") and url. A protocol error (the dispatcher
 * resolves m.error as the answer) or an errorText is a failure at once. Proved only when the root frame's loader has
 * changed from the one before the navigation (the old document gone), to the navigation's own loader, at about:blank,
 * and the page then evaluates with none of the cases' globals (the blank document committed). `io` is the CDP side:
 * frame(ms), navigate(ms), probe(ms).
 * r8 (astra's D2 r7 REVISE): the ONE deadline is checked on the clock (`now`, performance.now unless a fixture's) after
 * every await, before any further CDP work, and at the success decision: an answer, or a proof, that arrives with no
 * time left is unproved ("the slot ran out"), whatever it says; a call's own timer winning its race is never taken for
 * that check */
async function disposePage(io, ms, now = () => performance.now()) {
  const end = now() + ms, left = () => Math.max(0, end - now());
  const settle = (p) => Promise.resolve().then(p).then((v) => ({ v }), (e) => ({ e: why(e) }));
  const late = (after) => ({ ok: false, said: `the slot of ${ms} ms ran out ${after}` });
  const before = await settle(() => io.frame(left()));
  if (before.e !== undefined || typeof before.v?.loaderId !== "string") return { ok: false, said: `the frame before the navigation unread: ${before.e ?? J(before.v)}` };
  if (!(left() > 0)) return late("after the frame read before the navigation (no navigation sent)");
  const nav = await settle(() => io.navigate(left()));
  if (nav.e !== undefined) return { ok: false, said: `the navigation unanswered: ${nav.e}` };
  const a = nav.v;
  if (!a || typeof a !== "object" || a.code !== undefined || a.message !== undefined) return { ok: false, said: `the navigation answered a protocol error: ${J(a)}` };
  if (a.errorText !== undefined) return { ok: false, said: `the navigation failed: errorText ${J(a.errorText)}` };
  if (!(left() > 0)) return late("at the navigation's answer");
  let last = { loaderBefore: before.v.loaderId, navLoader: a.loaderId ?? null };
  while (left() > 0) {
    const f = await settle(() => io.frame(Math.min(1000, left())));
    if (!(left() > 0)) return late(`at a frame read (no probe sent): ${J(f.v ?? f.e)}`);
    if (f.e === undefined && typeof f.v?.loaderId === "string") {
      const gone = f.v.loaderId !== before.v.loaderId, ours = a.loaderId === undefined || f.v.loaderId === a.loaderId, blank = f.v.url === "about:blank";
      last = { loaderBefore: before.v.loaderId, navLoader: a.loaderId ?? null, loader: f.v.loaderId, url: f.v.url };
      if (gone && ours && blank) {
        const p = await settle(() => io.probe(Math.min(1000, left())));
        last.empty = p.e ?? p.v;
        if (!(left() > 0)) return late(`at the probe's answer (${J(last)})`);
        if (p.v === true) return { ok: true, said: `the old document gone (loader ${before.v.loaderId} -> ${f.v.loaderId}), about:blank committed with none of the cases' globals` };
      }
    } else last = { ...last, frame: f.e ?? J(f.v) };
    await sleep(Math.min(50, left()));
  }
  return { ok: false, said: `not observed within ${ms} ms: ${J(last)}` };
}
/** The gate after disposePage: unproved, the whole test stops, before the barrier and before any later page */
const requireDisposed = (page, d, more = "") => { if (!d.ok) throw new Error(`the control page ${page} didn't end, and its disposal wasn't proved, so the whole test stops before the barrier: ${d.said}${more}`); };

/** r6 §4's stop-path run (CONTROL_STOP=upstreamCloseFailure, read once at startup; absent in the main run): K-U4's
 * setup on the run's OWN registry and ledger, then the between-page barrier once, which must stop the whole test (exit 1,
 * "front not quiescent between pages", naming the upstream probe socket); the wrapped socket is closed by this code */
async function controlStop(cookie) {
  if (!cookie) throw new Error("CONTROL_STOP: the control account isn't enabled");
  const c = await connectUp("probe", { cookie });
  if (typeof c?.up?.send !== "function") throw new Error("CONTROL_STOP: no real socket: " + J(c?.refused));
  const real = c.up;
  c.entry.up = { send: (t) => real.send(t), close() { throw Object.assign(new Error("injected"), { code: "EPIPE" }); }, get closed() { return real.closed; }, get inflight() { return real.inflight; } };
  closeUp(c.entry, 1000, "control stop");
  real.close(1000, "control stop");
  const x = await barrierSteps(runState());
  const v = barrierVerdict(x);
  if (!v.ok) throw new Error(`front not quiescent between pages (after CONTROL_STOP): ${v.items.join("; ")}`);
  throw new Error("CONTROL_STOP: the barrier passed; it must not");
}

let results = [];
try {
  // (the temporary directories, made inside the try: if the second can't be, the cleanup still removes the first)
  profile = mkdtempSync(join(tmpdir(), "sb-scr-"));
  site = mkdtempSync(join(tmpdir(), "sb-scr-site-"));
  // (controls of the cleanup itself, in this process, with faults injected: every stage still runs, each failure is
  // named and the whole fails; a kill that throws other than ESRCH is not a stop; a spawn error is never an exit)
  {
    const d = mkdtempSync(join(tmpdir(), "sb-scr-ctl-"));
    const c = await runStages([
      ["a kill", () => { throw Object.assign(new Error("injected"), { code: "EPERM" }); }],
      ["a front", async () => { throw new Error("injected stop failure"); }],
      ["a directory", () => removeDir(d)],
    ]);
    control1(!c.ok && c.line === "cleanup: a kill threw (EPERM); a front threw (injected stop failure); a directory removed" && !existsSync(d), "(control) the cleanup runs every stage after failures, names each and fails: " + c.line);
    // (the real pair closer, registered as the front registers one, its server side refusing, closed the way the cases'
    // paths close it (its answer ignored) BEFORE the cleanup: the failure is kept, the page's side still closed, once
    // only, and the cleanup's proxied-sockets stage, run on that registry and ledger, fails naming it)
    let pageClosed = false;
    const reg = new Set(), led = [];
    const pc = pairCloser({ close() { throw Object.assign(new Error("injected"), { code: "EPIPE" }); } }, { close() { pageClosed = true; } }, () => reg.delete(pc), led);
    reg.add(pc);
    pc(1000);
    const pcAgain = pc(1000), d3 = mkdtempSync(join(tmpdir(), "sb-scr-ctl-"));
    const receipt = await runStages([["proxied sockets", () => proxiedStage(reg, led)], ["a directory", () => removeDir(d3)]], 200);
    control1(pageClosed && pcAgain.length === 0 && reg.size === 0 && J(led) === J(["the server's side (EPIPE)"]) && !receipt.ok && receipt.line === "cleanup: proxied sockets NOT all closed (the server's side (EPIPE)); a directory removed" && !existsSync(d3), "(control) a proxied pair's close that fails before the cleanup fails the final receipt, naming it, and the stages after it still run: " + receipt.line);
    // (a benign double close: the page's side already closed (readyState 3) isn't closed again, and nothing is recorded)
    const led2 = [], skips2 = { n: 0 };
    const pc2 = pairCloser({ close() {} }, { readyState: 3, close() { throw new Error("injected: closed twice"); } }, () => {}, led2, skips2);
    control1(pc2(1000).length === 0 && led2.length === 0 && skips2.n === 1, "(control) a page socket already closed is not closed again, and its pair records no failure: " + J({ failures: led2, skipped: skips2.n }));
    const d2 = mkdtempSync(join(tmpdir(), "sb-scr-ctl-"));
    const t0 = Date.now(), c2 = await runStages([["a front stop that never settles", () => new Promise(() => {})], ["a directory", () => removeDir(d2)]], 200);
    control1(!c2.ok && c2.line === "cleanup: a front stop that never settles threw (no answer within 200 ms: a front stop that never settles); a directory removed" && !existsSync(d2) && Date.now() - t0 < 5000, "(control) a stage that never ends fails within its bound, and the stages after it still run: " + c2.line);
    const eperm = await stopChrome({ pid: 1, exitCode: null, signalCode: null, kill() { throw Object.assign(new Error("injected"), { code: "EPERM" }); } }, () => new Promise(() => {}));
    control1(!eperm.ok && eperm.said === "TERM failed (EPERM)", "(control) a kill refused (EPERM) is a failure, not a stop: " + eperm.said);
    const esrch = await stopChrome({ pid: 1, exitCode: null, signalCode: null, kill() { throw Object.assign(new Error("injected"), { code: "ESRCH" }); } }, async () => ({ exit: [0, null] }));
    control1(esrch.ok && esrch.said === "exited on TERM", "(control) a kill that finds the process gone (ESRCH), then its exit seen, is a stop: " + esrch.said);
    const spawnError = await stopChrome({ pid: 1, exitCode: null, signalCode: null, kill() {} }, async () => ({ error: Object.assign(new Error("injected"), { code: "ENOENT" }) }));
    control1(!spawnError.ok && spawnError.said === "ended with an error (ENOENT)", "(control) a spawn error is never taken for an observed exit: " + spawnError.said);
  }
  const controlCookie = await resourceControls();
  if (CONTROL_STOP === "upstreamCloseFailure") await controlStop(controlCookie);
  // (the page: the workspace bundled in this process, and the cases beside it)
  waitingOn = "the page's bundle (Bun.build of index.ts)";
  const b = await bounded(Bun.build({ entrypoints: [join(here, "index.ts")], outdir: site, naming: "ws.js", target: "browser", format: "esm" }), waitingOn, 120_000);
  if (!b.success) throw new Error("the page's bundle: " + b.logs.map(String).join("\n"));
  copyFileSync(join(here, "sync-client-cases.js"), join(site, "cases.js"));
  writeFileSync(join(site, "index.html"), `<!doctype html><meta charset="utf-8"><title>sync client test</title><script>window.ACCOUNTS = ${J(ACCOUNTS)}; window.FULL = ${J(FULL)}; window.SMALL = ${J(SMALL)}; window.REQUIRE_CLAIM = true; window.__budgets = ${J(MAIN_BUDGETS)};</script><script type="module">import { run } from "./cases.js"; window.run = run; window.ready = true;</script>`);
  // (the control pages: their own accounts, never the main run's, and their own budgets; P7 has none, so it's legacy)
  writeFileSync(join(site, "ctl.html"), `<!doctype html><meta charset="utf-8"><title>sync client test: controls</title><script>const p = new URLSearchParams(location.search).get("p"); window.ACCOUNTS = ${J(CTL_ACCOUNTS)}.slice(3 * Math.max(0, ${J(CONTROL_PAGES.map((c) => c.page))}.indexOf(p))); window.FULL = null; window.SMALL = null; window.REQUIRE_CLAIM = true; if (p !== "P7") window.__budgets = ${J(CONTROL_BUDGETS)};</script><script type="module">import { run, runControls } from "./cases.js"; window.run = run; window.runControls = runControls; window.ready = true;</script>`);
  server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: serve, websocket });
  origin = `http://127.0.0.1:${server.port}`;
  filesServer = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: filesServe });
  filesOrigin = `http://127.0.0.1:${filesServer.port}`;

  let port = Number(process.env.CDP_PORT) || 0;
  chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", "--js-flags=--expose-gc", "--enable-precise-memory-info", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
  chromeEnded = new Promise((r) => { chrome.once("exit", (code, signal) => r({ exit: [code, signal] })); chrome.once("error", (error) => r({ error })); });
  waitingOn = "Chrome's DevTools port";
  if (!port) port = await bounded(Promise.race([devtoolsPort(profile), chromeEnded.then((end) => { throw new Error(end?.error ? `Chrome didn't start: ${why(end.error)}` : `Chrome ended before its DevTools port: exit ${J(end?.exit)}`); })]), waitingOn, 60_000);
  let targets;
  waitingOn = "the page list (/json)";
  for (let i = 0; i < 300; i++) { try { targets = await bounded(fetch(`http://127.0.0.1:${port}/json`).then((r) => r.json()), waitingOn, 5000); if (targets.some((t) => t.type === "page")) break; } catch {} await sleep(100); }
  const pageTarget = Array.isArray(targets) ? targets.find((t) => t.type === "page") : undefined;
  if (!pageTarget) throw new Error("no page target in /json after 300 tries");
  const ws = new WebSocket(pageTarget.webSocketDebuggerUrl);
  sockets.push(ws);
  await bounded(new Promise((r) => (ws.onopen = r)), (waitingOn = "the page's DevTools socket to open"), 10_000);
  let n = 0;
  const waiting = new Map(), errors = [];
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result ?? m.error); waiting.delete(m.id); }
    if (m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails?.exception?.description ?? J(m.params.exceptionDetails));
    if (m.method === "Runtime.consoleAPICalled" && process.env.SHOW_CONSOLE) console.log("page:", m.params.args.map((a) => a.value ?? a.description).join(" "));
  };
  const describe = (method, params) => method + (params?.expression ? ": " + String(params.expression).replace(/\s+/g, " ").slice(0, 160) : "");
  const send = (method, params = {}, ms = CALL_MS) => { const id = ++n, what = describe(method, params); waitingOn = what; return bounded(new Promise((r) => { waiting.set(id, r); ws.send(J({ id, method, params })); }), what, ms).finally(() => waiting.delete(id)); };
  const ev = async (expression, ms) => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, ms); if (r.exceptionDetails) throw new Error(J(r.exceptionDetails).slice(0, 2000)); return r.result?.value; };
  await send("Runtime.enable");
  /** A fresh page at `path`, ready, within T_PAGE_S from the navigation */
  const transition = async (path) => {
    const end = performance.now() + T_PAGE_S * 1000, left = () => Math.max(0, end - performance.now());
    await send("Page.navigate", { url: `${origin}${path}` }, Math.min(CALL_MS, left()));
    let ready = false;
    while (left() > 0 && !(ready = await ev("window.ready === true", Math.min(5000, left())).catch(() => false))) await sleep(50);
    if (!ready) throw new Error(`the page ${path} didn't become ready (window.ready) within ${T_PAGE_S} s`);
  };
  /** A run started in the page (never awaited in one evaluate), its report polled every 2 s, each poll bounded by what's
   * left; ends when the report says done, or the allowance is spent.  Says the last good snapshot and its age. */
  const runInPage = async (start, allowanceS, tell) => {
    const t0 = performance.now(), end = t0 + allowanceS * 1000, left = () => Math.max(0, end - performance.now());
    const req0 = front.requests;
    await ev(`(window.__runP = ${start}, true)`, Math.min(CALL_MS, left()));
    let last = null, at = null, progress = null;
    while (left() > 0) {
      // (each poll reads the report and, r6, window.progress, in the same evaluate)
      const s = await ev("JSON.stringify({ report: window.__report ?? null, progress: window.progress ?? null })", Math.min(5000, left())).catch(() => null);
      if (s) { try { const o = JSON.parse(s); last = o.report; progress = o.progress; at = performance.now(); } catch {} }
      if (last) tell?.(last);
      if (last?.done) break;
      await sleep(Math.min(2000, left()));
    }
    return { report: last, progress, elapsedS: +((performance.now() - t0) / 1000).toFixed(1), requests: front.requests - req0, ageS: at === null ? null : Math.round((performance.now() - at) / 1000), done: !!last?.done };
  };
  /** The run's answer, once it's done */
  const answer = () => ev("window.__runP", FETCH_S * 1000);
  const receipt = (r) => (r.report ? `receipt (${r.ageS} s old): ${J({ mode: r.report.mode, why: r.report.why, progress: r.report.progress, steps: r.report.steps, stopped: r.report.stopped, late: r.report.late }).slice(0, 4000)}` : "receipt: unavailable (no snapshot yet)");
  /** The between-page barrier on the run's own state; failing, the whole test stops */
  const barrier = async (page) => {
    const x = await barrierSteps(runState());
    const v = barrierVerdict(x);
    const late = reg.late.map((l) => `${l.label}@${l.tag}`);
    if (!v.ok) throw new Error(`front not quiescent between pages (after ${page}): ${v.items.join("; ")}`);
    newPage();
    return { before: x.before, late };
  };
  /** The core run must be in diagnostic mode (r3 §1): a legacy fallback here is a failure, never a pass */
  const requireDiagnostic = (rep) => (rep?.mode === "diagnostic" ? null : `diagnostic mode not active: ${rep ? `${rep.mode} (${rep.why})` : "no report"}`);

  // (the control pages, each a fresh navigation, before the main run: every control line must be ok)
  newPage();
  for (const cp of CONTROL_PAGES) {
    const allowance = pageAllowanceS(cp) - T_PAGE_S - LATE_OBS_MS / 1000;
    if (cp.page === "P8") ctl.quietUnknown = true;
    const proofs0 = reg.proofs;
    await transition(`/ctl.html?p=${cp.page}`);
    const r = await runInPage(`window.runControls(${J(cp.page)})`, allowance);
    let lines;
    if (r.done) lines = await answer();
    else {
      // (r6, @sagebrush's (3): a page that doesn't end is a failed control, recorded with its receipt; r7: its disposal
      // is then proved below (or the whole test stops), and the barrier must still prove the front quiet, or the whole
      // test stops as before. The pages after it, and the main run, then go on, the main run as DIAGNOSTIC ONLY)
      lines = [[false, `didn't end within ${allowance} s (elapsed ${r.elapsedS} s): ${receipt(r)}`]];
    }
    for (const [ok, what] of Array.isArray(lines) ? lines : [[false, `${cp.page}: no control lines: ${J(lines)}`]]) control1(ok, `(control) ${cp.page} ${what}`);
    if (!r.done) {
      // (r7: the disposal PROVED (disposePage), inside the answer's unused FETCH_S slot, and recorded as a control
      // either way; unproved, the whole test stops here, before the barrier and before any later page or the main run)
      const d = await disposePage({
        frame: (ms) => send("Page.getFrameTree", {}, ms).then((t) => { if (!t?.frameTree?.frame) throw new Error("no frame tree: " + J(t).slice(0, 300)); return t.frameTree.frame; }),
        navigate: (ms) => send("Page.navigate", { url: "about:blank" }, ms),
        probe: (ms) => ev('location.href === "about:blank" && typeof window.runControls === "undefined" && typeof window.run === "undefined" && typeof window.__report === "undefined" && typeof window.__runP === "undefined"', ms),
      }, FETCH_S * 1000);
      control1(d.ok, `(control) ${cp.page} disposed of after it didn't end (about:blank, within ${FETCH_S} s): ${d.said}`);
      requireDisposed(cp.page, d, `; ${receipt(r)}`);
      console.log(`  page ${cp.page} closed (proved: ${d.said}) after it didn't end; ${receipt(r)}`);
    }
    const proofs = reg.proofs - proofs0;
    const b = await barrier(cp.page);
    // (the harness's side of the terminal controls: what only the front or the barrier saw)
    if (cp.page === "P5") control1(b.late.some((l) => /^ctl slow@/.test(l)), "(control) P5 K-J: the barrier saw the abandoned ctl slow complete, late: " + J(b.late));
    if (cp.page === "P6") control1(b.late.some((l) => /^armed late@/.test(l)) || r.report?.stopped?.late?.some?.((l) => /^armed late@/.test(l)), "(control) P6 K-L2: the armed op's late completion recorded: " + J({ barrier: b.late, page: r.report?.stopped?.late }));
    // (P7, r6: the empty selection made no request at all while its run ran (so no ctl("reset") and no proof
    // command), from the front's own count; its elapsed time and window.progress (unset: no case started) recorded)
    if (cp.page === "P7") control1(r.done && r.report?.mode === "legacy" && proofs === 0 && r.requests === 0 && r.progress === null, "(control) P7 K-M1: legacy, the empty selection made no request (no ctl reset, no proof command): " + J({ mode: r.report?.mode, proofs, requests: r.requests, progress: r.progress, elapsedS: r.elapsedS }));
    if (cp.page === "P8") { const no = requireDiagnostic(r.report); control1(no !== null && /quiet answered \{"error":"unknown"\}/.test(no), "(control) P8 K-M2: the runner refuses the run: " + no); }
    if (cp.page === "RES1") control1(b.before.closers === 1 && b.before.inflight === 0, "(control) RES1 K-RES1: a socket left open with nothing in flight: the barrier closed it and passed: " + J(b.before));
  }

  // (the main run: every case but the cloud-only ones, which are skipped by name; its report polled, so a run that
  // doesn't end within its bound still says its cases' times, the open steps and where it was)
  // (r6: a control failed before the main run (its page's cleanup proved by the barrier): the main run still runs, for
  // diagnosis only; G1 is unchanged (the failure fails the run), and this label marks the table)
  const diagnosticOnly = fails.length > 0;
  if (diagnosticOnly) console.log(`  DIAGNOSTIC ONLY: ${fails.length} control(s) failed before the main run; its table below can never count toward G1`);
  await transition("/");
  for (const name of CLOUD_ONLY) if (selected(name)) console.log(`skipped (cloud-only, the reference server has no quotas): ${name}`);
  let modeChecked = false;
  const main = await runInPage(`window.run(${J(ONLY)}, ${J(CLOUD_ONLY.join(","))})`, PILOT_MAIN_S, (rep) => {
    if (modeChecked || !rep.mode) return;
    modeChecked = true;
    const no = requireDiagnostic(rep);
    if (no) throw new Error(no);
  });
  for (const c of main.report?.cases ?? []) console.log(`  case${diagnosticOnly ? " (DIAGNOSTIC ONLY)" : ""} ${c.name}: ${c.outcome ?? "running"}, ${c.endMs !== undefined ? ((c.endMs - c.startMs) / 1000).toFixed(1) + " s" : "unended"}${c.over ? `, over its bound by ${c.over} s (report-only)` : ""}, checks from ${c.checks}${c.cleanup && !c.cleanup.ok ? `, cleanup FAILED at ${c.cleanup.step}` : ""}`);
  if (!main.done) throw new Error(`the run didn't end within ${PILOT_MAIN_S} s: ${receipt(main)}`);
  { const no = requireDiagnostic(main.report); if (no) throw new Error(no); }
  if (main.report.stopped) fails.push(`fail-stop: ${J(main.report.stopped).slice(0, 2000)}`);
  for (const l of main.report.late ?? []) console.log(`  late: ${l}`);
  results = await answer();
  const mb = await barrier("the main run");
  for (const l of mb.late) console.log(`  late (the barrier): ${l}`);
  waitingOn = "(the run's results)";
  fails.push(...results.filter(([ok]) => !ok).map(([, what]) => what));
  // (claims: with SYNC_REQUIRE_CLAIM the legacy path is a failure, never a pass; its only result says "not exercised")
  for (const [, what] of results) if (/not exercised/.test(what)) fails.push(`a "not exercised" result: ${what}`);
  // (measurements, printed pass or fail)
  for (const [, what] of results) if (/figures/.test(what)) console.log("  " + what);
  // (informational: the reference server sends index_changed after ops that move an account's head; ctl.serverNotices
  // is off, so the front drops them)
  console.log(`  front: the server's own index_changed notices dropped (ctl.serverNotices off): ${serverNoticesDropped}`);
  // (the downloads went through the redirect to the page's own /__files/: required when a download case ran)
  if (DOWNLOADS.some(selected)) {
    console.log(`  front: downloads through /__files/ on the files origin: ${front.files200} (preflights: ${front.filesPreflights})`);
    if (front.files200 === 0) fails.push("no download went through /__files/ (the blob GET's redirect)");
  } else console.log("  front: downloads through /__files/: not required (ONLY names no download case)");
  // (the proxied pairs' closes over the run, for the gate's behaviour on real data; any failure also fails the cleanup)
  console.log(`  front: proxied close failures recorded: ${closeFailures.length}; page sockets already closed, not closed again: ${closeSkips.n}`);
  if (front.filesXSync.length) fails.push(`x-sync-* headers reached the files origin (its CORS refuses them, so those downloads fail in a browser): ${front.filesXSync.length}: ${front.filesXSync.slice(0, 3).join("; ")}`);
  if (front.leaks.length) fails.push(`the internal origin leaked to the page: ${front.leaks.length} responses: ${front.leaks.slice(0, 5).join("; ")}`);
  for (const e of errors) fails.push("page error: " + e);
} catch (e) {
  fails.push(`threw: ${e?.stack ?? e} (waiting on: ${waitingOn})`);
} finally {
  const c = await cleanup();
  console.log("  " + c.line);
  if (!c.ok) fails.push("not everything was cleaned up: " + c.line);
}
if (fails.length) {
  console.error(`FAIL: ${fails.length} of ${results.length} checks\n  ` + fails.join("\n  "));
  process.exit(1);
}
const skipped = CLOUD_ONLY.filter(selected).length;
console.log(`ok: sync's client against the reference server, ${results.length} checks, ${controls.length} runner controls, ${skipped} cloud-only cases skipped`);
if (process.env.SHOW) for (const [, what] of results) console.log("  " + what);
process.exit(0);
