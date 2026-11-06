// Writes test_remote_wave_cases.json: 200 random waves (a seeded generator) with the decisions src/wave-policy.ts
// makes for them, given each run entry's scripted result, so the runner's Python port
// (python/sagebrush/remote/wave_policy.py) is checked against the page's own policy, which replays the gateway's
// decisions.  Run with Node >= 23.6 (it loads the .ts directly):  node gen_remote_wave_cases.mjs
import { writeFileSync, readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
// (the repository's package.json makes a .ts CommonJS: a copy as .mts loads as an ES module, types stripped)
const copy = join(mkdtempSync(join(tmpdir(), "wave-policy-")), "wave-policy.mts");
writeFileSync(copy, readFileSync(new URL("../../src/wave-policy.ts", import.meta.url)));
const { newWaveState, waveDecide, waveRecord, waveStop, waveRunResult, waveEnvelopeInvalid } = await import(pathToFileURL(copy).href);

let seed = 0x5eed1234;
const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
const pick = (a) => a[Math.floor(rnd() * a.length)];

const cases = [];
for (let w = 0; w < 200; w++) {
  const n = 1 + Math.floor(rnd() * 8);
  const entries = [];
  for (let k = 0; k < n; k++) {
    const parents = [];
    for (let j = 0; j < k; j++) if (rnd() < 0.3) parents.push({ in: j });
    if (rnd() < 0.1) parents.push({ block: { by: "x" + k, why: pick(["exception", "error", "interrupted"]) } });
    if (rnd() < 0.1) parents.push({ stale: true });
    const desc = [];
    for (let j = k + 1; j < n; j++) if (rnd() < 0.3) desc.push(j);
    const e = { cell: "c" + k, auto: rnd() < 0.5, est: Math.floor(rnd() * 400), parents, desc, defs: ["v" + k] };
    const r = rnd();
    if (r < 0.08) e.place = "gone";
    else if (r < 0.16) { e.place = "approval"; if (rnd() < 0.5) e.note = "not approved"; }
    else if (r < 0.2) e.place = "never";
    else { e.code = "x" + k; e.mode = "python"; }
    entries.push(e);
  }
  const policy = { budget: pick([null, 0, 200, 500, 1000]), all: rnd() < 0.3 };
  const payload = { mode: "python", policy, forget: [], entries };
  if (waveEnvelopeInvalid(payload)) throw new Error("generated an invalid wave: " + waveEnvelopeInvalid(payload));
  const outcomes = entries.map(() => pick([{ status: "ok", ms: 120 }, { status: "ok", ms: 30 }, { status: "error", ms: 50 },
    { status: "error", ms: 5, ename: "KeyboardInterrupt" }, { status: "stopped", reason: "fallback" }]));
  const stopBefore = rnd() < 0.15 ? Math.floor(rnd() * n) : -1;
  const st = newWaveState();
  const decisions = [];
  for (let k = 0; k < n; k++) {
    if (k === stopBefore && !st.stopped) waveStop(st);
    const d = waveDecide(policy, st, k, entries[k]);
    decisions.push(d);
    if (d.kind === "run") waveRecord(st, k, entries[k], d, waveRunResult(outcomes[k]));
    else waveRecord(st, k, entries[k], d);
  }
  cases.push({ payload, outcomes, stopBefore, decisions });
}
writeFileSync(new URL("./test_remote_wave_cases.json", import.meta.url), JSON.stringify({ generator: "gen_remote_wave_cases.mjs", node: process.version, cases }) + "\n");
console.log(cases.length, "waves,", cases.reduce((n, c) => n + c.decisions.length, 0), "decisions");
