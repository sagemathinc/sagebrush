//! mpmath's elementary functions (libelefun.py, BSD-3-Clause, Copyright (c)
//! 2005-2021 Fredrik Johansson and mpmath contributors) on the python
//! backend, ported operation for operation: the fixed-point series and
//! their caches (cos_sin_cache, log_taylor_cache, log_int_cache, each the
//! session's and each giving what the reference's gives for the same
//! history), and mpf_exp, mpf_log, mpf_cos/mpf_sin, mpf_pow, exp_fixed,
//! cos_sin_fixed, log_int_fixed.  Float parameter choices go through glibm
//! (CPython's pow and log).

use crate::fail::{failed, raise, too_big};
use crate::consts::{e_fixed, ln2_fixed, pi_fixed};
use crate::exp::Exp;
use crate::glibm::pow as fpow;
use crate::int::Int;
use crate::intmath::isqrt_fast_python;
use crate::mpc::{mpc_abs, mpf_shift as mpf_shift_i64, Mpc};
use crate::mpf::{
    finf, fnan, fninf, fone, from_int, from_int_man_exp, fzero, mpf_add, mpf_div, mpf_mul, mpf_neg, mpf_perturb,
    mpf_pow_int, mpf_sqrt, normalize, to_fixed, Mpf, Rnd,
};
use crate::nat::Nat;
use crate::Fail;
use std::cell::RefCell;

const EXP_COSH_CUTOFF: i64 = 600;
const EXP_SERIES_U_CUTOFF: i64 = 1500;
const COS_SIN_CACHE_PREC: i64 = 400;
const COS_SIN_CACHE_STEP: i64 = 8;
const MAX_LOG_INT_CACHE: i64 = 2000;
const LOG_TAYLOR_PREC: i64 = 2500;
const LOG_TAYLOR_SHIFT: i64 = 9;
const LOG_AGM_MAG_PREC_RATIO: i64 = 20;

thread_local! {
    static COS_SIN_CACHE: RefCell<Dense<(Int, Int)>> = const { RefCell::new(Dense(Vec::new())) };
    static LOG_TAYLOR_CACHE: RefCell<Dense<(Int, Int)>> = const { RefCell::new(Dense(Vec::new())) };
    static LOG_INT_CACHE: RefCell<Dense<(Int, i64)>> = const { RefCell::new(Dense(Vec::new())) };
}

/// A cache over small non-negative keys, by index (no hashing: the keys are
/// dense).  cos_sin_cache and log_taylor_cache hold what their key alone
/// determines, so a key past the table is computed, not cached, with the same
/// result; log_int_cache's keys (n < MAX_LOG_INT_CACHE) all fit.
struct Dense<V>(Vec<Option<V>>);

/// The most entries a dense cache holds (past it, a key is not cached).
const DENSE_MAX: usize = 1 << 15;

impl<V: Clone> Dense<V> {
    fn get(&self, k: i64) -> Option<V> {
        usize::try_from(k).ok().and_then(|i| self.0.get(i)).and_then(|v| v.clone())
    }
    fn put(&mut self, k: i64, v: V) {
        // (a failed call's value is never cached: the reference raises before it stores)
        if failed() {
            return;
        }
        let Ok(i) = usize::try_from(k) else { return };
        if i >= DENSE_MAX {
            return;
        }
        if self.0.len() <= i {
            if self.0.try_reserve(i + 1 - self.0.len()).is_err() {
                return;
            }
            self.0.resize(i + 1, None);
        }
        self.0[i] = Some(v);
    }
}

/// log_taylor_cache's key (n, cached_prec) as one index: cached_prec is one
/// of cache_prec_steps' 12 values, n below 2^10 for x in (0.5, 2).
fn taylor_key(n: i64, cached_prec: i64) -> i64 {
    let step = [22, 24, 28, 36, 52, 84, 148, 276, 532, 1044, 2068, 2520].iter().position(|&p| p == cached_prec);
    match step {
        Some(s) if (0..1024).contains(&n) => s as i64 * 1024 + n,
        _ => -1,
    }
}

/// Forget every cache (a new session).
pub fn reset() {
    COS_SIN_CACHE.with(|c| c.borrow_mut().0.clear());
    LOG_TAYLOR_CACHE.with(|c| c.borrow_mut().0.clear());
    LOG_INT_CACHE.with(|c| c.borrow_mut().0.clear());
    crate::consts::reset();
}

/// cache_prec_steps[prec] for prec <= LOG_TAYLOR_PREC: [22, 22], then for
/// k = 1..bitcount(2500), [min(2^k, 2500) + 20] repeated 2^(k-1) times.
fn cache_prec_step(prec: i64) -> i64 {
    if prec < 2 {
        return 22;
    }
    // index i >= 2 falls in the run for k with 2^(k-1) <= i - 1 + ... :
    // runs start at 2 (k=1, length 1), 3 (k=2, length 2), 5 (k=3, length 4), ...
    let mut start = 2i64;
    let mut k = 1u32;
    loop {
        let len = 1i64 << (k - 1);
        if prec < start + len {
            return (1i64 << k).min(LOG_TAYLOR_PREC) + 20;
        }
        start += len;
        k += 1;
    }
}

fn i(x: i64) -> Int {
    Int::from_i64(x)
}

/// A shift count the reference computes as a Python int; a negative one is
/// its ValueError, refused here rather than wrapped.
fn cnt(k: i64) -> u64 {
    u64::try_from(k).unwrap_or_else(|_| {
        too_big();
        0
    })
}

/// A count that must fit an i64 (past it, a number the call couldn't hold).
fn big_i64(x: Option<i64>) -> i64 {
    x.unwrap_or_else(|| {
        too_big();
        0
    })
}

/// The float-chosen parameters, pinned against CPython for every prec
/// (tests/params.rs): exponential_series' r = int(0.5*prec**0.5) and
/// u = int(0.3*prec**0.35), exp_basecase's r = int(prec**0.5).
pub fn series_r(prec: i64) -> i64 {
    (0.5 * fpow(prec as f64, 0.5)) as i64
}
pub fn series_u(prec: i64) -> i64 {
    (0.3 * fpow(prec as f64, 0.35)) as i64
}
pub fn basecase_r(prec: i64) -> i64 {
    fpow(prec as f64, 0.5) as i64
}

fn isqrt_fast(x: &Int) -> Int {
    Int::from(isqrt_fast_python(&x.mag))
}

pub enum Series {
    Exp(Int),
    Pair(Int, Int),
}

/// exponential_series(x, prec, type)
pub fn exponential_series(x: &Int, prec: i64, typ: u32) -> Series {
    let sign = x.is_neg();
    let x = x.abs();
    let r0 = series_r(prec);
    let xmag = x.bits() as i64 - prec;
    let r = 0.max(xmag + r0);
    let extra = 10 + 2 * r.max(-xmag);
    let wp = prec + extra;
    let x = x.shl(cnt(extra - r));
    let one = Int::pow2(cnt(wp));
    let alt = typ == 2;
    let c;
    if prec < EXP_SERIES_U_CUTOFF {
        let x2 = x.mul(&x).shr(cnt(wp));
        let mut a = x2.clone();
        let x4 = x2.mul(&x2).shr(cnt(wp));
        let (mut s0, mut s1) = (Int::zero(), Int::zero());
        let mut k = 2i64;
        while !a.is_zero() {
            a = a.floordiv_i64((k - 1) * k);
            s0 = s0.add(&a);
            k += 2;
            a = a.floordiv_i64((k - 1) * k);
            s1 = s1.add(&a);
            k += 2;
            a = a.mul(&x4).shr(cnt(wp));
        }
        s1 = x2.mul(&s1).shr(cnt(wp));
        c = if alt { s1.sub(&s0).add(&one) } else { s1.add(&s0).add(&one) };
    } else {
        let u = series_u(prec) as usize;
        let x2 = x.mul(&x).shr(cnt(wp));
        let mut a = x2.clone();
        let mut xpowers = vec![one.clone(), x2.clone()];
        for _ in 1..u {
            let last = xpowers.last().unwrap().mul(&x2).shr(cnt(wp));
            xpowers.push(last);
        }
        let mut sums = vec![Int::zero(); u];
        let mut k = 2i64;
        while !a.is_zero() {
            for s in sums.iter_mut() {
                a = a.floordiv_i64((k - 1) * k);
                *s = if alt && k & 2 != 0 { s.sub(&a) } else { s.add(&a) };
                k += 2;
            }
            a = a.mul(xpowers.last().unwrap()).shr(cnt(wp));
        }
        for (j, s) in sums.iter_mut().enumerate().skip(1) {
            *s = s.mul(&xpowers[j]).shr(cnt(wp));
        }
        let mut total = Int::zero();
        for s in &sums {
            total = total.add(s);
        }
        c = total.add(&one);
    }
    if typ == 0 {
        let s = isqrt_fast(&c.mul(&c).sub(&one.shl(cnt(wp))));
        let mut v = if sign { c.sub(&s) } else { c.add(&s) };
        for _ in 0..r {
            v = v.mul(&v).shr(cnt(wp));
        }
        return Series::Exp(v.shr(cnt(extra)));
    }
    let pshift = cnt(wp - 1);
    let mut c = c;
    for _ in 0..r {
        c = c.mul(&c).shr(pshift).sub(&one);
    }
    let mut s = isqrt_fast(&one.shl(cnt(wp)).sub(&c.mul(&c)).abs());
    if sign {
        s = s.neg();
    }
    Series::Pair(c.shr(cnt(extra)), s.shr(cnt(extra)))
}

/// exp_basecase(x, prec)
pub fn exp_basecase(x: &Int, prec: i64) -> Int {
    if prec > EXP_COSH_CUTOFF {
        return match exponential_series(x, prec, 0) {
            Series::Exp(v) => v,
            Series::Pair(..) => unreachable!(),
        };
    }
    let mut r = basecase_r(prec);
    let prec = prec + r;
    let mut s0 = Int::pow2(cnt(prec));
    let mut s1 = s0.clone();
    let mut k = 2i64;
    let x2 = x.mul(x).shr(cnt(prec));
    let mut a = x2.clone();
    while !a.is_zero() {
        a = a.floordiv_i64(k);
        s0 = s0.add(&a);
        k += 1;
        a = a.floordiv_i64(k);
        s1 = s1.add(&a);
        k += 1;
        a = a.mul(&x2).shr(cnt(prec));
    }
    s1 = s1.mul(x).shr(cnt(prec));
    let mut s = s0.add(&s1);
    let u = r;
    while r != 0 {
        s = s.mul(&s).shr(cnt(prec));
        r -= 1;
    }
    s.shr(cnt(u))
}

/// cos_sin_basecase(x, prec), x in [0, pi/2).
pub fn cos_sin_basecase(x: &Int, prec: i64) -> (Int, Int) {
    if prec > COS_SIN_CACHE_PREC {
        return match exponential_series(x, prec, 2) {
            Series::Pair(c, s) => (c, s),
            Series::Exp(_) => unreachable!(),
        };
    }
    let precs = prec - COS_SIN_CACHE_STEP;
    let t = x.shr(cnt(precs));
    let n = big_i64(t.to_i64());
    let cached = COS_SIN_CACHE.with(|c| c.borrow().get(n));
    let (cos_t, sin_t) = match cached {
        Some(v) => v,
        None => {
            let w = t.shl(cnt(10 + COS_SIN_CACHE_PREC - COS_SIN_CACHE_STEP));
            let (c, s) = match exponential_series(&w, 10 + COS_SIN_CACHE_PREC, 2) {
                Series::Pair(c, s) => (c, s),
                Series::Exp(_) => unreachable!(),
            };
            let v = (c.shr(10), s.shr(10));
            COS_SIN_CACHE.with(|cc| cc.borrow_mut().put(n, v.clone()));
            v
        }
    };
    let offset = cnt(COS_SIN_CACHE_PREC - prec);
    let cos_t = cos_t.shr(offset);
    let sin_t = sin_t.shr(offset);
    let x = x.sub(&t.shl(cnt(precs)));
    let mut cos = Int::pow2(cnt(prec));
    let mut sin = x.clone();
    let mut k = 2i64;
    let mut a = x.mul(&x).shr(cnt(prec)).neg();
    while !a.is_zero() {
        a = a.floordiv_i64(k);
        cos = cos.add(&a);
        k += 1;
        a = a.mul(&x).shr(cnt(prec));
        a = a.floordiv_i64(k);
        sin = sin.add(&a);
        k += 1;
        a = a.mul(&x).shr(cnt(prec)).neg();
    }
    let p = cnt(prec);
    (cos.mul(&cos_t).sub(&sin.mul(&sin_t)).shr(p), sin.mul(&cos_t).add(&cos.mul(&sin_t)).shr(p))
}

/// def_mpf_constant(e_fixed)(prec, rnd): mpf_e.
fn mpf_e(prec: u64, rnd: Rnd) -> Mpf {
    let wp = prec as i64 + 20;
    let mut v = e_fixed(wp);
    if matches!(rnd, Rnd::Up | Rnd::Ceiling) {
        v = v.add_u64(1);
    }
    let bc = v.bits() as i64;
    normalize(0, v, Exp::S(-wp), bc, prec, rnd)
}

fn need_i64(e: &Exp) -> i64 {
    big_i64(e.as_i64())
}

/// mpf_exp(x, prec, rnd)
pub fn mpf_exp(x: &Mpf, prec: u64, rnd: Rnd) -> Mpf {
    if !x.man.is_zero() {
        let mag = x.exp.add_i64(x.bc);
        let wp = prec as i64 + 14;
        let man = Int::new(x.sign == 1, x.man.clone());
        if prec > 600 && !x.exp.is_neg() {
            // e = mpf_e(wp + int(1.45 * mag)); mpf_pow_int(e, man << exp)
            let magi = need_i64(&mag);
            let ep = big_i64(wp.checked_add((1.45 * magi as f64) as i64));
            let e = mpf_e(cnt(ep), Rnd::Down);
            let n = man.shl(x.exp.as_shift());
            return mpf_pow_int(&e, &n, prec, rnd);
        }
        if mag.lt_i64(-wp) {
            return mpf_perturb(&fone(), x.sign, prec, rnd);
        }
        let (t, n) = if mag.gt_i64(1) {
            let magi = need_i64(&mag);
            let wpmod = big_i64(wp.checked_add(magi));
            let offset = need_i64(&x.exp.add_i64(wpmod));
            let t = man.shift(offset);
            let lg2 = Int::from(ln2_fixed(wpmod));
            let (n, t) = t.divmod(&lg2);
            (t.shr(cnt(magi)), n)
        } else {
            let offset = x.exp.add_i64(wp);
            let t = match offset.as_i64() {
                Some(o) => man.shift(o),
                None => to_fixed(x, wp),
            };
            (t, Int::zero())
        };
        let m = exp_basecase(&t, wp);
        return from_int_man_exp(&m, &Exp::from_int(&n.sub(&i(wp))), prec, rnd);
    }
    if x.exp.is_zero() {
        return fone();
    }
    if x.is_fninf() {
        return fzero();
    }
    x.clone()
}

/// log_taylor(x, prec, r)
fn log_taylor(x: &Int, prec: i64, r: i64) -> Int {
    let mut x = x.clone();
    for _ in 0..r {
        x = isqrt_fast(&x.shl(cnt(prec)));
    }
    let one = Int::pow2(cnt(prec));
    let mut v = x.sub(&one).shl(cnt(prec)).floordiv(&x.add(&one));
    let sign = v.is_neg();
    if sign {
        v = v.neg();
    }
    let p = cnt(prec);
    let v2 = v.mul(&v).shr(p);
    let v4 = v2.mul(&v2).shr(p);
    let mut s0 = v.clone();
    let mut s1 = v.floordiv_i64(3);
    v = v.mul(&v4).shr(p);
    let mut k = 5i64;
    while !v.is_zero() {
        s0 = s0.add(&v.floordiv_i64(k));
        k += 2;
        s1 = s1.add(&v.floordiv_i64(k));
        v = v.mul(&v4).shr(p);
        k += 2;
    }
    s1 = s1.mul(&v2).shr(p);
    let s = s0.add(&s1).shl(cnt(1 + r));
    if sign { s.neg() } else { s }
}

/// log_taylor_cached(x, prec), x in (0.5, 2) at prec <= LOG_TAYLOR_PREC.
fn log_taylor_cached(x: &Int, prec: i64) -> Int {
    let n = big_i64(x.shr(cnt(prec - LOG_TAYLOR_SHIFT)).to_i64());
    let cached_prec = cache_prec_step(prec);
    let dprec = cnt(cached_prec - prec);
    let key = taylor_key(n, cached_prec);
    let cached = LOG_TAYLOR_CACHE.with(|c| c.borrow().get(key));
    let (a, log_a) = match cached {
        Some(v) => v,
        None => {
            let a = i(n).shl(cnt(cached_prec - LOG_TAYLOR_SHIFT));
            let log_a = log_taylor(&a, cached_prec, 8);
            LOG_TAYLOR_CACHE.with(|c| c.borrow_mut().put(key, (a.clone(), log_a.clone())));
            (a, log_a)
        }
    };
    let a = a.shr(dprec);
    let log_a = log_a.shr(dprec);
    let p = cnt(prec);
    let u = x.sub(&a).shl(p).floordiv(&a);
    let mut v = u.shl(p).floordiv(&Int::from_i64(2).shl(p).add(&u));
    let v2 = v.mul(&v).shr(p);
    let v4 = v2.mul(&v2).shr(p);
    let mut s0 = v.clone();
    let mut s1 = v.floordiv_i64(3);
    v = v.mul(&v4).shr(p);
    let mut k = 5i64;
    while !v.is_zero() {
        s0 = s0.add(&v.floordiv_i64(k));
        k += 2;
        s1 = s1.add(&v.floordiv_i64(k));
        v = v.mul(&v4).shr(p);
        k += 2;
    }
    s1 = s1.mul(&v2).shr(p);
    let s = s0.add(&s1).shl(1);
    log_a.add(&s)
}

/// agm_fixed(a, b, prec)
fn agm_fixed(a: &Int, b: &Int, _prec: i64) -> Int {
    let (mut a, mut b) = (a.clone(), b.clone());
    let mut it = 0;
    loop {
        let anew = a.add(&b).shr(1);
        if it > 4 && a.sub(&anew).abs().cmp(&i(8)) == core::cmp::Ordering::Less {
            return a;
        }
        b = isqrt_fast(&a.mul(&b));
        a = anew;
        it += 1;
    }
}

/// log_agm(x, prec): -log(x) for 0 < x < 1, fixed point.
fn log_agm(x: &Int, prec: i64) -> Int {
    let p = cnt(prec);
    let x2 = x.mul(x).shr(p);
    let mut s = x2.clone();
    let mut a = x2.clone();
    let mut b = x2.clone();
    while !a.is_zero() {
        b = b.mul(&x2).shr(p);
        a = a.mul(&b).shr(p);
        s = s.add(&a);
    }
    s = s.add(&Int::pow2(p));
    s = s.mul(&s).shr(p - 2);
    s = s.mul(&isqrt_fast(&x.shl(p))).shr(p);
    let mut t = x.clone();
    let mut a = x.clone();
    let mut b = x.clone();
    while !a.is_zero() {
        b = b.mul(&x2).shr(p);
        a = a.mul(&b).shr(p);
        t = t.add(&a);
    }
    t = Int::pow2(p).add(&t.shl(1));
    t = t.mul(&t).shr(p);
    let pa = agm_fixed(&s, &t, prec);
    Int::from(pi_fixed(prec)).shl(p).floordiv(&pa)
}

/// mpf_shift(s, n) for an n of any size.
fn mpf_shift(s: &Mpf, n: &Int) -> Mpf {
    if s.man.is_zero() {
        return s.clone();
    }
    Mpf { sign: s.sign, man: s.man.clone(), exp: s.exp.add(&Exp::from_int(n)), bc: s.bc }
}

/// mpf_log(x, prec, rnd); a negative x is the reference's ComplexResult.
pub fn mpf_log(x: &Mpf, prec: u64, rnd: Rnd) -> Mpf {
    if x.man.is_zero() {
        if x.is_fzero() {
            return fninf();
        }
        if x.is_finf() {
            return finf();
        }
        if x.is_fnan() {
            return fnan();
        }
    }
    if x.sign == 1 {
        raise(Fail::ComplexResult);
        return fnan();
    }
    let mut wp = prec as i64 + 20;
    if x.man.to_u64() == Some(1) {
        if x.exp.is_zero() {
            return fzero();
        }
        let m = x.exp.to_int().mul(&Int::from(ln2_fixed(wp)));
        return from_int_man_exp(&m, &Exp::S(-wp), prec, rnd);
    }
    let bc = x.bc;
    let mag = x.exp.add_i64(bc);
    let abs_mag = if mag.is_neg() { mag.neg() } else { mag.clone() };
    if !abs_mag.gt_i64(1) {
        let am = need_i64(&abs_mag);
        let tsign = (1 - am) as u32;
        let tman = if tsign == 1 {
            Nat::from_u64(1).shl(cnt(bc)).sub(&x.man)
        } else {
            x.man.sub(&Nat::from_u64(1).shl(cnt(bc - 1)))
        };
        let tbc = tman.bits() as i64;
        let cancellation = bc - tbc;
        if cancellation > wp {
            let t = normalize(tsign, tman, Exp::S(am - bc), tbc, tbc as u64, Rnd::Nearest);
            return mpf_perturb(&t, tsign, prec, rnd);
        }
        wp += cancellation;
    }
    if abs_mag.gt_i64(10000) && abs_mag.to_int().bits() as i64 > wp {
        let m = x.exp.to_int().mul(&Int::from(ln2_fixed(wp)));
        return from_int_man_exp(&m, &Exp::S(-wp), prec, rnd);
    }
    let m = if wp <= LOG_TAYLOR_PREC {
        let xm = Int::from(x.man.clone()).shift(wp - bc);
        let mut m = log_taylor_cached(&xm, wp);
        if !mag.is_zero() {
            m = m.add(&mag.to_int().mul(&Int::from(ln2_fixed(wp))));
        }
        m
    } else {
        let optimal_mag = (-wp).div_euclid(LOG_AGM_MAG_PREC_RATIO);
        let n = i(optimal_mag).sub(&mag.to_int());
        let xs = mpf_shift(x, &n);
        wp += -optimal_mag;
        let m = log_agm(&to_fixed(&xs, wp), wp).neg();
        m.sub(&n.mul(&Int::from(ln2_fixed(wp))))
    };
    from_int_man_exp(&m, &Exp::S(-wp), prec, rnd)
}

/// log_int_fixed(n, prec, ln2): log(n) in fixed point, cached for n < 2000
/// (the cache keeps the highest precision asked so far, as the reference's).
pub fn log_int_fixed(n: &Int, prec: i64, ln2: Option<&Int>) -> Int {
    let key = n.to_i64();
    if let Some(k) = key {
        let hit = LOG_INT_CACHE.with(|c| c.borrow().get(k));
        if let Some((value, vprec)) = hit {
            if vprec >= prec {
                return value.shr(cnt(vprec - prec));
            }
        }
    }
    let wp = prec + 10;
    let v = if wp <= LOG_TAYLOR_SHIFT {
        let ln2 = match ln2 {
            Some(l) => l.clone(),
            None => Int::from(ln2_fixed(wp)),
        };
        let r = n.bits() as i64;
        let x = n.shl(cnt(wp - r));
        log_taylor_cached(&x, wp).add(&ln2.mul_i64(r))
    } else {
        let nf = from_int(n.is_neg() as u32, n.mag.clone(), 0, Rnd::Down);
        to_fixed(&mpf_log(&nf, cnt(wp + 5), Rnd::Down), wp)
    };
    match key {
        Some(k) if k < MAX_LOG_INT_CACHE => {
            LOG_INT_CACHE.with(|c| c.borrow_mut().put(k, (v.clone(), wp)));
        }
        _ => {}
    }
    v.shr(cnt(wp - prec))
}

/// mod_pi2(man, exp, mag, wp) -> (t, n, wp)
fn mod_pi2(man: &Int, exp: &Exp, mag: i64, wp: i64) -> (Int, Int, i64) {
    if mag > 0 {
        let mut it = 0u32;
        loop {
            // (the precision doubles until the reduction is significant: a
            // failed call has no significant reduction, so it stops here)
            let wpmod = 20i64.checked_shl(it).filter(|c| *c > 0).and_then(|c| wp.checked_add(mag)?.checked_add(c));
            let Some(wpmod) = wpmod.filter(|_| !failed()) else {
                too_big();
                return (Int::zero(), Int::zero(), wp);
            };
            let pi2 = Int::from(pi_fixed(wpmod - 1));
            let pi4 = pi2.shr(1);
            let offset = need_i64(&exp.add_i64(wpmod));
            let t = man.shift(offset);
            let (n, y) = t.divmod(&pi2);
            let small = if y.cmp(&pi4) == core::cmp::Ordering::Greater { pi2.sub(&y) } else { y.clone() };
            if !small.shr(cnt(wp + mag - 10)).is_zero() {
                return (y.shr(cnt(mag)), n, wpmod - mag);
            }
            it += 1;
        }
    }
    let wp = wp - mag;
    let offset = need_i64(&exp.add_i64(wp));
    (man.shift(offset), Int::zero(), wp)
}

/// mpf_cos_sin(x, prec, rnd, which) with pi = False, for which 0 (both),
/// 1 (cos) and 2 (sin); the value not asked for is fzero and never rounded.
pub fn mpf_cos_sin(x: &Mpf, prec: u64, rnd: Rnd, which: u32) -> (Mpf, Mpf) {
    if x.man.is_zero() {
        return if !x.exp.is_zero() { (fnan(), fnan()) } else { (fone(), fzero()) };
    }
    let mag = x.exp.add_i64(x.bc);
    let wp = prec as i64 + 10;
    if mag.lt_i64(0) && mag.lt_i64(-wp) {
        let c = if which != 2 { mpf_perturb(&fone(), 1, prec, rnd) } else { fzero() };
        let s = if which != 1 { mpf_perturb(x, 1 - x.sign, prec, rnd) } else { fzero() };
        return (c, s);
    }
    let (t, n, wp) = mod_pi2(&Int::from(x.man.clone()), &x.exp, need_i64(&mag), wp);
    let (c, s) = cos_sin_basecase(&t, wp);
    let (c, mut s) = quarter(n, c, s);
    if x.sign == 1 {
        s = s.neg();
    }
    let e = Exp::S(-wp);
    let c = if which != 2 { from_int_man_exp(&c, &e, prec, rnd) } else { fzero() };
    let s = if which != 1 { from_int_man_exp(&s, &e, prec, rnd) } else { fzero() };
    (c, s)
}

/// (c, s) turned by n quarter periods: n & 3 on a Python int.
fn quarter(n: Int, c: Int, s: Int) -> (Int, Int) {
    match n.divmod(&i(4)).1.to_i64() {
        Some(1) => (s.neg(), c),
        Some(2) => (c.neg(), s.neg()),
        Some(3) => (s, c.neg()),
        _ => (c, s),
    }
}

pub fn mpf_cos(x: &Mpf, prec: u64, rnd: Rnd) -> Mpf {
    mpf_cos_sin(x, prec, rnd, 1).0
}

pub fn mpf_sin(x: &Mpf, prec: u64, rnd: Rnd) -> Mpf {
    mpf_cos_sin(x, prec, rnd, 2).1
}

/// cos_sin_fixed(x, prec, pi2)
pub fn cos_sin_fixed(x: &Int, prec: i64, pi2: Option<&Int>) -> (Int, Int) {
    let pi2 = match pi2 {
        Some(p) => p.clone(),
        None => Int::from(pi_fixed(prec - 1)),
    };
    let (n, t) = x.divmod(&pi2);
    let (c, s) = cos_sin_basecase(&t, prec);
    quarter(n, c, s)
}

/// exp_fixed(x, prec, ln2)
pub fn exp_fixed(x: &Int, prec: i64, ln2: Option<&Int>) -> Int {
    let ln2 = match ln2 {
        Some(l) => l.clone(),
        None => Int::from(ln2_fixed(prec)),
    };
    let (n, t) = x.divmod(&ln2);
    let v = exp_basecase(&t, prec);
    match n.to_i64() {
        Some(k) if k >= 0 => v.shl(k as u64),
        Some(k) => v.shr(k.unsigned_abs()),
        None if n.is_neg() => if v.is_neg() { i(-1) } else { Int::zero() },
        None => {
            too_big();
            Int::zero()
        }
    }
}

/// mpf_pow(s, t, prec, rnd)
pub fn mpf_pow(s: &Mpf, t: &Mpf, prec: u64, rnd: Rnd) -> Mpf {
    if s.sign == 1 && t.exp.is_neg() {
        raise(Fail::ComplexResult);
        return fnan();
    }
    if !t.exp.is_neg() {
        let n = Int::new(t.sign == 1, t.man.shl(t.exp.as_shift()));
        return mpf_pow_int(s, &n, prec, rnd);
    }
    if t.exp.as_i64() == Some(-1) {
        if t.man.to_u64() == Some(1) {
            if t.sign == 1 {
                return mpf_div(&fone(), &mpf_sqrt(s, prec + 10, rnd.reciprocal()), prec, rnd);
            }
            return mpf_sqrt(s, prec, rnd);
        }
        if t.sign == 1 {
            let r = mpf_sqrt(s, prec + 10, rnd.reciprocal());
            return mpf_pow_int(&r, &Int::new(true, t.man.clone()), prec, rnd);
        }
        return mpf_pow_int(&mpf_sqrt(s, prec + 10, rnd), &Int::from(t.man.clone()), prec, rnd);
    }
    let c = mpf_log(s, prec + 10, rnd);
    mpf_exp(&mpf_mul(t, &c, 0, Rnd::Down), prec, rnd)
}

/// libmpc's mpc_exp(z, prec, rnd)
pub fn mpc_exp(z: &Mpc, prec: u64, rnd: Rnd) -> Mpc {
    let (a, b) = z;
    if *a == fzero() {
        return mpf_cos_sin(b, prec, rnd, 0);
    }
    if *b == fzero() {
        return (mpf_exp(a, prec, rnd), fzero());
    }
    let mag = mpf_exp(a, prec + 4, rnd);
    let (c, s) = mpf_cos_sin(b, prec + 4, rnd, 0);
    (mpf_mul(&mag, &c, prec, rnd), mpf_mul(&mag, &s, prec, rnd))
}

/// libmpc's mpc_sqrt(z, prec, rnd): the principal branch.
pub fn mpc_sqrt(z: &Mpc, prec: u64, rnd: Rnd) -> Mpc {
    let (a, b) = z;
    if *b == fzero() {
        if *a == fzero() {
            return (a.clone(), b.clone());
        }
        if a.sign == 1 {
            return (fzero(), mpf_sqrt(&mpf_neg(a), prec, rnd));
        }
        return (mpf_sqrt(a, prec, rnd), fzero());
    }
    let wp = prec + 20;
    let r = mpc_abs(z, wp, Rnd::Down);
    if a.sign == 0 {
        let t = mpf_add(&r, a, wp, Rnd::Down, false);
        let re = mpf_sqrt(&mpf_shift_i64(&t, -1), prec, rnd);
        let w = mpf_sqrt(&mpf_shift_i64(&t, 1), wp, Rnd::Down);
        (re, mpf_div(b, &w, prec, rnd))
    } else {
        let t = mpf_add(&r, a, wp, Rnd::Down, true);
        let im = mpf_sqrt(&mpf_shift_i64(&t, -1), prec, rnd);
        let w = mpf_sqrt(&mpf_shift_i64(&t, 1), wp, Rnd::Down);
        let re = mpf_div(b, &w, prec, rnd);
        if b.sign == 1 {
            (mpf_neg(&re), mpf_neg(&im))
        } else {
            (re, im)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cache_prec_steps_as_the_reference() {
        // cache_prec_steps = [22,22] + [min(2**k,2500)+20] * 2**(k-1) for k = 1..12
        let mut want = vec![22i64, 22];
        for k in 1..=12u32 {
            for _ in 0..(1i64 << (k - 1)) {
                want.push((1i64 << k).min(2500) + 20);
            }
        }
        for (p, w) in want.iter().enumerate().take(2501) {
            assert_eq!(cache_prec_step(p as i64), *w, "prec {}", p);
        }
    }
}
