// A notebook's or board's JSON text for the shell (plan-bash-shell r3 §3.1: documents read as their JSON
// text), within a byte cap: exactly JSON.stringify(value, null, 1) + "\n" as UTF-8, but refused the moment
// the text would pass `max` bytes (LIMIT-BASH-S2-2).  So a document over the cap is never serialized whole:
// the walk stops where the cap is reached, and no more than one value's text past it is ever held.

/** The text would be more than the cap. */
export class TooLarge extends Error {}

const enc = new TextEncoder();

/** `value` (plain JSON data, as documents are kept) as JSON.stringify(value, null, 1) + "\n", in UTF-8, or TooLarge past `max` bytes. */
export function boundedJson(value: unknown, max: number): Uint8Array {
  const parts: Uint8Array[] = [];
  let n = 0;
  const put = (s: string) => {
    const b = enc.encode(s);
    n += b.length;
    if (n > max) throw new TooLarge(`larger than ${max} bytes`);
    parts.push(b);
  };
  const seen = new Set<object>();
  // (as JSON.stringify: toJSON first; undefined, functions and symbols are left out of objects and are null in arrays)
  const prep = (v: unknown, key: string): unknown => {
    if (v !== null && typeof v === "object" && typeof (v as any).toJSON === "function") return (v as any).toJSON(key);
    return v;
  };
  const skip = (v: unknown) => v === undefined || typeof v === "function" || typeof v === "symbol";
  const emit = (v: unknown, depth: number): void => {
    if (v === null) return put("null");
    switch (typeof v) {
      case "boolean":
        return put(v ? "true" : "false");
      case "number":
        return put(Number.isFinite(v) ? String(v) : "null");
      case "string":
        return put(JSON.stringify(v));
      case "bigint":
        throw new TypeError("a document holds no BigInt");
    }
    const o = v as object;
    if (seen.has(o)) throw new TypeError("a document holds no cycle");
    seen.add(o);
    const pad = " ".repeat(depth + 1), end = " ".repeat(depth);
    if (Array.isArray(o)) {
      if (!o.length) put("[]");
      else {
        put("[");
        for (let i = 0; i < o.length; i++) {
          put((i ? "," : "") + "\n" + pad);
          const x = prep(o[i], String(i));
          if (skip(x)) put("null");
          else emit(x, depth + 1);
        }
        put("\n" + end + "]");
      }
    } else {
      let first = true;
      for (const k of Object.keys(o)) {
        const x = prep((o as any)[k], k);
        if (skip(x)) continue;
        put((first ? "{" : ",") + "\n" + pad + JSON.stringify(k) + ": ");
        first = false;
        emit(x, depth + 1);
      }
      put(first ? "{}" : "\n" + end + "}");
    }
    seen.delete(o);
  };
  const top = prep(value, "");
  if (skip(top)) throw new TypeError("a document is a value");
  emit(top, 0);
  put("\n");
  const out = new Uint8Array(n);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
