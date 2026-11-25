// The Worker that web/cloud/lti/test-lti.mjs runs in Miniflare: the tool, plus
// test-only routes no deployed entry has.  It alone turns the test seams on.
(globalThis as { __SAGEBRUSH_LTI_TEST__?: boolean }).__SAGEBRUSH_LTI_TEST__ = true;
import { handleLti, ltiScheduled } from "./worker.ts";
import { setTestFault, setTestGate, testGateParked } from "./util.ts";
import { confirmedRefusal } from "./db.ts";
import { readCapped } from "./mapping.ts";
import type { Env } from "./env.ts";
import { contentWake, type WakeOptions } from "./content-wake.ts";
import { bundleKey } from "./bundle.ts";
export { LtiReg, LtiLaunchShard, LtiCourse, LtiFleet, LtiContentGate } from "./worker.ts";

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    // (tests only: a session as if launched `ago_ms` earlier, to reach the absolute end without waiting an hour)
    if (url.pathname === "/__test/session") {
      const b = (await req.json()) as Record<string, unknown>;
      const course = String(b.course);
      // (handles as Reg would issue them: fixed per member, so a member's sessions share them)
      const h = async (k: string) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(k + String(b.member)))).slice(0, 16), (x) => x.toString(16).padStart(2, "0")).join("");
      const memberRef = await h("member_ref:"), personRef = await h("person_ref:");
      const c = env.LTI_COURSE!.get(env.LTI_COURSE!.idFromName(course));
      const m = await c.setMember(String(b.member), memberRef, personRef);
      if (!m.ok) return Response.json(m);
      const s = await c.create({ course, rid: String(b.rid), deployment: "d", context: "c", placement: null, sub: String(b.sub), member: String(b.member), member_ref: memberRef, role: b.role as "instructor" | "learner", staff: (b.staff as "instructor" | "ta" | undefined) ?? (b.role === "instructor" ? "instructor" : null), launched_at: b.at !== undefined ? Number(b.at) : Date.now() - Number(b.ago_ms ?? 0) });
      return Response.json(s);
    }
    // (tests only: a guest relaunch at an exact time)
    if (url.pathname === "/__test/lower") {
      const b = (await req.json()) as { course: string; member: string; at: number };
      return Response.json(await env.LTI_COURSE!.get(env.LTI_COURSE!.idFromName(b.course)).lower(b.member, b.at));
    }
    // (tests only: bump a member's or the course's generation, as an NRPS refresh or a removal would)
    if (url.pathname === "/__test/bump") {
      const b = (await req.json()) as Record<string, unknown>;
      await env.LTI_COURSE!.get(env.LTI_COURSE!.idFromName(String(b.course))).bump(b.member === null ? null : String(b.member));
      return Response.json({ ok: true });
    }
    // (tests only: fill a Course with maximum-width rows and report its size; a shard's tombstone charges)
    if (url.pathname === "/__test/fill") {
      const b = (await req.json()) as { course: string; sessions?: number; members?: number };
      return Response.json(await env.LTI_COURSE!.get(env.LTI_COURSE!.idFromName(b.course)).testFill(b));
    }
    if (url.pathname === "/__test/shard-level") {
      const b = (await req.json()) as { name: string; pad?: number; padRows?: number };
      return Response.json(await env.LTI_SHARD!.get(env.LTI_SHARD!.idFromName(b.name)).testLevel(b));
    }
    if (url.pathname === "/__test/shard-stats") {
      const b = (await req.json()) as { name: string };
      return Response.json(await env.LTI_SHARD!.get(env.LTI_SHARD!.idFromName(b.name)).testStats());
    }
    // (tests only: hold, or open, a named step)
    if (url.pathname === "/__test/gate") {
      if (req.method === "GET") return Response.json({ parked: testGateParked(url.searchParams.get("name") ?? "") });
      const b = (await req.json()) as { name: string; on: boolean; once?: boolean };
      setTestGate(b.name, b.on, b.once === true);
      return Response.json({ ok: true });
    }
    // (tests only: which refusal, if any, a raw D1 error message proves)
    if (url.pathname === "/__test/classify") {
      return Response.json({ refusal: confirmedRefusal(((await req.json()) as { message: string }).message) });
    }
    // (tests only: arm a one-shot lost-response fault after a named write)
    if (url.pathname === "/__test/fault") {
      const f = (await req.json()) as { name: string; message?: string };
      setTestFault(f.name, f.message);
      return Response.json({ ok: true });
    }
    // (tests only: one call on the content gate, as the handlers make them, or its test seams)
    if (url.pathname === "/__test/cgate") {
      const b = (await req.json()) as { m: string; args?: unknown[] };
      const allowed = ["issue", "giveBack", "write", "live", "probe", "setMode", "testState", "testSeam", "testReleaseLate", "checkpointNow", "checkpoints", "intent", "resolveIntent", "intents", "closeIntent", "pause", "quiet", "marker", "recover", "recoveryState", "recoveryDone", "resume"];
      if (!allowed.includes(b.m)) return new Response("method", { status: 400 });
      const g = env.LTI_GATE!.get(env.LTI_GATE!.idFromName("gate")) as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
      return Response.json(await g[b.m](...(b.args ?? [])));
    }
    // (tests only: write a batch of small objects from inside the Worker, for the full-size population: one round trip
    // per batch, not per key)
    if (url.pathname === "/__test/r2-fill") {
      const b = (await req.json()) as { keys: string[] };
      await Promise.all(b.keys.map((k) => env.LTI_BUNDLES!.put(k, "s")));
      return Response.json({ ok: true, n: b.keys.length });
    }
    // (tests only: a bundle incarnation's R2 key)
    if (url.pathname === "/__test/bundle-key") {
      const q = url.searchParams;
      return Response.json({ key: await bundleKey(q.get("owner")!, q.get("sha")!, q.get("token")!) });
    }
    // (tests only: one content wake, now, with test options)
    if (url.pathname === "/__test/content-wake") {
      return Response.json(await contentWake(env, (await req.json()) as WakeOptions));
    }
    // (tests only: Reg's test seams)
    if (url.pathname === "/__test/seam") {
      const b = (await req.json()) as { rid: string; op: Record<string, unknown> };
      return Response.json(await env.LTI_REG!.get(env.LTI_REG!.idFromName(b.rid)).testSeam(b.rid, b.op));
    }
    // (tests only: the daily job, now)
    if (url.pathname === "/__test/scheduled") return Response.json(await ltiScheduled(env));
    // (tests only: a LaunchShard filled with n transactions whose state starts with the shard's digit; answers the last begin)
    if (url.pathname === "/__test/shard-fill") {
      const rid = url.searchParams.get("rid")!, n = Number(url.searchParams.get("n"));
      const sh = env.LTI_SHARD!.get(env.LTI_SHARD!.idFromName(`${rid}:f`));
      let last: unknown = null;
      for (let i = 0; i < n; i++) last = await sh.begin({ state: "f" + crypto.randomUUID().replace(/-/g, "").padEnd(63, "0").slice(0, 63), nonce: "0".repeat(64), rid, iss: "x", client_id: "x", deployment: null, target: "x", login_hint: "x", message_hint: null, mode: "cookie", storage_target: null, created: Date.now() });
      return Response.json({ last, stats: await sh.stats() });
    }
    // (tests only: readCapped on a 1 MiB stream whose pulls and cancellation it can see)
    if (url.pathname === "/__test/read-capped") {
      let pulled = 0, cancelled = false;
      const chunk = new TextEncoder().encode(" ".repeat(4096));
      const big = new ReadableStream({ pull(c) { if (pulled >= 1 << 20) return c.close(); pulled += chunk.length; c.enqueue(chunk); }, cancel() { cancelled = true; } }, { highWaterMark: 0 });
      const result = await readCapped(new Response(big), 16 * 1024);
      const small = await readCapped(new Response("x".repeat(16384)), 16 * 1024);
      return Response.json({ result, pulled, cancelled, small });
    }
    // (tests only: Reg's recovery page, as cocalc.ai's reported handles would arrive)
    if (url.pathname === "/__test/reconcile") {
      const rid = url.searchParams.get("rid")!;
      const b = (await req.json()) as { handles: { seq: number; handle: string; kind: "person" | "member" | "course" }[] };
      return Response.json(await env.LTI_REG!.get(env.LTI_REG!.idFromName(rid)).reconcile(rid, b.handles));
    }
    // (tests only: one of Reg's buckets spent for a long time, or full again)
    if (url.pathname === "/__test/bucket") {
      const rid = url.searchParams.get("rid")!;
      return Response.json(await env.LTI_REG!.get(env.LTI_REG!.idFromName(rid)).testBucket(url.searchParams.get("kind")!, url.searchParams.get("spent") === "1"));
    }
    // (tests only: a registration's launch bucket, and its 16 shards' rows)
    if (url.pathname === "/__test/launch-state") {
      const rid = url.searchParams.get("rid")!;
      const bucket = await env.LTI_REG!.get(env.LTI_REG!.idFromName(rid)).inspectBucket("launch");
      let rows = 0;
      for (const d of "0123456789abcdef") rows += (await env.LTI_SHARD!.get(env.LTI_SHARD!.idFromName(`${rid}:${d}`)).stats()).rows;
      return Response.json({ bucket, rows });
    }
    // (tests only: refill one of Reg's buckets)
    if (url.pathname === "/__test/refill") {
      const rid = url.searchParams.get("rid")!;
      return Response.json(await env.LTI_REG!.get(env.LTI_REG!.idFromName(rid)).testRefill(url.searchParams.get("kind")!));
    }
    // (tests only: Reg's reservations)
    if (url.pathname === "/__test/reserve") {
      const reg = env.LTI_REG!.get(env.LTI_REG!.idFromName(url.searchParams.get("rid")!));
      const kind = url.searchParams.get("kind")!;
      if (url.searchParams.get("release")) return Response.json(await reg.release(url.searchParams.get("release")!));
      return Response.json({ lease: await reg.reserve(kind) });
    }
    // (tests only: a registration's mapping state, or one wake of its erasure work)
    if (url.pathname === "/__test/reg") {
      const rid = url.searchParams.get("rid")!;
      const reg = env.LTI_REG!.get(env.LTI_REG!.idFromName(rid));
      if (url.searchParams.get("op") === "step") return Response.json(await reg.runStep(rid, url.searchParams.get("due") === "1"));
      return Response.json(await reg.inspectMapping(rid));
    }
    // (tests only: Course.eraseMember directly, and its member count)
    if (url.pathname === "/__test/course") {
      const c = env.LTI_COURSE!.get(env.LTI_COURSE!.idFromName(url.searchParams.get("course")!));
      if (url.searchParams.get("op") === "erase") return Response.json(await c.eraseMember(url.searchParams.get("ref")!, "e".repeat(16), ""));
      return Response.json({ members: await c.memberCount() });
    }
    // (tests only: grades — queue a score, drain the outbox (all rows made due), inspect; Reg's charged set)
    if (url.pathname === "/__test/ags") {
      const op = url.searchParams.get("op");
      if (op === "charge" || op === "release" || op === "charged") {
        const rid = url.searchParams.get("rid")!, reg = env.LTI_REG!.get(env.LTI_REG!.idFromName(rid));
        const qid = url.searchParams.get("qid")!, inc = Number(url.searchParams.get("inc"));
        if (op === "charge") return Response.json(await reg.agsCharge(rid, qid, inc, "c".repeat(32)));
        if (op === "release") return Response.json(await reg.agsRelease(rid, qid, inc));
        return Response.json(await reg.agsChargedCount());
      }
      if (op === "outday") {
        const rid = url.searchParams.get("rid")!;
        return Response.json(await env.LTI_REG!.get(env.LTI_REG!.idFromName(rid)).testOutboundDay(Number(url.searchParams.get("n"))));
      }
      if (op === "fleet") return Response.json(await env.LTI_FLEET!.get(env.LTI_FLEET!.idFromName("fleet")).testTokens(Number(url.searchParams.get("tokens"))));
      const course = url.searchParams.get("course")!;
      const c = env.LTI_COURSE!.get(env.LTI_COURSE!.idFromName(course));
      if (op === "queue") return Response.json(await c.queueScore(course, await req.json()));
      if (op === "drain") {
        const n = Number(url.searchParams.get("n") ?? 6);
        let left = -1;
        for (let i = 0; i < n; i++) {
          await c.agsTestDue();
          left = await c.agsDrain();
          if (left === 0) break;
        }
        return Response.json({ left, ...(await c.agsInspect()) });
      }
      if (op === "memberref") return Response.json(await c.memberRefOf(url.searchParams.get("member")!));
      if (op === "fill") return Response.json(await c.agsTestFill(await req.json()));
      return Response.json(await c.agsInspect());
    }
    return handleLti(req, env);
  },
};
