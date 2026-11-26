// sagebrush:// (design sagebrush-fsspec r3 §4, with r3.1-r3.3): the closed operations by which Python reads a
// workspace's files by range, asked of the page as live data is (src/live-data.ts).  Python never holds a key, a
// signed URL, a blob's address or header, or a network socket: it names a workspace, a path and a version, and the
// page resolves them itself, on every call, from its own index of that workspace.
//
//   fs.stat {ws, path, version?}                 -> {kind, size, version, mtime, codec, ...}
//   fs.list {ws, path, cursor?}                  -> {entries: [{name, type, size, version}], cursor?}
//   fs.read {ws, path, version, offset, length}  -> exactly min(length, max(0, size - offset)) bytes
//
// `ws` null is the kernel's own workspace (sagebrush:///path).  The caller is the channel a request comes on (the
// page knows which kernel's worker posted it, web/notebook/sb-fs.js), never anything in the request.
//
// The transport: each worker has one buffer (FS_BUFFER_BYTES, shared memory) for every call it makes, made at its
// first call.  Int32 [0] the state (0: the worker's turn to send or take, 1: a piece is there), [1] the piece's
// length in bytes, [2] its sequence number in its call (1, 2, ...), [3] its kind (1: the JSON header, 2: data
// bytes), [4] its call's number (the count in the call's key: a piece of an earlier call, one a Stop cut short,
// is skipped, never taken for this call's); then, from byte FS_HEADER, the piece.  The worker posts {id, target, sbFs: {op, params, key}, buffer}; the page answers with the header (an
// {ok} or an {error}), and for fs.read the data in pieces of at most FS_PIECE bytes, one at a time: after taking
// each piece the worker sets [0] back to 0 and posts {sbFsAck: {key, seq}}, and the page writes the next.  A Stop
// wins over a piece (the call is a KeyboardInterrupt), and each wait is bounded (FS_PIECE_DEADLINE_MS).  Both sides
// check everything here: the worker before it posts, and the page again on the raw message.

export const FS_OPS = ["fs.stat", "fs.list", "fs.read"] as const;
export type FsOp = (typeof FS_OPS)[number];

/** The bytes of one piece the page writes, and of the buffer: a FS_HEADER-byte header, then the piece. */
export const FS_PIECE = 1 << 20;
export const FS_HEADER = 32;
export const FS_BUFFER_BYTES = FS_HEADER + FS_PIECE;
/** At most this many bytes per fs.read call: SagebrushFile.read(n) loops for more (a fixed per-call limit, r3 §4.2). */
export const FS_MAX_READ = 64 << 20;
/** A request's message, as JSON, at most this many bytes; a path at most FS_MAX_PATH bytes as UTF-8. */
export const FS_MAX_MESSAGE = 8192;
export const FS_MAX_PATH = 4096;
/** A listing's page: at most this many entries, and at most this many bytes of JSON. */
export const FS_LIST_ENTRIES = 1000;
export const FS_LIST_BYTES = 1 << 20;
/** How long the worker waits for each piece: a run's 60 s deadline (r3.2 §A.3') and a margin. */
export const FS_PIECE_DEADLINE_MS = 75_000;

/** The closed error codes; anything else an answer says is `unavailable`. */
export const FS_ERRORS = ["not_found", "permission", "invalid", "memory", "codec", "budget", "network", "integrity", "unavailable", "timeout", "interrupted"] as const;
export type FsError = (typeof FS_ERRORS)[number];

export type StatParams = { ws: string | null; path: string; version?: string };
export type ListParams = { ws: string | null; path: string; cursor?: string };
export type ReadParams = { ws: string | null; path: string; version: string; offset: number; length: number };
export type FsRequest = { op: "fs.stat"; params: StatParams } | { op: "fs.list"; params: ListParams } | { op: "fs.read"; params: ReadParams };

const WS = /^[0-9a-f]{16}$/;
const VERSION = /^[0-9a-f]{64}$/;
const CURSOR = /^[A-Za-z0-9_-]{16,64}$/;
const KEYS: Record<FsOp, { need: string[]; may: string[] }> = {
  "fs.stat": { need: ["ws", "path"], may: ["version"] },
  "fs.list": { need: ["ws", "path"], may: ["cursor"] },
  "fs.read": { need: ["ws", "path", "version", "offset", "length"], may: [] },
};

const plain = (o: unknown): o is Record<string, unknown> => o !== null && typeof o === "object" && !Array.isArray(o) && Object.getPrototypeOf(o) === Object.prototype;
const utf8Length = (s: string) => new TextEncoder().encode(s).length;

/** A normalized workspace path: "/" or "/a/b", no empty, "." or ".." segment, no NUL or backslash, at most
 * FS_MAX_PATH bytes. */
export function isWorkspacePath(p: unknown): p is string {
  if (typeof p !== "string" || !p.startsWith("/") || p.includes("\0") || p.includes("\\")) return false;
  if (utf8Length(p) > FS_MAX_PATH) return false;
  if (p === "/") return true;
  for (const seg of p.slice(1).split("/")) if (seg === "" || seg === "." || seg === "..") return false;
  return true;
}

/** A request's operation and parameters, checked and copied (own fields only, exact keys), or why it's refused. */
export function checkRequest(op: unknown, params: unknown): { request: FsRequest } | { refused: string } {
  if (typeof op !== "string" || !Object.hasOwn(KEYS, op)) return { refused: "unknown operation" };
  const { need, may } = KEYS[op as FsOp];
  if (!plain(params)) return { refused: "the parameters must be an object" };
  for (const k of Object.keys(params)) if (!need.includes(k) && !may.includes(k)) return { refused: `unknown parameter ${JSON.stringify(k.slice(0, 64))}` };
  for (const k of need) if (!Object.hasOwn(params, k)) return { refused: `missing parameter ${k}` };
  const ws = params.ws;
  if (ws !== null && (typeof ws !== "string" || !WS.test(ws))) return { refused: "ws must be null (this workspace) or a workspace id" };
  if (!isWorkspacePath(params.path)) return { refused: "path must be a normalized workspace path" };
  const path = params.path as string;
  if (Object.hasOwn(params, "version") && (typeof params.version !== "string" || !VERSION.test(params.version))) return { refused: "version must be a SHA-256, 64 lowercase hex digits" };
  if (op === "fs.stat") return { request: { op, params: { ws, path, ...(Object.hasOwn(params, "version") ? { version: params.version as string } : {}) } } };
  if (op === "fs.list") {
    if (Object.hasOwn(params, "cursor") && (typeof params.cursor !== "string" || !CURSOR.test(params.cursor))) return { refused: "cursor must be one the page gave" };
    return { request: { op, params: { ws, path, ...(Object.hasOwn(params, "cursor") ? { cursor: params.cursor as string } : {}) } } };
  }
  const { offset, length } = params;
  if (!Number.isSafeInteger(offset) || (offset as number) < 0) return { refused: "offset must be a non-negative integer below 2**53" };
  if (!Number.isSafeInteger(length) || (length as number) < 0 || (length as number) > FS_MAX_READ) return { refused: `length must be an integer from 0 to ${FS_MAX_READ}` };
  return { request: { op: "fs.read", params: { ws, path, version: params.version as string, offset: offset as number, length: length as number } } };
}

/** The bytes fs.read returns for a file of `size` bytes: never forms offset + length - 1 (r3 §5.5). */
export function readLength(size: number, offset: number, length: number): number {
  if (length === 0 || offset >= size) return 0;
  return Math.min(length, size - offset);
}

export type FsHeader = { ok: Record<string, unknown> } | { error: { code: FsError; message: string } };

/** A header, checked against the closed form: anything else is `unavailable`. */
export function checkHeader(h: unknown): FsHeader {
  const bad: FsHeader = { error: { code: "unavailable", message: "the page's answer was not understood" } };
  if (!plain(h) || Object.keys(h).length !== 1) return bad;
  if (Object.hasOwn(h, "ok")) return plain(h.ok) ? { ok: h.ok } : bad;
  if (!Object.hasOwn(h, "error") || !plain(h.error)) return bad;
  const { code, message } = h.error;
  if (typeof message !== "string" || message.length > 4096) return bad;
  return { error: { code: (FS_ERRORS as readonly string[]).includes(code as string) ? (code as FsError) : "unavailable", message } };
}

// ------------------------------------------------------------------ the worker's side of the buffer

/** A piece's kind: the JSON header, or data bytes. */
export const KIND_HEADER = 1, KIND_DATA = 2;

/** Wait for piece `seq` of call `call` in `buffer`: its kind and a view of its bytes (valid until it is released),
 * or a Stop or a timeout.  A piece of an earlier call is released and skipped.  A Stop wins over a piece that lands
 * during the same wait. */
export function waitPiece(buffer: SharedArrayBuffer, intr: Int32Array, call: number, seq: number, deadlineMs = FS_PIECE_DEADLINE_MS, now: () => number = () => Date.now(), sliceMs = 100): { kind: number; bytes: Uint8Array } | { error: "interrupted" | "timeout" | "unavailable" } {
  const ctl = new Int32Array(buffer, 0, 5);
  const stopped = () => (Atomics.load(intr, 0) & 1) !== 0;
  const end = now() + deadlineMs;
  for (;;) {
    if (stopped()) return { error: "interrupted" };
    if (Atomics.load(ctl, 0) === 1) {
      const c = Atomics.load(ctl, 4);
      if (c === call) break;
      // (an earlier call's piece, written after a Stop cut that call short: not this call's, handed back)
      if (c < call) {
        releasePiece(buffer);
        continue;
      }
      return { error: "unavailable" };
    }
    const left = end - now();
    if (left <= 0) return { error: "timeout" };
    Atomics.wait(ctl, 0, 0, Math.min(sliceMs, left));
  }
  // (a Stop is checked after every wake, before the piece: one landing with the piece in the same wait wins)
  const n = Atomics.load(ctl, 1), s = Atomics.load(ctl, 2), kind = Atomics.load(ctl, 3);
  if (s !== seq || !(n >= 0 && n <= buffer.byteLength - FS_HEADER) || (kind !== KIND_HEADER && kind !== KIND_DATA)) return { error: "unavailable" };
  return { kind, bytes: new Uint8Array(buffer, FS_HEADER, n) };
}

/** Hand the buffer back to the page after taking (or skipping) a piece. */
export function releasePiece(buffer: SharedArrayBuffer): void {
  const ctl = new Int32Array(buffer, 0, 5);
  Atomics.store(ctl, 0, 0);
  Atomics.notify(ctl, 0);
}

/** The header piece's JSON, decoded and checked. */
export function readHeader(bytes: Uint8Array): FsHeader {
  try {
    // (copied out of shared memory first: TextDecoder refuses a shared view)
    return checkHeader(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.slice())));
  } catch {
    return checkHeader(null);
  }
}

// ------------------------------------------------------------------ the page's side of the buffer

/** Write piece `seq` of call `call` where the worker waits, if the buffer is the worker's to take (state 0); false
 * otherwise. */
export function writePiece(buffer: SharedArrayBuffer, call: number, seq: number, kind: number, bytes: Uint8Array): boolean {
  if (bytes.length > buffer.byteLength - FS_HEADER) return false;
  const ctl = new Int32Array(buffer, 0, 5);
  if (Atomics.load(ctl, 0) !== 0) return false;
  new Uint8Array(buffer, FS_HEADER, bytes.length).set(bytes);
  Atomics.store(ctl, 1, bytes.length);
  Atomics.store(ctl, 2, seq);
  Atomics.store(ctl, 3, kind);
  Atomics.store(ctl, 4, call);
  Atomics.store(ctl, 0, 1);
  Atomics.notify(ctl, 0);
  return true;
}

/** The header as the bytes of its piece. */
export function headerBytes(h: FsHeader): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(h));
}
