#!/usr/bin/env node
// The core's growth gate (plan-growth-budget-r6; it replaces the exact
// totals of size-budget.json, plan-modular-packages-r4 §7.2).  This file is
// the whole measurement: its sha256 is part of every size record's
// comparability key (r5 §1.1), so any change to how bytes are counted or
// normalized makes records made before it incomparable.
//
// What it guards (r5 §0): no core growth beyond reviewed markers (and a
// configured jitter, 0 today), and no growth of an optional package's way
// into the core.  budgets.json holds every size threshold; .growth/*.json are
// the reviewed growth markers.
//
//   node scripts/size-measure.mjs --record --out F [--root DIR]   measure a build: a size record
//   node scripts/size-measure.mjs --census [--root DIR]           the metadata assignments a build has (to review EXPECTED_COUNTS)
//   node scripts/size-measure.mjs --legacy --root DIR --out F     that build measured by DIR's own size-budget.mjs (the bootstrap cross-check)
//   node scripts/size-measure.mjs --resolve-base                  CI (size-base): the tested base, and its record if one is usable
//   node scripts/size-measure.mjs --gate --records DIR            CI (size-gate): apply the rules
//   node scripts/size-measure.mjs --epoch --records DIR --reason R [--map F]   write an epoch reset (r5 §1.3 rule 5)
//
// It reads builds; it builds nothing.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SELF = fileURLToPath(import.meta.url);
const root = join(dirname(SELF), "..");
export const REPO = "sagemathinc/sagebrush";
export const RECORD_FORMAT = "sagebrush-size-record";
export const BUDGETS_FORMAT = "sagebrush-budgets";

// ---------------------------------------------------------------------------
// Strict JSON: duplicate keys refused, and numbers only as integer literals
// (no "1.0", "1e3", "1.5"); budgets and markers hold no other kind (r5 §1.4).

export const MAX_DEPTH = 16;
// Hard caps on the gate's inputs, checked before anything is read in full or
// parsed (LIMIT-GATE95-2): a record, budgets.json and a marker by bytes; the
// markers by count and total bytes; and, inside them, strings and collections.
// (Input-envelope limits, versioned with this file; not size thresholds,
// which budgets.json owns.)
export const LIMITS = {
  record_bytes: 256 * 1024,
  budgets_bytes: 256 * 1024,
  legacy_bytes: 256 * 1024,
  marker_bytes: 4096,
  markers: 256,
  markers_total_bytes: 256 * 1024,
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
// A deep copy with null-prototype objects: a key such as "__proto__" or
// "constructor" is then only ever an own property, never something inherited
// (CORR-GATE95-3).  The rules look names up in these copies only.
export function bare(v) {
  if (Array.isArray(v)) return v.map(bare);
  if (v === null || typeof v !== "object") return v;
  const out = Object.create(null);
  for (const k of Object.keys(v)) out[k] = bare(v[k]);
  return out;
}
export const sha256 = (data) => createHash("sha256").update(data).digest("hex");
export const epochHash = (epoch) => sha256(jcs(epoch));

const isNat = (n) => Number.isSafeInteger(n) && n >= 0;
const isPos = (n) => Number.isSafeInteger(n) && n > 0;
const nonEmpty = (s) => typeof s === "string" && s.trim() !== "";
// a sum that stays a safe integer, or null (r5 §1.3 rule 5: a sum leaving the range fails)
export function safeSum(values) {
  let t = 0;
  for (const v of values) {
    t += v;
    if (!Number.isSafeInteger(t)) return null;
  }
  return t;
}

// ---------------------------------------------------------------------------
// Measurement (r5 §1.2, §1.6)

// The two generated values neutralized, and nothing else: each found only as
// its assignment, with the known value.  Each occurrence counts as
// NEUTRAL_WIDTH bytes, whatever the value's width.
export const NEUTRAL_WIDTH = 16;
export const ASSIGNMENTS = ["VERSION", "BUILD_ID"];
// How many of each assignment each bundle has: reviewed constants, never read
// from the build being measured (--census prints a build's, for review).  A bundle not listed has none.  A count that
// differs fails the measurement, so a new occurrence can't hide.  (Changing
// one changes this file's sha256: a measurement move, r5 §1.3 rule 5.)
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
  const reg = JSON.parse(readFileSync(join(rootDir, "packages", "registry.json"), "utf8"));
  return { files, extra: { "registry/packages": Object.keys(reg.packages).length } };
}

export async function measure(rootDir) {
  const { files, extra } = buildFiles(rootDir);
  return measureFiles(files, rootDir, await stampedValues(rootDir), extra);
}

// ---------------------------------------------------------------------------
// Records (r5 §1.1)

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

// Why a record can't be used for `commit`, or [] (r5 §1.1: an error, never a zero baseline)
export function recordProblems(rec, commit) {
  const p = [];
  if (!rec || typeof rec !== "object") return ["not a record"];
  if (rec.format !== RECORD_FORMAT || rec.v !== 1) p.push(`format ${rec.format} v${rec.v}, not ${RECORD_FORMAT} v1`);
  if (rec.repo !== REPO) p.push(`repo ${rec.repo}, not ${REPO}`);
  if (commit !== undefined && rec.commit !== commit) p.push(`commit ${rec.commit}, not ${commit}`);
  if (!rec.key || typeof rec.key.measure_sha256 !== "string" || typeof rec.key.bun !== "string" || typeof rec.key.node !== "string") p.push("no comparability key");
  if (!Array.isArray(rec.bundles) || !rec.sizes || typeof rec.sizes !== "object") return [...p, "no bundles or sizes"];
  if (rec.bundles.length > LIMITS.entries || rec.bundles.some(longString)) return [...p, `more than ${LIMITS.entries} bundles, or a name over ${LIMITS.string_chars} characters`];
  const listed = [...rec.bundles].sort(), keys = Object.keys(rec.sizes).sort();
  if (new Set(listed).size !== listed.length) p.push("a bundle is listed twice");
  if (jcs(listed) !== jcs(keys)) p.push("sizes don't have exactly the listed bundles");
  for (const [k, v] of Object.entries(rec.sizes)) if (!isNat(v)) p.push(`${k}: ${v} is not a non-negative safe integer`);
  if (rec.neutral !== undefined) for (const [k, v] of Object.entries(rec.neutral)) if (!Number.isSafeInteger(v)) p.push(`${k}: neutral ${v} is not a safe integer`);
  return p;
}

// ---------------------------------------------------------------------------
// budgets.json and markers (r5 §1.3, §1.4, §2.2)

const RESET_KEYS = ["reason", "prev", "growth", "map", "added", "removed"];
export function budgetsProblems(b) {
  const p = [];
  if (!b || typeof b !== "object" || Array.isArray(b)) return ["budgets.json is not an object"];
  for (const k of Object.keys(b)) if (!["format", "v", "note", "toolchain", "bundles", "epoch"].includes(k)) p.push(`budgets.json: unknown key ${k}`);
  if (b.format !== BUDGETS_FORMAT || b.v !== 1) p.push(`budgets.json: format ${b.format} v${b.v}, not ${BUDGETS_FORMAT} v1`);
  if (!b.toolchain || !nonEmpty(b.toolchain.bun) || Object.keys(b.toolchain).length !== 1) p.push("budgets.json: toolchain must be {bun}");
  if (!b.bundles || typeof b.bundles !== "object" || !Object.keys(b.bundles).length) return [...p, "budgets.json: no bundles"];
  if (Object.keys(b.bundles).length > LIMITS.entries) return [...p, `budgets.json: more than ${LIMITS.entries} bundles`];
  for (const k of Object.keys(b.bundles)) if (longString(k)) return [...p, `budgets.json: a bundle name over ${LIMITS.string_chars} characters`];
  if (longString(b.note) || longString(b.toolchain?.bun)) p.push(`budgets.json: a string over ${LIMITS.string_chars} characters`);
  for (const [k, e] of Object.entries(b.bundles)) {
    if (!e || typeof e !== "object") {
      p.push(`${k}: not an object`);
      continue;
    }
    if (e.exact === true) {
      if (jcs(Object.keys(e).sort()) !== jcs(["exact", "max"])) p.push(`${k}: an exact bundle has exactly {exact, max}`);
      if (!isNat(e.max)) p.push(`${k}: max must be a non-negative safe integer`);
    } else if (e.exact === false) {
      if (jcs(Object.keys(e).sort()) !== jcs(["ceiling", "exact", "marker_slack", "noise_bytes", "noise_total"])) p.push(`${k}: a bundle has exactly {exact, ceiling, noise_bytes, noise_total, marker_slack}`);
      for (const f of ["ceiling", "noise_bytes", "noise_total", "marker_slack"]) if (!isNat(e[f])) p.push(`${k}: ${f} must be a non-negative safe integer`);
    } else p.push(`${k}: exact must be true or false`);
  }
  const ep = b.epoch;
  if (!ep || typeof ep !== "object" || jcs(Object.keys(ep).sort()) !== jcs(["reset", "sizes"])) return [...p, "budgets.json: epoch must be exactly {sizes, reset}"];
  const nonExact = Object.keys(b.bundles).filter((k) => b.bundles[k]?.exact === false).sort();
  if (!ep.sizes || jcs(Object.keys(ep.sizes).sort()) !== jcs(nonExact)) p.push("epoch.sizes must name exactly the non-exact bundles");
  else
    for (const k of nonExact) {
      if (!isNat(ep.sizes[k])) p.push(`epoch.sizes.${k} must be a non-negative safe integer`);
      else if (isNat(b.bundles[k].ceiling) && b.bundles[k].ceiling < ep.sizes[k]) p.push(`${k}: ceiling ${b.bundles[k].ceiling} < epoch ${ep.sizes[k]}`);
    }
  if (ep.reset !== null) p.push(...resetShapeProblems(ep.reset));
  return p;
}
function resetShapeProblems(r) {
  const p = [];
  if (!r || typeof r !== "object" || Array.isArray(r)) return ["epoch.reset must be null or an object"];
  if (jcs(Object.keys(r).sort()) !== jcs([...RESET_KEYS].sort())) p.push(`epoch.reset has exactly {${RESET_KEYS.join(", ")}}`);
  if (!nonEmpty(r.reason)) p.push("epoch.reset.reason is empty");
  else if (longString(r.reason)) p.push(`epoch.reset.reason is over ${LIMITS.string_chars} characters`);
  for (const f of ["map", "added", "removed"]) if (Array.isArray(r[f]) && r[f].length > LIMITS.entries) p.push(`epoch.reset.${f} has more than ${LIMITS.entries} entries`);
  if (r.growth && typeof r.growth === "object" && Object.keys(r.growth).length > LIMITS.entries) p.push(`epoch.reset.growth has more than ${LIMITS.entries} entries`);
  if (typeof r.prev !== "string" || !/^[0-9a-f]{64}$/.test(r.prev)) p.push("epoch.reset.prev must be a sha256");
  if (!r.growth || typeof r.growth !== "object" || Array.isArray(r.growth)) p.push("epoch.reset.growth must be an object");
  else for (const [g, v] of Object.entries(r.growth)) if (!isPos(v)) p.push(`epoch.reset.growth.${g}: ${v} is not a positive safe integer`);
  if (!Array.isArray(r.map)) p.push("epoch.reset.map must be a list");
  else
    for (const e of r.map)
      if (!e || jcs(Object.keys(e).sort()) !== jcs(["new", "old"]) || !Array.isArray(e.old) || !Array.isArray(e.new) || !e.old.length || !e.new.length || ![...e.old, ...e.new].every(nonEmpty))
        p.push("epoch.reset.map entries are {old: [keys], new: [keys]}, both non-empty");
  for (const f of ["added", "removed"]) if (!Array.isArray(r[f]) || !r[f].every(nonEmpty)) p.push(`epoch.reset.${f} must be a list of keys`);
  return p;
}

// A marker's {bytes}, or its problems (r5 §1.4)
export function parseMarker(text, budgetsIn) {
  const budgets = bare(budgetsIn);
  const over = overCap("the marker", Buffer.byteLength(text ?? ""), LIMITS.marker_bytes);
  if (over) return { problems: [over] };
  let m;
  try {
    m = strictParse(text);
  } catch (e) {
    return { problems: [`not strict JSON: ${e.message}`] };
  }
  const p = [];
  if (!m || typeof m !== "object" || Array.isArray(m)) return { problems: ["not an object"] };
  if (jcs(Object.keys(m).sort()) !== jcs(["bytes", "reason", "v"])) p.push("a marker has exactly {v, reason, bytes}");
  if (m.v !== 1) p.push("v must be 1");
  if (!nonEmpty(m.reason)) p.push("the reason is empty");
  else if (longString(m.reason)) p.push(`the reason is over ${LIMITS.string_chars} characters`);
  if (!m.bytes || typeof m.bytes !== "object" || Array.isArray(m.bytes) || !Object.keys(m.bytes).length) p.push("bytes must name at least one bundle");
  else
    for (const [k, v] of Object.entries(m.bytes)) {
      const e = budgets?.bundles?.[k];
      if (!e) p.push(`${k}: not a bundle in budgets.json`);
      else if (e.exact) p.push(`${k}: an exact bundle can't be named by a marker (r5 §1.3 rule 1)`);
      if (!isPos(v)) p.push(`${k}: ${v} is not a positive safe integer`);
    }
  return p.length ? { problems: p } : { bytes: m.bytes, problems: [] };
}

// ---------------------------------------------------------------------------
// The rules (r5 §1.2, §1.3), as a function of the inputs CI gathers

const fmt = (n) => (n > 0 ? `+${n}` : String(n));

/**
 * mode: "transition" (one integration: a pull request, a merge-queue entry,
 *   a protocol push), "range" (a push with k > 1 first-parent transitions),
 *   or "absolute" (schedule, dispatch, a first push).
 * merge: {record, budgets, markers: [{path, text}]}: the tested commit, and every .growth/*.json in its tree
 * base:  {record, budgets, declaredKey}: the base measured under the merge's key (N);
 *        its budgets.json (null: the bootstrap); the key its tree declares
 * old:   the base under its own (old) key (O), when the key changed
 * markerDiff: [{status, path}] for .growth/, base..merge (--no-renames)
 * legacy: {measured, recorded}: the bootstrap's cross-check inputs
 * leaks: the optional-name scan's findings
 * range: {k, epochChanged}: rule 6's inputs
 */
export function evaluate(inputIn) {
  const input = bare(inputIn);
  const problems = [], notes = [], rows = [];
  const { mode, merge } = input;
  const B = merge.budgets;
  const bp = budgetsProblems(B);
  if (bp.length) return { ok: false, problems: bp, notes, rows };
  const M = merge.record;
  const mp = recordProblems(M);
  if (mp.length) return { ok: false, problems: mp.map((x) => `the merge's record: ${x}`), notes, rows };
  if (M.key.bun !== B.toolchain.bun) problems.push(`the merge was built with bun ${M.key.bun}, but budgets.json pins ${B.toolchain.bun}`);
  if (input.declaredNode && M.key.node !== input.declaredNode) problems.push(`the merge was measured with node ${M.key.node}, but heap-budget.json pins ${input.declaredNode}`);
  const listed = Object.keys(B.bundles).sort();
  if (jcs([...M.bundles].sort()) !== jcs(listed)) {
    const extra = M.bundles.filter((k) => !B.bundles[k]), missing = listed.filter((k) => !M.bundles.includes(k));
    problems.push(`the measured bundles differ from budgets.json's (r5 §1.2): ${[...extra.map((k) => `measured but not listed: ${k}`), ...missing.map((k) => `listed but not measured: ${k}`)].join("; ")}`);
  }
  for (const l of input.leaks ?? []) problems.push(`optional package in the core: ${l}`);

  // markers in the merge's tree: all must be well formed; their sum is the ledger's
  if (merge.markers.length > LIMITS.markers) return { ok: false, problems: [...problems, `.growth/ has ${merge.markers.length} markers, over the cap of ${LIMITS.markers}`], notes, rows };
  const total = safeSum(merge.markers.map((m) => Buffer.byteLength(m.text ?? "")));
  const overTotal = overCap(".growth/ in all", total ?? -1, LIMITS.markers_total_bytes);
  if (overTotal) return { ok: false, problems: [...problems, overTotal], notes, rows };
  const markers = new Map();
  for (const { path, text } of merge.markers) {
    const r = parseMarker(text, B);
    if (r.problems.length) problems.push(...r.problems.map((x) => `${path}: ${x}`));
    else markers.set(path, r.bytes);
  }
  const markerSum = (paths, k) => safeSum([...paths].map((p) => markers.get(p)?.[k] ?? 0));

  // absolute rules on the merge (rules 1, 3, 4)
  for (const k of listed) {
    if (!Object.hasOwn(M.sizes, k)) continue;
    const e = B.bundles[k], m = M.sizes[k];
    if (e.exact) {
      if (m > e.max) problems.push(`${k}: ${m} > max ${e.max} (an exact bundle, rule 1)`);
    } else {
      const ledger = safeSum([B.epoch.sizes[k], markerSum(markers.keys(), k) ?? NaN, e.noise_total]);
      if (ledger === null) problems.push(`${k}: the ledger's sum leaves the safe-integer range`);
      else if (m > ledger) problems.push(`${k}: ${m} > epoch ${B.epoch.sizes[k]} + markers in the tree + noise_total ${e.noise_total} = ${ledger} (rule 3, +${m - ledger})`);
      if (m > e.ceiling) problems.push(`${k}: ${m} > ceiling ${e.ceiling} (rule 4)`);
    }
  }
  if (mode === "absolute") {
    for (const k of listed) if (Object.hasOwn(M.sizes, k)) rows.push({ bundle: k, merge: M.sizes[k] });
    return { ok: problems.length === 0, problems, notes, rows };
  }

  const base = input.base;
  const diff = input.markerDiff ?? [];
  for (const d of diff) if (d.status !== "A" && d.status !== "D") problems.push(`${d.path}: status ${d.status} in .growth/: an existing marker can't be edited (r5 §1.4)`);
  const added = diff.filter((d) => d.status === "A").map((d) => d.path);
  for (const d of diff.filter((d) => d.status === "D")) notes.push(`${d.path}: deleted (the ledger only tightens)`);
  const deletedTexts = new Set(input.deletedMarkerTexts ?? []);
  for (const p of added) {
    const t = merge.markers.find((x) => x.path === p)?.text;
    if (t !== undefined && deletedTexts.has(t)) notes.push(`${p}: same content as a deleted or existing marker: a new request, to be reviewed as one`);
  }

  if (mode === "range") {
    const { k: transitions, epochChanged } = input.range;
    notes.push(`a push of ${transitions} first-parent transitions: outside the single-writer protocol (r5 §3.1), checked by the range rule`);
    if (epochChanged) problems.push("range contains an epoch reset: validate it transition by transition (r5 §1.3 rule 6)");
    const N = base.record;
    const np = recordProblems(N, base.commit);
    if (np.length) return { ok: false, problems: [...problems, ...np.map((x) => `the base's record: ${x}`)], notes, rows };
    if (!sameKey(N.key, M.key)) problems.push("the range changes the measurement key: validate it transition by transition");
    for (const k of listed) {
      const e = B.bundles[k];
      if (!Object.hasOwn(M.sizes, k) || !Object.hasOwn(N.sizes, k)) {
        problems.push(`${k}: not measured on both ends of the range`);
        continue;
      }
      const delta = M.sizes[k] - N.sizes[k];
      rows.push({ bundle: k, base: N.sizes[k], merge: M.sizes[k], delta });
      if (e.exact) {
        const old = base.budgets?.bundles?.[k];
        const raised = old?.exact === true && e.max > old.max;
        if (delta > 0 && !raised) problems.push(`${k}: ${fmt(delta)} over the range (an exact bundle, rule 1)`);
      } else {
        const allowed = safeSum([markerSum(added, k) ?? NaN, transitions * e.noise_bytes]);
        if (allowed === null) problems.push(`${k}: the range's authorization leaves the safe-integer range`);
        else if (delta > allowed) problems.push(`${k}: ${fmt(delta)} over the range > markers added in it + ${transitions} × noise_bytes = ${allowed} (rule 6)`);
      }
    }
    return { ok: problems.length === 0, problems, notes, rows };
  }

  // one transition: the base's record must be the base, under the merge's key
  const N = base.record;
  const np = recordProblems(N, base.commit);
  if (np.length) return { ok: false, problems: [...problems, ...np.map((x) => `the base's record: ${x}`)], notes, rows };
  if (!sameKey(N.key, M.key)) return { ok: false, problems: [...problems, "the base's record was made under another comparability key (r5 §1.1)"], notes, rows };

  if (base.budgets === null) return bootstrap(input, { problems, notes, rows, M, N, B, added, markerSum });
  const bb = budgetsProblems(base.budgets);
  if (bb.length) return { ok: false, problems: [...problems, ...bb.map((x) => `the base's ${x}`)], notes, rows };
  const keyChanged = !sameKey(base.declaredKey, M.key);
  const prev = epochHash(base.budgets.epoch);
  const isReset = B.epoch.reset !== null && B.epoch.reset.prev === prev;
  if (isReset) return reset(input, { problems, notes, rows, M, N, B, prev, keyChanged });
  if (keyChanged) problems.push("the measurement key changed (bun, node or size-measure.mjs): that is an epoch reset, which this PR doesn't declare (r5 §1.1, §1.3 rule 5)");

  // an ordinary integration: the epoch block is unchanged, except for new bundles' entries
  const newBundles = listed.filter((k) => !Object.hasOwn(N.sizes, k));
  const removed = N.bundles.filter((k) => !B.bundles[k]);
  for (const k of removed) problems.push(`${k}: measured in the base but not in budgets.json: a removal happens only in an epoch reset (r5 §1.2)`);
  for (const k of newBundles) if (base.budgets.bundles[k]) problems.push(`${k}: listed in the base's budgets.json but not measured there`);
  const stripped = (ep, drop) => ({ sizes: Object.fromEntries(Object.entries(ep.sizes).filter(([k]) => !drop.includes(k))), reset: ep.reset });
  if (jcs(stripped(B.epoch, newBundles)) !== jcs(base.budgets.epoch)) problems.push("the epoch block changed without a new reset declaration (epoch.reset.prev must be the sha256 of the base's epoch block; r5 §1.3 rule 5)");

  for (const k of listed) {
    const e = B.bundles[k];
    const m = M.sizes[k];
    if (m === undefined) continue;
    if (newBundles.includes(k)) {
      rows.push({ bundle: k, base: null, merge: m, delta: m, note: "new bundle" });
      if (!e.exact && B.epoch.sizes[k] !== m) problems.push(`${k}: a new bundle's epoch entry must be its size, ${m} (r5 §1.2)`);
      notes.push(`${k}: a new bundle, authorized by its budgets.json entry (r5 §1.2)`);
      continue;
    }
    const delta = m - N.sizes[k];
    const row = { bundle: k, base: N.sizes[k], merge: m, delta };
    rows.push(row);
    if (e.exact) {
      const old = base.budgets.bundles[k];
      const raised = old?.exact === true && e.max > old.max;
      if (delta > 0 && !raised) problems.push(`${k}: ${fmt(delta)}: an exact bundle may not grow without a reviewed raise of its max (rule 1)`);
      continue;
    }
    const s = markerSum(added, k);
    if (s === null) {
      problems.push(`${k}: the markers' sum leaves the safe-integer range`);
      continue;
    }
    row.markers = s;
    if (delta > e.noise_bytes && s < delta) problems.push(`${k}: ${fmt(delta)} needs a marker added by this PR for at least ${delta} B (markers: ${s}; rule 2)`);
    if (s > 0 && s > delta + e.marker_slack) problems.push(`${k}: markers ${s} B > growth ${fmt(delta)} + marker_slack ${e.marker_slack}: a marker must be tight (rule 2)`);
  }
  return { ok: problems.length === 0, problems, notes, rows };
}

function bootstrap(input, { problems, notes, rows, M, N, B, added, markerSum }) {
  notes.push("the bootstrap: the base has no budgets.json (r5 §1.2)");
  if (B.epoch.reset !== null) problems.push("the bootstrap declares no epoch reset");
  for (const k of Object.keys(B.bundles)) {
    if (!Object.hasOwn(N.sizes, k)) {
      problems.push(`${k}: listed in budgets.json but not measured in the rebuilt base`);
      continue;
    }
    const e = B.bundles[k];
    if (e.exact ? e.max !== N.sizes[k] : B.epoch.sizes[k] !== N.sizes[k]) problems.push(`${k}: ${e.exact ? "max" : "epoch"} must equal the rebuilt base, ${N.sizes[k]}`);
  }
  for (const k of N.bundles) if (!B.bundles[k]) problems.push(`${k}: measured in the base but not in budgets.json`);
  // the cross-check: this measurement agrees with size-budget.mjs's on the same build, but for the neutralization
  const lg = input.legacy;
  const sizesOk = (o) => !!o && typeof o === "object" && !Array.isArray(o) && Object.keys(o).length <= LIMITS.entries && Object.values(o).every(isNat);
  if (!lg?.measured) problems.push("the bootstrap needs the base measured by its own size-budget.mjs (the cross-check)");
  else if (!sizesOk(lg.measured) || (lg.recorded !== null && !sizesOk(lg.recorded))) problems.push("the cross-check's legacy measurement or record isn't an object of non-negative safe integers");
  else {
    const keys = Object.keys(lg.measured).sort();
    if (jcs(keys) !== jcs([...N.bundles].sort())) problems.push("the cross-check: size-budget.mjs measured other bundles than size-measure.mjs");
    for (const k of keys) {
      const want = lg.measured[k] + (N.neutral?.[k] ?? 0);
      if (N.sizes[k] !== want) problems.push(`the cross-check: ${k}: ${N.sizes[k]}, but size-budget.mjs measured ${lg.measured[k]} and the neutralization is ${fmt(N.neutral?.[k] ?? 0)}`);
      const rec = lg.recorded?.[k];
      if (rec === undefined) problems.push(`the cross-check: ${k} isn't in the base's size-budget.json`);
      else if (lg.measured[k] > rec) problems.push(`the cross-check: ${k}: the base measures ${lg.measured[k]} > its size-budget.json ${rec}`);
      else if (lg.measured[k] < rec) notes.push(`the base's size-budget.json is ${rec - lg.measured[k]} B over its build for ${k} (it records an upper bound)`);
    }
  }
  for (const k of Object.keys(B.bundles)) {
    const e = B.bundles[k];
    if (!Object.hasOwn(M.sizes, k) || !Object.hasOwn(N.sizes, k)) continue;
    const delta = M.sizes[k] - N.sizes[k];
    const row = { bundle: k, base: N.sizes[k], merge: M.sizes[k], delta };
    rows.push(row);
    if (e.exact) {
      if (delta > 0) problems.push(`${k}: ${fmt(delta)} (an exact bundle, rule 1)`);
      continue;
    }
    const s = markerSum(added, k) ?? NaN;
    row.markers = s;
    if (delta > e.noise_bytes && !(s >= delta)) problems.push(`${k}: ${fmt(delta)} needs a marker (rule 2)`);
    if (s > 0 && s > delta + e.marker_slack) problems.push(`${k}: markers ${s} B > growth ${fmt(delta)} + marker_slack ${e.marker_slack} (rule 2)`);
  }
  return { ok: problems.length === 0, problems, notes, rows };
}

// The groups of an epoch reset: the old→new key identity (r5 §1.3 rule 5)
export function resetGroups(oldIn, newIn, rIn) {
  const oldBudgets = bare(oldIn), newBudgets = bare(newIn), r = bare(rIn);
  const problems = [];
  const oldKeys = Object.keys(oldBudgets.bundles), newKeys = Object.keys(newBudgets.bundles);
  const seenOld = new Map(), seenNew = new Map();
  const groups = [];
  const claim = (seen, k, side, g) => {
    if (seen.has(k)) problems.push(`${k}: in two places of the reset's ${side} side`);
    seen.set(k, g);
  };
  for (const e of r.map) {
    const g = { old: [...e.old].sort(), new: [...e.new].sort() };
    g.name = g.new.join("+");
    for (const k of g.old) claim(seenOld, k, "old", g);
    for (const k of g.new) claim(seenNew, k, "new", g);
    groups.push(g);
  }
  for (const k of r.removed) claim(seenOld, k, "old", "removed");
  for (const k of r.added) claim(seenNew, k, "new", "added");
  for (const k of oldKeys)
    if (!seenOld.has(k)) {
      if (newBudgets.bundles[k] && !seenNew.has(k)) {
        const g = { old: [k], new: [k], name: k };
        seenOld.set(k, g);
        seenNew.set(k, g);
        groups.push(g);
      } else problems.push(`${k}: an old key with no place in the reset's map (r5 §1.3 rule 5)`);
    }
  for (const k of newKeys) if (!seenNew.has(k)) problems.push(`${k}: a new key with no place in the reset's map, and not in added`);
  for (const k of seenOld.keys()) if (!oldBudgets.bundles[k]) problems.push(`${k}: not a key of the base's budgets.json`);
  for (const k of seenNew.keys()) if (!newBudgets.bundles[k]) problems.push(`${k}: not a key of budgets.json`);
  for (const k of r.added) if (oldBudgets.bundles[k]) problems.push(`${k}: added, but the base has it`);
  for (const k of r.removed) if (newBudgets.bundles[k]) problems.push(`${k}: removed, but budgets.json has it`);
  for (const g of groups) {
    const ex = [...g.old.map((k) => oldBudgets.bundles[k]?.exact), ...g.new.map((k) => newBudgets.bundles[k]?.exact)];
    if (ex.some((x) => x === undefined)) continue;
    if (new Set(ex).size > 1) problems.push(`group ${g.name}: mixes exact and non-exact keys`);
    g.exact = ex[0];
  }
  return { groups, problems };
}

function reset(input, { problems, notes, rows, M, N, B, prev, keyChanged }) {
  const base = input.base, r = B.epoch.reset;
  notes.push(`an epoch reset: ${r.reason}`);
  if (input.merge.markers.length) problems.push(`an epoch reset leaves .growth/ empty (${input.merge.markers.length} marker(s) remain)`);
  const O = keyChanged ? input.old : N;
  if (keyChanged) {
    if (!O) return { ok: false, problems: [...problems, "the measurement key changed, and the base under its old key (O) couldn't be produced: the reset fails closed (r5 §1.3 rule 5)"], notes, rows };
    const op = recordProblems(O, base.commit);
    if (op.length) return { ok: false, problems: [...problems, ...op.map((x) => `the old-key record: ${x}`)], notes, rows };
    if (!sameKey(O.key, base.declaredKey)) problems.push("the old-key record isn't under the base's own key");
  }
  const { groups, problems: gp } = resetGroups(base.budgets, B, r);
  problems.push(...gp);
  const groupOf = (k, side) => groups.filter((g) => g[side].includes(k));
  const sum = (rec, keys) => safeSum(keys.map((k) => rec.sizes[k] ?? 0));
  const names = new Set(groups.map((g) => g.name));
  for (const g of Object.keys(r.growth)) if (!names.has(g)) problems.push(`epoch.reset.growth.${g}: not a group of this reset`);
  // N's keys can carry either side's names; each must belong to one group
  for (const k of N.bundles) {
    const gs = new Set([...groupOf(k, "old"), ...groupOf(k, "new")]);
    if (gs.size > 1) problems.push(`${k}: the rebuilt base's key belongs to two groups`);
    if (!gs.size && !r.removed.includes(k) && !r.added.includes(k)) problems.push(`${k}: the rebuilt base's key has no group`);
  }
  for (const g of groups) {
    const Og = sum(O, g.old.filter((k) => Object.hasOwn(O.sizes, k)));
    const Ng = sum(N, N.bundles.filter((k) => g.old.includes(k) || g.new.includes(k)));
    const Mg = sum(M, g.new);
    if ([Og, Ng, Mg].includes(null)) {
      problems.push(`group ${g.name}: a sum leaves the safe-integer range`);
      continue;
    }
    const dT = Ng - Og, dI = Mg - Ng;
    const row = { bundle: g.name, old: Og, base: Ng, merge: Mg, delta: dI, toolchain: dT };
    rows.push(row);
    if (g.exact) {
      // (a raise through the map: the group's new maxima sum above its old ones)
      const oldMax = safeSum(g.old.map((k) => base.budgets.bundles[k].max)), newMax = safeSum(g.new.map((k) => B.bundles[k].max));
      const raised = oldMax !== null && newMax !== null && newMax > oldMax;
      if ((dT > 0 || dI > 0) && !raised) problems.push(`group ${g.name}: exact, but ΔT ${fmt(dT)}, ΔI ${fmt(dI)} without a reviewed raise of max (rule 1)`);
      continue;
    }
    const slacks = new Set(g.new.map((k) => B.bundles[k].marker_slack));
    const noises = new Set(g.new.map((k) => B.bundles[k].noise_bytes));
    if (slacks.size !== 1 || noises.size !== 1) {
      problems.push(`group ${g.name}: its keys declare different marker_slack or noise_bytes`);
      continue;
    }
    const [slack] = slacks, [noise] = noises;
    const charge = Math.max(0, dT) + Math.max(0, dI);
    row.charge = charge;
    const growth = r.growth[g.name];
    row.growth = growth ?? 0;
    if (growth === undefined) {
      if (charge > noise) problems.push(`group ${g.name}: charge ${charge} (ΔT ${fmt(dT)}, ΔI ${fmt(dI)}) needs epoch.reset.growth.${g.name}`);
    } else if (growth < charge || growth > charge + slack) problems.push(`group ${g.name}: growth ${growth} not within charge ${charge} … charge + marker_slack ${charge + slack} (ΔT ${fmt(dT)}, ΔI ${fmt(dI)})`);
  }
  for (const k of r.added) if (Object.hasOwn(M.sizes, k)) notes.push(`${k}: added by the reset (${M.sizes[k]} B), authorized by its entry`);
  const nonExact = Object.keys(B.bundles).filter((k) => !B.bundles[k].exact);
  for (const k of nonExact) if (B.epoch.sizes[k] !== M.sizes[k]) problems.push(`${k}: after a reset epoch.sizes must equal the merge, ${M.sizes[k]} (it is ${B.epoch.sizes[k]})`);
  return { ok: problems.length === 0, problems, notes, rows };
}

// ---------------------------------------------------------------------------
// Docs-only (r5 §1.5): the gate's own inputs are never docs-only

export const GATE_INPUTS = [
  /^budgets\.json$/, /^\.growth\//, /^scripts\/size-measure\.mjs$/, /^scripts\/size-budget\.mjs$/, /^size-budget\.json$/,
  /^\.github\/workflows\//, /^package\.json$/, /^pnpm-lock\.yaml$/, /^\.nvmrc$/, /^\.bun-version$/,
  /^heap-budget\.json$/, /^scripts\/heap-budget\.mjs$/, /^core-api-surface\.json$/, /^scripts\/core-api-surface\.mjs$/, /^scripts\/ci-paths\.mjs$/,
];
export const gateInputs = (files) => files.filter((f) => GATE_INPUTS.some((re) => re.test(f)));

// ---------------------------------------------------------------------------
// The CLI (CI's jobs)

const git = (...a) => execFileSync("git", a, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).trim();
const gitOr = (fallback, ...a) => {
  try {
    return git(...a);
  } catch {
    return fallback;
  }
};
const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const event = () => (process.env.GITHUB_EVENT_PATH && existsSync(process.env.GITHUB_EVENT_PATH) ? JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8")) : {});
const ZERO = /^0{40}$/;

// The tested commit and its base, by event (r5 §1.1)
export function testedTransition({ cwd = root, name = process.env.GITHUB_EVENT_NAME ?? "local", ev = event() } = {}) {
  const git = (...a) => execFileSync("git", a, { cwd, encoding: "utf8" }).trim();
  const gitOr = (fallback, ...a) => {
    try {
      return git(...a);
    } catch {
      return fallback;
    }
  };
  const head = git("rev-parse", "HEAD");
  const parents = git("rev-list", "--parents", "-n", "1", head).split(" ").slice(1);
  if (name === "pull_request") {
    if (parents.length !== 2) throw new Error(`the tested commit ${head} isn't a two-parent merge (a head checkout or a deleted merge ref): refused`);
    if (parents[1] !== ev.pull_request?.head?.sha) throw new Error(`HEAD^2 ${parents[1]} isn't the pull request's head ${ev.pull_request?.head?.sha}`);
    return { mode: "transition", merge: head, base: parents[0], head: parents[1] };
  }
  if (name === "merge_group") {
    if (ev.merge_group?.base_sha !== parents[0]) throw new Error(`merge_group.base_sha ${ev.merge_group?.base_sha} isn't HEAD^1 ${parents[0]}`);
    return { mode: "transition", merge: head, base: parents[0], head: parents[1] ?? null };
  }
  if (name === "push") {
    const before = ev.before ?? "";
    if (!before || ZERO.test(before)) return { mode: "absolute", merge: head };
    if (parents[0] === before) return { mode: "transition", merge: head, base: before, head: parents[1] ?? null };
    if (gitOr("no", "merge-base", "--is-ancestor", before, head) === "no" || gitOr("no", "cat-file", "-e", `${before}^{commit}`) === "no") throw new Error(`the push's before ${before} isn't an ancestor of ${head}: master was rewritten`);
    const k = Number(git("rev-list", "--first-parent", "--count", `${before}..${head}`));
    return { mode: "range", merge: head, base: before, k };
  }
  return { mode: "absolute", merge: head };
}

const show = (commit, path) => gitOr(null, "show", `${commit}:${path}`);
// a blob's text, after checking its size against `cap` (null: no such blob)
function blobAt(commit, path, cap) {
  const size = gitOr(null, "cat-file", "-s", `${commit}:${path}`);
  if (size === null) return null;
  const over = overCap(`${path} at ${commit.slice(0, 12)}`, Number(size), cap);
  if (over) throw new Error(over);
  return show(commit, path);
}
function budgetsAt(commit) {
  const t = blobAt(commit, "budgets.json", LIMITS.budgets_bytes);
  return t === null ? null : strictParse(t);
}
function declaredKeyAt(commit) {
  const b = budgetsAt(commit);
  const h = show(commit, "heap-budget.json");
  const m = gitOr(null, "cat-file", "blob", `${commit}:scripts/size-measure.mjs`);
  return {
    bun: b?.toolchain?.bun ?? null,
    node: h ? JSON.parse(h).toolchain?.node ?? null : null,
    measure_sha256: m === null ? null : sha256(execFileSync("git", ["cat-file", "blob", `${commit}:scripts/size-measure.mjs`], { cwd: root })),
  };
}
// every marker of a commit, after checking their count and sizes (LIMITS)
function markersAt(commit) {
  const ls = gitOr("", "ls-tree", "-r", "-l", commit, "--", ".growth/");
  const entries = ls.split("\n").filter(Boolean).map((l) => {
    const [meta, path] = l.split("\t");
    return { path, size: Number(meta.trim().split(/\s+/)[3]) };
  });
  if (entries.length > LIMITS.markers) throw new Error(`.growth/ at ${commit.slice(0, 12)} has ${entries.length} markers, over the cap of ${LIMITS.markers}`);
  let total = 0;
  for (const e of entries) {
    const over = overCap(e.path, e.size, LIMITS.marker_bytes);
    if (over) throw new Error(over);
    total += e.size;
  }
  const overTotal = overCap(`.growth/ at ${commit.slice(0, 12)} in all`, total, LIMITS.markers_total_bytes);
  if (overTotal) throw new Error(overTotal);
  return entries.map(({ path }) => ({ path, text: show(commit, path) }));
}

function epochChangedInRange(before, after) {
  const commits = [before, ...git("rev-list", "--first-parent", "--reverse", `${before}..${after}`).split("\n").filter(Boolean)];
  let last = null;
  for (const c of commits) {
    const b = budgetsAt(c);
    const e = b ? jcs(b.epoch ?? null) : "none";
    if (last !== null && e !== last) return true;
    last = e;
  }
  return false;
}

// a downloaded record (or legacy.json), after checking its size
function readRecord(dir, name) {
  const f = join(dir, name);
  if (!existsSync(f)) return null;
  const over = overCap(name, statSync(f).size, name === "legacy.json" ? LIMITS.legacy_bytes : LIMITS.record_bytes);
  if (over) throw new Error(over);
  return JSON.parse(readFileSync(f, "utf8"));
}

function summary(lines) {
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join("\n") + "\n");
}

async function cli() {
  const mode = process.argv[2];
  const dir = arg("--root") ?? root;
  if (mode === "--record") {
    const m = await measure(dir);
    if (m.problems.length) {
      console.error("the measurement failed:\n  " + m.problems.join("\n  "));
      process.exit(1);
    }
    const g = (...a) => execFileSync("git", a, { cwd: dir, encoding: "utf8" }).trim();
    const rec = makeRecord({
      commit: g("rev-parse", "HEAD"),
      tree: g("rev-parse", "HEAD^{tree}"),
      event: process.env.GITHUB_EVENT_NAME ?? "local",
      run: { id: process.env.GITHUB_RUN_ID ?? null, attempt: process.env.GITHUB_RUN_ATTEMPT ?? null, job: process.env.GITHUB_JOB ?? null },
      key: currentKey(),
      m,
    });
    writeFileSync(arg("--out"), JSON.stringify(rec, null, 1) + "\n");
    console.log(`size record for ${rec.commit}: ${rec.bundles.length} bundles, key ${jcs(rec.key)}`);
  } else if (mode === "--census") {
    const { files, extra } = buildFiles(dir);
    const m = measureFiles(files, dir, await stampedValues(dir), extra);
    for (const [k, c] of Object.entries(m.counts)) if (c.VERSION || c.BUILD_ID) console.log(`${k}: VERSION ${c.VERSION}, BUILD_ID ${c.BUILD_ID}`);
    if (m.problems.length) console.log("against EXPECTED_COUNTS:\n  " + m.problems.join("\n  "));
  } else if (mode === "--legacy") {
    // (r6 §1.2: the base's own measure(), on this same build; fails closed if it can't run)
    const legacy = await import(pathToFileURL(join(dir, "scripts", "size-budget.mjs")).href);
    if (typeof legacy.measure !== "function") throw new Error(`${dir}/scripts/size-budget.mjs has no measure(): the bootstrap cross-check fails closed`);
    const recorded = existsSync(join(dir, "size-budget.json")) ? JSON.parse(readFileSync(join(dir, "size-budget.json"), "utf8")).sizes : null;
    writeFileSync(arg("--out"), JSON.stringify({ measured: legacy.measure(dir), recorded }, null, 1) + "\n");
  } else if (mode === "--resolve-base") {
    await resolveBase();
  } else if (mode === "--gate") {
    await gate();
  } else if (mode === "--epoch") {
    epochReset();
  } else {
    console.error("usage: size-measure.mjs --record|--census|--legacy|--resolve-base|--gate|--epoch (see the header)");
    process.exit(2);
  }
}

// size-base: which base, and whether its push record is usable (r5 §1.1, §1.5)
async function resolveBase() {
  const out = (k, v) => (process.env.GITHUB_OUTPUT ? appendFileSync(process.env.GITHUB_OUTPUT, `${k}=${v}\n`) : console.log(`${k}=${v}`));
  const recDir = arg("--out-dir");
  mkdirSync(recDir, { recursive: true });
  const t = testedTransition();
  out("mode", t.mode);
  if (t.mode === "absolute") return out("need_new", "false"), out("need_old", "false");
  out("base", t.base);
  const key = currentKey();
  const declared = declaredKeyAt(t.base);
  const bootstrap = budgetsAt(t.base) === null;
  let found = null;
  if (!bootstrap) found = fetchPushRecord(t.base, join(recDir, "fetched"));
  const keyChanged = !sameKey(declared, key);
  let needNew = true, needOld = false;
  if (found && sameKey(found.key, key)) {
    writeFileSync(join(recDir, "base-record.json"), JSON.stringify(found));
    needNew = false;
    console.log(`the base's push record (run ${found.run?.id}) is usable`);
  } else if (found) {
    writeFileSync(join(recDir, "old-record.json"), JSON.stringify(found));
    console.log(`the base's push record is under another key (${jcs(found.key)}): rebuilding the base under this one`);
  } else console.log(bootstrap ? "the bootstrap: the base has no budgets.json; rebuilding it" : "no usable push record for the base: rebuilding it");
  // the old-key base, for a reset that moves the key and has no old record
  const mergeBudgets = budgetsAt("HEAD");
  const isReset = !bootstrap && mergeBudgets?.epoch?.reset && mergeBudgets.epoch.reset.prev === epochHash(budgetsAt(t.base).epoch);
  if (isReset && keyChanged && !found) needOld = declared.measure_sha256 !== null;
  out("need_new", String(needNew));
  out("need_old", String(needOld));
  out("bootstrap", String(bootstrap));
  out("old_bun", declared.bun ?? "");
  out("old_node", declared.node ?? "");
}

// The push record of `sha`: only a successful ci push run on master for exactly that commit, in this repository
function fetchPushRecord(sha, into) {
  const gh = (...a) => spawnSync("gh", a, { encoding: "utf8", timeout: 120_000 });
  const r = gh("api", `repos/${REPO}/actions/workflows/ci.yml/runs?event=push&branch=master&head_sha=${sha}&per_page=20`);
  if (r.status !== 0) {
    console.log(`the push-record query failed: ${(r.stderr || "").slice(0, 300)}`);
    return null;
  }
  const runs = (JSON.parse(r.stdout).workflow_runs ?? []).filter((x) => x.head_sha === sha && x.event === "push" && x.head_branch === "master" && x.repository?.full_name === REPO);
  for (const run of runs.sort((a, b) => b.run_attempt - a.run_attempt)) {
    const jobs = gh("api", `repos/${REPO}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`);
    if (jobs.status !== 0) continue;
    const checks = (JSON.parse(jobs.stdout).jobs ?? []).find((j) => j.name === "checks");
    if (checks?.conclusion !== "success") continue;
    rmSync(into, { recursive: true, force: true });
    const d = gh("run", "download", String(run.id), "-R", REPO, "-n", `sizes-${sha}`, "-D", into);
    if (d.status !== 0) continue;
    let rec;
    try {
      rec = readRecord(into, "sizes.json");
    } catch (e) {
      console.log(`run ${run.id}'s record isn't usable: ${e.message}`);
      continue;
    }
    if (!rec) continue;
    const p = recordProblems(rec, sha);
    if (p.length) {
      console.log(`run ${run.id}'s record isn't usable: ${p.join("; ")}`);
      continue;
    }
    // (bound to its producer: this run, this attempt, the checks job, and the commit's own tree)
    if (rec.event !== "push" || String(rec.run?.id) !== String(run.id) || String(rec.run?.attempt) !== String(run.run_attempt) || rec.run?.job !== "checks" || rec.tree !== gitOr(null, "rev-parse", `${sha}^{tree}`)) {
      console.log(`run ${run.id}'s record doesn't name its producer (run, attempt, job, tree): not used`);
      continue;
    }
    return rec;
  }
  return null;
}

async function gate() {
  const recDir = arg("--records");
  const lines = ["## Core growth gate (plan-growth-budget-r5)", ""];
  let result;
  try {
    if (process.argv.includes("--docs-only")) result = docsOnly();
    else result = await gateInputsAndEvaluate(recDir);
  } catch (e) {
    result = { ok: false, problems: [e.message], notes: [], rows: [] };
  }
  lines.push(result.ok ? "**PASS**" : "**FAIL**", "");
  if (result.tested) lines.push(`tested merge \`${result.tested.merge}\`, base \`${result.tested.base ?? "-"}\`, head \`${result.tested.head ?? "-"}\`, mode ${result.tested.mode}`, "");
  if (result.rows.length) {
    lines.push("| bundle | base | merge | Δ | markers | notes |", "|---|---:|---:|---:|---:|---|");
    for (const r of result.rows) lines.push(`| ${r.bundle} | ${r.base ?? ""} | ${r.merge ?? ""} | ${r.delta === undefined ? "" : fmt(r.delta)} | ${r.markers ?? r.growth ?? ""} | ${[r.note, r.toolchain !== undefined ? `ΔT ${fmt(r.toolchain)}, charge ${r.charge ?? "-"}` : ""].filter(Boolean).join("; ")} |`);
  }
  for (const n of result.notes) lines.push(`- ${n}`);
  for (const p of result.problems) lines.push(`- **${p}**`);
  summary(lines);
  console.log(lines.join("\n"));
  if (arg("--out")) writeFileSync(arg("--out"), JSON.stringify(result, null, 1) + "\n");
  process.exit(result.ok ? 0 : 1);
}

function docsOnly() {
  const t = testedTransition();
  if (t.mode === "absolute") return { ok: false, problems: ["a docs-only pass needs a base to diff against"], notes: [], rows: [], tested: t };
  const files = git("diff", "--name-only", t.base, t.merge).split("\n").filter(Boolean);
  const inputs = gateInputs(files);
  const problems = inputs.map((f) => `${f}: a gate input, never docs-only (r5 §1.5)`);
  if (process.env.SIZE_GATE_NODE === "true" || process.env.SIZE_GATE_WEB === "true") problems.push("the classifier says measured inputs changed, but the measurement didn't run");
  return { ok: problems.length === 0, problems, notes: problems.length ? [] : [`docs-only: ${files.length} files, no measured or gate input`], rows: [], tested: t };
}

async function gateInputsAndEvaluate(recDir) {
  const t = testedTransition();
  const M = readRecord(recDir, "merge-record.json");
  if (!M) throw new Error("no record of the tested merge (the checks job didn't produce one): fails closed");
  if (M.commit !== t.merge) throw new Error(`the merge's record is of ${M.commit}, not the tested ${t.merge}`);
  // (the optional-name scan runs on the build itself, in the checks job's
  // size-budget.mjs --check, which still fails on a leak; size-gate requires
  // that job's success)
  const input = {
    mode: t.mode,
    merge: { record: M, budgets: (() => {
      const over = overCap("budgets.json", statSync(join(root, "budgets.json")).size, LIMITS.budgets_bytes);
      if (over) throw new Error(over);
      return strictParse(readFileSync(join(root, "budgets.json"), "utf8"));
    })(), markers: markersAt("HEAD") },
    declaredNode: declaredKeyAt("HEAD").node,
  };
  if (t.mode !== "absolute") {
    const N = readRecord(recDir, "base-record.json");
    if (!N) throw new Error("no record of the base (size-base produced none): fails closed");
    input.base = { commit: t.base, record: N, budgets: budgetsAt(t.base), declaredKey: declaredKeyAt(t.base) };
    input.old = readRecord(recDir, "old-record.json");
    input.legacy = readRecord(recDir, "legacy.json");
    const nameStatus = gitOr("", "diff", "--no-renames", "--name-status", t.base, t.merge, "--", ".growth/");
    input.markerDiff = nameStatus.split("\n").filter(Boolean).map((l) => {
      const [status, path] = l.split("\t");
      return { status: status[0], path };
    });
    input.deletedMarkerTexts = [
      ...input.markerDiff.filter((d) => d.status === "D").map((d) => show(t.base, d.path)),
      ...markersAt(t.base).map((m) => m.text),
    ].filter((x) => x !== null);
    if (t.mode === "range") input.range = { k: t.k, epochChanged: epochChangedInRange(t.base, t.merge) };
  }
  return { ...evaluate(input), tested: t };
}

// Write an epoch reset into budgets.json (r5 §1.3 rule 5): epoch.sizes from
// the merge's record, prev from the base's epoch block, growth = each
// group's charge (to be reviewed), and .growth/ emptied.
function epochReset() {
  const recDir = arg("--records");
  const reason = arg("--reason");
  if (!nonEmpty(reason)) throw new Error("--reason is required");
  const base = arg("--base") ?? git("merge-base", "HEAD", "origin/master");
  const M = readRecord(recDir, "merge-record.json"), N = readRecord(recDir, "base-record.json"), O = readRecord(recDir, "old-record.json") ?? N;
  if (!M || !N) throw new Error(`${recDir} needs merge-record.json and base-record.json (from this PR's CI artifacts)`);
  const file = join(root, "budgets.json");
  const B = strictParse(readFileSync(file, "utf8"));
  const baseBudgets = budgetsAt(base);
  const map = arg("--map") ? strictParse(readFileSync(arg("--map"), "utf8")) : { map: [], added: [], removed: [] };
  B.epoch = { sizes: Object.fromEntries(Object.keys(B.bundles).filter((k) => !B.bundles[k].exact).sort().map((k) => [k, M.sizes[k]])), reset: { reason, prev: epochHash(baseBudgets.epoch), growth: {}, map: map.map, added: map.added, removed: map.removed } };
  const { groups, problems } = resetGroups(baseBudgets, B, B.epoch.reset);
  if (problems.length) throw new Error(problems.join("\n"));
  for (const g of groups) {
    if (g.exact) continue;
    const s = (rec, keys) => keys.reduce((t, k) => t + (rec.sizes[k] ?? 0), 0);
    const Og = s(O, g.old), Ng = s(N, N.bundles.filter((k) => g.old.includes(k) || g.new.includes(k))), Mg = s(M, g.new);
    const charge = Math.max(0, Ng - Og) + Math.max(0, Mg - Ng);
    if (charge > 0) B.epoch.reset.growth[g.name] = charge;
  }
  writeFileSync(file, JSON.stringify(B, null, 1) + "\n");
  for (const m of markersAt("HEAD")) rmSync(join(root, m.path));
  console.log(`budgets.json: an epoch reset (prev ${B.epoch.reset.prev.slice(0, 12)}…), growth ${jcs(B.epoch.reset.growth)}; .growth/ emptied. Review it, and commit.`);
}

if (process.argv[1] === SELF) await cli();
