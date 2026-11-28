// ci: checks.6 order=37
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { optionalModules } from "./optional-wasm.mjs";
import { MODULES } from "./wasm-modules.mjs";

// (the header wasm-fetch.mjs writes: N of every pinned module, MODULES)
const failure = (...lines) => new Error(`wasm-fetch: ${lines.length} of ${MODULES.length} modules failed:\n${lines.join("\n")}`);
const unpublished = (name) => `${name}: https://get.sagebrush.space/wasm/sha256/${"a".repeat(64)}.wasm: 404 (not published): this pin isn't published yet`;
const throws = (error) => async () => { throw error; };
const run = (fetch, env) => optionalModules({ fetch, env, log: () => {} });

const intoTrack = { GITHUB_EVENT_NAME: "pull_request", GITHUB_BASE_REF: "track/math", GITHUB_HEAD_REF: "x" };
const pushTrack = { GITHUB_EVENT_NAME: "push", GITHUB_REF_NAME: "track/math" };
const intoMaster = { GITHUB_EVENT_NAME: "pull_request", GITHUB_BASE_REF: "master", GITHUB_HEAD_REF: "x" };
const trackIntoMaster = { GITHUB_EVENT_NAME: "pull_request", GITHUB_BASE_REF: "master", GITHUB_HEAD_REF: "track/math" };
const schedule = { GITHUB_EVENT_NAME: "schedule", GITHUB_REF_NAME: "master" };

// published: fetched, anywhere
for (const env of [intoTrack, intoMaster, schedule]) assert.equal(await run(async () => [], env), "fetched");

// on a track, an unpublished pin (one, or several) skips the tests
const one = failure(unpublished("sagebrush-engine.wasm"));
const two = failure(unpublished("sagebrush-engine.wasm"), unpublished("sagebrush-mp.wasm"));
for (const env of [intoTrack, pushTrack]) {
  assert.equal(await run(throws(one), env), "skipped");
  assert.equal(await run(throws(two), env), "skipped");
}

// off a track, the same 404 fails: master's pins are published, and a track's pull into master is strict
for (const env of [intoMaster, trackIntoMaster, schedule, {}]) await assert.rejects(run(throws(one), env), /404/);

// on a track, anything but 404s only fails: a network error, a corrupt object, a 404 mixed with another failure
const network = failure("sagebrush-engine.wasm: https://x/y.wasm: fetch failed (ECONNRESET)");
const corrupt = failure("sagebrush-mp.wasm: https://x/y.wasm: sha256 mismatch");
const mixed = failure(unpublished("sagebrush-engine.wasm"), "sagebrush-mp.wasm: https://x/y.wasm: 503");
const local = failure("sagebrush-engine.wasm: wasm/sagebrush-engine.wasm matches neither its pin, a local build's sidecar nor an earlier fetch: rerun with --force to replace it");
for (const error of [network, corrupt, mixed, local, new Error("the whole run took more than 240 s")]) {
  await assert.rejects(run(throws(error), intoTrack), (e) => e === error);
}

// the workflow: every step after the fetch is skipped when it says skip, and nothing else fetches the modules
const yml = readFileSync(new URL("../.github/workflows/optional.yml", import.meta.url), "utf8");
const steps = yml.slice(yml.indexOf("\n    steps:\n")).split("\n      - ").slice(1);
const at = steps.findIndex((s) => s.includes("run: node scripts/optional-wasm.mjs"));
assert.ok(at > 0 && /\bid: wasm\b/.test(steps[at]), "optional.yml fetches the modules with scripts/optional-wasm.mjs (id: wasm)");
assert.ok(!yml.includes("./.github/actions/wasm-modules") && !yml.includes("wasm-fetch.mjs"), "optional.yml fetches only through optional-wasm.mjs");
for (const s of steps.slice(at + 1)) assert.ok(s.includes("if: steps.wasm.outputs.skip != 'true'"), `not skipped with the modules: ${s.split("\n")[0]}`);
console.log("optional-wasm: all passed");
