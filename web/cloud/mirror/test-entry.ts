// The Worker that web/cloud/mirror/test-mirror.mjs runs in Miniflare: the share API (for /auth/dev's sessions and
// purges) and the mirror's routes, plus test-only hooks.  Never part of the site.
//
// The account object (TestMirrorAccount): a clock offset (/__do/<hash>/__clock?ms=), random bytes injected in order
// (__random?hex=a,b,...), its alarm run now (__alarm), its state (__state: every table), a restart (__restart: the
// object aborts, and the next call makes a new one from storage), the nonce counter set (__nonce?set=), the encryption
// mode set (__mode?account=C | conv=<locator>), rows restored as a backup would (__restore, POST {table: rows}), and
// crash cuts (__cut?at=after-raise | before-lower: the next such step throws there, once).
//
// The Worker: headers x-test-kek-current and x-test-kek-drop (KEK versions, as a rotation would set them),
// x-test-preauth "deny", x-test-lose-commit (the commit's answer is lost), x-test-replace (after the put, the object is
// replaced by these bytes, base64), x-test-crash-after-put (the Worker stops after its put: no commit, no abandon),
// x-test-mirror-down (the account object unreachable, for the purge); x-test-budget-claims "off" (BUDGET_CLAIMS unbound,
// as a rollback of the binding would leave it); x-test-core (sharing's routes, /__bindpurge and /__scheduled answered by
// core's share server, web/share, instead of this directory's); /__stream (an append fed a counted body
// stream); /__read (a read with a counting writer); /__forge (a segment sealed from any plaintext, past the
// body checks: S6's schema row); /__purge, /__gone (purgeMirror, mirrorGone); /__bindpurge and /__scheduled (sharing's
// own purge, to its end); /__logs (every console line, for S5's scan).
import { handleShare, bindPurge, scheduled, type ShareEnv } from "../share/server.ts";
// (core's share server too, MIT, as the production site runs it: x-test-core sends a request there)
import * as core from "../../share/server.ts";
import { handleMirror, purgeMirror, mirrorGone, type MirrorSiteEnv, type Writer } from "./server.ts";
import { MirrorAccount, type MirrorEnv } from "./account.ts";
import { ALG, ENVELOPE, hex, nonceOf, openDek, seal, sha256Hex, unb64url } from "./crypto.ts";
import { MIRROR_SCHEMA } from "../../workspace/agent-chat/mirror-format.ts";
export { MirrorAccount };

const logs: string[] = [];
for (const k of ["log", "info", "warn", "error", "debug"] as const) {
  const real = console[k].bind(console);
  console[k] = (...a: unknown[]) => {
    logs.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "));
    real(...a);
  };
}

export class TestMirrorAccount extends MirrorAccount {
  private offset = 0;
  private queue: Uint8Array[] = [];
  private cuts = new Set<string>();
  protected now(): number {
    return Date.now() + this.offset;
  }
  protected random(n: number): Uint8Array {
    if (n === 16 && this.queue.length) return this.queue.shift()!;
    return super.random(n);
  }
  /** A crash cut: true once where the test armed it. */
  cut(at: string): boolean {
    return this.cuts.delete(at);
  }
  async fetch(req: Request): Promise<Response> {
    const u = new URL(req.url);
    const q = u.searchParams;
    switch (u.pathname) {
      case "/__clock":
        this.offset = Number(q.get("ms"));
        return Response.json({ now: this.now() });
      case "/__random":
        this.queue.push(...(q.get("hex") ?? "").split(",").filter(Boolean).map((h) => Uint8Array.from(h.match(/../g)!.map((x) => parseInt(x, 16)))));
        return Response.json({ queued: this.queue.length });
      case "/__alarm":
        await this.alarm();
        return Response.json({ alarm: await this.ctx.storage.getAlarm() });
      case "/__restart":
        this.ctx.abort("restart (test)");
        return Response.json({});
      case "/__nonce":
        this.sql.exec(`INSERT INTO meta (k, v) VALUES ('nonce', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`, q.get("set")!);
        return Response.json({});
      case "/__mode":
        if (q.get("account")) this.sql.exec(`INSERT INTO meta (k, v) VALUES ('mode', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`, q.get("account")!);
        if (q.get("conv")) this.sql.exec(`UPDATE convs SET mode = 'C' WHERE locator = ?`, q.get("conv")!);
        return Response.json({});
      case "/__cut":
        this.cuts.add(q.get("at")!);
        return Response.json({});
      case "/__restore": {
        const b = (await req.json()) as Record<string, Record<string, unknown>[]>;
        for (const [t, rows] of Object.entries(b))
          for (const r of rows) {
            const ks = Object.keys(r);
            this.sql.exec(`INSERT OR REPLACE INTO ${t} (${ks.join(",")}) VALUES (${ks.map(() => "?").join(",")})`, ...ks.map((k) => r[k]));
          }
        return Response.json({});
      }
      case "/__state": {
        const out: Record<string, unknown[]> = {};
        for (const t of ["meta", "wraps", "convs", "streams", "segments", "reservations", "outbox", "tombs"]) out[t] = this.sql.exec(`SELECT * FROM ${t}`).toArray();
        return Response.json({ ...out, held: this.held(), alarm: await this.ctx.storage.getAlarm() });
      }
    }
    return new Response("no", { status: 404 });
  }
}
// (the crash cuts, at the two steps of A2's order the rows cut: after the D1 raise, before the DO marks the reservation
// live; and after the DO's reduction, before the D1 lowering)
const proto = MirrorAccount.prototype as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
const realRaise = proto.raise, realLower = proto.lower;
proto.raise = async function (this: TestMirrorAccount, ...a: unknown[]) {
  const r = await realRaise.apply(this, a);
  if (this.cut?.("after-raise")) throw new Error("crash (test): after the raise");
  return r;
};
proto.lower = async function (this: TestMirrorAccount, ...a: unknown[]) {
  if (this.cut?.("before-lower")) throw new Error("crash (test): before the lowering");
  return realLower.apply(this, a);
};

function counted(total: number) {
  const seen = { pulled: 0, cancelled: false };
  const chunk = new TextEncoder().encode("a".repeat(1024));
  const stream = new ReadableStream<Uint8Array>({
    pull(c) {
      if (seen.pulled * 1024 >= total) return c.close();
      seen.pulled++;
      c.enqueue(chunk);
    },
    cancel() {
      seen.cancelled = true;
    },
  }, { highWaterMark: 0 });
  return { stream, seen };
}

type Env = MirrorSiteEnv & MirrorEnv & Record<string, unknown>;
export default {
  async fetch(req: Request, env: Env, ctx: { waitUntil(p: Promise<unknown>): void }) {
    const url = new URL(req.url);
    const h = req.headers;
    let e: Env = { ...env, MIRROR_PREAUTH: { limit: async () => ({ success: h.get("x-test-preauth") !== "deny" }) } };
    if (h.get("x-test-kek-current")) e = { ...e, MIRROR_KEK_CURRENT: h.get("x-test-kek-current")! };
    for (const v of (h.get("x-test-kek-drop") ?? "").split(",").filter(Boolean)) delete e[`MIRROR_KEK_V${v}`];
    if (h.get("x-test-budget-claims") === "off") delete e.BUDGET_CLAIMS;
    const isCore = h.get("x-test-core") === "1";
    if (h.get("x-test-mirror-down")) e = { ...e, MIRROR_ACCOUNT: { idFromName: () => ({}), get: () => new Proxy({}, { get: () => async () => { throw new Error("unreachable (test)"); } }) } as unknown as Env["MIRROR_ACCOUNT"] };
    const dm = /^\/__do\/([0-9a-f]{64})(\/__[a-z]+)$/.exec(url.pathname);
    if (dm) {
      const ns = env.MIRROR_ACCOUNT!;
      return ns.get(ns.idFromName("mirror:" + dm[1])).fetch(new Request("https://do" + dm[2] + url.search, { method: req.method, body: req.method === "POST" ? await req.text() : undefined }));
    }
    if (url.pathname === "/__logs") return Response.json({ logs });
    if (url.pathname === "/__prof") return Response.json((globalThis as any).__prof ?? {});
    if (url.pathname === "/__purge" && req.method === "POST") {
      try {
        await purgeMirror(e, ((await req.json()) as { account: string }).account);
        return Response.json({ ok: true });
      } catch (x) {
        return Response.json({ ok: false, error: String((x as Error).message) }, { status: 500 });
      }
    }
    if (url.pathname === "/__gone" && req.method === "POST") return Response.json({ gone: await mirrorGone(e, ((await req.json()) as { account: string }).account) });
    if (url.pathname === "/__bindpurge" && req.method === "POST") {
      const b = (await req.json()) as { account: string; rid: string; kind?: "admin" | "self" };
      return Response.json({ r: await (isCore ? core.bindPurge : bindPurge)(e as ShareEnv, b.account, b.rid, b.kind ?? "self") });
    }
    if (url.pathname === "/__scheduled" && req.method === "POST") {
      try {
        await (isCore ? core.scheduled : scheduled)(e as ShareEnv);
        return Response.json({ ok: true });
      } catch (x) {
        return Response.json({ ok: false, error: String((x as Error).message) });
      }
    }
    if (url.pathname === "/__stream" && req.method === "POST") {
      // {path, total, length?, headers}: that route fed a counted stream of `total` bytes
      const b = (await req.json()) as { path: string; total: number; length?: string; headers: Record<string, string> };
      const { stream, seen } = counted(b.total);
      const headers: Record<string, string> = { ...b.headers };
      if (b.length !== undefined) headers["content-length"] = b.length;
      const inner = new Request(url.origin + b.path, { method: "POST", headers, body: stream, duplex: "half" } as RequestInit);
      const r = (await handleMirror(inner, e, ctx))!;
      return Response.json({ status: r.status, body: await r.text(), ...seen });
    }
    if (url.pathname.startsWith("/__read/")) {
      // a read whose answer goes to a counting writer: how many chunks, and what
      const chunks: { status: number; body: string }[] = [];
      const out: Writer = { write: (status, body) => void chunks.push({ status, body }) };
      const inner = new Request(url.origin + url.pathname.slice("/__read".length) + url.search, { headers: req.headers });
      await handleMirror(inner, e, ctx, { out });
      return Response.json({ chunks });
    }
    if (url.pathname === "/__forge" && req.method === "POST") {
      // {account, hash, locator, log_instance, first_n, last_n, first_seq, last_seq, plaintext}: a segment committed with
      // any plaintext, sealed properly (S6 b: a schema violation inside a valid AEAD)
      const b = (await req.json()) as Record<string, string | number>;
      const ns = env.MIRROR_ACCOUNT!;
      const stub = ns.get(ns.idFromName("mirror:" + b.hash));
      const base = { account: String(b.account), hash: String(b.hash) };
      const range = { log_instance: String(b.log_instance), first_n: Number(b.first_n), last_n: Number(b.last_n), first_seq: Number(b.first_seq), last_seq: Number(b.last_seq) };
      const r = await stub.reserve({ ...base, locator: String(b.locator), range, bytes: 300_000, limit: 1 << 30 });
      if ("error" in r || "dup" in r.ok) return Response.json({ r });
      const pt = new TextEncoder().encode(String(b.plaintext));
      const dek = (await openDek(e, base.account, r.ok.wraps))!;
      const obj = await seal(dek.key, { v: ENVELOPE, alg: ALG, schema: MIRROR_SCHEMA, account: base.account, locator: String(b.locator), ...range, segment: r.ok.segment, prev: r.ok.prev, key_id: dek.key_id, nonce: hex(nonceOf(r.ok.nonce)), len: pt.length }, pt);
      const sha = await sha256Hex(obj);
      await env.MIRROR_BUCKET!.put(r.ok.key, obj, { sha256: sha });
      return Response.json({ c: await stub.commit({ ...base, res: r.ok.res, digest: await sha256Hex(pt), len: pt.length, size: obj.length, sha }) });
    }
    if (url.pathname === "/__burst" && req.method === "POST") {
      // {cookie, csrf, locs, per, inst}: per appends of one entry each, on every conversation at once, through the
      // routes (S3a's 10,000 seals, without a round trip from the test for each); every 25th preceded by one whose body
      // doesn't match its range (refused after its reservation: its nonce burned)
      const b = (await req.json()) as { cookie: string; csrf: string; locs: string[]; per: number; inst: string };
      let refused = 0;
      const one = async (loc: string, n: number, seq: number, range: string, want: number) => {
        const text = JSON.stringify({ schema: 1, allowlist: 1, log_instance: b.inst, entries: [{ k: "user", n, seq, id: `m${n}`, text: `message ${n}` }] });
        const r = await handleMirror(new Request(`${url.origin}/api/mirror/v1/append/${loc}`, {
          method: "POST", body: text,
          headers: { cookie: b.cookie, origin: url.origin, "x-sb-mirror-csrf": b.csrf, "content-type": "application/vnd.sagebrush.mirror+json", "x-sb-mirror-range": range, "content-length": String(new TextEncoder().encode(text).length) },
        }), e, ctx);
        if (r!.status !== want) refused++;
      };
      await Promise.all(b.locs.map(async (loc) => {
        for (let j = 0; j < b.per; j++) {
          const n = j + 1, seq = 10 + 3 * j;
          if (j % 25 === 24) await one(loc, n, seq, `${b.inst} ${n} ${n} ${seq + 1} ${seq + 1}`, 400);
          await one(loc, n, seq, `${b.inst} ${n} ${n} ${seq} ${seq}`, 200);
        }
      }));
      return Response.json({ refused });
    }
    if (url.pathname === "/__seals" && req.method === "POST") {
      // {account, hash, locs, per}: S3a's 10,000 encryptions.  On every conversation at once, per times: a reservation
      // from the account's object (its nonce from the counter), a real seal under that nonce with the account's DEK,
      // then the reservation abandoned (so the nonce is burned).  Returns every nonce the sealed headers carry.
      const b = (await req.json()) as { account: string; hash: string; locs: string[]; per: number };
      const ns = env.MIRROR_ACCOUNT!;
      const stub = ns.get(ns.idFromName("mirror:" + b.hash));
      const base = { account: b.account, hash: b.hash };
      const nonces: string[] = [];
      let failed = 0;
      const pt = new TextEncoder().encode("x");
      await Promise.all(b.locs.map(async (loc) => {
        for (let j = 0; j < b.per; j++) {
          const range = { log_instance: "seals", first_n: 1, last_n: 1, first_seq: 1, last_seq: 1 };
          const r = await stub.reserve({ ...base, locator: loc, range, bytes: 1024, limit: 1 << 30 });
          if ("error" in r || "dup" in r.ok) { failed++; continue; }
          const dek = (await openDek(e, base.account, r.ok.wraps))!;
          const h = { v: ENVELOPE, alg: ALG, schema: MIRROR_SCHEMA, account: base.account, locator: loc, ...range, segment: r.ok.segment, prev: r.ok.prev, key_id: dek.key_id, nonce: hex(nonceOf(r.ok.nonce)), len: 1 };
          const obj = await seal(dek.key, h, pt);
          const n = new DataView(obj.buffer).getUint32(4);
          nonces.push(JSON.parse(new TextDecoder().decode(obj.subarray(8, 8 + n))).nonce);
          await stub.abandon({ ...base, res: r.ok.res });
        }
      }));
      return Response.json({ nonces, failed });
    }
    const hooks: Parameters<typeof handleMirror>[3] = {};
    if (h.get("x-test-lose-commit")) hooks.loseCommit = true;
    const replace = h.get("x-test-replace");
    if (replace !== null) hooks.afterPut = async (key) => void (await env.MIRROR_BUCKET!.put(key, unb64url(replace)));
    if (h.get("x-test-crash-after-put")) hooks.afterPut = async () => { throw new Error("crash (test): after the put"); };
    try {
      if (isCore) return (await core.handleShare(req, e as ShareEnv, ctx)) ?? new Response("not the API", { status: 404 });
      return (await handleMirror(req, e, ctx, hooks)) ?? (await handleShare(req, e as ShareEnv, ctx)) ?? new Response("not the API", { status: 404 });
    } catch (x) {
      return Response.json({ crashed: String((x as Error).message) }, { status: 500 });
    }
  },
};
