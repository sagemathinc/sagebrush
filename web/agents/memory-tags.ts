// The person's memory tags (agent memory v1): lane D's {id, name}, kept in this browser only (v1's ruling: another
// browser shows a tag's id until it's named there). The page owns this list; an agent never supplies or sees it.
// Making and renaming tags comes with the Memory view.
import { parseTag, type AgentTag } from "../workspace/agent-tags";

export const MEMORY_TAGS_KEY = "sb-memory-tags-v1";

/** The tags as kept here, each as lane D parses it (anything else is dropped), by name. */
export function listTags(): readonly AgentTag[] {
  let raw: unknown;
  try { raw = JSON.parse(localStorage.getItem(MEMORY_TAGS_KEY) ?? "[]"); } catch { return []; }
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: AgentTag[] = [];
  for (const v of raw) {
    try {
      const t = parseTag(v);
      if (!seen.has(t.id)) { seen.add(t.id); out.push(t); }
    } catch { /* not a tag: dropped */ }
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** A tag's name here, or null: a display name only, never authority. */
export const tagName = (id: string): string | null => listTags().find((t) => t.id === id)?.name ?? null;
