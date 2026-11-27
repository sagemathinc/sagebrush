// Page mirror of sagebrush-agent lib/tags.mjs at e826c5a7438c9e5189856391e5dba15037f9a6c1.
// agent-tags.schema.json is the byte-identical schema. test-agent-tags.mjs pins it and the agent's vectors.
// No persistence, membership discovery or authorization here: callers enforce their closed protocol and grant.
import { canon } from "./agent-canon";

export const TAG_LIMITS = Object.freeze({ enabled: 16, name: 32, grantBytes: 4096 });
export const GLOBAL_TAG_NAME = "global";
export const TAG_ID_PATTERN = "^[a-z2-7]{25}[aeimquy4]$";
export const TAG_NAME_PATTERN = "^[a-z0-9][a-z0-9-]{0,31}$";
export const TAG_RESERVED_NAMES = Object.freeze(["own", "con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9", "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9"]);
const idPattern = new RegExp(TAG_ID_PATTERN), namePattern = new RegExp(TAG_NAME_PATTERN);
const reserved = new Set<string>(TAG_RESERVED_NAMES);
const bad = (): never => { throw new TypeError("invalid tags v1 value"); };
export const validTagId = (v: unknown): v is string => typeof v === "string" && v.length === 26 && idPattern.test(v);
export const validTagName = (v: unknown): v is string => typeof v === "string" && v.length <= TAG_LIMITS.name && namePattern.test(v) && !reserved.has(v);

export type AgentTag = Readonly<{ id: string; name: string }>;
export type MemoryTagGrant = Readonly<{ tags: readonly string[] }>;
function snapshot(v: unknown): unknown {
  const r = canon(v, TAG_LIMITS.grantBytes);
  if (!r.ok) return bad();
  return r.value;
}
function keys(v: unknown, required: readonly string[]): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v) || Object.keys(v).length !== required.length || !required.every((k) => Object.hasOwn(v, k))) return bad();
  return v as Record<string, unknown>;
}
export function parseTag(value: unknown): AgentTag {
  const v = keys(snapshot(value), ["id", "name"]);
  if (!validTagId(v.id) || !validTagName(v.name)) return bad();
  return Object.freeze({ id: v.id, name: v.name });
}
export function parseEnabledTags(value: unknown): readonly string[] {
  const v = snapshot(value);
  if (!Array.isArray(v) || v.length > TAG_LIMITS.enabled) return bad();
  for (let i = 0; i < v.length; i++) if (!validTagId(v[i]) || (i && v[i - 1] >= v[i])) return bad();
  return Object.freeze(v);
}
export function parseMemoryGrant(value: unknown): MemoryTagGrant {
  const v = keys(snapshot(value), ["tags"]);
  return Object.freeze({ tags: parseEnabledTags(v.tags) });
}
function encoded(v: unknown, max = 16 * 1024): string {
  const r = canon(v, max);
  if (!r.ok) return bad();
  return r.text;
}
export function encodeTag(value: unknown): string { return encoded(parseTag(value)); }
export function encodeMemoryGrant(value: unknown): string { return encoded(parseMemoryGrant(value)); }
// Bounds the COMPLETE grant/reload record only. Does not replace its closed protocol/authority validation.
export function encodeBoundedGrant(value: unknown): string { return encoded(value, TAG_LIMITS.grantBytes); }
