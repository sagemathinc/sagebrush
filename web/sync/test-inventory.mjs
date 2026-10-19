// The daily inventory's bounds (web/sync/server.ts syncScheduled, LIMIT-268-1 and
// LIMIT-SYNC-CRON-1), against a counted stand-in for D1, R2 and the account objects:
// the call budget with the production constants, and the whole run's deadline.
// Run: bun web/sync/test-inventory.mjs
import { syncScheduled } from "./server.ts";

let checks = 0;
const fails = [];
const ok = (cond, what) => {
  checks++;
  if (!cond) {
    fails.push(what);
    console.log("FAIL " + what);
  }
};
const never = () => new Promise(() => {});
const OLD = new Date(Date.now() - 30 * 86400_000);

/**
 * A stand-in deployment: `pages` R2 pages of objects, each of whose `live` objects belongs to a
 * live account (its own prefix, its own row), the rest to nobody.  Every operation it answers is
 * counted, independently of the run's own count.  `hang` names operations that never answer.
 */
function fixture({ pages, prunes = 0, hang = new Set() }) {
  let ops = 0;
  const log = [];
  const cursor = { v: "" };
  const pageOf = (n) => pages[n].map((live, i) => ({ key: `s/${(n * 1000 + i).toString(16).padStart(32, "0")}/${"a".repeat(36)}`, uploaded: OLD, live }));
  const op = (name, answer) => {
    ops++;
    log.push(name);
    return hang.has(name) ? never() : Promise.resolve(answer());
  };
  const db = {
    prepare(sql) {
      let args = [];
      const stmt = {
        bind: (...a) => ((args = a), stmt),
        run: () =>
          sql.startsWith("DELETE FROM sync_admin_requests")
            ? op("prune", () => ({ meta: { changes: prunes-- > 0 ? 1000 : 0 } }))
            : op("cursor-write", () => ((cursor.v = args[0]), { meta: { changes: 1 } })),
        first: () => op("cursor-read", () => (cursor.v ? { v: cursor.v } : null)),
        all: () =>
          op("lookup", () => {
            const prefixes = new Set(JSON.parse(args[0]));
            const rows = [];
            for (let n = 0; n < pages.length; n++) for (const o of pageOf(n)) if (o.live && prefixes.has(o.key.split("/")[1])) rows.push({ account_hash: "h" + o.key.split("/")[1], prefix: o.key.split("/")[1], state: "active" });
            return { results: rows };
          }),
      };
      return stmt;
    },
  };
  const bucket = {
    list: ({ cursor: c }) =>
      op("list", () => {
        const n = c ? Number(c) : 0;
        return { objects: pageOf(n), truncated: n + 1 < pages.length, cursor: String(n + 1) };
      }),
    delete: (keys) => op("delete", () => keys.length),
  };
  const account = {
    idFromName: (name) => name,
    get: () => ({ knownKeys: () => op("knownKeys", () => ({ known: [], statements: 1 })) }),
  };
  return { env: { SHARE_DB: db, SHARE_BUCKET: bucket, SYNC_ACCOUNT: account }, ops: () => ops, log, cursor };
}

// ---- the call budget, with the production constants (astra's schedule on e062ef02): 20 prune
// statements, then full pages of 100 objects with 100, 100, 61 and 100 live accounts.  Pages cost
// 105, 105 and 66, 296 in all; a fourth page could cost 105 more, 401 > 400, so it is not begun
{
  const full = (live) => Array.from({ length: 100 }, (_, i) => i < live);
  const f = fixture({ pages: [full(100), full(100), full(61), full(100)], prunes: 20 });
  const r = await syncScheduled(f.env);
  ok(r.calls === f.ops(), `the run counts every call it makes, the cursor writes too: ${r.calls} counted, ${f.ops()} made`);
  ok(r.calls === 296 && r.pages === 3 && r.pruned === 20_000, `20 prune statements and pages of 105, 105 and 66 calls, 296 in all: ${JSON.stringify(r)}`);
  ok(f.cursor.v === "3", "and the fourth page, which could take it to 401, over 400, is left for the next run (its cursor saved)");
  ok(f.log.filter((x) => x === "cursor-write").length === 3, "one cursor write a page done");
}

// ---- the whole run's deadline (test mode, so the deadline can be short): a call that never
// answers ends the run at the deadline, whichever call it is, and the run stops where it is safe
globalThis.__SAGEBRUSH_SYNC_TEST__ = true;
const page = [true, false, false];
for (const [hung, expect] of [
  ["prune", "no page begins"],
  ["cursor-read", "no page is listed"],
  ["list", "nothing is deleted"],
  ["lookup", "nothing is deleted"],
  ["knownKeys", "nothing of the page is deleted, and its cursor is unmoved"],
  ["delete", "the cursor is unmoved"],
  ["cursor-write", "the page is not counted done"],
]) {
  const f = fixture({ pages: [page, page], hang: new Set([hung]) });
  const env = { ...f.env, SYNC_TEST_PIN_MS: "1000" };
  const t0 = Date.now();
  const r = await syncScheduled(env, { deadlineMs: 300 });
  const ms = Date.now() - t0;
  const after = f.log.slice(f.log.indexOf(hung) + 1);
  ok(r.stopped && ms >= 290 && ms < 1500 && after.length === 0 && r.calls === f.ops(), `a ${hung} that never answers ends the run at its deadline (${ms} ms), with no call after it and every call counted: ${JSON.stringify(r)}`);
  if (hung !== "delete" && hung !== "cursor-write") ok(!f.log.includes("delete"), `(${hung}) ${expect}`);
  if (hung !== "cursor-write") ok(f.cursor.v === "", `(${hung}) the cursor is unmoved`);
  ok(r.pages === 0, `(${hung}) no page is counted done`);
}
// and past the deadline no call starts at all
{
  const f = fixture({ pages: [page] });
  const r = await syncScheduled({ ...f.env, SYNC_TEST_PIN_MS: "1000" }, { deadlineMs: 0 });
  ok(r.stopped && r.calls === 0 && f.ops() === 0, `a run whose deadline has passed makes no call: ${JSON.stringify(r)}`);
}

console.log(`${checks - fails.length}/${checks} passed`);
if (fails.length) process.exit(1);
