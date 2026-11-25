// The content wake (plan-lti-r5 amendment 3 r15 §2.4, §2.5; A3-2 delta D1,
// D2): one worker per environment every 10 minutes, under its gate ticket and
// the `sweep_lease` row.  Sweep pages finish the bundle state machine in the
// durable `due` order; scan pages walk R2 from a saved cursor and delete
// orphans (normal mode: only objects older than 24 h; recovery mode: every
// object without a row, and every found, non-suspect token marked seen).
// Every R2 delete is announced to the gate first (a delete intent) and
// resolved after its success.  Every D1 write goes through the gate; reads use
// the read wrapper.  Each wake counts its D1 calls, statements, rows and R2
// calls against §2.5's table and stops starting pages at 250 statements.

import { bundleKey } from "./bundle.ts";
import { contentRead, gateOf, type ContentEnv } from "./content.ts";
import type { Stmt } from "./gate.ts";
import { testGate } from "./util.ts";

const D1_NOW = "CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)";
const WAKE_MS = 5 * 60_000;
/** No page starts with less than this left of the ticket or the lease. */
const PAGE_MARGIN_MS = 60_000;
const SWEEP_PAGE = 100;
const SCAN_PAGE = 1000;
/** Pages per wake: normal 10 + 10; recovery 10 + 40 (§2.5). */
const SWEEP_PAGES = 10;
const SCAN_PAGES = { normal: 10, recovery: 40 };
/** The scan's age gate in normal mode: an object younger than this may be an upload in flight. */
const ORPHAN_AGE_MS = 24 * 3600_000;
/** Every invocation stops starting pages at this many statements (D1's limit is 1,000). */
const STATEMENT_STOP = 250;
/** A sweep page is ≤ 1 select + a batch of ≤ 4; a scan page ≤ 1 lookup + a batch of ≤ 5 (a one-wake recovery cycle). */
const SWEEP_PAGE_STATEMENTS = 5;
const SCAN_PAGE_STATEMENTS = 6;
const TRIES_ALERT = 24;

type WakeEnv = ContentEnv & { LTI_BUNDLES?: R2Bucket };

export interface WakeStats {
  outcome: string;
  mode: "normal" | "recovery" | null;
  recovery_id: number;
  d1_calls: number;
  statements: number;
  rows_read: number;
  rows_written: number;
  r2_calls: number;
  keys_listed: number;
  keys_deleted: number;
  sweep_pages: number;
  scan_pages: number;
  first: boolean;
  final: boolean;
  /**
   * Each page's own counts, for the per-page bounds; whether the page made its fenced write, and that write's own chain
   * statement's rows (the gate_calls insert, with its keep trigger's prune: D3 r2).
   */
  pages: { kind: "sweep" | "scan"; statements: number; rows_read: number; rows_written: number; r2_calls: number; rows: number; wrote: boolean; chain_read: number; chain_written: number }[];
  /** The lease call's rows, and its chain statement's (D3 r2). */
  lease: { rows_read: number; rows_written: number; chain_read: number; chain_written: number } | null;
}

export interface WakeOptions {
  /** Tests: the wake's time budget, in place of the ticket's 5 min. */
  budgetMs?: number;
  /** Tests: the normal-mode age gate, compressed. */
  orphanAgeMs?: number;
  /** Tests: a failing R2 delete (the page's one bit), for the next n delete calls. */
  failDeletes?: number;
  /** Tests: a delete that lands but whose answer is lost (a local timeout before its success), for the next n calls. */
  deleteThenFail?: number;
  /** Tests: stop after this many pages of each kind. */
  maxSweepPages?: number;
  maxScanPages?: number;
}

const tokenOf = (key: string): string | null => /^o\/[0-9a-f]{32}\/[0-9a-f]{64}\/([0-9a-f]{32})$/.exec(key)?.[1] ?? null;
const rowsWritten = (m: { rows_written?: number } | undefined) => Number(m?.rows_written ?? 0);
const rowsRead = (m: { rows_read?: number } | undefined) => Number(m?.rows_read ?? 0);

export async function contentWake(env: WakeEnv, opts: WakeOptions = {}): Promise<WakeStats> {
  const st: WakeStats = { outcome: "", mode: null, recovery_id: 0, d1_calls: 0, statements: 0, rows_read: 0, rows_written: 0, r2_calls: 0, keys_listed: 0, keys_deleted: 0, sweep_pages: 0, scan_pages: 0, first: false, final: false, pages: [], lease: null };
  if (!env.LTI_CONTENT || !env.LTI_GATE || !env.LTI_BUNDLES) return { ...st, outcome: "not_configured" };
  const bucket = env.LTI_BUNDLES;
  const gate = gateOf(env);
  const read = contentRead(env);
  const started = Date.now();
  const t = await gate.issue("wake", null);
  if (!t.ok) return { ...st, outcome: t.code };
  let failDeletes = opts.failDeletes ?? 0, deleteThenFail = opts.deleteThenFail ?? 0;
  try {
    const rs = await gate.recoveryState();
    const recovery = rs.mode === "recovering";
    st.mode = recovery ? "recovery" : "normal";
    st.recovery_id = rs.recovery_id;
    // (the suspect tokens, in memory only: never marked seen, §2.5 step 4; the gate sends tokens, not keys)
    const suspect = new Set(rs.suspect);
    // the lease (A3-2 delta D1): fenced, on the chain; it also answers the scan row
    const lease = await gate.write(t.id, [{ sql: `UPDATE sweep_lease SET until = ${D1_NOW} + ${WAKE_MS} WHERE one = 1 AND until < ${D1_NOW} RETURNING (SELECT cursor FROM scan WHERE one = 1) AS cursor, (SELECT cycle FROM scan WHERE one = 1) AS cycle, (SELECT recovery FROM scan WHERE one = 1) AS recovery` }]);
    st.d1_calls++;
    st.statements += 2;
    if (!lease.ok) return { ...st, outcome: `lease_${lease.code}` };
    st.rows_written += rowsWritten(lease.chain) + rowsWritten(lease.results[0].meta);
    st.rows_read += rowsRead(lease.chain) + rowsRead(lease.results[0].meta);
    st.lease = { rows_read: rowsRead(lease.chain) + rowsRead(lease.results[0].meta), rows_written: rowsWritten(lease.chain) + rowsWritten(lease.results[0].meta), chain_read: rowsRead(lease.chain), chain_written: rowsWritten(lease.chain) };
    const scanRow = lease.results[0].results[0] as { cursor: string; cycle: number; recovery: number } | undefined;
    if (lease.results[0].meta.changes !== 1 || !scanRow) return { ...st, outcome: "lease_taken" };
    const budget = opts.budgetMs ?? WAKE_MS;
    const timeLeft = () => started + budget - Date.now();
    const room = (n: number) => timeLeft() >= PAGE_MARGIN_MS && st.statements + n <= STATEMENT_STOP;
    // (the current page's fenced write, if it made one: its chain statement's rows)
    let pageChain: { read: number; written: number } | null = null;
    const write = async (stmts: Stmt[]) => {
      const r = await gate.write(t.id, stmts);
      st.d1_calls++;
      st.statements += 1 + stmts.length;
      pageChain = { read: r.ok ? rowsRead(r.chain) : 0, written: r.ok ? rowsWritten(r.chain) : 0 };
      if (r.ok) {
        st.rows_written += rowsWritten(r.chain) + r.results.reduce((a, x) => a + rowsWritten(x.meta), 0);
        st.rows_read += rowsRead(r.chain) + r.results.reduce((a, x) => a + rowsRead(x.meta), 0);
      }
      return r;
    };
    // One delete call, under an intent; true only when the call succeeded (then the intent is resolved).
    const deleteKeys = async (keys: string[], where: "sweep" | "scan"): Promise<"ok" | "failed" | "refused"> => {
      const it = await gate.intent(t.id, keys);
      if (!it.ok) {
        console.log("ALERT lti wake: delete intent refused; no delete issued", JSON.stringify({ code: it.code, keys: keys.length }));
        return "refused";
      }
      await testGate(`${where}_before_delete`);
      st.r2_calls++;
      try {
        if (failDeletes > 0) {
          failDeletes--;
          throw new Error("injected R2 delete failure");
        }
        await bucket.delete(keys);
        if (deleteThenFail > 0) {
          deleteThenFail--;
          throw new Error("injected: the delete landed, its answer lost");
        }
      } catch {
        // (unresolved: its keys stay suspect until an operator closes it after a HEAD of each)
        return "failed";
      }
      await testGate("wake_before_resolve");
      await gate.resolveIntent(it.id);
      st.keys_deleted += keys.length;
      return "ok";
    };

    // ---- sweep pages: the durable due order is the cursor (§2.5)
    for (let page = 0; page < Math.min(SWEEP_PAGES, opts.maxSweepPages ?? SWEEP_PAGES) && room(SWEEP_PAGE_STATEMENTS); page++) {
      const p0 = { s: st.statements, r: st.rows_read, w: st.rows_written, c: st.r2_calls };
      pageChain = null;
      const sel = await read.allMeta<{ owner_ref: string; sha: string; token: string; state: string; refs: number; tries: number }>(
        `SELECT owner_ref, sha, token, state, refs, tries FROM bundles WHERE due IS NOT NULL AND due <= ${D1_NOW} ORDER BY due LIMIT ${SWEEP_PAGE}`,
      );
      st.d1_calls++;
      st.statements++;
      st.rows_read += sel.rows_read;
      const rows = sel.results;
      if (!rows.length) break;
      const H = rows.filter((r) => r.state === "held" && r.refs === 0).map((r) => r.token);
      const V = rows.filter((r) => r.state === "reserved");
      const L = rows.filter((r) => r.state === "releasing");
      const VL = [...V, ...L];
      const stmts: Stmt[] = [];
      if (H.length) stmts.push({ sql: `UPDATE bundles SET state = 'releasing', due = ${D1_NOW} WHERE token IN (SELECT value FROM json_each(?)) AND state = 'held' AND refs = 0`, params: [JSON.stringify(H)] });
      let stop = false;
      if (VL.length) {
        const keys = await Promise.all(VL.map((r) => bundleKey(r.owner_ref, r.sha, r.token)));
        const d = await deleteKeys(keys, "sweep");
        if (d === "refused") stop = true;
        else if (d === "ok") {
          if (V.length) stmts.push({ sql: `DELETE FROM bundles WHERE token IN (SELECT value FROM json_each(?)) AND state = 'reserved' AND deadline + 3600000 <= ${D1_NOW}`, params: [JSON.stringify(V.map((r) => r.token))] });
          if (L.length) stmts.push({ sql: "DELETE FROM bundles WHERE token IN (SELECT value FROM json_each(?)) AND state = 'releasing'", params: [JSON.stringify(L.map((r) => r.token))] });
        } else {
          // (a failed page moves its rows to a later due: 2^tries min, at most 1 h; never given up, the charge kept)
          stmts.push({ sql: `UPDATE bundles SET tries = tries + 1, due = ${D1_NOW} + (CASE WHEN tries >= 6 THEN 3600000 ELSE MIN(3600000, 60000 << tries) END) WHERE token IN (SELECT value FROM json_each(?)) AND state IN ('reserved', 'releasing')`, params: [JSON.stringify(VL.map((r) => r.token))] });
          const worst = Math.max(...VL.map((r) => r.tries + 1));
          if (worst > TRIES_ALERT) console.log("ALERT lti wake: a bundle's R2 delete has failed more than 24 times", JSON.stringify({ tries: worst }));
        }
      }
      await testGate("wake_sweep_batch");
      if (stmts.length) {
        const w = await write(stmts);
        if (!w.ok) stop = true;
      }
      st.sweep_pages++;
      st.pages.push({ kind: "sweep", statements: st.statements - p0.s, rows_read: st.rows_read - p0.r, rows_written: st.rows_written - p0.w, r2_calls: st.r2_calls - p0.c, rows: rows.length, wrote: pageChain !== null, chain_read: pageChain?.read ?? 0, chain_written: pageChain?.written ?? 0 });
      if (stop) return { ...st, outcome: "stopped" };
    }

    // ---- scan pages: the cursor, the wrap; recovery mode resets once per recovery id (delta D2)
    if (recovery && rs.done) return { ...st, outcome: "ok" };
    const rid = rs.recovery_id;
    const first = recovery && Number(scanRow.recovery) < rid;
    let cursor = first ? "" : String(scanRow.cursor ?? "");
    const pages = Math.min(recovery ? SCAN_PAGES.recovery : SCAN_PAGES.normal, opts.maxScanPages ?? Infinity);
    const age = opts.orphanAgeMs ?? ORPHAN_AGE_MS;
    for (let page = 0; page < pages && room(SCAN_PAGE_STATEMENTS); page++) {
      const p0 = { s: st.statements, r: st.rows_read, w: st.rows_written, c: st.r2_calls };
      pageChain = null;
      const listed = await bucket.list({ prefix: "o/", limit: SCAN_PAGE, ...(cursor ? { startAfter: cursor } : {}) });
      st.r2_calls++;
      st.keys_listed += listed.objects.length;
      const objs = listed.objects.map((o) => ({ key: o.key, token: tokenOf(o.key), uploaded: o.uploaded.getTime() }));
      const odd = objs.filter((o) => !o.token);
      if (odd.length) console.log("ALERT lti wake: objects under o/ that aren't bundle keys", JSON.stringify({ n: odd.length, first: odd[0].key }));
      const tokens = objs.flatMap((o) => (o.token ? [o.token] : []));
      let found = new Set<string>();
      if (tokens.length) {
        const look = await read.allMeta<{ token: string }>("SELECT token FROM bundles WHERE token IN (SELECT value FROM json_each(?))", JSON.stringify(tokens));
        st.d1_calls++;
        st.statements++;
        st.rows_read += look.rows_read;
        found = new Set(look.results.map((r) => r.token));
      }
      const now = Date.now();
      const orphans = objs.filter((o) => o.token && !found.has(o.token) && (recovery || o.uploaded <= now - age)).map((o) => o.key);
      if (orphans.length) {
        const d = await deleteKeys(orphans, "scan");
        // (not deleted: the cursor stays, so the page is listed again by a later wake)
        if (d !== "ok") return { ...st, outcome: d === "refused" ? "stopped" : "delete_failed" };
      }
      const wrapped = !listed.truncated;
      const last = objs.length ? objs[objs.length - 1].key : cursor;
      const stmts: Stmt[] = [];
      if (first && page === 0) {
        // (this recovery's reset, with the first page's cursor, in one statement: cursor, cycle and recovery together)
        stmts.push({ sql: "UPDATE scan SET cursor = ?, cycle = ?, recovery = ?, cycle_started = ? WHERE one = 1", params: [wrapped ? "" : last, rid, rid, now] });
        st.first = true;
      } else if (wrapped && !recovery) {
        stmts.push({ sql: "UPDATE scan SET cursor = '', cycle = cycle + 1, cycle_started = ? WHERE one = 1", params: [now] });
      } else {
        stmts.push({ sql: "UPDATE scan SET cursor = ? WHERE one = 1", params: [wrapped ? "" : last] });
      }
      if (recovery) {
        const seen = [...found].filter((x) => !suspect.has(x));
        if (seen.length) stmts.push({ sql: "UPDATE bundles SET seen_cycle = ? WHERE token IN (SELECT value FROM json_each(?))", params: [rid, JSON.stringify(seen)] });
        // (the cycle's end: one guarded statement makes every unseen restored row unusable, with no per-row write)
        if (wrapped) stmts.push({ sql: "UPDATE meta SET v = ? WHERE k = 'valid_cycle' AND v < ?", params: [rid, rid] });
      }
      const w = await write(stmts);
      st.scan_pages++;
      st.pages.push({ kind: "scan", statements: st.statements - p0.s, rows_read: st.rows_read - p0.r, rows_written: st.rows_written - p0.w, r2_calls: st.r2_calls - p0.c, rows: objs.length, wrote: pageChain !== null, chain_read: pageChain?.read ?? 0, chain_written: pageChain?.written ?? 0 });
      if (!w.ok) return { ...st, outcome: "stopped" };
      cursor = wrapped ? "" : last;
      if (wrapped) {
        // (one cycle per wake at most; a recovery's end is reported once its advance has committed)
        if (recovery) {
          st.final = true;
          await gate.recoveryDone(t.id, rid);
        }
        break;
      }
    }
    return { ...st, outcome: "ok" };
  } finally {
    await gate.giveBack(t.id);
  }
}
