//! CPython bindings: the `sagebrush._native` extension.  Computations
//! release the GIL, so Python threads can run several in parallel; each call
//! also uses `threads` worker threads (0 = all cores).  Invalid arguments
//! raise ValueError; Ctrl-C raises KeyboardInterrupt (see `guarded`).

use sagebrush_modsym::exact::Exact;
use pyo3::exceptions::{PyKeyboardInterrupt, PyValueError};
use pyo3::prelude::*;
use pyo3::types::PyDict;

mod serve;

/// The thread that imported the module: Python's main thread, the one that
/// receives Ctrl-C.
static MAIN: std::sync::OnceLock<std::thread::ThreadId> = std::sync::OnceLock::new();

/// An engine computation without the GIL.  Called from the main thread,
/// Ctrl-C during it stops it at its next check (sagebrush-interrupt) and
/// raises KeyboardInterrupt, with the interpreter's state intact; Python's
/// own handler is back in place when this returns.
///
/// It is also the call that asks the host's memory total source (no-cliffs
/// C-2c scope r2 section 2): the asking call is entered here, on the calling
/// thread with the GIL held, before the work is handed off, and finished
/// here after it.  Only this thread may run the source (a worker gets
/// NotAsked: the total in force, its age unchanged), and a stale total is
/// refreshed here first.  A control exception the source raised during the
/// call (KeyboardInterrupt, SystemExit, ...) is raised by this call, the
/// original object, once, in preference to the computation's own result or
/// error; an ordinary Exception from the source is an unreadable answer.
fn guarded<T: Send>(py: Python<'_>, f: impl FnOnce() -> T + Send) -> PyResult<T> {
    let asking = Asking::enter();
    // (the outer entry's refresh is the full, locked total(), whatever the
    // parallel wrapper's refresh_if_owner does)
    let _ = sagebrush_ledger::total();
    let main = MAIN.get() == Some(&std::thread::current().id());
    // (the body's unwind, a Rust panic, is caught here, at the owner, so
    // that the asking call is finished on every exit: return, error, Stop
    // or panic; the GIL is held again once detach returns or unwinds)
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        py.detach(|| {
            let _sigint = main.then(sagebrush_interrupt::SigintGuard::new);
            sagebrush_interrupt::catch(f)
        })
        .map_err(|_| PyKeyboardInterrupt::new_err(()))
    }));
    match (asking.finish(), r) {
        // the source's control exception is this call's, and wins over the
        // body's result, error or panic
        (Err(control), _) => Err(control),
        (Ok(()), Ok(r)) => r,
        // no control exception: the body's panic goes on as before
        (Ok(()), Err(panic)) => std::panic::resume_unwind(panic),
    }
}

/// guarded, on a pool of `threads` worker threads (sagebrush-par's install:
/// the workers run under the caller's ledger context, never its asking call).
fn run<T: Send>(py: Python<'_>, threads: usize, f: impl FnOnce() -> T + Send) -> PyResult<T> {
    guarded(py, || sagebrush_par::install(threads, f))
}

// Big integers cross into Python as num-bigint's (PyO3's conversion), from
// whichever backend sagebrush-bigint uses.
type PyInt = num_bigint::BigInt;
fn py1(v: &[BigInt]) -> Vec<PyInt> {
    v.iter().map(sagebrush_bigint::to_num).collect()
}
fn py2(v: &[Vec<BigInt>]) -> Vec<Vec<PyInt>> {
    v.iter().map(|w| py1(w)).collect()
}

fn err(e: String) -> PyErr {
    PyValueError::new_err(e)
}

/// A level N >= 1 and, if given, a weight k >= 2.
fn lk(n: u64, k: Option<usize>) -> PyResult<()> {
    sagebrush_modsym::check_level(n).map_err(err)?;
    k.map_or(Ok(()), sagebrush_modsym::check_weight).map_err(err)
}

/// T_q's characteristic polynomial mod p (constant term first).
#[pyfunction]
#[pyo3(signature = (n, q, p=67108859, threads=0))]
fn hecke_charpoly<'py>(py: Python<'py>, n: u64, q: u64, p: u64, threads: usize) -> PyResult<Bound<'py, PyDict>> {
    lk(n, None)?;
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
    d.set_item("charpoly", py1(&e.coeffs))?;
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
    lk(n, None)?;
    let e = run(py, threads, || sagebrush_modsym::exact::exact_charpoly(n, q))?.map_err(err)?;
    exact_dict(py, &e)
}

/// charpoly_exact for many levels in parallel; failures are {"n", "error"} dicts.
#[pyfunction]
#[pyo3(signature = (levels, q, threads=0))]
fn batch_exact<'py>(py: Python<'py>, levels: Vec<u64>, q: u64, threads: usize) -> PyResult<Vec<Bound<'py, PyDict>>> {
    levels.iter().try_for_each(|&n| lk(n, None))?;
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
    lk(n, None)?;
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
    lk(n, None)?;
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
/// Checked, not proven: the Hasse bound, and the same newforms modulo a second prime.
/// With details=True, a dict: forms, status ("checked") and checks (what was checked).
#[pyfunction]
#[pyo3(signature = (n, bound=1000, threads=0, details=false))]
fn rational_newforms<'py>(py: Python<'py>, n: u64, bound: u64, threads: usize, details: bool) -> PyResult<Bound<'py, PyAny>> {
    lk(n, None)?;
    let r = run(py, threads, || sagebrush_modsym::newforms::rational_newforms(n, bound, 40))?.map_err(err)?;
    let forms: Vec<Vec<(u64, i64)>> = r.forms.into_iter().map(|f| f.ap).collect();
    if !details {
        return Ok(forms.into_pyobject(py)?.into_any());
    }
    let d = PyDict::new(py);
    d.set_item("forms", forms)?;
    d.set_item("status", r.status)?;
    d.set_item("checks", r.checks)?;
    Ok(d.into_any())
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

use sagebrush_bigint::BigInt;
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
    lk(n, None)?;
    if n > 10_000_000 {
        return Err(err("characters: the modulus must be at most 10^7".into()));
    }
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
    lk(n, Some(k))?;
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
    lk(n, Some(k))?;
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
    lk(n, Some(k))?;
    let eps = character(n, chi)?;
    let e = run(py, threads, || sagebrush_modsym::general_exact::exact_charpoly(n, k, &eps, sign, q))?.map_err(err)?;
    let d = PyDict::new(py);
    d.set_item("m", e.m)?;
    d.set_item("dim", e.dim)?;
    d.set_item("coeffs", py2(&e.coeffs))?;
    d.set_item("primes_used", e.primes_used.len())?;
    d.set_item("status", e.status)?;
    d.set_item("checks", e.checks.clone())?;
    Ok(d)
}

fn python_factorer(factor: Py<PyAny>) -> impl Fn(&[BigInt]) -> Vec<(Vec<BigInt>, u32)> + Sync {
    move |f: &[BigInt]| {
        Python::attach(|py| {
            factor
                .call1(py, (py1(f),))
                .and_then(|r| r.extract::<Vec<(Vec<PyInt>, u32)>>(py))
                .map(|v| v.into_iter().map(|(g, e)| (g.iter().map(sagebrush_bigint::from_num).collect(), e)).collect())
                .unwrap_or_default()
        })
    }
}

fn newspace_dict<'py>(py: Python<'py>, r: &sagebrush_modsym::newspace::NewspaceOrbits) -> PyResult<Bound<'py, PyDict>> {
    let d = PyDict::new(py);
    d.set_item("dim", r.dim)?;
    d.set_item("order", r.m)?;
    d.set_item("orbit_dims", r.dims.clone())?;
    d.set_item("orbit_charpolys", py2(&r.orbits))?;
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
    lk(n, Some(k))?;
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
    lk(n, Some(k))?;
    if bound < 1 {
        return Err(err("bound must be at least 1".into()));
    }
    let eps = character(n, chi)?;
    let f = python_factorer(factor);
    let (r, tr) = run(py, threads, || -> Result<_, String> {
        let r = sagebrush_modsym::newspace::newspace_orbits(n, k, &eps, &f)?;
        let tr = sagebrush_modsym::traces::labelled_orbits(n, k, &eps, &r, bound)?;
        Ok((r, tr))
    })?.map_err(err)?;
    let orbits = tr;
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
        o.set_item("traces", py1(&t))?;
        o.set_item("charpoly", py1(&u))?;
        Ok(o)
    }).collect::<PyResult<_>>()?;
    d.set_item("newforms", list)?;
    Ok(d)
}

/// One symbolic-engine call (engine/sym/src/api.rs): "op\x1fargs..." ->
/// "ok\x1fresults..." or "err\x1fKind\x1fmessage".
#[pyfunction]
fn sym_call(py: Python<'_>, request: String) -> PyResult<String> {
    guarded(py, || sagebrush_sym::api::call(&request))
}

/// One JSON request to the engines (the same dispatcher as the WebAssembly
/// build, engine/web): `{"fn": name, ...}` -> `{"ok": ...}` or
/// `{"error": ...}`.  The pure-Python modules built on it (sagebrush.nf,
/// sagebrush.poly) are shared with the browser runtime.
#[pyfunction]
fn call(py: Python<'_>, request: String) -> PyResult<String> {
    guarded(py, || sagebrush_web::call(&request))
}

/// A multivariate polynomial call (engine/mpoly): the binary framing of
/// sagebrush_mpoly::call, shared with the WebAssembly build (sb_mp_call).
#[pyfunction]
fn mpoly_call<'py>(py: Python<'py>, request: Vec<u8>) -> PyResult<Bound<'py, pyo3::types::PyBytes>> {
    let r = guarded(py, move || sagebrush_mpoly::call_framed(&request))?;
    Ok(pyo3::types::PyBytes::new(py, &r))
}

/// A PNG call's failure as the browser's _sbraster raises it
/// (src/runtime/raster.ts): the input refused (a limit, an unsupported
/// drawing, not a PNG) a ValueError; memory the engine could not allocate a
/// MemoryError (args: the message, the bytes, what they were for); the
/// engine failing a RuntimeError.
fn raster_fail(e: sagebrush_raster::Fail) -> PyErr {
    use sagebrush_raster::Fail;
    match e {
        Fail::Input(s) => pyo3::exceptions::PyValueError::new_err(s),
        Fail::Memory { bytes, what } => {
            pyo3::exceptions::PyMemoryError::new_err((Fail::Memory { bytes, what }.to_string(), bytes, what))
        }
        Fail::Backend(s) => pyo3::exceptions::PyRuntimeError::new_err(format!("Sagebrush's PNG module: {}", s)),
    }
}

/// Sagebrush's PNG module (engine/raster), as the browser's _sbraster
/// (src/runtime/raster.ts): `svg` drawn at `scale` pixels per SVG unit on
/// a `width` x `height` picture (0 x 0: the drawing's size), on
/// `background` (a CSS color, "" for transparent), with the PNG text
/// chunks `text`; (the PNG, the characters the font lacked).
#[pyfunction]
#[allow(clippy::too_many_arguments)]
fn raster_render<'py>(py: Python<'py>, svg: String, scale: f32, width: u32, height: u32, background: String, dpi: f32, text: Vec<(String, String)>) -> PyResult<(Bound<'py, pyo3::types::PyBytes>, String)> {
    let size = if width == 0 && height == 0 { None } else { Some((width, height)) };
    let r = py.detach(|| sagebrush_raster::render_png(&svg, scale, size, &background, dpi, &text));
    match r {
        Ok((png, missing)) => Ok((pyo3::types::PyBytes::new(py, &png), missing)),
        Err(e) => Err(raster_fail(e)),
    }
}

/// The most a PNG file read may be, in bytes (lib/_png.py MAX_FILE_BYTES).
const RASTER_MAX_FILE_BYTES: usize = 256 << 20;

/// A PNG file's pixels: (width, height, channels, float32 values as bytes,
/// little-endian), as the browser's _sbraster.decode.  `png` is borrowed
/// from the caller's bytes (not copied), and refused above 256 MiB here,
/// before anything is read (daybreak2's limits review).
#[pyfunction]
fn raster_decode<'py>(py: Python<'py>, png: &[u8]) -> PyResult<(u32, u32, u32, Bound<'py, pyo3::types::PyBytes>)> {
    if png.len() > RASTER_MAX_FILE_BYTES {
        return Err(pyo3::exceptions::PyValueError::new_err(format!(
            "a PNG of {} bytes: Sagebrush reads at most {}", png.len(), RASTER_MAX_FILE_BYTES)));
    }
    let r = py.detach(|| sagebrush_raster::decode_png(png));
    match r {
        Ok((w, h, ch, v)) => {
            let mut b = Vec::new();
            let n = v.len().saturating_mul(4);
            if b.try_reserve_exact(n).is_err() {
                return Err(raster_fail(sagebrush_raster::Fail::Memory { bytes: n as u64, what: "the decoded image's values" }));
            }
            for x in v {
                b.extend_from_slice(&x.to_le_bytes());
            }
            Ok((w, h, ch, pyo3::types::PyBytes::new(py, &b)))
        }
        Err(e) => Err(raster_fail(e)),
    }
}

/// Register the host's memory share for default polynomial factorizations
/// (item D0): `source()` returns bytes or None (lib/_capacity.py
/// poly_share, through sagebrush._capacity_share).  It is called once per
/// default budget, with the GIL taken for it (engine calls run without it);
/// an exception or anything but a non-negative int is "no figure", and the
/// factorization keeps its default.  The first registration stands.
/// (Top-level factorizations are serialized in one host worker: see
/// sagebrush_interrupt::memory_share.)
#[pyfunction]
fn set_memory_share_source(source: Py<PyAny>) {
    sagebrush_interrupt::set_memory_share_host(move || {
        Python::attach(|py| source.call0(py).ok().and_then(|r| r.extract::<Option<u64>>(py).ok()).flatten())
    });
}

// ---- what the memory total source raises (CORR-C1-1, astra2): a
// KeyboardInterrupt, SystemExit or any other BaseException beyond an ordinary
// Exception is not an unreadable answer.  It belongs to the call that asked
// for the total: the source runs only on a thread where such a call is active
// (ledger_snapshot), what it raises is kept in that thread's slot, and that
// call raises it.  A read on any other thread (an engine worker) runs no
// source: the total in force stays (HostAnswer::NotAsked).  (A governed
// computation that reads the total, C-2b, must carry its asking call to its
// workers before it adopts this.)

thread_local! {
    /// asking calls active on this thread
    static ASKING: std::cell::Cell<u32> = const { std::cell::Cell::new(0) };
    /// the first control exception the source raised during them
    static RAISED: std::cell::RefCell<Option<PyErr>> = const { std::cell::RefCell::new(None) };
}

/// Whether an asking call is active on this thread: a plain thread-local
/// read (no GIL, no Python code, no lock), so the ledger may call it as its
/// `may_ask` from anywhere.
fn asking_here() -> bool {
    ASKING.with(|a| a.get()) > 0
}

/// An asking call on this thread: what the source raises while it lives is
/// its own.  Thread-bound (neither Send nor Sync).
struct Asking(std::marker::PhantomData<*const ()>);

impl Asking {
    fn enter() -> Asking {
        ASKING.with(|a| a.set(a.get() + 1));
        Asking(std::marker::PhantomData)
    }

    /// End the call: the outermost one raises what the source raised.
    fn finish(self) -> PyResult<()> {
        let raised = if ASKING.with(|a| a.get()) == 1 { RAISED.with(|r| r.borrow_mut().take()) } else { None };
        drop(self);
        raised.map_or(Ok(()), Err)
    }
}

impl Drop for Asking {
    fn drop(&mut self) {
        let left = ASKING.with(|a| {
            a.set(a.get() - 1);
            a.get()
        });
        if left == 0 {
            // (an asking call that ended without finish, by an error of its
            // own: what the source raised is not left for the next call)
            RAISED.with(|r| r.borrow_mut().take());
        }
    }
}

/// The source's (or its answer's conversion's) error: an ordinary Exception
/// is an unreadable answer; anything else is kept for this thread's asking
/// call (the first one kept).
fn host_error(py: Python<'_>, e: PyErr) {
    if !e.is_instance_of::<pyo3::exceptions::PyException>(py) {
        RAISED.with(|r| {
            let mut r = r.borrow_mut();
            if r.is_none() {
                *r = Some(e);
            }
        });
    }
}

/// Register the host's engine memory total (no-cliffs plan C r13, r17):
/// `source()` returns (bytes, status, joint, rows) or None, status 0
/// observed, 1 zero, 2 nominal; rows, EVERY row that constrains the
/// engine's domain (not only those at the least figure), a list of (kind,
/// path, figure) with kind "cgroup" (path: its usage file), "address_space",
/// "data_segment", "physical", "windows_job", "windows_physical", or
/// anything else for a row that can't be measured (then the ledger is not
/// certified).  The ledger asks when the total is 100 ms old, with the GIL
/// taken for it and its own lock not held, and only on a thread with an
/// asking call (see `Asking`); an ordinary exception or a malformed answer
/// is unreadable (the nominal total, uncertified), while KeyboardInterrupt
/// and any other BaseException, from the call or from converting its answer,
/// go to the asking call.  The first registration stands.
#[pyfunction]
fn set_memory_total_source(source: Py<PyAny>) {
    use sagebrush_ledger::HostAnswer;
    // (asking_here is both the ledger's may_ask and this answer's first
    // check, registered together: they can't disagree)
    sagebrush_ledger::set_total_host_asking(
        move || {
            if !asking_here() {
                return HostAnswer::NotAsked;
            }
            Python::attach(|py| {
                let r = match source.call0(py) {
                    Ok(r) => r,
                    Err(e) => {
                        host_error(py, e);
                        return HostAnswer::Unreadable;
                    }
                };
                // (bytes, status, joint, [(kind, path, figure)]): every applicable
                // row (no-cliffs plan C r17 section 1.3), an unknown kind kept as
                // Unknown so that the ledger fails closed rather than drops it
                let answer = match r.extract::<Option<(u64, u32, bool, Vec<(String, Option<String>, u64)>)>>(py) {
                    Ok(a) => a,
                    Err(e) => {
                        host_error(py, e);
                        return HostAnswer::Unreadable;
                    }
                };
                let Some((bytes, status, joint, rows)) = answer else {
                    return HostAnswer::Unreadable;
                };
                let Some(status) = sagebrush_ledger::TotalStatus::from_code(status) else {
                    return HostAnswer::Unreadable;
                };
                let total = sagebrush_ledger::Total { bytes, status, joint, uncertified: false };
                let rows = rows
                    .into_iter()
                    .map(|(k, p, figure)| {
                        let kind = match (k.as_str(), p) {
                            ("cgroup", Some(p)) => sagebrush_ledger::MeasureKind::Cgroup(p),
                            ("address_space", _) => sagebrush_ledger::MeasureKind::AddressSpace,
                            ("data_segment", _) => sagebrush_ledger::MeasureKind::DataSegment,
                            ("physical", _) => sagebrush_ledger::MeasureKind::Physical,
                            ("windows_job", _) => sagebrush_ledger::MeasureKind::WindowsJob,
                            ("windows_physical", _) => sagebrush_ledger::MeasureKind::WindowsPhysical,
                            _ => sagebrush_ledger::MeasureKind::Unknown,
                        };
                        sagebrush_ledger::Row { kind, figure }
                    })
                    .collect();
                HostAnswer::Total(total, rows)
            })
        },
        asking_here,
    );
}

/// The ledger as the engine sees it now (diagnostics and the package's
/// tests): {"total", "status", "joint", "allowance", "live", "outstanding"}.
#[pyfunction]
fn ledger_snapshot(py: Python<'_>) -> PyResult<Bound<'_, PyDict>> {
    let asking = Asking::enter();
    let t = sagebrush_ledger::total();
    let d = PyDict::new(py);
    d.set_item("total", t.bytes)?;
    d.set_item("status", t.status.name())?;
    d.set_item("joint", t.joint)?;
    d.set_item("allowance", sagebrush_ledger::allowance(t))?;
    d.set_item("live", sagebrush_ledger::live_estimate())?;
    d.set_item("resident", sagebrush_ledger::resident_bytes())?;
    d.set_item("certified", sagebrush_ledger::certified())?;
    d.set_item("outstanding", sagebrush_ledger::outstanding_bytes())?;
    asking.finish()?;
    Ok(d)
}

// ---- live progress for Python routines (design-estimates-progress r4 §6):
// the same functions as the browser's builtin _progress
// (src/runtime/progress-module.ts), over engine/interrupt's native slots.

static PROGRESS_CALLS: std::sync::Mutex<Vec<sagebrush_interrupt::progress::Call>> = std::sync::Mutex::new(Vec::new());

fn with_call<T>(id: u64, f: impl FnOnce(&mut sagebrush_interrupt::progress::Call) -> T) -> Option<T> {
    let mut calls = PROGRESS_CALLS.lock().unwrap_or_else(|e| e.into_inner());
    calls.iter_mut().find(|c| c.id() == id).map(f)
}

/// A Python routine's call starts: its id (its parent: the innermost call
/// running on this thread).
#[pyfunction]
fn progress_begin(op: &str) -> u64 {
    use sagebrush_interrupt::progress;
    let c = progress::begin(progress::name_index(op));
    let id = c.id();
    PROGRESS_CALLS.lock().unwrap_or_else(|e| e.into_inner()).push(c);
    id
}

/// Its counts, from a JSON object (done, total, unit, stage, stage_index,
/// stage_count, work, fraction, beyond_forecast, memory_now_bytes,
/// memory_peak_bytes; null total, stage_count or fraction: unknown or
/// absent), written at most every 0.5 s.
#[pyfunction]
fn progress_update(id: u64, update: &str) -> PyResult<()> {
    use sagebrush_interrupt::progress;
    let u: serde_json::Value = serde_json::from_str(update).map_err(|e| err(format!("progress_update: {e}")))?;
    let num = |k: &str| u.get(k).and_then(|v| v.as_f64().map(|x| x.max(0.0) as u64));
    with_call(id, |c| {
        let r = c.report();
        if let Some(v) = u.get("stage").and_then(|v| v.as_str()) {
            r.stage = progress::name_index(v);
        }
        if let Some(v) = u.get("unit").and_then(|v| v.as_str()) {
            r.unit = progress::name_index(v);
        }
        if let Some(v) = num("stage_index") {
            r.stage_index = v;
        }
        if u.get("stage_count").is_some() {
            r.stage_count = num("stage_count");
        }
        if let Some(v) = num("done") {
            r.done = v;
        }
        if u.get("total").is_some() {
            r.total = num("total");
        }
        if let Some(v) = num("work") {
            r.work = v;
        }
        if u.get("fraction").is_some() {
            r.fraction = u.get("fraction").and_then(|v| v.as_f64());
        }
        if let Some(v) = u.get("beyond_forecast").and_then(|v| v.as_bool()) {
            r.beyond_forecast = v;
        }
        if let Some(v) = num("memory_now_bytes") {
            r.memory_now_bytes = v;
        }
        if let Some(v) = num("memory_peak_bytes") {
            r.memory_peak_bytes = v;
        }
        c.publish();
    });
    Ok(())
}

/// Its counts, written now.
#[pyfunction]
fn progress_flush(id: u64) {
    with_call(id, |c| c.flush());
}

/// It ended (on success, an error or an interrupt alike): its slot is free.
#[pyfunction]
fn progress_end(id: u64) {
    let c = {
        let mut calls = PROGRESS_CALLS.lock().unwrap_or_else(|e| e.into_inner());
        calls.iter().position(|c| c.id() == id).map(|k| calls.remove(k))
    };
    drop(c);
}

/// Every call in progress (Python routines' and the engines'), as a JSON
/// array of progress/1 records; read without the GIL, so it never waits on
/// a computation and any thread may call it.
#[pyfunction]
fn progress_snapshot(py: Python<'_>) -> String {
    py.detach(sagebrush_interrupt::progress::snapshot_json)
}

/// The names behind the slots' indices, as JSON.
#[pyfunction]
fn progress_tables() -> String {
    sagebrush_interrupt::progress::tables_json()
}

/// The native extension, `sagebrush._native`; each engine is a submodule,
/// re-exported by the pure-Python package (python/sagebrush).
/// Tests only (feature `test-hooks`, never in a released wheel): a guarded
/// call whose body ends by `kind`: "panic" (an ordinary Rust panic), "stop"
/// (a Stop at a check), "nested_gated" (waits until `_test_gate(True)`,
/// then one parallel wrapper entry on this, the owner, thread, and no
/// admission: the C-2c-i hot path's owner refresh, ordered after another
/// owner's invalidation), "nested_now" (that wrapper entry at once) or
/// anything else (it returns 1), for the delivery of a retained control
/// exception on every exit path (C-2c scope r2 section 2.1; astra2's
/// CORR-C2CI-3).
#[cfg(feature = "test-hooks")]
#[pyfunction(name = "_test_guarded")]
fn test_guarded(py: Python<'_>, kind: &str) -> PyResult<u32> {
    let kind = kind.to_string();
    let r = guarded(py, move || match kind.as_str() {
        "panic" => panic!("a body failure (test hook)"),
        "nested_gated" => {
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
            while !TEST_GATE.load(std::sync::atomic::Ordering::SeqCst) {
                if std::time::Instant::now() > deadline {
                    return 0;
                }
                std::thread::sleep(std::time::Duration::from_millis(1));
            }
            sagebrush_par::map_range(2, |i| i as u32).len() as u32
        }
        "nested_now" => sagebrush_par::map_range(2, |i| i as u32).len() as u32,
        "stop" => {
            sagebrush_interrupt::request();
            sagebrush_interrupt::check();
            0
        }
        _ => 1,
    });
    sagebrush_interrupt::clear();
    r
}

/// Tests only: the gate "nested_gated" waits on (set by the test once the
/// other owner's invalidation is published).
#[cfg(feature = "test-hooks")]
static TEST_GATE: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

#[cfg(feature = "test-hooks")]
#[pyfunction(name = "_test_gate")]
fn test_gate(open: bool) {
    TEST_GATE.store(open, std::sync::atomic::Ordering::SeqCst);
}

#[pymodule]
fn _native(m: &Bound<'_, PyModule>) -> PyResult<()> {
    let _ = MAIN.set(std::thread::current().id());
    #[cfg(feature = "test-hooks")]
    m.add_function(wrap_pyfunction!(test_guarded, m)?)?;
    #[cfg(feature = "test-hooks")]
    m.add_function(wrap_pyfunction!(test_gate, m)?)?;
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
    let raster = PyModule::new(m.py(), "raster")?;
    raster.add_function(wrap_pyfunction!(raster_render, &raster)?)?;
    raster.add_function(wrap_pyfunction!(raster_decode, &raster)?)?;
    m.add_submodule(&raster)?;
    m.add_function(wrap_pyfunction!(set_memory_share_source, m)?)?;
    m.add_function(wrap_pyfunction!(set_memory_total_source, m)?)?;
    m.add_function(wrap_pyfunction!(ledger_snapshot, m)?)?;
    serve::register(m)?;
    for f in [
        wrap_pyfunction!(progress_begin, m)?,
        wrap_pyfunction!(progress_update, m)?,
        wrap_pyfunction!(progress_flush, m)?,
        wrap_pyfunction!(progress_end, m)?,
        wrap_pyfunction!(progress_snapshot, m)?,
        wrap_pyfunction!(progress_tables, m)?,
    ] {
        m.add_function(f)?;
    }
    m.add_function(wrap_pyfunction!(sym_call, m)?)?;
    m.add_function(wrap_pyfunction!(mpoly_call, m)?)?;
    m.add_function(wrap_pyfunction!(call, m)?)
}
