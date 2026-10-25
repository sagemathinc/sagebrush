// Install time and startup time of the npm package, the head against a base
// on one runner (plan-install-timing-r2): report-only, never a gate.  Weekly
// and on dispatch (.github/workflows/install-timing.yml).
//   node scripts/install-timing.mjs --resolve --dir D     the two sides (env HEAD_INPUT, BASE_INPUT, AA_INPUT)
//   node scripts/install-timing.mjs --prepare A|B --dir D  build the side in its own worktree, pack it, validate the payload
//   node scripts/install-timing.mjs --measure --dir D      7 alternating rounds (§3, §4)
//   node scripts/install-timing.mjs --summary --dir D      the step summary, whatever exists (also after a failure)
// The base, without a base input: the highest stable vMAJOR.MINOR.PATCH tag,
// by version, whose peeled commit is the head or an ancestor of it (§1).
// "Cold" is a cold process with an empty compile cache (warm page cache);
// every measured child gets the allowlisted environment of §3, and cache use
// is verified, never assumed.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { cpus, platform, release } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { isolationProblem, md, npmEnv, packDir, parsePack, runNpm } from "./npm-pack-metrics.mjs";

const SELF = fileURLToPath(import.meta.url);
const root = join(dirname(SELF), "..");
export const FORMAT = "sagebrush-install-timing";
export const ROUNDS = 7;
export const K = { install: 3, warm: 5 };
export const STABLE_TAG = /^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
export const RULE = "the highest stable vMAJOR.MINOR.PATCH tag, by integer version, whose peeled commit is the head or an ancestor of it";
const SPAWN_TIMEOUT_MS = 120_000;
const sha256 = (data) => createHash("sha256").update(data).digest("hex");

// ---------------------------------------------------------------------------
// The two sides (§1)

// [major, minor, patch] as BigInts (no float parsing, no precision loss), or null
export function parseVersion(name) {
  const m = STABLE_TAG.exec(name);
  return m ? [BigInt(m[1]), BigInt(m[2]), BigInt(m[3])] : null;
}
export function cmpVersion(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return 0;
}
const git = (cwd, ...args) => spawnSync("git", args, { cwd, encoding: "utf8" });

// A ref input: {sha} or {invalid}; plain names fall back to origin/<name>
export function resolveRef(cwd, ref) {
  if (typeof ref !== "string" || !ref) return { invalid: "an empty ref" };
  if (ref.startsWith("-") || /[\u0000-\u001f\u007f\s]/.test(ref)) return { invalid: `a ref that looks like an option or holds whitespace: ${JSON.stringify(ref.slice(0, 80))}` };
  for (const r of [ref, `origin/${ref}`]) {
    const out = git(cwd, "rev-parse", "--verify", "--quiet", "--end-of-options", `${r}^{commit}`);
    if (out.status === 0 && /^[0-9a-f]{40}$/.test(out.stdout.trim())) return { sha: out.stdout.trim() };
  }
  return { invalid: `not a commit here: ${JSON.stringify(ref.slice(0, 80))}` };
}

// The default base for head H: {tag, sha, considered} or {unavailable, considered}
export function selectBase(cwd, head) {
  const names = git(cwd, "for-each-ref", "--format=%(refname:strip=2)", "refs/tags").stdout.split("\n").filter(Boolean).sort();
  const considered = [];
  let best = null;
  for (const name of names) {
    const v = parseVersion(name);
    if (!v) {
      considered.push({ tag: name, kept: false, reason: "not a stable vMAJOR.MINOR.PATCH name" });
      continue;
    }
    const peeled = git(cwd, "rev-parse", "--verify", "--quiet", "--end-of-options", `refs/tags/${name}^{commit}`).stdout.trim();
    if (!/^[0-9a-f]{40}$/.test(peeled)) {
      considered.push({ tag: name, kept: false, reason: "doesn't peel to a commit" });
      continue;
    }
    if (git(cwd, "merge-base", "--is-ancestor", peeled, head).status !== 0) {
      considered.push({ tag: name, sha: peeled, kept: false, reason: "not an ancestor of the head" });
      continue;
    }
    considered.push({ tag: name, sha: peeled, kept: true, reason: "eligible" });
    if (!best || cmpVersion(v, best.v) > 0) best = { tag: name, sha: peeled, v };
  }
  if (!best) return { unavailable: "no stable release tag is an ancestor of the head", considered };
  for (const c of considered) if (c.kept && c.tag !== best.tag) c.reason = "eligible, but a higher version is";
  const chosen = considered.find((c) => c.tag === best.tag);
  chosen.reason = "chosen: the highest eligible version";
  return { tag: best.tag, sha: best.sha, considered };
}

// {head, base, aa, considered} or {invalid}: a bad input is refused, never
// confused with "no default base"
export function resolveSides(cwd, { headInput, baseInput, aaInput }) {
  const shallow = git(cwd, "rev-parse", "--is-shallow-repository").stdout.trim();
  if (shallow !== "false") return { invalid: "the checkout is shallow (or not a repository): full history and tags are required" };
  const h = resolveRef(cwd, headInput || "master");
  if (h.invalid) return { invalid: `head: ${h.invalid}` };
  const head = { sha: h.sha, input: headInput || "master" };
  if (aaInput === true || aaInput === "true") return { head, base: { sha: h.sha, how: "aa", label: `the head itself (A/A, noise)` }, aa: true, considered: [] };
  if (aaInput !== undefined && aaInput !== "" && aaInput !== false && aaInput !== "false") return { invalid: `aa: not a boolean: ${JSON.stringify(String(aaInput).slice(0, 20))}` };
  if (baseInput) {
    const b = resolveRef(cwd, baseInput);
    if (b.invalid) return { invalid: `base: ${b.invalid}` };
    return { head, base: { sha: b.sha, how: "input", input: baseInput, label: `the base input ${baseInput} (commit ${b.sha})` }, aa: b.sha === h.sha, considered: [] };
  }
  const s = selectBase(cwd, h.sha);
  if (s.unavailable) return { head, base: { how: "default", unavailable: s.unavailable }, aa: false, considered: s.considered };
  return { head, base: { sha: s.sha, how: "default", tag: s.tag, label: `rebuilt here from tag ${s.tag} (commit ${s.sha})` }, aa: s.sha === h.sha, considered: s.considered };
}

// ---------------------------------------------------------------------------
// Statistics (§4, §9): one value per tree per measure per round

export function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  if (!s.length) return null;
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
// A then B in odd rounds (1-based), B then A in even ones
export const order = (round) => (round % 2 ? ["A", "B"] : ["B", "A"]);
export function paired(a, b) {
  const n = Math.min(a.length, b.length);
  const diffs = [], ratios = [];
  for (let i = 0; i < n; i++) {
    if (a[i] == null || b[i] == null) continue;
    diffs.push(b[i] - a[i]);
    ratios.push(b[i] / a[i]);
  }
  return { n: diffs.length, medA: median(a.filter((x) => x != null)), medB: median(b.filter((x) => x != null)), medDiff: median(diffs), medRatio: median(ratios), minDiff: diffs.length ? Math.min(...diffs) : null, maxDiff: diffs.length ? Math.max(...diffs) : null, diffs, ratios };
}

// ---------------------------------------------------------------------------
// Measured children (§3)

// The allowlisted environment: nothing inherited but PATH (no NODE_*,
// npm_config_* or SAGEBRUSH_*: NODE_DISABLE_COMPILE_CACHE alone would
// override the cache asked for)
export function measuredEnv({ path = process.env.PATH, home, tmp, compileCache }) {
  // (NODE_V8_COVERAGE set, and empty: child_process copies the parent's value
  // into an explicit env that lacks the name, for coverage tools)
  const env = { PATH: path, HOME: home, TMPDIR: tmp, LANG: "C.UTF-8", NODE_V8_COVERAGE: "" };
  if (compileCache) env.NODE_COMPILE_CACHE = compileCache;
  return env;
}
// The cache's entries: [[relative path, size, mtimeMs], ...] sorted
export function listing(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) {
        const s = statSync(p);
        out.push([relative(dir, p), s.size, s.mtimeMs]);
      }
    }
  };
  if (existsSync(dir)) walk(dir);
  return out.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}
const sameListing = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// The CPU to pin to: one the process is allowed, or null (affinity not applied)
export function cpuChoice(statusText = existsSync("/proc/self/status") ? readFileSync("/proc/self/status", "utf8") : "", hasTaskset = spawnSync("taskset", ["-V"]).status === 0) {
  const m = /^Cpus_allowed_list:\s*(.+)$/m.exec(statusText);
  if (!m || !hasTaskset) return { cpu: null, allowed: m ? m[1].trim() : null, taskset: hasTaskset };
  const allowed = [];
  for (const part of m[1].trim().split(",")) {
    const [lo, hi] = part.split("-").map((x) => Number.parseInt(x, 10));
    for (let c = lo; c <= (hi ?? lo); c++) allowed.push(c);
  }
  return { cpu: allowed.includes(1) ? 1 : (allowed[0] ?? null), allowed: m[1].trim(), taskset: true };
}

// Only the spawn is timed (§9): everything else is prepared before
export function timed(cmd, args, { cwd, env, cpu = null, timeoutMs = SPAWN_TIMEOUT_MS }) {
  const [c, a] = cpu === null ? [cmd, args] : ["taskset", ["-c", String(cpu), cmd, ...args]];
  const t0 = process.hrtime.bigint();
  const r = spawnSync(c, a, { cwd, env, encoding: "utf8", timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  return { ms, status: r.status, signal: r.signal, error: r.error?.code ?? null, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}
const ok = (r) => r.status === 0 && !r.error;
const fail = (what, r) => new Error(`${what}: ${r.error ? r.error : `exit ${r.status ?? r.signal}`}: ${(r.stderr || r.stdout || "").trim().split("\n").pop()?.slice(0, 200) ?? ""}`);

// The names of a measured child's environment, sorted (recorded per measure, §3)
export const envNames = (env) => Object.keys(env).sort();

// One tree's block for one round (§3).  The block is filled as samples arrive
// and handed to onSample after each one, so a failure loses nothing already
// measured: on a failure the block is marked incomplete, its reason recorded,
// and the error (with the block as .block) thrown.  Values are computed only
// for a complete block, and a measure whose cache check failed has none.  The
// warm-up (§4) is one install and one cold --version, discarded.
export function measureTree(tree, { work, cpu = null, npm = "npm", npx = "npx", warmup = false, onSample = () => {} }) {
  const block = { incomplete: true, failed: null, raw: { install: [], npx: [], versionCold: [], versionWarm: [], evalCold: [], evalWarm: [] }, cache: {}, env: {}, values: null };
  const { raw, cache } = block;
  const sample = (key, r) => {
    raw[key].push(r.ms);
    onSample(block);
  };
  try {
    const mk = (name) => {
      const d = join(work, name);
      mkdirSync(d, { recursive: true });
      return d;
    };
    const cfgDir = mk("cfg");
    const u = join(cfgDir, "userconfig"), g = join(cfgDir, "globalconfig");
    writeFileSync(u, "");
    writeFileSync(g, "");
    const iso = isolationProblem(u, g);
    if (iso) throw new Error(`npm config isolation failed: ${iso}`);
    const home = mk("home"), tmp = mk("tmp");
    const npmChildEnv = (cc) => npmEnv(measuredEnv({ home, tmp, compileCache: cc }), u, g);
    // 1. install, k = 3, each into a fresh prefix and cache
    let prefix = null;
    block.env.install = envNames(npmChildEnv(null));
    for (let i = 0; i < (warmup ? 1 : K.install); i++) {
      prefix = mk(`prefix-${i}`);
      const npmCache = mk(`npm-cache-${i}`);
      const r = timed(npm, ["install", "-g", "--prefix", prefix, "--cache", npmCache, "--offline", "--ignore-scripts", "--no-audit", "--no-fund", tree.tgz], { cwd: tmp, env: npmChildEnv(null), cpu });
      if (!ok(r)) throw fail("npm install", r);
      sample("install", r);
    }
    // (the installed executable itself, as a user runs it: its shebang finds node on PATH)
    const bin = join(prefix, "bin", "sagebrush");
    block.bin = bin;
    if (warmup) {
      const r = timed(bin, ["--version"], { cwd: tmp, env: measuredEnv({ home, tmp, compileCache: mk("cc-warmup") }), cpu });
      if (!ok(r)) throw fail("warm-up --version", r);
      block.incomplete = false;
      return { warmup: true, version: r.stdout.trim() };
    }
    // 2. npx first run, its own npm cache, cwd and compile cache
    {
      const npxCache = mk("npx-cache"), npxCwd = mk("npx-cwd"), C = mk("cc-npx");
      const env = npmChildEnv(C);
      block.env.npx = envNames(env);
      const c = { dir: C, emptyBefore: listing(C).length === 0, problems: [] };
      if (!c.emptyBefore) c.problems.push("not empty before the run");
      cache.npx = c;
      const r = timed(npx, ["--yes", "--offline", "--cache", npxCache, "--package", tree.tgz, "sagebrush", "--version"], { cwd: npxCwd, env, cpu });
      if (!ok(r) || !r.stdout.startsWith(`sagebrush ${tree.version}`)) throw fail("npx --version", r);
      raw.npxStdout = r.stdout.trim().slice(0, 300);
      c.entries = listing(C).length;
      if (!c.entries) c.problems.push("empty after the run");
      c.verified = c.problems.length === 0;
      sample("npx", r);
    }
    // 3-6. cold, then warm x5, for --version (A) and -c (B)
    for (const [key, args, check] of [
      ["version", ["--version"], (s) => s.startsWith(`sagebrush ${tree.version}`)],
      ["eval", ["-c", "print(2+2)"], (s) => s.trim().split(/\s+/)[0] === "4"],
    ]) {
      const dir = mk(`cc-${key}`);
      const env = measuredEnv({ home, tmp, compileCache: dir });
      block.env[key] = envNames(env);
      const c = { dir, emptyBefore: listing(dir).length === 0, problems: [] };
      if (!c.emptyBefore) c.problems.push("not empty before the cold sample");
      cache[key] = c;
      const cold = timed(bin, args, { cwd: tmp, env, cpu });
      if (!ok(cold) || !check(cold.stdout)) throw fail(`${key} (cold)`, cold);
      raw[`${key}ColdStdout`] = cold.stdout.trim().slice(0, 300);
      const afterCold = listing(dir);
      c.afterCold = afterCold.length;
      if (!afterCold.length) c.problems.push("empty after the cold sample");
      sample(`${key}Cold`, cold);
      for (let i = 0; i < K.warm; i++) {
        const w = timed(bin, args, { cwd: tmp, env, cpu });
        if (!ok(w) || !check(w.stdout)) throw fail(`${key} (warm)`, w);
        raw[`${key}WarmStdout`] = w.stdout.trim().slice(0, 300);
        if (!sameListing(listing(dir), afterCold)) c.problems.push(`the entry list changed after warm sample ${i + 1}`);
        sample(`${key}Warm`, w);
      }
      c.verified = c.problems.length === 0;
    }
  } catch (e) {
    block.failed = e.message;
    onSample(block);
    e.block = block;
    throw e;
  }
  const v = (key) => cache[key].verified;
  block.values = {
    install: median(raw.install),
    npx: v("npx") ? raw.npx[0] : null,
    versionCold: v("version") ? raw.versionCold[0] : null,
    versionWarm: v("version") ? Math.min(...raw.versionWarm) : null,
    evalCold: v("eval") ? raw.evalCold[0] : null,
    evalWarm: v("eval") ? Math.min(...raw.evalWarm) : null,
  };
  // (diagnostics only, never in the paired estimator: the warm median of 5, and max/min per measure)
  const spread = (xs) => (xs.length ? Math.max(...xs) / Math.min(...xs) : null);
  block.diagnostics = { versionWarmMedian: median(raw.versionWarm), evalWarmMedian: median(raw.evalWarm), installSpread: spread(raw.install), versionWarmSpread: spread(raw.versionWarm), evalWarmSpread: spread(raw.evalWarm) };
  block.incomplete = false;
  onSample(block);
  return block;
}

// ---------------------------------------------------------------------------
// The summary (§4)

export const MEASURES = [
  ["install", "install (`npm install -g` from the tarball, median of 3)"],
  ["npx", "npx first run (`--version`)"],
  ["versionCold", "`--version`, cold"],
  ["versionWarm", "`--version`, warm (best of 5)"],
  ["evalCold", "`-c \"print(2+2)\"`, cold"],
  ["evalWarm", "`-c \"print(2+2)\"`, warm (best of 5)"],
];
const f1 = (x) => (x == null ? "" : x.toFixed(1));
const sgn = (x) => (x == null ? "" : (x > 0 ? "+" : x < 0 ? "−" : "") + Math.abs(x).toFixed(1));

export function summary(rec) {
  const L = ["## Install and startup time (report-only, plan-install-timing-r2)", ""];
  if (rec.invalid) return [...L, `**not measured: invalid input: ${md(rec.invalid)}**`, ""];
  if (rec.failed) L.push(`**failed at: ${md(rec.failed)}** (what was measured before it is below)`, "");
  const s = rec.sides ?? {};
  if (s.head) L.push(`- head: ${md(s.head.input)} = \`${s.head.sha}\``);
  if (s.base) L.push(`- base: ${s.base.unavailable ? `unavailable: ${md(s.base.unavailable)}` : md(s.base.label)}`);
  if (s.aa) L.push("- **A/A (noise)**: base and head are the same commit");
  if (rec.trees) for (const side of ["A", "B"]) {
    const t = rec.trees[side];
    if (t) L.push(`- ${side === "A" ? "base" : "head"} payload: ${t.version}, ${t.size?.toLocaleString("en-US")} B packed, ${t.unpackedSize?.toLocaleString("en-US")} B unpacked, sha256 \`${t.tgzSha256}\``);
  }
  if (rec.trees?.A && rec.trees?.B && !s.aa && rec.trees.A.tgzSha256 === rec.trees.B.tgzSha256) L.push("- identical payloads: base and head pack to the same tarball");
  if (rec.env) L.push(`- runner: ${md(rec.env.os)}, ${md(rec.env.cpu)} × ${rec.env.cpus}; node ${rec.env.node}, npm ${md(rec.env.npm)}; affinity ${rec.env.affinity.cpu === null ? `not applied (allowed ${md(rec.env.affinity.allowed ?? "?")}, taskset ${rec.env.affinity.taskset})` : `CPU ${rec.env.affinity.cpu} of ${md(rec.env.affinity.allowed)}`}`);
  L.push("");
  const rounds = rec.rounds ?? [];
  if (!rounds.length) return [...L, "no rounds measured", ""];
  const two = !!rec.trees?.A && !!rec.trees?.B && rounds.some((r) => r.A);
  // (aggregates only from complete rounds and complete blocks; the rest is shown below, never pooled)
  const val = (r, side, k) => (r.incomplete || !r[side] || r[side].incomplete || !r[side].values ? null : r[side].values[k]);
  L.push(two ? "| ms | base (median of rounds) | head | median paired Δ | median ratio | Δ min … max |" : "| ms | head (median of rounds) |", two ? "|---|---:|---:|---:|---:|---:|" : "|---|---:|");
  for (const [k, label] of MEASURES) {
    const a = rounds.map((r) => val(r, "A", k)), b = rounds.map((r) => val(r, "B", k));
    if (!two) {
      L.push(`| ${label} | ${f1(median(b.filter((x) => x != null)))} |`);
      continue;
    }
    const p = paired(a, b);
    L.push(`| ${label} | ${f1(p.medA)} | ${f1(p.medB)} | ${sgn(p.medDiff)} | ${p.medRatio == null ? "" : p.medRatio.toFixed(4)} | ${sgn(p.minDiff)} … ${sgn(p.maxDiff)} |`);
  }
  L.push("");
  const unverified = [];
  for (const r of rounds) for (const side of ["A", "B"]) for (const k of ["npx", "version", "eval"]) {
    const c = r[side]?.cache?.[k];
    if (c && c.verified === false) unverified.push(`round ${r.round} ${side} ${k}: ${c.problems.join("; ")}`);
  }
  for (const u of unverified) L.push(`- compile cache not verified (no time reported): ${md(u)}`);
  for (const r of rounds) {
    if (r.incomplete) L.push(`- round ${r.round} is incomplete: excluded from the aggregates, its samples kept below`);
    for (const side of ["A", "B"]) if (r[side]?.failed) L.push(`- round ${r.round} ${side === "A" ? "base" : "head"} failed: ${md(r[side].failed)}`);
  }
  if (s.aa) L.push("- an A/A run: its Δ column is this runner's noise for this run");
  L.push(`- ${rounds.length} rounds; odd rounds base first, even rounds head first; each round's value is one per tree (install: median of 3; warm: best of 5; cold and npx: the single sample). Δ and ratio are medians of the per-round paired values. No threshold: report-only.`);
  L.push("", "<details><summary>diagnostics per round (not in the estimator): warm median of 5, and max/min spread</summary>", "", "| round | side | `--version` warm best / median / spread | `-c` warm best / median / spread | install spread |", "|---:|---|---|---|---:|");
  const sp = (x) => (x == null ? "" : `×${x.toFixed(3)}`);
  for (const r of rounds) for (const side of ["A", "B"]) {
    const b = r[side];
    if (!b || !b.diagnostics) continue;
    const d = b.diagnostics;
    L.push(`| ${r.round} | ${side} | ${f1(Math.min(...b.raw.versionWarm))} / ${f1(d.versionWarmMedian)} / ${sp(d.versionWarmSpread)} | ${f1(Math.min(...b.raw.evalWarm))} / ${f1(d.evalWarmMedian)} / ${sp(d.evalWarmSpread)} | ${sp(d.installSpread)} |`);
  }
  L.push("", "</details>", "");
  L.push("", "<details><summary>every sample (ms)</summary>", "", "| round | first | side | measure | samples |", "|---:|---|---|---|---|");
  for (const r of rounds) for (const side of ["A", "B"]) {
    if (!r[side]) continue;
    const mark = r[side].incomplete ? " (incomplete)" : "";
    for (const k of ["install", "npx", "versionCold", "versionWarm", "evalCold", "evalWarm"]) L.push(`| ${r.round} | ${r.first} | ${side}${mark} | ${k} | ${r[side].raw[k].map((x) => x.toFixed(1)).join(", ")} |`);
  }
  L.push("", "</details>", "");
  return L;
}

// ---------------------------------------------------------------------------
// The CLI (the workflow's steps)

const arg = (n) => {
  const i = process.argv.indexOf(n);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const readJson = (p) => (existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null);
const writeJson = (p, v) => writeFileSync(p, JSON.stringify(v, null, 1) + "\n");

function prepare(dir, side) {
  const sides = readJson(join(dir, "sides.json"));
  if (!sides || sides.invalid) throw new Error("no valid sides");
  const sha = side === "A" ? sides.base?.sha : sides.head.sha;
  if (!sha) return console.log(`side ${side}: no commit (${sides.base?.unavailable ?? "none"}); skipped`);
  if (side === "B" && sides.aa) return console.log("A/A: the head is the base's build; skipped");
  const wt = join(dir, `wt-${side}`);
  const step = (what, cmd, args, timeoutMs) => {
    console.log(`::group::${side}: ${what}`);
    const r = spawnSync(cmd, args, { cwd: wt, stdio: "inherit", timeout: timeoutMs });
    console.log("::endgroup::");
    if (r.status !== 0) throw new Error(`${side === "A" ? "base" : "head"} unavailable: ${what} (${r.error?.code ?? `exit ${r.status ?? r.signal}`})`);
  };
  execFileSync("git", ["worktree", "add", "--detach", wt, sha], { cwd: root, stdio: "inherit" });
  step("pnpm install", "pnpm", ["install", "--frozen-lockfile"], 300_000);
  step("pnpm run build", "pnpm", ["run", "build"], 300_000);
  step("build-cli", "node", ["scripts/build-cli.mjs"], 300_000);
  step("web build", "bun", ["web/build.ts"], 300_000);
  step("build-cli (with the page)", "node", ["scripts/build-cli.mjs"], 300_000);
  const pkgDir = join(wt, "packages", "sagebrush");
  const dry = packDir(pkgDir);
  if (dry.reason) throw new Error(`${side}: the payload isn't valid: ${dry.reason}`);
  const out = join(dir, `pack-${side}`);
  mkdirSync(out, { recursive: true });
  const r = runNpm(["pack", "--json", "--ignore-scripts", "--workspaces=false", "--pack-destination", out], { cwd: pkgDir });
  if (r.reason) throw new Error(`${side}: npm pack: ${r.reason}`);
  const files = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")).files ?? [];
  const p = parsePack(r.stdout, files);
  if (p.reason) throw new Error(`${side}: the packed payload isn't valid: ${p.reason}`);
  if (JSON.stringify(p.files) !== JSON.stringify(dry.files)) throw new Error(`${side}: the real pack differs from the validated dry run`);
  const tgz = join(out, JSON.parse(r.stdout)[0].filename);
  const version = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")).version;
  writeJson(join(dir, `tree-${side}.json`), { side, sha, version, tgz, tgzSha256: sha256(readFileSync(tgz)), size: p.size, unpackedSize: p.unpackedSize, entryCount: p.entryCount, files: p.files, npmKey: dry.key });
  execFileSync("git", ["worktree", "remove", "--force", wt], { cwd: root });
  console.log(`${side}: ${version} at ${sha}, ${p.size} B packed`);
}

export function measure(dir, { rounds = ROUNDS, npm = "npm", npx = "npx" } = {}) {
  const sides = readJson(join(dir, "sides.json"));
  const A = readJson(join(dir, "tree-A.json"));
  let B = readJson(join(dir, "tree-B.json"));
  if (sides.aa && A) B = { ...A, side: "B" };
  if (!B) throw new Error("no head tree");
  const trees = { A, B };
  const affinity = cpuChoice();
  const npmV = spawnSync("npm", ["--version"], { encoding: "utf8" }).stdout?.trim() ?? null;
  // (the measured children's environment names: the allowlist, plus npm's two config files; each block records its own per measure)
  const measuredEnvNames = { cli: envNames(measuredEnv({ home: "", tmp: "", compileCache: "." })), npm: envNames(npmEnv(measuredEnv({ home: "", tmp: "" }), "", "")), npx: envNames(npmEnv(measuredEnv({ home: "", tmp: "", compileCache: "." }), "", "")) };
  const rec = { format: FORMAT, v: 1, script_sha256: sha256(readFileSync(SELF)), sides, trees, env: { os: `${platform()} ${release()}`, cpu: cpus()[0]?.model ?? "?", cpus: cpus().length, node: process.versions.node, npm: npmV, affinity, measuredEnvNames }, rounds: [] };
  const save = () => writeJson(join(dir, "install-timing.json"), rec);
  const work = mkdtempSync(join(dir, "work-"));
  try {
    // one discarded warm-up per tree: an install and a --version
    for (const side of ["A", "B"]) if (trees[side]) {
      const w = join(work, `warmup-${side}`);
      const r = measureTree(trees[side], { work: w, cpu: affinity.cpu, warmup: true, npm, npx });
      (rec.warmup ??= {})[side] = r.version.slice(0, 300);
      if (!r.version.startsWith(`sagebrush ${trees[side].version}`)) throw new Error(`${side} answers ${r.version.slice(0, 80)}, not ${trees[side].version}`);
      rmSync(w, { recursive: true, force: true });
    }
    // (each round is recorded as it starts, and each block after every sample: a failure keeps everything measured)
    for (let round = 1; round <= rounds; round++) {
      const first = order(round)[0];
      const entry = { round, first: first === "A" ? "base" : "head", incomplete: true };
      rec.rounds.push(entry);
      save();
      for (const side of order(round)) {
        if (!trees[side]) continue;
        const w = join(work, `r${round}-${side}`);
        measureTree(trees[side], { work: w, cpu: affinity.cpu, npm, npx, onSample: (b) => {
          entry[side] = b;
          save();
        } });
        rmSync(w, { recursive: true, force: true });
      }
      entry.incomplete = false;
      save();
      console.log(`round ${round} done`);
    }
  } catch (e) {
    rec.failed = `measurement: ${e.message}`;
    save();
    throw e;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  save();
}

function cli() {
  const mode = process.argv[2], dir = arg("--dir");
  if (!dir) throw new Error("--dir is required");
  mkdirSync(dir, { recursive: true });
  if (mode === "--resolve") {
    const s = resolveSides(root, { headInput: process.env.HEAD_INPUT, baseInput: process.env.BASE_INPUT, aaInput: process.env.AA_INPUT });
    writeJson(join(dir, "sides.json"), s);
    if (s.invalid) {
      writeJson(join(dir, "install-timing.json"), { format: FORMAT, v: 1, invalid: s.invalid });
      console.error(`invalid input: ${s.invalid}`);
      process.exit(1);
    }
    console.log(`head ${s.head.sha}; base ${s.base.unavailable ? `unavailable: ${s.base.unavailable}` : s.base.label}${s.aa ? "; A/A" : ""}`);
    for (const c of s.considered) console.log(`  tag ${c.tag}: ${c.reason}`);
  } else if (mode === "--prepare") {
    const side = arg("--prepare");
    if (side !== "A" && side !== "B") throw new Error("--prepare A|B");
    try {
      prepare(dir, side);
    } catch (e) {
      const p = join(dir, "install-timing.json");
      writeJson(p, { ...(readJson(p) ?? { format: FORMAT, v: 1 }), sides: readJson(join(dir, "sides.json")), failed: e.message });
      throw e;
    }
  } else if (mode === "--measure") {
    measure(dir);
  } else if (mode === "--summary") {
    const rec = readJson(join(dir, "install-timing.json")) ?? { failed: "nothing was recorded", sides: readJson(join(dir, "sides.json")) };
    const lines = summary(rec);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join("\n") + "\n");
    console.log(lines.join("\n"));
  } else {
    console.error("usage: install-timing.mjs --resolve|--prepare A|B|--measure|--summary --dir D (see the header)");
    process.exit(2);
  }
}

if (process.argv[1] === SELF) cli();
