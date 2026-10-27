//! Binomials x^k (a x^m + b) over Z, factored from their cyclotomic
//! structure without the modular phase (plan factor-binomial r3, frozen,
//! sha256 5ab250ce).  Textbook facts only (Lang, Algebra, VI section 3):
//!   * (F1) x^N - 1 = prod_{d | N} Phi_d, each Phi_d irreducible over Q;
//!   * (F2) x^m + 1 = prod_{d | 2m, d not dividing m} Phi_d;
//!   * (F3) for square-free r with primes P,
//!     Phi_r = prod_{S subset of P} (x^{r / prod S} - 1)^{(-1)^|S|};
//!   * (F4) Phi_{ps} Phi_s = Phi_s(x^p) for a prime p not dividing s, and
//!     Phi_d(x) = Phi_{rad d}(x^{d / rad d});
//!   * (F5) prod_{d | g} Phi_d(q y, p) = q^g y^g - p^g, with
//!     Phi_d(Y, Z) = Z^phi(d) Phi_d(Y / Z), for coprime p, q.
//!
//! Stage A (a = 1, b = +-1): each Phi_d is built by (F3) with sparse
//! products and exact divisions by x^e - 1, and every kernel is then proved
//! to be the true one by the chain identity (F4) (by induction on r, from
//! Phi_1 = x - 1), the outputs by a positional certificate, and the index
//! set by its distinctness, membership and total degree.  Stage B (|a| !=
//! |b|, of any size: plan rank 3 r3, 3.8): -b/a = (p/q)^g for the largest
//! g | m, by exact roots; then the pieces H_d = Phi_d(q x^h, p),
//! h = m/g, each proved coefficient by coefficient against the verified
//! Phi_d; for h = 1 they are irreducible, else they go through the general
//! square-free path with the same budget.
//!
//! Every stage preflights its work (an executable ledger over sizes, the
//! plan's section 4) and reserves its whole live memory before allocating,
//! then debits each step from the actual operand sizes (at most the
//! ledger's).  A failed verification is an error, never a result.

use super::*;
use num_integer::Roots;
use sagebrush_interrupt::{check, enter};

/// The factors of f (primitive, positive leading coefficient, degree >= 1)
/// with their multiplicities, when f = x^k (a x^m + b) is a binomial this
/// module handles; None for today's path.
pub(crate) fn factor<'b>(b: &'b Budget, f: &[BigInt]) -> FResult<Option<Vec<(Held<'b>, u32)>>> {
    // S1: the detection scan (two nonzero coefficients, the top one last)
    let (k, top) = {
        let _s = enter("binomial S1 scan");
        let (mut first, mut count) = (0usize, 0u32);
        for (i, c) in f.iter().enumerate() {
            if i & 1023 == 0 {
                check();
            }
            if !c.is_zero() {
                if count == 0 {
                    first = i;
                }
                count += 1;
                if count > 2 {
                    return Ok(None);
                }
            }
        }
        if count != 2 {
            return Ok(None);
        }
        (first, f.len() - 1)
    };
    let m = (top - k) as u64;
    let (a, c0) = (&f[top], &f[k]);
    let pieces = if a.is_one() && c0.abs().is_one() {
        stage_a(b, m, c0.is_positive())?
    } else {
        match stage_b(b, m, a, c0)? {
            Some(p) => p,
            None => return Ok(None),
        }
    };
    let mut out: Vec<(Held<'b>, u32)> = pieces.into_iter().map(|h| (h, 1)).collect();
    if k > 0 {
        out.push((Held::build(b, 2, 1, || vec![BigInt::zero(), BigInt::one()])?, k as u32));
    }
    Ok(Some(out))
}

/// A failed verification: an internal error, refused (never a result).
fn failed(b: &Budget, what: &'static str) -> FactorLimit {
    b.internal(what)
}

// ------------------------------------------------------------------ test faults

/// Faults the tests inject (plan r3, section 6 item 3), to see each
/// verification refuse (only the tests can set one).
pub(crate) mod fault {
    pub const KERNEL_COEFF: u8 = 1;
    pub const NOT_EXACT: u8 = 2;
    pub const DUPLICATE_INDEX: u8 = 3;
    pub const MISSING_INDEX: u8 = 4;
    pub const OUTPUT_POSITION: u8 = 5;
    pub const PIECE_COEFF: u8 = 6;
    pub const PIECE_POSITION: u8 = 7;

    #[cfg(test)]
    thread_local! {
        static FAULT: std::cell::Cell<u8> = const { std::cell::Cell::new(0) };
    }

    #[inline]
    pub fn is(_f: u8) -> bool {
        #[cfg(test)]
        {
            FAULT.with(|c| c.get() == _f)
        }
        #[cfg(not(test))]
        {
            false
        }
    }

    /// Run `run` with fault `f` injected.
    #[cfg(test)]
    pub fn with<T>(f: u8, run: impl FnOnce() -> T) -> T {
        struct Reset;
        impl Drop for Reset {
            fn drop(&mut self) {
                FAULT.with(|c| c.set(0));
            }
        }
        let _r = Reset;
        FAULT.with(|c| c.set(f));
        run()
    }
}

use fault::is as fault;

/// Stage B's executable-ledger audit (plan rank 3 r3, 3.8): each preflight
/// next to the units its section actually debited, from the last call on
/// this thread.
#[cfg(test)]
pub(crate) mod audit {
    #[derive(Clone, Copy, Debug, Default)]
    pub struct Audit {
        pub pp_preflight: u64,
        pub pp_used: u64,
        pub hom_preflight: u64,
        pub hom_used: u64,
    }

    thread_local! {
        static LAST: std::cell::Cell<Audit> = const { std::cell::Cell::new(Audit { pp_preflight: 0, pp_used: 0, hom_preflight: 0, hom_used: 0 }) };
    }

    pub fn set(f: impl FnOnce(&mut Audit)) {
        LAST.with(|c| {
            let mut a = c.get();
            f(&mut a);
            c.set(a)
        })
    }

    /// Clear, run, and return what the run recorded.
    pub fn during<T>(run: impl FnOnce() -> T) -> (T, Audit) {
        LAST.with(|c| c.set(Audit::default()));
        let r = run();
        (r, LAST.with(|c| c.get()))
    }
}

// ------------------------------------------------------------------ small integers

/// The divisors of n (increasing) and its primes (increasing), by one trial
/// division loop up to floor(sqrt n): one unit and one poll (site S2) per
/// trial, floor(sqrt n) + 1 units in all.
fn divisors_and_primes(b: &Budget, n: u64) -> FResult<(Vec<u64>, Vec<u64>)> {
    let _s = enter("binomial S2 enumeration");
    let s = n.sqrt();
    let (mut small, mut large, mut primes) = (vec![], vec![], vec![]);
    let mut rest = n;
    b.debit(Some(1))?;
    for j in 1..=s {
        b.debit(Some(1))?;
        if n % j == 0 {
            small.push(j);
            if j != n / j {
                large.push(n / j);
            }
        }
        if j >= 2 && rest % j == 0 {
            primes.push(j);
            while rest % j == 0 {
                rest /= j;
            }
        }
    }
    if rest > 1 {
        primes.push(rest);
    }
    small.extend(large.into_iter().rev());
    Ok((small, primes))
}

fn primes_of(d: u64, primes: &[u64]) -> Vec<u64> {
    primes.iter().copied().filter(|&p| d % p == 0).collect()
}

fn rad(d: u64, primes: &[u64]) -> u64 {
    primes_of(d, primes).iter().product()
}

fn phi(d: u64, primes: &[u64]) -> u64 {
    primes_of(d, primes).iter().fold(d, |acc, &p| acc / p * (p - 1))
}

// ------------------------------------------------------------------ the size ledger (plan r3, 4.1-4.2)

/// The construction of the kernel Phi_r by (F3): the exponents e of its
/// sparse products by x^e - 1 (|S| even, nonzero), then of its exact
/// divisions (|S| odd), in this fixed order.
fn kernel_steps(r: u64, ps: &[u64]) -> (Vec<u64>, Vec<u64>) {
    let k = ps.len();
    let (mut evens, mut odds) = (vec![], vec![]);
    for size in 1..=k {
        for mask in 1u32..(1 << k) {
            if mask.count_ones() as usize != size {
                continue;
            }
            let e = r / (0..k).filter(|i| mask >> i & 1 == 1).map(|i| ps[i]).product::<u64>();
            if size % 2 == 0 {
                evens.push(e);
            } else {
                odds.push(e);
            }
        }
    }
    (evens, odds)
}

/// Size bounds of a kernel's construction (no polynomials): its bits bound,
/// work and scratch (input and output of the largest step).
struct KernelPlan {
    bits: u64,
    work: u64,
    scratch: u64,
}

fn plan_kernel(r: u64, ps: &[u64]) -> Option<KernelPlan> {
    let (evens, odds) = kernel_steps(r, ps);
    let (mut l, mut bits, mut work, mut scratch) = (r.checked_add(1)?, 1u64, 0u64, 0u64);
    for e in evens {
        let (l2, b2) = (l.checked_add(e)?, bits.checked_add(1)?);
        work = work.checked_add(l2.checked_mul(limbs(b2))?)?;
        scratch = scratch.max(poly_bytes(l, bits)?.checked_add(poly_bytes(l2, b2)?)?);
        (l, bits) = (l2, b2);
    }
    for e in odds {
        let (l2, b2) = (l.checked_sub(e)?, bits.checked_add(clog2(l.div_ceil(e).checked_add(1)?))?);
        work = work.checked_add(l.checked_mul(limbs(b2))?)?;
        scratch = scratch.max(poly_bytes(l, bits)?.checked_add(poly_bytes(l2, b2)?)?);
        (l, bits) = (l2, b2);
    }
    Some(KernelPlan { bits, work, scratch })
}

/// The ledger of the cyclotomic stage for the index set ds (all of whose
/// kernels are ks, increasing): its total work and its memory parts.
pub(crate) struct CycloPlan {
    pub work: u64,
    pub kernel_bytes: u64,
    pub scratch_bytes: u64,
    pub output_bytes: Vec<u64>,
}

impl CycloPlan {
    #[cfg(test)]
    pub fn memory(&self) -> Option<u64> {
        self.output_bytes.iter().try_fold(self.kernel_bytes.checked_add(self.scratch_bytes)?, |acc, &x| acc.checked_add(x))
    }
}

pub(crate) fn plan_cyclotomics(ds: &[u64], ks: &[u64], primes: &[u64]) -> Option<CycloPlan> {
    let mut bits = Vec::with_capacity(ks.len());
    let (mut work, mut kernel_bytes, mut scratch) = (0u64, 0u64, 0u64);
    for &r in ks {
        let kp = plan_kernel(r, &primes_of(r, primes))?;
        work = work.checked_add(kp.work)?;
        kernel_bytes = kernel_bytes.checked_add(poly_bytes(phi(r, primes).checked_add(1)?, kp.bits)?)?;
        scratch = scratch.max(kp.scratch);
        bits.push(kp.bits);
    }
    let bits_of = |r: u64| ks.binary_search(&r).ok().map(|i| bits[i]);
    for &r in ks {
        if r == 1 {
            continue;
        }
        let p = *primes_of(r, primes).last()?;
        let s = r / p;
        let (br, bs) = (bits_of(r)?, bits_of(s)?);
        let (lr, ls) = (phi(r, primes).checked_add(1)?, phi(s, primes).checked_add(1)?);
        let n = lr.checked_add(ls)? - 1;
        let bprod = br.checked_add(bs)?.checked_add(clog2(lr.min(ls)))?.checked_add(1)?;
        work = work
            .checked_add(mul_work(lr, br, ls, bs)?)?
            .checked_add(n.checked_mul(limbs(bprod).checked_add(limbs(bs))?)?)?;
        scratch = scratch.max(poly_bytes(n, bprod)?.checked_add(poly_bytes(n, bs)?)?.checked_add(big_bytes(bprod)?.checked_mul(2)?)?);
    }
    let mut output_bytes = Vec::with_capacity(ds.len());
    for &d in ds {
        let bd = bits_of(rad(d, primes))?;
        let l = phi(d, primes).checked_add(1)?;
        // the substitution and its positional certificate
        work = work.checked_add(l.checked_mul(limbs(bd))?)?.checked_add(l.checked_mul(limbs(bd).checked_mul(2)?.checked_add(1)?)?)?;
        output_bytes.push(poly_bytes(l, bd)?);
    }
    Some(CycloPlan { work, kernel_bytes, scratch_bytes: scratch, output_bytes })
}

// ------------------------------------------------------------------ sparse arithmetic

/// a (x^e - 1): a shift and a subtraction (polls every 1024 coefficients,
/// site S4).
fn mul_binom(a: &[BigInt], e: usize) -> ZPoly {
    let mut out = vec![BigInt::zero(); a.len() + e];
    for (i, c) in a.iter().enumerate() {
        if i & 1023 == 0 {
            check();
        }
        if !c.is_zero() {
            out[i + e] += c;
            out[i] -= c;
        }
    }
    out
}

/// a / (x^e - 1) when exact, else None: the descending Euclidean recurrence
/// Q_i = A_{i+e} + Q_{i+e}, then the remainder R_i = A_i + Q_i (i < e),
/// computed, exact iff all zero (plan r3, CORR-BINOM-PLAN-2).
pub(crate) fn div_binom(a: &[BigInt], e: usize) -> Option<ZPoly> {
    let l = a.len();
    if e == 0 || l <= e {
        return None;
    }
    let lq = l - e;
    let mut q = vec![BigInt::zero(); lq];
    for i in (0..lq).rev() {
        if i & 1023 == 0 {
            check();
        }
        let mut t = a[i + e].clone();
        if i + e < lq {
            t += &q[i + e];
        }
        q[i] = t;
    }
    for i in 0..e {
        let r = if i < lq { &a[i] + &q[i] } else { a[i].clone() };
        if !r.is_zero() {
            return None;
        }
    }
    Some(q)
}

// ------------------------------------------------------------------ Stage A

/// x^m - 1 (plus = false) or x^m + 1 (plus = true): its cyclotomic factors.
fn stage_a<'b>(b: &'b Budget, m: u64, plus: bool) -> FResult<Vec<Held<'b>>> {
    let _p = b.enter(Phase::Cyclotomic);
    let n = if plus { m.checked_mul(2) } else { Some(m) };
    let n = n.ok_or_else(|| b.refuse("work (overflow)", u64::MAX, b.work_left()))?;
    let member = move |d: u64| if plus { (2 * m) % d == 0 && m % d != 0 } else { m % d == 0 };
    let (all, primes) = divisors_and_primes(b, n)?;
    let ds: Vec<u64> = all.into_iter().filter(|&d| member(d)).collect();
    Ok(cyclotomics(b, ds, m, &member, &primes)?.into_iter().map(|x| x.1).collect())
}

/// Phi_d for each d of ds (increasing), proved: the kernels by the chain
/// identity, the outputs by their positional certificate, the index set
/// (distinct, members, total degree `total`).  primes: those of the N
/// whose divisors ds are.
pub(crate) fn cyclotomics<'b>(
    b: &'b Budget,
    mut ds: Vec<u64>,
    total: u64,
    member: &dyn Fn(u64) -> bool,
    primes: &[u64],
) -> FResult<Vec<(u64, Held<'b>)>> {
    let _p = b.enter(Phase::Cyclotomic);
    if fault(fault::DUPLICATE_INDEX) && !ds.is_empty() {
        ds.insert(0, ds[0]);
    }
    if fault(fault::MISSING_INDEX) {
        ds.pop();
    }
    // the index set (astra's (a)): strictly increasing, members, sum phi = total
    {
        let _s = enter("binomial S2 enumeration");
        let mut sum = 0u64;
        for (i, &d) in ds.iter().enumerate() {
            check();
            if (i > 0 && ds[i - 1] >= d) || d == 0 || !member(d) {
                return Err(failed(b, "cyclotomic verification (index set)"));
            }
            sum = sum.saturating_add(phi(d, primes));
        }
        if sum != total {
            return Err(failed(b, "cyclotomic verification (index set)"));
        }
    }
    // the kernels: rad(d), closed under r -> r / maxprime(r)
    let ks: Vec<u64> = {
        let _s = enter("binomial S2 enumeration");
        let mut ks: Vec<u64> = vec![];
        for &d in &ds {
            let mut r = rad(d, primes);
            loop {
                b.debit(Some(1))?;
                if let Err(i) = ks.binary_search(&r) {
                    ks.insert(i, r);
                }
                if r == 1 {
                    break;
                }
                r /= primes_of(r, primes).last().copied().unwrap_or(r);
            }
        }
        ks
    };
    // the ledger, then the aggregate reservation, before any polynomial
    let plan = plan_cyclotomics(&ds, &ks, primes).ok_or_else(|| b.refuse("work (overflow)", u64::MAX, b.work_left()))?;
    if plan.work > b.work_left() {
        return Err(b.refuse("work", plan.work, b.work_left()));
    }
    let _kr = b.reserve(Some(plan.kernel_bytes))?;
    let _sr = b.reserve(Some(plan.scratch_bytes))?;
    let mut out_r = Vec::with_capacity(ds.len());
    for &x in &plan.output_bytes {
        out_r.push(Some(b.reserve(Some(x))?));
    }
    // the kernels, by (F3)
    let mut kernels: Vec<ZPoly> = Vec::with_capacity(ks.len());
    let mut divided = false;
    for &r in &ks {
        let _s = enter("cyclotomic S3 kernels");
        check();
        let ps = primes_of(r, primes);
        let (evens, odds) = kernel_steps(r, &ps);
        let mut a = vec![BigInt::zero(); r as usize + 1];
        a[0] = -BigInt::one();
        a[r as usize] = BigInt::one();
        for e in evens {
            b.debit((a.len() as u64).checked_add(e).and_then(|l| l.checked_mul(limbs(maxbits(&a) + 1))))?;
            let _s4 = enter("cyclotomic S4 sparse");
            a = mul_binom(&a, e as usize);
        }
        for e in odds {
            let l = a.len() as u64;
            b.debit(l.checked_mul(limbs(maxbits(&a) + clog2(l.div_ceil(e) + 1))))?;
            if fault(fault::NOT_EXACT) && !divided {
                a[0] += 1;
            }
            divided = true;
            let _s4 = enter("cyclotomic S4 sparse");
            a = div_binom(&a, e as usize).ok_or_else(|| failed(b, "cyclotomic verification (division)"))?;
        }
        if fault(fault::KERNEL_COEFF) && r > 1 && r == *ks.last().unwrap() {
            let mid = a.len() / 2;
            a[mid] += 1;
        }
        kernels.push(a);
    }
    // the proof: Phi_1 = x - 1, then Phi_r Phi_s = Phi_s(x^p) (F4), r = p s,
    // p = maxprime(r), by induction on r (ks increasing, closed)
    {
        let _s = enter("cyclotomic S5 verification");
        if ks[0] != 1 || kernels[0] != vec![-BigInt::one(), BigInt::one()] {
            return Err(failed(b, "cyclotomic verification (chain)"));
        }
        for (i, &r) in ks.iter().enumerate().skip(1) {
            let p = *primes_of(r, primes).last().unwrap();
            let j = ks.binary_search(&(r / p)).map_err(|_| failed(b, "cyclotomic verification (chain)"))?;
            let (fr, fs) = (&kernels[i], &kernels[j]);
            let (br, bs) = (maxbits(fr), maxbits(fs));
            let n = fr.len() + fs.len() - 1;
            let bprod = br + bs + clog2(fr.len().min(fs.len()) as u64) + 1;
            b.debit(mul_work(fr.len() as u64, br, fs.len() as u64, bs).and_then(|w| w.checked_add((n as u64).checked_mul(limbs(bprod) + limbs(bs))?)))?;
            let mut prod = vec![BigInt::zero(); n];
            for (x, u) in fr.iter().enumerate() {
                check();
                if u.is_zero() {
                    continue;
                }
                for (y, w) in fs.iter().enumerate() {
                    prod[x + y] += u * w;
                }
            }
            if (fs.len() - 1) * p as usize + 1 != n {
                return Err(failed(b, "cyclotomic verification (chain)"));
            }
            let mut sub = vec![BigInt::zero(); n];
            for (y, w) in fs.iter().enumerate() {
                sub[y * p as usize] = w.clone();
            }
            for t in 0..n {
                if t & 1023 == 0 {
                    check();
                }
                if prod[t] != sub[t] {
                    return Err(failed(b, "cyclotomic verification (chain)"));
                }
            }
        }
    }
    // the outputs Phi_d(x) = Phi_{rad d}(x^{d / rad d}), each checked
    // position by position
    let zero = BigInt::zero();
    let mut out = Vec::with_capacity(ds.len());
    for (i, &d) in ds.iter().enumerate() {
        let _s = enter("cyclotomic S6 outputs");
        let r = rad(d, primes);
        let ker = &kernels[ks.binary_search(&r).unwrap()];
        let k = (d / r) as usize;
        let l = phi(d, primes) as u64 + 1;
        let bk = limbs(maxbits(ker));
        b.debit(l.checked_mul(bk).and_then(|x| x.checked_add(l.checked_mul(bk.checked_mul(2)? + 1)?)))?;
        let mut v = vec![BigInt::zero(); (ker.len() - 1) * k + 1];
        for (j, c) in ker.iter().enumerate() {
            if j & 1023 == 0 {
                check();
            }
            v[j * k] = c.clone();
        }
        if fault(fault::OUTPUT_POSITION) && k > 1 {
            v[1] = BigInt::one();
        }
        // the positional certificate
        if v.len() as u64 != l {
            return Err(failed(b, "cyclotomic verification (output)"));
        }
        for (t, c) in v.iter().enumerate() {
            if t & 1023 == 0 {
                check();
            }
            let want = if t % k == 0 { &ker[t / k] } else { &zero };
            if c != want {
                return Err(failed(b, "cyclotomic verification (output)"));
            }
        }
        out.push((d, Held { v, _r: out_r[i].take().unwrap() }));
    }
    Ok(out)
}

// ------------------------------------------------------------------ Stage B

/// The work ledger U of the perfect-power search (plan r3, 4.3).
fn plan_powers(bits: u64, m: u64, primes: &[u64]) -> Option<u64> {
    let lb = limbs(bits);
    let mut u = 0u64;
    for &l in primes {
        let mut v = 0u64;
        let mut t = m;
        while t % l == 0 {
            t /= l;
            v += 1;
        }
        let steps = bits.div_ceil(l - 1).checked_add(v)?.checked_add(1)?;
        u = u.checked_add(steps.checked_mul(2 * clog2(l) + 1)?.checked_mul(lb.checked_mul(lb)?)?)?;
    }
    u.checked_mul(2)?.checked_add(m.sqrt().checked_mul(2)?)
}

/// Whether c^l <= n, and whether it is equal: square-and-multiply, stopping
/// as soon as a partial power exceeds n (operands stay at most bits(n)
/// bits); one debit and one poll (site S7) per product.
fn pow_cmp(b: &Budget, c: &BigInt, l: u64, n: &BigInt) -> FResult<Option<bool>> {
    let mut result = BigInt::one();
    let mut base = c.clone();
    let mut e = l;
    loop {
        if e & 1 == 1 {
            b.debit(limbs(result.bits()).checked_mul(limbs(base.bits())))?;
            result *= &base;
            if &result > n {
                return Ok(None);
            }
        }
        e >>= 1;
        if e == 0 {
            return Ok(Some(&result == n));
        }
        b.debit(limbs(base.bits()).checked_mul(limbs(base.bits())))?;
        base = &base * &base;
        if &base > n {
            // the remaining factors are at least base
            return Ok(None);
        }
    }
}

/// The l-th root of n >= 1 when n is an l-th power: bisection over the
/// root's ceil(B / l) bits, high bit first (plan r3, 3.2).
fn exact_root(b: &Budget, n: &BigInt, l: u64) -> FResult<Option<BigInt>> {
    if n.is_one() {
        return Ok(Some(BigInt::one()));
    }
    let bits = n.bits();
    if l > bits {
        return Ok(None);
    }
    let mut t = BigInt::zero();
    let mut exact = false;
    for bit in (0..bits.div_ceil(l)).rev() {
        check();
        let cand = &t | (BigInt::one() << bit);
        if let Some(eq) = pow_cmp(b, &cand, l, n)? {
            t = cand;
            exact = eq;
        }
    }
    Ok(if exact { Some(t) } else { None })
}

/// One piece's sizes and unit costs (plan r3, 4.4), every one in checked
/// arithmetic: the ledger sums them, and the build and the certificate
/// debit exactly these (a coefficient's c_i is at most the piece's c bits).
/// None on overflow, which is a refusal, never a wrap (plan rank 3 r3, 3.8).
struct PieceCost {
    /// phi(d) beta: the bits of p^phi
    fb: u64,
    /// the bits of a piece coefficient: c + fb + 1
    bh: u64,
    /// the piece's length, phi h + 1
    len: u64,
    /// p^phi by square-and-multiply
    pw: u64,
    /// one coefficient of the build
    build: u64,
    /// one coefficient of the certificate
    cert: u64,
}

fn piece_cost(ph: u64, c: u64, beta: u64, h: u64) -> Option<PieceCost> {
    let fb = ph.checked_mul(beta)?;
    let bh = c.checked_add(fb)?.checked_add(1)?;
    let len = ph.checked_mul(h)?.checked_add(1)?;
    let (lb, lfb) = (limbs(beta), limbs(fb));
    let pw = clog2(ph.checked_add(1)?).checked_mul(2)?.checked_mul(lfb.checked_mul(lfb)?)?;
    let build = limbs(c).checked_add(lb.checked_mul(3)?)?.checked_mul(limbs(bh))?;
    let cert = [lb.checked_mul(2)?.checked_mul(lfb)?, limbs(bh).checked_mul(lfb)?, limbs(c).checked_mul(lfb)?, limbs(c.checked_add(fb)?).checked_mul(lfb)?, limbs(fb.checked_mul(2)?.checked_add(c)?.checked_add(1)?)]
        .into_iter()
        .try_fold(0u64, |s, x| s.checked_add(x))?;
    Some(PieceCost { fb, bh, len, pw, build, cert })
}

/// p^phi for any u64 exponent: no u32 cutoff (plan rank 3 r3, 3.6); its
/// work and room are the piece's, preflighted and reserved by the caller.
fn phi_power(p: &BigInt, ph: u64) -> BigInt {
    pow_u64(p, ph, 32)
}

/// a x^m + b with |a| != |b|: the pieces Phi_d(q x^h, p), proved, either
/// final (h = 1) or factored by the general path (h > 1); None when g = 1.
fn stage_b<'b>(b: &'b Budget, m: u64, a: &BigInt, c0: &BigInt) -> FResult<Option<Vec<Held<'b>>>> {
    // the perfect-power search: the original a, b are not modified
    #[cfg(test)]
    let pp_start = b.work_left();
    let (g, p, q) = {
        let _p = b.enter(Phase::PerfectPower);
        let (u0, v0) = (-c0.clone(), a.clone());
        let bits = u0.bits().max(v0.bits());
        let (_, primes) = divisors_and_primes(b, m)?;
        let need = plan_powers(bits, m, &primes).ok_or_else(|| b.refuse("work (overflow)", u64::MAX, b.work_left()))?;
        if need > b.work_left() {
            return Err(b.refuse("work", need, b.work_left()));
        }
        #[cfg(test)]
        audit::set(|a| a.pp_preflight = need);
        let _r = b.reserve(big_bytes(bits.checked_mul(2).and_then(|x| x.checked_add(64)).unwrap_or(u64::MAX)).and_then(|x| x.checked_mul(4)?.checked_add(big_bytes(bits)?.checked_mul(2)?)))?;
        let _s = enter("perfect power S7");
        let (mut u, mut v, mut g) = (u0, v0, 1u64);
        for &l in &primes {
            let mut t = m;
            while t % l == 0 {
                t /= l;
                check();
                if u.is_negative() && l == 2 {
                    break;
                }
                let Some(ru) = exact_root(b, &u.abs(), l)? else { break };
                let Some(rv) = exact_root(b, &v, l)? else { break };
                u = if u.is_negative() { -ru } else { ru };
                v = rv;
                g *= l;
            }
        }
        (g, u, v)
    };
    #[cfg(test)]
    audit::set(|a| a.pp_used = pp_start - b.work_left());
    if g == 1 {
        return Ok(None);
    }
    let h = (m / g) as usize;
    // Phi_d for every d | g, by Stage A's construction and proof
    let (ds, primes) = divisors_and_primes(b, g)?;
    let phis = cyclotomics(b, ds, g, &|d| g % d == 0, &primes)?;
    let _p = b.enter(Phase::Homogenize);
    let beta = p.bits().max(q.bits());
    // the ledger: build and certificate (plan r3, 4.4), from the actual Phi_d
    // the ledger's per-piece costs, one PieceCost per Phi_d at a known
    // capacity: reserved before they are allocated and held until the
    // certificate ends (CORR-R3-BIN5-1)
    let costs_r = b.reserve_as("piece costs", (phis.len() as u64).checked_mul(std::mem::size_of::<PieceCost>() as u64))?;
    let ledger = || -> Option<(u64, Vec<u64>, u64, Vec<PieceCost>)> {
        // (the build's scratch and the certificate's, both reserved: plan
        // r3, 4.4)
        let mut costs = {
            let _t = crate::budget::tag("piece costs");
            Vec::with_capacity(phis.len())
        };
        let (mut work, mut out, mut build, mut cert) = (0u64, vec![], 0u64, 0u64);
        for (_, f) in &phis {
            let ph = (f.len() - 1) as u64;
            let c = maxbits(f);
            let k = piece_cost(ph, c, beta, h as u64)?;
            // build: p^phi, then per coefficient
            work = work.checked_add(k.pw)?.checked_add(ph.checked_add(1)?.checked_mul(k.build)?)?;
            // certificate: the zero scan, p^phi, then per coefficient
            work = work.checked_add(k.pw)?.checked_add(ph.checked_add(1)?.checked_mul(k.cert)?)?.checked_add(k.len)?;
            out.push(poly_bytes(k.len, k.bh)?);
            build = build.max(big_bytes(k.fb.checked_add(c)?.checked_add(64)?)?.checked_mul(3)?);
            cert = cert.max(big_bytes(k.fb.checked_mul(2)?.checked_add(c)?.checked_add(64)?)?.checked_mul(6)?);
            costs.push(k);
        }
        Some((work, out, build.checked_add(cert)?, costs))
    };
    let (work, out_bytes, scratch, costs) = ledger().ok_or_else(|| b.refuse("work (overflow)", u64::MAX, b.work_left()))?;
    if work > b.work_left() {
        return Err(b.refuse("work", work, b.work_left()));
    }
    #[cfg(test)]
    let hom_start = b.work_left();
    #[cfg(test)]
    audit::set(|a| a.hom_preflight = work);
    let _sr = b.reserve(Some(scratch))?;
    let mut out_r = Vec::with_capacity(out_bytes.len());
    for &x in &out_bytes {
        out_r.push(Some(b.reserve(Some(x))?));
    }
    // build H_d: coefficient i is c_i q^i p^(phi - i), with T descending
    // (T_0 = p^phi, T_{i+1} = (T_i / p) q, exact)
    let mut pieces: Vec<Held<'b>> = Vec::with_capacity(phis.len());
    for (i, (_, f)) in phis.iter().enumerate() {
        let _s = enter("homogenize S8");
        let ph = f.len() - 1;
        let k = &costs[i];
        b.debit(Some(k.pw))?;
        let mut t = phi_power(&p, ph as u64);
        // (the length's room is reserved: a size beyond the address space
        // is refused, never narrowed)
        let len = usize::try_from(k.len).map_err(|_| b.refuse("memory (overflow)", u64::MAX, 0))?;
        let mut v = vec![BigInt::zero(); len];
        for (j, cj) in f.iter().enumerate() {
            b.debit(Some(k.build))?;
            v[j * h] = cj * &t;
            if j < ph {
                t = &t / &p * &q;
            }
        }
        if fault(fault::PIECE_COEFF) && ph >= 2 {
            v[h] += 1;
        }
        if fault(fault::PIECE_POSITION) && h > 1 && v.len() > 1 {
            v[1] = BigInt::one();
        }
        pieces.push(Held { v, _r: out_r[i].take().unwrap() });
    }
    phis_certify(b, &phis, &pieces, &p, &q, h, &costs)?;
    #[cfg(test)]
    audit::set(|a| a.hom_used = hom_start - b.work_left());
    drop(costs);
    drop(costs_r);
    drop(phis);
    if h == 1 {
        return Ok(Some(pieces));
    }
    // h > 1: each piece through the general square-free path (no re-dispatch)
    let mut out = vec![];
    for piece in pieces {
        let _s = enter("homogenize S9 pieces");
        check();
        out.extend(factor_squarefree(b, &piece)?);
    }
    Ok(Some(out))
}

/// The coefficient certificate (plan r3, CORR-BINOM-PLAN-1): for every
/// piece, its length is phi h + 1, its coefficients off multiples of h are
/// zero, and eta_i p^i = c_i q^i p^phi for every i, with P_i = p^i and
/// Q_i = q^i ascending (independent of the build's descending T).  As p !=
/// 0 this forces H_d = Phi_d(q x^h, p) exactly.
fn phis_certify(b: &Budget, phis: &[(u64, Held)], pieces: &[Held], p: &BigInt, q: &BigInt, h: usize, costs: &[PieceCost]) -> FResult<()> {
    let _s = enter("homogenize S10 certificate");
    for (((_, f), piece), k) in phis.iter().zip(pieces).zip(costs) {
        let ph = f.len() - 1;
        b.debit(Some(k.len))?;
        if piece.len() as u64 != k.len {
            return Err(failed(b, "binomial verification"));
        }
        for (t, x) in piece.iter().enumerate() {
            if t & 1023 == 0 {
                check();
            }
            if t % h != 0 && !x.is_zero() {
                return Err(failed(b, "binomial verification"));
            }
        }
        b.debit(Some(k.pw))?;
        let pphi = phi_power(p, ph as u64);
        let (mut pi, mut qi) = (BigInt::one(), BigInt::one());
        for (i, ci) in f.iter().enumerate() {
            b.debit(Some(k.cert))?;
            let lhs = &piece[i * h] * &pi;
            let rhs = ci * &qi * &pphi;
            if lhs != rhs {
                return Err(failed(b, "binomial verification"));
            }
            pi *= p;
            qi *= q;
        }
    }
    Ok(())
}

#[cfg(test)]
#[path = "binomial_tests.rs"]
mod tests;
