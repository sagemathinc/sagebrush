#!/usr/bin/env node
// ci: checks.3 order=110
// The offline size gate's controls (scripts/offline-size-gate.mjs): a synthetic dist exactly at every ceiling passes,
// and each of the eight rows one unit over its ceiling, alone, is refused (the gate exits 1 naming that row).
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { CAPS, METHOD, NORMALIZED, TOPOLOGIES, assertRuntime, gzip9, measure, normalizeSw, readCeilings } from "./offline-size-gate.mjs";

let failures = 0;
const ok = (c, name) => (console.log((c ? "ok   " : "FAIL ") + name), c || failures++);

// a dist whose rows are given; the inventory and sw.js are padded to exact byte counts (gzip-9 is reached by a
// deterministic search over incompressible padding length)
function pad(prefix, suffix, raw) {
  const fill = raw - Buffer.byteLength(prefix) - Buffer.byteLength(suffix);
  if (fill < 0) throw new Error("too small");
  return Buffer.from(prefix + " ".repeat(fill) + suffix);
}
function noise(n, seed) {
  let x = seed >>> 0, s = "";
  for (let i = 0; i < n; i++) {
    x = (Math.imul(x, 1103515245) + 12345) >>> 0;
    s += String.fromCharCode(97 + (x >>> 16) % 26);
  }
  return s;
}
/** bytes whose gzip-9 length (of norm(bytes), for sw.js the normalized bytes) is exactly `gz` (or the raw target `raw`) */
function sized({ prefix, suffix, raw, gz, norm = (b) => b }) {
  if (gz === undefined) return pad(prefix, suffix, raw);
  for (let n = 0; n < 1 << 20; n++) {
    const b = Buffer.from(prefix + noise(n, 7) + suffix), g = gzipSync(norm(b), { level: 9 }).length;
    if (g === gz) return b;
    if (g > gz) break;
  }
  throw new Error("no padding gives gzip " + gz);
}
const sha = (b) => createHash("sha256").update(b).digest("hex");
// (commit: what a build's commit changes, the docs index's source links, and so the inventory and VERSION)
function dist({ files = 3, stored = 300, maxEntry = 200, transfer = 100, invRaw, invGz, swRaw, swGz, commit = "c0ffee" }) {
  const d = mkdtempSync(join(tmpdir(), "offline-gate-"));
  const lazy = Array.from({ length: files }, (_, i) => `lib/g${i}.src.${String(i).padStart(16, "0")}.json`);
  const sizes = Array.from({ length: files }, () => 0);
  sizes[0] = maxEntry;
  let rest = stored - maxEntry;
  for (let i = 1; i < files && rest > 0; i++) (sizes[i] = Math.min(rest, maxEntry)), (rest -= sizes[i]);
  if (rest > 0) throw new Error("stored too large for the files");
  const docs = Buffer.from(`{"source":"https://github.com/sagemathinc/sagebrush/blob/${commit}/lib/x.py"}\n`);
  writeFileSync(join(d, "docs-index-python.json"), docs);
  const inv = `{"format":"sagebrush-offline-1","items":[],"totals":{"files":${files},"stored":${stored},"transfer":${transfer},"maxEntry":${maxEntry}},"c":"${commit}"`;
  writeFileSync(join(d, "offline-inventory.json"), sized({ prefix: inv + ',"pad":"', suffix: '"}\n', raw: invRaw ?? inv.length + 20, gz: invGz }));
  const digests = { "docs-index-python.json": { sha256: sha(docs), size: docs.length, headers: {} }, "offline-inventory.json": { sha256: sha(readFileSync(join(d, "offline-inventory.json"))), size: 1, headers: {} },
    ...Object.fromEntries(lazy.map((p, i) => [p, { sha256: "0".repeat(64), size: sizes[i], headers: {} }])) };
  const swHead = `const VERSION = "${sha(commit).slice(0, 16)}";\nconst SHELL = [];\nconst LAZY = ${JSON.stringify(lazy)};\nconst DIGESTS = ${JSON.stringify(digests)};\nconst CACHE = "sagebrush-" + VERSION;\n//`;
  const read = (n) => readFileSync(join(d, n));
  writeFileSync(join(d, "sw.js"), sized({ prefix: swHead, suffix: "\n", raw: swRaw ?? swHead.length + 10, gz: swGz, norm: (b) => normalizeSw(b, read) }));
  return d;
}
const ceilings = { swRaw: 200000, swGzip: 20000, topology: "inventory-3span" };
const rowsOf = (d) => Object.fromEntries(measure(d, ceilings).map((r) => [r.row, r]));
const run = (d, ceilFile) => spawnSync(process.execPath, [join(import.meta.dirname, "offline-size-gate.mjs"), "--check", d], { encoding: "utf8", env: { ...process.env } });

// (the gate's CLI reads web/offline-size-ceilings.json; these controls call measure() with their own ceilings, and
// check the CLI's exit status on one over-row case with the committed ceilings)
const atCap = {
  files: CAPS.files, stored: CAPS.stored, maxEntry: CAPS.maxEntry, transfer: CAPS.transfer,
  invRaw: CAPS.inventoryRaw, swRaw: ceilings.swRaw,
};
{
  const d = dist(atCap);
  const r = Object.values(rowsOf(d));
  ok(r.filter((x) => !x.row.includes("gzip")).every((x) => x.value <= x.cap), "a dist exactly at every raw ceiling passes: " + JSON.stringify(r.map((x) => [x.row, x.value, x.cap])));
  rmSync(d, { recursive: true });
}
const cases = [
  ["LAZY files", { files: CAPS.files + 1, stored: CAPS.files + 1, maxEntry: 1 }],
  ["LAZY stored bytes", { files: 5, stored: CAPS.stored + 1, maxEntry: CAPS.maxEntry }],
  ["LAZY transfer bytes (estimate)", { transfer: CAPS.transfer + 1 }],
  ["largest LAZY file", { files: 2, stored: CAPS.maxEntry + 1, maxEntry: CAPS.maxEntry + 1 }],
  ["offline-inventory.json raw", { invRaw: CAPS.inventoryRaw + 1 }],
  ["offline-inventory.json gzip-9", { invRaw: undefined, invGz: CAPS.inventoryGzip + 1 }],
  ["sw.js raw", { swRaw: ceilings.swRaw + 1 }],
  ["sw.js gzip-9 (normalized, inventory-3span)", { swGz: ceilings.swGzip + 1 }],
];
for (const [row, over] of cases) {
  const d = dist(over);
  const rows = rowsOf(d);
  const bad = Object.values(rows).filter((x) => x.value > x.cap).map((x) => x.row);
  ok(bad.length === 1 && bad[0] === row && rows[row].value === rows[row].cap + 1, `${row} one over its ceiling is refused, alone: ${JSON.stringify(bad)} ${rows[row].value}/${rows[row].cap}`);
  rmSync(d, { recursive: true });
}
// the CLI refuses (exit 1) a dist over a fixed cap, and names the row
{
  const d = dist({ files: CAPS.files + 1, stored: CAPS.files + 1, maxEntry: 1 });
  const r = run(d);
  ok(r.status === 1 && /OVER LAZY files/.test(r.stdout), "the gate's --check exits 1 and names the row: " + r.status + " " + r.stdout.split("\n")[0]);
  rmSync(d, { recursive: true });
}
// the method is bound (daybreak3): the committed ceilings name this runtime; another node, zlib or method fails closed;
// the same input compressed twice must agree
const refuses = (f, re) => { try { f(); return false; } catch (e) { return re.test(String(e)); } };
const c = readCeilings(), here = { node: process.version, zlib: process.versions.zlib };
ok(!refuses(() => assertRuntime(c), /./) && c.method === METHOD, `the committed ceilings name this runtime: ${c.method}; node ${c.node}; zlib ${c.zlib}`);
ok(refuses(() => assertRuntime(c, { ...here, node: "v24.99.0" }), /node v24\.21\.0, this is v24\.99\.0/), "another Node fails closed");
ok(refuses(() => assertRuntime(c, { ...here, zlib: "1.3.1" }), /zlib .*this is 1\.3\.1/), "another zlib fails closed");
ok(refuses(() => assertRuntime({ ...c, method: "gzip -9c" }), /measured with "gzip -9c"/), "ceilings measured with another method are refused");
const sample = Buffer.from(noise(50000, 3));
ok(gzip9(sample) === gzipSync(sample, { level: 9 }).length && gzip9(sample) === gzip9(sample), "gzip-9 of the same input, repeated, is the same");
let flip = 0;
ok(refuses(() => gzip9(sample, (b) => gzipSync(b, { level: ++flip % 2 ? 9 : 1 })), /not deterministic/), "a compressor whose output varies is refused");
ok(!refuses(() => assertRuntime(c), /./) && c.normalized === NORMALIZED, "the committed ceilings name the normalization: " + c.normalized);
ok(refuses(() => assertRuntime({ ...c, normalized: undefined }), /unnormalized/), "ceilings without the normalization are refused");
ok(c.topology === "inventory-3span" && c.baseTopology === "legacy-2span", "the committed ceilings pin the topologies: head inventory-3span, base legacy-2span");
for (const [k, v] of [["topology", undefined], ["topology", "legacy-2span"], ["baseTopology", undefined], ["baseTopology", "inventory-3span"]]) ok(refuses(() => assertRuntime({ ...c, [k]: v }), /name topologies/), `ceilings with ${k} ${v ?? "absent"} are refused`);

// Rule A (daybreak3): the normalization
{
  const a = dist({ commit: "aaaaaaa1" }), b = dist({ commit: "bbbbbbb2" });
  const rd = (d) => (n) => readFileSync(join(d, n)), swOf = (d) => readFileSync(join(d, "sw.js"));
  const na = normalizeSw(swOf(a), rd(a)), nb = normalizeSw(swOf(b), rd(b));
  ok(!swOf(a).equals(swOf(b)) && na.equals(nb) && rowsOf(a)["sw.js gzip-9 (normalized, inventory-3span)"].value === rowsOf(b)["sw.js gzip-9 (normalized, inventory-3span)"].value, "the same tree built at two commits: different sw.js, the same normalized bytes and gzip");
  // (exactly three spans, 144 bytes, are touched: every differing byte lies in them, and their lengths are 16 + 64 + 64)
  const sw = swOf(a), t = sw.toString("utf8");
  const spans = [[t.indexOf('const VERSION = "') + 17, 16], [t.indexOf('"docs-index-python.json":{"sha256":"') + 36, 64], [t.indexOf('"offline-inventory.json":{"sha256":"') + 36, 64]];
  const inSpan = (i) => spans.some(([s0, n]) => i >= s0 && i < s0 + n);
  let outside = 0, zeroed = 0;
  for (let i = 0; i < sw.length; i++) { if (sw[i] !== na[i] && !inSpan(i)) outside++; if (inSpan(i) && na[i] === 0x30) zeroed++; }
  ok(outside === 0 && zeroed === 144 && na.length === sw.length, `only the three spans (144 bytes) are zeroed; every other byte (DIGESTS, sizes, headers, inventory, code) untouched: ${outside} outside, ${zeroed} zeroed`);
  // (a byte changed outside the spans survives; a constructed growth moves the gzip and exceeds a cap)
  const m = Buffer.from(sw); m[m.length - 2] ^= 1;
  ok(!normalizeSw(m, rd(a)).equals(na), "a byte changed outside the spans survives the normalization");
  const grown = Buffer.concat([sw.subarray(0, sw.length - 1), Buffer.from("//" + noise(400, 9) + "\n")]);
  ok(gzip9(normalizeSw(grown, rd(a))) > gzip9(na), "a constructed growth outside the spans moves the normalized gzip");
  // (every malformed, missing, repeated or mismatched field fails closed)
  const bad = (name, f, re) => ok(refuses(() => normalizeSw(Buffer.from(f(t)), rd(a)), re), "refused: " + name);
  bad("no VERSION", (s) => s.replace(/const VERSION = "[^"]*";/, ""), /0 VERSION declarations/);
  bad("two VERSIONs", (s) => s + 'const VERSION = "0123456789abcdef";\n', /2 VERSION declarations/);
  bad("a VERSION of 15 hex", (s) => s.replace(/(const VERSION = ")[0-9a-f]/, "$1"), /not 16 hex/);
  bad("a VERSION of 16 non-hex", (s) => s.replace(/const VERSION = "[0-9a-f]{16}"/, 'const VERSION = "ZZZZZZZZZZZZZZZZ"'), /not 16 hex/);
  bad("no canonical cache-name derivation", (s) => s.replace('const CACHE = "sagebrush-" + VERSION;', 'const CACHE = "sagebrush-x";'), /0 canonical cache-name derivations/);
  bad("two canonical cache-name derivations", (s) => s + 'const CACHE = "sagebrush-" + VERSION;\n', /2 canonical cache-name derivations/);
  ok(!refuses(() => normalizeSw(Buffer.from(t + "self.v = VERSION; self.w = VERSION;\n"), rd(a)), /./), "VERSION's other uses are not restricted");
  // (no other 16-hex literal changes: every 16-hex run outside VERSION's declaration is byte-identical, in place)
  {
    const withHex = Buffer.from(t + "//a1b2c3d4e5f60718 ?h=0f1e2d3c4b5a6978\n"), nn = normalizeSw(withHex, rd(a)).toString("latin1"), ww = withHex.toString("latin1");
    const vAt = ww.indexOf('const VERSION = "') + 17;
    const dSpans = ["docs-index-python.json", "offline-inventory.json"].map((n) => ww.indexOf(`"${n}":{"sha256":"`) + n.length + 14);
    const others = [...ww.matchAll(/[0-9a-f]{16}/g)].filter((m) => m.index !== vAt && !dSpans.some((d) => m.index >= d && m.index < d + 64));
    ok(others.length >= 2 && others.every((m) => nn.slice(m.index, m.index + 16) === m[0]) && nn.slice(vAt, vAt + 16) === "0".repeat(16), `every other 16-hex literal is unchanged (${others.length} checked), only VERSION's 16 bytes are zeroed`);
  }
  for (const n of ["docs-index-python.json", "offline-inventory.json"]) {
    const q = n.replace(/[.]/g, "\\.");
    bad(`no DIGESTS entry for ${n}`, (s) => s.replace(`"${n}":{"sha256":`, `"x${n}":{"sha256":`), new RegExp(`0 DIGESTS entries for ${q}`));
    bad(`two DIGESTS entries for ${n}`, (s) => s + `//"${n}":{"sha256":"${"a".repeat(64)}"\n`, new RegExp(`2 DIGESTS entries for ${q}`));
    bad(`a sha256 of 63 hex for ${n}`, (s) => s.replace(new RegExp(`("${q}":\\{"sha256":")[0-9a-f]`), "$1"), /not 64 hex/);
    bad(`a sha256 not ${n}'s`, (s) => s.replace(new RegExp(`("${q}":\\{"sha256":")[0-9a-f]{64}`), "$1" + "f".repeat(64)), /not its dist file's/);
  }
  // (the topology is pinned per ceiling record, never inferred, daybreak3: inventory-3span needs the inventory's file
  // and entry, legacy-2span needs both absent; any mismatch or an unknown topology fails closed)
  {
    const noEntry = (s) => s.replace(/"offline-inventory\.json":\{"sha256":"[0-9a-f]{64}","size":1,"headers":\{\}\},/, "");
    const rdNoFile = (n) => { if (n === "offline-inventory.json") throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); return rd(a)(n); };
    ok(noEntry(t) !== t, "(the fixture's inventory entry can be removed)");
    ok(refuses(() => normalizeSw(sw, rdNoFile, "inventory-3span"), /ENOENT/), "inventory-3span: the inventory's file deleted fails closed");
    ok(refuses(() => normalizeSw(Buffer.from(noEntry(t)), rd(a), "inventory-3span"), /0 DIGESTS entries for offline-inventory/), "inventory-3span: the inventory's entry deleted fails closed (never a fallback to legacy-2span)");
    ok(refuses(() => normalizeSw(Buffer.from(noEntry(t)), rdNoFile, "inventory-3span"), /0 DIGESTS entries for offline-inventory/), "inventory-3span: both deleted fails closed");
    ok(refuses(() => normalizeSw(sw, rd(a), "legacy-2span"), /must be absent \(its DIGESTS entries: 1; its file: present\)/), "legacy-2span: the inventory present (entry and file) fails closed");
    ok(refuses(() => normalizeSw(Buffer.from(noEntry(t)), rd(a), "legacy-2span"), /must be absent \(its DIGESTS entries: 0; its file: present\)/), "legacy-2span: the inventory's file present fails closed");
    ok(refuses(() => normalizeSw(sw, rdNoFile, "legacy-2span"), /must be absent \(its DIGESTS entries: 1; its file: absent\)/), "legacy-2span: the inventory's entry present fails closed");
    const legacy = normalizeSw(Buffer.from(noEntry(t)), rdNoFile, "legacy-2span"), lt = noEntry(t);
    let zeroedL = 0, changedL = 0;
    for (let i = 0; i < legacy.length; i++) if (legacy[i] !== Buffer.from(lt)[i]) changedL++;
    const v0 = lt.indexOf('const VERSION = "') + 17, d0 = lt.indexOf('"docs-index-python.json":{"sha256":"') + 36;
    zeroedL = [...legacy.subarray(v0, v0 + 16), ...legacy.subarray(d0, d0 + 64)].filter((x) => x === 0x30).length;
    ok(zeroedL === 80 && changedL <= 80, `legacy-2span with both absent: 2 spans, 80 bytes zeroed (${zeroedL}; ${changedL} changed)`);
    ok(refuses(() => normalizeSw(sw, rd(a), "inventory-4span"), /unknown normalization topology/), "an unknown topology fails closed");
    ok(Object.keys(TOPOLOGIES).join(",") === "legacy-2span,inventory-3span", "exactly the two topologies exist");
  }
  writeFileSync(join(a, "docs-index-python.json"), "changed");
  ok(refuses(() => normalizeSw(sw, rd(a)), /docs-index-python\.json is not its dist file's/), "refused: the dist file changed after the build");
  rmSync(a, { recursive: true }); rmSync(b, { recursive: true });
}
if (failures) {
  console.log(`${failures} failure(s)`);
  process.exit(1);
}
console.log("offline size gate controls: all pass");
