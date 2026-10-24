import test from "node:test";
import assert from "node:assert/strict";

// The allowance/1 schema (src/allowance.ts; design-optin-limits-g-r3 §1,
// §3.2, §4.2; plan-optin-limits-g-impl-r3 G-0): a strict validator, with no
// caller yet.  Every range is checked at, just inside and just outside its
// limit; strict JSON refuses duplicate and prototype keys.
const DIST = __dirname + "/..";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const A = require(DIST + "/src/allowance.js");

const base = { schema: "sagebrush.allowance/1", scope: "test", source: "grading" };
const ok = (extra: object, opts?: object) => A.checkAllowance({ ...base, ...extra }, opts);
const bad = (extra: object, re: RegExp, opts?: object) => assert.throws(() => A.checkAllowance({ ...base, ...extra }, opts), (e: any) => e.name === "AllowanceError" && re.test(e.message));

test("a minimal allowance in each dimension", () => {
  assert.equal(ok({ wall_s: 30 }).wall_s, 30);
  assert.equal(ok({ steps: 1000 }).steps, 1000);
  assert.equal(ok({ work: { factor: 5 } }).work.factor, 5);
  const a = ok({ wall_s: 1, steps: 2, work: { factor: 3, gb: 4 }, grace_s: 1 });
  assert.deepEqual({ ...a, work: { ...a.work } }, { ...base, wall_s: 1, steps: 2, work: { factor: 3, gb: 4 }, grace_s: 1 });
});

test("the result is frozen and has no prototype", () => {
  const a = ok({ work: { factor: 3 } });
  assert.ok(Object.isFrozen(a) && Object.isFrozen(a.work));
  assert.equal(Object.getPrototypeOf(a), null);
  assert.equal(Object.getPrototypeOf(a.work), null);
});

test("at least one dimension", () => {
  bad({}, /at least one of wall_s, work and steps/);
  bad({ grace_s: 1 }, /at least one/);
  bad({ work: {} }, /at least one family/);
});

test("schema, scope and source", () => {
  for (const scope of ["notebook", "question", "cell", "test"]) assert.equal(ok({ scope, steps: 1 }).scope, scope);
  for (const source of ["grading", "instructor", "server"]) assert.equal(ok({ source, steps: 1 }).source, source);
  bad({ schema: "sagebrush.allowance/2", steps: 1 }, /schema must be/);
  bad({ scope: "run", steps: 1 }, /scope must be/);
  bad({ source: "student", steps: 1 }, /source must be/);
  assert.throws(() => A.checkAllowance({ scope: "test", source: "grading", steps: 1 }), /schema must be/);
  assert.throws(() => A.checkAllowance([]), /not an object/);
  assert.throws(() => A.checkAllowance(null), /not an object/);
});

test("unknown fields are refused", () => {
  bad({ steps: 1, cpu_s: 1 }, /unknown field "cpu_s"/);
});

test("wall_s: 0.1 to 86,400", () => {
  assert.equal(ok({ wall_s: 0.1 }).wall_s, 0.1);
  assert.equal(ok({ wall_s: 86_400 }).wall_s, 86_400);
  bad({ wall_s: 0.09999 }, /wall_s must be from 0.1 to 86400/);
  bad({ wall_s: 86_400.001 }, /wall_s must be from/);
  bad({ wall_s: 0 }, /wall_s must be from/);
  bad({ wall_s: -1 }, /wall_s must be from/);
  bad({ wall_s: "30" }, /wall_s must be a number/);
  bad({ wall_s: Infinity }, /wall_s must be a number/);
  bad({ wall_s: NaN }, /wall_s must be a number/);
});

test("steps and work: integers from 1 to 2^53 - 1", () => {
  const max = 2 ** 53 - 1;
  assert.equal(ok({ steps: max }).steps, max);
  assert.equal(ok({ work: { factor: max } }).work.factor, max);
  assert.equal(ok({ steps: 1 }).steps, 1);
  bad({ steps: 2 ** 53 }, /steps must be from 1 to 9007199254740991/);
  bad({ work: { factor: 2 ** 53 } }, /work.factor must be from 1/);
  bad({ steps: 0 }, /steps must be from 1/);
  bad({ steps: -5 }, /steps must be from 1/);
  bad({ steps: 1.5 }, /steps must be an integer/);
  bad({ work: { factor: 2.5 } }, /work.factor must be an integer/);
  bad({ steps: "10" }, /steps must be an integer/);
});

test("work families: names, count, and the engine's registry", () => {
  bad({ work: { Factor: 1 } }, /is not a family name/);
  bad({ work: { "": 1 } }, /is not a family name/);
  bad({ work: { ["f".repeat(33)]: 1 } }, /is not a family name/);
  assert.equal(ok({ work: { ["f".repeat(32)]: 1 } }).work["f".repeat(32)], 1);
  const many = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`f${i}`, 1]));
  assert.equal(Object.keys(ok({ work: many(32) }).work).length, 32);
  bad({ work: many(33) }, /more than 32 families/);
  bad({ work: [1] }, /work must be an object/);
  const families = new Set(["factor", "gb"]);
  assert.equal(ok({ work: { gb: 2 } }, { families }).work.gb, 2);
  bad({ work: { lll: 2 } }, /unknown work family "lll"/, { families });
});

test("grace_s: 0.5 to 60", () => {
  assert.equal(ok({ steps: 1, grace_s: 0.5 }).grace_s, 0.5);
  assert.equal(ok({ steps: 1, grace_s: 60 }).grace_s, 60);
  bad({ steps: 1, grace_s: 0.49 }, /grace_s must be from 0.5 to 60/);
  bad({ steps: 1, grace_s: 60.5 }, /grace_s must be from/);
});

test("the default grace (design §4.2)", () => {
  assert.equal(A.graceSeconds(ok({ steps: 1 })), 2);
  assert.equal(A.graceSeconds(ok({ work: { factor: 1 } })), 2);
  assert.equal(A.graceSeconds(ok({ wall_s: 0.1 })), 0.5);
  assert.equal(A.graceSeconds(ok({ wall_s: 5 })), 0.5);
  assert.equal(A.graceSeconds(ok({ wall_s: 20 })), 2);
  assert.equal(A.graceSeconds(ok({ wall_s: 100 })), 2);
  assert.ok(Math.abs(A.graceSeconds(ok({ wall_s: 12 })) - 1.2) < 1e-12);
  assert.equal(A.graceSeconds(ok({ wall_s: 100, grace_s: 7 })), 7);
  assert.equal(A.graceSeconds(ok({ wall_s: 1, steps: 5 })), 0.5);
});

test("strict JSON: duplicates, prototype keys, depth and size", () => {
  const t = (s: string) => A.parseAllowance(s);
  assert.equal(t('{"schema":"sagebrush.allowance/1","scope":"cell","source":"instructor","wall_s":30}').wall_s, 30);
  assert.throws(() => t('{"schema":"sagebrush.allowance/1","scope":"cell","source":"instructor","wall_s":30,"wall_s":1}'), /duplicate key "wall_s"/);
  assert.throws(() => t('{"schema":"sagebrush.allowance/1","scope":"cell","source":"instructor","steps":3,"__proto__":{"wall_s":1}}'), /forbidden key "__proto__"/);
  assert.throws(() => t('{"schema":"sagebrush.allowance/1","scope":"cell","source":"instructor","work":{"constructor":1}}'), /forbidden key "constructor"/);
  assert.throws(() => t('{"schema":"sagebrush.allowance/1","scope":"cell","source":"instructor","work":{"f":[[[1]]]}}'), /nested deeper than 4/);
  assert.throws(() => t('{"schema":"sagebrush.allowance/1"'), /not valid JSON/);
  assert.throws(() => t(" ".repeat(16 * 1024 + 1)), /longer than 16384/);
  assert.equal(t('{"schema":"sagebrush.allowance/1","scope":"cell","source":"server","steps":9007199254740991}').steps, 2 ** 53 - 1);
  assert.throws(() => t('{"schema":"sagebrush.allowance/1","scope":"cell","source":"server","steps":9007199254740992}'), /steps must be from 1/);
  assert.throws(() => t('{"schema":"sagebrush.allowance/1","scope":"cell","source":"server","steps":9007199254740993}'), /steps must be from 1/);
});

test("scope_id grammar (design §3.2)", () => {
  for (const s of ["nb", "q:q1", "q:a-b_c", "t:q1/0", "t:q1/12", "c:Ab-_9", "c:" + "x".repeat(64), "u:0", "u:123456789"]) assert.ok(A.isScopeId(s), s);
  for (const s of ["", "NB", "nb ", "q:", "q:Q1", "q:" + "a".repeat(33), "t:q1", "t:q1/01", "t:q1/-1", "c:", "c:a.b", "c:" + "x".repeat(65), "u:01", "u:1234567890", "x:1", 7, null]) assert.ok(!A.isScopeId(s), String(s));
});
