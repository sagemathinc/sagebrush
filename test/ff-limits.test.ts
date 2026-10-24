import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The finite-field budgets as limits (plan-ff-limits r3, section 8): each
// key moves its boundary exactly, in both front ends where both have the
// operation: an operation charged c cops (the cost model's, in a fresh
// session) is admitted at the limit c and refused at c - 1, in words.
//   ff.work        lowered (MinimalPolynomial in GF(2^20), 343620) and
//                  raised (relative MinimalPolynomial GF(2^20)/GF(4),
//                  14745056; MinimalPolynomial in GF(2^79), 79373117)
//   ff.embed_max   GF(2^6) and GF(2^9)'s common field GF(2^18) at 2^12 (the
//                  old literal 20, now EMBED_BITS), and GF(3^8) with GF(3^2)
//                  at 6561 and 6560 (the exact comparison)
//   ff.conway_work the cold search for GF(3^8), 1530226
//   ff.root_bits   exponents of 64 and 65 bits at 64
// And at the ceiling, ff.work = 10^8: the polynomial-degree bound still
// refuses first; the largest call admitted, GF(2^79)'s, in a 96 MiB heap,
// under 15 s (the plan's CI benchmark).
const CLI = __dirname + "/../src/cli.js";
const dir = mkdtempSync(join(tmpdir(), "sb-fflimits-"));
let n = 0;
function run(mode: "sage" | "magma", src: string, limits: Record<string, number> | null, node: string[] = []) {
  const script = join(dir, `s${++n}.${mode === "sage" ? "sage" : "mag"}`);
  writeFileSync(script, src);
  const args = [...node, CLI];
  if (limits !== null) {
    const f = join(dir, `l${n}.json`);
    writeFileSync(f, JSON.stringify(limits));
    args.push("--limits", f);
  }
  const env = { ...process.env };
  delete env.SAGEBRUSH_LIMITS;
  const t = Date.now();
  const r = spawnSync(process.execPath, [...args, script], { encoding: "utf8", env, maxBuffer: 16 << 20 });
  // (whitespace as one space: Magma wraps its errors at 80 columns)
  return { out: (r.stdout + r.stderr).replace(/\s+/g, " "), status: r.status, ms: Date.now() - t };
}
// admitted at `at` (and by default if `byDefault`), refused at at - 1 with `refused` in the output
function boundary(mode: "sage" | "magma", key: string, at: number, src: string, admitted: string, refused: string, byDefault: boolean) {
  const yes = run(mode, src, { [key]: at });
  assert.ok(yes.out.includes(admitted) && !yes.out.includes(refused), `${mode} ${key} = ${at}: ${yes.out}`);
  const no = run(mode, src, { [key]: at - 1 });
  assert.ok(no.out.includes(refused) && !no.out.includes(admitted), `${mode} ${key} = ${at - 1}: ${no.out}`);
  const d = run(mode, src, null);
  assert.ok(byDefault ? d.out.includes(admitted) : d.out.includes(refused), `${mode} by default: ${d.out}`);
}

test("ff.work, lowered: MinimalPolynomial in GF(2^20) is admitted at its 343620 cops and refused one short (Sage and Magma)", () => {
  boundary("sage", "ff.work", 343620, 'K = GF(2^20, "z")\nprint("ADMITTED", (K.gen()^3 + K.gen()).minpoly().degree())\n', "ADMITTED 20", "is not supported yet (work)", true);
  boundary("magma", "ff.work", 343620, 'L := GF(2^20); x := L.1^3 + L.1; print "ADMITTED", Degree(MinimalPolynomial(x));\n', "ADMITTED 20", "is not supported yet (work)", true);
});

test("ff.work, raised: a relative MinimalPolynomial of 14745056 cops, refused by default, is admitted at that limit (Magma)", () => {
  boundary("magma", "ff.work", 14745056, 'L := GF(2^20); k := GF(4); x := L.1^3 + L.1; print "ADMITTED", Degree(MinimalPolynomial(x, k));\n', "ADMITTED 10", "within a bounded amount of work", false);
});

test("ff.work at its ceiling: MinimalPolynomial in GF(2^79) (79373117 cops) in a 96 MiB heap, under 15 s; refused one short and by default (Sage)", () => {
  const src = 'R.<x> = GF(2)[]\nK = GF(2^79, "a", modulus=x^79 + x^9 + 1)\nprint("ADMITTED", (K.gen()^3 + K.gen()).minpoly().degree())\n';
  const yes = run("sage", src, { "ff.work": 1e8 }, ["--max-old-space-size=96"]);
  assert.ok(yes.out.includes("ADMITTED 79"), yes.out);
  assert.ok(yes.ms < 15000, `${yes.ms} ms`);
  boundary("sage", "ff.work", 79373117, src, "ADMITTED 79", "is not supported yet (work)", false);
});

test("ff.work at its ceiling: the polynomial-degree bound still refuses first", () => {
  for (const limits of [null, { "ff.work": 1e8 }]) {
    const r = run("magma", "P<x> := PolynomialRing(GF(5)); f := x^2000000;\n", limits);
    assert.ok(/a polynomial of degree more than \d+ is not supported/.test(r.out), r.out);
  }
});

test("ff.embed_max: a lowered size bound refuses common fields past it, before and at the exact comparison (Magma and Sage)", () => {
  // (GF(2^18) made first, at top level: its cold Conway search is then not
  // the embedding's work, so the size bound is the one exercised)
  const em = "L18 := GF(2^18); K := GF(2^6); L := GF(2^9); x := K.1 + L.1; print Parent(x);\n";
  const yes = run("magma", em, null);
  assert.ok(yes.out.includes("Finite field of size 2^18"), yes.out);
  const no = run("magma", em, { "ff.embed_max": 4096 });
  assert.ok(no.out.includes("only in fields of at most 2^12 elements"), no.out);
  boundary("magma", "ff.embed_max", 6561, 'K := GF(3^8); k := GF(3^2); x := K.1 + k.1; print "ADMITTED", Parent(x);\n', "ADMITTED Finite field of size 3^8", "at most 6560 elements", true);
  boundary("sage", "ff.embed_max", 6561, 'K = GF(3^8); k = GF(3^2)\nprint("ADMITTED", K(k.gen()).minpoly())\n', "ADMITTED x^2 + 2*x + 2", "at most 6560 elements", true);
});

test("ff.conway_work: the cold Conway search for GF(3^8) is admitted at its 1530226 cops and refused one short (Sage and Magma)", () => {
  boundary("sage", "ff.conway_work", 1530226, "print(GF(3^8))\n", "Finite Field in z8 of size 3^8", "beyond the bounded search here", true);
  boundary("magma", "ff.conway_work", 1530226, "F := GF(3^8); print F;\n", "Finite field of size 3^8", "is not supported yet", true);
});

test("ff.root_bits: at 64, an exponent of 64 bits is taken and one of 65 refused (Sage and Magma)", () => {
  const sage = "print(GF(7)(3).nth_root(2^63 + 3))\nprint(GF(7)(3).nth_root(2^64 + 3))\n";
  assert.equal(run("sage", sage, null).out, "5 3 ");
  const s64 = run("sage", sage, { "ff.root_bits": 64 }).out;
  assert.ok(s64.startsWith("5 ") && s64.includes("nth_root of an exponent of more than 64 bits is not supported yet"), s64);
  const magma = "r := Root(GF(7)!3, 2^63 + 3); print r;\nr := Root(GF(7)!3, 2^64 + 3); print r;\n";
  assert.equal(run("magma", magma, null).out, "5 3 ");
  const m64 = run("magma", magma, { "ff.root_bits": 64 }).out;
  assert.ok(m64.startsWith("5 ") && m64.includes("Root of an exponent of more than 64 bits is not supported yet"), m64);
});
