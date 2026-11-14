// The daily check of sync's aggregate use while every CoCalc account may sync (SYNC_ADMIT "all";
// notes/sync-for-all-accounts.md): four figures against their thresholds, from the deployment's own records.
// - storage: the sync accounts' claims, SUM(claim_bytes) of the active rows of D1's sync_accounts. Each account object
//   raises its claim before it takes bytes and gives it back after, so the sum bounds sync's storage from above, sync's
//   alone (the R2 bucket is shared with sharing, so its size isn't used).
// - registrations: sync_accounts rows created in the last 24 hours (exact; Durable Object counts include documents).
// - requests and egress: the sync Worker's last 24 hours, from Cloudflare's Workers analytics (GraphQL).
// Prints one JSON line; exit 0 within every threshold, 2 over any (the alert: @sagebrush closes admission by
// unbinding SYNC_ADMIT), 1 if a figure couldn't be read (never taken as within).
//
//   CLOUDFLARE_ACCOUNT_ID=… CLOUDFLARE_API_TOKEN=… SYNC_D1_ID=… SYNC_WORKER=… node scripts/sync-usage-check.mjs [--baseline-bytes N]
// The token is read from the environment only, never printed or written.

/** The thresholds (plan r2): storage over the baseline at activation, per day otherwise. */
export const THRESHOLDS = { storageGrowthBytes: 100 * 2 ** 30, registrationsPerDay: 500, egressBytesPerDay: 200 * 2 ** 30, requestsPerDay: 5_000_000 };

/** The four figures, read through `api` (Cloudflare's REST and GraphQL, given). */
export async function readFigures({ api, d1, worker, now = Date.now() }) {
  const day = now - 86_400_000;
  const q = async (sql, params) => {
    const r = await api.d1(d1, sql, params);
    const row = r?.[0]?.results?.[0];
    if (!row) throw new Error("D1 gave no row");
    return row;
  };
  const storage = Number((await q("SELECT COALESCE(SUM(claim_bytes), 0) AS n FROM sync_accounts WHERE state = 'active'", [])).n);
  const registrations = Number((await q("SELECT COUNT(*) AS n FROM sync_accounts WHERE created >= ?", [day])).n);
  const w = await api.workerDay(worker, new Date(day).toISOString(), new Date(now).toISOString());
  const figures = { storageBytes: storage, registrations, requests: Number(w.requests), egressBytes: Number(w.egressBytes) };
  for (const [k, v] of Object.entries(figures)) if (!Number.isFinite(v) || v < 0) throw new Error(`${k} unreadable`);
  return figures;
}

/** Which thresholds `f` passes, given the storage at activation. */
export function overs(f, baselineBytes = 0, t = THRESHOLDS) {
  const out = [];
  if (f.storageBytes - baselineBytes > t.storageGrowthBytes) out.push("storage");
  if (f.registrations > t.registrationsPerDay) out.push("registrations");
  if (f.egressBytes > t.egressBytesPerDay) out.push("egress");
  if (f.requests > t.requestsPerDay) out.push("requests");
  return out;
}

/** Cloudflare's API, with the token from the environment. */
export function cloudflare({ account, token, fetchFn = fetch }) {
  const h = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  return {
    async d1(db, sql, params) {
      const r = await fetchFn(`https://api.cloudflare.com/client/v4/accounts/${account}/d1/database/${db}/query`, { method: "POST", headers: h, body: JSON.stringify({ sql, params }) });
      const j = await r.json();
      if (!r.ok || !j.success) throw new Error(`D1 query: ${r.status}`);
      return j.result;
    },
    async workerDay(script, from, to) {
      const query = `query($a: String!, $s: String!, $f: Time!, $t: Time!) { viewer { accounts(filter: { accountTag: $a }) {
        workersInvocationsAdaptive(limit: 10000, filter: { scriptName: $s, datetime_geq: $f, datetime_leq: $t }) { sum { requests responseBodySize } } } } }`;
      const r = await fetchFn("https://api.cloudflare.com/client/v4/graphql", { method: "POST", headers: h, body: JSON.stringify({ query, variables: { a: account, s: script, f: from, t: to } }) });
      const j = await r.json();
      const rows = j?.data?.viewer?.accounts?.[0]?.workersInvocationsAdaptive;
      if (!r.ok || !Array.isArray(rows)) throw new Error(`Workers analytics: ${r.status}`);
      return rows.reduce((a, x) => ({ requests: a.requests + Number(x.sum?.requests ?? 0), egressBytes: a.egressBytes + Number(x.sum?.responseBodySize ?? 0) }), { requests: 0, egressBytes: 0 });
    },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const env = process.env, at = process.argv.indexOf("--baseline-bytes");
  const baseline = at > 0 ? Number(process.argv[at + 1]) : 0;
  const need = ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN", "SYNC_D1_ID", "SYNC_WORKER"].filter((k) => !env[k]);
  if (need.length) {
    console.error("sync-usage-check: missing " + need.join(", "));
    process.exit(1);
  }
  try {
    const api = cloudflare({ account: env.CLOUDFLARE_ACCOUNT_ID, token: env.CLOUDFLARE_API_TOKEN });
    const f = await readFigures({ api, d1: env.SYNC_D1_ID, worker: env.SYNC_WORKER });
    const o = overs(f, baseline);
    console.log(JSON.stringify({ at: new Date().toISOString(), ...f, baselineBytes: baseline, over: o }));
    process.exit(o.length ? 2 : 0);
  } catch (e) {
    console.log(JSON.stringify({ at: new Date().toISOString(), error: String(e?.message ?? e) }));
    process.exit(1);
  }
}
