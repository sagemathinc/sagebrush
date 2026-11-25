// LtiContent from the request handlers' side (plan-lti-r5 amendment 3 r15 §2.5,
// §4).  Handlers get a READ wrapper only: every fenced write goes through the
// gate (gate.ts).  The two writes here are the self-validating pin batches,
// which take no ticket (LIMIT-LTI5A3-5): each only creates pins, its
// revision-existence trigger aborts it when the revision is gone, and it is
// one transaction, so a stale one landing after a restore records only a pin
// for a revision that exists.  test-lti.mjs checks that no other source file
// writes LTI_CONTENT.

import type { D1, D1Result } from "./db.ts";
import type { LtiContentGate } from "./gate.ts";

export interface ContentEnv { LTI_CONTENT?: D1; LTI_GATE?: DurableObjectNamespace<LtiContentGate> }

/** The environment's one gate. */
export function gateOf(env: ContentEnv): DurableObjectStub<LtiContentGate> {
  if (!env.LTI_GATE) throw new Error("LTI_GATE unbound");
  return env.LTI_GATE.get(env.LTI_GATE.idFromName("gate"));
}

/** A read-only view of LtiContent: a statement that isn't a SELECT is refused before it reaches D1. */
export function contentRead(env: ContentEnv): { first<T>(sql: string, ...p: unknown[]): Promise<T | null>; all<T>(sql: string, ...p: unknown[]): Promise<T[]>; allMeta<T>(sql: string, ...p: unknown[]): Promise<{ results: T[]; rows_read: number }> } {
  const db = env.LTI_CONTENT;
  if (!db) throw new Error("LTI_CONTENT unbound");
  const check = (sql: string) => {
    if (!/^\s*SELECT\b/i.test(sql) || /;\s*\S/.test(sql)) throw new Error("content: read only");
  };
  return {
    first: <T>(sql: string, ...p: unknown[]) => (check(sql), db.prepare(sql).bind(...p).first<T>()),
    all: async <T>(sql: string, ...p: unknown[]) => (check(sql), (await db.prepare(sql).bind(...p).all<T>()).results),
    // (the wake's accounting reads D1's own count of rows read)
    allMeta: async <T>(sql: string, ...p: unknown[]) => {
      check(sql);
      const r = await db.prepare(sql).bind(...p).all<T>();
      return { results: r.results, rows_read: Number((r.meta as { rows_read?: number } | undefined)?.rows_read ?? 0) };
    },
  };
}

/** D1's own clock in the same statement, as the triggers read it. */
const D1_NOW = "CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)";

export interface Placeable { aid: string; owner_ref: string; title: string; rev: number; max_points: number; visibility: "institution" | "public" }

/** The assignments a registration's owner may place (r5 §7.2): its own and the public catalog, at their current rev. */
export async function visibleAssignments(env: ContentEnv, ownerRef: string, limit = 200): Promise<Placeable[]> {
  return contentRead(env).all<Placeable>("SELECT aid, owner_ref, title, rev, max_points, visibility FROM assignments WHERE owner_ref = ? OR visibility = 'public' ORDER BY title LIMIT ?", ownerRef, limit);
}

/** The deep-link selection (§4): each assignment visible to the owner now, at its current rev. */
export async function placeableByAid(env: ContentEnv, aids: string[]): Promise<Placeable[]> {
  if (!aids.length) return [];
  return contentRead(env).all<Placeable>(`SELECT aid, owner_ref, title, rev, max_points, visibility FROM assignments WHERE aid IN (${aids.map(() => "?").join(",")})`, ...aids);
}

/**
 * Before the deep-link response is signed (§4): one batch writes a deep-link
 * pin per item.  The trigger refuses a missing revision ("isn't available") and
 * the registration's cap ("too many items not yet launched").  It only creates
 * pins, so it is self-validating as the launch's batch is.
 */
export async function pinDeepLinks(env: ContentEnv, rid: string, items: { item: string; aid: string; rev: number }[]): Promise<{ ok: true } | { ok: false; code: "not_available" | "pin_quota" }> {
  const db = env.LTI_CONTENT!;
  try {
    await db.batch([
      ...quotaRows(db, rid),
      ...items.map((i) => db.prepare(`INSERT INTO pins (kind, rid, item, aid, rev, created) VALUES ('dl', ?, ?, ?, ?, ${D1_NOW})`).bind(rid, i.item, i.aid, i.rev)),
    ]);
    return { ok: true };
  } catch (e) {
    return { ok: false, code: /pin_quota/.test(String((e as Error)?.message)) ? "pin_quota" : "not_available" };
  }
}

/** A registration's pin quota rows, made by its first pin's batch at the default caps (never moved). */
function quotaRows(db: D1, rid: string) {
  return [db.prepare("INSERT OR IGNORE INTO quota (scope, kind, cap_count, cap_bytes) VALUES (?, 'placement_pins', 10000, 0), (?, 'dl_pins', 10000, 0)").bind(rid, rid)];
}

/**
 * The launch check (§4), before any placement, document, attempt or session:
 * `sb_assignment` visible to the registration's owner now, `sb_rev` an existing
 * revision at most the current one, and its bundle usable (held, and seen in
 * the current valid cycle).  Answers the revision's max_points, or null.
 */
export async function launchCheck(env: ContentEnv, ownerRef: string, aid: string, rev: number): Promise<{ max_points: number } | null> {
  if (!/^[0-9a-f]{32}$/.test(aid) || !Number.isSafeInteger(rev) || rev < 1) return null;
  const r = await contentRead(env).first<{ owner_ref: string; visibility: string; cur: number; max_points: number; usable: number }>(
    `SELECT a.owner_ref, a.visibility, a.rev AS cur, r.max_points,
       (b.state = 'held' AND b.seen_cycle >= (SELECT v FROM meta WHERE k = 'valid_cycle')) AS usable
     FROM assignments a JOIN assignment_revisions r ON r.aid = a.aid AND r.rev = ?
       JOIN bundles b ON b.owner_ref = r.owner_ref AND b.sha = r.bundle_sha
     WHERE a.aid = ?`,
    rev, aid,
  );
  if (!r || (r.owner_ref !== ownerRef && r.visibility !== "public") || rev > r.cur || !r.usable) return null;
  return { max_points: r.max_points };
}

/**
 * The placement pin (§4): a launch that passed writes `(rid, placement, aid,
 * rev)` if the placement has none (never moving an existing one), and deletes
 * the deep-link pin `sb_item` names only when that pin is exactly the
 * registration's, for exactly this (aid, rev), and the placement now pins
 * exactly the same pair (CORR-LTI5A3-4).  One batch; no ticket.
 */
export async function pinPlacement(env: ContentEnv, p: { rid: string; placement: string; aid: string; rev: number; item: string | null; launch_id: string }): Promise<{ ok: true; pinned: { aid: string; rev: number } | null } | { ok: false; code: "not_available" | "pin_quota" }> {
  const db = env.LTI_CONTENT!;
  const stmts = [
    ...quotaRows(db, p.rid),
    db.prepare(`INSERT INTO pins (kind, rid, item, aid, rev, launch_id, created) VALUES ('placement', ?, ?, ?, ?, ?, ${D1_NOW}) ON CONFLICT (kind, rid, item) DO NOTHING`).bind(p.rid, p.placement, p.aid, p.rev, p.launch_id),
  ];
  if (p.item)
    stmts.push(db.prepare(
      `DELETE FROM pins WHERE kind = 'dl' AND rid = ? AND item = ? AND aid = ? AND rev = ?
         AND EXISTS (SELECT 1 FROM pins WHERE kind = 'placement' AND rid = ? AND item = ? AND aid = ? AND rev = ?)`,
    ).bind(p.rid, p.item, p.aid, p.rev, p.rid, p.placement, p.aid, p.rev));
  stmts.push(db.prepare("SELECT aid, rev FROM pins WHERE kind = 'placement' AND rid = ? AND item = ?").bind(p.rid, p.placement));
  let out: D1Result[];
  try {
    out = await db.batch(stmts);
  } catch (e) {
    return { ok: false, code: /pin_quota/.test(String((e as Error)?.message)) ? "pin_quota" : "not_available" };
  }
  const row = out.at(-1)!.results[0] as { aid: string; rev: number } | undefined;
  return { ok: true, pinned: row ?? null };
}
