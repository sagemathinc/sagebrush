// The fleet Worker's three relay endpoints as pure handlers (relay design r2.2 §3 and §5; channel addendum A1 §2):
//
//   POST /api/fleet/v1/relay/app-token         the app's relay token, under the person's account session (A1 §2)
//   POST /api/fleet/v1/relay/admit             one open's or commit's checks, for the relay (control-plane call)
//   GET  /api/fleet/v1/relay/epochs?since=<n>  the revocation feed, for the relay (control-plane call)
//
// Each takes the request as data ({ method, target, headers, body }) and a ctx of the Worker's state, and returns
// { status, headers, body }. They hold no state of their own and log nothing; a Worker mounts them, supplies the ctx
// from its Durable Objects and D1, and resolves the request's account session with its own session code.
//
// ---- The ctx (every read is current: none may be cached across requests)
//
//   aud, now                       the audience; the Worker's clock, ms
//   controlKey                     the relay control key's 32 bytes (control calls only)
//   requestSession                 the issuer's request: its authenticated { account, account_session } or null
//   session(account, s)            -> { expires_ms } if that account session is live now, else null
//   accountOf(fleet)               -> the fleet's account id, or null
//   chain(fleet)                   -> the fleet's device-chain state (as the core's verifiers take it), or null
//   host(host)                     -> { fleet, sign_key (32 raw bytes), gen, revoked, grant_not_after_ms | null } or null
//   agent(host, agent)             -> { browser, revoked } for the agent in the host's CURRENT grant, or null
//   epochs({ account, agent, host }) -> { account, agent, host }: the current epoch of each
//   feed(since, max)               -> { cursor, at_ms, more, agents, accounts, hosts } past since (at most max per
//                                     list), or null if since was never issued or is no longer kept
//   consumeCallId(id, until_ms)    -> true if the control call's id was new (ATOMIC, below)
//   tokens                         the relay tokens' store (ATOMIC, below)
//   bucket(key, limit, window_ms)  -> true if one more is allowed in the window (ATOMIC, below)
//
// ---- The atomic store contract (what the Worker's real store must meet; its own review checks it, since no fake can)
//
//   tokens.put(key, row)    insert iff no row has `key`; resolves true when the row is durable, false if one existed.
//   tokens.take(key)        read and delete the row at `key` in one step: of any number of takes of one key, however
//                           concurrent and on whatever instance, at most one resolves the row, and the others null. The
//                           delete is durable before the row is returned. A row past expires_ms may still be returned:
//                           the verifier checks expiry itself.
//   tokens.dropSession(s)   delete every row whose account_session is s (a logout or revocation calls it).
//   tokens.sweep(now)       delete every row with expires_ms <= now.
//   consumeCallId(id, u)    insert-if-absent, durable before it resolves; kept at least until u.
//   bucket(k, n, w)         at most n trues for k in any window of w ms, across instances.
//
// A store that keeps a row, a call id or a count in one instance's memory doesn't meet this: Durable Object storage
// (one object per key's shard, with its input gate) or a D1 statement that deletes and returns in one query does.

import { b64, enc, isId, random, refuse, unb64, FleetError } from "./bytes.mjs";
import { canonText } from "./canonical.mjs";
import {
  ADMIT_REFUSALS, ADMIT_ROUTE, CALL_ID_TTL_MS, CURSOR_EXPIRED, FEED_MAX, REQUEST_MAX, parseAdmitRequest, parseEpochsTarget,
  signControlAnswer, verifyControlRequest, AUTH_HEADER,
} from "./control.mjs";
import {
  APP_TOKEN_MS, APP_TOKEN_ROUTE, appTokenKey, parseAppTokenRequest, parseOpenTarget, verifyAppOpen, verifyCommit, verifyHostOpen,
} from "./relay.mjs";
import { parseSig } from "./request.mjs";

export const APP_TOKEN_RATE = Object.freeze({ limit: 30, windowMs: 60_000 });
const ISSUE_BODY_MAX = 1024;
// (the issuer's refusals and their HTTP status, as schema/fleet/reasons.json gives them)
const STATUS = Object.freeze({ bad_form: 400, unauthenticated: 401, unknown_host: 401, not_granted: 403, host_revoked: 403, agent_revoked: 403, stale_generation: 409, rate: 429 });
const JSON_HEADERS = Object.freeze({ "content-type": "application/json", "cache-control": "no-store" });
const bare = (status) => ({ status, headers: { "cache-control": "no-store" }, body: new Uint8Array(0) });
const json = (status, value) => ({ status, headers: { ...JSON_HEADERS }, body: enc(canonText(value)) });
const codeOf = (e) => (e instanceof FleetError ? e.code : null);

// ---- POST /api/fleet/v1/relay/app-token (A1 §2)

/**
 * The issuer. In A1 §2's order: the account session, the body's form, the fleet the session's, the host paired, not
 * revoked and at host_gen, the agent in its current grant with the browser, the per-session bucket; then one row put,
 * and the token returned once, in this answer's body only.
 */
export async function handleAppToken({ method, target, body }, ctx) {
  if (target !== APP_TOKEN_ROUTE) return bare(404);
  if (method !== "POST") return bare(405);
  try {
    const s = ctx.requestSession;
    if (!s || (await ctx.session(s.account, s.account_session)) === null) refuse("unauthenticated");
    if (!(body instanceof Uint8Array) || body.length > ISSUE_BODY_MAX) refuse("bad_form", "the token request's body");
    const b = parseAppTokenRequest(body);
    if ((await ctx.accountOf(b.fleet)) !== s.account) refuse("not_granted", "another account's fleet");
    const h = await ctx.host(b.host);
    if (!h || h.fleet !== b.fleet) refuse("unknown_host");
    if (h.revoked) refuse("host_revoked");
    if (h.gen !== b.host_gen) refuse("stale_generation");
    const a = await ctx.agent(b.host, b.agent);
    if (!a || a.revoked || !a.browser) refuse("not_granted", "the agent has no browser in the current grant");
    if (!(await ctx.bucket(`app-token:${s.account_session}`, APP_TOKEN_RATE.limit, APP_TOKEN_RATE.windowMs))) refuse("rate");
    const token = `rt1.${b64(random(32))}`;
    const expires_ms = ctx.now + APP_TOKEN_MS;
    const row = { account: s.account, account_session: s.account_session, ...b, expires_ms };
    if (!(await ctx.tokens.put(await appTokenKey(token), row))) return bare(500); // (2^-256: a store that reuses keys)
    return json(200, { token, expires_ms });
  } catch (e) {
    const code = codeOf(e);
    if (code === null || !Object.hasOwn(STATUS, code)) return bare(500);
    return json(STATUS[code], { error: code });
  }
}

// ---- the control plane: POST /relay/admit and GET /relay/epochs (relay r2.2 §3, §5)

/**
 * One control-plane call: its method and target, the relay's MAC and timestamp, its id consumed once; then the admit
 * checks or the feed. An unauthenticated call gets a bare status, never a signed answer.
 */
export async function handleControl({ method, target, headers, body = new Uint8Array(0) }, ctx) {
  const isAdmit = target === ADMIT_ROUTE;
  let since = null;
  if (!isAdmit) { try { since = parseEpochsTarget(target); } catch { return bare(404); } }
  if (method !== (isAdmit ? "POST" : "GET")) return bare(405);
  if (!(body instanceof Uint8Array) || body.length > REQUEST_MAX || (!isAdmit && body.length !== 0)) return bare(413);
  let call;
  try { call = await verifyControlRequest({ header: headers?.[AUTH_HEADER], method, target, body }, { key: ctx.controlKey, now: ctx.now }); } catch { return bare(401); }
  // (a store that throws or rejects: a bare 500, and nothing after it runs)
  let fresh;
  try { fresh = await ctx.consumeCallId(call.id, call.ts + CALL_ID_TTL_MS); } catch { return bare(500); }
  if (fresh !== true) return bare(401);
  let fields;
  try { fields = isAdmit ? await admit(body, ctx) : await epochs(since, ctx); } catch (e) {
    const code = codeOf(e);
    if (isAdmit && ADMIT_REFUSALS.includes(code)) fields = { result: "refused", code };
    else return bare(500);
  }
  let a;
  // (state the answer's closed schema refuses, a store's bad value, say: fail closed, with nothing signed)
  try { a = await signControlAnswer({ key: ctx.controlKey, call, answer: isAdmit ? "admit" : "epochs", fields }); } catch { return bare(500); }
  return { status: a.status, headers: { ...JSON_HEADERS, "sagebrush-relay-answer": a.header }, body: a.body };
}

async function epochs(since, ctx) {
  const f = await ctx.feed(since, FEED_MAX);
  if (f === null) return { result: "refused", since, code: CURSOR_EXPIRED };
  return { result: "ok", since, cursor: f.cursor, at_ms: f.at_ms, more: f.more, agents: f.agents, accounts: f.accounts, hosts: f.hosts };
}

// (the host's state, read once and current, for the core's synchronous hostKey and currentGen)
async function hostView(ctx, hostId) {
  const h = isId(hostId) ? await ctx.host(hostId) : null;
  return {
    h,
    hostKey: (id) => { if (id !== hostId || !h) refuse("unknown_host"); if (h.revoked) refuse("host_revoked"); return h.sign_key; },
    currentGen: (id) => (id === hostId && h ? h.gen : 0),
  };
}

async function liveAgent(ctx, host, agent) {
  const a = await ctx.agent(host, agent);
  if (a?.revoked) refuse("agent_revoked");
  if (!a || !a.browser) refuse("not_granted", "the agent has no browser in the current grant");
}

/** The admit checks for one request; returns the ok answer's fields, or throws a refusal. */
async function admit(body, ctx) {
  const p = parseAdmitRequest(body);
  if (p.kind === "host" || p.kind === "commit") {
    const sig = parseSig(p.sig);
    const v = await hostView(ctx, sig.host);
    const base = { aud: ctx.aud, now: ctx.now, hostKey: v.hostKey, currentGen: v.currentGen };
    if (p.kind === "host") {
      const f = parseOpenTarget(p.target);
      if (!v.h || v.h.fleet !== f.fleet) refuse("unknown_host");
      // (the grant's browser is read after the signature, with revocation, by liveAgent: the core's check is synchronous)
      const o = await verifyHostOpen({ target: p.target, headers: { "sagebrush-sig": p.sig } }, { ...base, agentHasBrowser: () => true });
      await liveAgent(ctx, o.host, o.agent);
      const account = await ctx.accountOf(o.fleet);
      if (account === null) refuse("not_granted");
      return { result: "ok", role: "host", fleet: o.fleet, host: o.host, agent: o.agent, browser_gen: o.browser_gen, session: o.session, host_gen: o.host_gen,
        resume_n: o.resume_n, nonce: o.nonce, account, not_after_ms: v.h.grant_not_after_ms, epochs: await ctx.epochs({ account, agent: o.agent, host: o.host }) };
    }
    const c = await verifyCommit({ header: p.sig, body: unb64(p.body) }, base);
    if (!v.h || v.h.fleet !== c.fleet) refuse("unknown_host");
    await liveAgent(ctx, c.host, c.agent);
    const account = await ctx.accountOf(c.fleet);
    if (account === null) refuse("not_granted");
    return { result: "ok", role: "commit", fleet: c.fleet, host: c.host, agent: c.agent, browser_gen: c.browser_gen, session: c.session, host_gen: c.gen,
      resume_n: c.resume_n, nonce: c.nonce, host_nonce: c.host_nonce, app_request: c.app_request, account, epochs: await ctx.epochs({ account, agent: c.agent, host: c.host }) };
  }
  // the app: the verifier takes the token first and checks its row (expiry, session, binding); only then, in
  // afterToken, are the fleet's chain and the token's host read, so a failed read finds the token already spent. The
  // core's record checks after that are synchronous, over what was read.
  let chain = null, v = null, expires = null;
  const o = await verifyAppOpen({ target: p.target, headers: { "sagebrush-relay-token": p.token, "sagebrush-browser-record": p.record, "sagebrush-request": p.request } }, {
    aud: ctx.aud, now: ctx.now,
    consumeAppToken: (key) => ctx.tokens.take(key),
    sessionLive: async (account, s) => { const r = await ctx.session(account, s); expires = r?.expires_ms ?? null; return r !== null; },
    afterToken: async (row) => { chain = await ctx.chain(row.fleet); v = await hostView(ctx, row.host); },
    chainOf: (fleet) => { if (!chain) refuse("not_granted", "no such fleet"); return chain; },
    currentGen: (id) => v.currentGen(id),
  });
  if (!v.h || v.h.fleet !== o.fleet) refuse("unknown_host");
  if (v.h.revoked) refuse("host_revoked");
  await liveAgent(ctx, o.host, o.agent);
  if ((await ctx.accountOf(o.fleet)) !== o.account) refuse("not_granted", "another account's fleet");
  return { result: "ok", role: "app", fleet: o.fleet, host: o.host, agent: o.agent, browser_gen: o.browser_gen, session: o.session, host_gen: o.host_gen,
    resume_n: o.resume_n, request: o.request, account: o.account, account_session: o.account_session, account_session_expires_ms: expires,
    signer: o.signer, chain_seq: o.chain_seq, not_after_ms: o.not_after_ms, epochs: await ctx.epochs({ account: o.account, agent: o.agent, host: o.host }) };
}
