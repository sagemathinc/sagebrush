//! Dimension formulas, independent of any modular symbols presentation:
//! S_k(N, eps) by Cohen-Oesterle, E_k(N, eps) by counting eps-regular cusps,
//! and the modular symbols space M_k(Gamma0(N), eps) (sign 0) via
//! Eichler-Shimura, dim = 2 dim S_k + dim E_k (k >= 2).
//!
//! These certify the dimensions found mod ell (which can only be too
//! large): equality proves that ell is good for the presentation.  For sign
//! +1 or -1 no split formula is needed: M = M^+ (+) M^-, so
//! dim_ell M^+ + dim_ell M^- = dim M certifies both.

use crate::exact::{factor, level_data};
use crate::general::Character;

fn parity_ok(eps: &Character, k: usize) -> bool {
    eps.is_even() == (k % 2 == 0)
}

/// Cohen-Oesterle's lambda(r_p, s_p, p).
fn lambda(r: u32, s: u32, p: u64) -> u64 {
    if 2 * s <= r {
        if r % 2 == 0 {
            p.pow(r / 2) + p.pow(r / 2 - 1)
        } else {
            2 * p.pow((r - 1) / 2)
        }
    } else {
        2 * p.pow(r - s)
    }
}

/// The values eps(x) = zeta^e (zeta = exp(2 pi i / order)) over the x mod N
/// with f(x) = 0 mod N, as counts by exponent e: the sum exactly.  The scan
/// over the level polls Stop.
fn character_values(eps: &Character, f: impl Fn(u64) -> u64) -> Vec<(u64, i128)> {
    let n = eps.n;
    let mut counts: std::collections::BTreeMap<u64, i128> = std::collections::BTreeMap::new();
    for x in 0..n {
        sagebrush_interrupt::check();
        if f(x) % n == 0 {
            let e = eps.exponent(x as i64).expect("a root of x^2+1 or x^2+x+1 is a unit");
            *counts.entry(e as u64).or_insert(0) += 1;
        }
    }
    counts.into_iter().collect()
}

/// sum of eps(x) over the roots x of x^2 + 1 mod N, for eps even: each
/// eps(x)^2 = eps(-1) = 1, so the sum is an integer (ones and minus ones).
fn sum_i(eps: &Character, vals: &[(u64, i128)]) -> i128 {
    let o = eps.order;
    vals.iter().map(|&(e, c)| {
        assert!(2 * e % o == 0, "eps(x)^2 = eps(-1) = 1 at a root of x^2 + 1");
        if e == 0 { c } else { -c }
    }).sum()
}

/// Twice the sum of eps(x) over the roots x of x^2 + x + 1 mod N: each
/// eps(x) is a cube root of unity (x^3 = 1), and the roots come in pairs x,
/// x^2 = -1 - x with conjugate values, so the sum is real: 1 for each value
/// 1, -1/2 for each other.
fn twice_sum_omega(eps: &Character, vals: &[(u64, i128)]) -> i128 {
    let o = eps.order;
    let (mut re2, mut im) = (0i128, 0i128);
    for &(e, c) in vals {
        assert!(3 * e % o == 0, "eps(x)^3 = 1 at a root of x^2 + x + 1");
        if e == 0 {
            re2 += 2 * c;
        } else {
            re2 -= c;
            im += if 3 * e == o { c } else { -c };
        }
    }
    assert_eq!(im, 0, "the values at the roots of x^2 + x + 1 pair off into conjugates");
    re2
}

/// dim S_k(Gamma0(N), eps) for k >= 2 (Cohen-Oesterle).
pub fn dim_cusp_forms(eps: &Character, k: usize) -> u64 {
    assert!(k >= 2);
    if !parity_ok(eps, k) {
        return 0;
    }
    let n = eps.n;
    let f = eps.conductor();
    let psi = level_data(n).0 as i128;
    let lam: i128 = factor(n).iter().map(|&(p, r)| {
        let s = factor(f).iter().find(|&&(q, _)| q == p).map_or(0, |&(_, s)| s);
        lambda(r, s, p) as i128
    }).product();
    // 12 dim = (k - 1) psi - 6 lambda + 12 g4 S4 + 12 g3 S3 + 12 [dim M_{2-k}],
    // in exact integers: 12 g4 = -3, 3 or 0 (k = 2, 0 mod 4 or odd) and
    // 12 g3 S3 = (-2, 2 or 0 by k mod 3) times 2 S3
    let nn = n as u128;
    let t4: i128 = match k % 4 { 2 => -3, 0 => 3, _ => 0 };
    let t3: i128 = match k % 3 { 2 => -2, 0 => 2, _ => 0 };
    let s4 = if t4 != 0 { sum_i(eps, &character_values(eps, |x| ((x as u128 * x as u128 + 1) % nn) as u64)) } else { 0 };
    let s3 = if t3 != 0 { twice_sum_omega(eps, &character_values(eps, |x| ((x as u128 * x as u128 + x as u128 + 1) % nn) as u64)) } else { 0 };
    // dim S_k - dim M_{2-k}; M_0 is the constants when eps = 1.
    let m2k: i128 = if k == 2 && eps.is_trivial() { 1 } else { 0 };
    let twelve = (k as i128 - 1) * psi - 6 * lam + t4 * s4 + t3 * s3 + 12 * m2k;
    assert!(twelve >= 0 && twelve % 12 == 0, "Cohen-Oesterle gave {}/12", twelve);
    // (it fits: N's character table has N entries, so psi < 2^36 at most
    // where it can be built, and (k - 1) psi / 12 < 2^31 2^36)
    u64::try_from(twelve / 12).expect("a dimension below 2^64")
}

/// dim E_k(Gamma0(N), eps) for k >= 2: the number of eps-regular cusps,
/// sum over c | N of phi(gcd(c, N/c)) with cond(eps) | N / gcd(c, N/c)
/// (a cusp with denominator c is fixed by d = 1 mod N / gcd(c, N/c)),
/// less one for k = 2 and eps = 1.  It factors over the primes of N.
pub fn dim_eisenstein(eps: &Character, k: usize) -> u64 {
    assert!(k >= 2);
    if !parity_ok(eps, k) {
        return 0;
    }
    let f = factor(eps.conductor());
    let count: u64 = factor(eps.n).iter().map(|&(p, r)| {
        let s = f.iter().find(|&&(q, _)| q == p).map_or(0, |&(_, s)| s);
        (0..=r).map(|a| {
            let g = a.min(r - a);
            if g <= r - s { if g == 0 { 1 } else { p.pow(g) - p.pow(g - 1) } } else { 0 }
        }).sum::<u64>()
    }).product();
    count - (k == 2 && eps.is_trivial()) as u64
}

/// dim of the sign-0 modular symbols space M_k(Gamma0(N), eps).
pub fn dim_modsym(eps: &Character, k: usize) -> u64 {
    2 * dim_cusp_forms(eps, k) + dim_eisenstein(eps, k)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::general::GeneralSpace;

    #[test]
    fn level_one_and_classical() {
        let one = Character::trivial(1);
        let s: Vec<u64> = (2..=26).step_by(2).map(|k| dim_cusp_forms(&one, k)).collect();
        assert_eq!(s, vec![0, 0, 0, 0, 0, 1, 0, 1, 1, 1, 1, 2, 1]);
        // Genus of X0(N) = dim S_2(N).
        for n in 1..300 {
            assert_eq!(dim_cusp_forms(&Character::trivial(n), 2), level_data(n).1, "N = {}", n);
        }
    }

    /// Exact integers at weights near 2^31, where f64 roundoff gave wrong
    /// dimensions or a failed residual check (Gamma0(39) at 2^31 - 2 panicked
    /// on 10021590341.999998): against Sage 10.10's dimension_cusp_forms, for
    /// trivial characters and for characters of order 2 and 3 (eps(g^j) =
    /// zeta_order^j for the generator g of (Z/p)^*, as Sage's G.0 powers).
    #[test]
    fn exact_at_large_weights() {
        let ks = [2147483646usize, 2147483645, 2147483644, 2147483643, 2147483642, 2147483641, 2, 3, 4, 12, 13];
        let triv: [(u64, [u64; 11]); 14] = [
            (1, [178956970, 0, 178956970, 0, 178956969, 0, 0, 0, 0, 1, 0]),
            (2, [536870910, 0, 536870910, 0, 536870909, 0, 0, 0, 0, 2, 0]),
            (3, [715827881, 0, 715827880, 0, 715827879, 0, 0, 0, 0, 3, 0]),
            (4, [1073741821, 0, 1073741820, 0, 1073741819, 0, 0, 0, 0, 4, 0]),
            (7, [1431655763, 0, 1431655761, 0, 1431655759, 0, 0, 0, 1, 7, 0]),
            (9, [2147483643, 0, 2147483641, 0, 2147483639, 0, 0, 0, 1, 9, 0]),
            (13, [2505397585, 0, 2505397583, 0, 2505397579, 0, 0, 0, 3, 13, 0]),
            (36, [12884901864, 0, 12884901852, 0, 12884901840, 0, 1, 0, 12, 60, 0]),
            (39, [10021590342, 0, 10021590332, 0, 10021590322, 0, 3, 0, 12, 50, 0]),
            (49, [10021590340, 0, 10021590330, 0, 10021590320, 0, 1, 0, 10, 48, 0]),
            (63, [17179869156, 0, 17179869140, 0, 17179869124, 0, 5, 0, 20, 84, 0]),
            (91, [20043180686, 0, 20043180666, 0, 20043180646, 0, 7, 0, 26, 102, 0]),
            (117, [30064771026, 0, 30064770998, 0, 30064770970, 0, 11, 0, 38, 150, 0]),
            (147, [40086361366, 0, 40086361328, 0, 40086361290, 0, 11, 0, 48, 198, 0]),
        ];
        for (n, want) in triv {
            let got: Vec<u64> = ks.iter().map(|&k| dim_cusp_forms(&Character::trivial(n), k)).collect();
            assert_eq!(got, want.to_vec(), "N = {}", n);
        }
        // eps(g^j) = zeta_order^(j mod order), g generating (Z/n)^*
        let power_char = |n: u64, g: u64, order: u64| {
            let mut exps = vec![u32::MAX; n as usize];
            let mut x = 1u64;
            for j in 0..n {
                exps[x as usize] = (j % order) as u32;
                x = x * g % n;
                if x == 1 {
                    break;
                }
            }
            Character::from_exponents(n, order, exps).unwrap()
        };
        let chars: [(&str, Character, [u64; 11]); 4] = [
            ("cubic mod 7", power_char(7, 3, 3), [1431655762, 0, 1431655761, 0, 1431655760, 0, 0, 0, 1, 6, 0]),
            ("cubic mod 9", power_char(9, 2, 3), [2147483644, 0, 2147483642, 0, 2147483640, 0, 0, 0, 2, 10, 0]),
            ("quadratic mod 13", power_char(13, 2, 2), [2505397586, 0, 2505397582, 0, 2505397580, 0, 0, 0, 2, 12, 0]),
            ("quadratic mod 7", power_char(7, 3, 2), [0, 1431655761, 0, 1431655761, 0, 1431655759, 0, 1, 0, 0, 7]),
        ];
        for (name, eps, want) in chars {
            let got: Vec<u64> = ks.iter().map(|&k| dim_cusp_forms(&eps, k)).collect();
            assert_eq!(got, want.to_vec(), "{}", name);
        }
    }

    /// Past 2^53 (Sage 10.10: 9007200315899901; f64 gave ...900). Its
    /// character table takes about 200 MB: run with --ignored.
    #[test]
    #[ignore]
    fn exact_past_2_53() {
        assert_eq!(dim_cusp_forms(&Character::trivial(50331653), 2147483646), 9007200315899901);
    }

    #[test]
    fn trivial_character_matches_presentations() {
        // Sign 0 and sign +-1 against the mod-ell presentations.
        for n in 1..80 {
            let eps = Character::trivial(n);
            for k in [2, 4, 6] {
                let want = dim_modsym(&eps, k) as usize;
                let d0 = GeneralSpace::new(n, k, &eps, 0).unwrap().dimension();
                let dp = GeneralSpace::new(n, k, &eps, 1).unwrap().dimension();
                let dm = GeneralSpace::new(n, k, &eps, -1).unwrap().dimension();
                assert_eq!((d0, dp + dm), (want, want), "N = {} k = {}", n, k);
            }
        }
    }
}
