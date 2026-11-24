// The support Worker (support.sagebrush.space; support-dev.sagebrush.space with `--mode dev`): the "Report an
// issue / request support" page (./page.ts) and its one API, POST /api/v1/requests, which checks a request and
// passes it to CoCalc's support system (/api/v2/support/sagebrush-intake, which creates the Zendesk ticket).  The
// plan is plan-support-requests r12 (§2 the page, §3 this Worker, §6 the limits).
//
// The request's steps run in this order and fail closed; the body isn't read before the Turnstile check:
//   1 the kill switch (SUPPORT_OPEN), the CoCalc URL's allowlist and, in production, the Turnstile test-key ban;
//   2 the Origin, byte-exact (no CORS);
//   3 Content-Type and Content-Length (at most 131,072 bytes);
//   4 the client IP (CF-Connecting-IP, an IP literal), SUPPORT_IP's flood gate and this isolate's admission (8);
//   5 X-Submission-Id, a UUIDv4 (only for the answer's ref and a line in the ticket; never a retry identity);
//   6 Turnstile siteverify (secret and response only; no idempotency key, no remoteip), then the body, read by a
//     counting reader that cancels past the cap or the declared length;
//   7 a strict parse: one flat object, the closed keys {kind, title, description, email?}, strings only;
//   8 the account-wide abuse backstop (D1: fewer than 600 this UTC hour AND 3,000 this UTC day, both or neither,
//     never refunded);
//   9 one call to CoCalc, mapped by its HTTP status only.
// Logs carry fixed codes and CoCalc's status only: never an IP, a header, the body, an email or CoCalc's answer.

export interface SupportEnv {
  SUPPORT_OPEN?: string;
  SUPPORT_ORIGIN: string;
  TURNSTILE_SITE_KEY: string;
  TURNSTILE_SECRET: string;
  COCALC_INTAKE_URL: string;
  COCALC_INTAKE_KEY: string;
  SUPPORT_IP: { limit(o: { key: string }): Promise<{ success: boolean }> };
  SUPPORT_DB: D1Database;
}

export interface SupportOptions {
  // production: Turnstile's test keys are refused, and CoCalc is exactly PROD_INTAKE_URL
  prod: boolean;
  // (tests only, test-entry.ts: called with the body's size right after the bounded read, while the request holds
  // its admission slot and its bytes)
  onBodyRead?: (bytes: number) => Promise<void>;
  // (tests only, test-entry.ts: the backstop's clock, so its hour and day windows are tested at a fixed time and never
  // across a real UTC boundary mid-test; the Worker itself runs on Date.now)
  backstopNow?: () => number;
}

export const MAX_BODY_BYTES = 131_072;
export const MAX_TOKEN_BYTES = 2_048;
export const MAX_ANSWER_BYTES = 16_384;
export const MAX_IN_FLIGHT = 8;
export const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
export const SITEVERIFY_DEADLINE_MS = 5_000;
export const COCALC_DEADLINE_MS = 10_000;
export const PROD_INTAKE_URL = "https://cocalc.ai/api/v2/support/sagebrush-intake";
export const INTAKE_PATH = "/api/v2/support/sagebrush-intake";
export const TURNSTILE_ACTION = "support";
export const TOKEN_MAX_AGE_MS = 300_000;
// (the whole body's read, from its first byte to its last: a stalled or abandoned upload gives up its slot then)
export const BODY_DEADLINE_MS = 10_000;
export const HOUR_LIMIT = 600;
export const DAY_LIMIT = 3_000;
export const KINDS = ["bug", "pkg", "feat", "book", "other"] as const;
export type Kind = (typeof KINDS)[number];
const FIELDS = new Set(["kind", "title", "description", "email"]);
export const MIN_TITLE = 5;
export const MAX_TITLE = 180;
export const MIN_DESCRIPTION = 10;
export const MAX_DESCRIPTION = 19_000;
export const MAX_SUBJECT = 200;
export const MAX_EMAIL_BYTES = 254;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
// (Turnstile's documented test site keys and secrets: 1x00000000000000000000AA, 2x0000000000000000000000000000000AA, ...)
const TEST_KEY = /^[0-9]x0{20,}[A-F]{2}$/;
const SITE_KEY = /^[0-9A-Za-z_-]{1,64}$/;

export interface SupportRequest {
  kind: Kind;
  title: string;
  description: string;
  email?: string;
}

// (this isolate's requests past step 4, at most MAX_IN_FLIGHT: about 1 MiB of bodies)
let inFlight = 0;

const enc = new TextEncoder();
const bytes = (s: string) => enc.encode(s).length;

function log(code: string, extra: Record<string, string | number> = {}): void {
  console.log(JSON.stringify({ code, ...extra }));
}

function json(status: number, body: object, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...headers },
  });
}
const fail = (status: number, error: string, headers: Record<string, string> = {}) => json(status, { error }, headers);

export function isTestKey(key: string | undefined): boolean {
  return TEST_KEY.test(`${key ?? ""}`);
}

// The CoCalc URL this deployment may call: production's fixed one; DEV's an https URL on cocalc.ai or a host under
// it, with exactly the intake path, no port, credentials, query or fragment.
export function intakeUrlAllowed(value: string, prod: boolean): boolean {
  if (prod) return value === PROD_INTAKE_URL;
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return false;
  }
  return (
    u.protocol === "https:" &&
    (u.hostname === "cocalc.ai" || u.hostname.endsWith(".cocalc.ai")) &&
    u.port === "" &&
    u.username === "" &&
    u.password === "" &&
    value === u.origin + INTAKE_PATH
  );
}

// An IPv4 or IPv6 literal, as Cloudflare sets CF-Connecting-IP (no list, port, brackets or zone).
export function isIpLiteral(v: string): boolean {
  if (v.length === 0 || v.length > 45) return false;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(v);
  if (m) return m.slice(1).every((p) => Number(p) <= 255 && (p === "0" || !p.startsWith("0")));
  if (!/^[0-9A-Fa-f:.]+$/.test(v) || !v.includes(":")) return false;
  try {
    return new URL(`http://[${v}]/`).hostname.length > 2;
  } catch {
    return false;
  }
}

// The API, or null for any other path (the page's, ./page.ts).
export async function handleApi(req: Request, env: SupportEnv, opts: SupportOptions): Promise<Response | null> {
  if (new URL(req.url).pathname !== "/api/v1/requests") return null;
  if (req.method !== "POST") return fail(405, "method-not-allowed", { allow: "POST" });
  return handleRequest(req, env, opts);
}

async function handleRequest(req: Request, env: SupportEnv, opts: SupportOptions): Promise<Response> {
  // 1. the kill switch; the CoCalc URL; production never runs on Turnstile's test keys
  if (env.SUPPORT_OPEN !== "1") return fail(503, "closed");
  if (!intakeUrlAllowed(env.COCALC_INTAKE_URL, opts.prod)) {
    log("support-intake-url-invalid");
    return fail(503, "unavailable");
  }
  if (opts.prod && (isTestKey(env.TURNSTILE_SITE_KEY) || isTestKey(env.TURNSTILE_SECRET))) {
    log("support-test-key-in-prod");
    return fail(503, "unavailable");
  }
  // 2. the origin, byte-exact
  if (req.headers.get("origin") !== env.SUPPORT_ORIGIN) return fail(403, "origin");
  // 3. the body's type and declared length
  const type = req.headers.get("content-type") ?? "";
  if (type.split(";")[0].trim().toLowerCase() !== "application/json") return fail(415, "unsupported-media-type");
  const length = req.headers.get("content-length");
  if (length === null) return fail(411, "length-required");
  if (!/^[0-9]{1,16}$/.test(length)) return fail(400, "bad-request");
  const declared = Number(length);
  if (declared > MAX_BODY_BYTES) return fail(413, "too-large");
  // 4. the client, its flood gate, and this isolate's admission
  const ip = req.headers.get("cf-connecting-ip") ?? "";
  if (!isIpLiteral(ip)) return fail(400, "bad-request");
  if (!(await env.SUPPORT_IP.limit({ key: ip })).success) return fail(429, "rate-limited");
  if (inFlight >= MAX_IN_FLIGHT) return fail(503, "busy", { "retry-after": "5" });
  inFlight++;
  try {
    return await admitted(req, env, ip, declared, opts);
  } finally {
    inFlight--;
  }
}

async function admitted(req: Request, env: SupportEnv, ip: string, declared: number, opts: SupportOptions): Promise<Response> {
  // 5. the submission id
  const submission_id = req.headers.get("x-submission-id") ?? "";
  if (!UUID_V4.test(submission_id)) return fail(400, "bad-request");
  // 6. Turnstile, then the body
  const token = req.headers.get("x-turnstile-token") ?? "";
  if (token.length === 0 || bytes(token) > MAX_TOKEN_BYTES) return fail(403, "challenge");
  if (!(await siteverify(env, token))) return fail(403, "challenge");
  const raw = await readRequestBody(req, declared);
  if (raw === "too-large") return fail(413, "too-large");
  if (raw === "timeout") return fail(408, "body-timeout");
  if (raw === "length-mismatch" || raw === "aborted") return fail(400, "bad-request");
  if (opts.onBodyRead) await opts.onBodyRead(raw.length);
  // 7. the strict parse
  const parsed = parseSupportRequest(raw);
  if (parsed === undefined) return fail(400, "bad-request");
  // 8. the abuse backstop
  const now = (opts.backstopNow ?? Date.now)();
  let gate: "ok" | "hour" | "day";
  try {
    gate = await admitBackstop(env.SUPPORT_DB, now);
  } catch {
    // (D1 down, or the table never migrated: nothing is admitted, nothing is sent)
    log("support-backstop-unavailable");
    return fail(503, "unavailable");
  }
  if (gate !== "ok") {
    log("support-backstop-exhausted", { window: gate });
    return fail(503, "busy", { "retry-after": `${retryAfter(gate, now)}` });
  }
  // 9. CoCalc
  return callCocalc(env, ip, submission_id, parsed);
}

// Siteverify: true only for a fresh, successful challenge of this action on this Worker's own host.
async function siteverify(env: SupportEnv, token: string): Promise<boolean> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), SITEVERIFY_DEADLINE_MS);
  try {
    const form = new FormData();
    form.append("secret", env.TURNSTILE_SECRET);
    form.append("response", token);
    const r = await fetch(SITEVERIFY_URL, { method: "POST", body: form, redirect: "manual", signal: ctl.signal });
    if (r.status !== 200) {
      await r.body?.cancel();
      return false;
    }
    const body = await readBounded(r.body, MAX_ANSWER_BYTES);
    if (body === undefined) return false;
    const v = JSON.parse(new TextDecoder().decode(body));
    if (!v || typeof v !== "object" || v.success !== true) return false;
    if (v.hostname !== new URL(env.SUPPORT_ORIGIN).hostname || v.action !== TURNSTILE_ACTION) return false;
    const ts = typeof v.challenge_ts === "string" ? Date.parse(v.challenge_ts) : NaN;
    const now = Date.now();
    // (never in the future, at most TOKEN_MAX_AGE_MS old)
    return Number.isFinite(ts) && ts <= now && now - ts <= TOKEN_MAX_AGE_MS;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

// A response body, at most max bytes; undefined (and the stream cancelled) past it.
async function readBounded(body: ReadableStream<Uint8Array> | null, max: number): Promise<Uint8Array | undefined> {
  if (body === null) return new Uint8Array();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > max) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(value);
  }
  return concat(chunks, total);
}

// The request body: exactly its declared length, never more than the cap, within BODY_DEADLINE_MS: a body longer
// or shorter than declared is "length-mismatch", one not complete by the deadline "timeout", one whose stream fails
// (the client went away) "aborted"; the stream is cancelled as soon as the outcome is known.
export async function readRequestBody(
  req: Request,
  declared: number,
  deadlineMs: number = BODY_DEADLINE_MS,
): Promise<Uint8Array | "too-large" | "length-mismatch" | "timeout" | "aborted"> {
  if (req.body === null) return declared === 0 ? new Uint8Array() : "length-mismatch";
  const reader = req.body.getReader();
  const stop = () => void reader.cancel().catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), deadlineMs);
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
      if (total > MAX_BODY_BYTES || total > declared) {
        stop();
        return total > MAX_BODY_BYTES ? "too-large" : "length-mismatch";
      }
      chunks.push(step.value);
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  return total === declared ? concat(chunks, total) : "length-mismatch";
}

function concat(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let i = 0;
  for (const c of chunks) {
    out.set(c, i);
    i += c.length;
  }
  return out;
}

// One flat JSON object whose values are strings, with only the closed keys, none repeated (also when escaped);
// undefined for anything else.
export function parseSupportRequest(raw: Uint8Array): SupportRequest | undefined {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(raw);
  } catch {
    return;
  }
  const f = parseFlatStringObject(text);
  if (f === undefined) return;
  const { kind, title, description, email } = f;
  if (kind === undefined || !(KINDS as readonly string[]).includes(kind)) return;
  if (title === undefined || title.length < MIN_TITLE || title.length > MAX_TITLE) return;
  if (description === undefined || description.length < MIN_DESCRIPTION || description.length > MAX_DESCRIPTION) return;
  if (email !== undefined && bytes(email) > MAX_EMAIL_BYTES) return;
  const request: SupportRequest = { kind: kind as Kind, title, description, ...(email !== undefined ? { email } : {}) };
  // (belt and braces: the subject CoCalc composes, at most 200 code units for every kind)
  if (composeSubject(request).length > MAX_SUBJECT) return;
  return request;
}

export const composeSubject = (r: { kind: string; title: string }) => `[sagebrush] ${r.kind}: ${r.title}`;

function parseFlatStringObject(text: string): Record<string, string> | undefined {
  const fields: Record<string, string> = Object.create(null);
  let i = skipSpace(text, 0);
  if (text[i] !== "{") return;
  i = skipSpace(text, i + 1);
  if (text[i] === "}") return skipSpace(text, i + 1) === text.length ? fields : undefined;
  for (;;) {
    const key = readString(text, i);
    if (key === undefined || !FIELDS.has(key.value) || key.value in fields) return;
    i = skipSpace(text, key.end);
    if (text[i] !== ":") return;
    const value = readString(text, skipSpace(text, i + 1));
    if (value === undefined) return;
    fields[key.value] = value.value;
    i = skipSpace(text, value.end);
    if (text[i] === ",") i = skipSpace(text, i + 1);
    else if (text[i] === "}") return skipSpace(text, i + 1) === text.length ? fields : undefined;
    else return;
  }
}

function skipSpace(text: string, i: number): number {
  while (i < text.length && " \t\n\r".includes(text[i])) i++;
  return i;
}

// A JSON string at text[start]: scanned here, decoded by JSON.parse (so its escapes are JSON's exactly); lone
// surrogates are refused.
function readString(text: string, start: number): { value: string; end: number } | undefined {
  if (text[start] !== '"') return;
  let i = start + 1;
  while (i < text.length) {
    const c = text.charCodeAt(i);
    if (c === 0x22) break;
    if (c < 0x20) return;
    i += c === 0x5c ? 2 : 1;
  }
  if (i >= text.length) return;
  let value: unknown;
  try {
    value = JSON.parse(text.slice(start, i + 1));
  } catch {
    return;
  }
  if (typeof value !== "string" || !wellFormed(value)) return;
  return { value, end: i + 1 };
}

function wellFormed(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const n = s.charCodeAt(i + 1);
      if (!(n >= 0xdc00 && n <= 0xdfff)) return false;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) return false;
  }
  return true;
}

// The backstop windows: "h:YYYY-MM-DDTHH" and "d:YYYY-MM-DD" (UTC).
export function windows(now: number): { hour: string; day: string } {
  const iso = new Date(now).toISOString();
  return { hour: `h:${iso.slice(0, 13)}`, day: `d:${iso.slice(0, 10)}` };
}

// One D1 batch (a transaction): both rows exist; the hour row is counted only while the hour has fewer than
// HOUR_LIMIT AND the day fewer than DAY_LIMIT; the day row is counted only if the hour row just was (changes()).
// So both or neither; a refusal counts nothing; an admission is never refunded.
export async function admitBackstop(db: D1Database, now: number): Promise<"ok" | "hour" | "day"> {
  const { hour, day } = windows(now);
  const t = Math.floor(now / 1000);
  const [, counted, , rows] = await db.batch([
    db.prepare("INSERT OR IGNORE INTO support_backstop (win, n, created) VALUES (?1, 0, ?3), (?2, 0, ?3)").bind(hour, day, t),
    db
      .prepare(
        "UPDATE support_backstop SET n = n + 1 WHERE win = ?1 AND (SELECT n FROM support_backstop WHERE win = ?1) < ?3 AND (SELECT n FROM support_backstop WHERE win = ?2) < ?4",
      )
      .bind(hour, day, HOUR_LIMIT, DAY_LIMIT),
    db.prepare("UPDATE support_backstop SET n = n + 1 WHERE win = ?1 AND changes() = 1").bind(day),
    db.prepare("SELECT win, n FROM support_backstop WHERE win IN (?1, ?2)").bind(hour, day),
  ]);
  if (counted.meta.changes === 1) return "ok";
  // (a full day is reported first: with both full, the refusal lasts until the next UTC day, not the next hour)
  const n = new Map((rows.results as { win: string; n: number }[]).map((r) => [r.win, r.n]));
  return (n.get(day) ?? 0) >= DAY_LIMIT ? "day" : "hour";
}

// Seconds to the next UTC hour (1-3,600) or day (1-86,400).
export function retryAfter(which: "hour" | "day", now: number): number {
  const s = Math.floor(now / 1000);
  const period = which === "hour" ? 3600 : 86400;
  return period - (s % period);
}

// The cron: hour rows go after 2 days, day rows after 30.
export async function cleanBackstop(db: D1Database, now: number): Promise<void> {
  const t = Math.floor(now / 1000);
  await db
    .prepare("DELETE FROM support_backstop WHERE (win LIKE 'h:%' AND created < ?1) OR (win LIKE 'd:%' AND created < ?2)")
    .bind(t - 2 * 86400, t - 30 * 86400)
    .run();
}

// One call; the answer by CoCalc's HTTP status only (its error text is never parsed or classified).
async function callCocalc(env: SupportEnv, ip: string, submission_id: string, r: SupportRequest): Promise<Response> {
  const body = JSON.stringify({
    submission_id,
    kind: r.kind,
    title: r.title,
    description: r.description,
    ...(r.email !== undefined ? { email: r.email } : {}),
  });
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), COCALC_DEADLINE_MS);
  let status = 0;
  let okBody = false;
  try {
    const res = await fetch(env.COCALC_INTAKE_URL, {
      method: "POST",
      redirect: "manual",
      signal: ctl.signal,
      headers: {
        "content-type": "application/json",
        "x-sagebrush-intake-key": env.COCALC_INTAKE_KEY,
        "x-sagebrush-client-ip": ip,
      },
      body,
    });
    status = res.status;
    const answer = await readBounded(res.body, MAX_ANSWER_BYTES);
    if (status === 200 && answer !== undefined) okBody = isExactlyOk(answer);
  } catch {
    // (a timeout, a reset, or a body cut short: the outcome is unknown)
    status = status === 200 ? -1 : status || 0;
  } finally {
    clearTimeout(timer);
  }
  log("support-cocalc", { status });
  if (status === 200 && okBody) return json(200, { ref: submission_id.replace(/-/g, "").slice(0, 8).toLowerCase() });
  if (status === 400) return fail(400, "bad-request");
  if (status === 429) return fail(429, "rate-limited");
  if (status === 401) log("intake-key-rejected");
  return fail(503, "unavailable");
}

function isExactlyOk(answer: Uint8Array): boolean {
  try {
    const v = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(answer));
    return v !== null && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 1 && v.ok === true;
  } catch {
    return false;
  }
}

// (the page's Turnstile site key, checked before it is written into the page)
export function siteKeyOk(key: string): boolean {
  return SITE_KEY.test(key);
}

// (tests only: this isolate's admission count)
export const _inFlight = () => inFlight;
