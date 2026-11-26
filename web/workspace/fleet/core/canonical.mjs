// Fleet protocol (r2.2 §1.2): the canonical bytes of a signed object. The encoder is canon.mjs beside this file
// (lib/canon.mjs re-exports it), with the two restrictions signatures need: no lone surrogates (Python and Rust can't
// round-trip them), and verification by byte equality (JSON.parse silently keeps the last of two duplicate keys, so the
// received bytes must be exactly what canon makes of what they parse to).

import { canon } from "./canon.mjs";
import { enc, refuse, utf8 } from "./bytes.mjs";

export const SIGNED_MAX = 64 * 1024;
export const SIGNED_DEPTH = 32;

const LONE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

/** The canonical text of a value for signing (at most `max` bytes), or a `bad_form`/`limit` refusal. */
export function canonText(value, max = SIGNED_MAX) {
  const r = canon(value, max);
  if (!r.ok) refuse(r.reason === "too large" ? "limit" : "bad_form", r.reason);
  if (LONE.test(r.text)) refuse("bad_form", "a lone surrogate");
  // (canon writes a lone surrogate as an escape; a string holding one is refused whichever way it is written)
  if (hasLone(r.value)) refuse("bad_form", "a lone surrogate");
  return r.text;
}

function hasLone(v) {
  if (typeof v === "string") return LONE.test(v);
  if (Array.isArray(v)) return v.some(hasLone);
  if (v && typeof v === "object") return Object.keys(v).some((k) => LONE.test(k) || hasLone(v[k]));
  return false;
}

export const canonBytes = (value, max) => enc(canonText(value, max));

/**
 * Parse received bytes that must be canonical: valid UTF-8, JSON, and byte-identical to canon of what they parse to
 * (§1.2's verify rule). Returns the parsed value.
 */
export function parseCanonical(bytes, max = SIGNED_MAX) {
  if (bytes.length > max) refuse("limit", "too large");
  const text = utf8(bytes);
  let v;
  try { v = JSON.parse(text); } catch { refuse("bad_form", "not JSON"); }
  if (canonText(v, max) !== text) refuse("bad_form", "not canonical");
  return v;
}
