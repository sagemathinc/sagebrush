// The discrete Fourier transform for numpy.fft: iterative radix-2
// Cooley-Tukey for powers of two, Bluestein's chirp-z algorithm (on top of
// radix-2) for every other length.  Works on one interleaved complex vector
// at a time; lib/numpy/fft.py handles axes, norms and real transforms.

import * as Obj from "./object";
import { newBuiltinModule } from "./modules";

// Per-size tables: twiddles cos/sin(2*pi*k/n) for k < n/2 and the bit-reversal permutation.
const tables = new Map<number, { c: Float64Array; s: Float64Array; rev: Uint32Array }>();
function table(n: number) {
  let t = tables.get(n);
  if (!t) {
    const c = new Float64Array(n >> 1), s = new Float64Array(n >> 1);
    for (let k = 0; k < n >> 1; k++) {
      c[k] = Math.cos((2 * Math.PI * k) / n);
      s[k] = Math.sin((2 * Math.PI * k) / n);
    }
    const rev = new Uint32Array(n);
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      rev[i] = j;
    }
    t = { c, s, rev };
    if (tables.size > 32) tables.clear();
    tables.set(n, t);
  }
  return t;
}

function fft2(re: Float64Array, im: Float64Array, inverse: boolean) {
  const n = re.length;
  if (n <= 1) return;
  const { c, s, rev } = table(n);
  for (let i = 1; i < n; i++) {
    const j = rev[i];
    if (i < j) {
      const tr = re[i], ti = im[i];
      re[i] = re[j];
      im[i] = im[j];
      re[j] = tr;
      im[j] = ti;
    }
  }
  const sgn = inverse ? 1 : -1;
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1, step = n / len;
    for (let i = 0; i < n; i += len) {
      for (let k = 0, t = 0; k < half; k++, t += step) {
        const wr = c[t], wi = sgn * s[t];
        const a = i + k, b = a + half;
        const tr = re[b] * wr - im[b] * wi, ti = re[b] * wi + im[b] * wr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
      }
    }
  }
}

// Bluestein's chirp z: per length n, the chirp and its transformed conjugate
const chirps = new Map<string, { m: number; cr: Float64Array; ci: Float64Array; br: Float64Array; bi: Float64Array }>();
function chirp(n: number, inverse: boolean) {
  const key = n + (inverse ? "i" : "f");
  let ch = chirps.get(key);
  if (!ch) {
    let m = 1;
    while (m < 2 * n - 1) m <<= 1;
    const sg = inverse ? 1 : -1;
    const cr = new Float64Array(n), ci = new Float64Array(n);
    for (let k = 0; k < n; k++) {
      const t = (Math.PI * ((k * k) % (2 * n))) / n;
      cr[k] = Math.cos(t);
      ci[k] = sg * Math.sin(t);
    }
    const br = new Float64Array(m), bi = new Float64Array(m);
    br[0] = cr[0];
    bi[0] = -ci[0];
    for (let k = 1; k < n; k++) {
      br[k] = br[m - k] = cr[k];
      bi[k] = bi[m - k] = -ci[k];
    }
    dft(br, bi, false);
    ch = { m, cr, ci, br, bi };
    if (chirps.size > 16) chirps.clear();
    chirps.set(key, ch);
  }
  return ch;
}

// Mixed-radix Stockham autosort FFT for lengths whose prime factors are
// small (as pocketfft handles them): stage by stage, radix R combines
// transforms of size Ns into size Ns*R; twiddles from one table per length.
function factorize(n: number): number[] | null {
  const f: number[] = [];
  while (n % 4 === 0) {
    f.push(4);
    n /= 4;
  }
  for (const p of [2, 3, 5, 7, 11, 13]) {
    while (n % p === 0) {
      f.push(p);
      n /= p;
    }
  }
  return n === 1 ? f : null;
}
const twiddles = new Map<number, { c: Float64Array; s: Float64Array }>();
function twiddle(n: number) {
  let t = twiddles.get(n);
  if (!t) {
    const c = new Float64Array(n), s = new Float64Array(n);
    for (let k = 0; k < n; k++) {
      c[k] = Math.cos((2 * Math.PI * k) / n);
      s[k] = Math.sin((2 * Math.PI * k) / n);
    }
    t = { c, s };
    if (twiddles.size > 32) twiddles.clear();
    twiddles.set(n, t);
  }
  return t;
}
// x: interleaved complex (re, im, re, im ...) of length 2N; result back in x.
function stockhamI(x: Float64Array, N: number, factors: number[], inverse: boolean) {
  const { c: TC, s: TS } = twiddle(N);
  const sg = inverse ? 1 : -1;
  let X: Float64Array<ArrayBufferLike> = x, Y: Float64Array<ArrayBufferLike> = new Float64Array(2 * N);
  const vr = new Float64Array(16), vi = new Float64Array(16), wr = new Float64Array(16), wi = new Float64Array(16);
  let Ns = 1;
  for (const R of factors) {
    const stride = N / R, blocks = stride / Ns, step = N / (Ns * R);
    const S2 = 2 * stride, N2 = 2 * Ns;
    if (R === 4) {
      for (let jm = 0; jm < Ns; jm++) {
        const t1 = jm * step, t2 = 2 * t1, t3 = 3 * t1;
        const w1r = TC[t1], w1i = sg * TS[t1], w2r = TC[t2], w2i = sg * TS[t2], w3r = TC[t3], w3i = sg * TS[t3];
        for (let blk = 0, src = 2 * jm, dst = 2 * jm; blk < blocks; blk++, src += N2, dst += 4 * N2) {
          const x0r = X[src], x0i = X[src + 1];
          let ar = X[src + S2], ai = X[src + S2 + 1];
          const x1r = ar * w1r - ai * w1i, x1i = ar * w1i + ai * w1r;
          ar = X[src + 2 * S2];
          ai = X[src + 2 * S2 + 1];
          const x2r = ar * w2r - ai * w2i, x2i = ar * w2i + ai * w2r;
          ar = X[src + 3 * S2];
          ai = X[src + 3 * S2 + 1];
          const x3r = ar * w3r - ai * w3i, x3i = ar * w3i + ai * w3r;
          const s0r = x0r + x2r, s0i = x0i + x2i, d0r = x0r - x2r, d0i = x0i - x2i;
          const s1r = x1r + x3r, s1i = x1i + x3i, d1r = x1r - x3r, d1i = x1i - x3i;
          Y[dst] = s0r + s1r;
          Y[dst + 1] = s0i + s1i;
          Y[dst + N2] = d0r - sg * d1i;
          Y[dst + N2 + 1] = d0i + sg * d1r;
          Y[dst + 2 * N2] = s0r - s1r;
          Y[dst + 2 * N2 + 1] = s0i - s1i;
          Y[dst + 3 * N2] = d0r + sg * d1i;
          Y[dst + 3 * N2 + 1] = d0i - sg * d1r;
        }
      }
    } else if (R === 2) {
      for (let jm = 0; jm < Ns; jm++) {
        const t1 = jm * step, w1r = TC[t1], w1i = sg * TS[t1];
        for (let blk = 0, src = 2 * jm, dst = 2 * jm; blk < blocks; blk++, src += N2, dst += 2 * N2) {
          const ar = X[src + S2], ai = X[src + S2 + 1];
          const x1r = ar * w1r - ai * w1i, x1i = ar * w1i + ai * w1r;
          const x0r = X[src], x0i = X[src + 1];
          Y[dst] = x0r + x1r;
          Y[dst + 1] = x0i + x1i;
          Y[dst + N2] = x0r - x1r;
          Y[dst + N2 + 1] = x0i - x1i;
        }
      }
    } else if (R === 3 || R === 5) {
      const C1 = Math.cos((2 * Math.PI) / R), SN1 = Math.sin((2 * Math.PI) / R);
      const C2 = Math.cos((4 * Math.PI) / R), SN2 = Math.sin((4 * Math.PI) / R);
      for (let jm = 0; jm < Ns; jm++) {
        for (let r = 1; r < R; r++) {
          const t = r * jm * step;
          wr[r] = TC[t];
          wi[r] = sg * TS[t];
        }
        for (let blk = 0, src = 2 * jm, dst = 2 * jm; blk < blocks; blk++, src += N2, dst += R * N2) {
          const x0r = X[src], x0i = X[src + 1];
          for (let r = 1; r < R; r++) {
            const ar = X[src + r * S2], ai = X[src + r * S2 + 1];
            vr[r] = ar * wr[r] - ai * wi[r];
            vi[r] = ar * wi[r] + ai * wr[r];
          }
          if (R === 3) {
            const t1r = vr[1] + vr[2], t1i = vi[1] + vi[2], t2r = vr[1] - vr[2], t2i = vi[1] - vi[2];
            const Ar = x0r - 0.5 * t1r, Ai = x0i - 0.5 * t1i, Br = SN1 * t2r, Bi = SN1 * t2i;
            Y[dst] = x0r + t1r;
            Y[dst + 1] = x0i + t1i;
            Y[dst + N2] = Ar - sg * Bi;
            Y[dst + N2 + 1] = Ai + sg * Br;
            Y[dst + 2 * N2] = Ar + sg * Bi;
            Y[dst + 2 * N2 + 1] = Ai - sg * Br;
          } else {
            const t1r = vr[1] + vr[4], t1i = vi[1] + vi[4], t2r = vr[2] + vr[3], t2i = vi[2] + vi[3];
            const t3r = vr[1] - vr[4], t3i = vi[1] - vi[4], t4r = vr[2] - vr[3], t4i = vi[2] - vi[3];
            const A1r = x0r + C1 * t1r + C2 * t2r, A1i = x0i + C1 * t1i + C2 * t2i;
            const A2r = x0r + C2 * t1r + C1 * t2r, A2i = x0i + C2 * t1i + C1 * t2i;
            const B1r = SN1 * t3r + SN2 * t4r, B1i = SN1 * t3i + SN2 * t4i;
            const B2r = SN2 * t3r - SN1 * t4r, B2i = SN2 * t3i - SN1 * t4i;
            Y[dst] = x0r + t1r + t2r;
            Y[dst + 1] = x0i + t1i + t2i;
            Y[dst + N2] = A1r - sg * B1i;
            Y[dst + N2 + 1] = A1i + sg * B1r;
            Y[dst + 4 * N2] = A1r + sg * B1i;
            Y[dst + 4 * N2 + 1] = A1i - sg * B1r;
            Y[dst + 2 * N2] = A2r - sg * B2i;
            Y[dst + 2 * N2 + 1] = A2i + sg * B2r;
            Y[dst + 3 * N2] = A2r + sg * B2i;
            Y[dst + 3 * N2 + 1] = A2i - sg * B2r;
          }
        }
      }
    } else {
      const st = N / R;
      for (let jm = 0; jm < Ns; jm++) {
        for (let r = 1; r < R; r++) {
          const t = r * jm * step;
          wr[r] = TC[t];
          wi[r] = sg * TS[t];
        }
        for (let blk = 0, src = 2 * jm, dst = 2 * jm; blk < blocks; blk++, src += N2, dst += R * N2) {
          vr[0] = X[src];
          vi[0] = X[src + 1];
          for (let r = 1; r < R; r++) {
            const ar = X[src + r * S2], ai = X[src + r * S2 + 1];
            vr[r] = ar * wr[r] - ai * wi[r];
            vi[r] = ar * wi[r] + ai * wr[r];
          }
          for (let k = 0; k < R; k++) {
            let sr = vr[0], si = vi[0];
            for (let r = 1; r < R; r++) {
              const t = ((r * k) % R) * st;
              const cr = TC[t], ci = sg * TS[t];
              sr += vr[r] * cr - vi[r] * ci;
              si += vr[r] * ci + vi[r] * cr;
            }
            Y[dst + k * N2] = sr;
            Y[dst + k * N2 + 1] = si;
          }
        }
      }
    }
    [X, Y] = [Y, X];
    Ns *= R;
  }
  if (X !== x) x.set(X);
}

function stockham(re: Float64Array, im: Float64Array, factors: number[], inverse: boolean) {
  const N = re.length, x = new Float64Array(2 * N);
  for (let k = 0; k < N; k++) {
    x[2 * k] = re[k];
    x[2 * k + 1] = im[k];
  }
  stockhamI(x, N, factors, inverse);
  for (let k = 0; k < N; k++) {
    re[k] = x[2 * k];
    im[k] = x[2 * k + 1];
  }
}

function dft(re: Float64Array, im: Float64Array, inverse: boolean) {
  const n = re.length;
  if (n <= 1) return;
  const f = factorize(n);
  if (f) return stockham(re, im, f, inverse);
  const { m, cr, ci, br, bi } = chirp(n, inverse);
  const ar = new Float64Array(m), ai = new Float64Array(m);
  for (let k = 0; k < n; k++) {
    ar[k] = re[k] * cr[k] - im[k] * ci[k];
    ai[k] = re[k] * ci[k] + im[k] * cr[k];
  }
  dft(ar, ai, false);
  for (let k = 0; k < m; k++) {
    const r = ar[k] * br[k] - ai[k] * bi[k], i = ar[k] * bi[k] + ai[k] * br[k];
    ar[k] = r;
    ai[k] = i;
  }
  dft(ar, ai, true);
  for (let k = 0; k < n; k++) {
    const r = ar[k] / m, i = ai[k] / m;
    re[k] = r * cr[k] - i * ci[k];
    im[k] = r * ci[k] + i * cr[k];
  }
}

// The FFT of a real sequence of even length n through one complex FFT of
// length n/2 (even samples real, odd samples imaginary) and a split step.
function rfftEven(x: Float64Array, xo: number, n: number, outRe: Float64Array, outIm: Float64Array) {
  const h = n >> 1;
  // the real samples, read as h interleaved complex numbers, are z
  const z = x.slice(xo, xo + n);
  const f = factorize(h);
  if (f && h > 1) stockhamI(z, h, f, false);
  else if (h > 1) {
    const zr = new Float64Array(h), zi = new Float64Array(h);
    for (let k = 0; k < h; k++) {
      zr[k] = z[2 * k];
      zi[k] = z[2 * k + 1];
    }
    dft(zr, zi, false);
    for (let k = 0; k < h; k++) {
      z[2 * k] = zr[k];
      z[2 * k + 1] = zi[k];
    }
  }
  const { c: TC, s: TS } = twiddle(n);
  for (let k = 0; k <= h; k++) {
    const a = k % h, b = (h - k) % h;
    const zar = z[2 * a], zai = z[2 * a + 1], zbr = z[2 * b], zbi = z[2 * b + 1];
    const er = (zar + zbr) / 2, ei = (zai - zbi) / 2; // (Z[k] + conj Z[h-k]) / 2
    const or = (zai + zbi) / 2, oi = -(zar - zbr) / 2; // (Z[k] - conj Z[h-k]) / 2i
    const c = k < n ? TC[k] : 1, sn = k < n ? -TS[k] : 0;
    outRe[k] = er + (or * c - oi * sn);
    outIm[k] = ei + (or * sn + oi * c);
  }
}

newBuiltinModule("_npfft", (m) => {
  // rows of a contiguous real float64 buffer (rows x n, n even) -> rows x (n/2+1) complex (out buffer)
  m.rfft_rows = Obj.builtin((data: any, rows: any, n: any, out: any) => {
    const R = Number(rows), N = Number(n), H = N / 2 + 1;
    const d = data.data as Float64Array, od = out.data as Float64Array;
    const re = new Float64Array(H), im = new Float64Array(H);
    for (let r = 0; r < R; r++) {
      rfftEven(d, data.offset + r * N, N, re, im);
      for (let k = 0; k < H; k++) {
        od[2 * (r * H + k)] = re[k];
        od[2 * (r * H + k) + 1] = im[k];
      }
    }
    return null;
  }, "rfft_rows");
  // transform the rows of an interleaved complex buffer (rows x n), in place
  m.rows = Obj.builtin((data: any, rows: any, n: any, inverse: any) => {
    const R = Number(rows), N = Number(n);
    const d = data.data as Float64Array; // an ndarray's buffer (contiguous complex128)
    const f = factorize(N);
    if (f && N > 1) {
      for (let r = 0; r < R; r++) {
        const base = 2 * (data.offset + r * N);
        stockhamI(d.subarray(base, base + 2 * N), N, f, !!inverse);
      }
      return null;
    }
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
