// What a reader's answer may change on a board in View (documents open in View, web/doc-mode.ts; @sagebrush's ruling
// on #658: answering is a reader's interaction, like running code, so a quiz is answered without Edit, bound tightly):
// only the answer state of one question item (its answer, the reader's own words, its attempts and verdict), never
// its design (prompt, options, check), never another item, never the pages.

/** A question's answer state: the fields an answer writes (edit.ts answer() and attempt()). */
export const ANSWER_STATE = ["answer", "note", "attempts", "wrongAttempts", "result"] as const;

type Any = Record<string, unknown>;
const isObj = (v: unknown): v is Any => !!v && typeof v === "object" && !Array.isArray(v);

/** Every question item of a document, by where it is (its page's place and its id), with its answer state; and the
 * document with those states taken out. */
function split(doc: unknown): { states: Map<string, string>; rest: string } {
  const d = JSON.parse(JSON.stringify(doc ?? null));
  const states = new Map<string, string>();
  const walk = (nodes: unknown, at: string) => {
    if (!Array.isArray(nodes)) return;
    for (const n of nodes) {
      if (!isObj(n)) continue;
      if (n.kind === "ask") {
        const s: Any = {};
        for (const k of ANSWER_STATE) if (k in n) { s[k] = n[k]; delete n[k]; }
        states.set(at + "\u0000" + String(n.id), JSON.stringify(s));
      }
      if (n.kind === "group") walk(n.children, at);
    }
  };
  if (isObj(d)) {
    walk(d.nodes, "-");
    if (Array.isArray(d.pages)) d.pages.forEach((p: unknown, i: number) => { if (isObj(p)) walk(p.nodes, String(i)); });
  }
  return { states, rest: JSON.stringify(d) };
}

/** Whether `after` differs from `before` in nothing but the answer state of at most one question item. */
export function answerOnly(before: unknown, after: unknown): boolean {
  const a = split(before), b = split(after);
  if (a.rest !== b.rest || a.states.size !== b.states.size) return false;
  let changed = 0;
  for (const [k, s] of a.states) {
    if (!b.states.has(k)) return false;
    if (b.states.get(k) !== s) changed++;
  }
  return changed <= 1;
}
