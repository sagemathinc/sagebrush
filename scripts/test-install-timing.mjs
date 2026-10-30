// scripts/install-timing.mjs (plan-install-timing-r2 §7): the statistics, the
// order, the base-tag rule on a fixture repository, input refusal, the
// summary, the workflow's contract, a real smoke of every measure on a tiny
// package under a hostile parent environment, and, where the bundle is built
// (the checks job), the real CLI's cold-to-warm compile cache on this Node.
//   node scripts/test-install-timing.mjs
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chmodSync } from "node:fs";
import { cmpVersion, cpuChoice, measure, measuredEnv, measureTree, median, order, paired, parseVersion, resolveRef, resolveSides, selectBase, summary, ROUNDS } from "./install-timing.mjs";
import { parsePack, runNpm } from "./npm-pack-metrics.mjs";

let passed = 0, failures = 0;
function check(name, ok, detail = "") {
  if (ok) passed++;
  else {
    failures++;
    console.error(`FAIL ${name}${detail ? `: ${detail}` : ""}`);
  }
}
const tmp = mkdtempSync(join(tmpdir(), "install-timing-test-"));
// Set some of process.env for fn, then put it back exactly
function withEnv(vars, fn) {
  const before = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(before)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}
const root = new URL("..", import.meta.url).pathname;
try {
  // ---- statistics and order (§4, §9)
  check("median: odd", median([5, 1, 3]) === 3);
  check("median: even", median([4, 1, 3, 2]) === 2.5);
  check("median: empty", median([]) === null);
  {
    const p = paired([10, 20, 30, 40, 50, 60, 70], [11, 19, 33, 40, 55, 66, 77]);
    // diffs 1,-1,3,0,5,6,7 -> median 3; ratios 1.1,0.95,1.1,1,1.1,1.1,1.1 -> median 1.1
    check("paired: the median of the per-round differences", p.medDiff === 3 && p.n === 7, JSON.stringify(p));
    check("paired: the median of the per-round ratios, not of the marginals", Math.abs(p.medRatio - 1.1) < 1e-12 && p.medB / p.medA !== p.medRatio, JSON.stringify(p));
    check("paired: min and max", p.minDiff === -1 && p.maxDiff === 7);
    const q = paired([10, null, 30], [12, 5, 33]);
    check("paired: an unverified round is left out, not zero", q.n === 2 && q.medDiff === 2.5, JSON.stringify(q));
  }
  check("order: alternates A→B, B→A by round", [1, 2, 3, 4, 5, 6, 7].map((r) => order(r).join("")).join(",") === "AB,BA,AB,BA,AB,BA,AB");
  check("7 rounds", ROUNDS === 7);
  // ---- versions as integers (astra2: no float parsing)
  check("version: stable names parse", JSON.stringify(parseVersion("v0.10.2")?.map(String)) === '["0","10","2"]');
  for (const bad of ["v1.0.0-rc.1", "v1.0", "vbad", "v01.0.0", "1.0.0", "v1.0.0+b", "v1.0.0 ", "release-x"]) check(`version: ${JSON.stringify(bad)} is not stable`, parseVersion(bad) === null);
  check("version: integer order (0.10 > 0.9)", cmpVersion(parseVersion("v0.10.0"), parseVersion("v0.9.0")) > 0);
  check("version: no precision loss past 2^53", cmpVersion(parseVersion("v9007199254740993.0.0"), parseVersion("v9007199254740992.0.0")) > 0);
  // ---- the base rule on a fixture repository (CORR-INSTALL-R1-2)
  {
    const repo = join(tmp, "repo");
    mkdirSync(repo);
    const g = (...a) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", ...a], { cwd: repo, encoding: "utf8", env: { ...process.env, GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z", GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z" } }).trim();
    g("init", "-q", "-b", "main");
    const c = [];
    for (let i = 0; i <= 6; i++) {
      g("commit", "-q", "--allow-empty", "-m", `c${i}`);
      c.push(g("rev-parse", "HEAD"));
    }
    g("checkout", "-q", "-b", "side", c[3]);
    g("commit", "-q", "--allow-empty", "-m", "c7");
    const c7 = g("rev-parse", "HEAD");
    g("checkout", "-q", "main");
    g("tag", "v0.1.0", c[1]); // lightweight
    g("tag", "-a", "-m", "annotated", "v0.2.0", c[2]);
    g("tag", "v0.10.0", c[3]);
    g("tag", "release-x", c[3]); // a second name on the same commit, not a stable name
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "tag", "-a", "-m", "later", "v0.9.0", c[4]], { cwd: repo, env: { ...process.env, GIT_COMMITTER_DATE: "2026-06-01T00:00:00Z" } });
    g("tag", "v1.0.0-rc.1", c[5]);
    g("tag", "vbad", c[5]);
    g("tag", "v1.0", c[5]);
    g("tag", "v2.0.0", c7);
    const s6 = selectBase(repo, c[6]);
    check("base: version order beats string and date order", s6.tag === "v0.10.0" && s6.sha === c[3], JSON.stringify(s6).slice(0, 300));
    const why = Object.fromEntries(s6.considered.map((x) => [x.tag, x.reason]));
    check("base: an annotated tag is peeled and eligible", /eligible/.test(why["v0.2.0"]));
    check("base: a lightweight tag is eligible", /eligible/.test(why["v0.1.0"]));
    check("base: a later-dated lower version isn't chosen", why["v0.9.0"] === "eligible, but a higher version is");
    check("base: a prerelease is dropped", why["v1.0.0-rc.1"] === "not a stable vMAJOR.MINOR.PATCH name");
    check("base: malformed names are dropped", why["vbad"] === "not a stable vMAJOR.MINOR.PATCH name" && why["v1.0"] === "not a stable vMAJOR.MINOR.PATCH name" && why["release-x"] === "not a stable vMAJOR.MINOR.PATCH name");
    check("base: a non-ancestor is dropped", why["v2.0.0"] === "not an ancestor of the head");
    check("base: every tag is accounted for", s6.considered.length === 9, String(s6.considered.length));
    const s1 = resolveSides(repo, { headInput: c[1] });
    check("base: the head on a tag is an A/A", s1.base.tag === "v0.1.0" && s1.aa === true, JSON.stringify(s1.base));
    const s0 = resolveSides(repo, { headInput: c[0] });
    check("base: no eligible tag is 'unavailable', not invalid", !s0.invalid && s0.base.how === "default" && s0.base.unavailable === "no stable release tag is an ancestor of the head", JSON.stringify(s0.base));
    const spell = resolveSides(repo, { headInput: "main", baseInput: c[6] });
    check("A/A: decided by resolved SHAs, not spellings", spell.aa === true && spell.base.how === "input", JSON.stringify(spell).slice(0, 200));
    check("A/A: the aa input", resolveSides(repo, { headInput: "main", aaInput: "true" }).aa === true);
    check("label: rebuilt from the tag, never npm latest", /^rebuilt here from tag v0\.10\.0 \(commit [0-9a-f]{40}\)$/.test(resolveSides(repo, { headInput: "main" }).base.label));
    check("input: an option-looking head is refused", /^head: a ref that looks like an option/.test(resolveSides(repo, { headInput: "-x" }).invalid ?? ""));
    check("input: an option-looking base is refused", /^base: a ref that looks like an option/.test(resolveSides(repo, { headInput: "main", baseInput: "--upload-pack=y" }).invalid ?? ""));
    check("input: an unknown base is invalid, not 'no default base'", /^base: not a commit here/.test(resolveSides(repo, { headInput: "main", baseInput: "nope" }).invalid ?? ""));
    check("input: a non-boolean aa is refused", /^aa: not a boolean/.test(resolveSides(repo, { headInput: "main", aaInput: "yes" }).invalid ?? ""));
    check("input: whitespace in a ref is refused", resolveRef(repo, "main x").invalid !== undefined);
    const shallow = join(tmp, "shallow");
    execFileSync("git", ["clone", "-q", "--depth", "1", `file://${repo}`, shallow]);
    check("checkout: a shallow clone is refused", /shallow/.test(resolveSides(shallow, { headInput: "main" }).invalid ?? ""));
  }
  // ---- CPU affinity: chosen from the allowed set, not assumed
  check("affinity: CPU 1 when allowed", cpuChoice("Cpus_allowed_list:\t0-3\n", true).cpu === 1);
  check("affinity: the first allowed CPU otherwise", cpuChoice("Cpus_allowed_list:\t4,6-7\n", true).cpu === 4);
  check("affinity: not applied without taskset", cpuChoice("Cpus_allowed_list:\t0-3\n", false).cpu === null);
  // ---- the measured environment: an allowlist
  {
    const e = withEnv({ NODE_OPTIONS: "--require /x", NODE_DISABLE_COMPILE_CACHE: "1", NODE_V8_COVERAGE: "/x", SAGEBRUSH_NO_WORKER: "1", npm_config_ignore_scripts: "false" }, () => measuredEnv({ home: "/h", tmp: "/t", compileCache: "/c" }));
    check("env: exactly the allowlist", Object.keys(e).sort().join() === "HOME,LANG,NODE_COMPILE_CACHE,NODE_V8_COVERAGE,PATH,TMPDIR" && e.NODE_V8_COVERAGE === "", Object.keys(e).join());
  }
  // ---- the summary
  {
    const vals = (x) => ({ install: x, npx: x, versionCold: x, versionWarm: x, evalCold: x, evalWarm: x });
    const t = (x) => ({ values: vals(x), raw: { install: [x, x, x], npx: [x], versionCold: [x], versionWarm: [x, x, x, x, x], evalCold: [x], evalWarm: [x, x, x, x, x] }, cache: { version: { verified: true, problems: [] }, eval: { verified: true, problems: [] } } });
    const tree = (sha) => ({ version: "0.6.1", size: 1, unpackedSize: 2, tgzSha256: sha });
    const rec = { sides: { head: { input: "master", sha: "h".repeat(40) }, base: { label: "rebuilt here from tag v0.6.1 (commit b)" }, aa: false }, trees: { A: tree("a"), B: tree("b") }, env: { os: "linux", cpu: "x", cpus: 4, node: "24.21.0", npm: "11.19.0", affinity: { cpu: 1, allowed: "0-3", taskset: true } }, rounds: [1, 2, 3, 4, 5, 6, 7].map((r) => ({ round: r, first: r % 2 ? "base" : "head", A: t(100), B: t(110) })) };
    const s = summary(rec).join("\n");
    check("summary: the paired row", s.includes("| install (`npm install -g` from the tarball, median of 3) | 100.0 | 110.0 | +10.0 | 1.1000 | +10.0 … +10.0 |"), s.slice(0, 1500));
    check("summary: every raw sample", (s.match(/^\| \d \| (base|head) \| [AB] \| /gm) ?? []).length === 7 * 2 * 6);
    check("summary: the base label", s.includes("rebuilt here from tag v0.6.1"));
    check("summary: no A/A label on a real pair", !s.includes("A/A (noise)"));
    const aa = summary({ ...rec, sides: { ...rec.sides, aa: true } }).join("\n");
    check("summary: an A/A is labelled", aa.includes("**A/A (noise)**"));
    const alone = summary({ ...rec, sides: { ...rec.sides, base: { unavailable: "no stable release tag is an ancestor of the head" } }, trees: { B: tree("b") }, rounds: rec.rounds.map((r) => ({ ...r, A: undefined })) }).join("\n");
    check("summary: no base means no Δ column", alone.includes("| ms | head (median of rounds) |") && !alone.includes("median paired Δ"), alone.slice(0, 600));
    check("summary: same payloads flagged", summary({ ...rec, trees: { A: tree("z"), B: tree("z") } }).join("\n").includes("identical payloads"));
    check("summary: an invalid input", summary({ invalid: "base: a ref | `x`" }).join("\n").includes("invalid input: base: a ref \\| \\`x\\`"));
    check("summary: a failure keeps what came before", summary({ ...rec, failed: "measurement: boom" }).join("\n").includes("**failed at: measurement: boom**"));
    const unv = { ...rec, rounds: rec.rounds.map((r) => ({ ...r, B: { ...r.B, cache: { ...r.B.cache, eval: { verified: false, problems: ["the entry list changed after warm sample 2"] } } } })) };
    check("summary: an unverified cache is named", summary(unv).join("\n").includes("compile cache not verified (no time reported): round 1 B eval: the entry list changed after warm sample 2"));
  }
  // ---- the workflow's contract
  {
    const wf = readFileSync(join(root, ".github/workflows/install-timing.yml"), "utf8");
    const on = /\non:\n([\s\S]*?)\n(?=\S)/.exec(wf)?.[1] ?? "";
    const triggers = [...on.matchAll(/^  ([a-z_]+):/gm)].map((m) => m[1]).sort();
    check("contract: dispatch and schedule only", triggers.join() === "schedule,workflow_dispatch", triggers.join());
    check("contract: no pull_request or push anywhere", !/\b(pull_request|pull_request_target|push):/.test(wf));
    check("contract: contents read only", /\npermissions:\n  contents: read\n(?!  )/.test(wf));
    check("contract: measurements are never cancelled", /\nconcurrency:\n  group: install-timing-\$\{\{ github\.ref \}\}\n  cancel-in-progress: false\n/.test(wf));
    check("contract: full history and tags", /fetch-depth: 0\n\s+fetch-tags: true/.test(wf));
    const runs = [...wf.matchAll(/\n\s+run: (.*)/g)].map((m) => m[1]);
    check("contract: inputs reach run: only through env", runs.length >= 5 && runs.every((r) => !r.includes("${{")), runs.join(" / "));
    check("contract: the inputs are in env", /HEAD_INPUT: \$\{\{ inputs\.head \}\}/.test(wf) && /BASE_INPUT: \$\{\{ inputs\.base \}\}/.test(wf) && /AA_INPUT: \$\{\{ inputs\.aa \}\}/.test(wf));
    const outer = Number(/\n    timeout-minutes: (\d+)/.exec(wf)?.[1]);
    const steps = [...wf.matchAll(/\n        timeout-minutes: (\d+)/g)].map((m) => Number(m[1]));
    check("contract: the step timeouts fit the job's", steps.length === 3 && steps.reduce((a, b) => a + b, 0) + 5 <= outer, `${steps} vs ${outer}`);
    check("contract: the summary and upload always run", /name: the summary\n\s+if: always\(\)/.test(wf) && /upload-artifact@[0-9a-f]{40} # v4\.\d+\.\d+\n\s+if: always\(\)/.test(wf));
    check("contract: the same pins as checks", wf.includes('node-version: "24.21.0"') && wf.includes('bun-version: "1.4.4"'));
    const ci = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8");
    check("contract: these tests run in checks", ci.includes("node scripts/test-install-timing.mjs"));
  }
  // ---- a real smoke of every measure, under a hostile parent environment (§7)
  const pack = (pkgDir, out) => {
    mkdirSync(out, { recursive: true });
    const r = runNpm(["pack", "--json", "--ignore-scripts", "--workspaces=false", "--pack-destination", out], { cwd: pkgDir });
    if (r.reason) throw new Error(`npm pack: ${r.reason}`);
    const files = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")).files;
    const p = parsePack(r.stdout, files);
    if (p.reason) throw new Error(`npm pack: ${p.reason}`);
    return join(out, JSON.parse(r.stdout)[0].filename);
  };
  const hostile = (fn) => {
    const marker = join(tmp, "marker.cjs");
    writeFileSync(marker, 'process.stdout.write("HOSTILE-MARKER\\n");\n');
    return withEnv({ NODE_OPTIONS: `--require ${marker}`, NODE_DISABLE_COMPILE_CACHE: "1", NODE_COMPILE_CACHE: "/nonexistent", NODE_V8_COVERAGE: join(tmp, "cov"), SAGEBRUSH_NO_WORKER: "1", npm_config_ignore_scripts: "false", NPM_CONFIG_OFFLINE: "false" }, fn);
  };
  {
    const pkg = join(tmp, "tiny");
    mkdirSync(join(pkg, "bin"), { recursive: true });
    mkdirSync(join(pkg, "lib"));
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "sagebrush", version: "0.0.1", bin: { sagebrush: "bin/s.js" }, files: ["bin/s.js", "lib/m.js"] }));
    writeFileSync(join(pkg, "lib", "m.js"), "module.exports = 2;\n");
    // (TEST-140-R2-1: the shebang names a wrapper interpreter, found on PATH, that marks the
    // process and execs node; spawning node with the bin as an argument skips it, so only a
    // direct exec of the installed executable can print shebang=yes)
    const shebin = join(tmp, "shebang-bin");
    mkdirSync(shebin);
    writeFileSync(join(shebin, "tiny-shebang-node"), `#!/bin/sh\nexport TINY_VIA_SHEBANG=yes\nexec "${process.execPath}" "$@"\n`);
    chmodSync(join(shebin, "tiny-shebang-node"), 0o755);
    writeFileSync(join(pkg, "bin", "s.js"), `#!/usr/bin/env tiny-shebang-node
const two = require("../lib/m.js");
const via = " shebang=" + (process.env.TINY_VIA_SHEBANG ?? "no");
const dir = require("node:module").getCompileCacheDir?.() ?? "none";
const a = process.argv.slice(2);
if (a[0] === "--version") console.log("sagebrush 0.0.1 " + dir + via + " entry=" + process.argv[1]);
else if (a[0] === "-c") console.log(String(two + two) + " " + dir + " worker-env=" + (process.env.SAGEBRUSH_NO_WORKER ?? "absent") + via + " entry=" + process.argv[1]);
`);
    const tgz = pack(pkg, join(tmp, "tiny-pack"));
    const work = join(tmp, "tiny-work");
    const viaPath = (fn) => withEnv({ PATH: `${shebin}:${process.env.PATH}` }, fn);
    const r = viaPath(() => hostile(() => measureTree({ tgz, version: "0.0.1" }, { work })));
    const all = JSON.stringify(r.raw);
    check("smoke: every measure has a value", Object.values(r.values).every((x) => typeof x === "number" && x > 0), JSON.stringify(r.values));
    check("smoke: k samples", r.raw.install.length === 3 && r.raw.npx.length === 1 && r.raw.versionWarm.length === 5 && r.raw.evalWarm.length === 5);
    check("smoke: NODE_OPTIONS never reached a child", !all.includes("HOSTILE-MARKER"));
    check("smoke: the cold --version used its own cache directory", r.raw.versionColdStdout.startsWith(`sagebrush 0.0.1 ${r.cache.version.dir}`), r.raw.versionColdStdout);
    check("smoke: the warm --version used the same directory", r.raw.versionWarmStdout.startsWith(`sagebrush 0.0.1 ${r.cache.version.dir}`), r.raw.versionWarmStdout);
    check("smoke: the cold -c used its own directory", r.raw.evalColdStdout.startsWith(`4 ${r.cache.eval.dir}`), r.raw.evalColdStdout);
    check("smoke: npx used its own directory C", r.raw.npxStdout.startsWith(`sagebrush 0.0.1 ${r.cache.npx.dir}`), r.raw.npxStdout);
    check("smoke: the three cache directories differ", new Set([r.cache.version.dir, r.cache.eval.dir, r.cache.npx.dir]).size === 3);
    check("smoke: SAGEBRUSH_NO_WORKER never reached a child", r.raw.evalColdStdout.includes("worker-env=absent "), r.raw.evalColdStdout);
    // (MEASURE-140-2: the installed executable itself, through its shebang, as a user runs it)
    check("smoke: every startup sample ran the installed executable through its shebang", ["versionColdStdout", "versionWarmStdout", "evalColdStdout", "evalWarmStdout", "npxStdout"].every((k) => r.raw[k]?.includes(" shebang=yes ")), JSON.stringify([r.raw.versionColdStdout, r.raw.evalWarmStdout]));
    check("smoke: the installed bin is the entry point", typeof r.bin === "string" && r.bin.endsWith(join("bin", "sagebrush")) && r.raw.versionColdStdout.endsWith(`entry=${r.bin}`) && r.raw.evalWarmStdout.endsWith(`entry=${r.bin}`), `${r.bin} / ${r.raw.versionColdStdout}`);
    // (AUDIT-140-3: each measure's environment names are recorded)
    check("smoke: the measured env names are recorded", JSON.stringify(r.env?.version) === JSON.stringify(["HOME", "LANG", "NODE_COMPILE_CACHE", "NODE_V8_COVERAGE", "PATH", "TMPDIR"]) && JSON.stringify(r.env?.eval) === JSON.stringify(r.env?.version) && !!r.env?.install?.includes("npm_config_userconfig") && !!r.env?.install?.includes("npm_config_globalconfig") && !r.env?.install?.includes("NODE_COMPILE_CACHE") && !!r.env?.npx?.includes("NODE_COMPILE_CACHE"), JSON.stringify(r.env));
    check("smoke: npx's cache verified", r.cache.npx?.verified === true && r.cache.npx?.emptyBefore === true, JSON.stringify(r.cache.npx));
    check("smoke: complete, with diagnostics", r.incomplete === false && r.failed === null && typeof r.diagnostics?.versionWarmMedian === "number" && r.diagnostics?.evalWarmSpread >= 1, JSON.stringify(r.diagnostics));
    check("smoke: cold to warm verified (--version)", r.cache.version.verified && r.cache.version.emptyBefore && r.cache.version.afterCold > 0, JSON.stringify(r.cache.version));
    check("smoke: cold to warm verified (-c)", r.cache.eval.verified && r.cache.eval.afterCold > 0, JSON.stringify(r.cache.eval));
    check("smoke: no coverage written", !existsSync(join(tmp, "cov")), existsSync(join(tmp, "cov")) ? execFileSync("sh", ["-c", `ls ${join(tmp, "cov")} | head -3; head -c 400 ${join(tmp, "cov")}/*.json | tr -c '[:print:]' ' ' | grep -o 'file://[^"]*' | sort -u | head -5`], { encoding: "utf8" }) : "");
    rmSync(work, { recursive: true, force: true });
    check("smoke: the round's directories are removed", !existsSync(work));

    // ---- CORR-140-1 / STAT-140-1: an npx run that writes no compile cache is unavailable, not a time
    try {
    const fakebin = join(tmp, "fakebin");
    mkdirSync(fakebin);
    writeFileSync(join(fakebin, "npx"), "#!/bin/sh\necho sagebrush 0.0.1\n");
    chmodSync(join(fakebin, "npx"), 0o755);
    const nw = join(tmp, "npx-neg");
    const n = viaPath(() => measureTree({ tgz, version: "0.0.1" }, { work: nw, npx: join(fakebin, "npx") }));
    check("npx negative control: the cache is not verified", n.cache.npx.verified === false && n.cache.npx.problems.includes("empty after the run"), JSON.stringify(n.cache.npx));
    check("npx negative control: no npx value, raw kept", n.values.npx === null && n.raw.npx.length === 1 && n.raw.npx[0] > 0, JSON.stringify({ v: n.values.npx, raw: n.raw.npx }));
    check("npx negative control: the other measures still stand", typeof n.values.versionWarm === "number" && typeof n.values.install === "number");
    const good = r;
    const nrec = { sides: { head: { input: "h", sha: "h" }, base: { label: "b" }, aa: false }, trees: { A: { version: "0.0.1" }, B: { version: "0.0.1" } }, rounds: [{ round: 1, first: "base", incomplete: false, A: good, B: n }] };
    const ns = summary(nrec).join("\n");
    const npxRow = ns.split("\n").find((l) => l.startsWith("| npx first run"));
    check("npx negative control: no npx number or ratio in the summary", npxRow && /\| \d+\.\d \| {2}\| {2}\| {2}\| {2}… {2}\|$/.test(npxRow), npxRow);
    check("npx negative control: the summary names it", ns.includes("compile cache not verified (no time reported): round 1 B npx: empty after the run"), ns.slice(0, 1200));
    rmSync(nw, { recursive: true, force: true });
    } catch (e) {
      check("npx negative control: ran to completion", false, e.stack?.split("\n").slice(0, 2).join(" ") ?? String(e));
    }

    // ---- CORR-140-2: a failure keeps what was measured (mid-tree, and the second side after the first)
    try {
    const bpkg = join(tmp, "broken");
    mkdirSync(join(bpkg, "bin"), { recursive: true });
    mkdirSync(join(bpkg, "lib"));
    writeFileSync(join(bpkg, "package.json"), JSON.stringify({ name: "sagebrush", version: "0.0.1", bin: { sagebrush: "bin/s.js" }, files: ["bin/s.js", "lib/m.js"] }));
    writeFileSync(join(bpkg, "lib", "m.js"), "module.exports = 2;\n");
    writeFileSync(join(bpkg, "bin", "s.js"), `#!/usr/bin/env node
require("../lib/m.js");
if (process.argv[2] === "--version") console.log("sagebrush 0.0.1");
else { console.error("injected failure"); process.exit(3); }
`);
    const btgz = pack(bpkg, join(tmp, "broken-pack"));
    const bw = join(tmp, "broken-work");
    let thrown = null;
    try {
      measureTree({ tgz: btgz, version: "0.0.1" }, { work: bw });
    } catch (e) {
      thrown = e;
    }
    const bb = thrown?.block;
    check("mid-tree failure: thrown with its block", !!bb && bb.incomplete === true && /^eval \(cold\): exit 3: injected failure/.test(bb.failed ?? ""), bb?.failed ?? String(thrown));
    check("mid-tree failure: earlier samples kept", bb && bb.raw.install.length === 3 && bb.raw.npx.length === 1 && bb.raw.versionCold.length === 1 && bb.raw.versionWarm.length === 5 && bb.raw.evalCold.length === 0 && bb.values === null, JSON.stringify(bb?.raw));
    rmSync(bw, { recursive: true, force: true });
    const md2 = join(tmp, "measure-dir");
    mkdirSync(md2);
    writeFileSync(join(md2, "sides.json"), JSON.stringify({ head: { input: "h", sha: "h".repeat(40) }, base: { sha: "b".repeat(40), how: "input", label: "fixture" }, aa: false, considered: [] }));
    writeFileSync(join(md2, "tree-A.json"), JSON.stringify({ side: "A", version: "0.0.1", tgz, tgzSha256: "a" }));
    writeFileSync(join(md2, "tree-B.json"), JSON.stringify({ side: "B", version: "0.0.1", tgz: btgz, tgzSha256: "b" }));
    let mthrown = null;
    try {
      viaPath(() => measure(md2, { rounds: 1 }));
    } catch (e) {
      mthrown = e;
    }
    const mrec = JSON.parse(readFileSync(join(md2, "install-timing.json"), "utf8"));
    const r1 = mrec.rounds[0];
    check("second side fails: the run fails", !!mthrown && /^measurement: eval \(cold\)/.test(mrec.failed ?? ""), mrec.failed);
    check("warm-up: through the shebang too", (mrec.warmup?.A ?? "").includes(" shebang=yes "), mrec.warmup?.A);
    check("second side fails: the round is kept, marked incomplete", mrec.rounds.length === 1 && r1.incomplete === true && r1.first === "base");
    check("second side fails: the first side's complete block is kept", r1.A && r1.A.incomplete === false && typeof r1.A.values.versionWarm === "number" && r1.A.raw.evalWarm.length === 5, JSON.stringify(r1.A?.values));
    check("second side fails: the second side's samples are kept", r1.B && r1.B.incomplete === true && r1.B.raw.install.length === 3 && r1.B.raw.versionWarm.length === 5 && /eval \(cold\)/.test(r1.B.failed), JSON.stringify(r1.B?.raw));
    check("measured env names in the record", JSON.stringify(mrec.env.measuredEnvNames.cli) === JSON.stringify(["HOME", "LANG", "NODE_COMPILE_CACHE", "NODE_V8_COVERAGE", "PATH", "TMPDIR"]) && mrec.env.measuredEnvNames.npm.includes("npm_config_userconfig") && !mrec.env.measuredEnvNames.npm.includes("NODE_COMPILE_CACHE"), JSON.stringify(mrec.env.measuredEnvNames));
    const ms = summary(mrec).join("\n");
    const irow = ms.split("\n").find((l) => l.startsWith("| install"));
    check("incomplete round: excluded from the aggregates", irow && /^\| install [^|]+\| {2}\| {2}\| {2}\| {2}\| {2}… {2}\|$/.test(irow), irow);
    check("incomplete round: named, with the failure", ms.includes("round 1 is incomplete: excluded from the aggregates") && ms.includes("round 1 head failed: eval (cold)") && ms.includes("| 1 | base | B (incomplete) | install |"), ms.slice(0, 1500));
    check("diagnostics: the warm median and spread are shown", /\| 1 \| A \| [\d.]+ \/ [\d.]+ \/ ×[\d.]+ \| [\d.]+ \/ [\d.]+ \/ ×[\d.]+ \| ×[\d.]+ \|/.test(ms), ms.slice(ms.indexOf("diagnostics"), ms.indexOf("diagnostics") + 600));
    } catch (e) {
      check("failure handling: ran to completion", false, e.stack?.split("\n").slice(0, 2).join(" ") ?? String(e));
    }
  }
  // ---- the real CLI, where the bundle is built (the checks job): this Node's compile cache
  {
    const dist = join(root, "packages", "sagebrush", "dist", "sagebrush.cjs");
    if (!existsSync(dist)) {
      check("real CLI: the bundle is built in CI", !process.env.GITHUB_ACTIONS, "packages/sagebrush/dist/sagebrush.cjs is missing");
      console.log("real CLI: skipped (no build here)");
    } else {
      const version = JSON.parse(readFileSync(join(root, "packages", "sagebrush", "package.json"), "utf8")).version;
      const tgz = pack(join(root, "packages", "sagebrush"), join(tmp, "real-pack"));
      const work = join(tmp, "real-work");
      const r = hostile(() => measureTree({ tgz, version }, { work }));
      check("real CLI: -c prints 4 (the worker path)", r.raw.evalColdStdout === "4" && r.raw.evalWarmStdout === "4", `${r.raw.evalColdStdout} / ${r.raw.evalWarmStdout}`);
      check("real CLI: cold to warm verified (--version)", r.cache.version.verified, JSON.stringify(r.cache.version));
      check("real CLI: cold to warm verified (-c)", r.cache.eval.verified, JSON.stringify(r.cache.eval));
      console.log(`real CLI on node ${process.versions.node}: ${JSON.stringify({ values: r.values, cache: { version: { afterCold: r.cache.version.afterCold, verified: r.cache.version.verified }, eval: { afterCold: r.cache.eval.afterCold, verified: r.cache.eval.verified }, npx: r.cache.npx.entries } })}`);
      rmSync(work, { recursive: true, force: true });
    }
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
console.log(`install-timing: ${passed} passed, ${failures} failed`);
if (failures) process.exit(1);
