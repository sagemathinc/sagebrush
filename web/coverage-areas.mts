// What each mode covers, by area: the line the function search shows above its results when a query names an area
// ("elliptic curves" in a Sage notebook), with its badge.  Every row is computed from what is public in the
// repository, never written by hand:
//   - each mode's area mapping, web/docs/coverage/<mode>.json, kept by the mode's owner: its areas, and for each the
//     catalog files or tags, our own suites and the public corpus sections it covers;
//   - the function catalog, catalog/<mode>/*.json: a `full` entry counts 1, a `partial` one 1/2, the others 0;
//   - the recorded oracle suites, rill-tests and sprig-tests: a case in a SCOPE file counts 1 unless KNOWN.json says
//     it's not implemented;
//   - summaries of public corpora, web/docs/coverage/corpora/<id>.json: numbers only, per section, with the date and
//     commit they were measured at; an example that runs and matches counts 1, and one whose output differs bars Works.
// Each catalog entry is in exactly one area of its mode, and every path a mapping names exists, or the build fails.
// The rows keep each catalog file's counts, so they roll up by package too.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** The modes with a mapping; `suite` for those measured by recorded oracle cases. */
export const AREA_MODES = [
  { mode: "sage" },
  { mode: "python" },
  { mode: "magma" },
  { mode: "matlab" },
  { mode: "rill", suite: "rill-tests", ext: ".R", mark: /^#-- \S/gm },
  { mode: "sprig", suite: "sprig-tests", ext: ".sprig", mark: /^\(\*-- \S.*\*\)$/gm },
] as const;

export type Area = { id: string; title: string; catalog?: { files?: string[]; tags?: string[] }; suites?: string[]; corpus?: { corpus: string; sections: string[] }[]; search?: string };
type Tally = { run: number; match: number; wrong: number };
export type Corpus = { id: string; mode: string; title: string; source: string; licence: string; oracle: string; commit: string; date: string; sections: Record<string, Tally> };
type Counts = { full: number; partial: number; other: number };
export type Row = {
  mode: string;
  area: Area;
  badge: "works" | "partly" | "not-yet" | "none";
  line: string;
  catalog: Counts & { n: number; byFile: Record<string, Counts> };
  cases: { n: number; pass: number };
  corpora: { corpus: Corpus; run: number; match: number; wrong: number }[];
};

const read = (p: string) => JSON.parse(readFileSync(p, "utf8"));

/** A mode's catalog entries, each with its file and tags (the top-level files only). */
function catalogEntries(root: string, mode: string): { key: string; file: string; tags: string[]; status: string }[] {
  const dir = join(root, "catalog", mode);
  if (!existsSync(dir)) return [];
  const out: { key: string; file: string; tags: string[]; status: string }[] = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".json")).sort())
    for (const e of read(join(dir, file)) as { name: string; signature?: string; status: string; tags?: string[] }[])
      out.push({ key: `${file}: ${e.name}${e.signature ? " " + e.signature : ""}`, file, tags: e.tags ?? [], status: e.status });
  return out;
}

/** The cases of a recorded oracle suite under `dir` (held-out files excluded), and how many of them pass. */
function oracleCases(root: string, m: (typeof AREA_MODES)[number], dir: string): { n: number; pass: number } {
  if (!("suite" in m)) return { n: 0, pass: 0 };
  const scope = new Set<string>(read(join(root, m.suite, "SCOPE.json")).files);
  const known = read(join(root, m.suite, "KNOWN.json")).cases as Record<string, { class: string }>;
  const notImplemented = new Map<string, number>();
  for (const [k, v] of Object.entries(known)) if (v.class === "not-implemented") { const f = k.split("#")[0]; notImplemented.set(f, (notImplemented.get(f) ?? 0) + 1); }
  let n = 0, pass = 0;
  const walk = (rel: string) => {
    for (const f of readdirSync(join(root, rel), { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const p = rel + "/" + f.name;
      if (f.isDirectory()) { if (f.name !== "heldout") walk(p); continue; }
      if (!f.name.endsWith(m.ext)) continue;
      const k = readFileSync(join(root, p), "utf8").match(m.mark)?.length ?? 0;
      n += k;
      if (scope.has(p)) pass += k - (notImplemented.get(p) ?? 0);
    }
  };
  walk(dir);
  return { n, pass };
}

/** What is wrong with a corpus summary's numbers: each section's run, match and wrong must be whole numbers, 0 or more,
 * with match + wrong at most run (a typo would otherwise publish impossible evidence, or a Works badge). */
export function corpusProblems(c: Corpus): string[] {
  const out: string[] = [];
  for (const [s, x] of Object.entries(c.sections ?? {})) {
    const ok = (v: unknown) => Number.isSafeInteger(v) && (v as number) >= 0;
    if (!ok(x?.run) || !ok(x?.match) || !ok(x?.wrong)) out.push(`section "${s}": run, match and wrong must be whole numbers, 0 or more`);
    else if (x.match + x.wrong > x.run) out.push(`section "${s}": match + wrong (${x.match + x.wrong}) is more than run (${x.run})`);
  }
  return out;
}

/** An area's corpus evidence: each corpus it names, with the tallies of the sections it names ("*": all of them).  A
 * corpus or section named twice in one area would count the same examples twice: refused, as is a corpus or section
 * that doesn't exist or another mode's corpus (into `fail`). */
export function areaCorpora(a: Area, mode: string, corpora: Map<string, Corpus>, fail: string[]): Row["corpora"] {
  const used: Row["corpora"] = [];
  const seen = new Set<string>();
  for (const ref of a.corpus ?? []) {
    const c = corpora.get(ref.corpus);
    if (!c) { fail.push(`${mode}/${a.id}: no corpus ${ref.corpus}`); continue; }
    if (c.mode !== mode) fail.push(`${mode}/${a.id}: corpus ${c.id} is ${c.mode}'s`);
    if (seen.has(c.id)) fail.push(`${mode}/${a.id}: corpus ${c.id} named twice`);
    const t = { run: 0, match: 0, wrong: 0 };
    if (ref.sections.includes("*") && ref.sections.length > 1) { fail.push(`${mode}/${a.id}: corpus ${c.id}: "*" (every section) must stand alone`); continue; }
    const sections = ref.sections[0] === "*" && ref.sections.length === 1 ? Object.keys(c.sections) : ref.sections;
    for (const s of sections) {
      const x = c.sections[s];
      if (!x) { fail.push(`${mode}/${a.id}: corpus ${c.id} has no section "${s}"`); continue; }
      if (seen.has(c.id + "/" + s)) { fail.push(`${mode}/${a.id}: corpus ${c.id}'s section "${s}" named twice`); continue; }
      seen.add(c.id + "/" + s);
      t.run += x.run; t.match += x.match; t.wrong += x.wrong;
    }
    seen.add(c.id);
    used.push({ corpus: c, ...t });
  }
  return used;
}

/** The rows of every mode (or of `modes`), from the mappings, the catalog, the oracle suites and the corpus summaries. */
export function coverageRows(root: string, modes: readonly (typeof AREA_MODES)[number][] = AREA_MODES): Row[] {
  const src = join(root, "web", "docs", "coverage");
  const fail: string[] = [];
  const corpora = new Map<string, Corpus>();
  for (const f of existsSync(join(src, "corpora")) ? readdirSync(join(src, "corpora")).filter((f) => f.endsWith(".json")).sort() : []) {
    const c = read(join(src, "corpora", f)) as Corpus;
    if (c.id + ".json" !== f) fail.push(`corpora/${f}: its id is ${c.id}`);
    if (!/^\d{4}-\d\d-\d\d$/.test(c.date) || !/^[0-9a-f]{7,40}$/.test(c.commit)) fail.push(`corpora/${f}: no date or commit it was measured at`);
    fail.push(...corpusProblems(c).map((p) => `corpora/${f}: ${p}`));
    corpora.set(c.id, c);
  }
  const rows: Row[] = [];
  for (const m of modes) {
    const file = join(src, m.mode + ".json");
    if (!existsSync(file)) { fail.push(`${m.mode}: no web/docs/coverage/${m.mode}.json`); continue; }
    const map = read(file) as { mode: string; areas: Area[] };
    if (map.mode !== m.mode) fail.push(`${m.mode}.json: its mode is ${map.mode}`);
    const entries = catalogEntries(root, m.mode);
    const owner = new Map<string, string[]>();
    const ids = new Set<string>();
    for (const a of map.areas) {
      if (!/^[a-z0-9-]+$/.test(a.id) || ids.has(a.id)) fail.push(`${m.mode}: area id "${a.id}" is malformed or used twice`);
      ids.add(a.id);
      const files = new Set(a.catalog?.files ?? []), tags = new Set(a.catalog?.tags ?? []);
      for (const f of files) if (!existsSync(join(root, "catalog", m.mode, f))) fail.push(`${m.mode}/${a.id}: no catalog/${m.mode}/${f}`);
      const mine = entries.filter((e) => files.has(e.file) || e.tags.some((t) => tags.has(t)));
      for (const e of mine) owner.set(e.key, [...(owner.get(e.key) ?? []), a.id]);
      for (const s of a.suites ?? []) if (!existsSync(join(root, s))) fail.push(`${m.mode}/${a.id}: no ${s}`);
      const cases = { n: 0, pass: 0 };
      for (const s of a.suites ?? []) if ("suite" in m && s.startsWith(m.suite + "/") && existsSync(join(root, s))) { const c = oracleCases(root, m, s); cases.n += c.n; cases.pass += c.pass; }
      const used = areaCorpora(a, m.mode, corpora, fail);
      const cat: Row["catalog"] = { n: mine.length, full: 0, partial: 0, other: 0, byFile: {} };
      for (const e of mine) {
        const k = e.status === "full" ? "full" : e.status === "partial" ? "partial" : "other";
        cat[k]++;
        (cat.byFile[e.file] ??= { full: 0, partial: 0, other: 0 })[k]++;
      }
      rows.push({ mode: m.mode, area: a, badge: "none", line: "", catalog: cat, cases, corpora: used });
    }
    for (const e of entries) {
      const o = owner.get(e.key);
      if (!o) fail.push(`${m.mode}: catalog entry "${e.key}" is in no area`);
      else if (o.length > 1) fail.push(`${m.mode}: catalog entry "${e.key}" is in ${o.join(" and ")}`);
    }
  }
  if (fail.length) throw new Error("coverage areas:\n  " + fail.join("\n  "));
  for (const r of rows) [r.badge, r.line] = judge(r);
  return rows;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "2026-11-12" as "Nov 12, 2026" */
const day = (d: string) => `${MONTHS[+d.slice(5, 7) - 1]} ${+d.slice(8, 10)}, ${d.slice(0, 4)}`;

/** A row's badge and its one line: over the measured items, Works at 90% with no corpus example differing, Not yet
 * under 20%, Partly between.  An area nothing measures (only our own tests, or nothing yet) has no badge.  A corpus's
 * numbers say when and at which commit they were measured: once, at the end, when every corpus in the line agrees. */
export function judge(r: Row): [Row["badge"], string] {
  const runs = r.corpora.reduce((s, c) => s + c.run, 0);
  const n = r.catalog.n + r.cases.n + runs;
  if (!n) return ["none", (r.area.suites ?? []).length ? "No measure yet: covered only by our own tests" : "No measure yet"];
  const parts: string[] = [];
  if (r.catalog.n) parts.push(`${r.catalog.full} of ${r.catalog.n} functions work fully` + (r.catalog.partial ? `, ${r.catalog.partial} partly` : ""));
  if (r.cases.n) parts.push(`${r.cases.pass} of ${r.cases.n} recorded test cases pass`);
  const used = r.corpora.filter((c) => c.run);
  const when = (c: (typeof used)[number]) => `measured ${day(c.corpus.date)} at commit ${c.corpus.commit.slice(0, 8)}`;
  const once = used.length > 0 && used.every((c) => when(c) === when(used[0]));
  for (const c of used) parts.push(`${c.match} of ${c.run} examples from ${c.corpus.title} give the expected output` + (c.wrong ? `, ${c.wrong} ${c.wrong === 1 ? "differs" : "differ"}` : "") + (once ? "" : ` (${when(c)})`));
  const score = (r.catalog.full + r.catalog.partial / 2 + r.cases.pass + r.corpora.reduce((s, c) => s + c.match, 0)) / n;
  const wrong = r.corpora.some((c) => c.wrong > 0);
  return [score >= 0.9 && !wrong ? "works" : score < 0.2 ? "not-yet" : "partly", parts.join("; ") + (once ? ` (${when(used[0])})` : "")];
}

/** A mode's rows as the function search reads them (in docs-upstream-<mode>.json): each area's id, title, badge and
 * line, and the words a query names it by (its title's and its id's). */
export function searchAreas(rows: Row[], mode: string): { id: string; title: string; badge: Row["badge"]; line: string }[] {
  return rows.filter((r) => r.mode === mode).map((r) => ({ id: r.area.id, title: r.area.title, badge: r.badge, line: r.line }));
}
