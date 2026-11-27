// An agent grant's scope rule (design/agent-endpoint.md §1; agent-autonomous-o4-memory r2, §0-§2), pure and shared: the
// sync server's check imports it today, and a device's check of a relayed verb imports it once grants are sealed to
// the person's devices, so the reserved folder can't drop out at that cutover.

import { normPath, within } from "./paths.ts";

export type Access = "read" | "write";
export type Scope = { path: string; access: Access };

/**
 * The agents' reserved folder: no grant's scope reaches into it, "/" included, and a scope at or under it is refused
 * when the grant is made.  An agent call naming a path in it is answered as one that isn't there.  (Autonomous agents'
 * memory namespaces, added back per agent, come later, behind a fleet switch that is off: until then nothing under it
 * is any agent's.)
 */
export const RESERVED = "/.agents";

/** Whether `path` (normalized: normPath's) is the reserved folder or in it: whole segments, after normalization. */
export const reserved = (path: string) => within(path, RESERVED);

/** Whether `path` (normalized) is inside a scope with `need`: whole segments, so "/Algebra" never covers "/Algebra2".
 * Never inside the reserved folder. */
export function inScope(scopes: Scope[], path: string, need: Access): boolean {
  if (reserved(path)) return false;
  return scopes.some((s) => within(path, s.path) && (need === "read" || s.access === "write"));
}

/**
 * A call's path against a grant's scopes, in the one order every caller uses: normalized and validated first (normPath:
 * a path it refuses is "invalid"), then the reserved folder ("reserved", whatever the scopes, "/" included), then the
 * ordinary scope match ("out", or the path as normalized).  The server's endpoint answers "reserved" as a path that
 * isn't there; so does a device answering a relayed verb.
 */
export function scopeCheck(scopes: Scope[], raw: unknown, need: Access): { verdict: "invalid" } | { verdict: "reserved" | "out" | "in"; path: string } {
  let path: string;
  try {
    path = normPath(raw);
  } catch {
    return { verdict: "invalid" };
  }
  if (reserved(path)) return { verdict: "reserved", path };
  return { verdict: inScope(scopes, path, need) ? "in" : "out", path };
}
