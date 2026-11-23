// The fleet Worker's two control-plane endpoints for the browser relay (agent-autonomous-browser-relay.md r2.1 §3 and
// §5; the contract is the fleet core's control.mjs, vendored byte for byte from sagebrush-agent in vendor/fleet-core/):
//
//   POST /api/fleet/v1/relay/admit             one open's or commit's raw facts -> a signed refusal, or ok with every
//                                              verified fact the relay matches on
//   GET  /api/fleet/v1/relay/epochs?since=<n>  the agents, accounts and hosts whose epoch changed since the cursor,
//                                              with a new cursor on every answer
//
// A call's steps, in order, each failing closed:
//   1 the kill switch (FLEET_RELAY_OPEN "1") and the service key's form (RELAY_CONTROL_KEY, 32 bytes): 503;
//   2 exactly one of the two method and target pairs: 404 or 405;
//   3 the body: POST at most 128 KiB by its declared length and by what is read, GET none: 413 or 400;
//   4 the service MAC, the timestamp within 60 s: 401;
//   5 the call's id consumed once, in D1 (kept 10 minutes): 409;
//   6 the endpoint, answering a signed refusal or a signed ok bound to the call's id and body digest.
// Steps 1 to 5 answer a bare status: nothing is signed for a caller that hasn't proved the key.  An internal failure
// (D1, the fleet state) is a bare 503.  The Worker consumes nothing of the relay's (host nonces, app request ids,
// commit authorizations): the relay does, after an ok.
//
// The live facts an admission checks (the fleet's owner and device chain, its hosts' keys, generations and
// revocations, the agent's grant, the account session behind a cookie) belong to the fleet service, which doesn't exist
// yet: they come through FleetFacts, and until it is built the Worker runs with NO_FACTS, which refuses every open.
// Logs: one line per call with a fixed code, the endpoint and the duration.  Never a cookie, a record, a signature, a
// nonce, an id, the key or an answer's facts.

import {
  ADMIT_REFUSALS, ADMIT_ROUTE, ANSWER_HEADER, AUTH_HEADER, EPOCHS_ROUTE, FEED_MAX, REQUEST_MAX, controlKey, parseAdmitRequest,
  parseEpochsTarget, signControlAnswer, verifyControlRequest,
} from "./vendor/fleet-core/core/control.mjs";
import { parseCommit, parseOpenTarget, verifyAppOpen, verifyCommit, verifyHostOpen } from "./vendor/fleet-core/core/relay.mjs";
import { parseSig } from "./vendor/fleet-core/core/request.mjs";
import { FleetError, refuse, unb64 } from "./vendor/fleet-core/core/bytes.mjs";
import { consumeCall, readEpochs, readFeed, type Epochs } from "./store.ts";
import { useCrypto } from "./vendor/fleet-core/core/crypto.mjs";
import { webCrypto } from "./vendor/fleet-core/core/webcrypto.mjs";
import { useSchemas } from "./vendor/fleet-core/core/schemas.mjs";
import FLEET_SCHEMA from "./vendor/fleet-core/schema/fleet.schema.json" with { type: "json" };
import REASONS from "./vendor/fleet-core/schema/reasons.json" with { type: "json" };

// (the core's one backend, WebCrypto, and its frozen schemas, bundled: installed once, when this module loads; the
// core refuses schemas of any other revision)
const SCHEMA_FILES: Record<string, unknown> = { "fleet.schema.json": FLEET_SCHEMA, "reasons.json": REASONS };
useCrypto(webCrypto());
useSchemas((name: string) => SCHEMA_FILES[name]);

export interface FleetEnv {
  FLEET_RELAY_OPEN?: string;
  FLEET_AUD: string;
  RELAY_CONTROL_KEY?: string;
  FLEET_RELAY_DB: D1Database;
}

/** One host of the fleet as the fleet service knows it. */
export interface HostFacts {
  signKey: Uint8Array; // its Ed25519 public key (from its certificate)
  gen: number; // its current host_gen
  revoked: boolean;
}

/** One read of the fleet service's state for an admission. */
export interface Snapshot {
  account: string; // the fleet's owner
  chain: unknown; // the fleet's device chain, replayed (the core's chain state)
  hosts: Map<string, HostFacts>;
  agent: { host: string; browser: boolean; revoked: boolean; notAfterMs: number | null } | null; // its current grant
  session: { account: string; session: string; expiresMs: number } | null; // the cookie's account session, if asked
}

/** The fleet service's state, read-only.  null: no such fleet. */
export interface FleetFacts {
  snapshot(q: { fleet: string; agent: string; cookie?: string }, now: number): Promise<Snapshot | null>;
}

/** Until the fleet service exists: no fleet is known, so every open is refused (not_granted). */
export const NO_FACTS: FleetFacts = { snapshot: async () => null };

export interface FleetOptions {
  facts: FleetFacts;
  now?: () => number;
}

const BODY_DEADLINE_MS = 5_000;
const LIMIT_CHANGES = 3 * FEED_MAX;
// (a feed answer's bytes with every list empty and every number at its widest; each entry is counted at its own size)
const FEED_BASE_BYTES = 400;
const FEED_BUDGET = 16 * 1024 - FEED_BASE_BYTES;

function log(code: string, extra: Record<string, string | number> = {}): void {
  console.log(JSON.stringify({ code, ...extra }));
}
const bare = (status: number) => new Response(null, { status, headers: { "cache-control": "no-store" } });

/** The Worker's one entry: the relay's two calls, or null for any other path. */
export async function handleFleet(req: Request, env: FleetEnv, opts: FleetOptions): Promise<Response | null> {
  const url = new URL(req.url);
  if (!url.pathname.startsWith("/api/fleet/v1/relay/")) return null;
  const started = Date.now();
  const r = await call(req, url, env, opts);
  log(r.code, { route: url.pathname === ADMIT_ROUTE ? "admit" : url.pathname === EPOCHS_ROUTE ? "epochs" : "other", ms: Date.now() - started });
  return r.response;
}

async function call(req: Request, url: URL, env: FleetEnv, opts: FleetOptions): Promise<{ code: string; response: Response }> {
  const now = (opts.now ?? Date.now)();
  if (env.FLEET_RELAY_OPEN !== "1") return { code: "closed", response: bare(503) };
  let key: Uint8Array;
  try {
    key = controlKey(env.RELAY_CONTROL_KEY);
  } catch {
    return { code: "no-key", response: bare(503) };
  }
  // (the raw target, as the relay signed it: the path and query exactly as received)
  const target = url.pathname + url.search;
  let endpoint: "admit" | "epochs";
  let since = 0;
  if (url.pathname === ADMIT_ROUTE) {
    if (req.method !== "POST") return { code: "method", response: bare(405) };
    if (url.search !== "") return { code: "target", response: bare(404) };
    endpoint = "admit";
  } else if (url.pathname === EPOCHS_ROUTE) {
    if (req.method !== "GET") return { code: "method", response: bare(405) };
    try {
      since = parseEpochsTarget(target);
    } catch {
      return { code: "target", response: bare(404) };
    }
    endpoint = "epochs";
  } else return { code: "target", response: bare(404) };

  let body: Uint8Array<ArrayBuffer>;
  if (endpoint === "admit") {
    const declared = req.headers.get("content-length");
    if (declared === null || !/^(0|[1-9][0-9]{0,8})$/.test(declared)) return { code: "length", response: bare(411) };
    if (Number(declared) > REQUEST_MAX) return { code: "too-large", response: bare(413) };
    const read = await readBody(req, Number(declared));
    if (typeof read === "string") return { code: read, response: bare(read === "too-large" ? 413 : 400) };
    body = read;
  } else {
    if (req.body !== null && req.headers.get("content-length") !== "0") return { code: "body", response: bare(400) };
    body = new Uint8Array(0);
  }

  let callId: { id: string; ts: number; digest: string };
  try {
    callId = await verifyControlRequest({ header: req.headers.get(AUTH_HEADER), method: req.method, target, body }, { key, now });
  } catch (e) {
    if (e instanceof FleetError) return { code: "unauthenticated", response: bare(401) };
    throw e;
  }
  try {
    if (!(await consumeCall(env.FLEET_RELAY_DB, callId.id, Math.max(callId.ts, now)))) return { code: "call-replay", response: bare(409) };
    const answer = endpoint === "admit" ? await admit(body, env, opts.facts, now) : await epochs(env.FLEET_RELAY_DB, since, now);
    const signed = await signControlAnswer({ key, call: { id: callId.id, digest: callId.digest }, answer: endpoint, fields: answer.fields });
    return {
      code: answer.code,
      response: new Response(signed.body, {
        status: signed.status,
        headers: { "content-type": "application/json", "cache-control": "no-store", [ANSWER_HEADER]: signed.header },
      }),
    };
  } catch (e) {
    // (D1 or the fleet state failed, or a check raised what no refusal names: nothing is signed)
    log("internal", { error: e instanceof FleetError ? e.code : "exception" });
    return { code: "internal", response: bare(503) };
  }
}

// The body: exactly its declared length, never more than the cap, within the deadline.
async function readBody(req: Request, declared: number): Promise<Uint8Array<ArrayBuffer> | "too-large" | "length-mismatch" | "timeout" | "aborted"> {
  if (req.body === null) return declared === 0 ? new Uint8Array(0) : "length-mismatch";
  const reader = req.body.getReader();
  const stop = () => void reader.cancel().catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), BODY_DEADLINE_MS);
  });
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      let step: ReadableStreamReadResult<Uint8Array> | "timeout";
      try {
        step = await Promise.race([reader.read(), expired]);
      } catch {
        stop();
        return "aborted";
      }
      if (step === "timeout") {
        stop();
        return "timeout";
      }
      if (step.done) break;
      total += step.value.length;
      if (total > REQUEST_MAX || total > declared) {
        stop();
        return total > REQUEST_MAX ? "too-large" : "length-mismatch";
      }
      chunks.push(step.value);
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  if (total !== declared) return "length-mismatch";
  const out = new Uint8Array(total);
  let i = 0;
  for (const c of chunks) {
    out.set(c, i);
    i += c.length;
  }
  return out;
}

type Answer = { code: string; fields: Record<string, unknown> };

// (the core is JavaScript: these name the fields its parsers and verifiers return, as this file uses them)
interface OpenFields { role: string; fleet: string; session: string; agent: string; browser_gen: number; host_gen: number; resume_n: number }
interface HostOpened extends OpenFields { host: string; nonce: string }
interface AppOpened extends OpenFields { host: string; request: string; signer: string; chain_seq: number; not_after_ms: number }
interface CommitFields { fleet: string; session: string; agent: string; browser_gen: number; resume_n: number; host_nonce: string; app_request: string }
interface CommitVerified extends CommitFields { host: string; gen: number; nonce: string }
const refused = (code: string): Answer => ({ code: `refused-${code}`, fields: { result: "refused", code } });

// ---- /relay/admit

/**
 * The snapshot, read as the late-answer rule needs (store.ts): the facts once to learn which account and host the
 * epochs are for, then the epochs, then the facts again (those checked), which must name the same account and host.
 */
async function snapshot(db: D1Database, facts: FleetFacts, q: { fleet: string; agent: string; cookie?: string }, now: number): Promise<{ snap: Snapshot; epochs: Epochs } | null> {
  const first = await facts.snapshot(q, now);
  if (!first) return null;
  const host = first.agent?.host ?? "";
  const epochs = await readEpochs(db, { account: first.account, agent: q.agent, host });
  const snap = await facts.snapshot(q, now);
  if (!snap || snap.account !== first.account || (snap.agent?.host ?? "") !== host) return null;
  return { snap, epochs };
}

/** The checks' ctx over one snapshot: the host's key and generation, the agent's grant. */
function ctxOf(snap: Snapshot, aud: string, now: number, agent: string) {
  const host = (h: string): HostFacts => {
    const f = snap.hosts.get(h);
    if (!f) refuse("unknown_host");
    if (f!.revoked) refuse("host_revoked");
    return f!;
  };
  return {
    aud,
    now,
    hostKey: (h: string) => host(h).signKey,
    currentGen: (h: string) => host(h).gen,
    // (the agent's current grant names this host and gives it the browser)
    agentHasBrowser: (h: string, a: string) => {
      if (a !== agent || !snap.agent) return false;
      if (snap.agent.revoked) refuse("agent_revoked");
      return snap.agent.host === h && snap.agent.browser;
    },
    chainOf: () => snap.chain,
  };
}

function grantInForce(snap: Snapshot, now: number): void {
  const end = snap.agent?.notAfterMs;
  if (end !== null && end !== undefined && now >= end) refuse("grant_expired");
}

async function admit(body: Uint8Array, env: FleetEnv, facts: FleetFacts, now: number): Promise<Answer> {
  try {
    const req = parseAdmitRequest(body) as Record<string, string> & { kind: "host" | "app" | "commit" };
    const db = env.FLEET_RELAY_DB;
    if (req.kind === "host") {
      const f = parseOpenTarget(req.target) as OpenFields;
      if (f.role !== "host") refuse("bad_form", "not a host open");
      const s = await snapshot(db, facts, { fleet: f.fleet, agent: f.agent }, now);
      if (!s) refuse("not_granted");
      const { snap, epochs } = s!;
      const v = (await verifyHostOpen({ target: req.target, headers: { "sagebrush-sig": req.sig } }, ctxOf(snap, env.FLEET_AUD, now, f.agent))) as HostOpened;
      grantInForce(snap, now);
      return {
        code: "ok-host",
        fields: {
          result: "ok", role: "host", fleet: v.fleet, host: v.host, agent: v.agent, browser_gen: v.browser_gen, session: v.session, host_gen: v.host_gen,
          resume_n: v.resume_n, nonce: v.nonce, account: snap.account, not_after_ms: snap.agent!.notAfterMs, epochs,
        },
      };
    }
    if (req.kind === "app") {
      const f = parseOpenTarget(req.target) as OpenFields;
      if (f.role !== "app") refuse("bad_form", "not an app open");
      const s = await snapshot(db, facts, { fleet: f.fleet, agent: f.agent, cookie: req.cookie }, now);
      if (!s) refuse("not_granted");
      const { snap, epochs } = s!;
      const session = snap.session;
      if (!session || now >= session.expiresMs) refuse("not_granted", "no account session");
      const ctx = { ...ctxOf(snap, env.FLEET_AUD, now, f.agent), accountFleets: () => (session!.account === snap.account ? [f.fleet] : []) };
      const v = (await verifyAppOpen({ target: req.target, headers: { "sagebrush-browser-record": req.record, "sagebrush-request": req.request } }, ctx)) as AppOpened;
      // (the record's host is the agent's, and the agent's grant gives it the browser now)
      if (!ctx.agentHasBrowser(v.host, v.agent)) refuse("not_granted", "the agent has no browser in the current grant");
      grantInForce(snap, now);
      return {
        code: "ok-app",
        fields: {
          result: "ok", role: "app", fleet: v.fleet, host: v.host, agent: v.agent, browser_gen: v.browser_gen, session: v.session, host_gen: v.host_gen,
          resume_n: v.resume_n, request: v.request, account: session!.account, account_session: session!.session,
          account_session_expires_ms: session!.expiresMs, signer: v.signer, chain_seq: v.chain_seq, not_after_ms: v.not_after_ms, epochs,
        },
      };
    }
    // a commit: the broker's replacement authorization, checked like a host open
    const raw = unb64(req.body);
    const c = parseCommit(raw) as CommitFields;
    parseSig(req.sig);
    const s = await snapshot(db, facts, { fleet: c.fleet, agent: c.agent }, now);
    if (!s) refuse("not_granted");
    const { snap, epochs } = s!;
    const ctx = ctxOf(snap, env.FLEET_AUD, now, c.agent);
    const v = (await verifyCommit({ header: req.sig, body: raw }, ctx)) as CommitVerified;
    if (!ctx.agentHasBrowser(v.host, v.agent)) refuse("not_granted", "the agent has no browser in the current grant");
    grantInForce(snap, now);
    return {
      code: "ok-commit",
      fields: {
        result: "ok", role: "commit", fleet: v.fleet, host: v.host, agent: v.agent, browser_gen: v.browser_gen, session: v.session, host_gen: v.gen,
        resume_n: v.resume_n, nonce: v.nonce, host_nonce: v.host_nonce, app_request: v.app_request, account: snap.account, epochs,
      },
    };
  } catch (e) {
    if (e instanceof FleetError && (ADMIT_REFUSALS as readonly string[]).includes(e.code)) return refused(e.code);
    throw e;
  }
}

// ---- /relay/epochs

async function epochs(db: D1Database, since: number, now: number): Promise<Answer> {
  const read = await readFeed(db, since, LIMIT_CHANGES + 1);
  if (read.expired) return { code: "refused-cursor_expired", fields: { result: "refused", since, code: "cursor_expired" } };
  // (each identity once per list, at its highest epoch; at most FEED_MAX a list and the answer within 16 KiB: past
  // either, the answer stops at the last change it took, its cursor that change's seq, and says more)
  const lists = { agent: new Map<string, number>(), account: new Map<string, number>(), host: new Map<string, number>() };
  let bytes = 0;
  let cursor = read.tick;
  let more = false;
  for (const [i, c] of read.changes.entries()) {
    const list = lists[c.kind];
    const fresh = !list.has(c.id);
    const cost = fresh ? 40 + c.id.length : 0;
    if (i >= LIMIT_CHANGES || (fresh && (list.size >= FEED_MAX || bytes + cost > FEED_BUDGET))) {
      cursor = read.changes[i - 1].seq;
      more = true;
      break;
    }
    list.set(c.id, Math.max(list.get(c.id) ?? 0, c.epoch));
    bytes += cost;
  }
  const entries = (m: Map<string, number>) => [...m].map(([id, epoch]) => ({ id, epoch }));
  return {
    code: more ? "feed-more" : "feed",
    fields: { result: "ok", since, cursor, at_ms: now, more, agents: entries(lists.agent), accounts: entries(lists.account), hosts: entries(lists.host) },
  };
}

