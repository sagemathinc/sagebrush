import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const CLI = join(__dirname, "..", "src", "cli.js");
const run = (source: string) => spawnSync(process.execPath, [CLI, "--magma"], {
  input: source, encoding: "utf8", timeout: 60_000,
});

test("R0a refuses unsupported constant fields and metadata without losing the session", () => {
  const r = run([
    "E<a> := GF(9); FunctionField(E);",
    "FunctionField(Rationals(), 2);",
    "Z<z> := FunctionField(Integers()); BaseField(Z);",
    "Z.0; Z.2;",
    "1;",
  ].join("\n") + "\n");
  assert.equal(r.signal, null);
  const flat = r.stdout.replace(/\s+/g, " ");
  assert.match(flat, /FunctionField over a non-prime finite field waits for R0b/);
  assert.match(flat, /FunctionField in more than one variable waits for the separate RM stage/);
  assert.match(flat, /Rational function field is not defined over a field/);
  assert.equal((flat.match(/should be in the range \[1\.\.1\]/g) ?? []).length, 2);
  assert.match(r.stdout, /\n1\n$/);
  assert.doesNotMatch(r.stdout + r.stderr, /Traceback|TypeError|AttributeError/);
});

test("R0a work, coefficient and exponent limits are closed at their boundary", () => {
  const r = run([
    "P<t> := PolynomialRing(Rationals()); F<x> := FunctionField(Rationals());",
    // 8*(127+1)^3*C_Q(1) is exactly 2^26; degree 128 is above it.
    "Degree(F!(t^127 + 1));",
    "Degree(F!(t^128 + 1));",
    // A 65536-bit coefficient is admitted; the next bit is refused.
    "Degree(F!(2^65535));",
    "Degree(F!(2^65536));",
    // A degree-zero element isolates the exponent cap from the degree cap.
    "Degree((F!2)^4096);",
    "Degree((F!2)^4097);",
    "1;",
  ].join("\n") + "\n");
  assert.equal(r.signal, null);
  const flat = r.stdout.replace(/\s+/g, " ");
  assert.match(r.stdout, /^127\n/m);
  assert.match(flat, /coercion normalization exceeds the rational-function R0a work or memory limit/);
  assert.match(r.stdout, /^1\n/m);
  assert.match(flat, /rational coefficients beyond the R0a bit limit/);
  assert.match(r.stdout, /^0\n/m);
  assert.match(flat, /exponent limit of 4096/);
  assert.match(r.stdout, /\n1\n$/);
});

test("an R0a refusal commits neither the canonical parent name nor an element", () => {
  const r = run([
    "P<t> := PolynomialRing(Rationals()); F<x> := FunctionField(Rationals());",
    "F!(t^128 + 1);",
    "G<y> := RationalFunctionField(Rationals());",
    "F eq G; F.1; G.1; x; y; t;",
  ].join("\n") + "\n");
  assert.equal(r.signal, null);
  assert.match(r.stdout, /work or memory limit/);
  assert.match(r.stdout, /true\ny\ny\ny\ny\nt\n$/);
});

test("the bounded parent cache churns while live canonical identities survive", () => {
  // 65 prime-field parents fill and then churn the 64-entry strong LRU.
  // Keeping every handle live exercises the separate weak identity registry.
  const primes = [
    2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37, 41, 43, 47, 53,
    59, 61, 67, 71, 73, 79, 83, 89, 97, 101, 103, 107, 109, 113,
    127, 131, 137, 139, 149, 151, 157, 163, 167, 173, 179, 181, 191,
    193, 197, 199, 211, 223, 227, 229, 233, 239, 241, 251, 257, 263,
    269, 271, 277, 281, 283, 293, 307, 311, 313,
  ];
  const r = run([
    // Model the 4 MiB prior-value allowance while the cache is populated.
    'old := "x"^4194304;',
    `primes := [${primes.join(",")}];`,
    "Fs := [ FunctionField(GF(p)) : p in primes ];",
    "Fs[1] eq FunctionField(GF(2));",
    "P<t> := PolynomialRing(Rationals()); F<x> := FunctionField(Rationals());",
    "Degree(F!(t^127 + 1));",
    "Degree(F!(t^128 + 1));",
    "Degree(F!(t + 1));",
    "#old;",
  ].join("\n") + "\n");
  assert.equal(r.signal, null);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^true\n127\n/m);
  assert.match(r.stdout, /work or memory limit/);
  assert.match(r.stdout, /\n1\n4194304\n$/);
});
