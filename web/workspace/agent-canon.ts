// The permission digest's canonical JSON, the page's side: a copy of sagebrush-agent's lib/canon.mjs (canon and
// permissionDigest), so the page and the agent turn the same action into the same bytes. Both are checked against the
// agent's canon fixtures (test-agent-canon.mjs). An Allow counts only with the digest of the very action the person
// was shown: the agent computes it from the action it asked about, the page from the card it shows, and the agent
// compares the two. Over `sagebrush remote` (the agent's --stdio) every Allow carries it.
//
// Accepted values: null, true, false, strings, integers with |n| <= 2^53 - 1 (not -0), arrays, and plain objects
// (prototype Object.prototype or null) whose own properties are all plain data (no getters, no symbols). Anything
// else is refused. Object keys are sorted by UTF-16 code units (JavaScript's default sort) and arrays keep their
// order; there is no whitespace. Strings are written as ES2019 JSON.stringify writes them: \" \\ \b \f \n \r \t,
// other control characters as lower-case \u00xx, lone surrogates as lower-case \udxxx, nothing else escaped. Bounded
// as it goes, as the agent's is: the same budget, checked at the same points.

export const CANON_MAX = 16 * 1024; // the most of a tool's arguments a person reviews, as canonical text
export const CANON_DEPTH = 32;
export const DIGEST_DOMAIN = "sb-agent-permission/1\n";

class Refused extends Error {}

const hex4 = (n: number) => n.toString(16).padStart(4, "0");

/** The UTF-8 length and JSON form of one string, or a refusal once it would pass `room` bytes. */
function encodeString(s: string, room: number): { text: string; bytes: number } {
  if (s.length + 2 > room) throw new Refused("too large");
  let bytes = 2;
  const parts = ['"'];
  let run = 0; // (start of the current run of characters written as they are)
  const flush = (i: number) => { if (i > run) parts.push(s.slice(run, i)); };
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    let esc: string | null = null, n = 0;
    if (c === 0x22) esc = '\\"';
    else if (c === 0x5c) esc = "\\\\";
    else if (c < 0x20) esc = c === 8 ? "\\b" : c === 9 ? "\\t" : c === 10 ? "\\n" : c === 12 ? "\\f" : c === 13 ? "\\r" : "\\u" + hex4(c);
    else if (c >= 0xd800 && c <= 0xdbff) {
      const d = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
      if (d >= 0xdc00 && d <= 0xdfff) { n = 4; i++; } // (a pair: one 4-byte character)
      else esc = "\\u" + hex4(c);
    } else if (c >= 0xdc00 && c <= 0xdfff) esc = "\\u" + hex4(c);
    else n = c < 0x80 ? 1 : c < 0x800 ? 2 : 3;
    if (esc !== null) {
      flush(i);
      parts.push(esc);
      run = i + 1;
      n = esc.length;
    }
    bytes += n;
    if (bytes > room) throw new Refused("too large");
  }
  flush(s.length);
  parts.push('"');
  return { text: parts.join(""), bytes };
}

const plainProto = (v: object) => { const p = Object.getPrototypeOf(v); return p === Object.prototype || p === null; };

export type Canon = { ok: true; text: string; value: unknown; bytes: number } | { ok: false; reason: string };

/** The canonical text of `value` and an inert copy of it, or why it is refused. */
export function canon(value: unknown, max = CANON_MAX): Canon {
  let used = 0;
  const take = (n: number) => { used += n; if (used > max) throw new Refused("too large"); };
  const walk = (v: unknown, depth: number): { t: string; v: unknown } => {
    if (v === null) { take(4); return { t: "null", v: null }; }
    if (v === true || v === false) { take(v ? 4 : 5); return { t: String(v), v }; }
    if (typeof v === "string") { const e = encodeString(v, max - used); used += e.bytes; return { t: e.text, v }; }
    if (typeof v === "number") {
      if (!Number.isSafeInteger(v) || Object.is(v, -0)) throw new Refused("a number that isn't a safe integer");
      const t = String(v);
      take(t.length);
      return { t, v };
    }
    if (typeof v !== "object") throw new Refused(`a ${typeof v}`);
    if (depth >= CANON_DEPTH) throw new Refused("nested too deeply");
    if (Array.isArray(v)) {
      if (Object.getPrototypeOf(v) !== Array.prototype) throw new Refused("an array of another kind");
      const n = v.length;
      take(2 + Math.max(0, 2 * n - 1)); // (each element is at least one byte, with a comma between)
      used -= Math.max(0, n); // (the elements' own bytes are counted as they are written; the commas stay counted)
      const out = new Array(n), texts = new Array(n);
      for (let i = 0; i < n; i++) {
        const d = Object.getOwnPropertyDescriptor(v, i);
        if (!d || !("value" in d)) throw new Refused("an array with a hole or a getter");
        const r = walk(d.value, depth + 1);
        out[i] = r.v; texts[i] = r.t;
      }
      return { t: "[" + texts.join(",") + "]", v: out };
    }
    if (!plainProto(v)) throw new Refused("an object of another kind");
    if (Object.getOwnPropertySymbols(v).length) throw new Refused("an object with symbol keys");
    // (count own keys one at a time, stopping at the budget, before collecting or sorting any)
    let n = 0;
    const room = max - used;
    for (const k in v) {
      if (!Object.prototype.hasOwnProperty.call(v, k)) continue;
      n++;
      if (2 + 5 * n - 1 > room) throw new Refused("too large"); // ('"":0' is 4 bytes, with a comma between)
    }
    take(2 + Math.max(0, n - 1)); // (the braces and commas; each entry's bytes are counted as it is written)
    const keys: string[] = [];
    for (const k in v) if (Object.prototype.hasOwnProperty.call(v, k)) keys.push(k);
    if (Object.getOwnPropertyNames(v).length !== keys.length) throw new Refused("an object with hidden properties");
    keys.sort();
    const out: Record<string, unknown> = Object.create(null), texts: string[] = [];
    for (const k of keys) {
      const d = Object.getOwnPropertyDescriptor(v, k)!;
      if (!("value" in d)) throw new Refused("an object with a getter");
      const ke = encodeString(k, max - used - 1);
      used += ke.bytes + 1; // (the key and its colon)
      const r = walk(d.value, depth + 1);
      out[k] = r.v;
      texts.push(ke.text + ":" + r.t);
    }
    return { t: "{" + texts.join(",") + "}", v: out };
  };
  try {
    const r = walk(value, 0);
    return { ok: true, text: r.t, value: r.v, bytes: used };
  } catch (e) {
    if (e instanceof Refused) return { ok: false, reason: e.message };
    if (e instanceof RangeError) return { ok: false, reason: "too large" };
    throw e;
  }
}

/** The canonical text a permission digest is taken over: canon's form of {child, conversation, input, request, tool},
 * those keys in that (sorted) order; null if any part is refused. */
export function permissionText(a: { child: unknown; conversation: unknown; request: unknown; tool: unknown; input: unknown }): string | null {
  const c = canon(a.input);
  if (!c.ok) return null;
  const ids = [a.child, a.conversation, a.request, a.tool].map((s) => (typeof s === "string" ? canon(s, 1024) : ({ ok: false, reason: "not a string" } as Canon)));
  if (!ids.every((r) => r.ok)) return null;
  const [ch, cv, rq, tl] = ids.map((r) => (r as { text: string }).text);
  return `{"child":${ch},"conversation":${cv},"input":${c.text},"request":${rq},"tool":${tl}}`;
}

const b64url = (u: Uint8Array) => { let s = ""; for (const b of u) s += String.fromCharCode(b); return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); };

/** The digest of one permission question (base64url of SHA-256 over the domain and the canonical text), as the agent
 * computes it; null if the action can't be put in canonical form (then the page can't allow it, only deny). */
export async function permissionDigest(a: { child: unknown; conversation: unknown; request: unknown; tool: unknown; input: unknown }, subtle: SubtleCrypto = globalThis.crypto.subtle): Promise<string | null> {
  const text = permissionText(a);
  if (text === null) return null;
  return b64url(new Uint8Array(await subtle.digest("SHA-256", new TextEncoder().encode(DIGEST_DOMAIN + text))));
}
