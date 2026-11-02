#!/usr/bin/env node
// The offline catalog's size gate (plan-b8-offline r3.4 §3; daybreak3's ruling on its implementation: a gate of its
// own, not scripts/size-measure.mjs).  Eight rows, each a hard ceiling, measured from a built web/dist:
//   the LAZY files (count, stored bytes, the largest one) from dist/sw.js's own LAZY and DIGESTS;
//   the transfer estimate from dist/offline-inventory.json's totals;
//   the inventory's own bytes, raw and gzip-9;
//   dist/sw.js's bytes, raw and gzip-9, against ceilings frozen in web/offline-size-ceilings.json (measured on the
//   exact merge base with the pinned toolchain, and remeasured when the base changes).
//
// gzip-9 is node:zlib's at level 9 under the Node and zlib the ceilings name (assertRuntime; else it fails closed).
//
//   node scripts/offline-size-gate.mjs [--check] [DIST]     (default web/dist; --check: exit 1 on any row over)
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const MiB = 1024 * 1024;
export const CAPS = { files: 600, stored: 64 * MiB, transfer: 16 * MiB, maxEntry: 16 * MiB, inventoryRaw: 8192, inventoryGzip: 3072 };

/** a JSON literal assigned by `const NAME = ...;` in sw.js (the build writes each on one line) */
function literal(sw, name) {
  const m = new RegExp(`^const ${name} = (.*);$`, "m").exec(sw);
  if (!m) throw new Error(`dist/sw.js has no ${name}`);
  return JSON.parse(m[1]);
}

// The gzip row measures a normalized sw.js (daybreak3's Rule A): three same-length spans that change with the commit a
// tree is built from, not with its code, are zeroed after each is authenticated: VERSION (16 hex) and the DIGESTS
// sha256 of docs-index-python.json (its source links name the commit) and of offline-inventory.json (its transfer
// estimate compresses that index).  Anything missing, repeated, malformed or not matching its dist file fails closed.
export const NORMALIZED = "rule-A-1/V3: VERSION + DIGESTS sha256 of docs-index-python.json, offline-inventory.json zeroed";
// (the span topology is pinned per ceiling record, never inferred, daybreak3: the merge base predates
// offline-inventory.json, so its record names the legacy topology, where the inventory's file and DIGESTS entry must
// both be absent; the head's names the inventory topology, where both must be present, exact-once and authenticated)
export const TOPOLOGIES = Object.freeze({
  "legacy-2span": { files: ["docs-index-python.json"], absent: ["offline-inventory.json"] },
  "inventory-3span": { files: ["docs-index-python.json", "offline-inventory.json"], absent: [] },
});
const sha256 = (b) => createHash("sha256").update(b).digest("hex");
/** VERSION's authentication (daybreak3's V3): besides its one declaration, exactly one canonical derivation of the
 *  cache's name from it */
export function versionStructural(version, sw) {
  const n = sw.split('\nconst CACHE = "sagebrush-" + VERSION;\n').length - 1;
  if (n !== 1) throw new Error(`sw.js: ${n} canonical cache-name derivations from VERSION (exactly one expected)`);
}
/** sw.js's bytes with the three spans zeroed, after each is authenticated against `dist` (read(name) -> bytes); `files`
 *  names the DIGESTS entries normalized (the merge base predates offline-inventory.json: there, docs-index-python.json
 *  alone, stated in the ceilings) */
export function normalizeSw(swBytes, read, topology = "inventory-3span", authVersion = versionStructural) {
  const topo = TOPOLOGIES[topology];
  if (!topo) throw new Error(`unknown normalization topology ${JSON.stringify(topology)}`);
  const files = topo.files;
  const sw = swBytes.toString("utf8"), spans = [];
  const at = (index) => Buffer.byteLength(sw.slice(0, index));
  const one = (re, what) => {
    const all = [...sw.matchAll(re)];
    if (all.length !== 1) throw new Error(`sw.js: ${all.length} ${what} (exactly one expected)`);
    return all[0];
  };
  const v = one(/const VERSION = "([^"]*)";/g, "VERSION declarations");
  if (!/^[0-9a-f]{16}$/.test(v[1])) throw new Error("sw.js: VERSION is not 16 hex digits");
  authVersion(v[1], sw, read);
  spans.push([at(v.index + v[0].indexOf('"') + 1), 16]);
  for (const name of topo.absent) {
    const entries = sw.split(`"${name}":{"sha256":"`).length - 1;
    let file = true;
    try { read(name); } catch (e) { if (e?.code === "ENOENT") file = false; else throw e; }
    if (entries || file) throw new Error(`topology ${topology}: ${name} must be absent (its DIGESTS entries: ${entries}; its file: ${file ? "present" : "absent"})`);
  }
  for (const name of files) {
    const m = one(new RegExp(`"${name.replace(/[.]/g, "\\.")}":\\{"sha256":"([^"]*)"`, "g"), `DIGESTS entries for ${name}`);
    if (!/^[0-9a-f]{64}$/.test(m[1])) throw new Error(`sw.js: the sha256 of ${name} is not 64 hex digits`);
    if (m[1] !== sha256(read(name))) throw new Error(`sw.js: the sha256 of ${name} is not its dist file's`);
    // (the match ends with the hash's closing quote: the span is the 64 bytes before it)
    spans.push([at(m.index + m[0].length - 65), 64]);
  }
  const out = Buffer.from(swBytes);
  for (const [i, n] of spans) out.fill(0x30, i, i + n);
  if (spans.reduce((t, [, n]) => t + n, 0) !== 16 + 64 * files.length) throw new Error("normalization touched other than its spans' bytes");
  return out;
}

/** the eight rows of a built dist: [{row, value, cap}] */
export function measure(dist, ceilings) {
  const swBytes = readFileSync(join(dist, "sw.js"));
  const sw = swBytes.toString("utf8");
  const lazy = literal(sw, "LAZY"), digests = literal(sw, "DIGESTS");
  const sizes = lazy.map((p) => {
    const d = digests[p.split("?")[0]];
    if (!d || !Number.isSafeInteger(d.size) || d.size < 0) throw new Error(`dist/sw.js: no size for ${p}`);
    return d.size;
  });
  const invBytes = readFileSync(join(dist, "offline-inventory.json"));
  const inv = JSON.parse(invBytes.toString("utf8"));
  if (!Number.isSafeInteger(inv?.totals?.transfer)) throw new Error("offline-inventory.json has no transfer total");
  return [
    { row: "LAZY files", value: lazy.length, cap: CAPS.files },
    { row: "LAZY stored bytes", value: sizes.reduce((t, n) => t + n, 0), cap: CAPS.stored },
    { row: "LAZY transfer bytes (estimate)", value: inv.totals.transfer, cap: CAPS.transfer },
    { row: "largest LAZY file", value: Math.max(0, ...sizes), cap: CAPS.maxEntry },
    { row: "offline-inventory.json raw", value: invBytes.length, cap: CAPS.inventoryRaw },
    { row: "offline-inventory.json gzip-9", value: gzip9(invBytes), cap: CAPS.inventoryGzip },
    { row: "sw.js raw", value: swBytes.length, cap: ceilings.swRaw },
    { row: `sw.js gzip-9 (normalized, ${ceilings.topology ?? "inventory-3span"})`, value: gzip9(normalizeSw(swBytes, (n) => readFileSync(join(dist, n)), ceilings.topology ?? "inventory-3span")), cap: ceilings.swGzip },
  ];
}

export function readCeilings(file = join(root, "web", "offline-size-ceilings.json")) {
  const c = JSON.parse(readFileSync(file, "utf8"));
  for (const k of ["swRaw", "swGzip"]) if (!Number.isSafeInteger(c[k]) || c[k] <= 0) throw new Error(`${file}: ${k} is not a positive integer`);
  return c;
}

// gzip-9 as the ceilings were measured (daybreak3's ruling): node:zlib gzipSync level 9, under the Node and zlib
// they name.  Another runtime or compressor fails closed: its output may differ, and the ceilings are then
// remeasured and reviewed, never regenerated here.
export const METHOD = "node:zlib gzipSync level 9";
export function assertRuntime(c, runtime = { node: process.version, zlib: process.versions.zlib }) {
  if (c.method !== METHOD) throw new Error(`the ceilings were measured with ${JSON.stringify(c.method)}, not ${METHOD}`);
  if (c.normalized !== NORMALIZED) throw new Error(`the ceilings' gzip was measured on ${JSON.stringify(c.normalized ?? "an unnormalized sw.js")}, not ${NORMALIZED}`);
  if (c.topology !== "inventory-3span" || c.baseTopology !== "legacy-2span") throw new Error(`the ceilings name topologies ${JSON.stringify([c.topology, c.baseTopology])}, not the head's inventory-3span and the base's legacy-2span`);
  for (const k of ["node", "zlib"]) {
    if (c[k] !== runtime[k]) throw new Error(`the ceilings were measured under ${k} ${c[k]}, this is ${runtime[k]}: remeasure them (reviewed), do not regenerate`);
  }
}
/** gzip-9 of `bytes`, compressed twice: the same input must give the same output (a determinism control) */
export function gzip9(bytes, z = (b) => gzipSync(b, { level: 9 })) {
  const a = z(bytes), b = z(bytes);
  if (!a.equals(b)) throw new Error("gzip-9 is not deterministic here: the same input compressed twice differs");
  return a.length;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const check = args.includes("--check");
  const dist = args.find((a) => !a.startsWith("--")) ?? join(root, "web", "dist");
  const ceilings = readCeilings();
  assertRuntime(ceilings);
  const topo = TOPOLOGIES[ceilings.topology];
  console.log(`(${METHOD}; node ${process.version}, zlib ${process.versions.zlib}; base ${ceilings.base.slice(0, 8)}; normalized: topology ${ceilings.topology}, ${1 + topo.files.length} spans, ${16 + 64 * topo.files.length} bytes; the base's ${ceilings.baseTopology})`);
  const rows = measure(dist, ceilings);
  let over = 0;
  for (const r of rows) {
    const bad = r.value > r.cap;
    if (bad) over++;
    console.log(`${bad ? "OVER" : "ok  "} ${r.row.padEnd(32)} ${String(r.value).padStart(10)} <= ${r.cap}`);
  }
  if (check && over) {
    console.log(`offline size gate: ${over} row(s) over their ceilings (plan-b8-offline §3)`);
    process.exit(1);
  }
}
