// Dense linear algebra for numpy.linalg, on row-major Float64Arrays:
// LU with partial pivoting (det, solve, inv), Householder QR, Cholesky,
// symmetric eigenproblems (Householder tridiagonalization + implicit QL, as
// EISPACK tred2/tql2), general eigenproblems (Hessenberg reduction + shifted
// QR with eigenvectors, as EISPACK orthes/hqr2, the algorithm of JAMA), and
// the SVD by one-sided Jacobi.  Batched (stacked) matrices are handled in
// lib/numpy/linalg.py, which calls these on one matrix at a time.

import * as Obj from "./object";
import { newBuiltinModule } from "./modules";
import { NDArray, empty, toDtype, ascontig, copy as npcopy } from "./numpy";
import { glibcLog, glibcExp } from "./libm";

const { T, raise, tuple } = Obj;
const F64 = () => toDtype("float64");

// A float64 copy of a 2-D matrix: [data, rows, cols]
function mat(a: NDArray): [Float64Array, number, number] {
  if (a.ndim !== 2) raise(T.ValueError ?? T.TypeError, `${a.ndim}-dimensional array given. Array must be two-dimensional`);
  const c = ascontig(a.dt.name === "float64" ? a : npcopy(a, F64()));
  return [Float64Array.from(c.data.subarray(0, a.shape[0] * a.shape[1])), a.shape[0], a.shape[1]];
}
function out(data: Float64Array | number[], shape: number[]): NDArray {
  const r = empty(shape, F64());
  r.data.set(data);
  return r;
}
function linalgError(msg: string): never {
  const E = (globalThis as any).__npLinAlgError;
  if (E) throw Obj.callObj(E, [msg]);
  return raise(T.ValueError, msg);
}

// Euclidean norm of x[off + i*stride], i < n, scaled to avoid overflow (as dnrm2).
function nrm2(x: Float64Array, off: number, n: number, stride: number): number {
  let big = 0;
  for (let i = 0, p = off; i < n; i++, p += stride) {
    const a = Math.abs(x[p]);
    if (a > big) big = a;
  }
  if (big === 0 || !Number.isFinite(big)) return big;
  let sum = 0;
  const inv = 1 / big;
  for (let i = 0, p = off; i < n; i++, p += stride) {
    const a = x[p] * inv;
    sum += a * a;
  }
  return big * Math.sqrt(sum);
}

// ------------------------------------------------------------------ LU

function lu(A: Float64Array, n: number): { lu: Float64Array; piv: number[]; sign: number; singular: boolean } {
  const a = Float64Array.from(A);
  const piv = Array.from({ length: n }, (_, i) => i);
  let sign = 1, singular = false;
  for (let k = 0; k < n; k++) {
    let p = k, big = Math.abs(a[k * n + k]);
    for (let i = k + 1; i < n; i++) {
      const v = Math.abs(a[i * n + k]);
      if (v > big) {
        big = v;
        p = i;
      }
    }
    if (p !== k) {
      for (let j = 0; j < n; j++) [a[k * n + j], a[p * n + j]] = [a[p * n + j], a[k * n + j]];
      [piv[k], piv[p]] = [piv[p], piv[k]];
      sign = -sign;
    }
    const d = a[k * n + k];
    if (d === 0) {
      singular = true;
      continue;
    }
    for (let i = k + 1; i < n; i++) {
      const f = (a[i * n + k] /= d);
      if (f === 0) continue;
      for (let j = k + 1; j < n; j++) a[i * n + j] -= f * a[k * n + j];
    }
  }
  return { lu: a, piv, sign, singular };
}

function luSolve(L: { lu: Float64Array; piv: number[] }, n: number, B: Float64Array, m: number): Float64Array {
  const a = L.lu;
  const x = new Float64Array(n * m);
  for (let i = 0; i < n; i++) for (let j = 0; j < m; j++) x[i * m + j] = B[L.piv[i] * m + j];
  for (let k = 0; k < n; k++) for (let i = k + 1; i < n; i++) {
    const f = a[i * n + k];
    if (f !== 0) for (let j = 0; j < m; j++) x[i * m + j] -= f * x[k * m + j];
  }
  for (let k = n - 1; k >= 0; k--) {
    const d = a[k * n + k];
    for (let j = 0; j < m; j++) x[k * m + j] /= d;
    for (let i = 0; i < k; i++) {
      const f = a[i * n + k];
      if (f !== 0) for (let j = 0; j < m; j++) x[i * m + j] -= f * x[k * m + j];
    }
  }
  return x;
}

// ------------------------------------------------------------------ QR (Householder)

function qr(A: Float64Array, m: number, n: number, complete: boolean): [Float64Array, Float64Array, number] {
  // columns stored contiguously: every Householder step works down columns
  const cols: Float64Array[] = [];
  for (let j = 0; j < n; j++) {
    const c = new Float64Array(m);
    for (let i = 0; i < m; i++) c[i] = A[i * n + j];
    cols.push(c);
  }
  const k = Math.min(m, n);
  const vs: Float64Array[] = [];
  const betas: number[] = [];
  for (let j = 0; j < k; j++) {
    const cj = cols[j];
    const norm = nrm2(cj, j, m - j, 1);
    const v = new Float64Array(m);
    if (norm === 0) {
      vs.push(v);
      betas.push(0);
      continue;
    }
    const alpha = cj[j] > 0 ? -norm : norm;
    for (let i = j; i < m; i++) v[i] = cj[i];
    v[j] -= alpha;
    let vv = 0;
    for (let i = j; i < m; i++) vv += v[i] * v[i];
    const beta = vv === 0 ? 0 : 2 / vv;
    for (let c = j; c < n; c++) {
      const cc = cols[c];
      let sum = 0;
      for (let i = j; i < m; i++) sum += v[i] * cc[i];
      sum *= beta;
      for (let i = j; i < m; i++) cc[i] -= sum * v[i];
    }
    vs.push(v);
    betas.push(beta);
  }
  const qc = complete ? m : k;
  const Qcols: Float64Array[] = [];
  for (let c = 0; c < qc; c++) {
    const q = new Float64Array(m);
    if (c < m) q[c] = 1;
    Qcols.push(q);
  }
  for (let j = k - 1; j >= 0; j--) {
    const v = vs[j], beta = betas[j];
    if (beta === 0) continue;
    for (let c = 0; c < qc; c++) {
      const q = Qcols[c];
      let sum = 0;
      for (let i = j; i < m; i++) sum += v[i] * q[i];
      if (sum === 0) continue;
      sum *= beta;
      for (let i = j; i < m; i++) q[i] -= sum * v[i];
    }
  }
  const Q = new Float64Array(m * qc);
  for (let c = 0; c < qc; c++) {
    const q = Qcols[c];
    for (let i = 0; i < m; i++) Q[i * qc + c] = q[i];
  }
  const rr = complete ? m : k;
  const R = new Float64Array(rr * n);
  for (let i = 0; i < Math.min(rr, m); i++) for (let c = i; c < n; c++) R[i * n + c] = cols[c][i];
  return [Q, R, qc];
}

// ------------------------------------------------------------------ symmetric eigenproblem (tred2 + tql2)

function symEig(A: Float64Array, n: number): [Float64Array, Float64Array] {
  const V: number[][] = [];
  for (let i = 0; i < n; i++) V.push(Array.from(A.subarray(i * n, i * n + n)));
  const d = new Array(n).fill(0), e = new Array(n).fill(0);
  for (let j = 0; j < n; j++) d[j] = V[n - 1][j];
  // Householder reduction to tridiagonal form
  for (let i = n - 1; i > 0; i--) {
    let scale = 0, h = 0;
    for (let k = 0; k < i; k++) scale += Math.abs(d[k]);
    if (scale === 0) {
      e[i] = d[i - 1];
      for (let j = 0; j < i; j++) {
        d[j] = V[i - 1][j];
        V[i][j] = 0;
        V[j][i] = 0;
      }
    } else {
      for (let k = 0; k < i; k++) {
        d[k] /= scale;
        h += d[k] * d[k];
      }
      let f = d[i - 1];
      let g = Math.sqrt(h);
      if (f > 0) g = -g;
      e[i] = scale * g;
      h -= f * g;
      d[i - 1] = f - g;
      for (let j = 0; j < i; j++) e[j] = 0;
      for (let j = 0; j < i; j++) {
        f = d[j];
        V[j][i] = f;
        g = e[j] + V[j][j] * f;
        for (let k = j + 1; k <= i - 1; k++) {
          g += V[k][j] * d[k];
          e[k] += V[k][j] * f;
        }
        e[j] = g;
      }
      f = 0;
      for (let j = 0; j < i; j++) {
        e[j] /= h;
        f += e[j] * d[j];
      }
      const hh = f / (h + h);
      for (let j = 0; j < i; j++) e[j] -= hh * d[j];
      for (let j = 0; j < i; j++) {
        f = d[j];
        g = e[j];
        for (let k = j; k <= i - 1; k++) V[k][j] -= f * e[k] + g * d[k];
        d[j] = V[i - 1][j];
        V[i][j] = 0;
      }
    }
    d[i] = h;
  }
  for (let i = 0; i < n - 1; i++) {
    V[n - 1][i] = V[i][i];
    V[i][i] = 1;
    const h = d[i + 1];
    if (h !== 0) {
      for (let k = 0; k <= i; k++) d[k] = V[k][i + 1] / h;
      for (let j = 0; j <= i; j++) {
        let g = 0;
        for (let k = 0; k <= i; k++) g += V[k][i + 1] * V[k][j];
        for (let k = 0; k <= i; k++) V[k][j] -= g * d[k];
      }
    }
    for (let k = 0; k <= i; k++) V[k][i + 1] = 0;
  }
  for (let j = 0; j < n; j++) {
    d[j] = V[n - 1][j];
    V[n - 1][j] = 0;
  }
  V[n - 1][n - 1] = 1;
  e[0] = 0;
  // implicit QL
  for (let i = 1; i < n; i++) e[i - 1] = e[i];
  e[n - 1] = 0;
  let f = 0, tst1 = 0;
  const eps = 2 ** -52;
  for (let l = 0; l < n; l++) {
    tst1 = Math.max(tst1, Math.abs(d[l]) + Math.abs(e[l]));
    let m = l;
    while (m < n) {
      if (Math.abs(e[m]) <= eps * tst1) break;
      m++;
    }
    if (m > l) {
      let iter = 0;
      do {
        iter++;
        if (iter > 300) linalgError("Eigenvalues did not converge");
        let g = d[l];
        let p = (d[l + 1] - g) / (2 * e[l]);
        let r = Math.hypot(p, 1);
        if (p < 0) r = -r;
        d[l] = e[l] / (p + r);
        d[l + 1] = e[l] * (p + r);
        const dl1 = d[l + 1];
        let h = g - d[l];
        for (let i = l + 2; i < n; i++) d[i] -= h;
        f += h;
        p = d[m];
        let c = 1, c2 = c, c3 = c;
        const el1 = e[l + 1];
        let s = 0, s2 = 0;
        for (let i = m - 1; i >= l; i--) {
          c3 = c2;
          c2 = c;
          s2 = s;
          g = c * e[i];
          h = c * p;
          r = Math.hypot(p, e[i]);
          e[i + 1] = s * r;
          s = e[i] / r;
          c = p / r;
          p = c * d[i] - s * g;
          d[i + 1] = h + s * (c * g + s * d[i]);
          for (let k = 0; k < n; k++) {
            h = V[k][i + 1];
            V[k][i + 1] = s * V[k][i] + c * h;
            V[k][i] = c * V[k][i] - s * h;
          }
        }
        p = (-s * s2 * c3 * el1 * e[l]) / dl1;
        e[l] = s * p;
        d[l] = c * p;
      } while (Math.abs(e[l]) > eps * tst1);
    }
    d[l] = d[l] + f;
    e[l] = 0;
  }
  // ascending order, as LAPACK
  const order = d.map((_, i) => i).sort((x, y) => d[x] - d[y]);
  const w = new Float64Array(n), vec = new Float64Array(n * n);
  order.forEach((src, dst) => {
    w[dst] = d[src];
    for (let k = 0; k < n; k++) vec[k * n + dst] = V[k][src];
  });
  return [w, vec];
}

// ------------------------------------------------------------------ general eigenproblem (orthes + hqr2)

function genEig(A: Float64Array, n: number): [Float64Array, Float64Array, Float64Array] {
  const H: number[][] = [];
  for (let i = 0; i < n; i++) H.push(Array.from(A.subarray(i * n, i * n + n)));
  const V: number[][] = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)));
  const ort = new Array(n).fill(0);
  const d = new Array(n).fill(0), e = new Array(n).fill(0);
  // reduce to Hessenberg form (orthes)
  const low = 0, high = n - 1;
  for (let m = low + 1; m <= high - 1; m++) {
    let scale = 0;
    for (let i = m; i <= high; i++) scale += Math.abs(H[i][m - 1]);
    if (scale !== 0) {
      let h = 0;
      for (let i = high; i >= m; i--) {
        ort[i] = H[i][m - 1] / scale;
        h += ort[i] * ort[i];
      }
      let g = Math.sqrt(h);
      if (ort[m] > 0) g = -g;
      h -= ort[m] * g;
      ort[m] -= g;
      for (let j = m; j < n; j++) {
        let f = 0;
        for (let i = high; i >= m; i--) f += ort[i] * H[i][j];
        f /= h;
        for (let i = m; i <= high; i++) H[i][j] -= f * ort[i];
      }
      for (let i = 0; i <= high; i++) {
        let f = 0;
        for (let j = high; j >= m; j--) f += ort[j] * H[i][j];
        f /= h;
        for (let j = m; j <= high; j++) H[i][j] -= f * ort[j];
      }
      ort[m] = scale * ort[m];
      H[m][m - 1] = scale * g;
    }
  }
  for (let m = high - 1; m >= low + 1; m--) {
    if (H[m][m - 1] !== 0) {
      for (let i = m + 1; i <= high; i++) ort[i] = H[i][m - 1];
      for (let j = m; j <= high; j++) {
        let g = 0;
        for (let i = m; i <= high; i++) g += ort[i] * V[i][j];
        g = g / ort[m] / H[m][m - 1];
        for (let i = m; i <= high; i++) V[i][j] += g * ort[i];
      }
    }
  }
  // hqr2: real Schur form and eigenvectors
  let nn = n, N = nn - 1;
  const eps = 2 ** -52;
  let exshift = 0, p = 0, q = 0, r = 0, s = 0, z = 0, t: number, w: number, x: number, y: number;
  let norm = 0;
  for (let i = 0; i < nn; i++) for (let j = Math.max(i - 1, 0); j < nn; j++) norm += Math.abs(H[i][j]);
  let iter = 0;
  let cdivr = 0, cdivi = 0;
  const cdiv = (xr: number, xi: number, yr: number, yi: number) => {
    let rr: number, dd: number;
    if (Math.abs(yr) > Math.abs(yi)) {
      rr = yi / yr;
      dd = yr + rr * yi;
      cdivr = (xr + rr * xi) / dd;
      cdivi = (xi - rr * xr) / dd;
    } else {
      rr = yr / yi;
      dd = yi + rr * yr;
      cdivr = (rr * xr + xi) / dd;
      cdivi = (rr * xi - xr) / dd;
    }
  };
  while (N >= low) {
    let l = N;
    while (l > low) {
      s = Math.abs(H[l - 1][l - 1]) + Math.abs(H[l][l]);
      if (s === 0) s = norm;
      if (Math.abs(H[l][l - 1]) < eps * s) break;
      l--;
    }
    if (l === N) {
      H[N][N] = H[N][N] + exshift;
      d[N] = H[N][N];
      e[N] = 0;
      N--;
      iter = 0;
    } else if (l === N - 1) {
      w = H[N][N - 1] * H[N - 1][N];
      p = (H[N - 1][N - 1] - H[N][N]) / 2;
      q = p * p + w;
      z = Math.sqrt(Math.abs(q));
      H[N][N] = H[N][N] + exshift;
      H[N - 1][N - 1] = H[N - 1][N - 1] + exshift;
      x = H[N][N];
      if (q >= 0) {
        z = p >= 0 ? p + z : p - z;
        d[N - 1] = x + z;
        d[N] = d[N - 1];
        if (z !== 0) d[N] = x - w / z;
        e[N - 1] = 0;
        e[N] = 0;
        x = H[N][N - 1];
        s = Math.abs(x) + Math.abs(z);
        p = x / s;
        q = z / s;
        r = Math.sqrt(p * p + q * q);
        p /= r;
        q /= r;
        for (let j = N - 1; j < nn; j++) {
          z = H[N - 1][j];
          H[N - 1][j] = q * z + p * H[N][j];
          H[N][j] = q * H[N][j] - p * z;
        }
        for (let i = 0; i <= N; i++) {
          z = H[i][N - 1];
          H[i][N - 1] = q * z + p * H[i][N];
          H[i][N] = q * H[i][N] - p * z;
        }
        for (let i = low; i <= high; i++) {
          z = V[i][N - 1];
          V[i][N - 1] = q * z + p * V[i][N];
          V[i][N] = q * V[i][N] - p * z;
        }
      } else {
        d[N - 1] = x + p;
        d[N] = x + p;
        e[N - 1] = z;
        e[N] = -z;
      }
      N -= 2;
      iter = 0;
    } else {
      x = H[N][N];
      y = 0;
      w = 0;
      if (l < N) {
        y = H[N - 1][N - 1];
        w = H[N][N - 1] * H[N - 1][N];
      }
      if (iter === 10) {
        exshift += x;
        for (let i = low; i <= N; i++) H[i][i] -= x;
        s = Math.abs(H[N][N - 1]) + Math.abs(H[N - 1][N - 2]);
        x = y = 0.75 * s;
        w = -0.4375 * s * s;
      }
      if (iter === 30) {
        s = (y - x) / 2;
        s = s * s + w;
        if (s > 0) {
          s = Math.sqrt(s);
          if (y < x) s = -s;
          s = x - w / ((y - x) / 2 + s);
          for (let i = low; i <= N; i++) H[i][i] -= s;
          exshift += s;
          x = y = w = 0.964;
        }
      }
      iter++;
      if (iter > 1000) linalgError("Eigenvalues did not converge");
      let m = N - 2;
      while (m >= l) {
        z = H[m][m];
        r = x - z;
        s = y - z;
        p = (r * s - w) / H[m + 1][m] + H[m][m + 1];
        q = H[m + 1][m + 1] - z - r - s;
        r = H[m + 2][m + 1];
        s = Math.abs(p) + Math.abs(q) + Math.abs(r);
        p /= s;
        q /= s;
        r /= s;
        if (m === l) break;
        if (Math.abs(H[m][m - 1]) * (Math.abs(q) + Math.abs(r)) < eps * (Math.abs(p) * (Math.abs(H[m - 1][m - 1]) + Math.abs(z) + Math.abs(H[m + 1][m + 1])))) break;
        m--;
      }
      for (let i = m + 2; i <= N; i++) {
        H[i][i - 2] = 0;
        if (i > m + 2) H[i][i - 3] = 0;
      }
      for (let k = m; k <= N - 1; k++) {
        const notlast = k !== N - 1;
        if (k !== m) {
          p = H[k][k - 1];
          q = H[k + 1][k - 1];
          r = notlast ? H[k + 2][k - 1] : 0;
          x = Math.abs(p) + Math.abs(q) + Math.abs(r);
          if (x === 0) continue;
          p /= x;
          q /= x;
          r /= x;
        }
        s = Math.sqrt(p * p + q * q + r * r);
        if (p < 0) s = -s;
        if (s !== 0) {
          if (k !== m) H[k][k - 1] = -s * x!;
          else if (l !== m) H[k][k - 1] = -H[k][k - 1];
          p += s;
          x = p / s;
          y = q / s;
          z = r / s;
          q /= p;
          r /= p;
          for (let j = k; j < nn; j++) {
            p = H[k][j] + q * H[k + 1][j];
            if (notlast) {
              p += r * H[k + 2][j];
              H[k + 2][j] -= p * z;
            }
            H[k][j] -= p * x;
            H[k + 1][j] -= p * y;
          }
          for (let i = 0; i <= Math.min(N, k + 3); i++) {
            p = x * H[i][k] + y * H[i][k + 1];
            if (notlast) {
              p += z * H[i][k + 2];
              H[i][k + 2] -= p * r;
            }
            H[i][k] -= p;
            H[i][k + 1] -= p * q;
          }
          for (let i = low; i <= high; i++) {
            p = x * V[i][k] + y * V[i][k + 1];
            if (notlast) {
              p += z * V[i][k + 2];
              V[i][k + 2] -= p * r;
            }
            V[i][k] -= p;
            V[i][k + 1] -= p * q;
          }
        }
      }
    }
  }
  // back substitution for the eigenvectors of the Schur form
  if (norm !== 0) {
    for (N = nn - 1; N >= 0; N--) {
      p = d[N];
      q = e[N];
      if (q === 0) {
        let l = N;
        H[N][N] = 1;
        for (let i = N - 1; i >= 0; i--) {
          w = H[i][i] - p;
          r = 0;
          for (let j = l; j <= N; j++) r += H[i][j] * H[j][N];
          if (e[i] < 0) {
            z = w;
            s = r;
          } else {
            l = i;
            if (e[i] === 0) H[i][N] = w !== 0 ? -r / w : -r / (eps * norm);
            else {
              x = H[i][i + 1];
              y = H[i + 1][i];
              q = (d[i] - p) * (d[i] - p) + e[i] * e[i];
              t = (x * s - z * r) / q;
              H[i][N] = t;
              H[i + 1][N] = Math.abs(x) > Math.abs(z) ? (-r - w * t) / x : (-s - y * t) / z;
            }
            t = Math.abs(H[i][N]);
            if (eps * t * t > 1) for (let j = i; j <= N; j++) H[j][N] /= t;
          }
        }
      } else if (q < 0) {
        let l = N - 1;
        if (Math.abs(H[N][N - 1]) > Math.abs(H[N - 1][N])) {
          H[N - 1][N - 1] = q / H[N][N - 1];
          H[N - 1][N] = -(H[N][N] - p) / H[N][N - 1];
        } else {
          cdiv(0, -H[N - 1][N], H[N - 1][N - 1] - p, q);
          H[N - 1][N - 1] = cdivr;
          H[N - 1][N] = cdivi;
        }
        H[N][N - 1] = 0;
        H[N][N] = 1;
        for (let i = N - 2; i >= 0; i--) {
          let ra = 0, sa = 0;
          for (let j = l; j <= N; j++) {
            ra += H[i][j] * H[j][N - 1];
            sa += H[i][j] * H[j][N];
          }
          w = H[i][i] - p;
          if (e[i] < 0) {
            z = w;
            r = ra;
            s = sa;
          } else {
            l = i;
            if (e[i] === 0) {
              cdiv(-ra, -sa, w, q);
              H[i][N - 1] = cdivr;
              H[i][N] = cdivi;
            } else {
              x = H[i][i + 1];
              y = H[i + 1][i];
              let vr = (d[i] - p) * (d[i] - p) + e[i] * e[i] - q * q;
              const vi = (d[i] - p) * 2 * q;
              if (vr === 0 && vi === 0) vr = eps * norm * (Math.abs(w) + Math.abs(q) + Math.abs(x) + Math.abs(y) + Math.abs(z));
              cdiv(x * r - z * ra + q * sa, x * s - z * sa - q * ra, vr, vi);
              H[i][N - 1] = cdivr;
              H[i][N] = cdivi;
              if (Math.abs(x) > Math.abs(z) + Math.abs(q)) {
                H[i + 1][N - 1] = (-ra - w * H[i][N - 1] + q * H[i][N]) / x;
                H[i + 1][N] = (-sa - w * H[i][N] - q * H[i][N - 1]) / x;
              } else {
                cdiv(-r - y * H[i][N - 1], -s - y * H[i][N], z, q);
                H[i + 1][N - 1] = cdivr;
                H[i + 1][N] = cdivi;
              }
            }
            t = Math.max(Math.abs(H[i][N - 1]), Math.abs(H[i][N]));
            if (eps * t * t > 1) for (let j = i; j <= N; j++) {
              H[j][N - 1] /= t;
              H[j][N] /= t;
            }
          }
        }
      }
    }
    for (let j = nn - 1; j >= low; j--) {
      for (let i = low; i <= high; i++) {
        z = 0;
        for (let k = low; k <= Math.min(j, high); k++) z += V[i][k] * H[k][j];
        V[i][j] = z;
      }
    }
  }
  // complex eigenvectors: columns (re, im) pairs; normalize each to unit norm as LAPACK
  const wr = Float64Array.from(d), wi = Float64Array.from(e);
  const vecs = new Float64Array(2 * n * n); // interleaved complex, row-major
  for (let j = 0; j < n; j++) {
    if (wi[j] === 0) {
      let nrm = 0;
      for (let i = 0; i < n; i++) nrm = Math.hypot(nrm, V[i][j]);
      for (let i = 0; i < n; i++) vecs[2 * (i * n + j)] = nrm ? V[i][j] / nrm : V[i][j];
    } else if (wi[j] > 0) {
      let nrm = 0;
      for (let i = 0; i < n; i++) nrm = Math.hypot(nrm, V[i][j], V[i][j + 1]);
      // LAPACK makes the component of largest modulus real
      let big = 0, bi = 0;
      for (let i = 0; i < n; i++) {
        const mod = V[i][j] ** 2 + V[i][j + 1] ** 2;
        if (mod > big) {
          big = mod;
          bi = i;
        }
      }
      const [pr, pi] = [V[bi][j], -V[bi][j + 1]];
      const pm = Math.hypot(pr, pi);
      const [ur, ui] = pm ? [pr / pm, pi / pm] : [1, 0];
      for (let i = 0; i < n; i++) {
        const re = (V[i][j] * ur - V[i][j + 1] * ui) / nrm, im = (V[i][j] * ui + V[i][j + 1] * ur) / nrm;
        vecs[2 * (i * n + j)] = re;
        vecs[2 * (i * n + j) + 1] = im;
        vecs[2 * (i * n + j + 1)] = re;
        vecs[2 * (i * n + j + 1) + 1] = -im;
      }
      j++;
    }
  }
  return [wr, wi, vecs];
}

// ------------------------------------------------------------------ SVD (one-sided Jacobi)

// Golub-Kahan-Reinsch SVD of an m x n matrix with m >= n (Householder
// bidiagonalization, then implicit shifted QR on the bidiagonal), as JAMA's
// SingularValueDecomposition (public domain).  Returns U's columns, S, V's columns.
function gkrSVD(Ain: Float64Array, m: number, n: number): [Float64Array[], Float64Array, Float64Array[]] {
  const A: Float64Array[] = [];
  for (let i = 0; i < m; i++) A.push(Ain.slice(i * n, i * n + n));
  const nu = Math.min(m, n);
  const s = new Float64Array(Math.min(m + 1, n));
  const U: Float64Array[] = Array.from({ length: m }, () => new Float64Array(nu));
  const V: Float64Array[] = Array.from({ length: n }, () => new Float64Array(n));
  const e = new Float64Array(n), work = new Float64Array(m);
  const nct = Math.min(m - 1, n), nrt = Math.max(0, Math.min(n - 2, m));
  for (let k = 0; k < Math.max(nct, nrt); k++) {
    if (k < nct) {
      for (let i = k; i < m; i++) work[i] = A[i][k];
      s[k] = nrm2(work, k, m - k, 1);
      if (s[k] !== 0) {
        if (A[k][k] < 0) s[k] = -s[k];
        for (let i = k; i < m; i++) A[i][k] /= s[k];
        A[k][k] += 1;
      }
      s[k] = -s[k];
    }
    for (let j = k + 1; j < n; j++) {
      if (k < nct && s[k] !== 0) {
        let t = 0;
        for (let i = k; i < m; i++) t += A[i][k] * A[i][j];
        t = -t / A[k][k];
        for (let i = k; i < m; i++) A[i][j] += t * A[i][k];
      }
      e[j] = A[k][j];
    }
    if (k < nct) for (let i = k; i < m; i++) U[i][k] = A[i][k];
    if (k < nrt) {
      e[k] = nrm2(e, k + 1, n - k - 1, 1);
      if (e[k] !== 0) {
        if (e[k + 1] < 0) e[k] = -e[k];
        for (let i = k + 1; i < n; i++) e[i] /= e[k];
        e[k + 1] += 1;
      }
      e[k] = -e[k];
      if (k + 1 < m && e[k] !== 0) {
        for (let i = k + 1; i < m; i++) work[i] = 0;
        for (let j = k + 1; j < n; j++) for (let i = k + 1; i < m; i++) work[i] += e[j] * A[i][j];
        for (let j = k + 1; j < n; j++) {
          const t = -e[j] / e[k + 1];
          for (let i = k + 1; i < m; i++) A[i][j] += t * work[i];
        }
      }
      for (let i = k + 1; i < n; i++) V[i][k] = e[i];
    }
  }
  let p = Math.min(n, m + 1);
  if (nct < n) s[nct] = A[nct][nct];
  if (m < p) s[p - 1] = 0;
  if (nrt + 1 < p) e[nrt] = A[nrt][p - 1];
  e[p - 1] = 0;
  for (let j = nct; j < nu; j++) {
    for (let i = 0; i < m; i++) U[i][j] = 0;
    U[j][j] = 1;
  }
  for (let k = nct - 1; k >= 0; k--) {
    if (s[k] !== 0) {
      for (let j = k + 1; j < nu; j++) {
        let t = 0;
        for (let i = k; i < m; i++) t += U[i][k] * U[i][j];
        t = -t / U[k][k];
        for (let i = k; i < m; i++) U[i][j] += t * U[i][k];
      }
      for (let i = k; i < m; i++) U[i][k] = -U[i][k];
      U[k][k] = 1 + U[k][k];
      for (let i = 0; i < k - 1; i++) U[i][k] = 0;
    } else {
      for (let i = 0; i < m; i++) U[i][k] = 0;
      U[k][k] = 1;
    }
  }
  for (let k = n - 1; k >= 0; k--) {
    if (k < nrt && e[k] !== 0) {
      for (let j = k + 1; j < nu; j++) {
        let t = 0;
        for (let i = k + 1; i < n; i++) t += V[i][k] * V[i][j];
        t = -t / V[k + 1][k];
        for (let i = k + 1; i < n; i++) V[i][j] += t * V[i][k];
      }
    }
    for (let i = 0; i < n; i++) V[i][k] = 0;
    V[k][k] = 1;
  }
  const pp = p - 1, eps = 2 ** -52, tiny = 2 ** -966;
  let iter = 0;
  while (p > 0) {
    let k: number, kase: number;
    for (k = p - 2; k >= -1; k--) {
      if (k === -1) break;
      if (Math.abs(e[k]) <= tiny + eps * (Math.abs(s[k]) + Math.abs(s[k + 1]))) {
        e[k] = 0;
        break;
      }
    }
    if (k === p - 2) kase = 4;
    else {
      let ks: number;
      for (ks = p - 1; ks >= k; ks--) {
        if (ks === k) break;
        const t = (ks !== p ? Math.abs(e[ks]) : 0) + (ks !== k + 1 ? Math.abs(e[ks - 1]) : 0);
        if (Math.abs(s[ks]) <= tiny + eps * t) {
          s[ks] = 0;
          break;
        }
      }
      if (ks === k) kase = 3;
      else if (ks === p - 1) kase = 1;
      else {
        kase = 2;
        k = ks;
      }
    }
    k++;
    if (++iter > 75 * n + 1000) linalgError("SVD did not converge");
    if (kase === 1) {
      let f = e[p - 2];
      e[p - 2] = 0;
      for (let j = p - 2; j >= k; j--) {
        let t = Math.hypot(s[j], f);
        const cs = s[j] / t, sn = f / t;
        s[j] = t;
        if (j !== k) {
          f = -sn * e[j - 1];
          e[j - 1] = cs * e[j - 1];
        }
        for (let i = 0; i < n; i++) {
          t = cs * V[i][j] + sn * V[i][p - 1];
          V[i][p - 1] = -sn * V[i][j] + cs * V[i][p - 1];
          V[i][j] = t;
        }
      }
    } else if (kase === 2) {
      let f = e[k - 1];
      e[k - 1] = 0;
      for (let j = k; j < p; j++) {
        let t = Math.hypot(s[j], f);
        const cs = s[j] / t, sn = f / t;
        s[j] = t;
        f = -sn * e[j];
        e[j] = cs * e[j];
        for (let i = 0; i < m; i++) {
          t = cs * U[i][j] + sn * U[i][k - 1];
          U[i][k - 1] = -sn * U[i][j] + cs * U[i][k - 1];
          U[i][j] = t;
        }
      }
    } else if (kase === 3) {
      const scale = Math.max(Math.abs(s[p - 1]), Math.abs(s[p - 2]), Math.abs(e[p - 2]), Math.abs(s[k]), Math.abs(e[k]));
      const sp = s[p - 1] / scale, spm1 = s[p - 2] / scale, epm1 = e[p - 2] / scale, sk = s[k] / scale, ek = e[k] / scale;
      const b = ((spm1 + sp) * (spm1 - sp) + epm1 * epm1) / 2, c = sp * epm1 * (sp * epm1);
      let shift = 0;
      if (b !== 0 || c !== 0) {
        shift = Math.sqrt(b * b + c);
        if (b < 0) shift = -shift;
        shift = c / (b + shift);
      }
      let f = (sk + sp) * (sk - sp) + shift, g = sk * ek;
      for (let j = k; j < p - 1; j++) {
        let t = Math.hypot(f, g);
        let cs = f / t, sn = g / t;
        if (j !== k) e[j - 1] = t;
        f = cs * s[j] + sn * e[j];
        e[j] = cs * e[j] - sn * s[j];
        g = sn * s[j + 1];
        s[j + 1] = cs * s[j + 1];
        for (let i = 0; i < n; i++) {
          t = cs * V[i][j] + sn * V[i][j + 1];
          V[i][j + 1] = -sn * V[i][j] + cs * V[i][j + 1];
          V[i][j] = t;
        }
        t = Math.hypot(f, g);
        cs = f / t;
        sn = g / t;
        s[j] = t;
        f = cs * e[j] + sn * s[j + 1];
        s[j + 1] = -sn * e[j] + cs * s[j + 1];
        g = sn * e[j + 1];
        e[j + 1] = cs * e[j + 1];
        if (j < m - 1) for (let i = 0; i < m; i++) {
          t = cs * U[i][j] + sn * U[i][j + 1];
          U[i][j + 1] = -sn * U[i][j] + cs * U[i][j + 1];
          U[i][j] = t;
        }
      }
      e[p - 2] = f;
    } else {
      if (s[k] <= 0) {
        s[k] = s[k] < 0 ? -s[k] : 0;
        for (let i = 0; i <= pp; i++) V[i][k] = -V[i][k];
      }
      while (k < pp) {
        if (s[k] >= s[k + 1]) break;
        let t = s[k];
        s[k] = s[k + 1];
        s[k + 1] = t;
        if (k < n - 1) for (let i = 0; i < n; i++) {
          t = V[i][k + 1];
          V[i][k + 1] = V[i][k];
          V[i][k] = t;
        }
        if (k < m - 1) for (let i = 0; i < m; i++) {
          t = U[i][k + 1];
          U[i][k + 1] = U[i][k];
          U[i][k] = t;
        }
        k++;
      }
      iter = 0;
      p--;
    }
  }
  // as columns
  const Ucols = Array.from({ length: nu }, (_, j) => Float64Array.from({ length: m }, (_, i) => U[i][j]));
  const Vcols = Array.from({ length: n }, (_, j) => Float64Array.from({ length: n }, (_, i) => V[i][j]));
  return [Ucols, s.slice(0, n), Vcols];
}

function svd(A: Float64Array, m: number, n: number): [Float64Array, Float64Array, Float64Array] {
  // work on the transpose when m < n, so that the matrix is tall
  const trans = m < n;
  const [M, N] = trans ? [n, m] : [m, n];
  let T = A;
  if (trans) {
    T = new Float64Array(M * N);
    for (let i = 0; i < m; i++) for (let j = 0; j < n; j++) T[j * N + i] = A[i * n + j];
  }
  // a tall matrix: QR first, then the SVD of the small R (U = Q U_R)
  let Wcols: Float64Array[], S: Float64Array, Vcols: Float64Array[];
  if (M > N + N / 2) {
    const [Q, R] = qr(T, M, N, false);
    const [Wr, Sr, Vr] = gkrSVD(R, N, N);
    Wcols = Wr.map((col) => {
      const u = new Float64Array(M);
      for (let i = 0; i < M; i++) {
        let sum = 0;
        for (let k = 0; k < N; k++) sum += Q[i * N + k] * col[k];
        u[i] = sum;
      }
      return u;
    });
    S = Sr;
    Vcols = Vr;
  } else [Wcols, S, Vcols] = gkrSVD(T, M, N);
  // descending singular values
  const order = Array.from(S.keys()).sort((a, b) => S[b] - S[a]);
  const So = Float64Array.from(order.map((i) => S[i]));
  const Uo = new Float64Array(M * N), Vo = new Float64Array(N * N);
  order.forEach((src, dst) => {
    for (let i = 0; i < M; i++) Uo[i * N + dst] = Wcols[src][i];
    for (let i = 0; i < N; i++) Vo[i * N + dst] = Vcols[src][i];
  });
  // complete zero columns of U to an orthonormal set
  for (let j = 0; j < N; j++) {
    if (So[j] > 0) continue;
    for (let e = 0; e < M; e++) {
      const col = new Float64Array(M);
      col[e] = 1;
      for (let k = 0; k < N; k++) {
        if (k === j || (So[k] === 0 && k > j)) continue;
        let dot = 0;
        for (let i = 0; i < M; i++) dot += Uo[i * N + k] * col[i];
        for (let i = 0; i < M; i++) col[i] -= dot * Uo[i * N + k];
      }
      let nrm = 0;
      for (let i = 0; i < M; i++) nrm = Math.hypot(nrm, col[i]);
      if (nrm > 1e-8) {
        for (let i = 0; i < M; i++) Uo[i * N + j] = col[i] / nrm;
        break;
      }
    }
  }
  return trans ? [Vo, So, Uo] : [Uo, So, Vo];
}

// ------------------------------------------------------------------ the module

newBuiltinModule("_nplinalg", (m) => {
  const fn = (name: string, f: any) => (m[name] = Obj.builtin(f, name));
  fn("set_error", (cls: any) => ((globalThis as any).__npLinAlgError = cls, null));
  fn("det", (a: NDArray) => {
    const [A, r, c] = mat(a);
    if (r !== c) linalgError("Last 2 dimensions of the array must be square");
    const L = lu(A, r);
    // as numpy/linalg/umath_linalg.cpp: sign * exp(sum of log|u_ii|)
    let sign = L.sign, logdet = 0;
    for (let i = 0; i < r; i++) {
      const v = L.lu[i * r + i];
      if (v === 0) return 0;
      if (v < 0) sign = -sign;
      logdet += glibcLog(Math.abs(v));
    }
    return sign * glibcExp(logdet);
  });
  fn("slogdet", (a: NDArray) => {
    const [A, r] = mat(a);
    const L = lu(A, r);
    let sign = L.sign, logdet = 0;
    for (let i = 0; i < r; i++) {
      const v = L.lu[i * r + i];
      if (v === 0) return tuple([0, -Infinity]);
      if (v < 0) sign = -sign;
      logdet += glibcLog(Math.abs(v));
    }
    return tuple([sign, logdet]);
  });
  fn("solve", (a: NDArray, b: NDArray) => {
    const [A, n, c] = mat(a);
    if (n !== c) linalgError("Last 2 dimensions of the array must be square");
    const vec = b.ndim === 1;
    const bb = vec ? empty([b.shape[0], 1], F64()) : null;
    if (bb) for (let i = 0; i < b.shape[0]; i++) bb.data[i] = ascontig(b).data[i];
    const [B, br, bc] = mat(bb ?? b);
    if (br !== n) raise(T.ValueError, `solve: Input operand 1 has a mismatch in its core dimension 0, with gufunc signature (m,m),(m,n)->(m,n) (size ${br} is different from ${n})`);
    const L = lu(A, n);
    if (L.singular) linalgError("Singular matrix");
    const X = luSolve(L, n, B, bc);
    return out(X, vec ? [n] : [n, bc]);
  });
  fn("inv", (a: NDArray) => {
    const [A, n, c] = mat(a);
    if (n !== c) linalgError("Last 2 dimensions of the array must be square");
    const L = lu(A, n);
    if (L.singular) linalgError("Singular matrix");
    const I = new Float64Array(n * n);
    for (let i = 0; i < n; i++) I[i * n + i] = 1;
    return out(luSolve(L, n, I, n), [n, n]);
  });
  fn("qr", (a: NDArray, complete: any) => {
    const [A, r, c] = mat(a);
    const [Q, R, qc] = qr(A, r, c, !!complete);
    return tuple([out(Q, [r, qc]), out(R, [complete ? r : Math.min(r, c), c])]);
  });
  fn("cholesky", (a: NDArray) => {
    const [A, n] = mat(a);
    const L = new Float64Array(n * n);
    for (let j = 0; j < n; j++) {
      let s = A[j * n + j];
      for (let k = 0; k < j; k++) s -= L[j * n + k] * L[j * n + k];
      if (!(s > 0)) linalgError("Matrix is not positive definite");
      const d = Math.sqrt(s);
      L[j * n + j] = d;
      for (let i = j + 1; i < n; i++) {
        let t = A[i * n + j];
        for (let k = 0; k < j; k++) t -= L[i * n + k] * L[j * n + k];
        L[i * n + j] = t / d;
      }
    }
    return out(L, [n, n]);
  });
  fn("eigh", (a: NDArray, upper: any) => {
    const [A, n] = mat(a);
    // use one triangle, as LAPACK (UPLO='L' by default)
    const S = new Float64Array(n * n);
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) S[i * n + j] = upper ? (i <= j ? A[i * n + j] : A[j * n + i]) : i >= j ? A[i * n + j] : A[j * n + i];
    const [w, v] = n ? symEig(S, n) : [new Float64Array(0), new Float64Array(0)];
    return tuple([out(w, [n]), out(v, [n, n])]);
  });
  fn("eig", (a: NDArray) => {
    const [A, n, c] = mat(a);
    if (n !== c) linalgError("Last 2 dimensions of the array must be square");
    for (const v of A) if (!Number.isFinite(v)) linalgError("Array must not contain infs or NaNs");
    const [wr, wi, vecs] = genEig(A, n);
    const cplx = wi.some((v) => v !== 0);
    if (!cplx) {
      const vr = new Float64Array(n * n);
      for (let k = 0; k < n * n; k++) vr[k] = vecs[2 * k];
      return tuple([out(wr, [n]), out(vr, [n, n])]);
    }
    const cdt = toDtype("complex128");
    const w = empty([n], cdt);
    for (let i = 0; i < n; i++) {
      w.data[2 * i] = wr[i];
      w.data[2 * i + 1] = wi[i];
    }
    const v = empty([n, n], cdt);
    v.data.set(vecs);
    return tuple([w, v]);
  });
  fn("svd", (a: NDArray, fullMatrices: any, computeUV: any) => {
    const [A, r, c] = mat(a);
    const [U, S, V] = svd(A, r, c);
    const k = Math.min(r, c);
    const s = out(S.subarray(0, k), [k]);
    if (!computeUV) return s;
    // U is r x k, V is c x k
    const Ur = new Float64Array(r * k), Vt = new Float64Array(k * c);
    const uc = U.length / r, vc = V.length / c;
    for (let i = 0; i < r; i++) for (let j = 0; j < k; j++) Ur[i * k + j] = U[i * uc + j];
    for (let i = 0; i < k; i++) for (let j = 0; j < c; j++) Vt[i * c + j] = V[j * vc + i];
    if (fullMatrices && (k < r || k < c)) {
      // complete the bases with QR of [U | I] and [V | I]
      const complete = (B: Float64Array, rows: number, cols: number): Float64Array => {
        const aug = new Float64Array(rows * rows);
        for (let i = 0; i < rows; i++) for (let j = 0; j < cols; j++) aug[i * rows + j] = B[i * cols + j];
        for (let i = 0; i < rows; i++) for (let j = cols; j < rows; j++) aug[i * rows + j] = i === j - cols ? 1 : 0;
        // Gram-Schmidt on the extra columns
        const Q = Float64Array.from(aug);
        let filled = cols;
        for (let e = 0; e < rows && filled < rows; e++) {
          const col = new Float64Array(rows);
          col[e] = 1;
          for (let pass = 0; pass < 2; pass++) for (let k2 = 0; k2 < filled; k2++) {
            let dot = 0;
            for (let i = 0; i < rows; i++) dot += Q[i * rows + k2] * col[i];
            for (let i = 0; i < rows; i++) col[i] -= dot * Q[i * rows + k2];
          }
          let nrm = 0;
          for (let i = 0; i < rows; i++) nrm = Math.hypot(nrm, col[i]);
          if (nrm < 1e-10) continue;
          for (let i = 0; i < rows; i++) Q[i * rows + filled] = col[i] / nrm;
          filled++;
        }
        return Q;
      };
      const Uf = k < r ? complete(Ur, r, k) : Ur;
      let Vf: Float64Array;
      if (k < c) {
        const V2 = new Float64Array(c * k);
        for (let i = 0; i < c; i++) for (let j = 0; j < k; j++) V2[i * k + j] = Vt[j * c + i];
        const Vc = complete(V2, c, k);
        Vf = new Float64Array(c * c);
        for (let i = 0; i < c; i++) for (let j = 0; j < c; j++) Vf[i * c + j] = Vc[j * c + i];
      } else Vf = Vt;
      return tuple([out(Uf, [r, k < r ? r : k]), s, out(Vf, [k < c ? c : k, c])]);
    }
    return tuple([out(Ur, [r, k]), s, out(Vt, [k, c])]);
  });
});
