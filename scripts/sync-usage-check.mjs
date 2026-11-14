// The daily check of sync's aggregate use while every CoCalc account may sync (SYNC_ADMIT "all";
// notes/sync-for-all-accounts.md): four figures against their thresholds, from the deployment's own records.
// - storage: the sync accounts' claims, SUM(claim_bytes) of every row of D1's sync_accounts not yet purged (active, and
//   deleting: a delete keeps its claim until its purge is confirmed). Each account object raises its claim before it
//   takes bytes and gives it back after, so the sum bounds sync's storage from above, sync's alone (the R2 bucket is
//   shared with sharing, so its size isn't used).
// - registrations: sync_accounts rows created in the last 24 hours (Durable Object counts include documents). A re-enable
//   after a purge keeps its row's first `created`, so it isn't counted again: new accounts, not enables.
// - requests and egress: the sync Worker's last 24 hours, from Cloudflare's Workers analytics (GraphQL): lower bounds,
//   since a WebSocket's frames after its upgrade, and bytes read straight from R2 by signed URL, aren't in them.
// Prints one JSON line; exit 0 within every threshold, 2 over any (the alert, not a cap: a person responds, closing
// admission by unbinding SYNC_ADMIT if needed), 1 if a figure couldn't be read (never taken as within).
//
//   CLOUDFLARE_ACCOUNT_ID=… CLOUDFLARE_API_TOKEN=… SYNC_D1_ID=… SYNC_WORKER=… node scripts/sync-usage-check.mjs [--baseline-bytes N]
// The token is read from the environment only, never printed or written.

/** The pilot's alert thresholds, approved Nov 14 2026: an ALERT, not a cap (nothing is refused by them; a person
 * responds, closing admission by unbinding SYNC_ADMIT if needed). Storage: the sync claims more than 100 GiB above their
 * total at activation (--baseline-bytes; near zero then); per day: new accounts, egress and requests. */
export const THRESHOLDS = { storageGrowthBytes: 100 * 2 ** 30, registrationsPerDay: 500, egressBytesPerDay: 200 * 2 ** 30, requestsPerDay: 5_000_000 };

/** A figure as read: a finite non-negative number, or it isn't one (null, missing, text, NaN: never taken as 0). */
export function figure(v, what) {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) throw new Error(`${what} unreadable: ${JSON.stringify(v)}`);
  return v;
}
/** At most this long for the whole check, its requests and their bodies read. */
export const DEADLINE_MS = 60_000;

/** The four figures, read through `api` (Cloudflare's REST and GraphQL, given). */
export async function readFigures({ api, d1, worker, now = Date.now() }) {
  const day = now - 86_400_000;
  const q = async (sql, params) => {
    const r = await api.d1(d1, sql, params);
    const row = r?.[0]?.results?.[0];
    if (!row) throw new Error("D1 gave no row");
    return row;
  };
  const storage = figure((await q("SELECT COALESCE(SUM(claim_bytes), 0) AS n FROM sync_accounts WHERE state <> 'purged'", [])).n, "storage");
  // (sync_accounts.created is in seconds, as register() writes it)
  const registrations = figure((await q("SELECT COUNT(*) AS n FROM sync_accounts WHERE created >= ?", [Math.floor(day / 1000)])).n, "registrations");
  const w = await api.workerDay(worker, new Date(day).toISOString(), new Date(now).toISOString());
  return { storageBytes: storage, registrations, requests: figure(w.requests, "requests"), egressBytes: figure(w.egressBytes, "egress") };
}

/** Which thresholds `f` passes, given the storage at activation. */
export function overs(f, baselineBytes = 0, t = THRESHOLDS) {
  figure(baselineBytes, "baseline");
  const out = [];
  if (f.storageBytes - baselineBytes > t.storageGrowthBytes) out.push("storage");
  if (f.registrations > t.registrationsPerDay) out.push("registrations");
  if (f.egressBytes > t.egressBytesPerDay) out.push("egress");
  if (f.requests > t.requestsPerDay) out.push("requests");
  return out;
}

/** Cloudflare's API, with the token from the environment. */
export function cloudflare({ account, token, fetchFn = fetch, signal }) {
  const h = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  return {
    async d1(db, sql, params) {
      const r = await fetchFn(`https://api.cloudflare.com/client/v4/accounts/${account}/d1/database/${db}/query`, { method: "POST", headers: h, body: JSON.stringify({ sql, params }), signal });
      const j = await r.json();
      if (!r.ok || !j.success) throw new Error(`D1 query: ${r.status}`);
      return j.result;
    },
    async workerDay(script, from, to) {
      const query = `query($a: String!, $s: String!, $f: Time!, $t: Time!) { viewer { accounts(filter: { accountTag: $a }) {
        workersInvocationsAdaptive(limit: 10000, filter: { scriptName: $s, datetime_geq: $f, datetime_leq: $t }) { sum { requests responseBodySize } } } } }`;
      const r = await fetchFn("https://api.cloudflare.com/client/v4/graphql", { method: "POST", headers: h, body: JSON.stringify({ query, variables: { a: account, s: script, f: from, t: to } }), signal });
      const j = await r.json();
      // (any error, even beside partial data, makes the answer unreadable)
      if (!r.ok || (Array.isArray(j?.errors) && j.errors.length) || j?.errors) throw new Error(`Workers analytics: ${r.status}${j?.errors ? " errors" : ""}`);
      const rows = j?.data?.viewer?.accounts?.[0]?.workersInvocationsAdaptive;
      if (!Array.isArray(rows)) throw new Error("Workers analytics: no rows");
      return rows.reduce((a, x) => ({ requests: a.requests + figure(x?.sum?.requests, "requests"), egressBytes: a.egressBytes + figure(x?.sum?.responseBodySize, "egress") }), { requests: 0, egressBytes: 0 });
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
  // (one deadline over everything: the requests and their bodies; a hang ends as unreadable)
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error("deadline")), DEADLINE_MS);
  try {
    const api = cloudflare({ account: env.CLOUDFLARE_ACCOUNT_ID, token: env.CLOUDFLARE_API_TOKEN, signal: ac.signal });
    const f = await Promise.race([readFigures({ api, d1: env.SYNC_D1_ID, worker: env.SYNC_WORKER }), new Promise((_, no) => ac.signal.addEventListener("abort", () => no(new Error("deadline")), { once: true }))]);
    const o = overs(f, baseline);
    clearTimeout(timer);
    console.log(JSON.stringify({ at: new Date().toISOString(), ...f, baselineBytes: baseline, over: o }));
    process.exit(o.length ? 2 : 0);
  } catch (e) {
    clearTimeout(timer);
    console.log(JSON.stringify({ at: new Date().toISOString(), error: String(e?.message ?? e) }));
    process.exit(1);
  }
}
