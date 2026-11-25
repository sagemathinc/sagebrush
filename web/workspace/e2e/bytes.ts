// The end-to-end crypto's byte encodings: fixed-width big-endian integers and length-prefixed fields, so that every
// derivation input and AAD (keys.ts, chunks.ts) has one encoding and no two field lists encode alike. Refusals are
// the fleet core's FleetError, with a code from schema/fleet/reasons.json.
import { fleetCore } from "../fleet/install.ts";

export const refuse = (code: "bad_form" | "limit", message: string): never => fleetCore().refuse(code, message);

const te = new TextEncoder();
export const utf8 = (s: string): Uint8Array => te.encode(s);

export function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

export function u32(n: number): Uint8Array {
  if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) refuse("bad_form", "a u32 is an integer from 0 to 2^32 - 1");
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n);
  return b;
}

export function u64(n: number): Uint8Array {
  if (!Number.isSafeInteger(n) || n < 0) refuse("bad_form", "a length or number is an integer from 0 to 2^53 - 1");
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, BigInt(n));
  return b;
}

/** A field: its byte length as a u32, then its bytes. */
export const field = (b: Uint8Array): Uint8Array<ArrayBuffer> => concat(u32(b.length), b);

// (an account, object, version or other name: a non-empty, well-formed string of at most 256 UTF-8 bytes, no NUL.
//  Well-formed: TextEncoder writes any lone surrogate as U+FFFD, so two different strings would name the same thing)
const NAME_MAX = 256;

/** Whether a string is well-formed UTF-16: every high surrogate followed by a low one, every low one preceded by one. */
export function wellFormed(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xdc00 && c <= 0xdfff) return false; // (a low surrogate not consumed as the second half of a pair)
    if (c >= 0xd800 && c <= 0xdbff) {
      const d = i + 1 < s.length ? s.charCodeAt(i + 1) : -1;
      if (!(d >= 0xdc00 && d <= 0xdfff)) return false;
      i++;
    }
  }
  return true;
}
export function name(s: unknown, what: string): Uint8Array {
  if (typeof s !== "string" || s.length === 0 || s.includes("\0")) refuse("bad_form", `${what} is a non-empty string`);
  if (!wellFormed(s as string)) refuse("bad_form", `${what} is well-formed Unicode (no lone surrogate)`);
  const b = utf8(s as string);
  if (b.length > NAME_MAX) refuse("bad_form", `${what} is at most ${NAME_MAX} bytes`);
  return field(b);
}

export function bytes32(b: unknown, what: string): Uint8Array {
  if (!(b instanceof Uint8Array) || b.length !== 32) refuse("bad_form", `${what} is 32 bytes`);
  return b as Uint8Array;
}

// (WebCrypto's typings want an ArrayBuffer-backed view; every Uint8Array here is one)
export const buf = (b: Uint8Array): BufferSource => b as BufferSource;

export const hex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
