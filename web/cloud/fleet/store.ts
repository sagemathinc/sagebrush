// The fleet Worker's own state for the relay's control plane, in D1 (migrations/0001_relay.sql): the control calls'
// consumed ids, the one monotone sequence behind every change and every feed cursor, each identity's epoch, and the
// changes the feed reports.  Each function that must be atomic is one statement or one batch (a D1 transaction).
//
// The order the relay's late-answer rule needs (relay r2.1 §3.3): whoever changes a fact the admission reads (a
// revocation, a new host_gen, a removed device, a sign-out, a grant) commits the change first and bumps the epochs it
// touches after; /relay/admit reads the epochs first and the facts after.  So an answer's epochs are never newer
// than the facts it was checked against, and any change after its read shows in the feed as a higher epoch.

export const CALL_KEEP_MS = 10 * 60_000;
export const CHANGES_KEEP_MS = 24 * 60 * 60_000;

export type Kind = "agent" | "account" | "host";
export interface Epochs {
  account: number;
  agent: number;
  host: number;
}

/** Consume a control call's id once: true if it was new (relay r2.1 §3: the Worker's own replay rule). */
export async function consumeCall(db: D1Database, id: string, ts: number): Promise<boolean> {
  const r = await db.prepare("INSERT INTO relay_calls (id, until_ms) VALUES (?1, ?2) ON CONFLICT (id) DO NOTHING").bind(id, ts + CALL_KEEP_MS).run();
  return r.meta.changes === 1;
}

/** The current epochs of an account, an agent and a host (0 for one never changed). */
export async function readEpochs(db: D1Database, ids: { account: string; agent: string; host: string }): Promise<Epochs> {
  const rows = await db
    .prepare("SELECT kind, epoch FROM relay_epochs WHERE (kind = 'account' AND id = ?1) OR (kind = 'agent' AND id = ?2) OR (kind = 'host' AND id = ?3)")
    .bind(ids.account, ids.agent, ids.host)
    .all<{ kind: Kind; epoch: number }>();
  const e: Epochs = { account: 0, agent: 0, host: 0 };
  for (const r of rows.results) e[r.kind] = r.epoch;
  return e;
}

/**
 * Record a change to one identity (after the change itself is committed): its epoch goes up by one and the change
 * takes the sequence's next value, in one transaction.  Returns the new epoch.  The fleet service's own paths call
 * this when they exist; until then, tests do.
 */
export async function bump(db: D1Database, kind: Kind, id: string, now: number): Promise<number> {
  const [, , , row] = await db.batch([
    db.prepare("UPDATE relay_seq SET n = n + 1 WHERE k = 1"),
    db.prepare("INSERT INTO relay_epochs (kind, id, epoch) VALUES (?1, ?2, 1) ON CONFLICT (kind, id) DO UPDATE SET epoch = epoch + 1").bind(kind, id),
    db
      .prepare("INSERT INTO relay_changes (seq, kind, id, epoch, at_ms) SELECT (SELECT n FROM relay_seq WHERE k = 1), ?1, ?2, (SELECT epoch FROM relay_epochs WHERE kind = ?1 AND id = ?2), ?3")
      .bind(kind, id, now),
    db.prepare("SELECT epoch FROM relay_epochs WHERE kind = ?1 AND id = ?2").bind(kind, id),
  ]);
  return (row.results[0] as { epoch: number }).epoch;
}

export interface Change {
  seq: number;
  kind: Kind;
  id: string;
  epoch: number;
}
export type FeedRead = { expired: true } | { expired: false; tick: number; changes: Change[] };

/**
 * One feed read, in one transaction: the sequence's next value (this answer's own cursor, so even an answer with no
 * changes advances), and the changes after `since` and before it, at most `limit` of them in seq order.  A since of 0
 * is "from now": no changes.  A since below the cleanup's floor, or one the sequence never reached, is expired.
 */
export async function readFeed(db: D1Database, since: number, limit: number): Promise<FeedRead> {
  const [, seq, changes] = await db.batch([
    db.prepare("UPDATE relay_seq SET n = n + 1 WHERE k = 1"),
    db.prepare("SELECT n, floor FROM relay_seq WHERE k = 1"),
    db.prepare("SELECT seq, kind, id, epoch FROM relay_changes WHERE seq > ?1 AND ?1 > 0 ORDER BY seq LIMIT ?2").bind(since, limit),
  ]);
  const { n, floor } = seq.results[0] as { n: number; floor: number };
  // (n is this answer's tick; a since at or past it was never a cursor this sequence gave)
  if (since !== 0 && (since < floor || since >= n)) return { expired: true };
  return { expired: false, tick: n, changes: (changes.results as unknown as Change[]).filter((c) => c.seq < n) };
}

/** The cron's cleanup: control ids past their window, and changes older than 24 hours (raising the floor). */
export async function clean(db: D1Database, now: number): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM relay_calls WHERE until_ms < ?1").bind(now),
    db.prepare("UPDATE relay_seq SET floor = MAX(floor, COALESCE((SELECT MAX(seq) FROM relay_changes WHERE at_ms < ?1), 0)) WHERE k = 1").bind(now - CHANGES_KEEP_MS),
    db.prepare("DELETE FROM relay_changes WHERE at_ms < ?1").bind(now - CHANGES_KEEP_MS),
  ]);
}
