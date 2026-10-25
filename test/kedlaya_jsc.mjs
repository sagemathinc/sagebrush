// The ledger of Kedlaya's Frobenius matrix against JavaScriptCore's own heap
// (lib/_sage_padic_lseries.py, plan-kedlaya-optin r6 section 6), under Bun:
// run by test/kedlaya.test.ts as `bun test/kedlaya_jsc.mjs DIST WHAT`.
//   layouts   per object, the heap's growth (bun:jsc heapStats after
//             Bun.gc(true)) over many copies made by Python, at most the
//             JSC table's formula, at each layout step, beyond the same
//             loop's growth making nothing
//   peak P PREC CURVE   the live heap's growth over the call's baseline
//             (after Bun.gc(true)) at each of its within-phase peaks (the
//             ledger's hook points: digits, series, reduce, forms, exact),
//             its largest, and U.  Bun honours no heap limit to bisect
//             (BUN_JSC_gcMaxHeapSize is not a hard limit), and its RSS
//             high-water counts the JIT and a heap it never returns.
// Prints one line of JSON.
const [dist, what, ...rest] = process.argv.slice(2);
const jsc = await import("bun:jsc");
const c = require(dist + "/src/compile.js");
await Promise.resolve(c.initParser && c.initParser());
const sys = c.R.importModule("sys");
sys.path.push(c.libDir());
const py = (code) => c.execModule(code, "<kedlaya-jsc>", "__main__");
const heap = () => (Bun.gc(true), Bun.gc(true), jsc.heapStats().heapSize);
// the copies live in sys._kd_keep, which outlives one execModule's namespace
py(["import sys, os", "sys.path.insert(0, os.path.join(" + JSON.stringify(dist) + ", '..', 'lib'))", "import _sage_padic_lseries as L", "sys._kd_L = L"].join("\n"));

function perObject(make, bound) {
  const copies = Math.max(32, Math.min(1 << 21, Math.floor((8 << 20) / bound)));
  const trial = (mk) => {
    py(`import sys\nsys._kd_keep = [None] * ${copies}\nsys._kd_make = ${mk}`);
    const h0 = heap();
    py(`import sys\nk, m = sys._kd_keep, sys._kd_make\nfor i in range(${copies}):\n    k[i] = m(i)`);
    const h1 = heap();
    py("import sys\nsys._kd_keep = sys._kd_make = None");
    return h1 - h0;
  };
  trial(make);
  const got = [];
  let noise = 0;
  for (let t = 0; t < 3; t++) {
    const n = trial("lambda i: None");
    got.push(trial(make) - n);
    noise = Math.max(noise, Math.abs(n));
  }
  got.sort((a, b) => a - b);
  return [got[1] / copies, noise / copies];
}

const T = (fn, n) => (py(`import sys\nsys._kd_out = sys._kd_L._KdJSC.${fn}(${n})`), Number(sys._kd_out));

if (what === "layouts") {
  const bad = [], worst = {};
  const check = (kind, label, make, bound) => {
    const [m, e] = perObject(make, bound);
    if (m > bound + e) bad.push(`${label}: ${m.toFixed(1)} > ${bound} + noise ${e.toFixed(1)}`);
    if (process.env.KD_RAW) console.error(`${kind} ${label} ${m.toFixed(1)} ${bound}`);
    worst[kind] = Math.max(worst[kind] ?? 0, m / bound);
  };
  // (CI: layout steps up to 2^12 entries; "full": up to 2^14, the plan's)
  const top = rest[0] === "full" ? 14 : 12;
  for (let k = 3; k <= top; k++) {
    for (const n of [2 ** k, 2 ** k + 1]) {
      check("list", `list ${n}`, `lambda i: [j for j in range(${n}) if True]`, T("Ls", n));
      check("dict", `dict ${n}`, `lambda i: {j: j for j in range(${n})}`, T("D", n));
    }
  }
  for (let k = 1; k <= 32; k++) for (const b of [64 * k, 64 * k + 1]) check("int", `int ${b} bits`, `lambda i: (1 << ${b}) - 1 - i`, T("I", b));
  console.log(JSON.stringify({ bad, worst }));
} else if (what === "peak") {
  const [p, prec, curve] = rest;
  const Q = curve === "dense" ? "[F(-23, 4), F(3), F(3), F(1)]" : "[F(1), F(0), F(0), F(1)]";
  py(`import sys\nfrom fractions import Fraction as F\nL = sys._kd_L\nQc = ${Q}\nN = ${prec} + 1\nK, W = L._kd_plan_fast(${p}, N)\nsys._kd_args = (Qc, ${p}, N, K, W)\nsys._kd_out = L._kd_ledger(${p}, N, K, W, ${p}, max(max(abs(c.numerator).bit_length(), c.denominator.bit_length()) for c in Qc), L._KdJSC)`);
  const U = Number(sys._kd_out);
  const Obj = require(dist + "/src/runtime/object.js");
  // (a first call compiles the code: JSC's code blocks are cells of its
  // heap, which stay, so they are not the call's; the second is measured)
  py("import sys\nsys._kd_L._kd_frobenius_matrix(*sys._kd_args)");
  let most = 0, hooks = 0;
  const base = heap();
  c.R.setattr(sys, "_kd_heap", Obj.builtin(() => {
    hooks++;
    most = Math.max(most, heap() - base);
    return null;
  }, "_kd_heap"));
  py("import sys\nL = sys._kd_L\nL._kd_hook = lambda point, v: sys._kd_heap()\ntry:\n    L._kd_frobenius_matrix(*sys._kd_args)\nfinally:\n    L._kd_hook = None");
  console.log(JSON.stringify({ U, most, hooks }));
}
