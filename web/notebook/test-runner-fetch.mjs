// G-10's unit cases (plan r2..r2.3.1): the zone data index's closed grammar (parseTzIndex), each bound by its own
// case, on fixtures made from the built index with exactly one change; the build's check that a bundle with the
// runner lacks no list (G7); and the list itself against what the built worker can ask for (G9). After the web
// build:   bun web/build.ts && bun web/notebook/test-runner-fetch.mjs (bun: runner-worker.js is an ES module, which
// node reads as CommonJS under the root package.json, as the other unit tests here)
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseTzIndex } from "./runner-worker.js";
import { checkRunnerDefine, runnerFetchList } from "../runner-fetch.mts";

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, "..", "dist");
let failures = 0;
const ok = (c, msg) => { console.log((c ? "ok   " : "FAIL ") + msg); if (!c) failures++; };
const enc = (o) => new TextEncoder().encode(typeof o === "string" ? o : JSON.stringify(o));

const tzDir = join(dist, "lib", "tzdata");
const indexFile = readdirSync(tzDir).find((f) => /^index-[0-9a-f]{64}\.json$/.test(f));
const realBytes = new Uint8Array(readFileSync(join(tzDir, indexFile)));
const real = JSON.parse(new TextDecoder().decode(realBytes));
const names = Object.keys(real.zones);
// (one zone renamed, keeping its value and every other entry)
const renamed = (from, to) => ({ ...real, zones: Object.fromEntries(Object.entries(real.zones).map(([k, v]) => [k === from ? to : k, v])) });
const z0 = names[0];

// G13 (unit): the real index admits exactly its distinct zone files, each of them in dist
{
  const set = parseTzIndex(realBytes);
  const distinct = new Set(Object.values(real.zones));
  const files = readdirSync(tzDir).filter((f) => f.endsWith(".tzif")).map((f) => `lib/tzdata/${f}`);
  ok(set !== null && set.size === distinct.size && [...set].every((u) => files.includes(u)) && files.length === set.size, `G13: the real index (${names.length} zones) admits exactly its ${distinct.size} distinct zone files, each in dist/lib/tzdata`);
}
// G11u: the tampered index of G11 (one hex digit of ANOTHER zone's value) still parses, and still lists the zone
// G11 asks for, so in G11 it is the hash check that refuses it
{
  const asked = "Europe/Paris";
  const other = names.find((k) => k !== asked && real.zones[k] !== real.zones[asked]);
  const v = real.zones[other];
  const t = { ...real, zones: { ...real.zones, [other]: (v[0] === "0" ? "1" : "0") + v.slice(1) } };
  const set = parseTzIndex(enc(t));
  ok(set !== null && set.has(`lib/tzdata/${real.zones[asked]}.tzif`), "G11u: G11's tampered index parses, and lists the zone G11 asks for");
}
const refuses = (id, what, bytes) => ok(parseTzIndex(bytes) === null, `${id}: ${what}: refused`);
// G12a: 262,145 bytes, a valid index padded with spaces
{
  const s = JSON.stringify(real);
  refuses("G12a", "262,145 bytes (the real index padded with spaces)", enc(s + " ".repeat(262145 - enc(s).length)));
  ok(parseTzIndex(enc(s + " ".repeat(262144 - enc(s).length))) !== null, "G12a's edge: 262,144 bytes of the same are accepted");
}
// G12b: 2,001 entries, each a real value, about 160 KB
{
  const vals = Object.values(real.zones);
  const zones = Object.fromEntries(Array.from({ length: 2001 }, (_, i) => [`Zz/${String(i).padStart(4, "0")}`, vals[i % vals.length]]));
  const b = enc({ ...real, zones });
  ok(b.length < 262144, `G12b's fixture is under the byte bound (${b.length} B)`);
  refuses("G12b", "2,001 zones", b);
}
refuses("G12c", "a name `../x`", enc(renamed(z0, "../x")));
{
  const v = real.zones[z0];
  const i = [...v].findIndex((ch) => /[a-f]/.test(ch));
  refuses("G12d", "a value with one uppercase hex digit", enc({ ...real, zones: { ...real.zones, [z0]: v.slice(0, i) + v[i].toUpperCase() + v.slice(i + 1) } }));
}
refuses("G12e1", "an extra top-level key", enc({ ...real, x: 1 }));
refuses("G12e2", "format \"sagebrush-tzdata2\"", enc({ ...real, format: "sagebrush-tzdata2" }));
refuses("G12f", "bytes that aren't JSON", enc(JSON.stringify(real).slice(0, -1)));
// G12g: 10 valid entries, then one bad one: nothing at all comes back (whole or nothing)
{
  const zones = Object.fromEntries(names.slice(0, 10).map((k) => [k, real.zones[k]]));
  zones["../bad"] = real.zones[z0];
  refuses("G12g", "10 valid entries then a bad one", enc({ ...real, zones }));
}
refuses("G12h", "a name of 65 characters", enc(renamed(z0, "America/" + "a".repeat(57))));
ok(parseTzIndex(enc(renamed(z0, "America/" + "a".repeat(56)))) !== null, "G12h's edge: a name of 64 characters is accepted");
refuses("G12i", "a version of 33 characters", enc({ ...real, version: "a".repeat(33) }));
refuses("G12j", "a version with a space", enc({ ...real, version: "2026 5" }));
refuses("G12k", "a name `/etc`", enc(renamed(z0, "/etc")));
refuses("G12l", "no zones", enc({ ...real, zones: {} }));
{
  const s = JSON.stringify(renamed(z0, "Europe/XQY"));
  const b = enc(s);
  const at = s.indexOf("Europe/XQY") + "Europe/X".length;
  b[at] = 0xff; // (one byte that isn't UTF-8, in a name)
  refuses("G12m", "a byte 0xFF in a name", b);
}
ok(parseTzIndex(realBytes) !== null, "the real index itself is accepted");

// G7: the build's check, on a fixture: a bundle with runner-worker.js, built without the list, fails the build
{
  let threw = null;
  try { checkRunnerDefine("a fixture", ["web/notebook/runner-worker.js", "web/notebook/index.js"], ["const L = __SB_RUNNER_FETCH__;"]); } catch (e) { threw = e.message; }
  ok(threw !== null && /without __SB_RUNNER_FETCH__/.test(threw), "G7: a bundle with runner-worker.js and no list fails the build: " + threw);
  let none = null;
  try { checkRunnerDefine("a fixture", ["web/notebook/runner-worker.js"], ['const L = {"files":[]};']); checkRunnerDefine("a fixture", ["web/other.js"], ["__SB_RUNNER_FETCH__"]); } catch (e) { none = e.message; }
  ok(none === null, "G7: a bundle with the list, and one without the runner, pass the check");
}

// G9: dist/runner-fetch.json is exactly what the built worker can ask for (the static half: the two wasm ?h=, the
// ordinary chunks, the index by name and SHA-256), and each built bundle with the runner carries it
{
  const list = JSON.parse(readFileSync(join(dist, "runner-fetch.json"), "utf8"));
  const sha = (f) => createHash("sha256").update(readFileSync(f)).digest("hex");
  const engine = sha(join(here, "..", "..", "wasm", "sagebrush-engine.wasm")), raster = sha(join(here, "..", "..", "wasm", "sagebrush-raster.wasm"));
  const chunks = readdirSync(join(dist, "lib")).filter((f) => /\.[0-9a-f]{16}\.json$/.test(f)).map((f) => `lib/${f}`);
  const want = runnerFetchList(engine, raster, chunks, { file: `lib/tzdata/${indexFile}`, sha256: sha(join(tzDir, indexFile)) });
  const same = (a, b) => a.length === b.length && [...a].sort().every((x, i) => x === [...b].sort()[i]);
  ok(same(list.files, want.files) && list.tzIndex?.file === want.tzIndex.file && list.tzIndex?.sha256 === want.tzIndex.sha256, `G9: dist/runner-fetch.json is exactly the built worker's files (${list.files.length} URLs and the index)`);
  // (the bundles that contain runner-worker.js: those with its NOT_RUN text; each must carry every URL of the list,
  // and no chunk name outside it)
  const marker = "the sandboxed runner didn't start";
  const bundles = [];
  const walk = (d) => { for (const f of readdirSync(d, { withFileTypes: true })) { const p = join(d, f.name); if (f.isDirectory()) walk(p); else if (/\.(js|html)$/.test(f.name)) bundles.push(p); } };
  walk(dist);
  const carriers = bundles.filter((p) => readFileSync(p, "utf8").includes(marker));
  const bad = carriers.filter((p) => { const t = readFileSync(p, "utf8"); return !want.files.every((u) => t.includes(u)) || !t.includes(want.tzIndex.sha256) || (t.match(/lib\/[\w.-]+\.[0-9a-f]{16}\.json/g) ?? []).some((u) => !want.files.includes(u)); });
  ok(carriers.length >= 3 && bad.length === 0, `G9: each of the ${carriers.length} built bundles with the runner carries exactly the list${bad.length ? ": not " + bad.map((p) => p.slice(dist.length + 1)).join(", ") : ""}`);
}

console.log(failures ? `${failures} FAILED` : "all passed");
process.exit(failures ? 1 : 0);
