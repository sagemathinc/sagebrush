// The tool under workerd (Miniflare) inside the lti-vmtest Docker network on
// VM 2 (plan-lti-r5 §12): ENV=vm-test, reached only through Caddy as
// https://lti.vmtest.  Its outbound fetches go through Node's fetch, which
// trusts the test CA via NODE_EXTRA_CA_CERTS (inside this container only).
import { readFileSync, readdirSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

const here = "/tool";
const script = readFileSync(join(here, "worker.js"), "utf8");
mkdirSync("/data", { recursive: true });
const mf = new Miniflare(convertV4MiniflareOptions({
  host: "0.0.0.0",
  port: 8787,
  // (Miniflare 5's one persistence root: D1 and Durable Objects survive a restart of this container)
  resourcePersistencePath: "/data",
  workers: [{
    name: "lti", modules: true, script, compatibilityDate: "2026-10-01",
    bindings: {
      ENV: "vm-test", LTI_ORIGIN: "https://lti.vmtest", LTI_KEY: process.env.LTI_KEY, LTI_SYNTHETIC_ENTITLEMENT: "1",
      MAPPING_BACKUP_KEY: process.env.MAPPING_BACKUP_KEY, COCALC_ORIGIN: "https://cocalc.vmtest",
    },
    d1Databases: ["LTI_DB", "LTI_AUDIT"],
    durableObjects: { LTI_REG: { className: "LtiReg", useSQLite: true }, LTI_SHARD: { className: "LtiLaunchShard", useSQLite: true }, LTI_COURSE: { className: "LtiCourse", useSQLite: true } },
    ratelimits: { LTI_PREAUTH: { namespace_id: "3001", simple: { limit: 600, period: 60 } } },
    // (Miniflare hands over its own Request; rebuild it for Node's fetch, keeping redirects manual for trustedFetch)
    outboundService: async (req) => {
      const body = req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer();
      const r = await fetch(req.url, { method: req.method, headers: Object.fromEntries(req.headers), body, redirect: "manual" });
      return new Response(r.body, { status: r.status, headers: r.headers });
    },
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
async function migrate(name, dir) {
  const db = await mf.getD1Database(name, "lti");
  await db.prepare("CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY)").run();
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    if (await db.prepare("SELECT 1 FROM _migrations WHERE name = ?").bind(f).first()) continue;
    for (const s of splitSql(readFileSync(join(dir, f), "utf8"))) await db.prepare(s).run();
    await db.prepare("INSERT INTO _migrations (name) VALUES (?)").bind(f).run();
  }
}
await migrate("LTI_DB", join(here, "migrations"));
await migrate("LTI_AUDIT", join(here, "migrations", "audit"));
await mf.ready;
console.log("lti tool listening on :8787 (container-internal)");
