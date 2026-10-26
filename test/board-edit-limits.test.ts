import test from "node:test";
import assert from "node:assert/strict";
import { CAPS, defaultLimits, resolveLimits, limitsHelp, ENV_PREFIX } from "../src/board-edit-limits";

// `board open --edit`'s caps (plan-board-open-edit r7 §8.1): 26 values, each in an inclusive range that
// can't be changed; validated as one set before the server listens.
const ok = (flags: string[], env: Record<string, string> = {}) => {
  const r = resolveLimits(flags, env);
  assert.ok("limits" in r, "error" in r ? r.error : "");
  return (r as { limits: Record<string, number> }).limits;
};
const refused = (flags: string[], env: Record<string, string> = {}, re?: RegExp) => {
  const r = resolveLimits(flags, env);
  assert.ok("error" in r, `expected a refusal for ${flags.join(" ")} ${JSON.stringify(env)}`);
  if (re) assert.match((r as { error: string }).error, re);
};

test("board open limits: 26 caps, their defaults valid", () => {
  assert.equal(CAPS.length, 26);
  assert.equal(new Set(CAPS.map((c) => c.name)).size, 26);
  assert.deepEqual(ok([]), defaultLimits());
  assert.equal(limitsHelp().split("\n").length, 26);
});

// (the other caps a value needs to pass the cross-field checks: kept compatible, so only the cap under test decides)
const companions = (name: string, v: number): string[] => {
  const MiB = 1024 * 1024;
  switch (name) {
    case "FILE_MAX": return [`EDIT_MAX=${Math.min(v, 16 * MiB)}`, `BODY_MAX=${Math.min(v, 16 * MiB)}`];
    case "EDIT_MAX": return [`BODY_MAX=${Math.min(v, 16 * MiB)}`, `MEMORY_MAX=${Math.max(1024 * MiB, 8 * v)}`, `MERGE_WORK=${Math.max(250_000_000, 8 * v)}`];
    case "MERGE_WORK": return [`EDIT_MAX=${Math.max(64 * 1024, Math.min(16 * MiB, Math.floor(v / 8)))}`, `BODY_MAX=${Math.max(64 * 1024, Math.min(16 * MiB, Math.floor(v / 8)))}`];
    case "MEMORY_MAX": return [`EDIT_MAX=${Math.min(16 * MiB, Math.floor(v / 8))}`, `BODY_MAX=${Math.max(64 * 1024, Math.min(16 * MiB, Math.floor(v / 36)))}`, `QUEUE_BYTES=${Math.min(64 * MiB, Math.floor(v / 2))}`];
    case "SAVE_QUIET_MS": return [`SAVE_MAX_DELAY_MS=${Math.max(5000, v)}`];
    default: return [];
  }
};

test("board open limits: each cap at its exact bounds, and one past them", () => {
  for (const c of CAPS) {
    for (const [bound, step] of [[c.min, -1], [c.max, 1]] as const) {
      if (typeof bound !== "number") continue; // (a bound naming another cap: the cross-field test)
      // (FILE_MAX's and EDIT_MAX's 1 KiB minimum can't be met: BODY_MAX >= 64 KiB <= EDIT_MAX <= FILE_MAX)
      if ((c.name === "FILE_MAX" || c.name === "EDIT_MAX") && step < 0) continue;
      ok([`${c.name}=${bound}`, ...companions(c.name, bound)]);
      if (bound + step >= 0) refused([`${c.name}=${bound + step}`, ...companions(c.name, bound + step)], {}, /out of its range/);
    }
  }
});

test("board open limits: FILE_MAX and EDIT_MAX can't go below BODY_MAX's 64 KiB minimum", () => {
  // (the table's 1 KiB minimum for both is below what the cross-field checks allow: their effective minimum is
  // 64 KiB, reported for the reviewers; nothing below it is accepted)
  ok(["FILE_MAX=65536", "EDIT_MAX=65536", "BODY_MAX=65536"]);
  refused(["FILE_MAX=65535", "EDIT_MAX=65535", "BODY_MAX=65535"], {}, /BODY_MAX/);
  refused(["FILE_MAX=1024", "EDIT_MAX=1024", "BODY_MAX=1024"], {}, /BODY_MAX/);
});

test("board open limits: the cross-field checks, at their exact bounds", () => {
  ok(["BODY_MAX=16777216", "EDIT_MAX=16777216"]);
  refused(["BODY_MAX=16777217", "EDIT_MAX=16777216"], {}, /BODY_MAX/);
  ok(["EDIT_MAX=67108864", "BODY_MAX=65536", "FILE_MAX=67108864", "MERGE_WORK=536870912"]);
  refused(["EDIT_MAX=67108865", "BODY_MAX=65536", "FILE_MAX=67108864", "MERGE_WORK=1073741824"], {}, /EDIT_MAX/);
  ok(["SAVE_QUIET_MS=5000", "SAVE_MAX_DELAY_MS=5000"]);
  refused(["SAVE_QUIET_MS=5001", "SAVE_MAX_DELAY_MS=5000"], {}, /SAVE_MAX_DELAY_MS/);
  ok(["MEMORY_MAX=134217728", "EDIT_MAX=16777216", "BODY_MAX=65536"]);
  refused(["MEMORY_MAX=134217727", "EDIT_MAX=16777216", "BODY_MAX=65536", "QUEUE_BYTES=1048576"], {}, /8 x EDIT_MAX/);
  // (daybreak3, Oct 24: an edit of a board EDIT_MAX allows fits MERGE_WORK; EDIT_MAX's whole range reachable)
  ok(["MERGE_WORK=134217728", "EDIT_MAX=16777216"]);
  refused(["MERGE_WORK=134217727", "EDIT_MAX=16777216"], {}, /8 x EDIT_MAX/);
  ok(["FILE_MAX=134217728", "EDIT_MAX=134217728", "MEMORY_MAX=1073741824", "MERGE_WORK=1073741824"]);
  refused(["FILE_MAX=134217728", "EDIT_MAX=134217728", "MEMORY_MAX=1073741824", "MERGE_WORK=1073741823"], {}, /MERGE_WORK/);
  // (addendum 2: a body of BODY_MAX bytes never too large for the ledger as such)
  ok(["MEMORY_MAX=603979776", "BODY_MAX=16777216"]);
  refused(["MEMORY_MAX=603979775", "BODY_MAX=16777216"], {}, /36 x BODY_MAX/);
  ok(["QUEUE_BYTES=536870912"]);
  refused(["QUEUE_BYTES=536870913"], {}, /QUEUE_BYTES/);
});

test("board open limits: refused for an unknown name, a name twice, or not a whole number", () => {
  refused(["NOPE=1"], {}, /unknown limit NOPE/);
  refused([], { [ENV_PREFIX + "NOPE"]: "1" }, /unknown limit NOPE/);
  refused(["TAB_RATE=5", "TAB_RATE=6"], {}, /given twice/);
  for (const v of ["", "1.5", "-1", "1e3", "0x10", " ", "abc", "01"]) refused([`TAB_RATE=${v}`], {}, /not a whole number/);
  refused(["TAB_RATE"], {}, /NAME=VALUE/);
});

test("board open limits: the flag wins over the environment", () => {
  assert.equal(ok(["TAB_RATE=7"], { [ENV_PREFIX + "TAB_RATE"]: "9" }).TAB_RATE, 7);
  assert.equal(ok([], { [ENV_PREFIX + "TAB_RATE"]: "9" }).TAB_RATE, 9);
  // (other environment variables are not ours)
  assert.equal(ok([], { OTHER_TAB_RATE: "x" }).TAB_RATE, 20);
});
