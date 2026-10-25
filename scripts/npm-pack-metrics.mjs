// The npm package's own size, as `npm install sagebrush` sees it: packed and
// unpacked bytes and the entry count from `npm pack --dry-run --json`, next to
// the growth gate and never part of it (plan-npm-pack-metrics-r3).  Report-only:
// a failure here is a recorded "unavailable" reason, never a failed gate; the
// gate's script, records and key are untouched.
//   node scripts/npm-pack-metrics.mjs --record --out F [--root DIR]     checks: the merge's npm-pack.json
//   node scripts/npm-pack-metrics.mjs --base --records DIR [--root B]   size-base: base-npm-pack.json (B: the rebuilt base)
//   node scripts/npm-pack-metrics.mjs --report --merge F --base F [--mode M]   size-gate: the summary table
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { jcs, sha256, strictParse } from "./size-measure.mjs";

const SELF = fileURLToPath(import.meta.url);
const root = join(dirname(SELF), "..");
export const FORMAT = "sagebrush-npm-pack";
export const PACKAGE = "sagebrush";
// (input-envelope caps on npm's output and the record, not size thresholds)
export const CAPS = { files: 64, path_chars: 256, output_bytes: 4 * 1024 * 1024, record_bytes: 256 * 1024, reason_chars: 200 };
export const TIMEOUT_MS = 60_000;
export const ARGS = ["pack", "--dry-run", "--json", "--ignore-scripts", "--workspaces=false"];

const isNat = (v) => Number.isSafeInteger(v) && v >= 0;
const clip = (s) => String(s).replace(/[\u0000-\u001f\u007f]+/g, " ").slice(0, CAPS.reason_chars);
const why = (reason, value) => ({ reason: value === undefined ? reason : `${reason}: ${clip(value)}` });

// A package.json "files" entry the membership check can take literally, or why not
// (a directory or glob would need npm's own semantics: unavailable, never misread)
export function literalEntryProblem(entry, pkgDir) {
  if (typeof entry !== "string" || !entry || entry.endsWith("/") || /[*?[\]{}!]/.test(entry) || entry.startsWith("./") || entry.split("/").includes("..")) return entry;
  try {
    if (statSync(join(pkgDir, entry)).isDirectory()) return entry;
  } catch {}
  return null;
}

// npm's JSON, checked: {size, unpackedSize, entryCount, files} or {reason}
export function parsePack(text, pkgFiles) {
  let out;
  try {
    out = strictParse(text);
  } catch (e) {
    return why("npm output is not JSON", e.message);
  }
  if (!Array.isArray(out) || out.length !== 1) return why("npm output is not exactly one package", Array.isArray(out) ? `${out.length} elements` : typeof out);
  const p = out[0];
  if (!p || typeof p !== "object" || p.name !== PACKAGE) return why("npm packed another package", p?.name);
  for (const k of ["size", "unpackedSize", "entryCount"]) if (!isNat(p[k])) return why(`npm's ${k} is not a non-negative safe integer`, p[k]);
  if (!Array.isArray(p.files)) return why("npm output has no files list");
  if (p.files.length > CAPS.files) return why(`more than ${CAPS.files} files`, p.files.length);
  if (p.entryCount !== p.files.length) return why("entryCount is not the number of files", `${p.entryCount} vs ${p.files.length}`);
  const files = [], seen = new Set();
  let sum = 0;
  for (const f of p.files) {
    if (!f || typeof f.path !== "string" || !f.path || f.path.length > CAPS.path_chars || /[\u0000-\u001f\u007f]/.test(f.path)) return why("a bad file path", f?.path);
    if (!isNat(f.size)) return why(`a bad file size for ${clip(f.path)}`, f.size);
    if (seen.has(f.path)) return why("a duplicate path", f.path);
    seen.add(f.path);
    sum += f.size;
    files.push([f.path, f.size]);
  }
  if (sum !== p.unpackedSize) return why("the file sizes don't sum to unpackedSize", `${sum} vs ${p.unpackedSize}`);
  for (const e of pkgFiles) if (!seen.has(e)) return why("missing from the pack", e);
  files.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return { size: p.size, unpackedSize: p.unpackedSize, entryCount: p.entryCount, files };
}

// The child's environment: every npm_config_* (any case) removed, then the user
// and global configs pointed at two distinct empty files (npm 11 refuses one
// file loaded as both)
export function npmEnv(env, userconfig, globalconfig) {
  const out = {};
  for (const [k, v] of Object.entries(env)) if (!/^npm_config_/i.test(k)) out[k] = v;
  out.npm_config_userconfig = userconfig;
  out.npm_config_globalconfig = globalconfig;
  return out;
}
export function isolationProblem(a, b) {
  if (a === b) return "the same path";
  let ra, rb;
  try {
    ra = realpathSync(a);
    rb = realpathSync(b);
  } catch (e) {
    return `not readable (${e.code ?? e.message})`;
  }
  if (ra === rb) return "the same file";
  for (const f of [a, b]) {
    const s = lstatSync(f);
    if (!s.isFile() || s.size !== 0) return `${f} is not an empty regular file`;
  }
  return null;
}

// Run npm with the exact arguments in `cwd`: {stdout} or {reason}
export function runNpm(args, { cwd, env = process.env, npm = "npm", timeoutMs = TIMEOUT_MS, configs } = {}) {
  const tmp = configs ? null : mkdtempSync(join(tmpdir(), "npm-pack-metrics-"));
  try {
    const [u, g] = configs ?? [join(tmp, "userconfig"), join(tmp, "globalconfig")];
    if (!configs) for (const f of [u, g]) writeFileSync(f, "");
    const iso = isolationProblem(u, g);
    if (iso) return why("npm config isolation failed", iso);
    const r = spawnSync(npm, args, { cwd, env: npmEnv(env, u, g), encoding: "utf8", timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: CAPS.output_bytes, stdio: ["ignore", "pipe", "pipe"] });
    if (r.error?.code === "ENOENT") return why("npm not found");
    // (only spawnSync's own deadline is a timeout; a signal from anywhere else is npm failing)
    if (r.error?.code === "ETIMEDOUT") return why(`npm timed out after ${timeoutMs} ms`);
    if (r.error?.code === "ENOBUFS") return why(`npm output over ${CAPS.output_bytes} bytes`);
    if (r.error) return why("npm failed to run", r.error.message);
    if (r.status !== 0) return why(`npm exited ${r.status ?? r.signal}`, (r.stderr || "").trim().split("\n").pop());
    return { stdout: r.stdout };
  } finally {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  }
}

// Pack `pkgDir`: the measurement, or {reason}; and the key it was made under
export function packDir(pkgDir, opts = {}) {
  const key = { npm: null, node: process.version.replace(/^v/, ""), script_sha256: sha256(readFileSync(SELF)) };
  // (before any npm invocation: npm would load it from this directory even for --version)
  if (existsSync(join(pkgDir, ".npmrc"))) return { key, ...why("project npmrc present") };
  const v = runNpm(["--version"], { ...opts, cwd: pkgDir });
  if (v.reason) return { key, ...v };
  key.npm = v.stdout.trim();
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
  } catch (e) {
    return { key, ...why("package.json unreadable", e.message) };
  }
  const entries = Array.isArray(pkg.files) ? pkg.files : [];
  for (const e of entries) {
    const bad = literalEntryProblem(e, pkgDir);
    if (bad !== null) return { key, ...why("package.json files entry is not a literal file path", bad) };
  }
  const r = runNpm(ARGS, { ...opts, cwd: pkgDir });
  if (r.reason) return { key, ...r };
  return { key, ...parsePack(r.stdout, entries) };
}

export function makeRecord({ commit, tree, run, m }) {
  const base = { format: FORMAT, v: 1, commit, tree, run, key: m.key };
  if (m.reason) return { ...base, unavailable: clip(m.reason) };
  return { ...base, size: m.size, unpackedSize: m.unpackedSize, entryCount: m.entryCount, files: m.files };
}

// Why a record can't be used, or []
export function recordProblems(rec) {
  if (!rec || typeof rec !== "object" || Array.isArray(rec)) return ["not a record"];
  const p = [];
  if (rec.format !== FORMAT || rec.v !== 1) p.push(`format ${clip(rec.format)} v${clip(rec.v)}, not ${FORMAT} v1`);
  if (typeof rec.commit !== "string" || typeof rec.tree !== "string") p.push("no commit or tree");
  if (!rec.run || typeof rec.run !== "object") p.push("no run");
  if (rec.unavailable !== undefined) {
    if (typeof rec.unavailable !== "string") p.push("a bad unavailable reason");
    return p;
  }
  const k = rec.key;
  if (!k || typeof k.npm !== "string" || typeof k.node !== "string" || typeof k.script_sha256 !== "string") p.push("no comparability key");
  for (const f of ["size", "unpackedSize", "entryCount"]) if (!isNat(rec[f])) p.push(`${f} is not a non-negative safe integer`);
  if (!Array.isArray(rec.files) || rec.files.length > CAPS.files) return [...p, "no files, or too many"];
  const seen = new Set();
  let sum = 0;
  for (const t of rec.files) {
    if (!Array.isArray(t) || t.length !== 2 || typeof t[0] !== "string" || !t[0] || t[0].length > CAPS.path_chars || /[\u0000-\u001f\u007f]/.test(t[0]) || !isNat(t[1])) return [...p, "a bad file tuple"];
    if (seen.has(t[0])) return [...p, "a duplicate path"];
    seen.add(t[0]);
    sum += t[1];
  }
  if (rec.entryCount !== rec.files.length) p.push("entryCount is not the number of files");
  if (sum !== rec.unpackedSize) p.push("the file sizes don't sum to unpackedSize");
  return p;
}

// A record file: the record, or {unavailable} saying why it can't be used
export function readRecord(path) {
  if (!path || !existsSync(path)) return { unavailable: "no npm-pack record" };
  try {
    const n = statSync(path).size;
    if (n > CAPS.record_bytes) return { unavailable: `the npm-pack record is ${n} bytes, over ${CAPS.record_bytes}` };
    const rec = strictParse(readFileSync(path, "utf8"));
    const p = recordProblems(rec);
    if (p.length) return { unavailable: clip(`a malformed npm-pack record: ${p.join("; ")}`) };
    // (a record-supplied reason is held to the wrapper's own envelope)
    return rec.unavailable === undefined ? rec : { ...rec, unavailable: clip(rec.unavailable) };
  } catch (e) {
    return { unavailable: clip(`a malformed npm-pack record: ${e.message}`) };
  }
}

// The fetched base companion, bound to the base's validated size record
export function bindFetched(sizesRec, npmRec) {
  if (npmRec.format === undefined) return npmRec.unavailable === "no npm-pack record" ? { unavailable: "n/a (the base's record predates npm-pack metrics)" } : npmRec;
  for (const f of ["commit", "tree"]) if (sizesRec?.[f] !== npmRec[f]) return { unavailable: `the base's npm-pack record names another ${f}` };
  if (jcs(sizesRec?.run ?? null) !== jcs(npmRec.run ?? null)) return { unavailable: "the base's npm-pack record names another run" };
  return npmRec;
}

// Markdown, escaped: never a table break, a link, HTML or code
export const md = (s) => String(s).replace(/[\r\n]+/g, " ").replace(/[|`<>[\]\\]/g, (c) => `\\${c}`);
const num = (n) => n.toLocaleString("en-US");
const signed = (n) => (n > 0 ? `+${num(n)}` : n < 0 ? `−${num(-n)}` : "0");

export function report(merge, base, mode) {
  const L = ["## npm package (report-only, plan-npm-pack-metrics-r3)", ""];
  const avail = (r) => r && r.unavailable === undefined && r.format === FORMAT;
  if (!avail(merge)) return [...L, `merge: unavailable: ${md(merge?.unavailable ?? "no npm-pack record")}`, ""];
  const b = mode === "absolute" ? { unavailable: "no base (absolute run)" } : base;
  const comparable = avail(b) && jcs(b.key) === jcs(merge.key);
  L.push("| npm package | base | merge | Δ |", "|---|---:|---:|---:|");
  for (const [label, k] of [["packed (`size`)", "size"], ["unpacked (`unpackedSize`)", "unpackedSize"], ["entries", "entryCount"]]) {
    const bv = avail(b) ? num(b[k]) : "n/a";
    L.push(`| ${label} | ${bv} | ${num(merge[k])} | ${comparable ? signed(merge[k] - b[k]) : ""} |`);
  }
  L.push("");
  if (!avail(b)) L.push(`- base: ${md(b?.unavailable ?? "no npm-pack record")}`);
  else if (!comparable) L.push(`- not comparable: key differs (base ${md(jcs(b.key))}, merge ${md(jcs(merge.key))})`);
  else {
    const bm = new Map(b.files), mm = new Map(merge.files);
    const changed = [...new Set([...bm.keys(), ...mm.keys()])].sort().filter((p) => bm.get(p) !== mm.get(p));
    for (const p of changed.slice(0, 20)) L.push(`- ${md(p)}: ${bm.has(p) ? num(bm.get(p)) : "absent"} → ${mm.has(p) ? num(mm.get(p)) : "absent"}`);
    if (changed.length > 20) L.push(`- and ${changed.length - 20} more changed files`);
    if (!changed.length) L.push("- no file changed size");
  }
  L.push(`- key: ${md(jcs(merge.key))}`);
  L.push("- (CI packs with the npm bundled with the pinned Node; a release publishes with npm@latest, so the published `size` can differ by compressor and tar-header differences; `unpackedSize` and the entry count agree only when both pack the same files with the same bytes)");
  return [...L, ""];
}

function identity(dir) {
  const g = (...a) => execFileSync("git", a, { cwd: dir, encoding: "utf8" }).trim();
  return { commit: g("rev-parse", "HEAD"), tree: g("rev-parse", "HEAD^{tree}"), run: { id: process.env.GITHUB_RUN_ID ?? null, attempt: process.env.GITHUB_RUN_ATTEMPT ?? null, job: process.env.GITHUB_JOB ?? null } };
}
const arg = (n) => {
  const i = process.argv.indexOf(n);
  return i > 0 ? process.argv[i + 1] : undefined;
};
function recordAt(dir, out) {
  const rec = makeRecord({ ...identity(dir), m: packDir(join(dir, "packages", PACKAGE)) });
  writeFileSync(out, JSON.stringify(rec) + "\n");
  console.log(rec.unavailable ? `npm package metrics unavailable: ${rec.unavailable}` : `npm package ${rec.commit.slice(0, 12)}: ${rec.size} B packed, ${rec.unpackedSize} B unpacked, ${rec.entryCount} entries, key ${jcs(rec.key)}`);
}

function cli() {
  const mode = process.argv[2];
  if (mode === "--record") return recordAt(arg("--root") ?? root, arg("--out"));
  if (mode === "--base") {
    const dir = arg("--records"), out = join(dir, "base-npm-pack.json");
    if (arg("--root")) return recordAt(arg("--root"), out);
    const sizesPath = join(dir, "base-record.json");
    if (!existsSync(sizesPath)) return console.log("no base size record: no base npm-pack record");
    let bound;
    try {
      bound = bindFetched(strictParse(readFileSync(sizesPath, "utf8")), readRecord(join(dir, "fetched", "npm-pack.json")));
    } catch (e) {
      bound = { unavailable: clip(`the base size record is unreadable: ${e.message}`) };
    }
    const rec = bound.format === FORMAT ? bound : { format: FORMAT, v: 1, commit: "", tree: "", run: {}, key: null, unavailable: bound.unavailable };
    writeFileSync(out, JSON.stringify(rec) + "\n");
    return console.log(rec.unavailable ? `base npm package metrics: ${rec.unavailable}` : `base npm package: the fetched record of ${rec.commit.slice(0, 12)}`);
  }
  if (mode === "--report") {
    let lines;
    try {
      lines = report(readRecord(arg("--merge")), readRecord(arg("--base")), arg("--mode"));
    } catch (e) {
      lines = ["## npm package (report-only)", "", `unavailable: ${md(clip(e.message))}`, ""];
    }
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join("\n") + "\n");
    return console.log(lines.join("\n"));
  }
  console.error("usage: npm-pack-metrics.mjs --record|--base|--report (see the header)");
  process.exit(2);
}

if (process.argv[1] === SELF) cli();
