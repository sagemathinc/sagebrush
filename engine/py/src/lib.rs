//! CPython bindings: the `sagebrush._native` extension.  Computations
//! release the GIL, so Python threads can run several in parallel; each call
//! also uses `threads` worker threads (0 = all cores).  Invalid arguments
//! raise ValueError; Ctrl-C raises KeyboardInterrupt (see `guarded`).

use sagebrush_modsym::exact::Exact;
use pyo3::exceptions::{PyKeyboardInterrupt, PyValueError};
use pyo3::prelude::*;
use pyo3::types::PyDict;

/// The thread that imported the module: Python's main thread, the one that
/// receives Ctrl-C.
static MAIN: std::sync::OnceLock<std::thread::ThreadId> = std::sync::OnceLock::new();

/// An engine computation without the GIL.  Called from the main thread,
/// Ctrl-C during it stops it at its next check (sagebrush-interrupt) and
/// raises KeyboardInterrupt, with the interpreter's state intact; Python's
/// own handler is back in place when this returns.
fn guarded<T: Send>(py: Python<'_>, f: impl FnOnce() -> T + Send) -> PyResult<T> {
    let main = MAIN.get() == Some(&std::thread::current().id());
    py.detach(|| {
        let _sigint = main.then(sagebrush_interrupt::SigintGuard::new);
        sagebrush_interrupt::catch(f)
    })
    .map_err(|_| PyKeyboardInterrupt::new_err(()))
}

fn run<T: Send>(py: Python<'_>, threads: usize, f: impl FnOnce() -> T + Send) -> PyResult<T> {
    guarded(py, || rayon::ThreadPoolBuilder::new().num_threads(threads).build().unwrap().install(f))
}

fn err(e: String) -> PyErr {
    PyValueError::new_err(e)
}

/// T_q's characteristic polynomial mod p (constant term first).
#[pyfunction]
#[pyo3(signature = (n, q, p=67108859, threads=0))]
fn hecke_charpoly<'py>(py: Python<'py>, n: u64, q: u64, p: u64, threads: usize) -> PyResult<Bound<'py, PyDict>> {
    let r = run(py, threads, || sagebrush_modsym::hecke_charpoly(n, q, p))?.map_err(err)?;
    let d = PyDict::new(py);
    d.set_item("symbols", r.symbols)?;
    d.set_item("gens", r.gens)?;
    d.set_item("dim", r.dim)?;
    d.set_item("charpoly", r.charpoly.clone())?;
    d.set_item("hash", r.hash())?;
    d.set_item("eisenstein_root", r.eisenstein_root())?;
    d.set_item("ms", r.ms.to_vec())?;
    Ok(d)
}

fn exact_dict<'py>(py: Python<'py>, e: &Exact) -> PyResult<Bound<'py, PyDict>> {
    let d = PyDict::new(py);
    d.set_item("n", e.n)?;
    d.set_item("q", e.q)?;
    d.set_item("genus", e.genus)?;
    d.set_item("cusps", e.cusps)?;
    d.set_item("eisenstein", e.eis)?;
    d.set_item("dim", e.dim)?;
    d.set_item("charpoly", e.coeffs.clone())?;
    d.set_item("primes_used", e.primes_used.len())?;
    d.set_item("bound_bits", e.bound_bits)?;
    d.set_item("status", e.status)?;
    d.set_item("checks", e.checks.clone())?;
    Ok(d)
}

/// T_q's characteristic polynomial over Z, proven by CRT with a coefficient bound.
#[pyfunction]
#[pyo3(signature = (n, q, threads=0))]
fn charpoly_exact<'py>(py: Python<'py>, n: u64, q: u64, threads: usize) -> PyResult<Bound<'py, PyDict>> {
    let e = run(py, threads, || sagebrush_modsym::exact::exact_charpoly(n, q))?.map_err(err)?;
    exact_dict(py, &e)
}

/// charpoly_exact for many levels in parallel; failures are {"n", "error"} dicts.
#[pyfunction]
#[pyo3(signature = (levels, q, threads=0))]
fn batch_exact<'py>(py: Python<'py>, levels: Vec<u64>, q: u64, threads: usize) -> PyResult<Vec<Bound<'py, PyDict>>> {
    let rs = run(py, threads, || sagebrush_modsym::exact::batch_exact(&levels, q))?;
    levels
        .iter()
        .zip(rs)
        .map(|(&n, r)| match r {
            Ok(e) => exact_dict(py, &e),
            Err(e) => {
                let d = PyDict::new(py);
                d.set_item("n", n)?;
                d.set_item("error", e)?;
                Ok(d)
            }
        })
        .collect()
}

/// Psi(N), genus, cusps, Eisenstein dimension and dimension of the sign +1 space.
#[pyfunction]
fn level_data<'py>(py: Python<'py>, n: u64) -> PyResult<Bound<'py, PyDict>> {
    let (psi, g, c, e, dim) = sagebrush_modsym::exact::level_data(n);
    let d = PyDict::new(py);
    d.set_item("psi", psi)?;
    d.set_item("genus", g)?;
    d.set_item("cusps", c)?;
    d.set_item("eisenstein", e)?;
    d.set_item("dim", dim)?;
    Ok(d)
}

/// Whether T_q and T_r commute mod p.
#[pyfunction]
#[pyo3(signature = (n, q, r, p=67108859, threads=0))]
fn commute(py: Python<'_>, n: u64, q: u64, r: u64, p: u64, threads: usize) -> PyResult<bool> {
    run(py, threads, || sagebrush_modsym::hecke_commute(n, q, r, p))?.map_err(err)
}

/// Predicted dimension, bytes and single-thread seconds, without computing.
#[pyfunction]
fn estimate<'py>(py: Python<'py>, n: u64, q: u64) -> PyResult<Bound<'py, PyDict>> {
    sagebrush_modsym::validate(n, q, None).map_err(err)?;
    let e = sagebrush_modsym::estimate::estimate(n, q);
    let d = PyDict::new(py);
    d.set_item("symbols", e.symbols)?;
    d.set_item("dim", e.dim)?;
    d.set_item("genus", e.genus)?;
    d.set_item("primes", e.primes)?;
    d.set_item("primes_max", e.primes_max)?;
    d.set_item("bytes_modp", e.bytes_modp)?;
    d.set_item("bytes_exact", e.bytes_exact)?;
    d.set_item("seconds_modp", e.seconds_modp)?;
    d.set_item("seconds_exact", e.seconds_exact)?;
    Ok(d)
}

/// The rational newforms of level N: a list of [(p, a_p)] for primes p <= bound not dividing N.
#[pyfunction]
#[pyo3(signature = (n, bound=1000, threads=0))]
fn rational_newforms(py: Python<'_>, n: u64, bound: u64, threads: usize) -> PyResult<Vec<Vec<(u64, i64)>>> {
    let r = run(py, threads, || sagebrush_modsym::newforms::rational_newforms(n, bound, 40))?.map_err(err)?;
    Ok(r.forms.into_iter().map(|f| f.ap).collect())
}

// ---- sagebrush.ap: traces of Frobenius of elliptic curves ----

fn curve(a: Vec<i64>) -> PyResult<sagebrush_ap::EllipticCurve> {
    let a: [i64; 5] = a.try_into().map_err(|_| PyValueError::new_err("a curve is [a1, a2, a3, a4, a6]"))?;
    sagebrush_ap::EllipticCurve::new(a).map_err(err)
}

/// a_p of y^2 + a1 xy + a3 y = x^3 + a2 x^2 + a4 x + a6, or None if p divides the discriminant.
#[pyfunction]
fn ap(a: Vec<i64>, p: u64) -> PyResult<Option<i64>> {
    if p < 2 || !sagebrush_modsym::exact::is_prime(p) || p >= 1 << 62 {
        return Err(PyValueError::new_err(format!("p = {} must be a prime below 2^62", p)));
    }
    Ok(curve(a)?.ap(p))
}

/// [(p, a_p)] for all primes p <= n (a_p None at bad primes), in parallel.
#[pyfunction]
#[pyo3(signature = (a, n, threads=0))]
fn aplist(py: Python<'_>, a: Vec<i64>, n: u64, threads: usize) -> PyResult<Vec<(u64, Option<i64>)>> {
    let e = curve(a)?;
    run(py, threads, || sagebrush_ap::aplist(&e, n))
}

/// aplist for many curves, in parallel over curves.
#[pyfunction]
#[pyo3(signature = (curves, n, threads=0))]
fn aplist_many(py: Python<'_>, curves: Vec<Vec<i64>>, n: u64, threads: usize) -> PyResult<Vec<Vec<(u64, Option<i64>)>>> {
    let es = curves.into_iter().map(curve).collect::<PyResult<Vec<_>>>()?;
    run(py, threads, || sagebrush_ap::aplist_many(&es, n))
}

/// (number of good primes p <= n, [mean (a_p^2/p)^k for k = 1..kmax]): Sato-Tate moments.
#[pyfunction]
#[pyo3(signature = (a, n, kmax=4, threads=0))]
fn moments(py: Python<'_>, a: Vec<i64>, n: u64, kmax: usize, threads: usize) -> PyResult<(u64, Vec<f64>)> {
    let e = curve(a)?;
    run(py, threads, || sagebrush_ap::moments(&e, n, kmax))
}

// ---- sagebrush.mf: weight k >= 2 with a Dirichlet character ----

use num_bigint::BigInt;
use sagebrush_modsym::dirichlet::DirichletGroup;
use sagebrush_modsym::general::Character;

/// A character mod n from LMFDB's description (order, gens, vals):
/// chi(gens[i]) = zeta_order^vals[i]; None is the trivial character.
fn character(n: u64, chi: Option<(u64, Vec<u64>, Vec<u64>)>) -> PyResult<Character> {
    match chi {
        None => Ok(Character::trivial(n)),
        Some((order, gens, vals)) => Character::from_generators(n, order, &gens, &vals).map_err(err),
    }
}

/// Galois-orbit representatives of the Dirichlet characters mod n, as
/// dicts with order, conductor, parity and (gens, vals) for `chi=`.
#[pyfunction]
fn characters<'py>(py: Python<'py>, n: u64) -> PyResult<Vec<Bound<'py, PyDict>>> {
    let g = DirichletGroup::new(n);
    let total = g.order();
    let mut seen = vec![false; total as usize];
    let mut out = vec![];
    for c in 0..total {
        if seen[c as usize] {
            continue;
        }
        let v = g.vector(c);
        let chi = g.character(&v);
        for j in 1..=chi.order {
            if sagebrush_modsym::p1::gcd(j, chi.order) == 1 {
                let w: Vec<u64> = v.iter().map(|&x| x * j).collect();
                seen[g.index(&w) as usize] = true;
            }
        }
        let vals: Vec<u64> = g.gens.iter().map(|&x| chi.exponent(x as i64).unwrap() as u64).collect();
        let d = PyDict::new(py);
        d.set_item("order", chi.order)?;
        d.set_item("conductor", chi.conductor())?;
        d.set_item("even", chi.is_even())?;
        d.set_item("gens", g.gens.clone())?;
        d.set_item("vals", vals.clone())?;
        d.set_item("chi", (chi.order, g.gens.clone(), vals))?;
        out.push(d);
    }
    Ok(out)
}

/// Dimensions (over Q(chi)) of S_k, E_k, the sign-0 modular symbols space
/// and the newspace S_k^new(N, chi).
#[pyfunction]
#[pyo3(signature = (n, k, chi=None))]
fn dims<'py>(py: Python<'py>, n: u64, k: usize, chi: Option<(u64, Vec<u64>, Vec<u64>)>) -> PyResult<Bound<'py, PyDict>> {
    use sagebrush_modsym::dims::*;
    let eps = character(n, chi)?.minimal();
    // dim S^new(N) = sum over M (cond | M | N) of beta(N/M) dim S(M), beta = mu * mu.
    let f = eps.conductor();
    let beta = |x: u64| -> i64 {
        sagebrush_modsym::exact::factor(x).iter().map(|&(_, e)| match e { 1 => -2, 2 => 1, _ => 0 }).product()
    };
    let new: i64 = (1..=n).filter(|m| n % m == 0 && m % f == 0).map(|m| beta(n / m) * dim_cusp_forms(&eps.restrict(m), k) as i64).sum();
    let d = PyDict::new(py);
    d.set_item("order", eps.order)?;
    d.set_item("conductor", f)?;
    d.set_item("cusp", dim_cusp_forms(&eps, k))?;
    d.set_item("eisenstein", dim_eisenstein(&eps, k))?;
    d.set_item("modsym", dim_modsym(&eps, k))?;
    d.set_item("new", new)?;
    Ok(d)
}

/// Charpoly of T_q on M_k(N, chi)^sign mod a prime ell = 1 mod ord(chi).
#[pyfunction]
#[pyo3(signature = (n, k, q, chi=None, sign=0, threads=0))]
fn charpoly_mod<'py>(py: Python<'py>, n: u64, k: usize, q: u64, chi: Option<(u64, Vec<u64>, Vec<u64>)>, sign: i32, threads: usize) -> PyResult<Bound<'py, PyDict>> {
    let eps = character(n, chi)?.minimal();
    let (dim, ell, zeta, f) = run(py, threads, || -> Result<_, String> {
        let sp = sagebrush_modsym::general::GeneralSpace::new(n, k, &eps, sign)?;
        Ok((sp.dimension(), sp.p, sp.zeta, sp.hecke_charpoly(q)?))
    })?.map_err(err)?;
    let d = PyDict::new(py);
    d.set_item("dim", dim)?;
    d.set_item("ell", ell)?;
    d.set_item("zeta", zeta)?;
    d.set_item("charpoly", f)?;
    Ok(d)
}

/// Exact charpoly of T_q (U_q if q | N) on M_k(N, chi)^sign over
/// Z[zeta_m], m = ord(chi): coeffs[j][i] = coefficient of zeta_m^i in the
/// coefficient of x^j.
#[pyfunction]
#[pyo3(signature = (n, k, q, chi=None, sign=0, threads=0))]
fn charpoly<'py>(py: Python<'py>, n: u64, k: usize, q: u64, chi: Option<(u64, Vec<u64>, Vec<u64>)>, sign: i32, threads: usize) -> PyResult<Bound<'py, PyDict>> {
    let eps = character(n, chi)?;
    let e = run(py, threads, || sagebrush_modsym::general_exact::exact_charpoly(n, k, &eps, sign, q))?.map_err(err)?;
    let d = PyDict::new(py);
    d.set_item("m", e.m)?;
    d.set_item("dim", e.dim)?;
    d.set_item("coeffs", e.coeffs.clone())?;
    d.set_item("primes_used", e.primes_used.len())?;
    d.set_item("status", e.status)?;
    d.set_item("checks", e.checks.clone())?;
    Ok(d)
}

fn python_factorer(factor: Py<PyAny>) -> impl Fn(&[BigInt]) -> Vec<(Vec<BigInt>, u32)> + Sync {
    move |f: &[BigInt]| {
        Python::attach(|py| {
            factor.call1(py, (f.to_vec(),)).and_then(|r| r.extract::<Vec<(Vec<BigInt>, u32)>>(py)).unwrap_or_default()
        })
    }
}

fn newspace_dict<'py>(py: Python<'py>, r: &sagebrush_modsym::newspace::NewspaceOrbits) -> PyResult<Bound<'py, PyDict>> {
    let d = PyDict::new(py);
    d.set_item("dim", r.dim)?;
    d.set_item("order", r.m)?;
    d.set_item("orbit_dims", r.dims.clone())?;
    d.set_item("orbit_charpolys", r.orbits.clone())?;
    d.set_item("T", r.ops.clone())?;
    d.set_item("status", r.status)?;
    d.set_item("checks", r.checks.clone())?;
    Ok(d)
}

/// Galois orbits of newforms in S_k^new(N, [chi]): dimensions over Q and
/// each orbit's charpoly over Q of the Hecke operator T = sum r T_q.
#[pyfunction]
#[pyo3(signature = (n, k, factor, chi=None, threads=0))]
fn newspace<'py>(py: Python<'py>, n: u64, k: usize, factor: Py<PyAny>, chi: Option<(u64, Vec<u64>, Vec<u64>)>, threads: usize) -> PyResult<Bound<'py, PyDict>> {
    let eps = character(n, chi)?;
    let f = python_factorer(factor);
    let r = run(py, threads, || sagebrush_modsym::newspace::newspace_orbits(n, k, &eps, &f))?.map_err(err)?;
    newspace_dict(py, &r)
}

/// newspace(...) plus the trace form tr a_1..a_B of each orbit; orbits in
/// LMFDB order (by dimension, then trace form).
#[pyfunction]
#[pyo3(signature = (n, k, factor, chi=None, bound=100, threads=0))]
fn newforms<'py>(py: Python<'py>, n: u64, k: usize, factor: Py<PyAny>, chi: Option<(u64, Vec<u64>, Vec<u64>)>, bound: usize, threads: usize) -> PyResult<Bound<'py, PyDict>> {
    let eps = character(n, chi)?;
    let f = python_factorer(factor);
    let (r, tr) = run(py, threads, || -> Result<_, String> {
        let r = sagebrush_modsym::newspace::newspace_orbits(n, k, &eps, &f)?;
        let tr = sagebrush_modsym::traces::orbit_traces(n, k, &eps, &r, bound)?;
        Ok((r, tr))
    })?.map_err(err)?;
    let mut orbits: Vec<(usize, Vec<BigInt>, Vec<BigInt>)> = r.dims.iter().cloned().zip(tr).zip(r.orbits.iter().cloned()).map(|((d, t), u)| (d, t, u)).collect();
    orbits.sort();
    let d = newspace_dict(py, &r)?;
    let list: Vec<Bound<'py, PyDict>> = orbits.into_iter().enumerate().map(|(i, (dim, t, u))| {
        let o = PyDict::new(py);
        let letter: String = {
            // LMFDB-style letters: a..z, ba, bb, ...
            let mut x = i;
            let mut s = vec![];
            loop {
                s.push((b'a' + (x % 26) as u8) as char);
                x /= 26;
                if x == 0 { break; }
            }
            s.iter().rev().collect()
        };
        o.set_item("letter", letter)?;
        o.set_item("dim", dim)?;
        o.set_item("traces", t)?;
        o.set_item("charpoly", u)?;
        Ok(o)
    }).collect::<PyResult<_>>()?;
    d.set_item("newforms", list)?;
    Ok(d)
}

/// One JSON request to the engines (the same dispatcher as the WebAssembly
/// build, engine/web): `{"fn": name, ...}` -> `{"ok": ...}` or
/// `{"error": ...}`.  The pure-Python modules built on it (sagebrush.nf,
/// sagebrush.poly) are shared with the browser runtime.
#[pyfunction]
fn call(py: Python<'_>, request: String) -> PyResult<String> {
    guarded(py, || sagebrush_web::call(&request))
}

/// The native extension, `sagebrush._native`; each engine is a submodule,
/// re-exported by the pure-Python package (python/sagebrush).
#[pymodule]
fn _native(m: &Bound<'_, PyModule>) -> PyResult<()> {
    let _ = MAIN.set(std::thread::current().id());
    let modsym = PyModule::new(m.py(), "modsym")?;
    modsym.add_function(wrap_pyfunction!(hecke_charpoly, &modsym)?)?;
    modsym.add_function(wrap_pyfunction!(charpoly_exact, &modsym)?)?;
    modsym.add_function(wrap_pyfunction!(batch_exact, &modsym)?)?;
    modsym.add_function(wrap_pyfunction!(level_data, &modsym)?)?;
    modsym.add_function(wrap_pyfunction!(commute, &modsym)?)?;
    modsym.add_function(wrap_pyfunction!(estimate, &modsym)?)?;
    modsym.add_function(wrap_pyfunction!(rational_newforms, &modsym)?)?;
    m.add_submodule(&modsym)?;
    let apm = PyModule::new(m.py(), "ap")?;
    apm.add_function(wrap_pyfunction!(ap, &apm)?)?;
    apm.add_function(wrap_pyfunction!(aplist, &apm)?)?;
    apm.add_function(wrap_pyfunction!(aplist_many, &apm)?)?;
    apm.add_function(wrap_pyfunction!(moments, &apm)?)?;
    m.add_submodule(&apm)?;
    let mf = PyModule::new(m.py(), "mf")?;
    mf.add_function(wrap_pyfunction!(characters, &mf)?)?;
    mf.add_function(wrap_pyfunction!(dims, &mf)?)?;
    mf.add_function(wrap_pyfunction!(charpoly_mod, &mf)?)?;
    mf.add_function(wrap_pyfunction!(charpoly, &mf)?)?;
    mf.add_function(wrap_pyfunction!(newspace, &mf)?)?;
    mf.add_function(wrap_pyfunction!(newforms, &mf)?)?;
    m.add_submodule(&mf)?;
    m.add_function(wrap_pyfunction!(call, m)?)
}
