// The engine protocol's frames (design/native-desktop.md §2.1), shared by the
// engine (app/engine/main.mjs, Node) and the page's client (the app's web view).
//
// On the pipe, each frame is a 4-byte little-endian length, then that many
// bytes of payload.  A payload is a message: a 4-byte little-endian length of
// its JSON, the JSON (UTF-8), then the bytes of its binary values, one after
// another.  In the JSON, each binary value (a Uint8Array, or an ArrayBuffer)
// is {"$b": [offset, length, kind]}, its place in those bytes, kind 0 for a
// Uint8Array and 1 for an ArrayBuffer; an object with a "$b" key of its own is
// refused, so nothing a document writes can be read as one.  A
// SharedArrayBuffer is never sent: shared memory stays on its own side (the
// engine keeps the interpreter's words and translates, as the sandboxed
// runner's frame does), and encode() throws on one.

export const FRAME_MAX = 512 * 1024 * 1024;
const enc = new TextEncoder(), dec = new TextDecoder("utf-8", { fatal: true });
const shared = (x) => typeof SharedArrayBuffer === "function" && (x instanceof SharedArrayBuffer || x?.buffer instanceof SharedArrayBuffer);

/** A message as a payload (without the frame's length). */
export function encode(msg) {
  const parts = [];
  let size = 0;
  const json = JSON.stringify(msg, function (k, v) {
    // (the value as it is in its holder: a typed array's toJSON doesn't exist, but read it from the holder anyway)
    const raw = this[k];
    if (shared(raw)) throw new Error(`shared memory can't be sent (${k})`);
    if (raw instanceof Uint8Array || raw instanceof ArrayBuffer) {
      const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
      parts.push(bytes);
      size += bytes.length;
      return { $b: [size - bytes.length, bytes.length, raw instanceof Uint8Array ? 0 : 1] };
    }
    if (ArrayBuffer.isView(raw)) throw new Error(`only a Uint8Array or an ArrayBuffer is sent as bytes (${k}: ${raw.constructor?.name})`);
    if (v !== null && typeof v === "object" && !Array.isArray(v) && Object.prototype.hasOwnProperty.call(v, "$b")) throw new Error(`the key "$b" is reserved (${k})`);
    return v;
  });
  if (json === undefined) throw new Error("not a message");
  const head = enc.encode(json);
  if (4 + head.length + size > FRAME_MAX) throw new Error(`a message of ${4 + head.length + size} bytes is larger than a frame (${FRAME_MAX})`);
  const out = new Uint8Array(4 + head.length + size);
  new DataView(out.buffer).setUint32(0, head.length, true);
  out.set(head, 4);
  let at = 4 + head.length;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

/** A payload as its message; throws on anything malformed. */
export function decode(payload) {
  if (!(payload instanceof Uint8Array) || payload.length < 4) throw new Error("a payload shorter than its header");
  const n = new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getUint32(0, true);
  if (4 + n > payload.length) throw new Error("a payload shorter than its JSON");
  const body = payload.subarray(4 + n);
  return JSON.parse(dec.decode(payload.subarray(4, 4 + n)), (k, v) => {
    if (v === null || typeof v !== "object" || Array.isArray(v) || !Object.prototype.hasOwnProperty.call(v, "$b")) return v;
    const b = v.$b;
    if (Object.keys(v).length !== 1 || !Array.isArray(b) || b.length !== 3 || !b.every(Number.isSafeInteger) || b[0] < 0 || b[1] < 0 || b[0] + b[1] > body.length || (b[2] !== 0 && b[2] !== 1)) throw new Error("a malformed binary value");
    // (a copy: the message never shares memory with the frame it came in)
    const bytes = body.slice(b[0], b[0] + b[1]);
    return b[2] === 0 ? bytes : bytes.buffer;
  });
}

/** A frame: the payload with its length in front. */
export function frame(payload) {
  if (payload.length > FRAME_MAX) throw new Error(`a frame of ${payload.length} bytes is larger than the limit (${FRAME_MAX})`);
  const out = new Uint8Array(4 + payload.length);
  new DataView(out.buffer).setUint32(0, payload.length, true);
  out.set(payload, 4);
  return out;
}

/** Reads frames from a byte stream: push(chunk) calls onPayload(payload) for each complete one, in order.  A length
 * over FRAME_MAX throws: the stream is then no protocol stream, and its reader closes it.  A frame's chunks are
 * joined once, when the last one is here (never a copy per chunk). */
export function frameReader(onPayload) {
  let chunks = [], have = 0, need = -1;
  const take = (n) => {
    // the first n bytes of what is buffered, as one array, and the rest kept
    const out = new Uint8Array(n);
    let at = 0;
    while (at < n) {
      const c = chunks[0], k = Math.min(c.length, n - at);
      out.set(c.subarray(0, k), at);
      at += k;
      if (k === c.length) chunks.shift();
      else chunks[0] = c.subarray(k);
    }
    have -= n;
    return out;
  };
  return {
    push(chunk) {
      const c = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
      if (c.length) { chunks.push(c); have += c.length; }
      for (;;) {
        if (need < 0) {
          if (have < 4) return;
          const h = take(4);
          need = new DataView(h.buffer).getUint32(0, true);
          if (need > FRAME_MAX) throw new Error(`a frame of ${need} bytes is larger than the limit (${FRAME_MAX})`);
        }
        if (have < need) return;
        const p = take(need);
        need = -1;
        onPayload(p);
      }
    },
    get buffered() { return have; },
  };
}
