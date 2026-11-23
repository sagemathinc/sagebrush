// ci: checks.6 order=36
import { strict as assert } from "node:assert";
import { fetchOrBuild, unpublishedOnly } from "./wasm-fetch-or-build.mjs";

const failure = (...lines) => new Error(`wasm-fetch: ${lines.length} of 4 modules failed:\n${lines.join("\n")}`);
const missing = (name) => `${name}: https://get.example/${name}.wasm: 404 https://get.example/${name}.wasm: this pin isn't published yet`;
let passed = 0;
const test = async (name, fn) => {
  await fn();
  passed++;
  console.log(`ok ${name}`);
};

await test("a successful fetch never builds", async () => {
  let builds = 0, checks = 0;
  assert.equal(await fetchOrBuild({ root: "/base", env: {}, fetch: async () => {}, build: () => builds++, check: () => (checks++, []) }), "fetched");
  assert.equal(builds, 0);
  assert.equal(checks, 0);
});

await test("one or several unpublished pins build once and verify every pin", async () => {
  for (const error of [failure(missing("sagebrush-engine.wasm")), failure(missing("sagebrush-engine.wasm"), missing("sagebrush-nd.wasm"))]) {
    let builds = 0, checks = 0;
    assert.equal(await fetchOrBuild({
      root: "/base",
      env: {},
      fetch: async () => { throw error; },
      build: (root) => { assert.equal(root, "/base"); builds++; },
      check: ({ root, mode }) => { assert.deepEqual([root, mode], ["/base", "pinned"]); checks++; return ["all pinned"]; },
      log: () => {},
    }), "built");
    assert.deepEqual([builds, checks], [1, 1]);
  }
});

await test("only a well-formed set of 404 failures is eligible", async () => {
  assert.equal(unpublishedOnly(failure(missing("sagebrush-engine.wasm"))), true);
  assert.equal(unpublishedOnly(failure("sagebrush-engine.wasm: https://get.example/x: 500 origin failed")), false);
  assert.equal(unpublishedOnly(failure(missing("sagebrush-engine.wasm"), "sagebrush-nd.wasm: https://get.example/y: 500 origin failed")), false);
  assert.equal(unpublishedOnly(new Error("404")), false);
});

await test("non-404 fetch failures fail without a build", async () => {
  const error = failure("sagebrush-engine.wasm: https://get.example/x: wrong sha256");
  let builds = 0;
  await assert.rejects(fetchOrBuild({ env: {}, fetch: async () => { throw error; }, build: () => builds++ }), (got) => got === error);
  assert.equal(builds, 0);
});

await test("a source build that differs from its pins fails closed", async () => {
  const mismatch = new Error("wasm/sagebrush-engine.wasm does not match its pin");
  await assert.rejects(fetchOrBuild({
    env: {},
    fetch: async () => { throw failure(missing("sagebrush-engine.wasm")); },
    build: () => {},
    check: () => { throw mismatch; },
    log: () => {},
  }), (got) => got === mismatch);
});

const trackEnvs = [
  { GITHUB_EVENT_NAME: "pull_request", GITHUB_BASE_REF: "track/math", GITHUB_HEAD_REF: "r6" },
  { GITHUB_EVENT_NAME: "push", GITHUB_REF_NAME: "track/math" },
];
const notTrack = { GITHUB_EVENT_NAME: "pull_request", GITHUB_BASE_REF: "master", GITHUB_HEAD_REF: "track/math" };

await test("a track's base is built from source, never fetched, and a fresh build is labelled, not refused", async () => {
  for (const env of trackEnvs) {
    let fetches = 0, builds = 0, marks = 0;
    const got = await fetchOrBuild({
      root: "/base", env, log: () => {}, mark: (root) => { assert.equal(root, "/base"); assert.equal(builds, 1); marks++; },
      fetch: async () => { fetches++; },
      build: () => builds++,
      check: ({ mode }) => { assert.equal(mode, "local"); return ["sagebrush-engine.wasm: using a local build (sha256 e), not the pinned one (p)", "sagebrush-nd.wasm: pinned"]; },
    });
    assert.deepEqual([got, fetches, builds, marks], ["built-fresh", 0, 1, 1]);
  }
});

await test("a track's base whose build matches every pin is \"built\"", async () => {
  const got = await fetchOrBuild({ root: "/base", env: trackEnvs[0], log: () => {}, fetch: async () => {}, build: () => {}, mark: () => {}, check: () => ["a.wasm: pinned", "b.wasm: pinned"] });
  assert.equal(got, "built");
});

await test("a track's base with a missing or unidentified module still fails", async () => {
  const bad = new Error("wasm/sagebrush-nd.wasm is missing");
  await assert.rejects(fetchOrBuild({ root: "/base", env: trackEnvs[1], log: () => {}, fetch: async () => {}, build: () => {}, mark: () => {}, check: () => { throw bad; } }), (got) => got === bad);
});

await test("a track's pull into master is not a track base: fetched as before", async () => {
  let builds = 0;
  assert.equal(await fetchOrBuild({ root: "/base", env: notTrack, fetch: async () => {}, build: () => builds++, check: () => [] }), "fetched");
  assert.equal(builds, 0);
});

console.log(`test-wasm-fetch-or-build: ${passed} passed`);
