import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

// Sprig's corpus of recorded Mathics3 outputs (design/sprig-mvp.md §7.1, §7.4): every case file has an output
// recorded by sprig-tests/run.py --regen from the oracle, PROVENANCE.json records the oracle's environment (as the
// oracle printed it) and the sha256 of every case file and output, and a held-out directory's SHA256SUMS freezes it.
// Outputs come only from the oracle: a hand-edited output no longer matches its recorded hash. (The same checks as
// run.py --verify; the corpus replay itself is S1's.)
const root = join(__dirname, "..", "..");
const RECORD_KEYS = ["version", "versions", "orderless", "limits", "argv"];
/** The oracle's exact arguments after its path (oracle.py's ARGS), and the recorder's own files, whose hashes
 * PROVENANCE.json records: a changed driver or recorder means the corpus must be re-recorded. */
const ORACLE_ARGV = ["<program>", "-q", "--no-readline", "--colors", "NoColor"];
const TOOLS: [string, string][] = [["oracle.py", "oracle_py_sha256"], ["run.py", "run_py_sha256"]];
/** The oracle's facts the design rests on (§5.2, §7.3): its version, its Orderless heads and its limits. */
const PINNED = {
  version: /^Mathics3 10\.0\.1$/,
  orderless: "{Plus, Times, Max, Min, GCD, LCM, Xor}",
  limits: "{200, 4096, {MaxIterations \u29f4 65535}}",
};
/** The corpus's floor: S0's visible cases plus S1's held-out file. */
const MIN_CASES = 229;

const sha256 = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");

function caseFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...caseFiles(p));
    else if (/^test_.*\.sprig$/.test(name)) out.push(p);
  }
  return out.sort();
}

function caseIds(p: string): string[] {
  return readFileSync(p, "utf8").split("\n").map((l) => /^\(\*-- (\S+) \*\)\s*$/.exec(l)).filter((m) => m).map((m) => m![1]);
}

/** The problems of the corpus under base (a repository root): [] when complete and consistent. */
export function checkCorpus(base: string): string[] {
  const dir = join(base, "sprig-tests");
  const problems: string[] = [];
  const provPath = join(dir, "PROVENANCE.json");
  if (!existsSync(provPath)) return ["sprig-tests/PROVENANCE.json is missing"];
  const prov = JSON.parse(readFileSync(provPath, "utf8"));
  const record = prov?.oracle?.record ?? {};
  for (const k of RECORD_KEYS) if (!record[k]) problems.push(`the oracle's environment record lacks ${k}`);
  if (record.version !== undefined && !PINNED.version.test(record.version)) problems.push(`the oracle is ${record.version}, not the pinned Mathics3 10.0.1`);
  if (record.orderless !== undefined && record.orderless !== PINNED.orderless) problems.push(`the oracle's Orderless heads are ${record.orderless}, not the pinned ${PINNED.orderless}`);
  if (record.limits !== undefined && record.limits !== PINNED.limits) problems.push(`the oracle's limits are ${record.limits}, not the pinned ${PINNED.limits}`);
  if (record.argv !== undefined && JSON.stringify(record.argv) !== JSON.stringify(ORACLE_ARGV)) problems.push(`the oracle ran with arguments ${JSON.stringify(record.argv)}, not ${JSON.stringify(ORACLE_ARGV)}`);
  if (!prov?.oracle?.path) problems.push("the oracle's program path is not recorded");
  for (const [name, key] of TOOLS) {
    if (prov?.oracle?.[key] !== sha256(join(dir, name))) problems.push(`sprig-tests/${name} differs from the one that recorded the corpus`);
  }
  const total = Object.values((prov.files ?? {}) as Record<string, { cases: number }>).reduce((n, e) => n + (e.cases ?? 0), 0);
  if (total < MIN_CASES) problems.push(`the corpus has ${total} cases, fewer than its floor of ${MIN_CASES}`);
  const files = caseFiles(dir).map((p) => relative(base, p).split("\\").join("/"));
  const listed = Object.keys(prov.files ?? {});
  for (const f of [...new Set([...files, ...listed])].sort()) {
    const e = prov.files?.[f];
    const p = join(base, f), out = p.slice(0, -".sprig".length) + ".out.json";
    if (!e) { problems.push(`${f}: not in PROVENANCE.json`); continue; }
    if (!files.includes(f)) { problems.push(`${f}: in PROVENANCE.json but missing`); continue; }
    if (!existsSync(out)) { problems.push(`${f}: no recorded output`); continue; }
    if (sha256(p) !== e.sprig_sha256) problems.push(`${f}: changed since it was recorded`);
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
        if (/^test_.*\.(sprig|out\.json)$/.test(name) && !named.has(name)) problems.push(`heldout/${phase}/${name}: not in its SHA256SUMS`);
      }
    }
  }
  return problems;
}

test("the corpus of recorded Mathics3 outputs is complete and its outputs come from the oracle", () => {
  assert.deepEqual(checkCorpus(root), []);
});

test("the corpus includes S1's held-out file, frozen", () => {
  const prov = JSON.parse(readFileSync(join(root, "sprig-tests", "PROVENANCE.json"), "utf8"));
  assert.ok(Object.keys(prov.files).includes("sprig-tests/heldout/s1/test_1.sprig"));
  assert.ok(existsSync(join(root, "sprig-tests", "heldout", "s1", "SHA256SUMS")));
});

// (controls: each check fails when its rule is broken, on a copy of the corpus)
function copyCorpus(): string {
  const base = mkdtempSync(join(tmpdir(), "sprig-prov-"));
  cpSync(join(root, "sprig-tests"), join(base, "sprig-tests"), { recursive: true });
  return base;
}
const edit = (p: string, f: (s: string) => string) => writeFileSync(p, f(readFileSync(p, "utf8")));
const has = (problems: string[], re: RegExp) => assert.ok(problems.some((x) => re.test(x)), problems.join("\n") || "no problems");
const provEdit = (b: string, f: (j: any) => void) =>
  edit(join(b, "sprig-tests", "PROVENANCE.json"), (s) => { const j = JSON.parse(s); f(j); return JSON.stringify(j); });

test("control: a hand-edited output is caught", () => {
  const b = copyCorpus();
  edit(join(b, "sprig-tests", "arith", "test_1.out.json"), (s) => s.replace('"result": "1/2"', '"result": "1/3"'));
  has(checkCorpus(b), /arith\/test_1\.sprig: its output differs/);
});

test("control: a case file changed after recording is caught", () => {
  const b = copyCorpus();
  edit(join(b, "sprig-tests", "list", "test_1.sprig"), (s) => s + "1 + 1\n");
  has(checkCorpus(b), /list\/test_1\.sprig: changed since it was recorded/);
});

test("control: an incomplete environment record is caught, key by key", () => {
  for (const k of RECORD_KEYS) {
    const b = copyCorpus();
    provEdit(b, (j) => { delete j.oracle.record[k]; });
    has(checkCorpus(b), new RegExp(`lacks ${k}`));
  }
});

test("control: another oracle version, Orderless set or limits are caught", () => {
  const b = copyCorpus();
  provEdit(b, (j) => { j.oracle.record.version = "Mathics3 9.0.0"; j.oracle.record.orderless = "{Plus, Times}"; j.oracle.record.limits = "{1024, 4096, {}}"; });
  const p = checkCorpus(b);
  has(p, /not the pinned Mathics3 10\.0\.1/);
  has(p, /Orderless heads are .*not the pinned/);
  has(p, /limits are .*not the pinned/);
});

test("control: a case file without a recorded output, or unlisted, is caught", () => {
  const b = copyCorpus();
  writeFileSync(join(b, "sprig-tests", "misc", "test_2.sprig"), "(*-- new *)\n1\n");
  has(checkCorpus(b), /misc\/test_2\.sprig: not in PROVENANCE\.json/);
});

test("control: an edited or unlisted held-out file is caught", () => {
  const b = copyCorpus();
  edit(join(b, "sprig-tests", "heldout", "s1", "test_1.sprig"), (s) => s.replace("(*-- s1-1 *)", "(*-- s1-1x *)"));
  has(checkCorpus(b), /heldout\/s1\/test_1\.sprig: does not match its frozen SHA256SUMS/);
  const c = copyCorpus();
  writeFileSync(join(c, "sprig-tests", "heldout", "s1", "test_2.sprig"), "(*-- late *)\n1\n");
  has(checkCorpus(c), /heldout\/s1\/test_2\.sprig: not in its SHA256SUMS/);
});

test("control: case ids that differ from the output's are caught", () => {
  const b = copyCorpus();
  edit(join(b, "sprig-tests", "numth", "test_1.out.json"), (s) => s.replace('"id": "numth-1"', '"id": "numth-x"'));
  has(checkCorpus(b), /numth\/test_1\.sprig: case ids differ from its output's/);
});

test("control: a case count that differs from PROVENANCE.json is caught", () => {
  const b = copyCorpus();
  provEdit(b, (j) => { j.files["sprig-tests/calc/test_1.sprig"].cases += 1; });
  has(checkCorpus(b), /calc\/test_1\.sprig: case count differs from PROVENANCE\.json/);
});

test("control: a listed case file that is missing is caught", () => {
  const b = copyCorpus();
  for (const f of ["test_1.sprig", "test_1.out.json"]) rmSync(join(b, "sprig-tests", "solve", f));
  has(checkCorpus(b), /solve\/test_1\.sprig: in PROVENANCE\.json but missing/);
});

test("control: a listed case file without its recorded output is caught", () => {
  const b = copyCorpus();
  rmSync(join(b, "sprig-tests", "linalg", "test_1.out.json"));
  has(checkCorpus(b), /linalg\/test_1\.sprig: no recorded output/);
});

test("control: a held-out phase without SHA256SUMS is caught", () => {
  const b = copyCorpus();
  mkdirSync(join(b, "sprig-tests", "heldout", "s2"));
  writeFileSync(join(b, "sprig-tests", "heldout", "s2", "test_1.sprig"), "(*-- h *)\n1\n");
  has(checkCorpus(b), /heldout\/s2: not frozen \(no SHA256SUMS\)/);
});

test("control: a corpus below its floor is caught", () => {
  const b = copyCorpus();
  const gone: string[] = [];
  for (const area of readdirSync(join(b, "sprig-tests"))) {
    const dir = join(b, "sprig-tests", area);
    if (area === "arith" || area === "heldout" || !statSync(dir).isDirectory()) continue;
    for (const f of readdirSync(dir)) if (/^test_\d+\.(sprig|out\.json)$/.test(f)) {
      rmSync(join(dir, f));
      if (f.endsWith(".sprig")) gone.push(`sprig-tests/${area}/${f}`);
    }
  }
  provEdit(b, (j) => { for (const f of gone) delete j.files[f]; });
  has(checkCorpus(b), /fewer than its floor of 229/);
});

test("control: a changed oracle driver or recorder is caught, each by its own hash", () => {
  for (const [name] of TOOLS) {
    const b = copyCorpus();
    edit(join(b, "sprig-tests", name), (s) => s + "\n# changed\n");
    has(checkCorpus(b), new RegExp(`sprig-tests/${name.replace(".", "\\.")} differs from the one that recorded the corpus`));
  }
});

test("control: other oracle arguments, or no recorded program path, are caught", () => {
  const b = copyCorpus();
  provEdit(b, (j) => { j.oracle.record.argv = ["<program>", "-q"]; delete j.oracle.path; });
  const p = checkCorpus(b);
  has(p, /the oracle ran with arguments/);
  has(p, /program path is not recorded/);
});
