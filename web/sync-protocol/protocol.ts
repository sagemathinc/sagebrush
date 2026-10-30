// The sync protocol, version 1 (design/sync-server.md §5): the limits of
// §8, the forms of ids, and the checks every message passes before
// anything is written.  This is the open contract (MIT OR Apache-2.0) between
// the sync client (web/workspace/) and the sync server: the server's Worker
// (web/sync/server.ts) and objects (account.ts, doc.ts) import it, as will
// sagemathinc/sagebrush-cloud's after the split (plan-cloud-split-r1); the
// client (web/workspace/sync-client.ts) is tested against the same rules.

import { normPath, PathError, type Kind } from "../workspace/paths.ts";

export const VERSION = 1;

/** §8: the server's limits.  Each has a test in web/sync/test-sync.mjs. */
export const LIMITS = {
  /**
   * a message on a socket, in UTF-8 bytes: a batch's largest body (1 MiB)
   * is 1.33 MiB as base64, and its 2,000 envelopes up to about 0.4 MiB more
   * (LIMIT-321-3: the design's 1 MiB + 64 KiB couldn't carry a full batch)
   */
  messageBytes: 2 << 20,
  batchBytes: 1 << 20,
  batchPatches: 2000,
  patchParents: 8,
  patchBlobs: 8,
  /** a patch inline in a batch; larger ones go as a blob (Env.blobs) */
  patchBytes: 256 << 10,
  opsPerMessage: 500,
  entries: 100_000,
  folderEntries: 10_000,
  docsPerAccount: 100_000,
  /** requests a socket may have unanswered */
  inflight: 8,
  accountSockets: 20,
  docSocketsPerDoc: 50,
  docSocketsPerAccount: 64,
  docSocketsPerSession: 16,
  ticketsPerSession: 32,
  helloDocs: 1000,
  indexPage: 1000,
  indexPageBytes: 1 << 20,
  pullDefault: 100,
  pullMax: 500,
  pullBytes: 4 << 20,
  checkItems: 1000,
  /** batches per account: a burst, and the sustained rate a second */
  batchBurst: 20,
  batchRate: 4,
  opsPerMinute: 2000,
  uploadsAtOnce: 4,
  urlsPerMinute: 600,
  snapshotsKept: 3,
  liveBatches: 200,
  /** refusals a device may collect before it must rebuild (§5.2) */
  refusalsPerDevice: 10_000,
  /** a keepalive request (a page being hidden) */
  keepaliveBytes: 64 << 10,
};

/** How long a session is trusted on a socket before it is checked again (§2). */
export const RECHECK_MS = 10 * 60_000;
/** How long the limits from CoCalc are cached (§6). */
export const LIMITS_TTL_MS = 6 * 3600_000;
/** A document socket's ticket (§2). */
export const TICKET_MS = 2 * 60_000;
/** A pin's forward, and a grant's admission (§4.3, §4.5). */
export const PIN_MS = 5 * 60_000;
export const ADMIT_MS = 60_000;
/** A signed blob URL (§5.4). */
export const URL_MS = 5 * 60_000;

/** The codes a refusal uses (§5.2; slice 2's claims and fences, plan-sync-slice2-r9.md §5.8).  "unavailable": a feature
 * the deployment has switched off (2b-7's snapshots: `{why: "snapshots_off"}`, no retry_after; the client stops asking
 * for the session), doc-vectors.json's `refusals`. */
export const CODES = Object.freeze([
  "invalid", "exists", "missing", "conflict", "order", "epoch", "unknown_doc", "forbidden",
  "limit", "storage_full", "rate", "readonly", "deleting", "busy",
  "unknown_client", "fenced", "stale_epoch", "unavailable",
] as const);
export type Code = (typeof CODES)[number];
const KNOWN_CODES: ReadonlySet<string> = new Set(CODES);
/** Whether `c` is one of the codes this build knows. */
export const isCode = (c: unknown): c is Code => typeof c === "string" && KNOWN_CODES.has(c);

export class SyncError extends Error {
  constructor(public code: Code, message: string, public detail?: Record<string, unknown>) { super(message); }
}
/**
 * What an RPC to an object answers: a refusal is a value, not a thrown
 * error, since an error's own fields don't survive the call.  A thrown
 * error therefore always means the answer was lost (design/sync-server.md §4.3).
 */
export type Result<T> = { ok: T } | { error: { code: SyncError["code"]; message: string; detail?: Record<string, unknown> } };
export function attempt<T>(f: () => T): Result<T> {
  try {
    return { ok: f() };
  } catch (e) {
    if (e instanceof SyncError) return { error: { code: e.code, message: e.message, ...(e.detail ? { detail: e.detail } : {}) } };
    throw e;
  }
}
export async function attemptAsync<T>(f: () => Promise<T>): Promise<Result<T>> {
  try {
    return { ok: await f() };
  } catch (e) {
    if (e instanceof SyncError) return { error: { code: e.code, message: e.message, ...(e.detail ? { detail: e.detail } : {}) } };
    throw e;
  }
}
/** The value of a Result, or its refusal thrown as a SyncError. */
export function unwrap<T>(r: Result<T>): T {
  if ("error" in r) throw refusalOf(r.error);
  return r.ok;
}
/** A refusal as it arrived, as a SyncError.  A code this build doesn't know (a newer server's, or anything else) fails
 * closed: it becomes "invalid", which is final and never sent again, with the code it had in `detail.unknown_code`. */
export function refusalOf(e: { code?: unknown; message?: unknown; detail?: Record<string, unknown> }): SyncError {
  const message = typeof e?.message === "string" ? e.message : "refused";
  if (isCode(e?.code)) return new SyncError(e.code, message, e.detail);
  return new SyncError("invalid", `a refusal this build doesn't know: ${message}`, { unknown_code: typeof e?.code === "string" ? e.code.slice(0, 64) : null, final: true });
}

export const invalid = (m: string) => new SyncError("invalid", m);
const tooBig = (limit: string, max: number, m: string) => new SyncError("limit", m, { limit, max });

// ---- ids: the client's own, keyed by account (§3)

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HEX12 = /^[0-9a-f]{12}$/;
const HEX16 = /^[0-9a-f]{16}$/;
export const HEX64 = /^[0-9a-f]{64}$/;
/** A device's id: 8-64 of [0-9A-Za-z_-]. */
const DEVICE = /^[0-9A-Za-z_-]{8,64}$/;

/** A document's id: a notebook's UUID or a board's (or chat's) 12 hex. */
export const isDocId = (s: unknown): s is string => typeof s === "string" && (UUID.test(s) || HEX12.test(s));
export const isFid = (s: unknown): s is string => typeof s === "string" && HEX16.test(s);
export const isSha = (s: unknown): s is string => typeof s === "string" && HEX64.test(s);
export const isHash = isSha;
export const isDevice = (s: unknown): s is string => typeof s === "string" && DEVICE.test(s);
export const isNat = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 0;

export type DocKind = "notebook" | "board" | "chat";
const DOC_KINDS = new Set<string>(["notebook", "board", "chat"]);
const KINDS = new Set<string>(["notebook", "board", "file", "folder"]);

// ---- plain objects only, with exactly the fields allowed (§5: an unknown field is refused)

/** A plain object whose own keys are all in `allowed`: never a prototype's, never one more. */
export function fields(v: unknown, allowed: readonly string[], what: string): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v) || Object.getPrototypeOf(v) !== Object.prototype) throw invalid(`${what}: an object`);
  for (const k of Object.keys(v)) if (!allowed.includes(k)) throw invalid(`${what}: unknown field ${JSON.stringify(k.slice(0, 40))}`);
  return v as Record<string, unknown>;
}
export const has = (o: Record<string, unknown>, k: string) => Object.prototype.hasOwnProperty.call(o, k);

function path(p: unknown, what: string): string {
  try {
    const n = normPath(p);
    // (only the normal form: two spellings of one path never reach the log)
    if (n !== p) throw new PathError("not in normal form");
    return n;
  } catch (e) {
    throw invalid(`${what}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// ---- index ops (§3; the client's Op with ref, fid, sha256, size, base)

export const OPS = ["create", "mkdir", "write", "rename", "duplicate", "remove", "restore", "adopt", "forget", "dropVersions"] as const;
export type OpName = (typeof OPS)[number];
/** Ops only a person may send, from a session: never a grant (§3, design/agent-endpoint.md §4). */
export const PERSON_ONLY = new Set<OpName>(["forget", "dropVersions"]);

export interface Op {
  dseq: number;
  t: number;
  by: string;
  op: OpName;
  path: string;
  to?: string;
  kind: Kind;
  ref?: string;
  fid?: string;
  sha256?: string;
  size?: number;
  base?: string;
  /** The fid of the folder this op puts something in (§3): a hint for the reducer, never checked here. */
  parent?: string;
}
const OP_FIELDS = ["dseq", "t", "by", "op", "path", "to", "kind", "ref", "fid", "sha256", "size", "base", "parent"] as const;
/** The ops that may say `to`: where it goes. */
const TO_OPS = new Set<string>(["rename", "duplicate", "remove", "restore"]);
/** The ops that put something in a folder, and so may name it by `parent`: on rename and duplicate, the destination's. */
const PLACES = new Set<string>(["create", "mkdir", "adopt", "write", "rename", "duplicate", "restore"]);

/** One op, checked: its shape, its paths, and the identity its kind needs. */
export function checkOp(v: unknown): Op {
  const o = fields(v, OP_FIELDS, "op");
  if (!isNat(o.dseq) || o.dseq < 1) throw invalid("op: dseq is a positive integer");
  if (!isNat(o.t)) throw invalid("op: t is a time in ms");
  if (typeof o.by !== "string" || !/^(person|agent:[^\u0000-\u001f\u007f]{1,64})$/.test(o.by)) throw invalid("op: by");
  if (typeof o.op !== "string" || !(OPS as readonly string[]).includes(o.op)) throw invalid("op: unknown op");
  if (typeof o.kind !== "string" || !KINDS.has(o.kind)) throw invalid("op: kind");
  const op: Op = { dseq: o.dseq, t: o.t, by: o.by, op: o.op as OpName, path: path(o.path, "op path"), kind: o.kind as Kind };
  if (has(o, "to")) op.to = path(o.to, "op to");
  // (rename and duplicate need `to`; remove and restore may say where in Trash, or where back to, as the client's
  // log and the shared reducer have them (sync-reduce.ts remove(to), restore(to)); no other op has it)
  if ((op.op === "rename" || op.op === "duplicate") && op.to === undefined) throw invalid("op: rename and duplicate need `to`");
  if (op.to !== undefined && !TO_OPS.has(op.op)) throw invalid("op: `to` is for rename, duplicate, remove and restore only");
  if (has(o, "ref")) {
    if (typeof o.ref !== "string" || o.ref.length === 0 || o.ref.length > 1024) throw invalid("op: ref");
    op.ref = o.ref;
  }
  if (has(o, "fid")) {
    if (!isFid(o.fid)) throw invalid("op: fid is 16 hex");
    op.fid = o.fid;
  }
  if (has(o, "sha256")) {
    if (!isSha(o.sha256)) throw invalid("op: sha256");
    op.sha256 = o.sha256;
  }
  if (has(o, "base")) {
    if (!isSha(o.base)) throw invalid("op: base");
    op.base = o.base;
  }
  if (has(o, "parent")) {
    if (!isFid(o.parent)) throw invalid("op: parent is a folder's fid, 16 hex");
    if (!PLACES.has(op.op)) throw invalid("op: parent is for an op that puts something in a folder");
    op.parent = o.parent;
  }
  if (has(o, "size")) {
    if (!isNat(o.size)) throw invalid("op: size");
    op.size = o.size;
  }
  const makes = op.op === "create" || op.op === "adopt" || op.op === "write";
  // (a document's contents are its id; a data file's are its bytes, by hash)
  if (makes && (op.kind === "notebook" || op.kind === "board") && !isDocId(op.ref)) throw invalid("op: a document's ref is its id");
  if (makes && op.kind === "file" && (!isFid(op.fid) || !isSha(op.sha256) || op.size === undefined)) throw invalid("op: a data file needs fid, sha256 and size");
  if (op.base !== undefined && !(op.op === "write" && op.kind === "file")) throw invalid("op: base is for a data file's write");
  return op;
}

// ---- batches (§4.1, §5.3)

/** A patch's checked envelope: its graph, beside its opaque payload. */
export interface Env { cseq: number; id: string; parents: string[]; size: number; blobs?: string[] }
export interface Head { epoch: number; seq: number }
export interface Batch { owner?: string; doc: string; kind?: DocKind; epoch: number; expect_head?: Head; patches: Env[]; body: Uint8Array }

/** patchflow's PatchId: 11 base-36 characters of time, "_", the client's id (patch-id.js). */
const PATCH_ID = /^[0-9a-z]{11}_[0-9A-Za-z_-]{1,64}$/;
export const isPatchId = (s: unknown): s is string => typeof s === "string" && PATCH_ID.test(s);
/** The patchflow client a patch id names. */
export const clientOf = (id: string) => id.slice(12);

/** base64 to bytes, bounded by its length before anything is decoded. */
export function fromB64(s: unknown, max: number, limit = "batch_bytes"): Uint8Array {
  if (typeof s !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(s) || s.length % 4 !== 0) throw invalid("body: base64");
  if (s.length > Math.ceil(max / 3) * 4) throw tooBig(limit, max, `body: at most ${max} bytes`);
  const bin = atob(s);
  if (bin.length > max) throw tooBig(limit, max, `body: at most ${max} bytes`);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
export function toB64(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}

export function checkHead(v: unknown, what: string): Head {
  const h = fields(v, ["epoch", "seq"], what);
  if (!isNat(h.epoch) || !isNat(h.seq)) throw invalid(`${what}: epoch and seq`);
  return { epoch: h.epoch, seq: h.seq };
}

/** One patch's envelope, checked for shape and size. */
export function checkEnv(p: unknown): Env {
  const e = fields(p, ["cseq", "id", "parents", "size", "blobs"], "patch");
  if (!isNat(e.cseq) || e.cseq < 1) throw invalid("patch: cseq is a positive integer");
  if (!isPatchId(e.id)) throw invalid("patch: id");
  if (!Array.isArray(e.parents) || !e.parents.every(isPatchId)) throw invalid("patch: parents");
  if (e.parents.length > LIMITS.patchParents) throw tooBig("patch_parents", LIMITS.patchParents, "patch: too many parents");
  if (new Set(e.parents).size !== e.parents.length || e.parents.includes(e.id)) throw invalid("patch: parents repeat, or name the patch itself");
  if (!isNat(e.size)) throw invalid("patch: size");
  if (e.size > LIMITS.patchBytes) throw tooBig("patch_bytes", LIMITS.patchBytes, "a patch over the inline limit goes as a blob");
  const env: Env = { cseq: e.cseq, id: e.id, parents: e.parents as string[], size: e.size };
  if (has(e, "blobs")) {
    if (!Array.isArray(e.blobs) || e.blobs.length === 0 || !e.blobs.every(isSha) || new Set(e.blobs).size !== e.blobs.length) throw invalid("patch: blobs");
    if (e.blobs.length > LIMITS.patchBlobs) throw tooBig("patch_blobs", LIMITS.patchBlobs, "patch: too many blobs");
    env.blobs = e.blobs as string[];
  }
  return env;
}

/** A batch's envelopes and body, checked for shape and size; the order is the document's to check (§4.2). */
export function checkBatch(v: Record<string, unknown>, opts: { bodyKey?: string } = {}): Batch {
  if (!isDocId(v.doc)) throw invalid("batch: doc");
  if (has(v, "owner") && !isHash(v.owner)) throw invalid("batch: owner is an account hash");
  if (!isNat(v.epoch)) throw invalid("batch: epoch");
  if (has(v, "kind") && !(typeof v.kind === "string" && DOC_KINDS.has(v.kind))) throw invalid("batch: kind");
  if (!Array.isArray(v.patches) || v.patches.length === 0) throw invalid("batch: patches");
  if (v.patches.length > LIMITS.batchPatches) throw tooBig("batch_patches", LIMITS.batchPatches, "too many patches");
  const body = fromB64(v[opts.bodyKey ?? "body"], LIMITS.batchBytes);
  const patches = v.patches.map(checkEnv);
  // (the payloads are the body, exactly: no bytes the envelopes don't account for, none they claim that aren't there)
  if (patches.reduce((n, p) => n + p.size, 0) !== body.length) throw invalid("batch: the patches' sizes don't add up to the body");
  const b: Batch = { doc: v.doc, epoch: v.epoch, patches, body };
  if (has(v, "owner")) b.owner = v.owner as string;
  if (has(v, "kind")) b.kind = v.kind as DocKind;
  if (has(v, "expect_head")) b.expect_head = checkHead(v.expect_head, "batch: expect_head");
  return b;
}

/** A plain JSON message from a socket or request, bounded before it is parsed. */
export function parseMessage(raw: string | ArrayBuffer, max = LIMITS.messageBytes): Record<string, unknown> {
  if (typeof raw !== "string") throw invalid("messages are text");
  // (a UTF-16 length over max is over in bytes too; the exact check is on the encoding)
  if (raw.length > max || enc.encode(raw).length > max) throw tooBig("message_bytes", max, "message too large");
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    throw invalid("not JSON");
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) throw invalid("a message is an object");
  return v as Record<string, unknown>;
}

// ---- small helpers shared by the objects

export const enc = new TextEncoder();
export const hex = (b: ArrayBuffer | Uint8Array) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
export async function sha256Hex(data: Uint8Array | string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", typeof data === "string" ? enc.encode(data) : data));
}
export async function hmacHex(key: string, msg: string): Promise<string> {
  const k = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", k, enc.encode(msg)));
}
/** Equal strings, in time independent of where they differ. */
export function same(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
/** The account's hash, as sharing names it (web/share/server.ts accountHash). */
export const accountHash = (account: string) => sha256Hex("sagebrush-account\n" + account);
export const randomHex = (n: number) => hex(crypto.getRandomValues(new Uint8Array(n)));

/** A token bucket: `burst` at once, refilled at `rate` a second.  In memory (§2). */
export class Bucket {
  private tokens: number;
  private at: number;
  constructor(private burst: number, private rate: number, now = Date.now()) {
    this.tokens = burst;
    this.at = now;
  }
  /**
   * Takes `n` if there are that many, and returns 0; otherwise takes none
   * and returns the ms until there are (Infinity if `n` is over the burst,
   * which can never fit).
   */
  take(n = 1, now = Date.now()): number {
    this.tokens = Math.min(this.burst, this.tokens + (Math.max(0, now - this.at) / 1000) * this.rate);
    this.at = now;
    if (n > this.burst) return Infinity;
    if (this.tokens >= n) {
      this.tokens -= n;
      return 0;
    }
    return Math.ceil(((n - this.tokens) / this.rate) * 1000);
  }
}
