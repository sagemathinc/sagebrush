// One canonical JSON encoder: for the permission digest (the page and this agent must turn the same action into the
// same bytes; the page has a copy, and both are checked against test/canon-fixtures.json) and for the fleet protocol's
// signed bytes (canonical.mjs beside it). Pure, with no Node built-ins, so the fleet core runs unchanged in a page or a
// Worker; lib/canon.mjs re-exports it with the permission digest.
//
// Accepted values: null, true, false, strings, integers with |n| <= 2^53 - 1 (not -0), arrays, and plain objects
// (prototype Object.prototype or null) whose own properties are all plain data (no getters, no symbols). Anything
// else is refused. Object keys are sorted by UTF-16 code units (JavaScript's default sort) and arrays keep their
// order; there is no whitespace. Strings are written as ES2019 JSON.stringify writes them: \" \\ \b \f \n \r \t,
// other control characters as lower-case \u00xx, lone surrogates as lower-case \udxxx, nothing else escaped.
//
// Bounded as it goes: the walk keeps a running count of the output's UTF-8 bytes and stops as soon as it would pass
// the budget. An object's or array's size is checked against the remaining budget before its keys are collected or
// sorted (each entry costs at least a few bytes), and a string's length before it is escaped (each UTF-16 unit is at
// least one byte), so a huge input is refused without being copied. Depth is checked on the way down.
//
// It returns the canonical text and an inert copy of the value (plain data only), so what is counted, hashed, shown
// and run are the same snapshot.

export const CANON_MAX = 16 * 1024; // the most of a tool's arguments a person reviews, as canonical text
export const CANON_DEPTH = 32;

class Refused extends Error {}

const hex4 = (n) => n.toString(16).padStart(4, "0");

// The UTF-8 length and JSON form of one string, or a refusal once it would pass `room` bytes.
function encodeString(s, room) {
  if (s.length + 2 > room) throw new Refused("too large");
  let bytes = 2;
  const parts = ['"'];
  let run = 0; // (start of the current run of characters written as they are)
  const flush = (i) => { if (i > run) parts.push(s.slice(run, i)); };
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    let esc = null, n;
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

const plainProto = (v) => { const p = Object.getPrototypeOf(v); return p === Object.prototype || p === null; };

// canon(value[, max]): {ok: true, text, value, bytes} or {ok: false, reason}.
export function canon(value, max = CANON_MAX) {
  let used = 0;
  const take = (n) => { used += n; if (used > max) throw new Refused("too large"); };
  const walk = (v, depth) => {
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
    const keys = [];
    for (const k in v) if (Object.prototype.hasOwnProperty.call(v, k)) keys.push(k);
    if (Object.getOwnPropertyNames(v).length !== keys.length) throw new Refused("an object with hidden properties");
    keys.sort();
    const out = Object.create(null), texts = [];
    for (const k of keys) {
      const d = Object.getOwnPropertyDescriptor(v, k);
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

// The UTF-8 length of one string as JSON.stringify writes it (quotes included), counted without building anything,
// or -1 as soon as it would pass room.
function countString(s, room) {
  if (s.length + 2 > room) return -1;
  let bytes = 2;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x22 || c === 0x5c || c === 8 || c === 9 || c === 10 || c === 12 || c === 13) bytes += 2;
    else if (c < 0x20) bytes += 6;
    else if (c < 0x80) bytes += 1;
    else if (c < 0x800) bytes += 2;
    else if (c >= 0xd800 && c <= 0xdbff) {
      const d = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
      if (d >= 0xdc00 && d <= 0xdfff) { bytes += 4; i++; } else bytes += 6;
    } else if (c >= 0xdc00 && c <= 0xdfff) bytes += 6;
    else bytes += 3;
    if (bytes > room) return -1;
  }
  return bytes;
}

// The UTF-8 length of JSON.stringify(v), counted without building it (no string, slice or array is made), or -1 as
// soon as it would pass max. For the messages this agent builds itself (plain data: no toJSON, no getters); keys in
// their own order, as JSON.stringify writes them. Used to refuse a message over the connection's frame, and to check
// the writer's room, before anything is serialized.
export function jsonBytes(v, max) {
  let used = 0;
  const over = () => used > max;
  const walk = (x, inArray) => {
    if (x === null) { used += 4; return true; }
    switch (typeof x) {
      case "boolean": used += x ? 4 : 5; return true;
      case "number": used += Number.isFinite(x) ? String(x).length : 4; return true;
      case "string": {
        const n = countString(x, max - used);
        used = n < 0 ? max + 1 : used + n;
        return true;
      }
      case "undefined": case "function": case "symbol":
        if (inArray) { used += 4; return true; } // (null in an array)
        return false; // (left out of an object)
      case "bigint": throw new TypeError("a bigint");
    }
    if (Array.isArray(x)) {
      used += 2 + Math.max(0, x.length - 1);
      for (let i = 0; i < x.length && !over(); i++) walk(x[i], true);
      return true;
    }
    used += 2;
    let first = true;
    for (const k in x) {
      if (!Object.prototype.hasOwnProperty.call(x, k)) continue;
      const val = x[k];
      if (val === undefined || typeof val === "function" || typeof val === "symbol") continue; // (left out, key too)
      used += (first ? 0 : 1) + 1; // (a comma and the colon)
      first = false;
      const n = countString(k, max - used);
      if (n < 0) { used = max + 1; return true; }
      used += n;
      walk(val, false);
      if (over()) return true;
    }
    return true;
  };
  walk(v, true);
  return over() ? -1 : used;
}
