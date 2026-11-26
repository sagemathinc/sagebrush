// ci: checks.6 order=36
import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchOrBuild, unpublishedOnly } from "./wasm-fetch-or-build.mjs";
import { baseModules, MODULES, parsePins } from "./wasm-modules.mjs";

// (wasm-fetch.mjs's failure, as it writes it for a fetch of `total` modules: this checkout's count by default)
const failureOf = (total, ...lines) => new Error(`wasm-fetch: ${lines.length} of ${total} modules failed:\n${lines.join("\n")}`);
const failure = (...lines) => failureOf(MODULES.length, ...lines);
// (the cases below run on this checkout's module set unless they say otherwise)
const fob = (opts) => fetchOrBuild({ modulesOf: () => MODULES, ...opts });
const missing = (name) => `${name}: https://get.example/${name}.wasm: 404 https://get.example/${name}.wasm: this pin isn't published yet`;
let passed = 0;
const test = async (name, fn) => {
  await fn();
  passed++;
  console.log(`ok ${name}`);
};

await test("a successful fetch never builds", async () => {
  let builds = 0, checks = 0;
  assert.equal(await fob({ root: "/base", env: {}, fetch: async () => {}, build: () => builds++, check: () => (checks++, []) }), "fetched");
  assert.equal(builds, 0);
  assert.equal(checks, 0);
});

await test("one or several unpublished pins build once and verify every pin", async () => {
  for (const error of [failure(missing("sagebrush-engine.wasm")), failure(missing("sagebrush-engine.wasm"), missing("sagebrush-nd.wasm"))]) {
    let builds = 0, checks = 0;
    assert.equal(await fob({
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
  await assert.rejects(fob({ env: {}, fetch: async () => { throw error; }, build: () => builds++ }), (got) => got === error);
  assert.equal(builds, 0);
});

await test("a source build that differs from its pins fails closed", async () => {
  const mismatch = new Error("wasm/sagebrush-engine.wasm does not match its pin");
  await assert.rejects(fob({
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
    const got = await fob({
      root: "/base", env, log: () => {}, mark: (root) => { assert.equal(root, "/base"); assert.equal(builds, 1); marks++; },
      fetch: async () => { fetches++; },
      build: () => builds++,
      check: ({ mode }) => { assert.equal(mode, "local"); return ["sagebrush-engine.wasm: using a local build (sha256 e), not the pinned one (p)", "sagebrush-nd.wasm: pinned"]; },
    });
    assert.deepEqual([got, fetches, builds, marks], ["built-fresh", 0, 1, 1]);
  }
});

await test("a track's base whose build matches every pin is \"built\"", async () => {
  const got = await fob({ root: "/base", env: trackEnvs[0], log: () => {}, fetch: async () => {}, build: () => {}, mark: () => {}, check: () => ["a.wasm: pinned", "b.wasm: pinned"] });
  assert.equal(got, "built");
});

await test("a track's base with a missing or unidentified module still fails", async () => {
  const bad = new Error("wasm/sagebrush-nd.wasm is missing");
  await assert.rejects(fob({ root: "/base", env: trackEnvs[1], log: () => {}, fetch: async () => {}, build: () => {}, mark: () => {}, check: () => { throw bad; } }), (got) => got === bad);
});

await test("a track's pull into master is not a track base: fetched as before", async () => {
  let builds = 0;
  assert.equal(await fob({ root: "/base", env: notTrack, fetch: async () => {}, build: () => builds++, check: () => [] }), "fetched");
  assert.equal(builds, 0);
});

// (the classifier before five modules, kept to show that the cases below are real: it rejected every one of them)
const oldUnpublishedOnly = (error) => {
  const escaped = ["sagebrush-engine.wasm", "sagebrush-raster.wasm", "sagebrush-mp.wasm", "sagebrush-nd.wasm"].map((n) => n.replace(/[.]/g, "\\.")).join("|");
  const NOT_FOUND = new RegExp(`^(${escaped}): \\S+: 404(?:\\s|$)`);
  const lines = String(error?.message ?? error).split("\n");
  const header = /^wasm-fetch: ([1-4]) of 4 modules failed:$/.exec(lines[0]);
  if (!header) return false;
  const count = Number(header[1]);
  const failures = lines.slice(1);
  if (failures.length !== count || !failures.every((line) => NOT_FOUND.test(line))) return false;
  return new Set(failures.map((line) => NOT_FOUND.exec(line)[1])).size === count;
};

await test("five modules: 1, several or all of 5 unpublished are eligible (the four-module classifier refused them)", async () => {
  assert.equal(MODULES.length, 5);
  const one = failure(missing("sagebrush-skltree.wasm"));
  const two = failure(missing("sagebrush-skltree.wasm"), missing("sagebrush-engine.wasm"));
  const all = failure(...MODULES.map(missing));
  for (const e of [one, two, all]) {
    assert.equal(unpublishedOnly(e), true, e.message.split("\n")[0]);
    assert.equal(oldUnpublishedOnly(e), false, e.message.split("\n")[0]);
  }
  // and a 1-of-5 404 falls back to the source build, which then checks every pin
  let builds = 0, checked = null;
  assert.equal(await fob({ root: "/base", env: {}, log: () => {}, fetch: async () => { throw one; }, build: () => builds++, check: ({ modules }) => ((checked = modules), ["all pinned"]) }), "built");
  assert.deepEqual([builds, checked], [1, MODULES]);
});

await test("the header must be exactly the fetched set's: other totals, counts, duplicates, strangers and non-404s fail closed", async () => {
  const m = missing("sagebrush-skltree.wasm");
  // (a total other than the set's: a 4-module header for a 5-module fetch, and the reverse)
  assert.equal(unpublishedOnly(failureOf(4, missing("sagebrush-engine.wasm"))), false);
  assert.equal(unpublishedOnly(failureOf(5, missing("sagebrush-engine.wasm")), MODULES.slice(0, 4)), false);
  // (a count past the total, a count that isn't the lines', zero, the same module twice)
  assert.equal(unpublishedOnly(new Error(`wasm-fetch: 6 of 5 modules failed:\n${[...MODULES.map(missing), m].join("\n")}`)), false);
  assert.equal(unpublishedOnly(new Error(`wasm-fetch: 2 of 5 modules failed:\n${m}`)), false);
  assert.equal(unpublishedOnly(new Error("wasm-fetch: 0 of 5 modules failed:")), false);
  assert.equal(unpublishedOnly(failure(m, m)), false);
  // (a module outside the fetched set: skltree's 404 when the base fetched only four)
  assert.equal(unpublishedOnly(failureOf(4, m), MODULES.slice(0, 4)), false);
  // (one non-404 among 404s)
  assert.equal(unpublishedOnly(failure(m, "sagebrush-nd.wasm: https://get.example/y: wrong sha256")), false);
});

await test("a base that pins four modules is fetched, checked and built as four (its own set), not as this checkout's five", async () => {
  const four = MODULES.filter((n) => n !== "sagebrush-skltree.wasm");
  let fetched = null, checked = null, builds = 0;
  assert.equal(await fetchOrBuild({ root: "/base", env: {}, log: () => {}, modulesOf: () => four,
    fetch: async ({ modules }) => { fetched = modules; throw failureOf(4, missing("sagebrush-nd.wasm")); },
    build: () => builds++, check: ({ modules }) => ((checked = modules), ["all pinned"]) }), "built");
  assert.deepEqual([fetched, checked, builds], [four, four, 1]);
  // (the base's 404 of a module its own pins don't name is no reason to build)
  await assert.rejects(fetchOrBuild({ root: "/base", env: {}, log: () => {}, modulesOf: () => four, fetch: async () => { throw failureOf(4, missing("sagebrush-skltree.wasm")); }, build: () => assert.fail("built") }));
});

await test("size-base's call on a real four-module base root: its own four are fetched (the default modulesOf, reading --root's pins.json)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-base-four-"));
  try {
    mkdirSync(join(dir, "wasm"));
    const four = MODULES.filter((n) => n !== "sagebrush-skltree.wasm");
    writeFileSync(join(dir, "wasm", "pins.json"), JSON.stringify({ v: 1, modules: Object.fromEntries(four.map((n) => [n, { sha256: "0".repeat(64), bytes: 1 }])) }));
    let fetched = null;
    assert.equal(await fetchOrBuild({ root: dir, env: {}, log: () => {}, fetch: async ({ root, modules }) => { assert.equal(root, dir); fetched = modules; } }), "fetched");
    assert.deepEqual(fetched, four);
    // (and the five-module head's own root: all five)
    writeFileSync(join(dir, "wasm", "pins.json"), JSON.stringify({ v: 1, modules: Object.fromEntries(MODULES.map((n) => [n, { sha256: "0".repeat(64), bytes: 1 }])) }));
    assert.equal(await fetchOrBuild({ root: dir, env: {}, log: () => {}, fetch: async ({ modules }) => { fetched = modules; } }), "fetched");
    assert.deepEqual(fetched, MODULES);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

await test("baseModules: the base's own pinned names in this checkout's order; unknown names, no engine or no file fail closed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-base-modules-"));
  const pins = (names) => {
    mkdirSync(join(dir, "wasm"), { recursive: true });
    writeFileSync(join(dir, "wasm", "pins.json"), JSON.stringify({ v: 1, modules: Object.fromEntries(names.map((n) => [n, { sha256: "0".repeat(64), bytes: 1 }])) }));
  };
  try {
    assert.throws(() => baseModules(dir), /pins\.json/);
    pins([...MODULES].reverse());
    assert.deepEqual(baseModules(dir), MODULES);
    pins(["sagebrush-nd.wasm", "sagebrush-engine.wasm", "sagebrush-mp.wasm", "sagebrush-raster.wasm"]);
    assert.deepEqual(baseModules(dir), MODULES.filter((n) => n !== "sagebrush-skltree.wasm"));
    pins([...MODULES, "sagebrush-other.wasm"]);
    assert.throws(() => baseModules(dir), /sagebrush-other\.wasm, which this checkout's scripts don't know/);
    pins(["sagebrush-nd.wasm"]);
    assert.throws(() => baseModules(dir), /doesn't pin sagebrush-engine\.wasm/);
    // (a module named twice: JSON.parse would keep one silently; refused by its text)
    writeFileSync(join(dir, "wasm", "pins.json"), `{"v": 1, "modules": {"sagebrush-engine.wasm": {"sha256": "${"0".repeat(64)}", "bytes": 1}, "sagebrush-nd.wasm": {"sha256": "${"0".repeat(64)}", "bytes": 1}, "sagebrush-nd.wasm": {"sha256": "${"1".repeat(64)}", "bytes": 2}}}`);
    assert.throws(() => baseModules(dir), /sagebrush-nd\.wasm more than once/);
    // (the head's own pins.json likewise)
    const twice = `{"v": 1, "modules": {${[...MODULES, MODULES[1]].map((n) => `"${n}": {"sha256": "${"0".repeat(64)}", "bytes": 1}`).join(", ")}}}`;
    assert.throws(() => parsePins(twice), new RegExp(`${MODULES[1].replace(/\./g, "\\.")} more than once`));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

console.log(`test-wasm-fetch-or-build: ${passed} passed`);
