// The real systems' names in the function search: what a mode's search shows of the functions the real system
// documents but Sagebrush's index doesn't have.
//
// catalog/<mode>/upstream.txt lists those names, from documentation or a black-box run of the real system (names
// only, never its source).  At build time scripts/upstream-probe.py asks Sagebrush's own runtime which of them it has.
// Each mode's docs-upstream-<mode>.json then holds the names its index (docs-index*.json) lacks:
// - "absent": the runtime doesn't have them either.  The search shows each as Not yet, with Request.
// - "present": the runtime has them, undocumented.  The search shows each with no status.
// The file is fetched with the mode's index (web/docsearch.ts), a LAZY file of the "docs" offline item, never at
// startup, and never part of the CLI, the packages or the indexes.  The caps below bound every list and file, and
// the build refuses a list or a file over them.

/** The modes whose page search gets a file; the others' lists are checked, and wait for their modes to be on the page. */
export const UPSTREAM_MODES = ["sage", "python", "matlab", "magma"] as const;
/** Every mode with a catalog/<mode>/upstream.txt. */
export const UPSTREAM_LISTS = [...UPSTREAM_MODES, "rill", "sprig"] as const;

export const UPSTREAM_CAPS = Object.freeze({
  /** names in one list */
  names: 12000,
  /** UTF-8 bytes of one name */
  nameBytes: 120,
  /** the groups a list names (MATLAB's toolboxes), and the UTF-8 bytes of one */
  groups: 16,
  groupBytes: 80,
  /** bytes of one docs-upstream-<mode>.json, and of all of them (every list's, shipped or not) */
  fileBytes: 192 * 1024,
  allBytes: 640 * 1024,
  /** a mode's areas (web/coverage-areas.mts), and the UTF-8 bytes of an area's id, title and line */
  areas: 32,
  areaIdBytes: 32,
  areaTitleBytes: 120,
  areaLineBytes: 600,
});

export type UpstreamRow = { name: string; group?: string };
/** an area of the mode: what the search shows above its results when a query names it */
export type UpstreamArea = { id: string; title: string; badge: "works" | "partly" | "not-yet" | "none"; line: string };
export type UpstreamAsset = { groups: string[]; absent: string[]; present: string[]; areas?: UpstreamArea[] };

/** `asset` with the mode's areas; throws on more areas than the cap, a malformed or repeated id, an unknown badge, or
 * a field over its byte cap or holding a control character. */
export function withAreas(asset: UpstreamAsset, areas: UpstreamArea[], mode: string): UpstreamAsset {
  const fail = (why: string) => { throw new Error(`docs-upstream-${mode}.json: ${why} (web/upstream-names.mts)`); };
  if (areas.length > UPSTREAM_CAPS.areas) fail(`${areas.length} areas, over ${UPSTREAM_CAPS.areas}`);
  const ids = new Set<string>();
  for (const a of areas) {
    if (!/^[a-z0-9-]+$/.test(a.id) || bytes(a.id) > UPSTREAM_CAPS.areaIdBytes || ids.has(a.id)) fail(`the area id ${JSON.stringify(a.id.slice(0, 40))} is malformed, over ${UPSTREAM_CAPS.areaIdBytes} bytes or repeated`);
    ids.add(a.id);
    if (!["works", "partly", "not-yet", "none"].includes(a.badge)) fail(`area ${a.id}: no badge ${JSON.stringify(a.badge)}`);
    for (const [k, v, cap] of [["title", a.title, UPSTREAM_CAPS.areaTitleBytes], ["line", a.line, UPSTREAM_CAPS.areaLineBytes]] as const)
      if (!v || /[\u0000-\u001f\u007f]/.test(v) || bytes(v) > cap) fail(`area ${a.id}: its ${k} is blank, has a control character or is over ${cap} bytes`);
  }
  return { ...asset, areas: areas.map(({ id, title, badge, line }) => ({ id, title, badge, line })) };
}

const BAD = /[\u0000-\u001f\u007f\s]/;
const bytes = (s: string) => new TextEncoder().encode(s).length;

/** A catalog/<mode>/upstream.txt's rows: "#" lines are comments; a line is a name, then (after a tab) the part of the
 * system that has it.  Throws on a duplicate, a blank or over-long name, whitespace or a control character in a
 * name, or a list over its caps. */
export function parseUpstream(text: string, mode: string): UpstreamRow[] {
  const rows: UpstreamRow[] = [];
  const seen = new Set<string>(), groups = new Set<string>();
  const fail = (why: string) => { throw new Error(`catalog/${mode}/upstream.txt: ${why} (web/upstream-names.mts)`); };
  for (const line of text.split("\n")) {
    if (!line || line.startsWith("#")) continue;
    const [name, group, extra] = line.split("\t");
    if (extra !== undefined) fail(`two tabs in ${JSON.stringify(line.slice(0, 80))}`);
    if (!name || BAD.test(name)) fail(`the name ${JSON.stringify(name.slice(0, 80))} is blank or has whitespace or a control character`);
    if (bytes(name) > UPSTREAM_CAPS.nameBytes) fail(`the name ${JSON.stringify(name.slice(0, 80))} is over ${UPSTREAM_CAPS.nameBytes} bytes`);
    if (seen.has(name)) fail(`${JSON.stringify(name)} is listed twice`);
    seen.add(name);
    if (group !== undefined) {
      if (!group || /[\u0000-\u001f\u007f]/.test(group) || bytes(group) > UPSTREAM_CAPS.groupBytes) fail(`the group of ${JSON.stringify(name)} is blank, has a control character or is over ${UPSTREAM_CAPS.groupBytes} bytes`);
      groups.add(group);
    }
    rows.push(group === undefined ? { name } : { name, group });
  }
  if (rows.length > UPSTREAM_CAPS.names) fail(`${rows.length} names, over ${UPSTREAM_CAPS.names}`);
  if (groups.size > UPSTREAM_CAPS.groups) fail(`${groups.size} groups, over ${UPSTREAM_CAPS.groups}`);
  return rows;
}

/** A mode's file: `rows` less the names (and aliases) `index` has, each "absent" or "present" as `has` (the probe's
 * names) says; a name with a group is "name<tab>n", n its group's place in `groups`.  In the list's order. */
export function upstreamAsset(rows: UpstreamRow[], has: Set<string>, index: { name: string; aliases?: string[] }[]): UpstreamAsset {
  const indexed = new Set(index.flatMap((e) => [e.name, ...(e.aliases ?? [])]));
  const groups: string[] = [], absent: string[] = [], present: string[] = [];
  for (const r of rows) {
    if (indexed.has(r.name)) continue;
    let g = "";
    if (r.group !== undefined) {
      if (!groups.includes(r.group)) groups.push(r.group);
      g = "\t" + groups.indexOf(r.group);
    }
    (has.has(r.name) ? present : absent).push(r.name + g);
  }
  return { groups, absent, present };
}

/** An asset's bytes as the site serves them; throws when over the file cap. */
export function upstreamBytes(asset: UpstreamAsset, mode: string): Uint8Array {
  const raw = new TextEncoder().encode(JSON.stringify(asset) + "\n");
  if (raw.length > UPSTREAM_CAPS.fileBytes) throw new Error(`docs-upstream-${mode}.json: ${raw.length} bytes, over ${UPSTREAM_CAPS.fileBytes} (web/upstream-names.mts)`);
  return raw;
}

/** Throws when all the lists' files together are over the aggregate cap. */
export function checkUpstreamTotal(sizes: Record<string, number>): void {
  const total = Object.values(sizes).reduce((a, b) => a + b, 0);
  if (total > UPSTREAM_CAPS.allBytes) throw new Error(`docs-upstream-*.json: ${total} bytes in all, over ${UPSTREAM_CAPS.allBytes} (web/upstream-names.mts)`);
}
