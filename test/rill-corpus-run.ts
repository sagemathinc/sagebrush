// The Rill corpus replay (design/rill.md §7), shared by test/rill-corpus-{1..4}.test.ts: each partition runs the case
// files of rill-tests/SCOPE.json whose name hashes to it, one CLI process per file, each case in a fresh Rill session
// (lib/_rill run_cases), and compares stdout, the exit status and stderr with the recorded R output byte for byte (§7.2:
// the only normalization is dropping Rscript's final "Execution halted" line).  A case listed in rill-tests/KNOWN.json
// must still give our recorded output (its sha256) and must still differ from R's (§7.3, both ways); a scoped case
// that is neither exact nor listed fails.  A fixed 5% of the cases (by id hash) also runs one process per case through
// `--rill -c`, and must give the same result (§7.5's fresh-session equivalence).  grader's SCOPE conditions (Nov 7):
// whole files only, no held-out file, no file twice, every listed file present; KNOWN's not-implemented entries name
// the PR that implements them.
//   RILL_KNOWN_UPDATE=1 node --test dist/test/rill-corpus-<n>.test.js   rewrites the sha256 of KNOWN entries in that
//   partition to our current output (T6: an explicit update, stated in the PR); it never adds or removes an entry.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const ROOT = join(__dirname, "..", "..");
export const TESTS = join(ROOT, "rill-tests");
export const PARTITIONS = 4;
const CLI = join(__dirname, "..", "src", "cli.js");

export type Outcome = { stdout: string; stderr: string; status: number };
export type Known = { class: string; reason: string; sha256: string };
export const REASON_CLASSES = ["not-implemented", "layout-undocumented", "rng-stream", "lapack-rounding", "help-system"];

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
export const outcomeHash = (o: Outcome) => sha(JSON.stringify({ stdout: o.stdout, stderr: o.stderr, status: o.status }));
export const partitionOf = (file: string) => (parseInt(sha(file).slice(0, 8), 16) % PARTITIONS) + 1;
export const freshProcess = (id: string) => parseInt(sha(id).slice(0, 8), 16) % 20 === 0;

export function scope(): string[] {
  return JSON.parse(readFileSync(join(TESTS, "SCOPE.json"), "utf8")).files;
}

export function known(): Record<string, Known> {
  return JSON.parse(readFileSync(join(TESTS, "KNOWN.json"), "utf8")).cases;
}

/** A case file's cases: [id, source], split at its `#-- <id>` lines (rill-tests/run.py's rule). */
export function cases(file: string): [string, string][] {
  const out: [string, string][] = [];
  let cur: string | null = null, buf: string[] = [];
  for (const line of readFileSync(join(ROOT, file), "utf8").split("\n")) {
    const m = /^#-- (\S+)/.exec(line);
    if (m) {
      if (cur !== null) out.push([cur, buf.join("\n")]);
      cur = m[1];
      buf = [];
    } else buf.push(line);
  }
  if (cur !== null) out.push([cur, buf.join("\n")]);
  return out.map(([id, src]) => [id, src.replace(/\n+$/, "") + "\n"]);
}

/** R's recorded outcome of each case of `file`, normalized as §7.2 says. */
export function recorded(file: string): Record<string, Outcome> {
  const rec = JSON.parse(readFileSync(join(ROOT, file.replace(/\.R$/, ".out.json")), "utf8"));
  const out: Record<string, Outcome> = {};
  for (const r of rec.cases) out[r.id] = { stdout: r.stdout ?? "", stderr: (r.stderr ?? "").replace(/Execution halted\n$/, ""), status: r.status };
  return out;
}

/** Every case of `file`, each in a fresh session, in one CLI process. */
export function runFile(file: string): Record<string, Outcome> {
  const dir = mkdtempSync(join(tmpdir(), "rill-corpus-"));
  try {
    const input = join(dir, "cases.json");
    writeFileSync(input, JSON.stringify(cases(file)));
    const py = `import json, _rill\nprint(json.dumps(_rill.run_cases(json.load(open(${JSON.stringify(input)})))))\n`;
    const r = spawnSync(process.execPath, [CLI, "-c", py], { encoding: "utf8", maxBuffer: 1 << 28, timeout: 600000 });
    assert.equal(r.status, 0, `${file}: the corpus process failed: ${(r.stderr || "").slice(0, 2000)}`);
    const out: Record<string, Outcome> = {};
    for (const x of JSON.parse(r.stdout)) out[x.id] = { stdout: x.stdout, stderr: x.stderr, status: x.status };
    return out;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** One case through `--rill -c`, in a process of its own (the host's path, not run_cases). */
export function runAlone(src: string): Outcome {
  const r = spawnSync(process.execPath, [CLI, "--rill", "-c", src], { encoding: "utf8", maxBuffer: 1 << 28, timeout: 600000 });
  return { stdout: r.stdout, stderr: r.stderr, status: r.status ?? -1 };
}

/** The checks on SCOPE.json and KNOWN.json themselves (grader's conditions). */
export function checkScopeAndKnown() {
  const files = scope();
  assert.equal(new Set(files).size, files.length, "SCOPE.json lists a file twice");
  for (const f of files) {
    assert.match(f, /^rill-tests\/[a-z0-9-]+\/test_\d+\.R$/, `SCOPE.json: ${f} is not a case file`);
    assert.ok(!f.startsWith("rill-tests/heldout/"), `SCOPE.json: ${f} is held out (scored at the phase's end, never in scope)`);
    assert.ok(existsSync(join(ROOT, f)), `SCOPE.json: ${f} doesn't exist`);
  }
  const ids = new Set(files.flatMap((f) => cases(f).map(([id]) => `${f}#${id}`)));
  for (const [key, k] of Object.entries(known())) {
    assert.ok(ids.has(key), `KNOWN.json: ${key} is not a case of a scoped file`);
    assert.ok(REASON_CLASSES.includes(k.class), `KNOWN.json: ${key}: unknown class ${k.class}`);
    assert.ok(k.reason && k.reason.length <= 200, `KNOWN.json: ${key}: a reason of one line`);
    assert.match(k.sha256, /^[0-9a-f]{64}$/, `KNOWN.json: ${key}: sha256`);
    if (k.class === "not-implemented") assert.match(k.reason, /\bA\d\.\d[a-z]?\b|\bA[2-5]\b|\b[BCD]\b/, `KNOWN.json: ${key}: a not-implemented entry names the PR that implements it`);
  }
}

/** Partition n: every scoped file of it, exact or KNOWN both ways; returns the wall time in ms. */
export function checkPartition(n: number): number {
  const t0 = Date.now();
  const k = known();
  const update = process.env.RILL_KNOWN_UPDATE === "1";
  let changed = false;
  const problems: string[] = [];
  const files = scope().filter((f) => partitionOf(f) === n);
  for (const file of files) {
    const want = recorded(file);
    const got = runFile(file);
    for (const [id, src] of cases(file)) {
      const key = `${file}#${id}`;
      const g = got[id], w = want[id];
      if (!g) {
        problems.push(`${key}: no result`);
        continue;
      }
      const exact = g.stdout === w.stdout && g.stderr === w.stderr && g.status === w.status;
      const entry = k[key];
      if (entry) {
        if (exact) problems.push(`${key}: now exact; remove it from KNOWN.json`);
        else if (outcomeHash(g) !== entry.sha256) {
          if (update) {
            entry.sha256 = outcomeHash(g);
            changed = true;
          } else problems.push(`${key}: our output changed inside a known difference (RILL_KNOWN_UPDATE=1 to accept): ${JSON.stringify(g).slice(0, 300)}`);
        }
      } else if (!exact) {
        problems.push(`${key}: differs from R\n    got  ${JSON.stringify(g).slice(0, 400)}\n    want ${JSON.stringify(w).slice(0, 400)}`);
      }
      if (freshProcess(key)) {
        const alone = runAlone(src);
        if (alone.stdout !== g.stdout || alone.stderr !== g.stderr || alone.status !== g.status)
          problems.push(`${key}: a process of its own differs from a fresh session\n    alone   ${JSON.stringify(alone).slice(0, 300)}\n    session ${JSON.stringify(g).slice(0, 300)}`);
      }
    }
  }
  if (changed) writeFileSync(join(TESTS, "KNOWN.json"), JSON.stringify({ format: 1, cases: Object.fromEntries(Object.entries(k).sort()) }, null, 1) + "\n");
  assert.deepEqual(problems, [], `${problems.length} problems`);
  return Date.now() - t0;
}
