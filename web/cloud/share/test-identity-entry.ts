// The Worker that web/cloud/share/test-identity.mjs runs in Miniflare: the share API, plus (tests only) the WorkOS
// token check itself at /__verify, so its rows run in the Workers runtime, as deployed.
import { clearKeyCache, verifyAccessToken } from "../../share/identity/workos.ts";
import { seal, sealKeys, unseal } from "../../share/identity/seal.ts";
import { authTier, disableAccount, drainRevokes, handleShare, onSessionsEnded, outboxCounts, reauthAt, scheduled, type EndedSession, type ShareEnv } from "./server.ts";
import { handleRemote } from "../remote/server.ts";

// (tests only: the bulk-end hooks, registered at import as the sync service registers its own, recording each call;
// off until a row arms them, and each can be made to fail)
const hooks = { on: false, failEnding: false, failEnded: false, n: 0, calls: [] as { hook: string; account: string; sessions?: EndedSession[]; live?: number; mark?: unknown; before?: unknown }[] };
let hookDb: ShareEnv["SHARE_DB"] = undefined;
onSessionsEnded({
  ending: async (_env, account) => {
    if (!hooks.on) return;
    // (how many of the account's sessions exist when it runs: all of them, since it runs before the delete)
    const live = Number((await hookDb!.prepare("SELECT COUNT(*) AS n FROM sessions WHERE account_id = ?1").bind(account).first<{ n: number }>())?.n);
    // (a value of this call's own, which core must hand back to this call's ended and no other)
    const mark = `call-${++hooks.n}`;
    hooks.calls.push({ hook: "ending", account, live, mark });
    if (hooks.failEnding) throw new Error("ending failed (test)");
    return mark;
  },
  ended: async (_env, account, sessions, before) => {
    if (!hooks.on) return;
    hooks.calls.push({ hook: "ended", account, sessions, before });
    if (hooks.failEnded) throw new Error("ended failed (test)");
  },
});

export default {
  async fetch(req: Request, env: ShareEnv, ctx: { waitUntil(p: Promise<unknown>): void }) {
    const u = new URL(req.url);
    hookDb = env.SHARE_DB;
    if (u.pathname === "/__hooks" && req.method === "POST") {
      const b = (await req.json()) as { on?: boolean; failEnding?: boolean; failEnded?: boolean };
      const calls = hooks.calls;
      Object.assign(hooks, { on: !!b.on, failEnding: !!b.failEnding, failEnded: !!b.failEnded, calls: [] });
      return Response.json({ calls });
    }
    if (u.pathname === "/__verify" && req.method === "POST") {
      const b = (await req.json()) as { token: unknown; now?: number; issuer?: string; clientId?: string; env?: string; fresh?: boolean };
      if (b.fresh) clearKeyCache();
      const c = { env: b.env ?? env.AUTH_ENV!, clientId: b.clientId ?? env.WORKOS_CLIENT_ID!, issuer: b.issuer ?? env.WORKOS_ISSUER!, apiKey: env.WORKOS_API_KEY!, api: env.WORKOS_API };
      return Response.json(await verifyAccessToken(c, b.token, { now: b.now }));
    }
    // (tests only: the tier that decides computer enrollment, for an account)
    if (u.pathname === "/__authTier" && req.method === "POST") {
      const b = (await req.json()) as { account: string };
      return Response.json({ tier: await authTier(env, { id: b.account, session: "x" }) });
    }
    // (tests only: the scheduled job, run now)
    if (u.pathname === "/__scheduled" && req.method === "POST") {
      await scheduled(env);
      return Response.json({ ok: true });
    }
    // (tests only: an account disabled, as the admin action will; the revoke outbox drained; its numbers)
    if (u.pathname === "/__disable" && req.method === "POST") {
      try {
        await disableAccount(env, ((await req.json()) as { account: string }).account);
      } catch {
        return Response.json({ ok: false }, { status: 503 });
      }
      return Response.json({ ok: true });
    }
    // (tests only: the refresh-token seal in workerd: rotation, retired keys, a seal moved to another row or environment)
    if (u.pathname === "/__seal" && req.method === "POST") {
      const b = (await req.json()) as { old: string; next: string };
      const oldOnly = (await sealKeys(b.old))!, both = (await sealKeys(`${b.next},${b.old}`))!, nextOnly = (await sealKeys(b.next))!;
      const c = { env: "test", identity: "id-1", session: "hash-1" };
      const s1 = await seal(oldOnly, c, "rt_one");
      const s2 = await seal(both, c, "rt_two");
      const again = await seal(oldOnly, c, "rt_one");
      return Response.json({
        oldVersion: s1.version, newVersion: s2.version,
        rotatedOpensOld: await unseal(both, c, s1.version, s1.ct), rotatedOpensNew: await unseal(both, c, s2.version, s2.ct),
        retiredOpensOld: await unseal(nextOnly, c, s1.version, s1.ct),
        otherSession: await unseal(oldOnly, { ...c, session: "hash-2" }, s1.version, s1.ct),
        otherIdentity: await unseal(oldOnly, { ...c, identity: "id-2" }, s1.version, s1.ct),
        otherEnv: await unseal(oldOnly, { ...c, env: "prod" }, s1.version, s1.ct),
        versionSwapped: await unseal(both, c, s2.version, s1.ct),
        freshNonce: again.ct !== s1.ct,
        malformed: [await sealKeys(""), await sealKeys("v1:short"), await sealKeys("nocolon"), await sealKeys(`${b.old},${b.old}`)].map((k) => k === null),
      });
    }
    // (tests only: a new session's reauth_ms expression, on D1, with the clock given as ?1 and the state's last moment as ?2)
    if (u.pathname === "/__reauthAt" && req.method === "POST") {
      const b = (await req.json()) as { now: number; until: number | null };
      return Response.json(await env.SHARE_DB!.prepare(`SELECT ${reauthAt("?1", "?2")} AS v`).bind(b.now, b.until).first());
    }
    if (u.pathname === "/__drain" && req.method === "POST") return Response.json(await drainRevokes(env, 100));
    if (u.pathname === "/__outbox" && req.method === "GET") return Response.json(await outboxCounts(env.SHARE_DB!));
    // (tests only: the remote pages, with the bindings remote needs to be on, so a row can reach a page's sign-in check)
    if (u.pathname.startsWith("/remote/")) {
      const renv = { ...env, REMOTE_CHAL_KEY: "test-remote-challenge-key-0123456789abcdef", REMOTE_ACCOUNTS: "", REMOTE_PREAUTH: { limit: async () => ({ success: true }) } };
      return (await handleRemote(req, renv as never, ctx as never)) ?? new Response("not remote", { status: 404 });
    }
    return (await handleShare(req, env, ctx)) ?? new Response("not the API", { status: 404 });
  },
  async scheduled(_e: unknown, env: ShareEnv) {
    await scheduled(env);
  },
};
