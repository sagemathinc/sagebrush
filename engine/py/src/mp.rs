//! `sagebrush._native.mp`: the multiprecision core (engine/mp), natively, for
//! the CPython package's `_sagebrush_mpcore` (python/sagebrush/_mpcore.py,
//! which gives each hook the reference's signature).  One entry, `run`: an
//! operation by code (engine/mp's abi::op) on up to four operands (raw mpf
//! tuples, ints or None), with mpmath's precision and rounding; its results as
//! Python values, or its failure code.  The core's caches and memos are the
//! thread's, as mpmath 1.4.1's are (threading.local).

use num_bigint::{BigInt, BigUint, Sign};
use pyo3::prelude::*;
use pyo3::types::PyTuple;
use sagebrush_mp::abi::{Core, Val};
use sagebrush_mp::exp::Exp;
use sagebrush_mp::int::Int;
use sagebrush_mp::mpf::Mpf;
use sagebrush_mp::nat::Nat;
use std::cell::RefCell;

thread_local! {
    static CORE: RefCell<Core> = RefCell::new(Core::default());
}

fn nat_of(b: &BigUint) -> Nat {
    Nat::from_limbs(&b.to_u64_digits())
}

fn int_of(b: &BigInt) -> Int {
    Int::new(b.sign() == Sign::Minus, nat_of(b.magnitude()))
}

fn big_of(n: &Nat) -> BigUint {
    let mut w = Vec::with_capacity(2 * n.len());
    for l in n.limbs() {
        w.push(l as u32);
        w.push((l >> 32) as u32);
    }
    BigUint::new(w)
}

fn bigint_of(i: &Int) -> BigInt {
    BigInt::from_biguint(if i.is_neg() { Sign::Minus } else { Sign::Plus }, big_of(&i.mag))
}

fn exp_of(b: &BigInt) -> Exp {
    match i64::try_from(b) {
        Ok(e) => Exp::S(e),
        Err(_) => Exp::from_parts(b.sign() == Sign::Minus, nat_of(b.magnitude())),
    }
}

fn exp_big(e: &Exp) -> BigInt {
    match e {
        Exp::S(x) => BigInt::from(*x),
        Exp::B { neg, mag } => BigInt::from_biguint(if *neg { Sign::Minus } else { Sign::Plus }, big_of(mag)),
    }
}

/// An operand: a 4-tuple is a raw mpf, an int an int, None nothing.
fn val_of(x: &Bound<'_, PyAny>) -> PyResult<Val> {
    if x.is_none() {
        return Ok(Val::None);
    }
    if let Ok(t) = x.downcast::<PyTuple>() {
        if t.len() == 4 {
            let sign: u32 = t.get_item(0)?.extract()?;
            let man: BigInt = t.get_item(1)?.extract()?;
            let exp: BigInt = t.get_item(2)?.extract()?;
            let bc: i64 = t.get_item(3)?.extract()?;
            return Ok(Val::F(Mpf { sign, man: nat_of(man.magnitude()), exp: exp_of(&exp), bc }));
        }
    }
    // (a list: a matrix's or a vector's raw mpfs)
    if let Ok(l) = x.downcast::<pyo3::types::PyList>() {
        let mut v = Vec::with_capacity(l.len());
        for e in l.iter() {
            match val_of(&e)? {
                Val::F(m) => v.push(m),
                _ => return Err(pyo3::exceptions::PyTypeError::new_err("a matrix's entries are raw mpf tuples")),
            }
        }
        return Ok(Val::M(v));
    }
    let v: BigInt = x.extract()?;
    Ok(Val::I(int_of(&v)))
}

fn py_of(py: Python<'_>, v: &Val) -> PyResult<PyObject> {
    Ok(match v {
        Val::None => py.None(),
        Val::F(m) => {
            let man = BigInt::from_biguint(Sign::Plus, big_of(&m.man));
            (m.sign, man, exp_big(&m.exp), m.bc).into_pyobject(py)?.into_any().unbind()
        }
        Val::I(i) => bigint_of(i).into_pyobject(py)?.into_any().unbind(),
        Val::M(v) => {
            let items: Vec<PyObject> = v.iter().map(|m| py_of(py, &Val::F(m.clone()))).collect::<PyResult<_>>()?;
            pyo3::types::PyList::new(py, items)?.into_any().unbind()
        }
    })
}

/// Whether a call may run long enough to need Stop: by its work, not only its
/// size: gamma (its series), ifac (a small n can mean a long product), every
/// matrix operation (n^3), or numbers (operands, or the precision) past
/// 16,384 bits.
fn long(op: i32, prec: f64, limbs: &usize) -> bool {
    use sagebrush_mp::abi::op;
    matches!(op, op::MPF_GAMMA | op::IFAC | op::MAT_LU | op::MAT_INVERSE | op::MAT_DET | op::MAT_LU_SOLVE) || prec > 16384.0 || *limbs > 256
}

/// run(op, args, prec, rnd) -> (n, results): n >= 0 results, or a failure
/// code (< 0, engine/mp's abi::code) with the failure's detail as results.
#[pyfunction]
fn run(py: Python<'_>, op: i32, args: &Bound<'_, PyTuple>, prec: f64, rnd: i32) -> PyResult<(i32, PyObject)> {
    let mut regs = [Val::None, Val::None, Val::None, Val::None];
    for (k, a) in args.iter().enumerate().take(4) {
        regs[k] = val_of(&a)?;
    }
    let regs_size: usize = regs
        .iter()
        .map(|v| match v {
            Val::F(m) => m.man.len(),
            Val::I(i) => i.mag.len(),
            Val::M(v) => v.iter().map(|m| m.man.len()).sum(),
            Val::None => 0,
        })
        .sum();
    let call = move || {
        CORE.with(|c| {
            let mut c = c.borrow_mut();
            c.regs = regs;
            let n = c.run(op, prec, rnd);
            let out = std::mem::take(&mut c.out);
            (n, out, c.res)
        })
    };
    // (a call that may run long, as every engine call: Ctrl-C reaches the core's loops, and a Stop is this
    // call's KeyboardInterrupt; an unwind drops the core's borrow, and a cache taken out mid-call is lost, never
    // left half made.  A small one, most of mpmath's, runs at once, holding the GIL: Python's own Ctrl-C is
    // seen as it returns)
    let (n, out, res) = if long(op, prec, &regs_size) { crate::guarded(py, call)? } else { call() };
    if n < 0 {
        return Ok((n, res.to_vec().into_pyobject(py)?.into_any().unbind()));
    }
    let vals: Vec<PyObject> = out.iter().take(n as usize).map(|v| py_of(py, v)).collect::<PyResult<_>>()?;
    Ok((n, PyTuple::new(py, vals)?.into_any().unbind()))
}

/// reset(): forget the thread's caches and memos (a new session).
#[pyfunction]
fn reset() {
    CORE.with(|c| c.borrow_mut().reset());
}

pub fn register(m: &Bound<'_, PyModule>) -> PyResult<()> {
    let mp = PyModule::new(m.py(), "mp")?;
    mp.add_function(wrap_pyfunction!(run, &mp)?)?;
    mp.add_function(wrap_pyfunction!(reset, &mp)?)?;
    m.add_submodule(&mp)
}
