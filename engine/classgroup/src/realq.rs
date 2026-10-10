//! Class groups and regulators of real quadratic fields (fundamental
//! discriminant D > 0), assuming GRH, by Buchmann's subexponential method:
//! the relations of imag.rs's sieve also describe principal ideals (gamma),
//! gamma = prod ((B + sqrt D) / 2)^c; kernel vectors of the relation matrix
//! give units, whose logarithms are multiples of 2 R; and the analytic class
//! number formula h R = sqrt(D) L(1, chi) / 2 estimates h R: the search
//! stops at h* R* < sqrt 2 times the estimate, and the certificate
//! (nf/certify.rs) then proves h* = h and R* = R under GRH alone from
//! h* R*_hi < 2 h R_lo (a genuine unit with a proven error bound, h* from
//! exact determinants, Belabas and Friedman's lower bound for h R).

use crate::arith::*;
use crate::imag::{l1_estimate, lattice_group, lattice_group_exact, tuning, ClassGroup, Timing};
use crate::linalg::{eliminate_tracked, eliminate_with, independent_rows, kernel_crt, Reduced};
use crate::real::{ln_fixed, ln_int, real_gcd, sqrt_fixed, to_f64};
use crate::relations::{collect, Elem, FactorBase, Relation, Stats};
use sagebrush_bigint::BigInt;
use num_traits::{One, Signed, ToPrimitive, Zero};

#[derive(Debug, Clone)]
pub struct RealQuadratic {
    pub group: ClassGroup,
    /// The regulator, and to `prec` bits as an integer reg_fixed / 2^prec.
    pub regulator: f64,
    pub reg_fixed: BigInt,
    pub prec: u32,
    /// h and R proven under GRH alone (nf/certify.rs), and the regulator's
    /// correct significant digits then (else 20)
    pub certified: bool,
    pub reg_digits: usize,
}

/// log |gamma / gamma'| 2^prec for gamma = prod ((B + sqrt D)/2)^c:
/// for one factor, sign(B) (2 ln(|B| + sqrt D) - ln |B^2 - D|), which has
/// no cancellation (B^2 - D = 4 a Q(x) is an exact integer).
fn elem_log(el: &Elem, d: &BigInt, sqrt_d: &BigInt, prec: u32) -> BigInt {
    let mut total = BigInt::zero();
    for &(b, c) in el {
        let ab = BigInt::from(b.unsigned_abs());
        let x = (&ab << prec as usize) + sqrt_d;
        let l = (ln_fixed(&x, prec) << 1usize) - ln_int(&(&ab * &ab - d).abs(), prec);
        total += if b < 0 { -l } else { l } * c;
    }
    total
}

/// elem_log with a bound on its error (units of 2^-prec): sqrt_d is a floor
/// (< 1 unit, < 1 unit relatively in ln(|B| + sqrt D) too, as that is >= 1),
/// and ln_fixed is allowed 8 + 2 |e| units (e its binary exponent), as in
/// embed.rs log_embedding_err.
fn elem_log_err(el: &Elem, d: &BigInt, sqrt_d: &BigInt, prec: u32) -> (BigInt, f64) {
    let mut err = 0.0f64;
    for &(b, c) in el {
        let ab = BigInt::from(b.unsigned_abs());
        let x = (&ab << prec as usize) + sqrt_d;
        let ex = (x.bits() as f64 - 1.0 - prec as f64).abs();
        let ei = ((&ab * &ab - d).abs().bits() as f64 - 1.0).abs();
        err += (c.unsigned_abs() as f64) * (2.0 * (9.0 + 2.0 * ex) + 8.0 + 2.0 * ei);
    }
    (elem_log(el, d, sqrt_d, prec), err * (1.0 + 1e-12))
}

/// A batch of kernel vectors: det A, the y_t, the extra rows.
type Batch = (BigInt, Vec<Vec<BigInt>>, Vec<usize>);

/// unit_logs with certified error bounds, each kernel vector checked to
/// vanish exactly on the core (so every value is the logarithm of a unit).
#[allow(clippy::too_many_arguments)]
fn unit_logs_bounded(d: &BigInt, rels: &[Relation], elems: &[Elem], n: usize, pivot_weight: usize, dense: &[Vec<i64>], core_rows: &[usize], sel: &[usize], batches: &[Batch], prec: u32) -> Option<(Vec<BigInt>, Vec<f64>)> {
    let sqrt_d = sqrt_fixed(d, prec);
    let (mut logs, mut errs): (Vec<Vec<BigInt>>, Vec<f64>) = elems.iter().map(|el| {
        let (l, e) = elem_log_err(el, d, &sqrt_d, prec);
        (vec![l], e)
    }).unzip();
    let (_, core2, zero_rows) = eliminate_tracked(n, rels, pivot_weight, Some(&mut logs), Some(&mut errs));
    if core2 != core_rows {
        return None;
    }
    let mut lams: Vec<BigInt> = zero_rows.iter().map(|&k| logs[k][0].clone()).collect();
    let mut lerr: Vec<f64> = zero_rows.iter().map(|&k| errs[k]).collect();
    let ncol = dense.first().map_or(0, |r| r.len());
    for (det, ys, extras) in batches {
    for (y, &e) in ys.iter().zip(extras) {
        let g = y.iter().fold(det.clone(), |g, yi| num_integer::Integer::gcd(&g, yi));
        if g.is_zero() {
            continue;
        }
        let coef: Vec<BigInt> = y.iter().map(|yi| yi / &g).collect();
        let de = det / &g;
        // sum coef_i A_i - de v = 0 exactly
        if (0..ncol).any(|col| !(coef.iter().zip(sel).map(|(ci, &k)| ci * dense[k][col]).sum::<BigInt>() - &de * dense[e][col]).is_zero()) {
            continue;
        }
        let mut l: BigInt = sel.iter().zip(&coef).map(|(&k, ci)| ci * &logs[core_rows[k]][0]).sum();
        l -= &de * &logs[core_rows[e]][0];
        let er: f64 = sel.iter().zip(&coef).map(|(&k, ci)| to_f64(&ci.abs(), 0) * (1.0 + 1e-15) * errs[core_rows[k]]).sum::<f64>() + to_f64(&de.abs(), 0) * (1.0 + 1e-15) * errs[core_rows[e]];
        lams.push(l);
        lerr.push(er * (1.0 + 1e-12));
    }
    }
    Some((lams, lerr))
}

/// Relations of negative norm directly: gamma = (B + sqrt D)/2 with
/// |B| < sqrt D (B = D mod 2), when (D - B^2)/4 factors over the factor
/// base (trial division; B up to `max_b`).  For small D the sieve's
/// polynomials (a >= the smallest q) give almost only positive norms, and
/// units are then products of positive-norm elements, so a fundamental
/// unit of norm -1 would never be found (R* = 2R).
fn negative_norm_relations(fb: &FactorBase, d: &BigInt, want: usize, max_b: u64) -> (Vec<Relation>, Vec<Elem>) {
    let (mut rels, mut elems) = (vec![], vec![]);
    let sq = num_integer::Roots::sqrt(d).to_u64().unwrap_or(u64::MAX);
    let parity = bigmod(d, 2);
    let mut b = parity;
    while b <= sq.min(max_b) && rels.len() < want {
        sagebrush_interrupt::check();
        let bb = BigInt::from(b);
        let mut v = (d - &bb * &bb) >> 2usize; // > 0
        let mut rel: Relation = vec![];
        for (i, fp) in fb.primes.iter().enumerate() {
            let p = BigInt::from(fp.p);
            let mut e = 0i64;
            while (&v % &p).is_zero() {
                v /= &p;
                e += 1;
            }
            if e > 0 {
                rel.push((i, fb.sign(i, b as i128) as i64 * e));
            }
            if v.is_one() {
                break;
            }
        }
        if v.is_one() && !rel.is_empty() {
            rels.push(rel);
            elems.push(vec![(b as i128, 1)]);
        }
        b += 2;
    }
    (rels, elems)
}

/// Below this the factor base is too small for the sieve.
const MIN_D: f64 = 1e3;

pub fn class_group_real(d: &BigInt) -> Result<(RealQuadratic, Timing), String> {
    let d4 = bigmod(d, 4);
    if !d.is_positive() || !(d4 == 0 || d4 == 1) {
        return Err(format!("{} is not a positive discriminant", d));
    }
    if d.bits() > 200 {
        return Err("D >= 2^200 is not supported yet".into());
    }
    let dsq = num_integer::Roots::sqrt(d);
    if &dsq * &dsq == *d {
        return Err(format!("{} is a square", d));
    }
    let absd = d.to_f64().unwrap();
    if absd < MIN_D {
        return Err(format!("D < {} is not supported yet", MIN_D));
    }
    let debug = std::env::var("QCL_DEBUG").is_ok();
    let mut tm = Timing::default();
    let ld = absd.ln();
    let bound = (crate::imag::GRH_C * ld * ld).ceil() as u64;
    let fb = FactorBase::new(d, bound.max(60));
    let n = fb.primes.len();
    tm.fb = n;
    // h R = sqrt(D) L(1, chi) / 2
    let hr_est = absd.sqrt() * l1_estimate(d, ((4.0 * ld * ld) as u64).clamp(1 << 10, 1 << 16)) / 2.0;
    tm.h_est = hr_est;
    // the certificate's proven lower bound for log h R (GRH; nf/certify.rs)
    let log_hr_lo = if std::env::var("QCL_NOCERT").is_ok() { None } else { crate::nf::certify::quadratic_log_hr_lower(d) };
    let mut tu = tuning(absd.log10(), bound);
    let mut rels: Vec<Relation> = vec![];
    let mut elems: Vec<Elem> = vec![];
    let mut stats = Stats { polys: 0, candidates: 0, full: 0, partial_pairs: 0 };
    let mut want = (tu.excess * n as f64) as usize + 20;
    let mut counts = vec![0u32; n];
    let mut cache = LogCache::default();
    // (the sieve finds plenty of negative norms for large D)
    let (neg, neg_el) = if absd < 1e20 { negative_norm_relations(&fb, d, 20, 4000) } else { (vec![], vec![]) };
    for r in &neg {
        for &(i, _) in r {
            counts[i] += 1;
        }
    }
    rels.extend(neg);
    elems.extend(neg_el);
    for round in 0..200 {
        sagebrush_interrupt::check();
        tm.rounds = round + 1;
        let t = crate::clock::Instant::now();
        let (found, found_el) = collect(&fb, want.saturating_sub(rels.len()).max(1), &tu.sieve, round as u64 + 1, &mut stats, &mut counts);
        if found.is_empty() {
            tu.sieve.sieve_bound = u64::MAX;
        }
        rels.extend(found);
        elems.extend(found_el);
        tm.sieve_s += t.elapsed().as_secs_f64();
        let t = crate::clock::Instant::now();
        let mut more = (rels.len() / 5).max(10);
        let res = match eliminate_with(n, &rels, tu.pivot_weight, None) {
            (Reduced::Deficient(col), _, _) => {
                if debug {
                    eprintln!("round {} rels {}: column {} has no relation", round, rels.len(), col);
                }
                more = (4 * counts.iter().filter(|&&c| c == 0).count()).max(10);
                None
            }
            (Reduced::Core(cols, dense), core_rows, _) => {
                let c = cols.len();
                tm.core = c;
                match independent_rows(&dense, c) {
                    Err(free) => {
                        if debug {
                            eprintln!("round {} rels {}: core not of full rank ({} free)", round, rels.len(), free.len());
                        }
                        more = (4 * free.len()).max(10);
                        for j in free {
                            counts[cols[j]] = 0;
                        }
                        None
                    }
                    Ok(sel) => try_lattice(&mut cache, d, &rels, &elems, n, tu.pivot_weight, &dense, &core_rows, c, &sel, hr_est, log_hr_lo, round as u64, debug),
                }
            }
        };
        tm.linalg_s += t.elapsed().as_secs_f64();
        if let Some(r) = res {
            tm.relations = rels.len();
            tm.polys = stats.polys;
            return Ok((r, tm));
        }
        want = rels.len() + more;
    }
    Err("no convergence".into())
}

/// The relations' logarithms, kept at the highest precision computed so far
/// (a lower precision is a shift), across rounds.
#[derive(Default)]
struct LogCache {
    prec: u32,
    logs: Vec<BigInt>,
}

impl LogCache {
    fn logs(&mut self, d: &BigInt, elems: &[Elem], prec: u32) -> Vec<BigInt> {
        if prec > self.prec {
            // recompute everything a little above what is asked
            let p = prec + prec / 4;
            let sqrt_d = sqrt_fixed(d, p);
            self.logs = elems.iter().map(|el| elem_log(el, d, &sqrt_d, p)).collect();
            self.prec = p;
        } else if self.logs.len() < elems.len() {
            let sqrt_d = sqrt_fixed(d, self.prec);
            let p = self.prec;
            self.logs.extend(elems[self.logs.len()..].iter().map(|el| elem_log(el, d, &sqrt_d, p)));
        }
        let shift = (self.prec - prec) as usize;
        self.logs[..elems.len()].iter().map(|l| l >> shift).collect()
    }
}

/// The logarithms (2^prec fixed point) of units: from the relations that
/// the elimination reduced to zero, and from the kernel vectors (y_t, -det)
/// of [sel; extra_t] made primitive; and how many came from zero rows.
#[allow(clippy::too_many_arguments)]
fn unit_logs(cache: &mut LogCache, d: &BigInt, rels: &[Relation], elems: &[Elem], n: usize, pivot_weight: usize, core_rows: &[usize], sel: &[usize], det: &BigInt, ys: &[Vec<BigInt>], extras: &[usize], prec: u32) -> (Vec<BigInt>, usize) {
    // the logarithms of every relation, carried through the elimination
    let mut logs: Vec<Vec<BigInt>> = cache.logs(d, elems, prec).into_iter().map(|l| vec![l]).collect();
    let (_, core2, zero_rows) = eliminate_with(n, rels, pivot_weight, Some(&mut logs));
    let logs: Vec<BigInt> = logs.into_iter().map(|mut l| l.pop().unwrap()).collect();
    assert_eq!(core2, core_rows, "elimination is deterministic");
    let mut lambdas: Vec<BigInt> = zero_rows.iter().map(|&k| logs[k].clone()).collect();
    for (y, &e) in ys.iter().zip(extras) {
        // the primitive kernel vector (y, -det) / content: otherwise the unit
        // is a needless power (the content often shares factors with det)
        let g = y.iter().fold(det.clone(), |g, yi| num_integer::Integer::gcd(&g, yi));
        if g.is_zero() {
            continue;
        }
        let mut l: BigInt = sel.iter().zip(y).map(|(&k, yi)| yi / &g * &logs[core_rows[k]]).sum();
        l -= det / &g * &logs[core_rows[e]];
        lambdas.push(l);
    }
    (lambdas, zero_rows.len())
}

/// Units from kernel vectors of the core, the regulator multiple R* they
/// generate, then h* from the lattice; the answer if h* R* is small enough.
#[allow(clippy::too_many_arguments)]
fn try_lattice(cache: &mut LogCache, d: &BigInt, rels: &[Relation], elems: &[Elem], n: usize, pivot_weight: usize, dense: &[Vec<i64>], core_rows: &[usize], c: usize, sel: &[usize], hr_est: f64, log_hr_lo: Option<f64>, seed: u64, debug: bool) -> Option<RealQuadratic> {
    let t = crate::clock::Instant::now();
    let ms = || t.elapsed().as_secs_f64() * 1e3;
    let in_sel: std::collections::HashSet<usize> = sel.iter().cloned().collect();
    let others: Vec<usize> = (0..dense.len()).filter(|k| !in_sel.contains(k)).collect();
    let a: Vec<Vec<i64>> = sel.iter().map(|&k| dense[k].clone()).collect();
    let log_c = 64 - (c as u64 + 1).leading_zeros();
    // batches of kernel vectors (the square sel with one more row each):
    // more are tried before giving up on these relations when h* R* is a
    // small multiple of the estimate (the units found may all be powers)
    let mut lambdas: Vec<BigInt> = vec![];
    let mut prec = 0u32;
    let mut err_bits = 0u32;
    let mut lattice: Option<(BigInt, Vec<BigInt>)> = None;
    let mut used = 0;
    let mut last_r: Option<f64> = None;
    let mut batches: Vec<Batch> = vec![];
    for batch in [6usize, 12, 24] {
        let extras: Vec<usize> = (0..batch).map(|t| others[(used + t) * 7919 % others.len().max(1)]).collect();
        used += batch;
        if others.is_empty() {
            break;
        }
        let vs: Vec<Vec<i64>> = extras.iter().map(|&k| dense[k].clone()).collect();
        let (det, ys) = kernel_crt(&a, &vs);
        batches.push((det.clone(), ys.clone(), extras.clone()));
        if prec == 0 {
            // The lambdas are exact integer combinations of the relations'
            // logarithms, so their errors are the rounding of those times
            // coefficients that can far exceed |lambda| (cancellation, here
            // and in the elimination).  Measure it: the difference of two
            // cheap passes at 48 and 112 bits is the error at 48 bits.  The
            // gcd multiplies errors by up to |lambda| / 2R (R > 0.48); keep
            // the product below 2^-30.
            let (low, _) = unit_logs(cache, d, rels, elems, n, pivot_weight, core_rows, sel, &det, &ys, &extras, 48);
            let (mid, _) = unit_logs(cache, d, rels, elems, n, pivot_weight, core_rows, sel, &det, &ys, &extras, 112);
            let lbits = mid.iter().map(|l| l.bits() as i64 - 112).max().unwrap_or(0).max(0) as u32;
            let ebits = low.iter().zip(&mid).map(|(l, m)| ((l << 64usize) - m).bits() as i64 - 112).max().unwrap_or(0).max(0) as u32;
            // error at precision p: 2^(ebits + 48 - p) (in fixed-point units
            // 2^(ebits + 48) at any p); identifying x / g = h / k needs
            // relative precision 2 log2(x / R); R is at least the estimate of
            // h R over h, h assumed at most 2^10 here (a lower R only means a
            // retry at higher precision, as verification fails)
            err_bits = ebits + 48 + 16;
            let m_bits = (lbits as f64 - (hr_est / 1024.0).max(0.5).log2()).max(1.0) as u32;
            prec = err_bits + 2 * m_bits + log_c + 32;
            if debug {
                eprintln!("  kernel: det {} bits; |lambda| ~ 2^{}, error at 48 bits ~ 2^{}: precision {} at {:.1} ms", det.bits(), lbits, ebits, prec, ms());
            }
        }
        let (more, n_zero) = unit_logs(cache, d, rels, elems, n, pivot_weight, core_rows, sel, &det, &ys, &extras, prec);
        // a unit's logarithm is at least 2 log((1 + sqrt 5)/2) > 0.96:
        // anything below 1/4 is zero (a torsion unit)
        let quarter = BigInt::one() << (prec as usize - 2);
        lambdas.extend(more.into_iter().filter(|l| l.abs() > quarter));
        if lambdas.is_empty() {
            continue;
        }
        let two_r = real_gcd(&lambdas, &(BigInt::one() << err_bits as usize)).unwrap_or_default();
        let r_fixed: BigInt = &two_r >> 1usize;
        let r = to_f64(&r_fixed, prec);
        // verify: R* at least log((1 + sqrt 5)/2) and every lambda within
        // 2^-20 of a multiple of 2 R*
        let fine = BigInt::one() << (prec as usize - 20);
        let verified = r > 0.48
            && lambdas.iter().all(|l| {
                let q = num_integer::Integer::div_floor(&(l + (&two_r >> 1usize)), &two_r);
                (l - q * &two_r).abs() <= fine
            });
        if debug {
            eprintln!("  precision {}: {} units ({} from zero rows), R* = {:.6e} (h R est {:.6e}){} at {:.1} ms", prec, lambdas.len(), n_zero, r, hr_est, if verified { "" } else { " NOT VERIFIED" }, ms());
        }
        if !verified {
            // should not happen with the precision above; start over with more
            prec *= 2;
            lambdas.clear();
            continue;
        }
        // h* (once: a smaller R* only loosens the HNF's early stop)
        if lattice.is_none() {
            let enough = std::f64::consts::SQRT_2 * hr_est / r;
            lattice = Some(lattice_group(dense, c, sel, Some(det), enough, seed, debug)?);
        }
        let (h, cyc) = lattice.clone().unwrap();
        let ratio = h.to_f64().unwrap_or(f64::INFINITY) * r / hr_est;
        if debug {
            eprintln!("  h* R* / est {:.4} at {:.1} ms", ratio, ms());
        }
        if ratio <= std::f64::consts::SQRT_2 {
            // the certificate: a genuine unit with a proven error bound, an
            // exact multiple of h, h* R*_hi < 2 h R_lo
            let mut imprecise = false;
            let cert = log_hr_lo.and_then(|lo| {
                let Some((lams, errs)) = unit_logs_bounded(d, rels, elems, n, pivot_weight, dense, core_rows, sel, &batches, prec) else {
                    if debug { eprintln!("  certificate: no bounded unit logarithms"); }
                    return None;
                };
                let (blo, bhi, b) = match crate::nf::certify::rank_one_bounds(&lams, &errs, &two_r) {
                    Ok(v) => v,
                    Err(e) => {
                        if debug { eprintln!("  certificate: no unit with a proven bound ({} units, worst error 2^{:.0} units{})", lams.len(), errs.iter().cloned().fold(0.0, f64::max).log2(), if e { ", imprecise" } else { "" }); }
                        imprecise = e;
                        return None;
                    }
                };
                // R = |b| / 2 (b is twice the log of the unit)
                let (rlo, rhi) = (to_f64(&blo, prec) / 2.0, to_f64(&bhi, prec) / 2.0 * (1.0 + 1e-14));
                let (h2, cyc2) = if c == 0 { (BigInt::one(), vec![]) } else { lattice_group_exact(dense, c, sel, 2.0 * lo.exp() / rhi, seed, debug)? };
                let ok = crate::nf::certify::ln_big(&h2) + rhi.ln() < std::f64::consts::LN_2 + lo - 1e-12;
                if debug {
                    eprintln!("  certificate: R in [{:.12e}, {:.12e}], h* {} (heuristic {}): {}", rlo, rhi, h2, h, if ok { "holds" } else { "failed" });
                }
                ok.then(|| {
                    // the relative error of |b|: its error bound over it
                    let rel = to_f64(&(&bhi - &blo), 0) / to_f64(&(&blo + &bhi), 0) * (1.0 + 1e-9) + 2f64.powf(-(prec as f64) * 0.9);
                    let digits = ((-rel.log10()).floor() as i64 - 1).clamp(1, 20) as usize;
                    (h2, cyc2, b.abs() >> 1usize, digits)
                })
            });
            if cert.is_none() && imprecise && prec < 1 << 16 {
                // the unit logarithms' error bounds were too wide: again
                // with twice the precision
                prec *= 2;
                lambdas.clear();
                continue;
            }
            return Some(match cert {
                Some((h2, cyc2, rf, digits)) => RealQuadratic { group: ClassGroup { h: h2, cyc: cyc2 }, regulator: to_f64(&rf, prec), reg_fixed: rf, prec, certified: true, reg_digits: digits },
                None => RealQuadratic { group: ClassGroup { h, cyc }, regulator: r, reg_fixed: r_fixed, prec, certified: false, reg_digits: 20 },
            });
        }
        // more units help only while R* is too big; once a new batch leaves
        // it unchanged, h* is (the lattice needs more relations)
        if ratio > 64.0 || last_r.is_some_and(|lr: f64| (lr - r).abs() <= 1e-9 * r) {
            break;
        }
        last_r = Some(r);
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn against_pari() {
        // quadclassunit(D): .cyc and .reg (PARI 2.17.4, used as an oracle only)
        let known: &[(&str, &[u64], &str)] = &[
            ("730136", &[28], "17.540842522290717434143671618719280373"),
            ("859308", &[2, 2], "104.81835690088888047897926535389742413"),
            ("688492", &[8, 2], "30.591391539841152805525909415454129989"),
            ("1636872", &[10, 2], "22.024535719159453190942211941626370404"),
            ("1000000009", &[], "70773.233967148465118314024656238279773"),
            ("54475728456", &[18, 2, 2], "2309.6528637836322470529281336917498581"),
            ("692632716585", &[2, 2, 2, 2], "39520.413306079297971361758511448915471"),
            ("710573243720556", &[4, 2, 2], "722684.33796962453780774459782082914823"),
            ("10000000000000000000000000000033", &[43], "84328477135202.256410546706641650446858"),
        ];
        for &(d, cyc, reg) in known {
            let (r, _) = class_group_real(&d.parse().unwrap()).unwrap();
            let want: Vec<BigInt> = cyc.iter().map(|&c| BigInt::from(c)).collect();
            assert_eq!(r.group.cyc, want, "cyc({})", d);
            assert!(r.certified, "{} not certified", d);
            // the regulator to 15 significant digits
            let got = to_f64(&r.reg_fixed, r.prec);
            let reg: f64 = reg.parse().unwrap();
            assert!(((got - reg) / reg).abs() < 1e-14, "reg({}) = {} vs {}", d, got, reg);
        }
    }
}
