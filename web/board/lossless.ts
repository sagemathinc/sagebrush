// A board's file, edited without losing anything (plan-board-open-edit r7
// §3.1, §3.4): the records boardMerge3 merges, and back, with everything the
// history's records leave out carried along; stable ids for pages without
// one; the file's bytes in canonical()'s layout but nothing cleaned or
// dropped; and the check that decides whether a board can be edited at all,
// and whether bytes about to be written are the board merged: the raw JSON,
// input against output, equal up to the allowed transformations only.
//
// The allowed transformations, and no others:
//   1. whitespace, number formatting and the order of keys (JSON values compared, not text);
//   2. the stable page ids given here (an `id` added only where a page had none);
//   3. a merge's own changes (when a merge result is checked against its inputs:
//      boardMerge3's reports, a separate check).

import { FORMAT, VERSION, boardText, type BoardDoc } from "./doc";
import { toRecords, fromRecords } from "./history";
import { canon, keyOf, type Rec } from "./merge";

/** Records as history.ts's fromRecords reads them (get and getOne by fields). */
function recordSet(rs: Rec[]) {
  const match = (r: Rec, where: Rec) => Object.keys(where).every((k) => r[k] === where[k]);
  return {
    get: (where: Rec) => rs.filter((r) => match(r, where)),
    getOne: (where: Rec) => rs.find((r) => match(r, where)),
  } as any;
}

// (what the history's records leave out, carried in the records an edit merges:
// `tools`, in the doc record; an edge's own `id`, an extension field the
// history's key replaces, as `$eid`; and whether a page (or an unpaged board)
// had `nodes` and `edges` at all, as `$has`, so that none is added on the way back)
const EID = "$eid", HAS = "$has";
const hasOf = (o: any) => ["nodes", "edges"].filter((k) => o[k] !== undefined);

/** A board's JSON as the records an edit merges: history.ts's, with what they leave out carried along. */
export function editRecords(d: any): Rec[] {
  const edges = (es: any[] | undefined) => es?.map((e) => (e.id !== undefined ? (({ id, ...rest }) => ({ ...rest, [EID]: id }))(e) : e));
  const pages = Array.isArray(d.pages) ? d.pages.map((p: any) => ({ ...p, ...(p.edges ? { edges: edges(p.edges) } : {}) })) : undefined;
  const rs = toRecords({ ...d, ...(d.edges ? { edges: edges(d.edges) } : {}), ...(pages ? { pages } : {}) } as BoardDoc) as Rec[];
  const doc = rs.find((r) => r.type === "doc")!;
  if (d.tools !== undefined) doc.tools = JSON.parse(JSON.stringify(d.tools));
  if (!pages) doc[HAS] = hasOf(d);
  const pageRecs = rs.filter((r) => r.type === "page").sort((x, y) => Number(x.pos) - Number(y.pos));
  pageRecs.forEach((r, i) => { r[HAS] = hasOf(d.pages[i]); });
  return rs;
}

/** The records of an edit as the board's JSON. */
export function fromEditRecords(rs: Rec[]): any {
  const doc = rs.find((r) => r.type === "doc");
  const tools = doc?.tools, docHas = doc?.[HAS] as string[] | undefined;
  const pageHas = new Map(rs.filter((r) => r.type === "page").map((r) => [canon(r.page), r[HAS] as string[] | undefined]));
  const strip = (r: Rec) => {
    if (r.type === "doc") { const { tools: _t, [HAS]: _h, ...rest } = r; return rest; }
    if (r.type === "page") { const { [HAS]: _h, ...rest } = r; return rest; }
    return r;
  };
  const d: any = fromRecords(recordSet(rs.map(strip)));
  if (tools !== undefined) d.tools = tools;
  const back = (es: any[]) => es.map((e) => (EID in e ? (({ [EID]: id, ...rest }) => ({ ...rest, id }))(e) : e));
  const shape = (o: any, has: string[] | undefined) => {
    if (o.edges) o.edges = back(o.edges);
    if (has) for (const k of ["nodes", "edges"]) if (!has.includes(k) && Array.isArray(o[k]) && !o[k].length) delete o[k];
  };
  if (Array.isArray(d.pages)) {
    const pids = rs.filter((r) => r.type === "page").sort((x, y) => Number(x.pos) - Number(y.pos)).map((r) => canon(r.page));
    d.pages.forEach((p: any, i: number) => shape(p, pageHas.get(pids[i])));
  } else shape(d, docHas);
  return d;
}

/** The bytes of a board's file: canonical()'s layout, nothing dropped. */
export const serialize = (d: any): string => boardText(d);

/** A stable id for each page without one (`p-` and 8 hex digits of SHA-256(position, revision, attempt)), unique
 * against every id in the board; the board with them, and the ids given. */
export async function givePageIds(d: any, revision: string): Promise<{ doc: any; given: { pos: number; id: string }[] }> {
  if (!Array.isArray(d.pages) || !d.pages.some((p: any) => p.id == null)) return { doc: d, given: [] };
  const taken = new Set<string>();
  const note = (x: unknown) => { if (x != null) taken.add(String(x)); };
  const walk = (ns: any[]) => { for (const n of ns ?? []) { note(n.id); if (Array.isArray(n.children)) walk(n.children); } };
  for (const p of d.pages) { note(p.id); walk(p.nodes); for (const e of p.edges ?? []) note(e.id); }
  const hex = async (s: string) => {
    const h = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
    return [...h.slice(0, 4)].map((x) => x.toString(16).padStart(2, "0")).join("");
  };
  const given: { pos: number; id: string }[] = [];
  const pages: any[] = [];
  for (let i = 0; i < d.pages.length; i++) {
    const p = d.pages[i];
    if (p.id != null) { pages.push(p); continue; }
    let id = "", attempt = 0;
    do id = "p-" + (await hex(JSON.stringify([i, revision, attempt++]))); while (taken.has(id));
    taken.add(id);
    given.push({ pos: i, id });
    pages.push({ id, ...p });
  }
  return { doc: { ...d, pages }, given };
}

/** Whether a board's JSON comes back as it was through the edit's records: equal as JSON values, after
 * `given` (the page ids given) are allowed for; else the first path where it differs. */
export function roundTrips(input: any, given: { pos: number; id: string }[] = []): { ok: true } | { ok: false; at: string } {
  if (input?.format !== FORMAT || input?.version !== VERSION) return { ok: false, at: "format" };
  // (the allowed transformation 2: an id given only to a page that had none)
  for (const g of given) if (!Array.isArray(input.pages) || !input.pages[g.pos] || input.pages[g.pos].id != null) return { ok: false, at: `/pages/${g.pos}/id` };
  const want = given.length ? { ...input, pages: input.pages.map((p: any, i: number) => { const g = given.find((x) => x.pos === i); return g ? { id: g.id, ...p } : p; }) } : input;
  const at = firstDifference(want, fromEditRecords(editRecords(want)), "");
  return at === null ? { ok: true } : { ok: false, at };
}

/** Whether `bytes` are exactly the board `d` (equal JSON values): the check before a write. */
export function bytesAre(bytes: string, d: any): { ok: true } | { ok: false; at: string } {
  let parsed: any;
  try { parsed = JSON.parse(bytes); } catch { return { ok: false, at: "json" }; }
  const at = firstDifference(d, parsed, "");
  return at === null ? { ok: true } : { ok: false, at };
}

/** The first JSON path where x and y differ as JSON values (key order ignored, an undefined key absent), or null. */
export function firstDifference(x: any, y: any, path: string): string | null {
  if (x === y) return null;
  if (typeof x !== typeof y || x === null || y === null || typeof x !== "object") return canon(x) === canon(y) ? null : path || "/";
  if (Array.isArray(x) !== Array.isArray(y)) return path || "/";
  if (Array.isArray(x)) {
    if (x.length !== y.length) return `${path}/length`;
    for (let i = 0; i < x.length; i++) { const d = firstDifference(x[i], y[i], `${path}/${i}`); if (d !== null) return d; }
    return null;
  }
  const keys = new Set([...Object.keys(x).filter((k) => x[k] !== undefined), ...Object.keys(y).filter((k) => y[k] !== undefined)]);
  for (const k of [...keys].sort()) { const d = firstDifference(x[k], y[k], `${path}/${k}`); if (d !== null) return d; }
  return null;
}

export { keyOf };
