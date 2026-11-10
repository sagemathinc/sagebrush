//! The core's call interface, host-independent (src/wasm.rs exports it to
//! WebAssembly; tests call it natively): a few operand registers, the
//! operations python's overlay hooks, by code, and their results, read back
//! inline when small, else as limbs (design/mpmath-core.md §4.5, §4.6: the
//! hybrid number, whose big form the runtime keeps JS-side as packed limbs:
//! the core holds no number between calls).
//!
//! Numbers cross as f64s when exact (a mantissa below 2^53, an exponent of
//! magnitude below 2^53) and as u64 limbs in the IO buffer otherwise.
//!
//! A call's outcome is a count of results (>= 0) or a failure code (< 0, see
//! `code`); a failure leaves no result and nothing allocated for the call.

use crate::consts::{e_fixed, ln2_fixed, pi_fixed};
use crate::elefun;
use crate::fail::checked;
use crate::exp::Exp;
use crate::int::Int;
use crate::intmath::sqrtrem_python;
use crate::kernel::{self, Sm};
use crate::mpc::{self, Mpc};
use crate::mpf::{self, Mpf, Rnd};
use crate::nat::Nat;
use crate::Fail;
use std::cell::RefCell;

/// 2^53: the bound of what an f64 holds exactly.
pub const EXACT: f64 = 9007199254740992.0;
/// libintmath's MAX_FACTORIAL_CACHE: ifac's memo keeps n! up to here.
const MAX_FACTORIAL_CACHE: i64 = 1000;

/// The failure codes (negative outcomes).
pub mod code {
    pub const LIMIT: i32 = -1;
    pub const MEMORY: i32 = -2;
    pub const ZERO_DIVISION: i32 = -3;
    pub const COMPLEX_RESULT: i32 = -4;
    pub const KEY_ERROR: i32 = -5;
    pub const BAD_CALL: i32 = -7;
}

/// The operations, by code.
pub mod op {
    pub const ADD: i32 = 1;
    pub const SUB: i32 = 2;
    pub const MUL: i32 = 3;
    pub const DIV: i32 = 4;
    pub const SQRT: i32 = 5;
    pub const EXP: i32 = 6;
    pub const LOG: i32 = 7;
    pub const COS: i32 = 8;
    pub const SIN: i32 = 9;
    pub const POW: i32 = 10;
    pub const NORMALIZE: i32 = 11;
    pub const NORMALIZE1: i32 = 12;
    pub const FROM_MAN_EXP: i32 = 13;
    pub const MPC_EXP: i32 = 14;
    pub const MPC_SQRT: i32 = 15;
    pub const EXP_FIXED: i32 = 16;
    pub const COS_SIN_FIXED: i32 = 17;
    pub const LOG_INT_FIXED: i32 = 18;
    pub const PI_FIXED: i32 = 19;
    pub const LN2_FIXED: i32 = 20;
    pub const E_FIXED: i32 = 21;
    pub const BITCOUNT: i32 = 22;
    pub const TRAILING: i32 = 23;
    pub const ISQRT: i32 = 24;
    pub const SQRTREM: i32 = 25;
    pub const IFAC: i32 = 26;
    pub const MPC_MUL: i32 = 27;
    pub const MPC_DIV: i32 = 28;
    pub const MPC_ABS: i32 = 29;
    pub const MPF_GAMMA: i32 = 30;
}

/// A register's or a result's value.
#[derive(Clone, Debug, Default, PartialEq)]
pub enum Val {
    #[default]
    None,
    F(Mpf),
    I(Int),
}

/// The session's state: registers, results, the IO buffer.
pub struct Core {
    pub regs: [Val; 4],
    pub out: [Val; 2],
    /// Limbs in and out (the host's view of it is in linear memory).
    pub io: Vec<u64>,
    /// Scalars out: a small result's fields, a big one's header, a failure's detail.
    pub res: [f64; 8],
    /// len(ifac's memo): it starts {0: 1, 1: 1}.
    ifac_len: i64,
}

impl Core {
    pub const fn new() -> Core {
        Core { regs: [Val::None, Val::None, Val::None, Val::None], out: [Val::None, Val::None], io: Vec::new(), res: [0.0; 8], ifac_len: 2 }
    }
}

impl Default for Core {
    fn default() -> Core {
        Core::new()
    }
}

thread_local! {
    pub static CORE: RefCell<Core> = const { RefCell::new(Core::new()) };
}

/// Run f on the session's core.  (The module has no callbacks and one
/// thread, so the core is never borrowed twice; were it, the call would get
/// R's default, never a panic, whose formatting the module would carry.)
pub fn with<R: Default>(f: impl FnOnce(&mut Core) -> R) -> R {
    CORE.try_with(|c| c.try_borrow_mut().map(|mut b| f(&mut b)).unwrap_or_default()).unwrap_or_default()
}

fn small_exp(e: f64) -> Option<i64> {
    (e.fract() == 0.0 && e.abs() < EXACT).then_some(e as i64)
}

fn small_man(m: f64) -> Option<u64> {
    (m.fract() == 0.0 && (0.0..EXACT).contains(&m)).then_some(m as u64)
}

/// The failure's code, its detail in res[0].
fn fail(c: &mut Core, f: Fail) -> i32 {
    match f {
        Fail::Limit { limbs } => {
            c.res[0] = limbs as f64;
            code::LIMIT
        }
        Fail::Memory { bytes } => {
            c.res[0] = bytes as f64;
            code::MEMORY
        }
        Fail::ZeroDivision => code::ZERO_DIVISION,
        Fail::ComplexResult => code::COMPLEX_RESULT,
        Fail::KeyError => code::KEY_ERROR,
    }
}

impl Core {
    /// Forget everything: the session's end (its caches and memos).
    pub fn reset(&mut self) {
        *self = Core::default();
        elefun::reset();
    }

    /// The IO buffer with room for n limbs, or None (refused).
    pub fn io_reserve(&mut self, n: usize) -> Option<&mut Vec<u64>> {
        if self.io.len() < n {
            let more = n - self.io.len();
            self.io.try_reserve_exact(more).ok()?;
            self.io.resize(n, 0);
        }
        Some(&mut self.io)
    }

    fn io_nat(&self, at: usize, n: usize) -> Result<Nat, Fail> {
        let src = self.io.get(at..at + n).ok_or(Fail::Limit { limbs: n as u64 })?;
        checked(|| Nat::from_limbs(src))
    }

    // ---- loading operands

    /// A binary mpf operation on two operands, each inline (its limb count
    /// 0) or packed: a's limbs first in the IO buffer, then b's.  The
    /// outcome: 0, the result inline in res[0..4]; 1, by limbs (out); < 0, a
    /// failure (code).  The hosts' mp_bin.
    #[allow(clippy::too_many_arguments)]
    pub fn bin(&mut self, op: i32, prec: f64, rnd: i32, asign: u32, aman: f64, aexp: f64, abc: f64, an: usize, bsign: u32, bman: f64, bexp: f64, bbc: f64, bn: usize) -> i32 {
        // (two inline operands: the kernel fast path, no allocation, when it applies)
        if an == 0 && bn == 0 {
            if let Some(r) = self.kernel(op, prec, rnd, asign, aman, aexp, abc, bsign, bman, bexp, bbc) {
                return r;
            }
        }
        let e = self.operand(0, asign, aman, aexp, abc, 0, an);
        if e < 0 {
            return e;
        }
        let e = self.operand(1, bsign, bman, bexp, bbc, an, bn);
        if e < 0 {
            return e;
        }
        match self.run(op, prec, rnd) {
            n if n < 0 => n,
            _ => self.out(0),
        }
    }

    /// An mpf whose fields are exact f64s.
    pub fn set_f(&mut self, r: usize, sign: u32, man: f64, exp: f64, bc: f64) -> i32 {
        match (small_man(man), small_exp(exp), small_exp(bc)) {
            (Some(m), Some(e), Some(b)) if r < 4 => {
                self.regs[r] = Val::F(Mpf { sign, man: Nat::from_u64(m), exp: Exp::S(e), bc: b });
                0
            }
            _ => code::BAD_CALL,
        }
    }

    /// An mpf from the IO buffer: nman limbs of mantissa, then (if nexp > 0)
    /// nexp limbs of exponent magnitude, negative if expneg; else exp.
    pub fn set_fx(&mut self, r: usize, sign: u32, nman: usize, exp: f64, bc: f64, nexp: usize, expneg: bool) -> i32 {
        let man = match self.io_nat(0, nman) {
            Ok(m) => m,
            Err(f) => return fail(self, f),
        };
        let exp = if nexp > 0 {
            match self.io_nat(nman, nexp) {
                Ok(m) => Exp::from_parts(expneg, m),
                Err(f) => return fail(self, f),
            }
        } else {
            match small_exp(exp) {
                Some(e) => Exp::S(e),
                None => return code::BAD_CALL,
            }
        };
        match small_exp(bc) {
            Some(b) if r < 4 => {
                self.regs[r] = Val::F(Mpf { sign, man, exp, bc: b });
                0
            }
            _ => code::BAD_CALL,
        }
    }

    /// An int that is an exact f64.
    pub fn set_i(&mut self, r: usize, v: f64) -> i32 {
        if r >= 4 || v.fract() != 0.0 || v.abs() >= EXACT {
            return code::BAD_CALL;
        }
        self.regs[r] = Val::I(Int::from_i64(v as i64));
        0
    }

    /// An int of n limbs from the IO buffer.
    pub fn set_ix(&mut self, r: usize, neg: bool, n: usize) -> i32 {
        match self.io_nat(0, n) {
            Ok(m) if r < 4 => {
                self.regs[r] = Val::I(Int::new(neg, m));
                0
            }
            Ok(_) => code::BAD_CALL,
            Err(f) => fail(self, f),
        }
    }

    pub fn set_none(&mut self, r: usize) {
        if r < 4 {
            self.regs[r] = Val::None;
        }
    }

    // ---- results

    /// Write out result k: an mpf inline (0: res = sign, man, exp, bc), an
    /// mpf by limbs (1: res = sign, nman, exp, bc, nexp, expneg; man then
    /// exp limbs in io), an int inline (2: res[0]), an int by limbs (3: res
    /// = neg, n; limbs in io), nothing (4); or a failure (no room for the
    /// limbs).
    pub fn out(&mut self, k: usize) -> i32 {
        let v = match self.out.get(k) {
            Some(v) => v.clone(),
            None => return code::BAD_CALL,
        };
        match v {
            Val::None => 4,
            Val::F(m) => {
                if let Some(r) = self.inline(&m) {
                    self.res[..4].copy_from_slice(&r);
                    return 0;
                }
                // (an exponent crosses as an f64 only when exact: |e| < 2^53)
                let (nman, exp_limbs) = (m.man.len(), match &m.exp {
                    Exp::S(e) if (e.unsigned_abs() as f64) < EXACT => None,
                    Exp::S(e) => Some((*e < 0, vec![e.unsigned_abs()])),
                    Exp::B { neg, mag } => Some((*neg, mag.limbs())),
                });
                let nexp = exp_limbs.as_ref().map_or(0, |e| e.1.len());
                let Some(io) = self.io_reserve(nman + nexp) else {
                    return fail(self, Fail::Memory { bytes: 8 * (nman + nexp) as u64 });
                };
                io[..nman].copy_from_slice(&m.man.limbs());
                if let Some((_, e)) = &exp_limbs {
                    io[nman..nman + nexp].copy_from_slice(e);
                }
                self.res[..6].copy_from_slice(&[
                    m.sign as f64,
                    nman as f64,
                    match m.exp {
                        Exp::S(e) if (e.unsigned_abs() as f64) < EXACT => e as f64,
                        _ => 0.0,
                    },
                    m.bc as f64,
                    nexp as f64,
                    exp_limbs.map_or(0.0, |e| e.0 as u8 as f64),
                ]);
                1
            }
            Val::I(i) => {
                if let Some(x) = i.to_i64().filter(|x| (x.unsigned_abs() as f64) < EXACT) {
                    self.res[0] = x as f64;
                    return 2;
                }
                let n = i.mag.len();
                let Some(io) = self.io_reserve(n) else {
                    return fail(self, Fail::Memory { bytes: 8 * n as u64 });
                };
                io[..n].copy_from_slice(&i.mag.limbs());
                self.res[0] = i.is_neg() as u8 as f64;
                self.res[1] = n as f64;
                3
            }
        }
    }

    /// A fused binary operation on two inline operands by the kernel fast
    /// path (kernel.rs): Some of out()'s outcome (0, the result inline in
    /// res; 1, by limbs); None where the kernel doesn't apply (the general
    /// path then runs).
    #[allow(clippy::too_many_arguments)]
    pub fn kernel(&mut self, op: i32, prec: f64, rnd: i32, asg: u32, am: f64, ae: f64, ab: f64, bsg: u32, bm: f64, be: f64, bb: f64) -> Option<i32> {
        let sm = |sign: u32, m: f64, e: f64, b: f64| Some(Sm { sign, man: small_man(m)? as u128, exp: small_exp(e)?, bc: small_exp(b)? });
        let (a, b) = (sm(asg, am, ae, ab)?, sm(bsg, bm, be, bb)?);
        let rnd = Rnd::from_code(rnd as u32)?;
        if !(prec >= 0.0 && prec.fract() == 0.0 && prec < EXACT) {
            return None;
        }
        let prec = prec as u64;
        let r = match op {
            op::ADD | op::SUB => kernel::add(a, b, prec, rnd, op == op::SUB)?,
            op::MUL => kernel::mul(a, b, prec, rnd)?,
            _ => return None,
        };
        let m = r.mpf();
        if let Some(v) = self.inline(&m) {
            self.res[..4].copy_from_slice(&v);
            return Some(0);
        }
        self.out = [Val::F(m), Val::None];
        Some(self.out(0))
    }

    /// Register r := an operand of a fused call: inline (n = 0: sign, man,
    /// exp, bc exact f64s) or packed (n limbs of mantissa in the IO buffer
    /// from limb `at`), the runtime's own big form, so it is checked to be
    /// canonical: the top limb nonzero, bc its bit length, the exponent exact
    /// (a malformed one is refused, never read past).
    pub fn operand(&mut self, r: usize, sign: u32, man: f64, exp: f64, bc: f64, at: usize, n: usize) -> i32 {
        if n == 0 {
            return self.set_f(r, sign, man, exp, bc);
        }
        let m = match self.io_nat(at, n) {
            Ok(m) => m,
            Err(f) => return fail(self, f),
        };
        match (small_exp(exp), small_exp(bc)) {
            (Some(e), Some(b)) if r < 4 && sign <= 1 && m.len() == n && m.bits() as i64 == b => {
                self.regs[r] = Val::F(Mpf { sign, man: m, exp: Exp::S(e), bc: b });
                0
            }
            _ => code::BAD_CALL,
        }
    }

    /// The fields of m as exact f64s, if they are (the hybrid number's inline form).
    pub fn inline(&self, m: &Mpf) -> Option<[f64; 4]> {
        let man = m.man.to_u64().filter(|&x| (x as f64) < EXACT)?;
        let exp = match m.exp {
            Exp::S(e) if (e.unsigned_abs() as f64) < EXACT => e,
            _ => return None,
        };
        Some([m.sign as f64, man as f64, exp as f64, m.bc as f64])
    }

    // ---- operations

    fn f(&self, r: usize) -> Result<&Mpf, Fail> {
        match &self.regs[r] {
            Val::F(m) => Ok(m),
            _ => Err(Fail::KeyError),
        }
    }

    fn i(&self, r: usize) -> Result<&Int, Fail> {
        match &self.regs[r] {
            Val::I(i) => Ok(i),
            _ => Err(Fail::KeyError),
        }
    }

    fn opt_i(&self, r: usize) -> Option<&Int> {
        match &self.regs[r] {
            Val::I(i) => Some(i),
            _ => None,
        }
    }

    /// Run operation `op` on the registers; its results in `out`.
    pub fn run(&mut self, op: i32, prec: f64, rnd: i32) -> i32 {
        self.out = Default::default();
        let Some(rnd_v) = Rnd::from_code(rnd as u32) else { return code::BAD_CALL };
        // (a precision is a non-negative int below 2^53; 0 is mpmath's exact)
        if !(prec >= 0.0 && prec.fract() == 0.0 && prec < EXACT) {
            return code::BAD_CALL;
        }
        // (the operation's own failure is sticky, fail.rs; a register of the
        // wrong kind is the dispatch's)
        match checked(|| self.dispatch(op, prec as u64, rnd_v, rnd)) {
            Ok(Ok(n)) => n,
            Ok(Err(f)) | Err(f) => {
                self.out = Default::default();
                fail(self, f)
            }
        }
    }

    fn put(&mut self, v: Val) -> Result<i32, Fail> {
        self.out[0] = v;
        Ok(1)
    }

    fn put2(&mut self, a: Val, b: Val) -> Result<i32, Fail> {
        self.out = [a, b];
        Ok(2)
    }

    fn dispatch(&mut self, op: i32, prec: u64, rnd: Rnd, flag: i32) -> Result<i32, Fail> {
        let p = prec as i64;
        match op {
            op::ADD | op::SUB => {
                let r = mpf::mpf_add(self.f(0)?, self.f(1)?, prec, rnd, op == op::SUB);
                self.put(Val::F(r))
            }
            op::MUL => {
                let r = mpf::mpf_mul(self.f(0)?, self.f(1)?, prec, rnd);
                self.put(Val::F(r))
            }
            op::DIV => {
                let r = mpf::mpf_div(self.f(0)?, self.f(1)?, prec, rnd);
                self.put(Val::F(r))
            }
            op::SQRT => {
                let r = mpf::mpf_sqrt(self.f(0)?, prec, rnd);
                self.put(Val::F(r))
            }
            op::EXP => {
                let r = elefun::mpf_exp(self.f(0)?, prec, rnd);
                self.put(Val::F(r))
            }
            op::LOG => {
                let r = elefun::mpf_log(self.f(0)?, prec, rnd);
                self.put(Val::F(r))
            }
            op::COS => {
                let r = elefun::mpf_cos(self.f(0)?, prec, rnd);
                self.put(Val::F(r))
            }
            op::SIN => {
                let r = elefun::mpf_sin(self.f(0)?, prec, rnd);
                self.put(Val::F(r))
            }
            op::POW => {
                let r = elefun::mpf_pow(self.f(0)?, self.f(1)?, prec, rnd);
                self.put(Val::F(r))
            }
            op::NORMALIZE | op::NORMALIZE1 => {
                let s = self.f(0)?.clone();
                let r = if op == op::NORMALIZE {
                    mpf::normalize(s.sign, s.man, s.exp, s.bc, prec, rnd)
                } else {
                    mpf::normalize1(s.sign, s.man, s.exp, s.bc, prec, rnd)
                };
                self.put(Val::F(r))
            }
            op::FROM_MAN_EXP => {
                let (m, e) = (self.i(0)?.clone(), Exp::from_int(self.i(1)?));
                let r = mpf::from_man_exp(m.is_neg() as u32, m.mag, e, prec, rnd);
                self.put(Val::F(r))
            }
            op::MPC_EXP | op::MPC_SQRT => {
                let z: Mpc = (self.f(0)?.clone(), self.f(1)?.clone());
                let (a, b) = if op == op::MPC_EXP { elefun::mpc_exp(&z, prec, rnd) } else { elefun::mpc_sqrt(&z, prec, rnd) };
                self.put2(Val::F(a), Val::F(b))
            }
            // (a complex product or quotient: its four exact products stay here, rounded once, as libmpc's are)
            op::MPC_MUL | op::MPC_DIV => {
                let z: Mpc = (self.f(0)?.clone(), self.f(1)?.clone());
                let w: Mpc = (self.f(2)?.clone(), self.f(3)?.clone());
                let (a, b) = if op == op::MPC_MUL { mpc::mpc_mul(&z, &w, prec, rnd) } else { mpc::mpc_div(&z, &w, prec, rnd) };
                self.put2(Val::F(a), Val::F(b))
            }
            // (register 1 is mpf_gamma's type; no result where mpmath's own path answers)
            op::MPF_GAMMA => match crate::gamma::mpf_gamma(self.f(0)?, prec, rnd, self.i(1)?.to_i64().map_or(1, |t| t as u32)) {
                Some(r) => self.put(Val::F(r)),
                None => Ok(0),
            },
            op::MPC_ABS => {
                let z: Mpc = (self.f(0)?.clone(), self.f(1)?.clone());
                self.put(Val::F(mpc::mpc_abs(&z, prec, rnd)))
            }
            op::EXP_FIXED => {
                let r = elefun::exp_fixed(self.i(0)?, p, self.opt_i(1));
                self.put(Val::I(r))
            }
            op::COS_SIN_FIXED => {
                let (c, s) = elefun::cos_sin_fixed(self.i(0)?, p, self.opt_i(1));
                self.put2(Val::I(c), Val::I(s))
            }
            op::LOG_INT_FIXED => {
                let r = elefun::log_int_fixed(self.i(0)?, p, self.opt_i(1));
                self.put(Val::I(r))
            }
            op::PI_FIXED => self.put(Val::I(Int::from(pi_fixed(p)))),
            op::LN2_FIXED => self.put(Val::I(Int::from(ln2_fixed(p)))),
            op::E_FIXED => self.put(Val::I(Int::from(e_fixed(p)))),
            op::BITCOUNT => {
                // python_bitcount: the bit length of a positive n, else 0
                let n = self.i(0)?;
                let b = if n.is_neg() { 0 } else { n.bits() as i64 };
                self.put(Val::I(Int::from_i64(b)))
            }
            op::TRAILING => {
                // python_trailing: the trailing zero bits of abs(n), 0 for 0
                let n = self.i(0)?;
                let t = if n.is_zero() { 0 } else { n.mag.trailing_zeros() as i64 };
                self.put(Val::I(Int::from_i64(t)))
            }
            op::ISQRT | op::SQRTREM => {
                // (a negative x is the host's TypeError, before the call)
                let x = self.i(0)?;
                if x.is_neg() {
                    return Err(Fail::KeyError);
                }
                let (y, r) = sqrtrem_python(&x.mag);
                if op == op::ISQRT {
                    self.put(Val::I(Int::from(y)))
                } else {
                    self.put2(Val::I(Int::from(y)), Val::I(Int::from(r)))
                }
            }
            op::IFAC => {
                let n = self.i(0)?.clone();
                let r = self.ifac(&n, flag == 1);
                self.put(Val::I(r))
            }
            _ => Err(Fail::KeyError),
        }
    }

    /// libintmath's ifac(n, memo={0: 1, 1: 1}), memo and all: n! for n in the
    /// memo or past it (which extends the memo up to MAX_FACTORIAL_CACHE);
    /// below it, a negative n or a float's floor n (`fraction`: n was not
    /// integral) returns the memo's last value, (len(memo) - 1)!.
    fn ifac(&mut self, n: &Int, fraction: bool) -> Int {
        let len = self.ifac_len;
        let m = match n.to_i64() {
            Some(m) => m,
            None if n.is_neg() => return factorial(len - 1),
            None => {
                crate::fail::too_big();
                return Int::zero();
            }
        };
        // (n in the memo: an integral n with 0 <= n < len)
        if !fraction && (0..len).contains(&m) {
            return factorial(m);
        }
        // (k = len; while k <= n: ... -- for a fractional n, floor(n) < n)
        if m < len {
            return factorial(len - 1);
        }
        let r = factorial(m);
        if !crate::fail::failed() {
            self.ifac_len = len.max(m.min(MAX_FACTORIAL_CACHE) + 1);
        }
        r
    }
}

fn factorial(n: i64) -> Int {
    let mut p = Nat::from_u64(1);
    for k in 2..=n.max(1) as u64 {
        // (a refused product ends the loop: n may be far past what fits)
        if crate::fail::failed() {
            break;
        }
        p = p.mul_u64(k);
    }
    Int::from(p)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_operation_inline_and_by_limbs() {
        let mut c = Core::default();
        // (0, 3, 0, 2) * (0, 3, 0, 2) at prec 0 = (0, 9, 0, 4)
        assert_eq!(c.set_f(0, 0, 3.0, 0.0, 2.0), 0);
        assert_eq!(c.set_f(1, 0, 3.0, 0.0, 2.0), 0);
        assert_eq!(c.run(op::MUL, 0.0, 3), 1);
        assert_eq!(c.out(0), 0);
        assert_eq!(&c.res[..4], &[0.0, 9.0, 0.0, 4.0]);
        // 2^53 - 1 squared: 106 bits, by limbs
        let m = EXACT - 1.0;
        assert_eq!(c.set_f(0, 1, m, 0.0, 53.0), 0);
        assert_eq!(c.set_f(1, 0, m, 0.0, 53.0), 0);
        assert_eq!(c.run(op::MUL, 0.0, 3), 1);
        assert_eq!(c.out(0), 1);
        let want = ((1u128 << 53) - 1) * ((1u128 << 53) - 1);
        assert_eq!(&c.res[..6], &[1.0, 2.0, 0.0, 106.0, 0.0, 0.0]);
        assert_eq!(c.io[0] as u128 | (c.io[1] as u128) << 64, want);
        // a division by zero is the reference's ZeroDivisionError
        assert_eq!(c.set_f(1, 0, 0.0, 0.0, 0.0), 0);
        assert_eq!(c.run(op::DIV, 53.0, 0), code::ZERO_DIVISION);
    }

    #[test]
    fn ifac_with_its_memo() {
        let mut c = Core::default();
        let f = |c: &mut Core, n: i64, frac: bool| {
            c.regs[0] = Val::I(Int::from_i64(n));
            assert_eq!(c.run(op::IFAC, 0.0, frac as i32), 1);
            assert_eq!(c.out(0), 2);
            c.res[0]
        };
        // the memo is {0: 1, 1: 1}: a negative n is 1! = 1
        assert_eq!(f(&mut c, -3, false), 1.0);
        assert_eq!(f(&mut c, 5, false), 120.0);
        // the memo now reaches 5: a negative n is 5!, and so is 2.5's
        assert_eq!(f(&mut c, -3, false), 120.0);
        assert_eq!(f(&mut c, 2, true), 120.0);
        assert_eq!(f(&mut c, 3, false), 6.0);
        // 7.5: k runs 6, 7: 7!
        assert_eq!(f(&mut c, 7, true), 5040.0);
    }
}
