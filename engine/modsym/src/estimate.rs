//! Predicted dimension, memory and time before running anything, so a
//! caller (or an agent) can decide what is affordable.  The constants are
//! fitted to measurements on an 8-core AMD EPYC (see results/engine-exact.md).

use crate::exact::{bound_bits, level_data};
use crate::linalg::heilbronn;

pub struct Estimate {
    pub n: u64,
    pub q: u64,
    pub symbols: u64,
    pub dim: u64,
    pub genus: u64,
    /// Primes the exact characteristic polynomial typically needs (the
    /// proven bound from the sum of squares, with Sato-Tate's r = sqrt(q)),
    /// and at most (the worst-case Deligne bound).
    pub primes: u64,
    pub primes_max: u64,
    /// Peak bytes for one prime, and for the exact computation (up to 8
    /// primes are in flight at once).
    pub bytes_modp: f64,
    pub bytes_exact: f64,
    /// Single-thread seconds for one prime, and for the exact computation.
    pub seconds_modp: f64,
    pub seconds_exact: f64,
}

// Fitted on one thread for dim 84..3334: free generators are psi/4; the
// elimination constant is an upper bound (highly composite levels have the
// most fill-in, prime levels are ~5x cheaper); the charpoly constant grows
// once the matrix leaves the cache.
const GENS_PER_SYMBOL: f64 = 0.25;
const ELIM: f64 = 4e-8;
const HECKE: f64 = 3e-9;
const CHARPOLY: f64 = 4.4e-10;

pub fn estimate(n: u64, q: u64) -> Estimate {
    let (psi, genus, _, eis, dim) = level_data(n);
    let (m, d) = (GENS_PER_SYMBOL * psi as f64, dim as f64);
    let h = heilbronn(q as i64).len() as f64;
    let primes_max = (bound_bits(q, genus, eis) / 30.99).ceil();
    let typical = genus as f64 * (1.0 + (q as f64).sqrt()).log2() + eis as f64 * (2.0 + q as f64).log2() + 2.0;
    let primes = (typical / 30.99).ceil().min(primes_max);
    // Dense coordinates of every free generator dominate, then the matrix.
    let bytes_modp = 8.0 * m * d + 4.0 * d * d + 3e6;
    let seconds_modp = ELIM * m * d + HECKE * h * d * d + CHARPOLY * (1.0 + d / 4000.0) * d * d * d;
    Estimate {
        n,
        q,
        symbols: psi,
        dim,
        genus,
        primes: primes as u64,
        primes_max: primes_max as u64,
        bytes_modp,
        bytes_exact: bytes_modp * primes.min(8.0),
        seconds_modp,
        seconds_exact: seconds_modp * primes,
    }
}

/// What `newforms` (newspace_orbits + orbit_traces, trivial character)
/// will cost, before running it: the quantities that drive each stage, and
/// predicted seconds and peak bytes for the WebAssembly build on one thread
/// (fitted on every stored space of the atlas; see web/atlas/README.md).
pub struct NewformsEstimate {
    pub n: u64,
    pub k: usize,
    pub bound: usize,
    /// dim S_k^new(Gamma_0(N)), and dim M_k(Gamma_0(N))^+ (the matrices).
    pub dim_new: u64,
    pub dim_top: u64,
    pub levels: usize,
    /// Manin symbols over all levels M | N.
    pub symbols: f64,
    /// CRT primes for the characteristic polynomial of T, and for the traces.
    pub primes: u64,
    pub trace_primes: u64,
    /// The model's terms (see `NEWFORMS_TERMS`), and its predictions.
    pub terms: Vec<f64>,
    pub seconds: f64,
    /// The range of the actual time for 80% of spaces (10% to 90%).
    pub seconds_low: f64,
    pub seconds_high: f64,
    pub bytes: f64,
}

/// The names of `NewformsEstimate::terms`.
///   pt, P: trace and CRT primes; L: levels M | N; symbols, sum D_M^3: over
///   the levels; D: dim M_k(Gamma_0(N))^+; d: dim S_k^new; B: the bound;
///   heilbronn: sum over p <= B of p log p (Heilbronn matrices for T_p).
/// The L P terms stand for the search for T, which tries more operators
/// when there are many old forms (highly composite N).
pub const NEWFORMS_TERMS: [&str; 11] = [
    "1", "heilbronn", "pt*heilbronn*(k-1)", "pt*symbols", "pt*D^3", "P*symbols", "P*sum D_M^3", "d^2*bits", "pt*B*d^2", "L*P*symbols", "L*P*sum D_M^3",
];
// Seconds per term (WebAssembly, one thread), fitted by web/atlas/fit-cost.py.
const NEWFORMS_SECONDS: [f64; 11] = [0.0000e+00, 3.8606e-01, 2.0454e-02, 5.6752e+01, 3.6749e+01, 0.0000e+00, 0.0000e+00, 0.0000e+00, 4.7457e+01, 3.6049e+00, 4.9644e-01];
// actual / predicted at the 10% and 90% quantiles (fit-cost.py)
const NEWFORMS_RANGE: [f64; 2] = [0.61, 1.73];
// Peak bytes: base, heilbronn, D_top^2, symbols, B d.
const NEWFORMS_BYTES: [f64; 5] = [1.5572e+06, 5.0203e+05, 1.7363e+01, 4.5048e+01, 6.9154e+00];

fn psi(n: u64) -> u64 {
    crate::exact::factor(n).iter().fold(n, |m, &(p, _)| m / p * (p + 1))
}

pub fn newforms(n: u64, k: usize, bound: usize) -> NewformsEstimate {
    use crate::dims::{dim_cusp_forms, dim_eisenstein};
    use crate::general::Character;
    let ms: Vec<u64> = (1..=n).filter(|m| n % m == 0).collect();
    let mut symbols = 0f64;
    let mut sum_d3 = 0f64;
    let mut dim_top = 0u64;
    let mut cusp = std::collections::HashMap::new();
    for &m in &ms {
        let eps = Character::trivial(m);
        let (s, e) = (dim_cusp_forms(&eps, k), dim_eisenstein(&eps, k));
        cusp.insert(m, s);
        symbols += (psi(m) * (k as u64 - 1)) as f64;
        sum_d3 += ((s + e) as f64).powi(3);
        dim_top = s + e;
    }
    // dim S^new(N) = sum over M | N of beta(N / M) dim S(M), beta = mu * mu
    let beta = |x: u64| -> i64 { crate::exact::factor(x).iter().map(|&(_, e)| match e { 1 => -2, 2 => 1, _ => 0 }).product() };
    let d = ms.iter().map(|&m| beta(n / m) * cusp[&m] as i64).sum::<i64>().max(0) as u64;
    // CRT primes: the coefficients of the charpoly of T = T_q0 + 3 T_q1 (the
    // usual choice) are bounded by those of (1 + b x)^d, b = sum c (2 q^((k-1)/2) + 1).
    let qs: Vec<u64> = (2..).filter(|&q| crate::exact::is_prime(q) && n % q != 0).take(2).collect();
    let b: f64 = qs.iter().zip([1.0, 3.0]).map(|(&q, c)| c * (2.0 * (q as f64).powf((k as f64 - 1.0) / 2.0) + 1.0)).sum();
    let (df, lb) = (d as f64, (1.0 + b).log2());
    let bits = if d == 0 { 0.0 } else { df * lb - 0.5 * df.log2() + 2.0 }; // ~ log2 of the largest coefficient, times 2
    let primes = if d == 0 { 0 } else { (bits / 30.99).ceil().max(1.0) as u64 };
    // trace primes: |tr a_n| <= d sigma0(n) n^((k-1)/2)
    let mut tb = 0f64;
    for m in 1..=bound as u64 {
        let s0 = crate::exact::factor(m).iter().map(|&(_, e)| e as f64 + 1.0).product::<f64>();
        tb = tb.max((m as f64).log2() * (k as f64 - 1.0) / 2.0 + s0.log2());
    }
    let trace_primes = if d == 0 { 0 } else { ((tb + df.log2() + 2.0) / 30.99).floor() as u64 + 1 };
    let heil: f64 = (2..=bound as u64).filter(|&p| crate::exact::is_prime(p)).map(|p| p as f64 * (p as f64).ln()).sum::<f64>() * 1e-6;
    let (pt, pc, bf) = (trace_primes as f64, primes as f64, bound as f64);
    let dt = dim_top as f64;
    let on = if d == 0 { 0.0 } else { 1.0 };
    let terms = vec![
        on,
        on * heil,
        pt * heil * (k as f64 - 1.0),
        pt * symbols * 1e-6,
        pt * dt.powi(3) * 1e-9,
        pc * symbols * 1e-6,
        pc * sum_d3 * 1e-9,
        df * df * bits * 1e-9,
        pt * bf * df * df * 1e-9,
        ms.len() as f64 * pc * symbols * 1e-6,
        ms.len() as f64 * pc * sum_d3 * 1e-9,
    ];
    let seconds: f64 = terms.iter().zip(NEWFORMS_SECONDS).map(|(t, c)| t * c).sum();
    let bytes = NEWFORMS_BYTES[0] + on * (NEWFORMS_BYTES[1] * heil + NEWFORMS_BYTES[2] * dt * dt + NEWFORMS_BYTES[3] * symbols + NEWFORMS_BYTES[4] * bf * df);
    NewformsEstimate { n, k, bound, dim_new: d, dim_top, levels: ms.len(), symbols, primes, trace_primes, terms, seconds, seconds_low: seconds * NEWFORMS_RANGE[0], seconds_high: seconds * NEWFORMS_RANGE[1], bytes }
}
