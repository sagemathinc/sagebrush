// ci: checks.1 order=40
// web/build-time.mjs: version.json's `built` is SOURCE_DATE_EPOCH's instant when set (the same bytes on every build of
// one commit), the current time when unset or empty, and a malformed value throws.
//   node web/test-build-time.mjs
import { readFileSync } from "node:fs";
import { builtAt } from "./build-time.mjs";

let failures = 0;
const ok = (c, what) => (c ? console.log("ok  ", what) : (failures++, console.log("FAIL", what)));
const throws = (f) => { try { f(); return false; } catch { return true; } };
const fixed = () => new Date("2030-01-02T03:04:05.678Z");

ok(builtAt({ SOURCE_DATE_EPOCH: "1794910000" }, fixed) === "2026-11-17T10:06:40.000Z", "SOURCE_DATE_EPOCH set: its instant, not the clock");
ok(builtAt({ SOURCE_DATE_EPOCH: "1794910000" }) === builtAt({ SOURCE_DATE_EPOCH: "1794910000" }), "SOURCE_DATE_EPOCH set: the same value on every call");
ok(builtAt({ SOURCE_DATE_EPOCH: "0" }, fixed) === "1970-01-01T00:00:00.000Z", "SOURCE_DATE_EPOCH 0: the epoch");
ok(builtAt({}, fixed) === "2030-01-02T03:04:05.678Z", "unset: the current time");
ok(builtAt({ SOURCE_DATE_EPOCH: "" }, fixed) === "2030-01-02T03:04:05.678Z", "empty: the current time");
for (const bad of ["-1", "1.5", "17949e5", " 1794910000", "now", "9999999999999"]) ok(throws(() => builtAt({ SOURCE_DATE_EPOCH: bad }, fixed)), `malformed ${JSON.stringify(bad)}: throws`);
// (and web/build.ts writes version.json's `built` with it: running the whole build here would take minutes)
const build = readFileSync(new URL("./build.ts", import.meta.url), "utf8");
ok(/^    built: builtAt\(\),$/m.test(build) && !/new Date\(\)\.toISOString\(\)/.test(build.slice(build.indexOf("version.json\"), JSON.stringify("))), "web/build.ts writes `built` with builtAt()");

console.log(failures ? `${failures} FAILED` : "all passed");
process.exit(failures ? 1 : 0);
