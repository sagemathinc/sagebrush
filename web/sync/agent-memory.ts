// The rules of Autonomous agents' memory namespaces in the agents' reserved folder (agent-autonomous-o4-memory r2,
// sha256 82ef9fee…, §0-§4): pure, and wired to nothing yet.  The endpoint answers every agent call under /.agents as a
// path that isn't there (agent-token.ts RESERVED) until a fleet's Autonomous memory feature is on; memory v1 (Pair and
// Delegate) never turns it on.  These functions are what the endpoint will use once it is: the scopes an agent gets
// back (§2.1), which namespace a path is in (§3), and the note limits and expiry (§4).

import { within } from "../workspace/paths.ts";
import { RESERVED, type Scope } from "./agent-token.ts";

/** The memory tree (§1): /.agents/memory/agent/<agent id>/ and /.agents/memory/tag/<tag id>/. */
export const MEMORY = RESERVED + "/memory";
/** An id of the fleet schemas (§1.1): 26 lowercase base32 characters, the last one of a e i m q u y 4. */
export const FLEET_ID = /^[a-z2-7]{25}[aeimquy4]$/;
/** A note's name (§4): 1 to 64 lowercase letters, digits and inner hyphens, then ".md". */
export const NOTE_NAME = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?\.md$/;
export const MEMORY_LIMITS = {
  /** a note's text, in UTF-8 bytes (§4) */
  noteBytes: 8192,
  /** live notes in one namespace (§4) */
  notesPerNamespace: 500,
  /** a note expires this long after it was last saved or renewed, in ms (§4) */
  expiryMs: 90 * 86_400_000,
};

/** What the endpoint knows of the calling agent, from its capability's record and the current grant (§2.1). */
export interface MemoryCaller {
  agent: string;
  tags: readonly string[];
  rights: readonly string[];
}

/**
 * The memory scopes M an agent gets back (§2.1): its own namespace and each of its tags', read-write; none at all
 * unless the fleet's Autonomous memory feature is on and the caller has the `memory` right.  Ids that aren't fleet ids
 * give nothing (they can't name a namespace).
 */
export function memoryScopes(caller: MemoryCaller, featureOn: boolean): Scope[] {
  if (!featureOn || !caller.rights.includes("memory") || !FLEET_ID.test(caller.agent)) return [];
  const out: Scope[] = [{ path: `${MEMORY}/agent/${caller.agent}`, access: "write" }];
  for (const t of caller.tags) if (FLEET_ID.test(t) && !out.some((s) => s.path === `${MEMORY}/tag/${t}`)) out.push({ path: `${MEMORY}/tag/${t}`, access: "write" });
  return out;
}

/** The namespace a (normalized) path is in: `agent/<id>` or `tag/<id>`, or null for any other path. */
export function namespaceOf(path: string): string | null {
  if (!within(path, MEMORY)) return null;
  const m = /^\/\.agents\/memory\/(agent|tag)\/([^/]+)(?:\/|$)/.exec(path);
  return m && FLEET_ID.test(m[2]) ? `${m[1]}/${m[2]}` : null;
}

/** Whether `path` is a note directly in a namespace with a valid name (§1: namespaces hold no folders; §4: names). */
export function isNotePath(path: string): boolean {
  const ns = namespaceOf(path);
  if (ns === null) return false;
  const rest = path.slice(MEMORY.length + 1 + ns.length + 1);
  return NOTE_NAME.test(rest);
}

/** Whether a rename or duplicate may go from `from` to `to` (§3): if either is in the reserved folder, both must be
 * notes (isNotePath) in the same namespace; anything else there (the folder's own paths, the memory parents, a
 * namespace's root, an id that isn't a fleet id, a nested pseudo-note) never moves.  Two ordinary paths: not this
 * rule's to refuse. */
export function sameNamespaceMove(from: string, to: string): boolean {
  if (!within(from, RESERVED) && !within(to, RESERVED)) return true;
  return isNotePath(from) && isNotePath(to) && namespaceOf(from) === namespaceOf(to);
}

/** A note's text within its limit (§4): at most 8,192 bytes of UTF-8. */
export function noteBytesOk(text: string): boolean {
  return new TextEncoder().encode(text).length <= MEMORY_LIMITS.noteBytes;
}

/** Whether a note saved or renewed at `savedMs` has expired at `nowMs` (§4): strictly after 90 days. */
export function expired(savedMs: number, nowMs: number): boolean {
  return nowMs > savedMs + MEMORY_LIMITS.expiryMs;
}
