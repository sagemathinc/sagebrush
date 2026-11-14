// ci: web-sync.1 order=25
// Sync for every CoCalc account (SYNC_ADMIT, web/sync/env.ts allowed()): with it "all", every signed-in account is
// admitted and its plan governs the rest; with it unset or anything else, only the lists, as before.  And the
// rollback: the same storage under a Worker with it unbound (as a deploy that unbinds it is, its objects restarted and
// their sockets with them) admits nothing new, refuses the account's socket and uploads, and keeps every op; bound
// again, it goes on from them.  (On a socket that stays open, the account object's own guards, sessionLive on every
// message and admit() on every batch and upload, check the same allowed(); a deploy leaves no such socket.)
// In Miniflare with real Durable Objects (SQLite), D1 and R2.
//
//   node web/sync/test-sync-admit.mjs
import { readdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { dispatch } from "../miniflare-dispatch.mjs";
import { readFigures } from "../../scripts/sync-usage-check.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(here, "../site/package.json"));
const { Miniflare, convertV4MiniflareOptions } = require("miniflare");

let failures = 0, count = 0;
function ok(cond, what) {
  count++;
  if (!cond) {
    failures++;
    console.log("FAIL", what);
  }
}

const OPEN = "a0a0a0a0-0001-4a0a-8a0a-a0a0a0a0a001"; // on no list; a plan with sync
const NOSYNC = "a0a0a0a0-0002-4a0a-8a0a-a0a0a0a0a002"; // on no list; a plan without sync
const NOPLAN = "a0a0a0a0-0003-4a0a-8a0a-a0a0a0a0a003"; // on no list; CoCalc has no plan for it
const BADPLAN = "a0a0a0a0-0004-4a0a-8a0a-a0a0a0a0a004"; // on no list; CoCalc's answer isn't a plan
const LISTED = "a0a0a0a0-0005-4a0a-8a0a-a0a0a0a0a005"; // in SYNC_ACCOUNTS
const SMALL = "a0a0a0a0-0006-4a0a-8a0a-a0a0a0a0a006"; // on no list; a small plan (its file limit)
const ROLL = "a0a0a0a0-0007-4a0a-8a0a-a0a0a0a0a007"; // on no list; the rollback's account

const script = execFileSync("bun", ["build", join(here, "test-entry.ts"), "--format", "esm", "--target", "browser", "--external", "cloudflare:workers"], { encoding: "utf8" });
const base = { modules: true, script, compatibilityDate: "2026-10-01", d1Databases: ["SHARE_DB"], r2Buckets: ["SHARE_BUCKET"] };
const shareBindings = { SESSION_KEY: "session-key", SHARE_DEV: "1", DEV_AUTH_TOKEN: "dev-token", COCALC_ORIGIN: "https://cocalc.test", COCALC_CLIENT_SECRET: "client-secret", PURGE_KEY: "purge-key", LIMITS_KEY: "limits-key" };
const objects = { SYNC_ACCOUNT: { className: "SyncAccount", useSQLite: true }, SYNC_DOC: { className: "SyncDoc", useSQLite: true } };
const ratelimits = (id) => ({ SYNC_PREAUTH: { namespace_id: id, simple: { limit: 100000, period: 60 } }, SYNC_FILES_LIMIT: { namespace_id: id + "1", simple: { limit: 100000, period: 60 } } });

// ---- a fake CoCalc: each account's plan
const plan = (enabled, max = 50_000) => ({ storage_bytes: 1 << 20, max_file_bytes: max, sync: { enabled, version_bytes: 1000, read_bytes_per_day: 1 << 20 } });
const plans = new Map([[OPEN, plan(true)], [NOSYNC, plan(false)], [LISTED, plan(true)], [SMALL, plan(true, 100)], [ROLL, plan(true)]]);
async function cocalc(req) {
  const u = new URL(req.url);
  if (u.pathname === "/api/v2/sagebrush/limits") {
    const who = u.searchParams.get("account_id");
    if (who === BADPLAN) return Response.json({ storage_bytes: "lots", sync: { enabled: true } });
    const l = plans.get(who);
    return l ? Response.json(l) : Response.json({ error: "no_account" }, { status: 404 });
  }
  return new Response("not found", { status: 404 });
}

/** One deployment: its Worker's own admission bindings, on `dir`'s storage (null: in memory). */
function deployment(name, bindings, dir = null) {
  return new Miniflare(convertV4MiniflareOptions({
    ...(dir ? { resourcePersistencePath: dir } : {}),
    workers: [{ ...base, name, bindings: { ...shareBindings, ...bindings }, durableObjects: objects, routes: [`${name}.test/*`], outboundService: cocalc, ratelimits: ratelimits(String(9000 + name.length)) }],
  }));
}
async function migrate(m, name) {
  const db = await m.getD1Database("SHARE_DB", name);
  const mig = join(here, "../share/migrations");
  for (const f of readdirSync(mig).filter((f) => f.endsWith(".sql")).sort())
    for (const q of readFileSync(join(mig, f), "utf8").replace(/--.*$/gm, "").split(";").map((q) => q.trim()).filter(Boolean)) await db.prepare(q).run();
}
/** The site as one account sees it: its session, and its status, enable, socket and blob calls. */
function client(m, name) {
  const origin = `https://${name}.test`;
  const go = (path, init = {}) => dispatch(m, origin + path, { redirect: "manual", ...init });
  return {
    origin,
    go,
    async signIn(account_id) {
      const r = await go("/auth/dev", { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ token: "dev-token", account_id }) });
      return r.headers.getSetCookie().map((c) => c.split(";")[0]).find((c) => c.startsWith("__Host-sb_session="));
    },
    async status(s) {
      const r = await go("/api/sync/v1/status", { headers: { ...(s ? { cookie: s } : {}), origin } });
      return { code: r.status, body: await r.json().catch(() => null) };
    },
    enable: async (s) => (await go("/api/sync/v1/enable", { method: "POST", headers: { cookie: s, origin, "content-type": "application/json" }, body: "{}" })).status,
    async check(s, blobs) {
      const r = await go("/api/sync/v1/blobs/check", { method: "POST", headers: { cookie: s, origin, "content-type": "application/json" }, body: JSON.stringify({ blobs }) });
      return { code: r.status, body: await r.json().catch(() => null) };
    },
    async socket(s) {
      const r = await go("/api/sync/v1/account", { headers: { cookie: s, origin, upgrade: "websocket" } });
      if (r.status !== 101) return { status: r.status };
      const ws = r.webSocket;
      ws.accept();
      const queue = [], waiting = [];
      ws.addEventListener("message", (e) => {
        const msg = JSON.parse(e.data);
        const w = waiting.findIndex((x) => x.match(msg));
        if (w >= 0) waiting.splice(w, 1)[0].resolve(msg);
        else queue.push(msg);
      });
      let req = 0;
      const sock = {
        status: 101,
        ws,
        next(match = () => true) {
          const i = queue.findIndex(match);
          if (i >= 0) return Promise.resolve(queue.splice(i, 1)[0]);
          return new Promise((resolve) => {
            const w = { match, resolve };
            waiting.push(w);
            setTimeout(() => { const j = waiting.indexOf(w); if (j >= 0) waiting.splice(j, 1), resolve(null); }, 3000);
          });
        },
        async ask(msg) { const r = ++req; ws.send(JSON.stringify({ ...msg, req: r })); return sock.next((x) => x.req === r); },
        async hello(device) {
          ws.send(JSON.stringify({ t: "hello", v: 2, device, name: "test", index_after: 0 }));
          const w = await sock.next((x) => x.t === "welcome" || x.t === "error");
          const ix = w?.t === "welcome" ? await sock.next((x) => x.t === "index") : null;
          return { welcome: w, index: ix };
        },
      };
      return sock;
    },
  };
}

// ---- admission: "all" admits every signed-in account, its plan deciding the rest; anything else, the lists
{
  const m = deployment("admitall", { SYNC_ADMIT: "all" });
  const n = deployment("admitother", { SYNC_ADMIT: "yes", SYNC_ACCOUNTS: LISTED });
  const u = deployment("admitunset", { SYNC_ACCOUNTS: LISTED });
  try {
    for (const [mm, nm] of [[m, "admitall"], [n, "admitother"], [u, "admitunset"]]) await migrate(mm, nm);
    const all = client(m, "admitall"), other = client(n, "admitother"), unset = client(u, "admitunset");
    const so = await all.signIn(OPEN);
    const st = await all.status(so);
    ok(st.code === 200 && st.body?.available !== false && st.body?.reason !== "not_allowlisted", "all: an account on no list, its plan with sync: available: " + JSON.stringify(st));
    ok((await all.enable(so)) === 200, "all: …and it turns sync on");
    const s = await all.socket(so);
    const h = s.status === 101 ? await s.hello("device-open-0001") : null;
    ok(h?.welcome?.t === "welcome", "all: …and its socket is welcomed: " + JSON.stringify(h?.welcome));
    const a = await s.ask({ t: "ops", ops: [{ dseq: 1, t: 1001, by: "person", op: "mkdir", path: "/A", kind: "folder" }] });
    ok(a?.t === "ack" && a.ops?.[0]?.seq === 1, "all: …and its ops are accepted: " + JSON.stringify(a));
    s.ws.close();
    // (the daily usage check's own queries on this D1, after this registration: counted, in register()'s unit)
    {
      const db = await m.getD1Database("SHARE_DB", "admitall");
      const api = { d1: async (_db, sql, params) => [{ results: [await db.prepare(sql).bind(...params).first()] }], workerDay: async () => ({ requests: 0, egressBytes: 0 }) };
      const f = await readFigures({ api, d1: "x", worker: "x" });
      const old = await readFigures({ api, d1: "x", worker: "x", now: Date.now() + 2 * 86_400_000 });
      ok(f.registrations >= 1 && old.registrations === 0 && f.storageBytes >= 0, "all: the usage check counts this day's registration (created in register()'s unit), and not two days on: " + JSON.stringify({ f, old }));
    }
    // (no session: refused before any account is asked)
    const anon = await all.status(null);
    ok(anon.code === 401, "all: a request that isn't signed in is still refused: " + anon.code);
    // (the plan decides: without sync, unreachable or not a plan, nothing is turned on)
    const sn = await all.signIn(NOSYNC);
    const stn = await all.status(sn);
    ok(stn.body?.available === false && stn.body?.reason === "plan_has_no_sync" && (await all.enable(sn)) === 403, "all: a plan without sync: plan_has_no_sync, and enable refused: " + JSON.stringify(stn.body));
    const sp = await all.signIn(NOPLAN);
    const stp = await all.status(sp);
    ok(stp.body?.available === false && (await all.enable(sp)) !== 200, "all: CoCalc with no plan for the account: not available, enable refused: " + JSON.stringify(stp.body));
    const sb = await all.signIn(BADPLAN);
    const stb = await all.status(sb);
    ok(stb.body?.available === false && (await all.enable(sb)) !== 200, "all: an answer that isn't a plan: not available, enable refused (fail-closed): " + JSON.stringify(stb.body));
    // (the plan's limits as for any account: a file over its maximum refused)
    const ss = await all.signIn(SMALL);
    ok((await all.enable(ss)) === 200, "all: a small plan's account turns sync on");
    const bytes = Buffer.from("x".repeat(500)), sha = createHash("sha256").update(bytes).digest("hex");
    const put = await all.go(`/api/sync/v1/blob/${sha}`, { method: "PUT", headers: { cookie: ss, origin: all.origin, "content-type": "application/octet-stream" }, body: bytes });
    const pb = await put.json().catch(() => null);
    ok(put.status >= 400 && /too large/.test(JSON.stringify(pb)), "all: a file over the plan's maximum (100 bytes) refused at its upload: " + JSON.stringify({ status: put.status, body: pb }));
    // (any other value, or none: only the lists)
    for (const [c, label] of [[other, "SYNC_ADMIT \"yes\""], [unset, "SYNC_ADMIT unset"]]) {
      const x = await c.signIn(OPEN);
      const sx = await c.status(x);
      ok(sx.body?.available === false && sx.body?.reason === "not_allowlisted" && (await c.enable(x)) === 403, `${label}: an account on no list: not_allowlisted, enable 403: ` + JSON.stringify(sx.body));
      const l = await c.signIn(LISTED);
      ok((await c.enable(l)) === 200, `${label}: a listed account syncs as before`);
    }
  } finally {
    await Promise.all([m.dispose(), n.dispose(), u.dispose()]);
  }
}

// ---- the rollback: the same storage under a deployment with SYNC_ADMIT unbound, then bound again
{
  const dir = join(process.env.TMPDIR || "/tmp", "sync-admit-" + process.pid);
  let m = deployment("roll", { SYNC_ADMIT: "all" }, dir);
  try {
    await migrate(m, "roll");
    let c = client(m, "roll");
    let s = await c.signIn(ROLL);
    ok((await c.enable(s)) === 200, "rollback: on under \"all\"");
    let sock = await c.socket(s);
    await sock.hello("device-roll-0001");
    const a = await sock.ask({ t: "ops", ops: [{ dseq: 1, t: 1001, by: "person", op: "mkdir", path: "/kept", kind: "folder" }] });
    ok(a?.t === "ack" && a.ops?.[0]?.seq === 1, "rollback: an op accepted before it");
    sock.ws.close();
    await m.dispose();
    // (unbound: what a deploy without it is; the same storage)
    m = deployment("roll", {}, dir);
    c = client(m, "roll");
    s = await c.signIn(ROLL);
    const st = await c.status(s);
    ok(st.body?.available === false && st.body?.reason === "not_allowlisted", "rollback: unbound: the status says not admitted: " + JSON.stringify(st.body));
    ok((await c.enable(s)) === 403, "rollback: unbound: enable refused");
    sock = await c.socket(s);
    const h = sock.status === 101 ? await sock.hello("device-roll-0001") : { welcome: { t: "refused", status: sock.status } };
    ok(h.welcome?.t !== "welcome", "rollback: unbound: the account's socket isn't welcomed: " + JSON.stringify(h.welcome));
    if (sock.status === 101) {
      const b = await sock.ask({ t: "ops", ops: [{ dseq: 2, t: 1002, by: "person", op: "mkdir", path: "/after", kind: "folder" }] });
      ok(b?.t !== "ack", "rollback: unbound: an op sent on that socket anyway is refused: " + JSON.stringify(b));
      sock.ws.close();
    }
    const up = await c.check(s, [{ sha256: "0".repeat(64), size: 10 }]);
    ok(up.code === 403, "rollback: unbound: uploads refused: " + up.code);
    await m.dispose();
    // (bound again: the same account goes on from what it had: its op kept, nothing lost or redone)
    m = deployment("roll", { SYNC_ADMIT: "all" }, dir);
    c = client(m, "roll");
    s = await c.signIn(ROLL);
    ok((await c.status(s)).body?.available !== false, "rollback: bound again: available");
    sock = await c.socket(s);
    const h2 = await sock.hello("device-roll-0001");
    ok(h2.welcome?.t === "welcome" && h2.welcome.next_dseq === 2 && h2.index?.ops?.some((o) => o.path === "/kept") && !h2.index.ops.some((o) => o.path === "/after"), "rollback: bound again: its op kept (next dseq 2, /kept in its index), nothing from the unbound time: " + JSON.stringify({ next: h2.welcome?.next_dseq, ops: h2.index?.ops?.map((o) => o.path) }));
    sock.ws.close();
  } finally {
    await m.dispose().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(failures ? `FAIL: ${failures} of ${count} checks` : `ok: sync's admission and its rollback, ${count} checks`);
process.exit(failures ? 1 : 0);
