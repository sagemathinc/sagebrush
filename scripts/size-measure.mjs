#!/usr/bin/env node
// Stateless per-change size comparison. Measurements normalize only checkout
// paths and known VERSION/BUILD_ID assignments. Base and merge are measured
// with the same pinned toolchain and this file, whose hash binds both records.
// See design/size-gate.md. No stored budgets, markers, ledgers or epochs.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SELF = fileURLToPath(import.meta.url);
const root = join(dirname(SELF), "..");
export const REPO = "sagemathinc/sagebrush";
export const RECORD_FORMAT = "sagebrush-size-record";

// ---------------------------------------------------------------------------
// Strict JSON: duplicate keys refused, and numbers only as integer literals
// (no "1.0", "1e3", "1.5"); measurements contain integer byte counts.

export const MAX_DEPTH = 16;
// Bound input bytes, nesting, strings and collections before using records.
export const LIMITS = {
  record_bytes: 256 * 1024,
  string_chars: 1024,
  entries: 1024,
};
// why `bytes` of `what` can't be admitted under `cap`, or null
export const overCap = (what, bytes, cap) => (Number.isSafeInteger(bytes) && bytes >= 0 && bytes <= cap ? null : `${what}: ${bytes} bytes, over the cap of ${cap} (size-measure.mjs LIMITS): refused before parsing`);
const longString = (s) => typeof s === "string" && s.length > LIMITS.string_chars;
export function strictParse(text) {
  let i = 0, depth = 0;
  const fail = (what) => {
    throw new Error(`${what} at offset ${i}`);
  };
  const ws = () => {
    while (i < text.length && " \t\n\r".includes(text[i])) i++;
  };
  const value = () => {
    ws();
    const c = text[i];
    if (c === "{" || c === "[") if (++depth > MAX_DEPTH) fail(`nesting deeper than ${MAX_DEPTH}`);
    if (c === "{") {
      i++;
      const out = Object.create(null);
      ws();
      if (text[i] === "}") return depth--, i++, out;
      for (;;) {
        ws();
        if (text[i] !== '"') fail("expected a string key");
        const k = string();
        if (Object.hasOwn(out, k)) fail(`duplicate key ${JSON.stringify(k)}`);
        ws();
        if (text[i++] !== ":") fail("expected ':'");
        // (an own data property, whatever the name: "__proto__" is kept, never the prototype)
        Object.defineProperty(out, k, { value: value(), enumerable: true, writable: true, configurable: true });
        ws();
        if (text[i] === ",") i++;
        else if (text[i] === "}") return depth--, i++, out;
        else fail("expected ',' or '}'");
      }
    }
    if (c === "[") {
      i++;
      const out = [];
      ws();
      if (text[i] === "]") return depth--, i++, out;
      for (;;) {
        out.push(value());
        ws();
        if (text[i] === ",") i++;
        else if (text[i] === "]") return depth--, i++, out;
        else fail("expected ',' or ']'");
      }
    }
    if (c === '"') return string();
    for (const [lit, v] of [["true", true], ["false", false], ["null", null]]) if (text.startsWith(lit, i)) return (i += lit.length), v;
    const m = /^-?[0-9][0-9eE.+-]*/.exec(text.slice(i));
    if (!m) fail("unexpected character");
    if (!/^-?(0|[1-9][0-9]*)$/.test(m[0])) fail(`${m[0]} is not an integer literal`);
    i += m[0].length;
    return Number(m[0]);
  };
  const string = () => {
    const m = /^"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"/.exec(text.slice(i));
    if (!m) fail("bad string");
    i += m[0].length;
    return JSON.parse(m[0]);
  };
  const v = value();
  ws();
  if (i !== text.length) fail("trailing text");
  return v;
}

// RFC 8785 (JCS) for the values these files hold: objects with keys sorted by
// UTF-16 code units, arrays, strings, safe integers, booleans and null.
export function jcs(v) {
  if (v === null || typeof v === "boolean" || typeof v === "string") return JSON.stringify(v);
  if (typeof v === "number") {
    if (!Number.isSafeInteger(v)) throw new Error(`jcs: ${v} is not a safe integer`);
    return String(v);
  }
  if (Array.isArray(v)) return "[" + v.map(jcs).join(",") + "]";
  const keys = Object.keys(v).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + jcs(v[k])).join(",") + "}";
}
export const sha256 = (data) => createHash("sha256").update(data).digest("hex");

const isNat = (n) => Number.isSafeInteger(n) && n >= 0;
// ---------------------------------------------------------------------------
// Measurement

// The two generated values neutralized, and nothing else: each found only as
// its assignment, with the known value.  Each occurrence counts as
// NEUTRAL_WIDTH bytes, whatever the value's width.
export const NEUTRAL_WIDTH = 16;
export const ASSIGNMENTS = ["VERSION", "BUILD_ID"];
// How many of each assignment each bundle has: reviewed constants, never read
// from the build being measured (--census prints a build's, for review).  A bundle not listed has none.  A count that
// differs fails the measurement, so a new occurrence can't hide.  (Changing
// one changes this file's measurement hash.)
export const EXPECTED_COUNTS = {
  // build-cli.mjs writes both into lib.gen.js; the CLI bundle imports it
  "cli/lib.gen.js": { VERSION: 1, BUILD_ID: 1 },
  "cli/pyjs.cjs": { VERSION: 1, BUILD_ID: 1 },
  // web/worker.ts imports lib-meta.gen.js, which has both
  "engine/sagebrush-worker.js": { VERSION: 1, BUILD_ID: 1 },
};

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// the assignments of `name` with the value `value` in `text`: source form
// (globalThis.__SAGEBRUSH_VERSION__ = "0.6.0";) or minified, any quote
export function countAssignments(text, name, value) {
  const re = new RegExp(`globalThis\\.__SAGEBRUSH_${name}__\\s*=\\s*(["'\`])${escapeRe(value)}\\1`, "g");
  return [...text.matchAll(re)].length;
}

function pathFree(bytes, rootDir) {
  const needle = Buffer.from(rootDir);
  let n = 0;
  for (let i = bytes.indexOf(needle); i >= 0; i = bytes.indexOf(needle, i + needle.length)) n++;
  return bytes.length - n * needle.length;
}

// The values a build was stamped with: its version, and its own build-id.mjs's id
export async function stampedValues(rootDir) {
  const version = JSON.parse(readFileSync(join(rootDir, "packages", "sagebrush", "package.json"), "utf8")).version;
  const { buildId, libFiles } = await import(pathToFileURL(join(rootDir, "scripts", "build-id.mjs")).href);
  return { VERSION: version, BUILD_ID: buildId(rootDir, libFiles(rootDir)) };
}

// {bundles, sizes, neutral, counts, problems} for the built tree at rootDir.
// `files` maps a bundle to the files it sums; a file's size is without the
// checkout path, and with each neutralized assignment at NEUTRAL_WIDTH.
export function measureFiles(files, rootDir, values, extra = {}, expected = EXPECTED_COUNTS) {
  const sizes = {}, neutral = {}, counts = {}, problems = [];
  for (const [key, list] of Object.entries(files)) {
    let size = 0, adj = 0;
    const c = Object.fromEntries(ASSIGNMENTS.map((a) => [a, 0]));
    for (const f of list) {
      if (typeof f === "number") {
        size += f;
        continue;
      }
      const bytes = readFileSync(f);
      size += pathFree(bytes, rootDir);
      const text = bytes.toString("latin1");
      for (const a of ASSIGNMENTS) {
        const n = countAssignments(text, a, values[a]);
        c[a] += n;
        adj += n * (NEUTRAL_WIDTH - Buffer.byteLength(values[a]));
      }
    }
    sizes[key] = size + adj;
    neutral[key] = adj;
    counts[key] = c;
    for (const a of ASSIGNMENTS) {
      const want = expected[key]?.[a] ?? 0;
      if (c[a] !== want) problems.push(`${key}: ${c[a]} ${a} assignment(s), ${want} expected (size-measure.mjs EXPECTED_COUNTS)`);
    }
  }
  for (const k of Object.keys(expected)) if (!Object.hasOwn(files, k)) problems.push(`${k}: expected in the build, but it isn't there`);
  Object.assign(sizes, extra);
  for (const k of Object.keys(extra)) neutral[k] = 0;
  const bundles = Object.keys(sizes).sort();
  return { bundles, sizes: Object.fromEntries(bundles.map((k) => [k, sizes[k]])), neutral: Object.fromEntries(bundles.map((k) => [k, neutral[k]])), counts, problems };
}

// The bundles of a build, as size-budget.mjs's measure() names them: the
// engine's files by group (the hash in the name dropped; the zone data as one),
// the CLI bundle and its generated library and packages, and the registry's
// package count.
// The examples gallery's bundles (plan-examples-gallery §5, daybreak2's ruling): the corpus (every file under
// examples/), what the site serves of it (every file web/build.ts writes under web/site/public/examples: the pages, the
// LaTeX previews, files.json, the ZIPs, the catalog) and the catalog on its own. Read after the build, never built
// here. An absent tree has no bundle; added bundles use a zero base.
export function examplesFiles(rootDir) {
  const walk = (dir) => readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
  const files = {};
  const site = join(rootDir, "web", "site", "public", "examples");
  if (existsSync(join(rootDir, "examples"))) files["examples/corpus"] = walk(join(rootDir, "examples"));
  if (existsSync(join(site, "index.json"))) {
    files["site/examples"] = walk(site);
    files["examples/index.json"] = [join(site, "index.json")];
  }
  return files;
}

export function buildFiles(rootDir) {
  const files = {};
  const dist = join(rootDir, "web", "dist");
  const latest = JSON.parse(readFileSync(join(dist, "engine", "latest.json"), "utf8"));
  const engine = join(dist, "engine", latest.id);
  const manifest = JSON.parse(readFileSync(join(engine, "manifest.json"), "utf8"));
  for (const [name, f] of Object.entries(manifest.files)) {
    const m = /^lib\/(.+)\.(src|pre)\.[0-9a-f]{16}\.json$/.exec(name);
    const key = m ? `engine/lib/${m[1]}.${m[2]}` : name.startsWith("lib/tzdata/") ? "engine/lib/tzdata" : `engine/${name}`;
    const file = join(engine, name);
    (files[key] ??= []).push(existsSync(file) ? file : f.size);
  }
  for (const f of ["pyjs.cjs", "lib.gen.js", "packages.gen.js"]) files[`cli/${f}`] = [join(rootDir, "build", "cli", f)];
  Object.assign(files, examplesFiles(rootDir));
  const reg = JSON.parse(readFileSync(join(rootDir, "packages", "registry.json"), "utf8"));
  return { files, extra: { "registry/packages": Object.keys(reg.packages).length } };
}

export async function measure(rootDir) {
  const { files, extra } = buildFiles(rootDir);
  return measureFiles(files, rootDir, await stampedValues(rootDir), extra);
}

// ---------------------------------------------------------------------------
// Records

function observed(cmd) {
  const r = spawnSync(cmd, ["--version"], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim().replace(/^v/, "") : null;
}
export function currentKey() {
  return { bun: observed("bun"), node: process.version.replace(/^v/, ""), measure_sha256: sha256(readFileSync(SELF)) };
}
const sameKey = (a, b) => !!a && !!b && a.bun === b.bun && a.node === b.node && a.measure_sha256 === b.measure_sha256;
export { sameKey };

export function makeRecord({ commit, tree, event, run, key, m }) {
  return { format: RECORD_FORMAT, v: 1, repo: REPO, commit, tree, event, run, key, bundles: m.bundles, sizes: m.sizes, neutral: m.neutral };
}

// Why a record can't be used for `commit`, or [] (an error, never a zero baseline)
export function recordProblems(rec, commit) {
  const p = [];
  if (!rec || typeof rec !== "object") return ["not a record"];
  if (rec.format !== RECORD_FORMAT || rec.v !== 1) p.push(`format ${rec.format} v${rec.v}, not ${RECORD_FORMAT} v1`);
  if (rec.repo !== REPO) p.push(`repo ${rec.repo}, not ${REPO}`);
  if (commit !== undefined && rec.commit !== commit) p.push(`commit ${rec.commit}, not ${commit}`);
  if (!rec.key || typeof rec.key.measure_sha256 !== "string" || typeof rec.key.bun !== "string" || typeof rec.key.node !== "string") p.push("no comparability key");
  if (!Array.isArray(rec.bundles) || !rec.sizes || typeof rec.sizes !== "object" || Array.isArray(rec.sizes)) return [...p, "no bundles or sizes"];
  if (rec.bundles.length > LIMITS.entries || rec.bundles.some((s) => typeof s !== "string" || !s || longString(s))) return [...p, `more than ${LIMITS.entries} bundles, or a name over ${LIMITS.string_chars} characters`];
  const listed = [...rec.bundles].sort(), keys = Object.keys(rec.sizes).sort();
  if (new Set(listed).size !== listed.length) p.push("a bundle is listed twice");
  if (jcs(listed) !== jcs(keys)) p.push("sizes don't have exactly the listed bundles");
  for (const [k, v] of Object.entries(rec.sizes)) if (!isNat(v)) p.push(`${k}: ${v} is not a non-negative safe integer`);
  if (rec.neutral !== undefined) for (const [k, v] of Object.entries(rec.neutral)) if (!Number.isSafeInteger(v)) p.push(`${k}: neutral ${v} is not a safe integer`);
  return p;
}

// ---------------------------------------------------------------------------
// Stateless per-change backstop. The larger allowance avoids percentage noise
// on small files and scales with large bundles; exact boundaries pass.
export const TOOLCHAIN = { bun: "1.4.4", node: "24.21.0" };
export const ABSOLUTE_ALLOWANCE = 50_000; // decimal KB, not KiB
export const growthLimit = (base) => Math.max(Math.floor(base / 50), ABSOLUTE_ALLOWANCE);
const fmt = (n) => n > 0 ? "+" + n : String(n);

export function evaluate({ mode = "transition", merge, base }) {
  const problems = recordProblems(merge?.record);
  const notes = [], rows = [];
  const M = merge?.record, N = base?.record;
  if (mode !== "absolute") problems.push(...recordProblems(N, base?.commit).map((p) => "base: " + p));
  if (problems.length) return { ok: false, problems, notes, rows };
  if (M.key.bun !== TOOLCHAIN.bun || M.key.node !== TOOLCHAIN.node)
    problems.push("measurement must use pinned bun " + TOOLCHAIN.bun + " and node " + TOOLCHAIN.node);
  if (mode !== "absolute" && !sameKey(M.key, N.key)) problems.push("base and merge measurement keys differ: rebuild both with this run's recipe and pins");
  if (problems.length) return { ok: false, problems, notes, rows };
  if (mode === "absolute") {
    for (const bundle of M.bundles) rows.push({ bundle, merge: M.sizes[bundle] });
    notes.push("No base for this event: sizes reported without a growth comparison.");
  } else {
    const names = [...new Set([...N.bundles, ...M.bundles])].sort();
    for (const bundle of names) {
      const before = Object.hasOwn(N.sizes, bundle) ? N.sizes[bundle] : 0;
      const after = Object.hasOwn(M.sizes, bundle) ? M.sizes[bundle] : 0;
      const delta = after - before, limit = growthLimit(before);
      const note = !Object.hasOwn(N.sizes, bundle) ? "added" : !Object.hasOwn(M.sizes, bundle) ? "removed" : "";
      rows.push({ bundle, base: before, merge: after, delta, limit, note });
      if (delta > limit) problems.push(bundle + ": growth " + fmt(delta) + " exceeds " + limit + " bytes (both 2% and 50,000 B)");
    }
  }
  return { ok: problems.length === 0, problems, notes, rows };
}

export const GATE_INPUTS = [
  /^scripts\/size-measure\.mjs$/, /^scripts\/size-budget\.mjs$/, /^size-budget\.json$/,
  /^\.github\/workflows\//, /^package\.json$/, /^pnpm-lock\.yaml$/, /^\.nvmrc$/,
  /^heap-budget\.json$/, /^scripts\/heap-budget\.mjs$/, /^core-api-surface\.json$/,
  /^scripts\/core-api-surface\.mjs$/, /^scripts\/ci-paths\.mjs$/,
];
export const gateInputs = (files) => files.filter((f) => GATE_INPUTS.some((re) => re.test(f)));

const git = (...a) => execFileSync("git", a, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).trim();
const arg = (name) => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1]; };
const event = () => process.env.GITHUB_EVENT_PATH ? JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8")) : {};

// Bind to the tested event, never today's master tip. Dispatch compares with
// the merge-base and does not require updating a branch just for size.
export function testedTransition({ cwd = root, name = process.env.GITHUB_EVENT_NAME ?? "local", ev = event(), master = process.env.SIZE_DISPATCH_MASTER } = {}) {
  const g = (...a) => execFileSync("git", a, { cwd, encoding: "utf8" }).trim();
  const merge = g("rev-parse", "HEAD");
  const parents = g("rev-list", "--parents", "-n", "1", merge).split(" ").slice(1);
  if (name === "pull_request") {
    if (parents.length !== 2 || parents[1] !== ev.pull_request?.head?.sha) throw new Error("tested commit is not the pull request's two-parent merge");
    return { mode: "transition", merge, base: parents[0], head: parents[1] };
  }
  if (name === "merge_group") {
    if (!parents[0] || ev.merge_group?.base_sha !== parents[0]) throw new Error("merge_group base is not HEAD^1");
    return { mode: "transition", merge, base: parents[0], head: parents[1] ?? null };
  }
  if (name === "push" && ev.before && !/^0{40}$/.test(ev.before)) {
    g("merge-base", "--is-ancestor", ev.before, merge);
    return { mode: "transition", merge, base: ev.before };
  }
  if (name === "workflow_dispatch") {
    const tip = master || g("rev-parse", "refs/remotes/origin/master");
    // Exactly one base; criss-cross ambiguity is not a zero baseline.
    const bases = g("merge-base", "--all", merge, tip).split("\n");
    if (bases.length !== 1) throw new Error("dispatch needs exactly one merge-base");
    return bases[0] === merge ? { mode: "absolute", merge, master: tip } :
      { mode: "transition", merge, base: bases[0], master: tip };
  }
  return { mode: "absolute", merge };
}

function readRecord(dir, name) {
  const file = join(dir, name);
  const over = overCap(name, statSync(file).size, LIMITS.record_bytes);
  if (over) throw new Error(over);
  return strictParse(readFileSync(file, "utf8"));
}

export function producerProblems(rec, commit, tree, job, env = process.env) {
  const p = recordProblems(rec, commit);
  if (rec?.tree !== tree) p.push("record tree does not match " + commit);
  if (env.GITHUB_RUN_ID && (String(rec?.run?.id) !== env.GITHUB_RUN_ID ||
      String(rec?.run?.attempt) !== env.GITHUB_RUN_ATTEMPT || rec?.run?.job !== job))
    p.push("record producer does not match this run, attempt and " + job + " job");
  if (env.GITHUB_EVENT_NAME && rec?.event !== env.GITHUB_EVENT_NAME) p.push("record event does not match this run");
  return p;
}

async function gate() {
  const t = testedTransition(), lines = ["## Per-change size comparison", "",
    "Backstop: growth must exceed both 2% of the base and 50,000 bytes to fail. Equality passes.", ""];
  let result;
  try {
    if (process.argv.includes("--docs-only")) {
      if (!t.base) throw new Error("docs-only needs a base");
      const files = git("diff", "--name-only", t.base, t.merge).split("\n").filter(Boolean);
      if (gateInputs(files).length || process.env.SIZE_GATE_NODE === "true" || process.env.SIZE_GATE_WEB === "true")
        throw new Error("measurement or gate inputs changed but the measurement did not run");
      result = { ok: true, problems: [], notes: ["No measured or gate inputs changed."], rows: [] };
    } else {
      const dir = arg("--records"), M = readRecord(dir, "merge-record.json");
      const N = t.base ? readRecord(dir, "base-record.json") : null;
      const p = producerProblems(M, t.merge, git("rev-parse", t.merge + "^{tree}"), "checks");
      if (N) p.push(...producerProblems(N, t.base, git("rev-parse", t.base + "^{tree}"), "size-base"));
      if (M.key?.measure_sha256 !== sha256(readFileSync(SELF))) p.push("record measurement recipe is not this run's script");
      if (p.length) throw new Error(p.join("; "));
      result = evaluate({ mode: t.mode, merge: { record: M }, base: N && { commit: t.base, record: N } });
    }
  } catch (e) { result = { ok: false, problems: [e.message], notes: [], rows: [] }; }
  result.tested = t;
  lines.push(result.ok ? "**PASS**" : "**FAIL**", "",
    "tested merge " + t.merge + ", base " + (t.base ?? "-") + ", head " + (t.head ?? "-"), "",
    "| bundle | base | merge | delta | limit (B) | notes |", "|---|---:|---:|---:|---:|---|");
  for (const r of result.rows) lines.push("| " + r.bundle.replaceAll("|", "\\|") + " | " + (r.base ?? "") + " | " + r.merge + " | " + (r.delta === undefined ? "" : fmt(r.delta)) + " | " + (r.limit ?? "") + " | " + (r.note ?? "") + " |");
  for (const n of result.notes) lines.push("- " + n);
  for (const p of result.problems) lines.push("- **" + p + "**");
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join("\n") + "\n");
  console.log(lines.join("\n"));
  if (arg("--out")) writeFileSync(arg("--out"), JSON.stringify(result, null, 1) + "\n");
  process.exitCode = result.ok ? 0 : 1;
}

async function cli() {
  const mode = process.argv[2], dir = arg("--root") ?? root;
  if (mode === "--record" || mode === "--census") {
    const { buildProblems } = await import("./size-budget.mjs");
    const p = buildProblems(dir, TOOLCHAIN.bun);
    if (process.version !== "v" + TOOLCHAIN.node) p.push("recording requires node " + TOOLCHAIN.node);
    if (p.length) throw new Error(p.join("; "));
    const m = await measure(dir);
    if (m.problems.length) throw new Error(m.problems.join("; "));
    if (mode === "--census") return console.log(m.counts);
    const g = (...a) => execFileSync("git", a, { cwd: dir, encoding: "utf8" }).trim();
    const rec = makeRecord({ commit: g("rev-parse", "HEAD"), tree: g("rev-parse", "HEAD^{tree}"),
      event: process.env.GITHUB_EVENT_NAME ?? "local",
      run: { id: process.env.GITHUB_RUN_ID ?? null, attempt: process.env.GITHUB_RUN_ATTEMPT ?? null, job: process.env.GITHUB_JOB ?? null },
      key: currentKey(), m });
    writeFileSync(arg("--out"), JSON.stringify(rec, null, 1) + "\n");
    console.log("size record for " + rec.commit + ": " + rec.bundles.length + " bundles");
  } else if (mode === "--resolve-base") {
    const t = testedTransition(), dir = arg("--out-dir");
    mkdirSync(dir, { recursive: true });
    const out = (k, v) => process.env.GITHUB_OUTPUT ? appendFileSync(process.env.GITHUB_OUTPUT, k + "=" + v + "\n") : console.log(k + "=" + v);
    out("mode", t.mode);
    if (t.master) out("master", t.master);
    if (t.base) out("base", t.base);
    // Rebuild once with this run's measurement recipe; no stored budgets,
    // cached baselines, old-key builds or epoch migration.
    out("need_new", String(!!t.base));
  } else if (mode === "--gate") await gate();
  else throw new Error("usage: size-measure.mjs --record|--census|--resolve-base|--gate");
}
if (process.argv[1] === SELF) await cli();
