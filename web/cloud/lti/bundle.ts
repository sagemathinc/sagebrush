// PUT /lti/admin/bundle (plan-lti-r5 amendment 3 r15 §2.2): an owner's own
// copy of an assignment bundle, in the LTI-owned R2 bucket.  The body is the
// raw bytes; the signed `x-lti-meta` header binds them (sha256, size).  Three
// steps under one upload ticket (§2.5, weight 3): reserve (a conditional
// insert that charges the owner and the environment), store (an R2 put to the
// row's own incarnation key, cut off at the deadline), hold (a conditional
// update that needs the deadline not passed).  A failure leaves the
// reservation to the sweep, with its charge (§2.4).

import { admitRequest, SKEW_MS } from "./admin.ts";
import { audit } from "./audit.ts";
import { gateOf, type ContentEnv } from "./content.ts";
import type { D1 } from "./db.ts";
import type { WriteResult } from "./gate.ts";
import { canonicalJson, derivedKey, fail, hmacHex, json, LtiError, randomHex, same, testGate } from "./util.ts";

export const BUNDLE_MAX = 25 * 1024 * 1024;
const META_MAX = 1024;
const D1_NOW = "CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)";

type BundleEnv = ContentEnv & { LTI_KEY: string; LTI_DB: D1; LTI_AUDIT: D1; LTI_BUNDLES?: R2Bucket };

const isRef = (v: unknown, max = 64): v is string => typeof v === "string" && v.length >= 1 && v.length <= max && /^[A-Za-z0-9_.:-]+$/.test(v);

/** The bundle's object key: one incarnation, `o/<owner digest>/<sha256>/<token>` (§2.1). */
export async function bundleKey(owner: string, sha: string, token: string): Promise<string> {
  return `o/${await derivedKey("owner", owner)}/${sha}/${token}`;
}

interface Meta { request_id: string; owner_ref: string; actor_ref: string; sha256: string; size: number }

/** §17.1's admin-call authentication, for a PUT whose body is bytes: the HMAC covers method, path, time and the meta header. */
async function authenticatedMeta(req: Request, env: BundleEnv): Promise<Meta> {
  if (req.method !== "PUT") throw new LtiError(405, "method");
  const t = req.headers.get("x-lti-time"), sig = req.headers.get("x-lti-signature"), raw = req.headers.get("x-lti-meta");
  if (!t || !/^\d{13}$/.test(t) || !sig || !/^[0-9a-f]{64}$/.test(sig) || !raw) throw new LtiError(401, "signature");
  if (raw.length > META_MAX) throw new LtiError(413, "too_large");
  if (Math.abs(Date.now() - Number(t)) > SKEW_MS) throw new LtiError(401, "stale");
  const want = await hmacHex(env.LTI_KEY, `PUT\n${new URL(req.url).pathname}\n${t}\n${raw}`);
  if (!same(want, sig)) throw new LtiError(401, "signature");
  let m: Record<string, unknown>;
  try {
    m = JSON.parse(raw);
  } catch {
    throw new LtiError(400, "json");
  }
  // (canonical JSON, so one meaning has one signature)
  if (!m || typeof m !== "object" || Array.isArray(m) || canonicalJson(m) !== raw) throw new LtiError(400, "meta");
  if (!isRef(m.owner_ref) || !isRef(m.actor_ref) || typeof m.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(m.sha256) || !Number.isSafeInteger(m.size) || (m.size as number) < 1 || (m.size as number) > BUNDLE_MAX) throw new LtiError(400, "meta");
  await admitRequest(env, m.request_id);
  return m as unknown as Meta;
}

/** The request body, cut off at `deadline` (§2.2 step 2): no put can finish after it, and none longer than `size`. */
function bounded(body: ReadableStream<Uint8Array>, size: number, deadline: number): ReadableStream<Uint8Array> {
  let seen = 0;
  const reader = body.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  return new ReadableStream<Uint8Array>({
    start(c) {
      timer = setTimeout(() => {
        c.error(new Error("deadline"));
        void reader.cancel();
      }, Math.max(0, deadline - Date.now()));
    },
    async pull(c) {
      const { done, value } = await reader.read();
      if (Date.now() >= deadline) {
        c.error(new Error("deadline"));
        return;
      }
      if (done) {
        clearTimeout(timer);
        if (seen !== size) c.error(new Error("size"));
        else c.close();
        return;
      }
      seen += value.byteLength;
      if (seen > size) {
        c.error(new Error("size"));
        void reader.cancel();
        return;
      }
      c.enqueue(value);
    },
    cancel() {
      clearTimeout(timer);
      void reader.cancel();
    },
  });
}

export async function uploadBundle(req: Request, env: BundleEnv): Promise<Response> {
  try {
    return await upload(req, env);
  } catch (e) {
    if (e instanceof LtiError) return fail(e.status, e.code);
    throw e;
  }
}

async function upload(req: Request, env: BundleEnv): Promise<Response> {
  if (!env.LTI_CONTENT || !env.LTI_GATE || !env.LTI_BUNDLES) throw new LtiError(503, "not_configured");
  const m = await authenticatedMeta(req, env);
  if (req.headers.get("content-length") !== String(m.size) || !req.body) throw new LtiError(400, "size");
  const detail = { request_id: m.request_id, sha256: m.sha256, size: m.size };
  await audit(env.LTI_AUDIT, { action: "bundle.upload", actor_ref: m.actor_ref, owner_ref: m.owner_ref, detail });
  const outcome = (o: string) => audit(env.LTI_AUDIT, { action: "bundle.upload.outcome", actor_ref: m.actor_ref, owner_ref: m.owner_ref, detail: { request_id: m.request_id, outcome: o } });
  const gate = gateOf(env);
  const t = await gate.issue("upload", m.owner_ref);
  if (!t.ok) throw new LtiError(t.status, t.code);
  try {
    await testGate("bundle_before_reserve");
    // 1. reserve: a new incarnation, charged by trigger; an existing (owner, sha) row answers instead
    const token = randomHex(16);
    const r = await gate.write(t.id, [
      { sql: "INSERT OR IGNORE INTO owners (owner_ref, created) VALUES (?, ?)", params: [m.owner_ref, Date.now()] },
      { sql: "INSERT INTO bundles (owner_ref, sha, size, state, token, deadline, due) VALUES (?, ?, ?, 'reserved', ?, ?, ?) ON CONFLICT (owner_ref, sha) DO NOTHING", params: [m.owner_ref, m.sha256, m.size, token, t.deadline, t.deadline + 3600_000] },
      { sql: "SELECT state, token FROM bundles WHERE owner_ref = ? AND sha = ?", params: [m.owner_ref, m.sha256] },
    ]);
    const refused = refusal(r);
    if (refused) {
      await outcome(refused.code);
      return fail(refused.status, refused.code);
    }
    const row = (r as { ok: true; results: { results: { state: string; token: string }[] }[] }).results[2].results[0];
    if (row.token !== token) {
      if (row.state === "held") {
        // (deduplicated: no upload, no new charge)
        await outcome("dedup");
        return json({ sha256: m.sha256, size: m.size, deduplicated: true });
      }
      await outcome("busy");
      return fail(409, "busy");
    }
    // 2. store: the row's own key; R2 refuses bytes that don't match the signed SHA-256
    const key = await bundleKey(m.owner_ref, m.sha256, token);
    let stored: R2Object | null;
    try {
      const fixed = new FixedLengthStream(m.size);
      const pipe = bounded(req.body!, m.size, t.deadline).pipeTo(fixed.writable);
      [stored] = await Promise.all([env.LTI_BUNDLES.put(key, fixed.readable, { sha256: m.sha256 }), pipe]);
    } catch {
      // (the reservation and any partial object are the sweep's, after the deadline + 1 h)
      await outcome("put_failed");
      return fail(400, "bundle_mismatch");
    }
    if (!stored || stored.size !== m.size) {
      await outcome("put_failed");
      return fail(400, "bundle_mismatch");
    }
    await testGate("bundle_before_hold");
    // 3. hold: only this incarnation, only before its deadline; usable in the current valid cycle (§2.5)
    const h = await gate.write(t.id, [
      { sql: `UPDATE bundles SET state = 'held', held_at = ${D1_NOW}, due = ${D1_NOW} + 86400000, seen_cycle = (SELECT v FROM meta WHERE k = 'valid_cycle') WHERE owner_ref = ? AND sha = ? AND state = 'reserved' AND token = ? AND deadline > ${D1_NOW}`, params: [m.owner_ref, m.sha256, token] },
    ]);
    if (!h.ok || h.results[0].meta.changes !== 1) {
      await outcome("hold_failed");
      return fail(503, "hold_failed");
    }
    await outcome("ok");
    return json({ sha256: m.sha256, size: m.size, deduplicated: false });
  } finally {
    await gate.giveBack(t.id);
  }
}

/** A reserve's refusal: the caps (507), an expired or spent ticket, or an uncertain call (503, start again). */
function refusal(r: WriteResult): { status: number; code: string } | null {
  if (r.ok) return null;
  if (r.code === "bundle_quota" || r.code === "quota") return { status: 507, code: "bundle_quota" };
  return { status: 503, code: r.code === "uncertain_committed" ? "uncertain" : r.code };
}
