//! A norm bound T such that, under GRH, the prime ideals of norm < T generate
//! the class group, computed for the field at hand.
//!
//! The criterion is Belabas, Diaz y Diaz and Friedman's (Math. Comp. 77
//! (2008); as restated by Grenie and Molteni, arXiv:1607.02430, Theorem 2.2):
//! if F = Phi * Phi, with Phi even and supported in [-L/2, L/2], L = log T,
//! makes the linear form
//!
//!   l(F) = -2 sum_{P, m} log NP F(m log NP) / NP^(m/2)
//!          + F(0) (log d - (gamma + log 8 pi) n) + I(F) n - J(F) r1
//!
//! negative, the primes of norm < T generate.  For F_L = (L - |x|) on
//! [-L, L] (Phi the indicator of [-L/2, L/2]) the integrals are dilogarithms
//! (op. cit., Section 4):
//!
//!   I(F_L) = pi^2/2 - 4 Li2(e^(-L/2)) + Li2(e^(-L)),
//!   J(F_L) = pi L/2 - 4 C + 4 Im Li2(i e^(-L/2))       (C Catalan's),
//!
//! and the prime sum over m log NP < L is -2 (L W(L) - U(L)) with W, U prefix
//! sums of w = log NP / NP^(m/2) and w m log NP.  The search is Grenie and
//! Molteni's (arXiv:1507.00602; arXiv:1607.02430, Section 6): Phi a step
//! function with N steps of width delta, Phi = sum v_i 1_(-i delta, i delta),
//! for which l(Phi * Phi) = v^T A v with A_ij = l(F_(i+j)delta) -
//! l(F_|i-j|delta); a negative pivot of A's LDL^T factorization gives v with
//! v^T A v < 0, so T = e^(2 N delta).  The witness v is checked directly, with
//! a margin for rounding, before T is used.
//!
//! If no witness is found below it, the result is the uniform bound
//! 4 log^2 d (Grenie and Molteni, arXiv:2212.09461, Theorem 2: T <=
//! (4 - 1/(2n) + 1/(2n^2)) log^2 d for every field of degree n >= 2).

const EULER_GAMMA: f64 = 0.577_215_664_901_532_9;
const CATALAN: f64 = 0.915_965_594_177_219;
const PI: f64 = std::f64::consts::PI;

/// Bernoulli numbers B_0 .. B_28 (B_1 = -1/2), for the dilogarithm series.
const BERNOULLI: [f64; 29] = [
    1.0, -0.5, 1.0 / 6.0, 0.0, -1.0 / 30.0, 0.0, 1.0 / 42.0, 0.0, -1.0 / 30.0, 0.0, 5.0 / 66.0, 0.0, -691.0 / 2730.0, 0.0, 7.0 / 6.0, 0.0,
    -3617.0 / 510.0, 0.0, 43867.0 / 798.0, 0.0, -174611.0 / 330.0, 0.0, 854513.0 / 138.0, 0.0, -236364091.0 / 2730.0, 0.0, 8553103.0 / 6.0, 0.0,
    -23749461029.0 / 870.0,
];

/// Li2(z) for |-log(1 - z)| < 1.5: sum B_k w^(k+1) / (k+1)!, w = -log(1 - z)
/// (the terms shrink like (|w| / 2 pi)^k).
fn li2_bernoulli(re: f64, im: f64) -> (f64, f64) {
    // w = -log(1 - z)
    let (ar, ai) = (1.0 - re, -im);
    let (wr, wi) = (-(ar * ar + ai * ai).sqrt().ln(), -ai.atan2(ar));
    let (mut pr, mut pi) = (wr, wi); // w^(k+1) / (k+1)!
    let (mut sr, mut si) = (0.0, 0.0);
    for (k, b) in BERNOULLI.iter().enumerate() {
        sr += b * pr;
        si += b * pi;
        let d = (k + 2) as f64;
        (pr, pi) = ((pr * wr - pi * wi) / d, (pr * wi + pi * wr) / d);
    }
    (sr, si)
}

/// Li2(x) for real 0 <= x < 1.
pub fn li2(x: f64) -> f64 {
    if x > 0.5 {
        // Euler's reflection
        PI * PI / 6.0 - x.ln() * (-x).ln_1p() - li2_bernoulli(1.0 - x, 0.0).0
    } else {
        li2_bernoulli(x, 0.0).0
    }
}

/// Im Li2(i y) for 0 <= y <= 1 (the inverse tangent integral).
pub fn ti2(y: f64) -> f64 {
    li2_bernoulli(0.0, y).1
}

/// The prime ideals' contribution to the explicit formula, by prefix sums.
pub struct Explicit {
    n: f64,
    r1: f64,
    log_d: f64,
    /// m log NP, ascending, with prefix sums of w and w m log NP
    u: Vec<f64>,
    w_sum: Vec<f64>,
    wu_sum: Vec<f64>,
}

impl Explicit {
    /// `norms`: the norms of all prime ideals of norm below `t_max`.
    pub fn new(n: usize, r1: usize, log_d: f64, norms: &[u64], t_max: f64) -> Explicit {
        let mut terms: Vec<(f64, f64)> = vec![];
        for &q in norms {
            let lq = (q as f64).ln();
            let mut m = 1;
            while (m as f64) * lq < t_max.ln() {
                terms.push((m as f64 * lq, lq * (-(m as f64) * lq / 2.0).exp()));
                m += 1;
            }
        }
        terms.sort_by(|a, b| a.0.total_cmp(&b.0));
        let (mut w_sum, mut wu_sum) = (vec![0.0], vec![0.0]);
        for &(u, w) in &terms {
            w_sum.push(w_sum.last().unwrap() + w);
            wu_sum.push(wu_sum.last().unwrap() + w * u);
        }
        Explicit { n: n as f64, r1: r1 as f64, log_d, u: terms.into_iter().map(|t| t.0).collect(), w_sum, wu_sum }
    }

    /// l(F_L) for F_L = (L - |x|) on [-L, L]; l(F_0) = 0.
    pub fn ell(&self, l: f64) -> f64 {
        if l <= 0.0 {
            return 0.0;
        }
        let k = self.u.partition_point(|&u| u < l);
        let primes = -2.0 * (l * self.w_sum[k] - self.wu_sum[k]);
        let x = (-l / 2.0).exp();
        let i = PI * PI / 2.0 - 4.0 * li2(x) + li2(x * x);
        let j = PI * l / 2.0 - 4.0 * CATALAN + 4.0 * ti2(x);
        primes + l * (self.log_d - (EULER_GAMMA + (8.0 * PI).ln()) * self.n) + i * self.n - j * self.r1
    }

    /// The one-step test (Belabas, Diaz y Diaz and Friedman's own).
    pub fn one_step(&self, t: f64) -> bool {
        self.ell(t.ln()) < 0.0
    }

    /// A step function with at most `nmax` steps of width `delta` making the
    /// form negative: Some(v), checked directly with a rounding margin.
    pub fn witness(&self, delta: f64, nmax: usize) -> Option<Vec<f64>> {
        let tab: Vec<f64> = (0..=2 * nmax).map(|k| self.ell(k as f64 * delta)).collect();
        let a = |i: usize, j: usize| tab[i + j + 2] - tab[i.abs_diff(j)];
        // incremental L D L^T of A (0-based: A_ij = l(F_(i+j+2)delta) - ...)
        let mut lo: Vec<Vec<f64>> = vec![];
        let mut d: Vec<f64> = vec![];
        for k in 0..nmax {
            let mut row = vec![0.0; k + 1];
            for j in 0..k {
                let mut s = a(k, j);
                for (m, dm) in d.iter().enumerate().take(j) {
                    s -= row[m] * lo[j][m] * dm;
                }
                row[j] = s / d[j];
            }
            let mut dk = a(k, k);
            for (m, dm) in d.iter().enumerate() {
                dk -= row[m] * row[m] * dm;
            }
            row[k] = 1.0;
            if dk < 0.0 {
                // v = L^-T e_k: then v^T A v = d_k
                let mut v = vec![0.0; k + 1];
                v[k] = 1.0;
                for i in (0..k).rev() {
                    let mut s = 0.0;
                    for (m, vm) in v.iter().enumerate().skip(i + 1) {
                        let lmi = if m == k { row[i] } else { lo[m][i] };
                        s -= lmi * vm;
                    }
                    v[i] = s;
                }
                let (mut q, mut mag) = (0.0, 0.0);
                for i in 0..=k {
                    for j in 0..=k {
                        q += v[i] * v[j] * a(i, j);
                        mag += (v[i] * v[j] * a(i, j)).abs();
                    }
                }
                return if q < -1e-9 * mag.max(1.0) { Some(v) } else { None };
            }
            if dk == 0.0 {
                return None;
            }
            lo.push(row);
            d.push(dk);
        }
        None
    }

    fn good(&self, t: f64, n: usize) -> bool {
        t > 1.0 && self.witness(t.ln() / (2 * n) as f64, n).is_some()
    }

    /// The smallest candidate T in `cands` (ascending, last one good) that
    /// is good with n steps, by dichotomy.
    fn optimal(&self, cands: &[f64], n: usize) -> f64 {
        let (mut lo, mut hi) = (0, cands.len() - 1);
        while lo < hi {
            let mid = (lo + hi) / 2;
            if self.good(cands[mid], n) {
                hi = mid;
            } else {
                lo = mid + 1;
            }
        }
        cands[hi]
    }
}

/// Grenie and Molteni's bound for the norms of class group generators, at
/// most `t0` (a proven uniform bound): the prime ideals of norm < T generate.
/// `norms` are the norms of all prime ideals of norm below t0.
pub fn class_group_bound(n: usize, r1: usize, log_d: f64, norms: &[u64], t0: f64) -> f64 {
    let ex = Explicit::new(n, r1, log_d, norms, t0);
    // T only matters up to the norms below it: candidates are the distinct
    // norms (T = q means the primes of norm < q)
    let mut cand: Vec<f64> = norms.iter().map(|&q| q as f64).filter(|&q| q > 1.0 && q < t0).collect();
    cand.sort_by(|a, b| a.total_cmp(b));
    cand.dedup();
    let between = |lo: f64, hi: f64| -> Vec<f64> {
        let mut v: Vec<f64> = cand.iter().copied().filter(|&q| q >= lo && q < hi).collect();
        v.push(hi);
        v
    };
    let (mut nsteps, step) = (8usize, 0.0625);
    let mut delta = step;
    while !ex.good((2.0 * nsteps as f64 * delta).exp(), nsteps) {
        delta += step;
        if (2.0 * nsteps as f64 * delta).exp() >= t0 {
            return t0;
        }
    }
    let hi = (2.0 * nsteps as f64 * delta).exp();
    let mut th = ex.optimal(&between((2.0 * nsteps as f64 * (delta - step)).exp(), hi), nsteps);
    // more and finer steps while the bound improves
    loop {
        nsteps *= 2;
        if nsteps > 256 || !ex.good(th, nsteps) {
            break;
        }
        let t = ex.optimal(&between(1.0, th), nsteps);
        if t >= th {
            break;
        }
        th = t;
    }
    th.min(t0)
}

/// Belabas, Diaz y Diaz and Friedman's own bound (one step): the smallest
/// norm q < t0 with the one-step test true at T = q, else t0.
pub fn one_step_bound(n: usize, r1: usize, log_d: f64, norms: &[u64], t0: f64) -> f64 {
    let ex = Explicit::new(n, r1, log_d, norms, t0);
    let mut cand: Vec<u64> = norms.iter().copied().filter(|&q| q > 1 && (q as f64) < t0).collect();
    cand.sort();
    cand.dedup();
    cand.into_iter().map(|q| q as f64).find(|&q| ex.one_step(q)).unwrap_or(t0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dilogarithms() {
        let ln2 = 2f64.ln();
        assert!((li2(0.5) - (PI * PI / 12.0 - ln2 * ln2 / 2.0)).abs() < 1e-15);
        assert!((li2(0.0)).abs() < 1e-18);
        assert!((li2(0.999) - 1.637_022_605_276_117_7).abs() < 1e-14, "{}", li2(0.999));
        assert!((ti2(1.0) - CATALAN).abs() < 1e-15);
        // Ti2(y) = sum (-1)^k y^(2k+1) / (2k+1)^2 at y = 0.3
        let s: f64 = (0..30).map(|k| (-1f64).powi(k) * 0.3f64.powi(2 * k + 1) / ((2 * k + 1) as f64).powi(2)).sum();
        assert!((ti2(0.3) - s).abs() < 1e-16);
        // against the defining integrals of I(F_L) and J(F_L), by Simpson
        let l = 3.7;
        let simpson = |f: &dyn Fn(f64) -> f64, a: f64, b: f64| {
            let m = 20000;
            let h = (b - a) / m as f64;
            (0..=m).map(|k| f(a + k as f64 * h) * if k == 0 || k == m { 1.0 } else if k % 2 == 1 { 4.0 } else { 2.0 }).sum::<f64>() * h / 3.0
        };
        let fl = |x: f64| if x < l { l - x } else { 0.0 };
        let i = simpson(&|x| if x == 0.0 { 1.0 } else { (l - fl(x)) / (2.0 * (x / 2.0).sinh()) }, 0.0, l) + simpson(&|x| l / (2.0 * (x / 2.0).sinh()), l, 80.0);
        let j = simpson(&|x| fl(x) / (2.0 * (x / 2.0).cosh()), 0.0, l);
        let x = (-l / 2.0).exp();
        assert!((i - (PI * PI / 2.0 - 4.0 * li2(x) + li2(x * x))).abs() < 1e-9, "{}", i);
        assert!((j - (PI * l / 2.0 - 4.0 * CATALAN + 4.0 * ti2(x))).abs() < 1e-9, "{}", j);
    }
}
