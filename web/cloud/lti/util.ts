// Small helpers for the LTI tool (plan-lti-r5).  Self-contained: this
// directory imports nothing from the rest of the site, so it can move to its
// own repository unchanged.

const te = new TextEncoder();

export const utf8 = (s: string): Uint8Array => te.encode(s);
export const byteLength = (s: string): number => te.encode(s).length;

export function hex(b: ArrayBuffer | Uint8Array): string {
  const a = b instanceof Uint8Array ? b : new Uint8Array(b);
  let s = "";
  for (const x of a) s += x.toString(16).padStart(2, "0");
  return s;
}

/** `n` random bytes as hex (2n characters). */
export function randomHex(n: number): string {
  const a = new Uint8Array(n);
  crypto.getRandomValues(a);
  return hex(a);
}

export async function sha256Hex(data: string | Uint8Array): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", typeof data === "string" ? utf8(data) : data));
}

/**
 * §1.1: every derived key is SHA-256("sb-lti-v1" ‖ enc(kind) ‖ enc(f1) ‖ … ‖ enc(fn)),
 * where enc(s) is a 4-byte big-endian length and the UTF-8 bytes.  The id is
 * the first 32 hex characters; callers keep the full tuple beside it.
 */
export async function derivedKey(kind: string, ...fields: string[]): Promise<string> {
  const parts = [utf8("sb-lti-v1")];
  for (const f of [kind, ...fields]) {
    const b = utf8(f);
    const len = new Uint8Array(4);
    new DataView(len.buffer).setUint32(0, b.length);
    parts.push(len, b);
  }
  const total = parts.reduce((n, p) => n + p.length, 0);
  const all = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    all.set(p, off);
    off += p.length;
  }
  return (await sha256Hex(all)).slice(0, 32);
}

export async function hmacHex(key: string, msg: string): Promise<string> {
  const k = await crypto.subtle.importKey("raw", utf8(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", k, utf8(msg)));
}

/** Constant-time comparison of two strings. */
export function same(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

export function b64urlDecode(s: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new Error("bad base64url");
  const pad = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const bin = atob(pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function b64urlEncode(b: Uint8Array | string): string {
  const a = typeof b === "string" ? utf8(b) : b;
  let bin = "";
  for (const x of a) bin += String.fromCharCode(x);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Canonical JSON: object keys sorted, recursively; used for policy digests (§17.1). */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(canonicalJson).join(",") + "]";
  const o = v as Record<string, unknown>;
  return "{" + Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => JSON.stringify(k) + ":" + canonicalJson(o[k])).join(",") + "}";
}

/** A request body read to at most `max` bytes, or null if longer (whatever the headers say). */
export async function readBounded(req: Request, max: number): Promise<string | null> {
  const cl = req.headers.get("content-length");
  if (cl !== null && (!/^\d{1,9}$/.test(cl) || Number(cl) > max)) return null;
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.length;
    if (n > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(n);
  let off = 0;
  for (const c of chunks) {
    all.set(c, off);
    off += c.length;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(all);
  } catch {
    return null;
  }
}

export function json(v: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...headers } });
}

/** An error answer: a code only, never details (§3.2). */
export const fail = (status: number, code: string): Response => json({ error: code }, status);

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** A refusal carrying an HTTP status and a short code. */
export class LtiError extends Error {
  constructor(public status: number, public code: string) {
    super(code);
  }
}

/**
 * Test seams: on only in the Worker built from web/cloud/lti/test-entry.ts, which
 * sets this flag when it loads.  No deployed entry sets it, so no binding can
 * turn a seam on in production.
 */
export function testMode(): boolean {
  return (globalThis as { __SAGEBRUSH_LTI_TEST__?: boolean }).__SAGEBRUSH_LTI_TEST__ === true;
}
const gates = new Set<string>();
/** (a one-shot gate holds only the first caller to reach it, and says when it is holding one) */
const once = new Map<string, "armed" | "parked" | "released">();
/** Tests only: hold a named step until the test opens it (≤ 30 s; a one-shot hold ≤ 120 s, as a stale continuation must outlast a restore); a no-op outside test mode. */
export async function testGate(name: string): Promise<void> {
  if (!testMode()) return;
  if (once.get(name) === "armed") {
    once.set(name, "parked");
    for (let i = 0; once.get(name) === "parked" && i < 6000; i++) await new Promise((r) => setTimeout(r, 20));
    once.delete(name);
    return;
  }
  for (let i = 0; gates.has(name) && i < 1500; i++) await new Promise((r) => setTimeout(r, 20));
}
export function setTestGate(name: string, on: boolean, oneShot = false): void {
  if (!testMode()) return;
  if (oneShot) {
    if (on) once.set(name, "armed");
    else if (once.get(name) === "parked") once.set(name, "released");
    else once.delete(name);
    return;
  }
  if (on) gates.add(name);
  else gates.delete(name);
}
const faults = new Map<string, string>();
/**
 * Tests only: once armed, the named step rejects just after its write, as a lost response would, with
 * the armed raw message (a plain transport error by default); a no-op outside test mode.
 */
export function testFault(name: string): void {
  if (!testMode()) return;
  const m = faults.get(name);
  if (m === undefined) return;
  faults.delete(name);
  throw new Error(m);
}
export function setTestFault(name: string, message = `Network connection lost (injected: ${name}'s response)`): void {
  if (testMode()) faults.set(name, message);
}
/** Tests only: whether a one-shot gate is holding its caller. */
export function testGateParked(name: string): boolean {
  return testMode() && once.get(name) === "parked";
}
