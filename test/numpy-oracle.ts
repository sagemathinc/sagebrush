import { execFileSync } from "node:child_process";

// CPython's NumPy as the oracle of the bit-exact tests of float loops
// (power, powf, complex power): NumPy's loops without AVX-512, whose exp,
// log, pow... are glibc's libm, as Sagebrush's are. On a CPU with AVX-512
// (GitHub's runners) NumPy dispatches exp, log, sin, float power... to SIMD
// kernels (its own and SVML) that differ from glibc in the last bit, so even
// the cases' inputs, built with np.exp and 10 ** array, are not the same
// numbers. NPY_DISABLE_CPU_FEATURES turns them off, as in ci.yml's
// numpy-tests step. Before comparing, the oracle is checked to take that
// route: its exp, log and float64 power are math.exp's, math.log's and
// float ** float's (glibc's) element for element. A NumPy that doesn't is
// refused with that reason, not reported as a digest mismatch.
export const NO_AVX512 = "X86_V4 AVX512_ICL AVX512_SPR";
const env = { ...process.env, NPY_DISABLE_CPU_FEATURES: NO_AVX512 };
let checked = false;
export function numpyOracle(script: string): string[] {
  if (!checked) {
    const probe = execFileSync(
      "python3",
      [
        "-c",
        "import math, numpy as np\n" +
          "from numpy._core._multiarray_umath import __cpu_features__ as f\n" +
          "v = np.linspace(-700.0, 700.0, 20001) * 1.0000001\n" +
          "w = np.exp(np.linspace(-740.0, 700.0, 20001))\n" +
          "u = np.linspace(-300.0, 300.0, 20001) * 1.0000001\n" +
          "same = (np.exp(v).tolist() == [math.exp(t) for t in v.tolist()] and np.log(w).tolist() == [math.log(t) for t in w.tolist()]\n" +
          "        and (10.0 ** u).tolist() == [10.0 ** t for t in u.tolist()])\n" +
          "print(np.__version__, same, ','.join(k for k, v in f.items() if v and k.startswith('AVX512')) or '-')",
      ],
      { encoding: "utf8", env },
    ).trim();
    const [version, glibc, avx512] = probe.split(" ");
    if (glibc !== "True")
      throw new Error(
        `the oracle, NumPy ${version} with NPY_DISABLE_CPU_FEATURES="${NO_AVX512}" (AVX-512 features still on: ${avx512}), ` +
          `does not compute exp, log and pow as glibc (math.exp, math.log, float ** float), so it is not the NumPy these tests compare with`,
      );
    checked = true;
  }
  return execFileSync("python3", [script], { encoding: "utf8", env }).split("\n");
}
