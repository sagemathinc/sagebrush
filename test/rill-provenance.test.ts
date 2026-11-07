import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

// Rill's corpus of recorded R outputs (design/rill.md §7.1, §7.4, §7.6): every
// case file has an output recorded by rill-tests/run.py --regen from the
// oracle, PROVENANCE.json records the oracle's environment (from inside the
// runs) and the sha256 of every case file and output, and a held-out
// directory's SHA256SUMS freezes it. Outputs come only from the oracle: a
// hand-edited output no longer matches its recorded hash. (The same checks as
// run.py --verify; the corpus replay itself is A1's.)
const root = join(__dirname, "..", "..");
const RECORD_KEYS = ["R.version.string", "platform", "locale", "timezone", "options", "namespaces"];
const OPTION_KEYS = ["width", "digits", "scipen", "OutDec"];

const sha256 = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");

function caseFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...caseFiles(p));
    else if (/^test_.*\.R$/.test(name)) out.push(p);
  }
  return out.sort();
}

function caseIds(p: string): string[] {
  return readFileSync(p, "utf8").split("\n").filter((l) => l.startsWith("#--")).map((l) => l.slice(3).trim());
}

/** The problems of the corpus under base (a repository root): [] when complete and consistent. */
export function checkCorpus(base: string): string[] {
  const dir = join(base, "rill-tests");
  const problems: string[] = [];
  const provPath = join(dir, "PROVENANCE.json");
  if (!existsSync(provPath)) return ["rill-tests/PROVENANCE.json is missing"];
  const prov = JSON.parse(readFileSync(provPath, "utf8"));
  const record = prov?.oracle?.record ?? {};
  for (const k of RECORD_KEYS) if (!(k in record)) problems.push(`the oracle's environment record lacks ${k}`);
  for (const k of OPTION_KEYS) if (!(k in (record.options ?? {}))) problems.push(`the oracle's options lack ${k}`);
  if (record.timezone !== undefined && record.timezone !== "UTC") problems.push(`the oracle ran in time zone ${record.timezone}, not the pinned UTC`);
  if (record.locale !== undefined && !/LC_CTYPE=C\.UTF-8/.test(record.locale)) problems.push("the oracle's locale is not the pinned C.UTF-8");
  const files = caseFiles(dir).map((p) => relative(base, p).split("\\").join("/"));
  const listed = Object.keys(prov.files ?? {});
  for (const f of [...new Set([...files, ...listed])].sort()) {
    const e = prov.files?.[f];
    const p = join(base, f), out = p.slice(0, -2) + ".out.json";
    if (!e) { problems.push(`${f}: not in PROVENANCE.json`); continue; }
    if (!files.includes(f)) { problems.push(`${f}: in PROVENANCE.json but missing`); continue; }
    if (!existsSync(out)) { problems.push(`${f}: no recorded output`); continue; }
    if (sha256(p) !== e.r_sha256) problems.push(`${f}: changed since it was recorded`);
    if (sha256(out) !== e.out_sha256) problems.push(`${f}: its output differs from the recorded hash`);
    const got = JSON.parse(readFileSync(out, "utf8")).cases.map((c: { id: string }) => c.id);
    if (JSON.stringify(got) !== JSON.stringify(caseIds(p))) problems.push(`${f}: case ids differ from its output's`);
    if (got.length !== e.cases) problems.push(`${f}: case count differs from PROVENANCE.json`);
  }
  const held = join(dir, "heldout");
  if (existsSync(held)) {
    for (const phase of readdirSync(held)) {
      const sums = join(held, phase, "SHA256SUMS");
      if (!existsSync(sums)) { problems.push(`heldout/${phase}: not frozen (no SHA256SUMS)`); continue; }
      const named = new Set<string>();
      for (const line of readFileSync(sums, "utf8").split("\n").filter((l) => l.trim())) {
        const [h, name] = line.split(/\s+/);
        named.add(name);
        const q = join(held, phase, name);
        if (!existsSync(q) || sha256(q) !== h) problems.push(`heldout/${phase}/${name}: does not match its frozen SHA256SUMS`);
      }
      for (const name of readdirSync(join(held, phase))) {
        if (/^test_.*\.(R|out\.json)$/.test(name) && !named.has(name)) problems.push(`heldout/${phase}/${name}: not in its SHA256SUMS`);
      }
    }
  }
  return problems;
}

test("the corpus of recorded R outputs is complete and its outputs come from the oracle", () => {
  assert.deepEqual(checkCorpus(root), []);
});

test("the corpus has at least the seed and the A1 held-out file, with the pinned environment", () => {
  const prov = JSON.parse(readFileSync(join(root, "rill-tests", "PROVENANCE.json"), "utf8"));
  assert.match(prov.oracle.record["R.version.string"], /^R version \d+\.\d+\.\d+/);
  assert.deepEqual(prov.oracle.record.options, { OutDec: ".", digits: 7, scipen: 0, width: 80 });
  assert.ok(Object.keys(prov.files).includes("rill-tests/heldout/a1/test_1.R"));
  const cases = Object.values(prov.files as Record<string, { cases: number }>).reduce((n, e) => n + e.cases, 0);
  assert.ok(cases >= 450, `${cases} cases`);
});

// (controls: each check fails when its rule is broken, on a copy of the corpus)
function copyCorpus(): string {
  const base = mkdtempSync(join(tmpdir(), "rill-prov-"));
  cpSync(join(root, "rill-tests"), join(base, "rill-tests"), { recursive: true });
  return base;
}
const edit = (p: string, f: (s: string) => string) => writeFileSync(p, f(readFileSync(p, "utf8")));
const has = (problems: string[], re: RegExp) => assert.ok(problems.some((x) => re.test(x)), problems.join("\n") || "no problems");

test("control: a hand-edited output is caught", () => {
  const b = copyCorpus();
  edit(join(b, "rill-tests", "arith", "test_1.out.json"), (s) => s.replace('"[1] 3\\n"', '"[1] 4\\n"'));
  has(checkCorpus(b), /arith\/test_1\.R: its output differs/);
});

test("control: a case file changed after recording is caught", () => {
  const b = copyCorpus();
  edit(join(b, "rill-tests", "vec", "test_1.R"), (s) => s + "1 + 1\n");
  has(checkCorpus(b), /vec\/test_1\.R: changed since it was recorded/);
});

test("control: an incomplete environment record is caught, key by key", () => {
  for (const k of RECORD_KEYS) {
    const b = copyCorpus();
    edit(join(b, "rill-tests", "PROVENANCE.json"), (s) => { const j = JSON.parse(s); delete j.oracle.record[k]; return JSON.stringify(j); });
    has(checkCorpus(b), new RegExp(`lacks ${k.replace(".", "\\.")}`));
  }
  for (const k of OPTION_KEYS) {
    const b = copyCorpus();
    edit(join(b, "rill-tests", "PROVENANCE.json"), (s) => { const j = JSON.parse(s); delete j.oracle.record.options[k]; return JSON.stringify(j); });
    has(checkCorpus(b), new RegExp(`options lack ${k}`));
  }
});

test("control: an unpinned time zone or locale is caught", () => {
  const b = copyCorpus();
  edit(join(b, "rill-tests", "PROVENANCE.json"), (s) => { const j = JSON.parse(s); j.oracle.record.timezone = "America/Los_Angeles"; j.oracle.record.locale = "LC_CTYPE=en_US.UTF-8"; return JSON.stringify(j); });
  const p = checkCorpus(b);
  has(p, /not the pinned UTC/);
  has(p, /not the pinned C\.UTF-8/);
});

test("control: a case file without a recorded output, or unlisted, is caught", () => {
  const b = copyCorpus();
  writeFileSync(join(b, "rill-tests", "na", "test_2.R"), "#-- new\n1\n");
  has(checkCorpus(b), /na\/test_2\.R: not in PROVENANCE\.json/);
});

test("control: an edited or unlisted held-out file is caught", () => {
  const b = copyCorpus();
  edit(join(b, "rill-tests", "heldout", "a1", "test_1.R"), (s) => s.replace("#-- clo-1", "#-- clo-1x"));
  has(checkCorpus(b), /heldout\/a1\/test_1\.R: does not match its frozen SHA256SUMS/);
  const c = copyCorpus();
  writeFileSync(join(c, "rill-tests", "heldout", "a1", "test_2.R"), "#-- late\n1\n");
  has(checkCorpus(c), /heldout\/a1\/test_2\.R: not in its SHA256SUMS/);
});
