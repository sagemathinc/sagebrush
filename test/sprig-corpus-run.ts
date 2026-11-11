// The Sprig corpus replay (design/sprig-mvp.md §7), shared by test/sprig-corpus-{1..4}.test.ts, mirroring Rill's
// (test/rill-corpus-run.ts; daybreak3's ruling: not a generalized runner).  Each partition runs the case files of
// sprig-tests/SCOPE.json whose name hashes to it, one CLI process per file, each case in a fresh Sprig session
// (lib/_sprig run_cases).  It compares the result's InputForm text and everything printed (Print's lines and the
// messages, in order) with the oracle's recording, byte for byte, after S0's one normalization (sprig-tests/checkers.py
// normalize(), the same process: its arrows and ==).  A case listed in sprig-tests/KNOWN.json must still give our
// recorded output (its sha256) and must still differ from the oracle's (§7.3, both ways), and its class's check
// (checkers.py: term-order, equivalent-form, oracle-host-limit; reference-inconsistency, below) must pass; a scoped
// case that is neither exact nor
// listed fails.  A fixed 5% of the cases (by id hash) also runs alone, in a process of its own, and must give the same
// outcome (§7.5's fresh-session equivalence).
// grader's conditions (S1 plan, Nov 9): whole files only, no held-out file, no file twice, every listed file present;
// a not-implemented entry names the PR or slice that implements it; the checks below have negative controls
// (test/sprig-corpus-controls.test.ts).
//   SPRIG_KNOWN_UPDATE=1 node --test dist/test/sprig-corpus-<n>.test.js   rewrites the sha256 of KNOWN entries in that
//   partition to our current output (§7.6: an explicit update, stated in the PR); it never adds or removes an entry.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const ROOT = join(__dirname, "..", "..");
export const TESTS = join(ROOT, "sprig-tests");
export const PARTITIONS = 4;
const CLI = join(__dirname, "..", "src", "cli.js");

export type Outcome = { result: string; output: string };
export type Known = { class: string; reason: string; sha256: string; up_to_constant?: string; expected?: string; witness?: string };
// (reference-inconsistency: the oracle answers one form of a question differently from
// an equivalent form of it, recorded in the same file as its `witness`; ours must be exactly the witness's recorded
// outcome, and the witness itself an exact case, not a known one)
export const CLASSES = ["term-order", "equivalent-form", "oracle-host-limit", "not-implemented", "reference-inconsistency"];

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
export const outcomeHash = (o: Outcome) => sha(JSON.stringify({ result: o.result, output: o.output }));
export const partitionOf = (file: string) => (parseInt(sha(file).slice(0, 8), 16) % PARTITIONS) + 1;
export const freshProcess = (id: string) => parseInt(sha(id).slice(0, 8), 16) % 20 === 0;

export function scope(): string[] {
  return JSON.parse(readFileSync(join(TESTS, "SCOPE.json"), "utf8")).files;
}

export function known(): Record<string, Known> {
  return JSON.parse(readFileSync(join(TESTS, "KNOWN.json"), "utf8")).cases;
}

/** A case file's cases: [id, source], split at its `(*-- <id> *)` lines (sprig-tests/run.py's rule). */
export function cases(file: string): [string, string][] {
  const out: [string, string][] = [];
  let cur: string | null = null, buf: string[] = [];
  for (const line of readFileSync(join(ROOT, file), "utf8").split("\n")) {
    const m = /^\(\*-- (\S+) \*\)$/.exec(line);
    if (m) {
      if (cur !== null) out.push([cur, buf.join("\n")]);
      cur = m[1];
      buf = [];
    } else if (cur !== null) buf.push(line);
  }
  if (cur !== null) out.push([cur, buf.join("\n")]);
  return out.map(([id, src]) => [id, src.replace(/\n+$/, "") + "\n"]);
}

// (the corpus process: our outcomes by run_cases, the oracle's normalized by checkers.py, and each KNOWN entry's class
// check, in one CLI process; SPRIG_LEAK=1 runs every case in one session instead, the planted fresh-session leak of
// the controls)
const PROCESS = `
import json, sys
sys.path.insert(0, ARGS["tests"])
import checkers, _sprig
from _sprig.eval import Session
cases = ARGS["cases"]
if ARGS.get("leak"):
    out = []
    sess = None
    def leaky(cs):
        global sess
        res = []
        for cid, src in cs:
            buf = []
            if sess is None:
                sess = Session(buf.append, buf.append)
            sess.write_out = sess.write_err = buf.append
            sess.messages = []
            last = [None]
            _sprig._statements(sess, src, "<string>", lambda v: last.__setitem__(0, v))
            res.append({"id": cid, "result": _sprig.input_form(last[0] if last[0] is not None else _sprig.NULL), "fullform": "", "output": "".join(buf), "messages": []})
        return res
    ours = leaky(cases)
else:
    ours = _sprig.run_cases(cases)
rec = {c["id"]: c for c in json.load(open(ARGS["recorded"]))["cases"]} if ARGS.get("recorded") else {}
prov = json.load(open(ARGS["provenance"]))
orderless = prov["oracle"]["record"]["orderless"]
res = []
for o in ours:
    w = rec.get(o["id"])
    item = {"id": o["id"], "ours": {"result": o["result"], "output": o["output"]}, "fullform": o["fullform"]}
    if w is not None:
        item["want"] = {"result": checkers.normalize(w["result"]), "output": checkers.normalize(w["output"])}
        k = ARGS["known"].get(o["id"])
        if k is not None:
            if k["class"] == "term-order":
                item["check"] = [bool(checkers.term_order(o["fullform"], w["fullform"], orderless)), "term-order"]
            elif k["class"] == "equivalent-form":
                ok, how = checkers.equivalent(o["fullform"], w["fullform"], k.get("up_to_constant"))
                item["check"] = [bool(ok), how]
            elif k["class"] == "oracle-host-limit":
                ok, how = checkers.host_limit(" ".join(w["messages"]), o["fullform"], k.get("expected"))
                item["check"] = [bool(ok), how]
            elif k["class"] == "reference-inconsistency":
                v = rec.get(k.get("witness")) if k.get("witness") != o["id"] else None
                ok = v is not None and o["result"] == checkers.normalize(v["result"]) and \
                    o["output"] == checkers.normalize(v["output"])
                item["check"] = [ok, "the witness's recorded outcome" if ok else "differs from its witness's recorded outcome"]
    res.append(item)
print(json.dumps(res))
`;

export type Row = { id: string; ours: Outcome; want?: Outcome; check?: [boolean, string] };

/** Every case of `file` (or the given cases), each in a fresh session (unless leak), in one CLI process. */
export function runFile(file: string, opts: { cases?: [string, string][]; known?: Record<string, Known>; leak?: boolean; recorded?: boolean } = {}): Record<string, Row> {
  const dir = mkdtempSync(join(tmpdir(), "sprig-corpus-"));
  try {
    const args = join(dir, "args.json");
    const k: Record<string, Known> = {};
    for (const [key, v] of Object.entries(opts.known ?? {})) if (key.startsWith(file + "#")) k[key.slice(file.length + 1)] = v;
    writeFileSync(args, JSON.stringify({
      tests: TESTS, cases: opts.cases ?? cases(file), known: k, leak: !!opts.leak, provenance: join(TESTS, "PROVENANCE.json"),
      recorded: opts.recorded === false ? null : join(ROOT, file.replace(/\.sprig$/, ".out.json")),
    }));
    const py = `import json\nARGS = json.load(open(${JSON.stringify(args)}))\n` + PROCESS;
    const r = spawnSync(process.execPath, [CLI, "-c", py], { encoding: "utf8", maxBuffer: 1 << 28, timeout: 600000 });
    assert.equal(r.status, 0, `${file}: the corpus process failed: ${(r.stderr || "").slice(0, 2000)}`);
    const out: Record<string, Row> = {};
    for (const x of JSON.parse(r.stdout)) out[x.id] = x;
    return out;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** One case alone, in a process of its own. */
export function runAlone(file: string, id: string, src: string): Outcome {
  const row = runFile(file, { cases: [[id, src]], recorded: false })[id];
  return row.ours;
}

/** The problems with a SCOPE list and KNOWN entries (grader's conditions); [] when they follow their rules. */
export function scopeProblems(files: string[], k: Record<string, Known>, exists = (f: string) => existsSync(join(ROOT, f)),
  caseIds = (f: string) => cases(f).map(([id]) => id)): string[] {
  const problems: string[] = [];
  if (new Set(files).size !== files.length) problems.push("SCOPE.json lists a file twice");
  for (const f of files) {
    if (f.startsWith("sprig-tests/heldout/")) problems.push(`SCOPE.json: ${f} is held out (scored at the slice's end, never in scope)`);
    else if (!/^sprig-tests\/[a-z0-9-]+\/test_\d+\.sprig$/.test(f)) problems.push(`SCOPE.json: ${f} is not a case file`);
    if (!exists(f)) problems.push(`SCOPE.json: ${f} doesn't exist`);
  }
  if (problems.length) return problems;
  const ids = new Set(files.flatMap((f) => caseIds(f).map((id) => `${f}#${id}`)));
  for (const [key, e] of Object.entries(k)) {
    if (!ids.has(key)) problems.push(`KNOWN.json: ${key} is not a case of a scoped file`);
    if (!CLASSES.includes(e.class)) problems.push(`KNOWN.json: ${key}: a class this runner can't check: ${e.class}`);
    if (!e.reason || e.reason.length > 200 || e.reason.includes("\n")) problems.push(`KNOWN.json: ${key}: a reason of one line`);
    if (!/^[0-9a-f]{64}$/.test(e.sha256 ?? "")) problems.push(`KNOWN.json: ${key}: sha256`);
    if (e.class === "not-implemented" && !/\bS\d(\.\d)?\b|\bL\d+\b/.test(e.reason)) problems.push(`KNOWN.json: ${key}: a not-implemented entry names the PR or slice that implements it`);
    if (e.class === "reference-inconsistency") {
      const w = `${key.split("#")[0]}#${e.witness ?? ""}`;
      if (!e.witness || w === key || !ids.has(w)) problems.push(`KNOWN.json: ${key}: a reference-inconsistency entry names its witness, another case of its file`);
      else if (k[w]) problems.push(`KNOWN.json: ${key}: its witness ${e.witness} is itself a known case`);
    }
  }
  return problems;
}

/** The census (the grader's condition 4, Nov 9): a recorded case keeping a non-ASCII character outside string literals
 * after the normalization must be a KNOWN case, so the oracle's next quirk is a named failure, not a mystery. */
export function censusProblems(entries: { file: string; id: string; chars: string[] }[], k: Record<string, Known>): string[] {
  return entries.filter((e) => !k[`${e.file}#${e.id}`]).map((e) => `${e.file}#${e.id}: the oracle's ${e.chars.join(" ")} outside a string, not in the normalization's table and not a KNOWN case`);
}

/** checkers.py's census of every recorded output (held-out files' included: their text reaches the score). */
export function census(): { file: string; id: string; chars: string[] }[] {
  const files: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name.endsWith(".out.json")) files.push(p);
    }
  };
  walk(TESTS);
  const r = spawnSync(process.execPath, [CLI, join(TESTS, "checkers.py"), "--census", ...files], { encoding: "utf8", maxBuffer: 1 << 26, timeout: 600000 });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

export function checkScopeAndKnown() {
  assert.deepEqual(scopeProblems(scope(), known()), []);
}

/** The problems of one file's rows against KNOWN (both ways); with update, KNOWN's sha256 follow our output. */
export function rowProblems(file: string, rows: Record<string, Row>, k: Record<string, Known>, update = false): { problems: string[]; changed: boolean } {
  const problems: string[] = [];
  let changed = false;
  for (const [id, row] of Object.entries(rows)) {
    const key = `${file}#${id}`;
    const g = row.ours, w = row.want;
    if (!w) {
      problems.push(`${key}: no recorded outcome`);
      continue;
    }
    const exact = g.result === w.result && g.output === w.output;
    const entry = k[key];
    if (entry) {
      if (exact) problems.push(`${key}: now exact; remove it from KNOWN.json`);
      else if (outcomeHash(g) !== entry.sha256) {
        if (update) {
          entry.sha256 = outcomeHash(g);
          changed = true;
        } else problems.push(`${key}: our output changed inside a known difference (SPRIG_KNOWN_UPDATE=1 to accept): ${JSON.stringify(g).slice(0, 300)}`);
      }
      if (entry.class !== "not-implemented" && !(row.check && row.check[0]))
        problems.push(`${key}: its ${entry.class} check fails (${row.check ? row.check[1] : "not run"})`);
    } else if (!exact) {
      problems.push(`${key}: differs from the oracle\n    got  ${JSON.stringify(g).slice(0, 400)}\n    want ${JSON.stringify(w).slice(0, 400)}`);
    }
  }
  return { problems, changed };
}

/** The fresh-session check: the chosen cases, each alone in a process of its own, give what the file's run gave. */
export function freshProblems(file: string, rows: Record<string, Row>, chosen: (key: string) => boolean = freshProcess,
  alone: (id: string, src: string) => Outcome = (id, src) => runAlone(file, id, src), list: [string, string][] = cases(file)): string[] {
  const problems: string[] = [];
  for (const [id, src] of list) {
    const key = `${file}#${id}`;
    if (!chosen(key) || !rows[id]) continue;
    const a = alone(id, src), g = rows[id].ours;
    if (a.result !== g.result || a.output !== g.output)
      problems.push(`${key}: a process of its own differs from a fresh session\n    alone   ${JSON.stringify(a).slice(0, 300)}\n    session ${JSON.stringify(g).slice(0, 300)}`);
  }
  return problems;
}

/** Partition n: every scoped file of it, exact or KNOWN both ways; returns the wall time in ms. */
export function checkPartition(n: number): number {
  const t0 = Date.now();
  const k = known();
  const update = process.env.SPRIG_KNOWN_UPDATE === "1";
  let changed = false;
  const problems: string[] = [];
  for (const file of scope().filter((f) => partitionOf(f) === n)) {
    const rows = runFile(file, { known: k });
    const r = rowProblems(file, rows, k, update);
    problems.push(...r.problems, ...freshProblems(file, rows));
    changed ||= r.changed;
  }
  if (changed) writeFileSync(join(TESTS, "KNOWN.json"), JSON.stringify({ format: 1, note: JSON.parse(readFileSync(join(TESTS, "KNOWN.json"), "utf8")).note, cases: Object.fromEntries(Object.entries(k).sort()) }, null, 1) + "\n");
  assert.deepEqual(problems, [], `${problems.length} problems`);
  return Date.now() - t0;
}
