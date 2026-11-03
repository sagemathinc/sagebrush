// A .tex's code items as cells with identities (plan L1b r4b §2 item 1 and 1b, §5 step 1): the items found in the
// source with their exact ranges, ids carried through every edit by the editor's change sets (posmap.ts), and on
// reopen matched to the results file by (kind, code hash, ordinal). Pure; test-latex-cells.mjs checks it against a
// reference that tracks each character's identity.
//
// The identity rule (r4b, daybreak3's CLEAR): after a change set, an old item keeps its id only through a unique,
// one-to-one correspondence of the same kind: some of its characters survive inside exactly one new item, and that new
// item holds surviving characters of no other old item. Every other case (an item wholly replaced, split across two,
// two merged into one, a kind changed, a new item) gets a fresh id; so does every item a non-unique correspondence
// touches. A fresh id gives a fresh seed and so a fresh output key: the item is stale and runs again.
//
// Items written by macros or read from \input files have no range of their own in this file: they are not anchored
// here, and take the reopen rule (kind, code hash, ordinal) at every parse, ambiguity giving fresh ids.
import type { ChangeSet } from "./posmap";

export type Kind = "sage" | "sageplot" | "sagesilent" | "sageblock" | "py" | "pyc" | "pycode" | "pyblock" | "matlab" | "matlabcode" | "matlabblock";
export const LANG: Record<Kind, "sage" | "python" | "matlab"> = {
  sage: "sage", sageplot: "sage", sagesilent: "sage", sageblock: "sage",
  py: "python", pyc: "python", pycode: "python", pyblock: "python",
  matlab: "matlab", matlabcode: "matlab", matlabblock: "matlab",
};
const COMMANDS = new Set<Kind>(["sage", "sageplot", "py", "pyc", "matlab"]);
const ENVS = new Set<Kind>(["sagesilent", "sageblock", "pycode", "pyblock", "matlabcode", "matlabblock"]);
// (environments whose content isn't TeX: an item's command inside them isn't one)
const VERBATIM = /^(verbatim\*?|Verbatim|lstlisting|minted|comment|filecontents\*?)$/;

export interface Item { kind: Kind; start: number; end: number; code: string }

/** At most this many items in one document (the engine's own bound for code items is the same). */
export const ITEMS_MAX = 1000;

/** The code items of a .tex source, in order, each with its exact range [start, end) (the whole command or
 * environment) and its code (a command's argument as written; an environment's body). Comments and verbatim
 * environments are skipped; an unterminated item ends the scan (the engine shows it as not finished). */
export function scanItems(text: string): Item[] {
  const out: Item[] = [];
  const n = text.length;
  let i = 0;
  while (i < n && out.length < ITEMS_MAX) {
    const ch = text.charCodeAt(i);
    if (ch === 37 /* % */) { const j = text.indexOf("\n", i); i = j < 0 ? n : j + 1; continue; }
    if (ch !== 92 /* \ */) { i++; continue; }
    // a control word
    let j = i + 1;
    while (j < n && /[A-Za-z]/.test(text[j])) j++;
    if (j === i + 1) { i += 2; continue; }
    const name = text.slice(i + 1, j);
    if (name === "begin") {
      const env = braced(text, skipSpace(text, j));
      if (!env) { i = j; continue; }
      const kind = env.body as Kind;
      if (ENVS.has(kind) || VERBATIM.test(env.body)) {
        const endTag = "\\end{" + env.body + "}", k = text.indexOf(endTag, env.end);
        if (k < 0) break;
        if (ENVS.has(kind)) out.push({ kind, start: i, end: k + endTag.length, code: text.slice(env.end, k) });
        i = k + endTag.length; continue;
      }
      i = env.end; continue;
    }
    if (COMMANDS.has(name as Kind)) {
      // (\sageplot[opts]{...}: an optional argument first)
      let k = skipSpace(text, j);
      if (text[k] === "[") { const c = text.indexOf("]", k); if (c < 0) break; k = skipSpace(text, c + 1); }
      const arg = braced(text, k);
      if (!arg) { i = j; continue; }
      out.push({ kind: name as Kind, start: i, end: arg.end, code: arg.body });
      i = arg.end; continue;
    }
    i = j;
  }
  return out;
}
function skipSpace(t: string, i: number) { while (i < t.length && (t[i] === " " || t[i] === "\t")) i++; return i; }
// ({...} at i, balanced, escapes skipped: its body and the offset after its closing brace)
function braced(t: string, i: number): { body: string; end: number } | null {
  if (t[i] !== "{") return null;
  let depth = 0;
  for (let k = i; k < t.length; k++) {
    const c = t[k];
    if (c === "\\") { k++; continue; }
    if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return { body: t.slice(i + 1, k), end: k + 1 };
  }
  return null;
}

/** The parts of [start, end) of the old text that no change of `cs` deletes, mapped into the new text. */
function survivors(start: number, end: number, cs: ChangeSet): [number, number][] {
  const out: [number, number][] = [];
  let delta = 0, at = start;
  for (const c of cs) {
    if (c.to <= at) { delta += c.insert - (c.to - c.from); continue; }
    if (c.from >= end) break;
    if (c.from > at) out.push([at + delta, c.from + delta]);
    at = Math.max(at, c.to);
    delta += c.insert - (c.to - c.from);
    if (at >= end) break;
  }
  if (at < end) out.push([at + delta, end + delta]);
  return out;
}

/** The ids of the new items after an edit: kept through a unique one-to-one correspondence of the same kind, else
 * fresh (from `nextId`). `old` and `oldIds` are the items and ids before the change set `cs`. */
export function carryIds(old: Item[], oldIds: string[], cs: ChangeSet, now: Item[], nextId: () => string): string[] {
  // (the relation: old i -> new j when some character of i survives inside j)
  const toNew: number[][] = old.map(() => []), toOld: number[][] = now.map(() => []);
  old.forEach((it, i) => {
    for (const [a, b] of survivors(it.start, it.end, cs)) now.forEach((nj, j) => {
      if (a < nj.end && b > nj.start && !toNew[i].includes(j)) { toNew[i].push(j); toOld[j].push(i); }
    });
  });
  return now.map((nj, j) => {
    const os = toOld[j];
    if (os.length === 1) { const i = os[0]; if (toNew[i].length === 1 && old[i].kind === nj.kind) return oldIds[i]; }
    return nextId();
  });
}

/** A saved item's identity, as the results file keeps it (plan r3b's v2 schema). */
export interface Saved { id: string; kind: Kind; codeHash: string; ordinal: number }

/** Each item's (kind, codeHash, ordinal): its ordinal among items of the same kind and code hash, in order. */
export function signatures(items: Item[], hash: (code: string) => string): { kind: Kind; codeHash: string; ordinal: number }[] {
  const seen = new Map<string, number>();
  return items.map((it) => {
    const codeHash = hash(it.code), k = it.kind + "|" + codeHash, ordinal = seen.get(k) ?? 0;
    seen.set(k, ordinal + 1);
    return { kind: it.kind, codeHash, ordinal };
  });
}

/** The ids of items on reopen (no change set): an item whose (kind, codeHash) group has the same size in the saved
 * file as now takes the saved id of its ordinal; a group whose size changed is ambiguous (which duplicate was added or
 * removed can't be known), and all of it gets fresh ids, as does every item with no saved match. */
export function reopenIds(items: Item[], saved: Saved[], hash: (code: string) => string, nextId: () => string): string[] {
  const sig = signatures(items, hash);
  const group = (k: string, list: { kind: string; codeHash: string }[]) => list.filter((s) => s.kind + "|" + s.codeHash === k).length;
  const byKey = new Map(saved.map((s) => [s.kind + "|" + s.codeHash + "|" + s.ordinal, s.id]));
  const used = new Set<string>();
  return sig.map((s) => {
    const k = s.kind + "|" + s.codeHash;
    const id = group(k, sig) === group(k, saved) ? byKey.get(k + "|" + s.ordinal) : undefined;
    if (id && !used.has(id)) { used.add(id); return id; }
    return nextId();
  });
}

/** A fresh-id source: i1, i2, ... past every id already used. */
export function idSource(used: Iterable<string>): () => string {
  let n = 0;
  for (const id of used) { const m = /^i(\d{1,6})$/.exec(id); if (m) n = Math.max(n, Number(m[1])); }
  return () => "i" + ++n;
}

const KINDS = new Set(Object.keys(LANG));
/** A results file's saved identities (v2), validated (plan r3b): a malformed item is dropped alone; a malformed file
 * (not v2, or over the bounds) gives none, so every item is fresh and stale. */
export function savedIdentities(file: unknown): Saved[] {
  const f = file as { format?: unknown; version?: unknown; items?: unknown };
  if (!f || f.format !== "sagebrush-latex-results" || f.version !== 2 || !Array.isArray(f.items) || f.items.length > ITEMS_MAX) return [];
  const out: Saved[] = [];
  for (const it of f.items as any[]) {
    if (!it || typeof it !== "object") continue;
    if (typeof it.id !== "string" || !/^i[0-9]{1,6}$/.test(it.id) || !KINDS.has(it.kind) || typeof it.codeHash !== "string" || !/^[0-9a-f]{64}$/.test(it.codeHash)) continue;
    if (!Number.isInteger(it.ordinal) || it.ordinal < 0 || it.ordinal > 9999) continue;
    out.push({ id: it.id, kind: it.kind, codeHash: it.codeHash, ordinal: it.ordinal });
  }
  return out;
}
