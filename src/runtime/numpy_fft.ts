// The discrete Fourier transform for numpy.fft: iterative radix-2
// Cooley-Tukey for powers of two, Bluestein's chirp-z algorithm (on top of
// radix-2) for every other length.  Works on one interleaved complex vector
// at a time; lib/numpy/fft.py handles axes, norms and real transforms.

import * as Obj from "./object";
import { newBuiltinModule } from "./modules";

function fft2(re: Float64Array, im: Float64Array, inverse: boolean) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((inverse ? 2 : -2) * Math.PI) / len;
    const half = len >> 1;
    // twiddles computed directly (not by recurrence) for accuracy
    const wr = new Float64Array(half), wi = new Float64Array(half);
    for (let k = 0; k < half; k++) {
      wr[k] = Math.cos(ang * k);
      wi[k] = Math.sin(ang * k);
    }
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < half; k++) {
        const a = i + k, b = a + half;
        const tr = re[b] * wr[k] - im[b] * wi[k], ti = re[b] * wi[k] + im[b] * wr[k];
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
      }
    }
  }
}

function dft(re: Float64Array, im: Float64Array, inverse: boolean) {
  const n = re.length;
  if (n <= 1) return;
  if ((n & (n - 1)) === 0) return fft2(re, im, inverse);
  // Bluestein: x_k w_k convolved with conj chirp, via power-of-two FFTs
  let m = 1;
  while (m < 2 * n - 1) m <<= 1;
  const s = inverse ? 1 : -1;
  const cr = new Float64Array(n), ci = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    const t = (Math.PI * ((k * k) % (2 * n))) / n;
    cr[k] = Math.cos(t);
    ci[k] = s * Math.sin(t);
  }
  const ar = new Float64Array(m), ai = new Float64Array(m), br = new Float64Array(m), bi = new Float64Array(m);
  for (let k = 0; k < n; k++) {
    ar[k] = re[k] * cr[k] - im[k] * ci[k];
    ai[k] = re[k] * ci[k] + im[k] * cr[k];
  }
  br[0] = cr[0];
  bi[0] = -ci[0];
  for (let k = 1; k < n; k++) {
    br[k] = br[m - k] = cr[k];
    bi[k] = bi[m - k] = -ci[k];
  }
  fft2(ar, ai, false);
  fft2(br, bi, false);
  for (let k = 0; k < m; k++) {
    const r = ar[k] * br[k] - ai[k] * bi[k], i = ar[k] * bi[k] + ai[k] * br[k];
    ar[k] = r;
    ai[k] = i;
  }
  fft2(ar, ai, true);
  for (let k = 0; k < n; k++) {
    const r = ar[k] / m, i = ai[k] / m;
    re[k] = r * cr[k] - i * ci[k];
    im[k] = r * ci[k] + i * cr[k];
  }
}

newBuiltinModule("_npfft", (m) => {
  // transform the rows of an interleaved complex buffer (rows x n), in place
  m.rows = Obj.builtin((data: any, rows: any, n: any, inverse: any) => {
    const R = Number(rows), N = Number(n);
    const d = data.data as Float64Array; // an ndarray's buffer (contiguous complex128)
    const re = new Float64Array(N), im = new Float64Array(N);
    for (let r = 0; r < R; r++) {
      const base = 2 * (data.offset + r * N);
      for (let k = 0; k < N; k++) {
        re[k] = d[base + 2 * k];
        im[k] = d[base + 2 * k + 1];
      }
      dft(re, im, !!inverse);
      for (let k = 0; k < N; k++) {
        d[base + 2 * k] = re[k];
        d[base + 2 * k + 1] = im[k];
      }
    }
    return null;
  }, "rows");
});
