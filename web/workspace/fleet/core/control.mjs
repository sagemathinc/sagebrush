// The browser relay's control plane (agent-autonomous-browser-relay.md r2.1 §3 and §5): the contract between the relay
// (on its VM) and the fleet Worker, in the pure core so both sides run the same file. Two calls:
//
//   POST /api/fleet/v1/relay/admit             body: one open's or commit's raw facts (ADMIT_REQUEST)
//   GET  /api/fleet/v1/relay/epochs?since=<n>  no body
//
// Each call is authenticated with a relay-only service key (32 random bytes, a secret on both sides, never in argv,
// logs or a repository), both ways:
//
//   request header  Sagebrush-Relay-Auth: v1 ts=<ms>; id=<22>; mac=<43>
//                   mac = HMAC-SHA256(key, "sagebrush.relay-control.request.v1\n" METHOD "\n" target "\n"
//                                          sha256b64(body) "\n" ts "\n" id)
//   answer header   Sagebrush-Relay-Answer: v1 mac=<43>
//                   mac = HMAC-SHA256(key, "sagebrush.relay-control.answer.v1\n" status "\n" sha256b64(answer body))
//
// The answer's body is canonical JSON naming its call: { answer: "admit" | "epochs", call: <the request's id>,
// call_sha256: <the request body's digest>, ... }, so an answer verifies only for the one call it answers. The Worker
// refuses a timestamp more than 60 s off, consumes the id once (kept 10 minutes) and refuses any other method or target;
// the relay refuses an answer whose MAC, call or digest isn't its call's, and a second answer to one call (its state).
// Request bodies are at most 128 KiB, answers at most 16 KiB; both are canonical JSON and closed (the schemas below).
// A signed answer is result "ok" or "refused" with a code from a closed list (ADMIT_REFUSALS; the feed's only refusal
// is CURSOR_EXPIRED).
// Unauthenticated requests get a bare HTTP status, never a signed answer.

import { b64, concat, enc, refuse, sha256b64, unb64 } from "./bytes.mjs";
import { canonText, parseCanonical } from "./canonical.mjs";
import { crypto } from "./crypto.mjs";
import { APP_TOKEN, COMMIT_ROUTE, RECORD_HEADER_MAX } from "./relay.mjs";
import { compile } from "./schema.mjs";

export const ADMIT_ROUTE = "/api/fleet/v1/relay/admit";
export const EPOCHS_ROUTE = "/api/fleet/v1/relay/epochs";
export const AUTH_HEADER = "sagebrush-relay-auth";
export const ANSWER_HEADER = "sagebrush-relay-answer";
export const REQUEST_MAX = 128 * 1024;
export const ANSWER_MAX = 16 * 1024;
export const CONTROL_SKEW_MS = 60_000;
export const CALL_ID_TTL_MS = 10 * 60_000;
// The admit refusals the Worker can answer, closed (fleet reasons the verifiers and the live checks raise; the relay
// maps each to an HTTP status). The feed's one refusal is CURSOR_EXPIRED: a since the Worker never issued or no longer
// keeps (24 h), after which the relay closes everything and starts again from since=0.
export const ADMIT_REFUSALS = Object.freeze([
  "bad_form", "bad_audience", "clock_skew", "bad_signature", "unknown_host", "host_revoked", "agent_revoked", "stale_generation", "grant_expired",
  "not_granted", "limit", "device_unknown", "device_removed", "device_tier", "chain_fork", "browser_gen_stale", "unauthenticated",
]);
export const CURSOR_EXPIRED = "cursor_expired";
export const FEED_MAX = 80; // (entries per list in one feed answer: three full lists stay under ANSWER_MAX, tested)

const COUNT = /^(0|[1-9][0-9]{0,15})$/;
const B22 = /^[A-Za-z0-9_-]{21}[AQgw]$/;
const REQ_PREFIX = "sagebrush.relay-control.request.v1\n";
const ANS_PREFIX = "sagebrush.relay-control.answer.v1\n";

/** The service key from its secret's text (43 base64url characters: 32 bytes). Refuses anything else. */
export function controlKey(text) {
  const k = unb64(text, 32); // (exactly 43 characters, canonical, or bad_form)
  if (k.every((x) => x === 0)) refuse("bad_form", "an all-zero relay control key");
  return k;
}

const hmac = async (key, bytes) => {
  if (!(key instanceof Uint8Array) || key.length !== 32) refuse("bad_form", "the relay control key");
  const m = await crypto().hmacSha256(key, bytes);
  if (!(m instanceof Uint8Array) || m.length !== 32) throw new Error("the backend's HMAC isn't 32 bytes");
  return m;
};

/** Constant time in the bytes compared: both are 32-byte MACs. */
const macEqual = (a, b) => {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
};

const requestMac = async (key, method, target, body, ts, id) =>
  hmac(key, concat(REQ_PREFIX, `${method}\n${target}\n${await sha256b64(body)}\n${ts}\n${id}`));
const answerMac = async (key, status, body) => hmac(key, concat(ANS_PREFIX, `${status}\n${await sha256b64(body)}`));

/** The relay's side: the auth header's value for a call. `id` is 16 fresh random bytes, base64url. */
export async function signControlRequest({ key, method, target, body = new Uint8Array(0), ts, id }) {
  if (!B22.test(id) || !Number.isSafeInteger(ts) || ts < 0) refuse("bad_form", "a control call's id or ts");
  return `v1 ts=${ts}; id=${id}; mac=${b64(await requestMac(key, method, target, body, ts, id))}`;
}

/** The auth header's fields, in form: { ts, id, mac }. */
export function parseControlAuth(header) {
  if (typeof header !== "string" || header.length > 128) refuse("bad_form", "not a relay control header");
  const m = /^v1 ts=([0-9]{1,16}); id=([A-Za-z0-9_-]{22}); mac=([A-Za-z0-9_-]{43})$/.exec(header);
  if (!m || !COUNT.test(m[1]) || !Number.isSafeInteger(Number(m[1])) || !B22.test(m[2])) refuse("bad_form", "a relay control header's form");
  return { ts: Number(m[1]), id: m[2], mac: unb64(m[3], 32) };
}

/**
 * The Worker's side, after it has checked the method and target are one of the two calls: the header's form, the
 * timestamp within 60 s, the MAC. Returns { id, ts, digest } (digest: the body's sha256b64); the caller consumes id.
 */
export async function verifyControlRequest({ header, method, target, body = new Uint8Array(0) }, { key, now }) {
  const a = parseControlAuth(header);
  if (Math.abs(a.ts - now) > CONTROL_SKEW_MS) refuse("clock_skew");
  const want = await requestMac(key, method, target, body, a.ts, a.id);
  if (!macEqual(want, a.mac)) refuse("bad_signature");
  return { id: a.id, ts: a.ts, digest: await sha256b64(body) };
}

/** The Worker's side: an answer's { status, body, header } for the call { id, digest }; `fields` per the schemas. */
export async function signControlAnswer({ key, call, status = 200, answer, fields }) {
  const value = { v: 1, answer, call: call.id, call_sha256: call.digest, ...fields };
  checkAnswer(answer, value);
  const body = enc(canonText(value));
  if (body.length > ANSWER_MAX) refuse("limit", "an answer over 16 KiB");
  return { status, body, header: `v1 mac=${b64(await answerMac(key, status, body))}` };
}

/**
 * The relay's side: verify an answer to its call { id, digest } (the size cap, the MAC over status and body, canonical
 * JSON, the closed schema, the call it names). Returns the answer's value.
 */
export async function verifyControlAnswer({ header, status, body }, { key, call, answer }) {
  if (!(body instanceof Uint8Array) || body.length > ANSWER_MAX) refuse("limit", "an answer over 16 KiB");
  const m = typeof header === "string" ? /^v1 mac=([A-Za-z0-9_-]{43})$/.exec(header) : null;
  if (!m) refuse("bad_form", "a relay answer header's form");
  if (!macEqual(await answerMac(key, status, body), unb64(m[1], 32))) refuse("bad_signature");
  const value = parseCanonical(body, ANSWER_MAX);
  checkAnswer(answer, value);
  if (value.call !== call.id || value.call_sha256 !== call.digest) refuse("bad_form", "an answer to another call");
  return value;
}

// ---- the closed schemas (auth's, relay r2.1 §3): the admit request, its answer, the feed's answer

const ID = { type: "string", pattern: "^[a-z2-7]{25}[aeimquy4]$" };
const N22 = { type: "string", pattern: "^[A-Za-z0-9_-]{21}[AQgw]$" };
const COUNT_N = { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
const GEN = { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER };
const SHA = { type: "string", pattern: "^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$" };
// (an account's id and its session's id as the account service names them: opaque, printable, never the cookie)
const OPAQUE = { type: "string", pattern: "^[!-~]{1,128}$" };
const TARGET = { type: "string", minLength: 1, maxLength: 512 };
const SIG = { type: "string", minLength: 1, maxLength: 1024 };
const closed = (properties) => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
const EPOCHS = closed({ account: COUNT_N, agent: COUNT_N, host: COUNT_N });
const CALL = { v: { const: 1 }, call: N22, call_sha256: SHA };
const TUPLE = { fleet: ID, host: ID, agent: ID, browser_gen: GEN, session: ID, host_gen: GEN, resume_n: COUNT_N };
const ENTRY = closed({ id: ID, epoch: COUNT_N });
const ENTRIES = { type: "array", items: ENTRY, maxItems: FEED_MAX };

export const SCHEMAS = Object.freeze({
  request: {
    oneOf: [
      closed({ v: { const: 1 }, kind: { const: "host" }, target: TARGET, sig: SIG }),
      closed({ v: { const: 1 }, kind: { const: "app" }, target: TARGET, record: { type: "string", pattern: "^[A-Za-z0-9_-]+$", maxLength: RECORD_HEADER_MAX }, request: N22,
        token: { type: "string", pattern: APP_TOKEN.source } }),
      closed({ v: { const: 1 }, kind: { const: "commit" }, target: { const: COMMIT_ROUTE }, sig: SIG, body: { type: "string", pattern: "^[A-Za-z0-9_-]{1,1366}$" } }),
    ],
  },
  admit: {
    oneOf: [
      closed({ ...CALL, answer: { const: "admit" }, result: { const: "refused" }, code: { enum: ADMIT_REFUSALS } }),
      // (a host's not_after_ms is its grant's end, null for a grant without one)
      closed({ ...CALL, answer: { const: "admit" }, result: { const: "ok" }, role: { const: "host" }, ...TUPLE, nonce: N22, account: OPAQUE,
        not_after_ms: { oneOf: [COUNT_N, { type: "null" }] }, epochs: EPOCHS }),
      closed({ ...CALL, answer: { const: "admit" }, result: { const: "ok" }, role: { const: "app" }, ...TUPLE, request: N22, account: OPAQUE,
        account_session: OPAQUE, account_session_expires_ms: COUNT_N, signer: ID, chain_seq: COUNT_N, not_after_ms: COUNT_N, epochs: EPOCHS }),
      closed({ ...CALL, answer: { const: "admit" }, result: { const: "ok" }, role: { const: "commit" }, ...TUPLE, nonce: N22, host_nonce: N22,
        app_request: N22, account: OPAQUE, epochs: EPOCHS }),
    ],
  },
  epochs: {
    oneOf: [
      closed({ ...CALL, answer: { const: "epochs" }, result: { const: "ok" }, since: COUNT_N, cursor: GEN, at_ms: COUNT_N, more: { type: "boolean" }, agents: ENTRIES,
        accounts: { type: "array", items: closed({ id: OPAQUE, epoch: COUNT_N }), maxItems: FEED_MAX }, hosts: ENTRIES }),
      closed({ ...CALL, answer: { const: "epochs" }, result: { const: "refused" }, since: COUNT_N, code: { const: CURSOR_EXPIRED } }),
    ],
  },
});

const validators = new Map();
const validator = (name) => {
  if (!validators.has(name)) validators.set(name, compile(SCHEMAS[name]));
  return validators.get(name);
};
// (the validator refuses bad_form, naming only the schema path)
const check = (name, value) => validator(name)(value);

function checkAnswer(answer, value) {
  if (answer !== "admit" && answer !== "epochs") refuse("bad_form", "no such answer");
  check(answer, value);
  if (answer === "epochs" && value.result === "ok") {
    if (value.cursor <= value.since) refuse("bad_form", "a feed cursor that isn't ahead of since");
    for (const list of ["agents", "accounts", "hosts"]) {
      const ids = value[list].map((e) => e.id);
      if (new Set(ids).size !== ids.length) refuse("bad_form", `an identity listed twice in ${list}`);
    }
  }
}

/** The Worker's side: an admit request's body, closed (canonical JSON, at most 128 KiB, the request schema). */
export function parseAdmitRequest(body) {
  if (!(body instanceof Uint8Array)) refuse("bad_form", "an admit request's body");
  const value = parseCanonical(body, REQUEST_MAX);
  check("request", value);
  return value;
}

/** An epochs call's target: exactly EPOCHS_ROUTE?since=<n>. Returns since. */
export function parseEpochsTarget(target) {
  if (typeof target !== "string" || target.length > 64 || !target.startsWith(`${EPOCHS_ROUTE}?since=`)) refuse("bad_form", "not the epochs route");
  const s = target.slice(EPOCHS_ROUTE.length + 7);
  if (!COUNT.test(s) || !Number.isSafeInteger(Number(s))) refuse("bad_form", "since isn't an exact count");
  return Number(s);
}

/** The epochs call's target for a cursor. */
export const epochsTarget = (since) => `${EPOCHS_ROUTE}?since=${since}`;
