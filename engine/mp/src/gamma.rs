//! mpmath's gamma function for real arguments (libmp/gammazeta.py, mpmath
//! 1.4.1, BSD-3-Clause, Copyright (c) 2005-2025 Fredrik Johansson and mpmath
//! contributors), ported operation for operation: the Taylor series of
//! 1/gamma(1+x) (gamma_fixed_taylor), its coefficients from Euler's constant
//! and the zeta values at the integers (gamma_taylor_coefficients,
//! zeta_array), and the Bernoulli numbers those take (mpf_bernoulli's
//! sequential recurrence).  The whole computation is one call into the core.
//!
//! The caches are the session's, as the reference's module-level ones are:
//! the Taylor coefficients by precision, in the order they were made (the
//! reference reuses the first larger one it meets), and the Bernoulli numbers
//! by working precision with their recurrence's state.
//!
//! mpf_gamma takes the Taylor path here; a call the reference would answer
//! another way (integers, half-integers, the pole's neighbourhood, Stirling's
//! series at large |x| or precision, the log-gamma and factorial types) is
//! answered `None`, for the caller to take mpmath's own path.

use crate::consts::{euler_fixed, pi_fixed};
use crate::elefun::mpf_exp;
use crate::exp::Exp;
use crate::fail::failed;
use crate::glibm;
use crate::int::Int;
use crate::mpc::{mpf_abs, mpf_shift, FAST};
use crate::mpf::{self, fone, from_int_man_exp, mpf_div, mpf_mul, mpf_pos, mpf_pow_int, normalize, to_fixed, Mpf, Rnd};
use crate::nat::Nat;
use std::cell::Cell;
use std::collections::HashMap;

/// gammazeta's MAX_GAMMA_TAYLOR_PREC, GAMMA_STIRLING_BETA,
/// MAX_BERNOULLI_CACHE.
const MAX_GAMMA_TAYLOR_PREC: i64 = 5000;
const GAMMA_STIRLING_BETA: f64 = 0.2;
const MAX_BERNOULLI_CACHE: i64 = 3000;

/// One working precision's Bernoulli numbers (index n, the even ones and 0)
/// and the recurrence's state [m, bin, bin1].
struct Bern {
    numbers: Vec<Option<Mpf>>,
    m: i64,
    bin: Int,
    bin1: Int,
}

#[derive(Default)]
struct Caches {
    taylor: Vec<(i64, Vec<Int>)>,
    bernoulli: HashMap<i64, Bern>,
}

thread_local! {
    static CACHES: Cell<Option<Box<Caches>>> = const { Cell::new(None) };
}

/// The caches, taken out, worked on and put back (no borrow held).
fn caches<R>(f: impl FnOnce(&mut Caches) -> R) -> R {
    let mut c = CACHES.try_with(|c| c.take()).ok().flatten().unwrap_or_default();
    let r = f(&mut c);
    let _ = CACHES.try_with(|x| x.set(Some(c)));
    r
}

/// Forget every cache (a new session).
pub fn reset() {
    let _ = CACHES.try_with(|c| c.set(None));
}

fn i(x: i64) -> Int {
    Int::from_i64(x)
}

/// CPython's math.log(x, 2) = log(x) / log(2).
fn log2(x: f64) -> f64 {
    glibm::log(x) / glibm::log(2.0)
}

/// from_int(n), exact.
fn from_int(n: &Int) -> Mpf {
    from_int_man_exp(n, &Exp::S(0), 0, FAST)
}

/// mpf_sub(s, t, prec, rnd).
fn mpf_sub(s: &Mpf, t: &Mpf, prec: u64, rnd: Rnd) -> Mpf {
    mpf::mpf_add(s, t, prec, rnd, true)
}

/// k ** n for k, n >= 0.
fn ipow(k: i64, n: i64) -> Int {
    let mut r = Nat::from_u64(1);
    let mut b = Nat::from_u64(k as u64);
    let mut e = n as u64;
    while e > 0 {
        if e & 1 == 1 {
            r = r.mul(&b);
        }
        e >>= 1;
        if e > 0 {
            b = b.mul(&b);
        }
    }
    Int::from(r)
}

/// def_mpf_constant(pi_fixed)(prec, rnd): mpf_pi.
fn mpf_pi(prec: u64, rnd: Rnd) -> Mpf {
    let wp = prec as i64 + 20;
    let mut v = pi_fixed(wp);
    if matches!(rnd, Rnd::Up | Rnd::Ceiling) {
        v = v.add_u64(1);
    }
    let bc = v.bits() as i64;
    normalize(0, v, Exp::S(-wp), bc, prec, rnd)
}

/// mpf_rdiv_int(n, t, prec, rnd): n / t for a Python int n.
fn mpf_rdiv_int(n: i64, t: &Mpf, prec: u64, rnd: Rnd) -> Mpf {
    let mut sign = t.sign;
    if n == 0 || t.man.is_zero() {
        return mpf_div(&from_int(&i(n)), t, prec, rnd);
    }
    if n < 0 {
        sign ^= 1;
    }
    let mut extra = prec as i64 + t.bc + 5;
    let (quot, rem) = Nat::from_u64(n.unsigned_abs()).shl(extra as u64).divmod(&t.man);
    let quot = if rem.is_zero() {
        quot
    } else {
        extra += 1;
        quot.shl(1).add_u64(1)
    };
    let bc = quot.bits() as i64;
    let exp = t.exp.neg().add_i64(-extra);
    normalize(sign, quot, exp, bc, prec, rnd)
}

/// bernoulli_size(n): an estimate of B_n's size (even n > 2).
fn bernoulli_size(n: i64) -> i64 {
    let lgn = log2(n as f64);
    (2.326 + 0.5 * lgn + n as f64 * (lgn - 4.094)) as i64
}

/// mpf_bernoulli(n, prec, rnd) for the calls zeta_array makes: n from 0 up,
/// in order, so each is the recurrence's next (or cached).  None where the
/// reference would take another way (bernfrac at huge precisions, or
/// mpf_bernoulli_huge).
fn mpf_bernoulli(n: i64, prec: i64, rnd: Rnd) -> Option<Mpf> {
    if n < 2 {
        return Some(if n == 0 { fone() } else { mpf::mpf_neg(&Mpf { sign: 0, man: Nat::from_u64(1), exp: Exp::S(-1), bc: 1 }) });
    }
    if n & 1 == 1 {
        return Some(mpf::fzero());
    }
    if prec > bernoulli_size(MAX_BERNOULLI_CACHE) && prec as f64 > bernoulli_size(n) as f64 * 1.1 + 1000.0 {
        return None;
    }
    if n > MAX_BERNOULLI_CACHE {
        return None;
    }
    let wp = prec + 30 + 32 - (prec & 31);
    let (f3, f6) = (from_int(&i(3)), from_int(&i(6)));
    caches(|c| {
        if let Some(b) = c.bernoulli.get(&wp) {
            if let Some(Some(v)) = b.numbers.get(n as usize) {
                return Some(mpf_pos(v, prec as u64, rnd));
            }
            if n - b.m > 10 {
                return None;
            }
        } else {
            if n > 10 {
                return None;
            }
            c.bernoulli.insert(wp, Bern { numbers: vec![Some(fone())], m: 2, bin: i(10), bin1: i(1) });
        }
        let st = c.bernoulli.get_mut(&wp)?;
        let w = wp as u64;
        while st.m <= n {
            if failed() {
                return Some(mpf::fzero());
            }
            let m = st.m;
            let case = m % 6;
            let szbm = bernoulli_size(m);
            let mut s = Int::zero();
            let sexp = szbm.max(0) - wp;
            let mut a = if m < 6 { Int::zero() } else { st.bin1.clone() };
            for j in 1..=m / 6 {
                let u = st.numbers[(m - 6 * j) as usize].as_ref()?;
                let uman = Int::new(u.sign == 1, u.man.clone());
                let uexp = u.exp.as_i64()?;
                s = s.add(&a.mul(&uman).shift(uexp - sexp));
                let j6 = 6 * j;
                let mut num = i(1);
                for d in [5, 4, 3, 2, 1, 0] {
                    num = num.mul_i64(m - d - j6);
                }
                let mut den = i(1);
                for d in 4..=9 {
                    den = den.mul_i64(d + j6);
                }
                a = a.mul(&num).floordiv(&den);
            }
            let b = match case {
                4 => mpf_rdiv_int(-m - 3, &f6, w, FAST),
                _ => mpf_rdiv_int(m + 3, &f3, w, FAST),
            };
            let s = from_int_man_exp(&s, &Exp::S(sexp), w, FAST);
            let b = mpf_div(&mpf_sub(&b, &s, w, FAST), &from_int(&st.bin), w, FAST);
            if st.numbers.len() <= m as usize {
                st.numbers.resize(m as usize + 1, None);
            }
            st.numbers[m as usize] = Some(b);
            st.m += 2;
            let m = st.m;
            st.bin = st.bin.mul(&i((m + 2) * (m + 3))).floordiv(&i(m * (m - 1)));
            if m > 6 {
                st.bin1 = st.bin1.mul(&i((2 + m) * (3 + m))).floordiv(&i((m - 7) * (m - 6)));
            }
        }
        let v = st.numbers.get(n as usize)?.as_ref()?;
        Some(mpf_pos(v, prec as u64, rnd))
    })
}

/// zeta_array(N, prec): zeta(n) for n = 0..N+1 at prec bits, fixed point.
fn zeta_array(n_max: i64, prec: i64) -> Option<Vec<Int>> {
    let extra = 30;
    let wp = prec + extra;
    let w = wp as u64;
    let mut zv = vec![Int::zero(); (n_max + 2) as usize];
    let pi = Int::from(pi_fixed(wp));
    let one = i(1).shl(w);
    zv[0] = one.neg().floordiv_i64(2);
    let f_2pi = mpf_shift(&mpf_pi(w, FAST), 1);
    let exp_2pi = mpf_exp(&f_2pi, w, FAST);
    let mut exp_2pi_k = exp_2pi.clone();
    let mut exps3: Vec<(Int, Int)> = Vec::new();
    let mut k: i64 = 1;
    loop {
        let tp = wp - 9 * k;
        if tp < 1 || failed() {
            break;
        }
        let tp = tp as u64;
        let q1 = mpf_div(&fone(), &mpf_sub(&exp_2pi_k, &fone(), tp, FAST), tp, FAST);
        let q2 = mpf_mul(&exp_2pi_k, &mpf_mul(&q1, &q1, tp, FAST), tp, FAST);
        let q1 = to_fixed(&q1, wp);
        let q2 = to_fixed(&q2, wp);
        let q2 = i(k).mul(&q2).mul(&pi).shr(w);
        exps3.push((q1, q2));
        exp_2pi_k = mpf_mul(&exp_2pi_k, &exp_2pi, w, FAST);
        k += 1;
    }
    let mut n = 3;
    while n <= n_max {
        let mut s = Int::zero();
        let mut k = 1;
        for (e1, e2) in &exps3 {
            if failed() {
                return None;
            }
            let t = if n % 4 == 3 {
                e1.floordiv(&ipow(k, n))
            } else {
                let u = (n - 1) / 4;
                e1.add(&e2.floordiv_i64(u)).floordiv(&ipow(k, n))
            };
            if t.is_zero() {
                break;
            }
            s = s.add(&t);
            k += 1;
        }
        zv[n as usize] = s.mul_i64(-2);
        n += 2;
    }
    let mut bs = Vec::with_capacity((n_max + 2) as usize);
    for k in 0..n_max + 2 {
        bs.push(mpf_abs(&mpf_bernoulli(k, wp, FAST)?, 0, FAST));
    }
    let fpi = mpf_pow_int(&mpf_shift(&mpf_pi(w, FAST), 1), &i(2), w, FAST);
    let mut pi_pow = mpf_div(&fpi, &from_int(&i(4)), w, FAST);
    let mut n = 2;
    while n < n_max + 2 {
        let z = mpf_mul(&bs[n as usize], &pi_pow, w, FAST);
        zv[n as usize] = to_fixed(&z, wp);
        pi_pow = mpf_mul(&pi_pow, &fpi, w, FAST);
        pi_pow = mpf_div(&pi_pow, &from_int(&i((n + 1) * (n + 2))), w, FAST);
        n += 2;
    }
    let reciprocal_pi = one.shl(w).floordiv(&pi);
    let mut n = 3;
    while n <= n_max {
        let u = (n - 3) / 4;
        let mut s = zv[(4 * u + 4) as usize].mul_i64(4 * u + 7).floordiv_i64(4);
        for k in 1..=u {
            s = s.sub(&zv[(4 * k) as usize].mul(&zv[(4 * u + 4 - 4 * k) as usize]).shr(w));
        }
        zv[n as usize] = zv[n as usize].add(&s.mul_i64(2).mul(&reciprocal_pi).shr(w));
        n += 4;
    }
    let mut n = 5;
    while n <= n_max {
        let u = (n - 1) / 4;
        let mut s = zv[(4 * u + 2) as usize].mul_i64(2 * u + 1);
        for k in 1..=2 * u {
            let sg = if k % 2 == 1 { -1 } else { 1 };
            s = s.add(&zv[(2 * k) as usize].mul_i64(sg * 2 * k).mul(&zv[(4 * u + 2 - 2 * k) as usize]).shr(w));
        }
        zv[n as usize] = zv[n as usize].add(&s.mul(&reciprocal_pi).shr(w).floordiv_i64(2 * u));
        n += 4;
    }
    Some(zv.iter().map(|x| x.shr(extra as u64)).collect())
}

/// gamma_taylor_coefficients(inprec): the Taylor coefficients of
/// 1/gamma(1+x), highest first, and their precision.
fn gamma_taylor_coefficients(inprec: i64) -> Option<(Vec<Int>, i64)> {
    let mut prec = if inprec < 400 {
        inprec + (10 - inprec % 10)
    } else if inprec < 1000 {
        inprec + (30 - inprec % 30)
    } else {
        inprec
    };
    if let Some(c) = caches(|c| c.taylor.iter().find(|e| e.0 == prec).map(|e| e.1.clone())) {
        return Some((c, prec));
    }
    let n = if prec < 1000 { glibm::pow(prec as f64, 0.76) + 2.0 } else { glibm::pow(prec as f64, 0.787) + 2.0 } as i64;
    // (the first larger precision cached, in the order they were made)
    let reuse = caches(|c| {
        c.taylor.iter().find(|e| e.0 > prec).map(|(cprec, v)| {
            let from = v.len().saturating_sub(n as usize);
            v[from..].iter().map(|x| x.shr((cprec - prec) as u64)).collect::<Vec<Int>>()
        })
    });
    if let Some(coeffs) = reuse {
        if inprec < 1000 {
            caches(|c| c.taylor.push((prec, coeffs.clone())));
        }
        return Some((coeffs, prec));
    }
    if prec > 1000 {
        prec = (prec as f64 * 1.2) as i64;
    }
    let wp = prec + 20;
    let w = wp as u64;
    let nn = n as usize;
    let mut a = vec![Int::zero(); nn];
    a[1] = i(1).shl(w);
    a[2] = Int::from(euler_fixed(wp));
    let zv = zeta_array(n, wp)?;
    for k in 3..nn {
        if failed() {
            return None;
        }
        let mut x = a[2].neg().mul(&a[k - 1]).shr(w);
        for j in 2..k {
            let t = zv[j].mul(&a[k - j]);
            let t = if j % 2 == 1 { t.neg() } else { t };
            x = x.add(&t.shr(w));
        }
        a[k] = x.floordiv_i64(1 - k as i64);
    }
    let mut a: Vec<Int> = a.iter().map(|x| x.shr(20)).collect();
    a.reverse();
    a.pop();
    caches(|c| c.taylor.push((prec, a)));
    gamma_taylor_coefficients(inprec)
}

/// gamma_fixed_taylor(xmpf, x, wp, prec, rnd, type) for type 0 (gamma) and
/// 2 (1/gamma).
fn gamma_fixed_taylor(xmpf: &Mpf, x: Int, wp: i64, prec: u64, rnd: Rnd, typ: u32) -> Option<Mpf> {
    let w = wp as u64;
    let mut x = x;
    let nearest_int = x.shr(w - 1).add(&i(1)).shr(1).to_i64()?;
    let one = i(1).shl(w);
    let (coeffs, cwp) = gamma_taylor_coefficients(wp)?;
    let horner = |x: &Int| {
        let mut p = Int::zero();
        for c in &coeffs {
            p = c.add(&x.mul(&p).shr(w));
        }
        p.shr((cwp - wp) as u64)
    };
    if nearest_int > 0 {
        let mut r = one.clone();
        for _ in 0..nearest_int - 1 {
            x = x.sub(&one);
            r = r.mul(&x).shr(w);
        }
        x = x.sub(&one);
        let p = horner(&x);
        let rw = r.shl(w);
        return Some(if typ == 0 {
            from_int_man_exp(&rw.floordiv(&p), &Exp::S(-wp), prec, rnd)
        } else {
            mpf_shift(&mpf_div(&from_int(&p), &from_int(&rw), prec, rnd), wp)
        });
    }
    let mut r = one.clone();
    for _ in 0..-nearest_int {
        r = r.mul(&x).shr(w);
        x = x.add(&one);
    }
    let p = horner(&x);
    let r = if wp - x.bits() as i64 > 10 {
        // (very near 0: the product in floating point)
        let g = mpf::mpf_add(xmpf, &from_int(&i(-nearest_int)), 0, FAST, false);
        let r = from_int_man_exp(&p.mul(&r), &Exp::S(-2 * wp), 0, FAST);
        mpf_mul(&r, &g, w, FAST)
    } else {
        from_int_man_exp(&x.mul(&p).mul(&r), &Exp::S(-3 * wp), 0, FAST)
    };
    Some(if typ == 0 { mpf_div(&fone(), &r, prec, rnd) } else { mpf_pos(&r, prec, rnd) })
}

/// mpf_gamma(x, prec, rnd, type) where the reference takes the Taylor path
/// (types 0 and 2); None for the caller to take mpmath's own path.
pub fn mpf_gamma(x: &Mpf, prec: u64, rnd: Rnd, typ: u32) -> Option<Mpf> {
    if x.man.is_zero() || prec == 0 || !(typ == 0 || typ == 2) {
        return None;
    }
    let exp = x.exp.as_i64()?;
    // (integers: the factorial cache and ifac)
    if exp >= 0 {
        return None;
    }
    let n = x.man.shr(exp.unsigned_abs()).to_u64().filter(|&n| n < 1 << 40)? as i64;
    let mag = exp + x.bc;
    let gamma_size = n as i128 * mag as i128;
    let wp = prec as i64 + (128 - gamma_size.unsigned_abs().leading_zeros()) as i64 + 20;
    // (the pole's neighbourhood, and half-integers)
    if mag < -wp || exp >= -1 {
        return None;
    }
    let offset = exp + wp;
    let absxman = if offset >= 0 { x.man.shl(offset as u64) } else { x.man.shr(offset.unsigned_abs()) };
    let n_for_stirling = (GAMMA_STIRLING_BETA * wp as f64) as i64;
    if !(n < n_for_stirling.max(100) && wp < MAX_GAMMA_TAYLOR_PREC) {
        return None;
    }
    gamma_fixed_taylor(x, Int::new(x.sign == 1, absxman), wp, prec, rnd, typ)
}
