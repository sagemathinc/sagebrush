//! Sagebrush engines as a plain wasm32 module with a JSON ABI, so that one
//! small JavaScript file (web/sagebrush.mjs) can embed and call it anywhere
//! WebAssembly runs, including chat artifacts that forbid fetch().
//!
//! ABI: sb_alloc(len) -> ptr; write a UTF-8 JSON request there;
//! sb_call(ptr, len) -> ptr of a UTF-8 JSON reply whose length is
//! sb_reply_len().  Requests are {"fn": NAME, ...args}; replies are
//! {"ok": RESULT} or {"error": MESSAGE}.  Single-threaded.  The functions
//! and their results mirror the Python bindings (py/src/lib.rs: modsym,
//! ap, mf); newspace/newforms factor with sagebrush-poly (pure Rust) and
//! "factor" exposes it.  Big integers are decimal strings.

use sagebrush_bigint::BigInt;
use sagebrush_modsym::dirichlet::DirichletGroup;
use sagebrush_modsym::general::{Character, GeneralSpace};
use serde_json::{json, Value};

static mut REPLY: Vec<u8> = Vec::new();

#[no_mangle]
pub extern "C" fn sb_alloc(len: usize) -> *mut u8 {
    let mut v = Vec::<u8>::with_capacity(len);
    let p = v.as_mut_ptr();
    std::mem::forget(v);
    p
}

#[no_mangle]
pub unsafe extern "C" fn sb_free(ptr: *mut u8, len: usize) {
    drop(Vec::from_raw_parts(ptr, 0, len));
}

#[no_mangle]
pub extern "C" fn sb_reply_len() -> usize {
    unsafe { (*std::ptr::addr_of!(REPLY)).len() }
}

#[no_mangle]
pub unsafe extern "C" fn sb_call(ptr: *const u8, len: usize) -> *const u8 {
    let req = std::str::from_utf8(std::slice::from_raw_parts(ptr, len)).unwrap_or("");
    let r = &mut *std::ptr::addr_of_mut!(REPLY);
    *r = call(req).into_bytes();
    r.as_ptr()
}

/// A symbolic-engine call (engine/sym/src/api.rs: "op\x1fargs..."); the
/// reply is in the same buffer as sb_call's.
#[no_mangle]
pub unsafe extern "C" fn sb_sym_call(ptr: *const u8, len: usize) -> *const u8 {
    let req = std::str::from_utf8(std::slice::from_raw_parts(ptr, len)).unwrap_or("");
    let r = &mut *std::ptr::addr_of_mut!(REPLY);
    *r = sagebrush_sym::api::call(req).into_bytes();
    r.as_ptr()
}

/// A multivariate polynomial call (engine/mpoly: binary framing of
/// sagebrush_mpoly::call); the reply is in the same buffer as sb_call's.
#[no_mangle]
pub unsafe extern "C" fn sb_mp_call(ptr: *const u8, len: usize) -> *const u8 {
    let req = std::slice::from_raw_parts(ptr, len);
    let r = &mut *std::ptr::addr_of_mut!(REPLY);
    *r = sagebrush_mpoly::call_framed(req);
    r.as_ptr()
}

/// After a trap (an error aborts in WebAssembly): "err\x1fKind\x1fmessage"
/// for the last symbolic error, or "" (an interrupt or a bug).
#[no_mangle]
pub unsafe extern "C" fn sb_last_error() -> *const u8 {
    let r = &mut *std::ptr::addr_of_mut!(REPLY);
    *r = match sagebrush_sym::err::take_last_error() {
        Some((k, m)) => format!("err\x1f{}\x1f{}", k, m),
        None => String::new(),
    }
    .into_bytes();
    r.as_ptr()
}

/// The same JSON call natively (examples/atlas.rs builds the atlas with it).
pub fn call(req: &str) -> String {
    match serde_json::from_str::<Value>(req).map_err(|e| e.to_string()).and_then(|v| dispatch(&v)) {
        Ok(v) => json!({ "ok": v }),
        Err(e) => json!({ "error": e }),
    }
    .to_string()
}

fn u(v: &Value, k: &str) -> Result<u64, String> {
    v.get(k).and_then(Value::as_u64).ok_or_else(|| format!("missing integer argument '{}'", k))
}

/// A size argument (a count, a bound, a weight, a number of points) at most
/// `max`, so that it means the same on every target: usize is 32 bits in
/// WebAssembly, and an unchecked cast changed 2^32 to 0 there.
fn size(v: &Value, k: &str, default: Option<u64>, max: u64) -> Result<usize, String> {
    let x = match (v.get(k), default) {
        (None | Some(Value::Null), Some(d)) => d,
        (Some(x), _) => x.as_u64().ok_or_else(|| format!("'{}' must be a nonnegative integer", k))?,
        (None | Some(Value::Null), None) => return Err(format!("missing integer argument '{}'", k)),
    };
    if x > max {
        return Err(format!("'{}' = {} is too large (at most {})", k, x, max));
    }
    usize::try_from(x).map_err(|_| format!("'{}' = {} is too large here", k, x))
}

/// The sign of a modular symbols space: -1, 0 or +1.
fn sign(v: &Value) -> Result<i32, String> {
    match v.get("sign").map(Value::as_i64) {
        None => Ok(0),
        Some(Some(s)) if (-1..=1).contains(&s) => Ok(s as i32),
        _ => Err("sign must be -1, 0 or 1".into()),
    }
}

/// What a class group result assumes: GRH; that the roots of unity found
/// are all, when that is not proven; and, when the analytic certificate
/// (h* R* below twice a proven lower bound for h R) did not go through,
/// the stopping rule's estimate of h R, which has no proven error bound.
fn assumes(w_proven: bool, certified: bool) -> Value {
    let mut a = vec!["GRH"];
    if !w_proven {
        a.push("the roots of unity found are all");
    }
    if !certified {
        a.push("h R is near its estimate (uncertified stopping rule)");
    }
    json!(a)
}

/// The level n >= 1.
fn level(v: &Value) -> Result<u64, String> {
    let n = u(v, "n")?;
    sagebrush_modsym::check_level(n)?;
    Ok(n)
}

/// The weight k >= 2 (default 2).
fn weight(v: &Value) -> Result<usize, String> {
    let k = size(v, "k", Some(2), (1 << 31) - 1).map_err(|_| "the weight must be an integer 2 <= k < 2^31".to_string())?;
    if k < 2 {
        return Err("the weight must be an integer 2 <= k < 2^31".into());
    }
    Ok(k)
}

/// A list of unsigned integers, every element checked.
fn u64s(v: &Value, what: &str) -> Result<Vec<u64>, String> {
    v.as_array().ok_or_else(|| format!("{} must be a list of nonnegative integers", what))?.iter()
        .map(|x| x.as_u64().ok_or_else(|| format!("{} must be a list of nonnegative integers", what)))
        .collect()
}

fn character(n: u64, v: &Value) -> Result<Character, String> {
    match v.get("chi") {
        None | Some(Value::Null) => Ok(Character::trivial(n)),
        Some(c) => {
            let bad = || "chi must be [order, gens, vals], gens and vals lists of the same length".to_string();
            let a = c.as_array().filter(|a| a.len() == 3).ok_or_else(bad)?;
            let order = a[0].as_u64().filter(|&o| o >= 1).ok_or_else(bad)?;
            let (gens, vals) = (u64s(&a[1], "gens")?, u64s(&a[2], "vals")?);
            if gens.len() != vals.len() {
                return Err(bad());
            }
            Character::from_generators(n, order, &gens, &vals)
        }
    }
}

fn curve(a: Option<&Value>) -> Result<sagebrush_ap::EllipticCurve, String> {
    let a: Vec<i64> = a.and_then(Value::as_array).ok_or("missing a")?.iter()
        .map(|x| x.as_i64().ok_or("a curve is [a1, a2, a3, a4, a6], integers"))
        .collect::<Result<_, _>>()?;
    let a: [i64; 5] = a.try_into().map_err(|_| "a curve is [a1, a2, a3, a4, a6]")?;
    sagebrush_ap::EllipticCurve::new(a)
}

fn exact_json(e: &sagebrush_modsym::exact::Exact) -> Value {
    json!({ "n": e.n, "q": e.q, "genus": e.genus, "cusps": e.cusps, "eisenstein": e.eis, "dim": e.dim,
            "charpoly": big(&e.coeffs), "primes_used": e.primes_used.len(), "bound_bits": e.bound_bits,
            "status": e.status, "checks": e.checks })
}

fn bigs(v: Option<&Value>) -> Result<Vec<BigInt>, String> {
    // the compact wire format: "c0,c1,..." (sagebrush.linalg and poly send it)
    if let Some(Value::String(s)) = v {
        if s.is_empty() {
            return Ok(vec![]);
        }
        return s.split(',').map(|t| t.parse::<BigInt>().map_err(|e| e.to_string())).collect();
    }
    v.and_then(Value::as_array)
        .ok_or("missing integer list")?
        .iter()
        .map(|x| match x {
            Value::String(s) => s.parse::<BigInt>().map_err(|e| e.to_string()),
            Value::Number(n) => n.as_i64().map(BigInt::from).ok_or_else(|| "bad integer".to_string()),
            _ => Err("integers are numbers or decimal strings".to_string()),
        })
        .collect()
}

fn big1(v: Option<&Value>) -> Result<BigInt, String> {
    match v {
        Some(Value::String(s)) => s.parse::<BigInt>().map_err(|e| e.to_string()),
        Some(Value::Number(n)) => n.as_i64().map(BigInt::from).ok_or_else(|| "bad integer".to_string()),
        _ => Err("missing integer argument".into()),
    }
}

/// A matrix as rows, every row the same length.
fn rect(v: Option<&Value>) -> Result<Vec<Vec<BigInt>>, String> {
    let rows = matrix(v)?;
    if rows.iter().any(|r| r.len() != rows[0].len()) {
        return Err("matrix rows of different lengths".into());
    }
    Ok(rows)
}

fn matrix(v: Option<&Value>) -> Result<Vec<Vec<BigInt>>, String> {
    // compact: rows separated by ';' ("" is the matrix with no rows)
    if let Some(Value::String(s)) = v {
        if s.is_empty() {
            return Ok(vec![]);
        }
        return s.split(';').map(|r| bigs(Some(&Value::String(r.to_string())))).collect();
    }
    v.and_then(Value::as_array).ok_or("missing matrix (a list of rows)")?.iter().map(|r| bigs(Some(r))).collect()
}

/// A matrix argument (rows of integers) as a ZMat; every row the same length.
fn zmat(v: Option<&Value>) -> Result<sagebrush_arith::zmat::ZMat, String> {
    let rows = matrix(v)?;
    let c = rows.first().map_or(0, |r| r.len());
    if rows.iter().any(|r| r.len() != c) {
        return Err("matrix rows of different lengths".into());
    }
    let r = rows.len();
    Ok(sagebrush_arith::zmat::ZMat { rows: r, cols: c, d: rows.into_iter().flatten().collect() })
}

/// A matrix result: rows of decimal strings, or with "wire": "csv" one
/// string "a,b;c,d".
fn zrows(m: &sagebrush_arith::zmat::ZMat, v: &Value) -> Value {
    if csv(v) {
        return json!((0..m.rows).map(|i| m.row(i).iter().map(|x| x.to_string()).collect::<Vec<_>>().join(",")).collect::<Vec<_>>().join(";"));
    }
    json!((0..m.rows).map(|i| big(m.row(i))).collect::<Vec<_>>())
}

/// A vector result in the requested wire format.
fn zvec(x: &[BigInt], v: &Value) -> Value {
    if csv(v) {
        return json!(x.iter().map(|c| c.to_string()).collect::<Vec<_>>().join(","));
    }
    json!(big(x))
}

fn csv(v: &Value) -> bool {
    v.get("wire").and_then(Value::as_str) == Some("csv")
}

fn big(v: &[BigInt]) -> Vec<String> {
    v.iter().map(|x| x.to_string()).collect()
}

// ---------------------------------------------------------------- permutation groups

fn perms(n: usize, v: Option<&Value>) -> Result<Vec<sagebrush_group::Perm>, String> {
    let arr = match v {
        None | Some(Value::Null) => return Ok(vec![]),
        Some(a) => a.as_array().ok_or("permutations are lists of images")?,
    };
    arr.iter()
        .map(|p| {
            let im: Vec<u32> = p.as_array().ok_or("a permutation is a list of images")?.iter().map(|x| x.as_u64().and_then(|x| u32::try_from(x).ok()).ok_or("images are point numbers")).collect::<Result<_, _>>()?;
            if im.len() != n {
                return Err(format!("a permutation of {} points, not {}", im.len(), n));
            }
            sagebrush_group::Perm::from_images(im)
        })
        .collect()
}

fn perm_json(gs: &[sagebrush_group::Perm]) -> Value {
    json!(gs.iter().map(|g| g.0.clone()).collect::<Vec<_>>())
}

/// {"fn": "perm_group", "n": n, "gens": [images...], "what": [...]} -> one
/// answer per requested property (points are 0..n-1).
fn perm_group(v: &Value) -> Result<Value, String> {
    use sagebrush_group::{Group, Rng};
    let n = size(v, "n", None, 1 << 20)?;
    let gens = perms(n, v.get("gens"))?;
    let g = Group::new(n, gens)?;
    let what: Vec<String> = match v.get("what") {
        Some(Value::String(s)) => vec![s.clone()],
        Some(Value::Array(a)) => a.iter().map(|x| x.as_str().map(String::from).ok_or("what must be names")).collect::<Result<_, _>>()?,
        _ => vec!["order".into()],
    };
    let point = || -> Result<u32, String> { v.get("point").and_then(Value::as_u64).filter(|&x| x < n as u64).map(|x| x as u32).ok_or_else(|| "missing or bad point".to_string()) };
    let mut rng = Rng::new(v.get("seed").and_then(Value::as_u64).unwrap_or(1));
    let mut out = serde_json::Map::new();
    for w in &what {
        let r = match w.as_str() {
            "order" => json!(g.order().to_string()),
            "orbits" => json!(g.orbits()),
            "orbit" => json!(g.orbit(point()?)),
            "is_transitive" => json!(g.is_transitive()),
            "is_primitive" => json!(g.is_primitive()),
            "is_abelian" => json!(g.is_abelian()),
            "is_solvable" => json!(g.is_solvable()),
            "transitivity" => json!(g.transitivity()),
            "blocks" => json!(g.blocks_containing(v.get("point").and_then(Value::as_u64).filter(|&x| x < n as u64).ok_or("bad point")? as u32)),
            "min_block" => {
                let seed: Vec<u32> = u64s(v.get("block").ok_or("missing block")?, "block")?.into_iter().map(|x| if x < n as u64 { Ok(x as u32) } else { Err("a block is a list of points") }).collect::<Result<_, _>>()?;
                if seed.is_empty() || seed.iter().any(|&x| x as usize >= n) {
                    return Err("bad block".into());
                }
                json!(g.min_block(&seed))
            }
            "block_system" => {
                let b: Vec<u32> = u64s(v.get("block").ok_or("missing block")?, "block")?.into_iter().map(|x| u32::try_from(x).ok().filter(|&x| (x as usize) < n).ok_or("a block is a list of points")).collect::<Result<_, _>>()?;
                json!(g.block_system(&b))
            }
            "stabilizer" => {
                let s = g.stabilizer(point()?);
                json!({"gens": perm_json(&s.gens), "order": s.order().to_string()})
            }
            "normal_closure" => {
                let x = perms(n, v.get("sub"))?;
                let c = g.normal_closure(&x);
                json!({"gens": perm_json(&c.gens), "order": c.order().to_string()})
            }
            "derived_subgroup" => {
                let d = g.derived_subgroup();
                json!({"gens": perm_json(&d.gens), "order": d.order().to_string()})
            }
            "derived_series" => json!(g.derived_series().iter().map(|d| json!({"gens": perm_json(&d.gens), "order": d.order().to_string()})).collect::<Vec<_>>()),
            "contains" => {
                let x = perms(n, Some(&json!([v.get("g").ok_or("missing g")?])))?;
                json!(g.contains(&x[0]))
            }
            "random" => {
                let k = size(v, "count", Some(1), 1 << 20)?;
                perm_json(&(0..k).map(|_| g.random(&mut rng)).collect::<Vec<_>>())
            }
            "elements" => {
                let limit = v.get("limit").and_then(Value::as_u64).unwrap_or(100_000);
                match g.elements(limit) {
                    Some(es) => perm_json(&es),
                    None => return Err(format!("the group has more than {} elements", limit)),
                }
            }
            "cycle_type_counts" => {
                let limit = v.get("limit").and_then(Value::as_u64).unwrap_or(200_000);
                let samples = size(v, "samples", Some(10_000), 1 << 26)?;
                let (c, exact) = g.cycle_type_counts(limit, samples, &mut rng);
                json!({"exact": exact, "counts": c.into_iter().map(|(t, k)| json!([t, k])).collect::<Vec<_>>()})
            }
            "is_normal" => {
                let sub = Group::new(n, perms(n, v.get("sub"))?)?;
                json!(g.contains_group(&sub) && g.is_normal(&sub))
            }
            "is_subgroup" => {
                // is the group generated by "sub" a subgroup of this one?
                let sub = Group::new(n, perms(n, v.get("sub"))?)?;
                json!(g.contains_group(&sub))
            }
            "base" => json!(g.chain.base()),
            "strong_gens" => perm_json(&g.chain.strong_gens()),
            other => return Err(format!("unknown permutation group property {}", other)),
        };
        out.insert(w.clone(), r);
    }
    Ok(Value::Object(out))
}

/// {"fn": "perm_group_named", "name": ..., "n": n} -> {"n", "gens"}
fn perm_group_named(v: &Value) -> Result<Value, String> {
    use sagebrush_group::named::*;
    let n = size(v, "n", None, 1 << 20)? as u64;
    let name = v.get("name").and_then(Value::as_str).ok_or("missing name")?;
    let g = match name {
        "symmetric" => symmetric(n as usize),
        "alternating" => alternating(n as usize),
        "cyclic" => cyclic(n as usize),
        "dihedral" => dihedral(n as usize),
        "mathieu" => mathieu(n as usize)?,
        "agl1" => agl1(n)?,
        "psl2" => pl2(n, false)?,
        "pgl2" => pl2(n, true)?,
        _ => return Err(format!("unknown group {}", name)),
    };
    Ok(json!({"n": g.n, "gens": perm_json(&g.gens)}))
}

fn dispatch(v: &Value) -> Result<Value, String> {
    let f = v.get("fn").and_then(Value::as_str).ok_or("missing fn")?;
    match f {
        "perm_group" => perm_group(v),
        "perm_group_named" => perm_group_named(v),
        "characters" => {
            let n = level(v)?;
            if n > 10_000_000 {
                return Err("characters: the modulus must be at most 10^7".into());
            }
            let g = DirichletGroup::new(n);
            let mut seen = vec![false; g.order() as usize];
            let mut out = vec![];
            for c in 0..g.order() {
                if seen[c as usize] {
                    continue;
                }
                let vec = g.vector(c);
                let chi = g.character(&vec);
                for j in 1..=chi.order {
                    if sagebrush_modsym::p1::gcd(j, chi.order) == 1 {
                        let w: Vec<u64> = vec.iter().map(|&x| x * j).collect();
                        seen[g.index(&w) as usize] = true;
                    }
                }
                let vals: Vec<u64> = g.gens.iter().map(|&x| chi.exponent(x as i64).unwrap() as u64).collect();
                out.push(json!({ "order": chi.order, "conductor": chi.conductor(), "even": chi.is_even(),
                                 "gens": g.gens.clone(), "vals": vals.clone(), "chi": [chi.order, g.gens.clone(), vals] }));
            }
            Ok(json!(out))
        }
        "dims" => {
            use sagebrush_modsym::dims::*;
            let (n, k) = (level(v)?, weight(v)?);
            let eps = character(n, v)?.minimal();
            // dim S^new(N) = sum over M (cond | M | N) of beta(N/M) dim S(M), beta = mu * mu.
            let f = eps.conductor();
            let beta = |x: u64| -> i64 {
                sagebrush_modsym::exact::factor(x).iter().map(|&(_, e)| match e { 1 => -2, 2 => 1, _ => 0 }).product()
            };
            let new: i64 = (1..=n).filter(|m| n % m == 0 && m % f == 0).map(|m| beta(n / m) * dim_cusp_forms(&eps.restrict(m), k) as i64).sum();
            Ok(json!({ "order": eps.order, "conductor": f, "cusp": dim_cusp_forms(&eps, k),
                       "eisenstein": dim_eisenstein(&eps, k), "modsym": dim_modsym(&eps, k), "new": new }))
        }
        "charpoly" => {
            let (n, k, q) = (level(v)?, weight(v)?, u(v, "q")?);
            let sign = sign(v)?;
            let eps = character(n, v)?;
            let e = sagebrush_modsym::general_exact::exact_charpoly(n, k, &eps, sign, q)?;
            let coeffs: Vec<Vec<String>> = e.coeffs.iter().map(|c| big(c)).collect();
            Ok(json!({ "m": e.m, "dim": e.dim, "coeffs": coeffs, "primes_used": e.primes_used.len(), "status": e.status, "checks": e.checks }))
        }
        "charpoly_mod" => {
            let (n, k, q) = (level(v)?, weight(v)?, u(v, "q")?);
            let sign = sign(v)?;
            let eps = character(n, v)?.minimal();
            let sp = GeneralSpace::new(n, k, &eps, sign)?;
            Ok(json!({ "dim": sp.dimension(), "ell": sp.p, "zeta": sp.zeta, "charpoly": sp.hecke_charpoly(q)? }))
        }
        // ---- sagebrush.modsym: weight 2, trivial character, sign +1 ----
        "hecke_charpoly" => {
            let (n, q) = (level(v)?, u(v, "q")?);
            let p = u(v, "p").unwrap_or(67108859);
            let r = sagebrush_modsym::hecke_charpoly(n, q, p)?;
            Ok(json!({ "symbols": r.symbols, "gens": r.gens, "dim": r.dim, "charpoly": r.charpoly, "hash": r.hash(),
                       "eisenstein_root": r.eisenstein_root(), "ms": r.ms.to_vec() }))
        }
        "weight2" | "charpoly_exact" => Ok(exact_json(&sagebrush_modsym::exact::exact_charpoly(level(v)?, u(v, "q")?)?)),
        "batch_exact" => {
            let levels = u64s(v.get("levels").ok_or("missing levels")?, "levels")?;
            levels.iter().try_for_each(|&n| sagebrush_modsym::check_level(n))?;
            let q = u(v, "q")?;
            let rs = sagebrush_modsym::exact::batch_exact(&levels, q);
            Ok(json!(levels.iter().zip(rs).map(|(&n, r)| match r {
                Ok(e) => exact_json(&e),
                Err(e) => json!({ "n": n, "error": e }),
            }).collect::<Vec<_>>()))
        }
        "level_data" => {
            let (psi, g, c, e, dim) = sagebrush_modsym::exact::level_data(level(v)?);
            Ok(json!({ "psi": psi, "genus": g, "cusps": c, "eisenstein": e, "dim": dim }))
        }
        "commute" => {
            let p = u(v, "p").unwrap_or(67108859);
            Ok(json!(sagebrush_modsym::hecke_commute(level(v)?, u(v, "q")?, u(v, "r")?, p)?))
        }
        "estimate" => {
            let (n, q) = (level(v)?, u(v, "q")?);
            sagebrush_modsym::validate(n, q, None)?;
            let e = sagebrush_modsym::estimate::estimate(n, q);
            Ok(json!({ "symbols": e.symbols, "dim": e.dim, "genus": e.genus, "primes": e.primes, "primes_max": e.primes_max,
                       "bytes_modp": e.bytes_modp, "bytes_exact": e.bytes_exact, "seconds_modp": e.seconds_modp,
                       "seconds_exact": e.seconds_exact }))
        }
        "estimate_newforms" => {
            let e = sagebrush_modsym::estimate::newforms(level(v)?, weight(v)?, size(v, "bound", Some(100), 1 << 24)?);
            Ok(json!({ "n": e.n, "k": e.k, "bound": e.bound, "dim_new": e.dim_new, "dim_top": e.dim_top, "levels": e.levels, "symbols": e.symbols,
                       "primes": e.primes, "trace_primes": e.trace_primes, "terms": e.terms, "term_names": sagebrush_modsym::estimate::NEWFORMS_TERMS,
                       "seconds": e.seconds, "seconds_low": e.seconds_low, "seconds_high": e.seconds_high, "bytes": e.bytes }))
        }
        "rational_newforms" => {
            let r = sagebrush_modsym::newforms::rational_newforms(level(v)?, u(v, "bound").unwrap_or(1000), 40)?;
            let forms = json!(r.forms.into_iter().map(|f| f.ap).collect::<Vec<_>>());
            // "details": what the forms come with (checked, not proven)
            Ok(if v.get("details").and_then(Value::as_bool) == Some(true) {
                json!({ "forms": forms, "status": r.status, "checks": r.checks })
            } else {
                forms
            })
        }
        // ---- sagebrush.nf / arith / matrix: engine/classgroup ----
        "factor_integer" => {
            let n = big1(v.get("n"))?;
            if n.sign() == sagebrush_bigint::Sign::NoSign {
                return Err("factor of 0".into());
            }
            Ok(json!(sagebrush_classgroup::api::factor_integer(&n)?.iter().map(|(p, e)| json!([p.to_string(), e])).collect::<Vec<_>>()))
        }
        "is_prime" => Ok(json!(sagebrush_classgroup::api::is_prime(&big1(v.get("n"))?))),
        "nf_data" => {
            let d = sagebrush_classgroup::api::nf_data(&bigs(v.get("f"))?)?;
            Ok(json!({ "degree": d.degree, "r1": d.r1, "r2": d.r2, "disc": d.disc.to_string(), "index": d.index.to_string(),
                       "basis": d.basis.iter().map(|r| big(r)).collect::<Vec<_>>(), "den": d.den.to_string(), "w": d.w, "w_proven": d.w_proven }))
        }
        "primes_above" => {
            let ps = sagebrush_classgroup::api::primes_above(&bigs(v.get("f"))?, u(v, "p")?)?;
            Ok(json!(ps.iter().map(|q| json!({ "p": q.p, "e": q.e, "f": q.f, "pi": big(&q.pi), "pi_den": q.pi_den.to_string() })).collect::<Vec<_>>()))
        }
        "bnf" => {
            let b = sagebrush_classgroup::api::bnf(&bigs(v.get("f"))?)?;
            Ok(json!({ "degree": b.degree, "r1": b.r1, "r2": b.r2, "disc": b.disc.to_string(), "h": b.h.to_string(),
                       "cyc": big(&b.cyc), "regulator": b.regulator, "w": b.w, "w_proven": b.w_proven, "certified": b.certified, "assumes": assumes(b.w_proven, b.certified) }))
        }
        "bnf_relations" => {
            let bad = || "extra must be a list of primes".to_string();
            let extra: Vec<u64> = match v.get("extra") {
                None | Some(Value::Null) => vec![],
                Some(e) => e.as_array().ok_or_else(bad)?.iter()
                    .map(|x| x.as_u64().or_else(|| x.as_str().and_then(|s| s.parse().ok())).ok_or_else(bad))
                    .collect::<Result<_, _>>()?,
            };
            let d = sagebrush_classgroup::api::bnf_relations(&bigs(v.get("f"))?, &extra)?;
            let b = &d.bnf;
            Ok(json!({ "degree": b.degree, "r1": b.r1, "r2": b.r2, "disc": b.disc.to_string(), "h": b.h.to_string(),
                       "cyc": big(&b.cyc), "regulator": b.regulator, "w": b.w, "w_proven": b.w_proven, "certified": b.certified, "assumes": assumes(b.w_proven, b.certified),
                       "fb": d.fb.iter().map(|&(p, e, f)| json!([p, e, f])).collect::<Vec<_>>(),
                       "rels": d.rels.iter().map(|r| r.iter().map(|&(i, k)| json!([i, k])).collect::<Vec<_>>()).collect::<Vec<_>>(),
                       "elems": d.elems.iter().map(|(num, den)| json!([big(num), den.to_string()])).collect::<Vec<_>>() }))
        }
        "quadratic_class_group" => {
            let (h, cyc, reg, certified) = sagebrush_classgroup::api::quadratic(&big1(v.get("d"))?)?;
            Ok(json!({ "h": h.to_string(), "cyc": big(&cyc), "regulator": reg, "certified": certified, "assumes": assumes(true, certified) }))
        }
        "hermite_form" => Ok(json!(sagebrush_classgroup::api::hermite(&rect(v.get("m"))?).iter().map(|r| big(r)).collect::<Vec<_>>())),
        "elementary_divisors" => Ok(json!(big(&sagebrush_classgroup::api::elementary_divisors(&rect(v.get("m"))?)))),
        "lll" => Ok(json!(sagebrush_classgroup::api::lll(&rect(v.get("m"))?).iter().map(|r| big(r)).collect::<Vec<_>>())),
        "complex_roots" => {
            let digits = size(v, "digits", Some(15), 100_000)?;
            let r = sagebrush_classgroup::api::complex_roots(&bigs(v.get("f"))?, digits)?;
            Ok(json!(r.iter().map(|(re, im, e)| json!([re, im, e])).collect::<Vec<_>>()))
        }
        "factor_mod" => {
            let f = bigs(v.get("f"))?;
            let p = u(v, "p")?;
            if !(2..1u64 << 32).contains(&p) || !sagebrush_modsym::exact::is_prime(p) {
                return Err(format!("factor_mod needs a prime p < 2^32, not {}", p));
            }
            // (zero modulo p, not only over Z: [4, 8, 4] mod 2 trapped)
            let bp = BigInt::from(p);
            if f.iter().all(|c| (c % &bp).sign() == sagebrush_bigint::Sign::NoSign) {
                return Err("factor of the zero polynomial (modulo p)".into());
            }
            Ok(json!(sagebrush_poly::factor_mod(&f, p).iter().map(|(g, e)| json!([g, e])).collect::<Vec<_>>()))
        }
        // ---- Galois groups over Q and the transitive groups nTk (engine/galois) ----
        "galois_group" => {
            let f = bigs(v.get("f"))?;
            let proof = match v.get("proof") {
                Some(Value::Bool(true)) => sagebrush_galois::Proof::Always,
                Some(Value::Bool(false)) => sagebrush_galois::Proof::Never,
                _ => sagebrush_galois::Proof::WhenCheap,
            };
            let g = sagebrush_galois::galois_group_with(&f, proof)?;
            let t = &sagebrush_galois::tables::transitive_groups(g.degree)[g.number - 1];
            Ok(json!({ "n": g.degree, "k": g.number, "order": g.order.to_string(), "name": g.name, "proven": g.proven,
                       "log": g.log, "gens": perm_json(&t.gens) }))
        }
        "transitive_group" => {
            let n = size(v, "n", None, 1 << 20)?;
            if n < 1 || n > sagebrush_galois::tables::MAX_DEGREE {
                return Err(format!("transitive groups are available for degrees 1 to {}", sagebrush_galois::tables::MAX_DEGREE));
            }
            let all = sagebrush_galois::tables::transitive_groups(n);
            match v.get("k").and_then(Value::as_u64) {
                None => Ok(json!(all.len())),
                Some(k) if k >= 1 && k <= all.len() as u64 => {
                    let t = &all[k as usize - 1];
                    Ok(json!({ "n": n, "k": k, "order": t.order.to_string(), "name": t.name, "gens": perm_json(&t.gens) }))
                }
                Some(k) => Err(format!("there are {} transitive groups of degree {}, not {}", all.len(), n, k)),
            }
        }
        // ---- sagebrush.poly: factoring in Z[x] (pure Rust) ----
        "factor" => {
            let f = bigs(v.get("f"))?;
            if f.iter().all(|c| c.sign() == sagebrush_bigint::Sign::NoSign) {
                return Err("factor of the zero polynomial".into());
            }
            let (c, fs) = sagebrush_poly::factor(&f);
            Ok(json!({ "content": c.to_string(), "factors": fs.iter().map(|(g, e)| json!([big(g), e])).collect::<Vec<_>>() }))
        }
        // ---- sagebrush.linalg: exact matrices over Z (and Q, scaled) ----
        "mat_det" => {
            let a = zmat(v.get("m"))?;
            if a.rows != a.cols {
                return Err("mat_det of a non-square matrix".into());
            }
            Ok(json!(sagebrush_arith::zmat::det(&a).to_string()))
        }
        "mat_rank" => Ok(json!(sagebrush_arith::zmat::rank(&zmat(v.get("m"))?))),
        "mat_rref" => {
            let (n, den, piv) = sagebrush_arith::zmat::rref(&zmat(v.get("m"))?);
            Ok(json!({ "rows": zrows(&n, v), "den": den.to_string(), "pivots": piv }))
        }
        "mat_solve" => {
            let a = zmat(v.get("a"))?;
            let b = zmat(v.get("b"))?;
            if a.rows != a.cols || a.rows != b.rows {
                return Err("mat_solve needs a square matrix and a right-hand side with as many rows".into());
            }
            Ok(match sagebrush_arith::zmat::solve(&a, &b) {
                None => Value::Null,
                Some((x, den)) => json!({ "rows": zrows(&x, v), "den": den.to_string() }),
            })
        }
        "mat_inverse" => {
            let a = zmat(v.get("m"))?;
            if a.rows != a.cols {
                return Err("mat_inverse of a non-square matrix".into());
            }
            Ok(match sagebrush_arith::zmat::inverse(&a) {
                None => Value::Null,
                Some((x, den)) => json!({ "rows": zrows(&x, v), "den": den.to_string() }),
            })
        }
        "mat_charpoly" => {
            let a = zmat(v.get("m"))?;
            if a.rows != a.cols {
                return Err("mat_charpoly of a non-square matrix".into());
            }
            Ok(zvec(&sagebrush_arith::zmat::charpoly(&a), v))
        }
        "mat_kernel" => Ok(zrows(&sagebrush_arith::zmat::kernel(&zmat(v.get("m"))?), v)),
        "mat_mul" => {
            let (a, b) = (zmat(v.get("a"))?, zmat(v.get("b"))?);
            if a.cols != b.rows {
                return Err("mat_mul: matrices of incompatible sizes".into());
            }
            Ok(zrows(&a.mul(&b), v))
        }
        // ---- sagebrush.poly: products and gcds in Z[x] ----
        "poly_mul" => Ok(zvec(
            &sagebrush_arith::zpoly::mul(&sagebrush_arith::zpoly::trim(bigs(v.get("a"))?), &sagebrush_arith::zpoly::trim(bigs(v.get("b"))?)),
            v,
        )),
        "poly_gcd" => Ok(zvec(&sagebrush_arith::zpoly::gcd(&bigs(v.get("a"))?, &bigs(v.get("b"))?), v)),
        "poly_divexact" => {
            let a = sagebrush_arith::zpoly::trim(bigs(v.get("a"))?);
            let b = sagebrush_arith::zpoly::trim(bigs(v.get("b"))?);
            if b.is_empty() {
                return Err("division by zero polynomial".into());
            }
            Ok(sagebrush_arith::zpoly::divexact(&a, &b).map_or(Value::Null, |q| zvec(&q, v)))
        }
        // ---- sagebrush.mf: Galois orbits of newforms, factored here ----
        "newspace" | "newforms" => {
            let (n, k) = (level(v)?, weight(v)?);
            let eps = character(n, v)?;
            let fac = |f: &[BigInt]| sagebrush_poly::factor(f).1;
            let r = sagebrush_modsym::newspace::newspace_orbits(n, k, &eps, &fac)?;
            let mut out = json!({ "dim": r.dim, "order": r.m, "orbit_dims": r.dims, "orbit_charpolys": r.orbits.iter().map(|o| big(o)).collect::<Vec<_>>(),
                                  "T": r.ops, "status": r.status, "checks": r.checks });
            if f == "newforms" {
                let bound = size(v, "bound", Some(100), 1 << 24)?;
                if bound < 1 {
                    return Err("bound must be at least 1".into());
                }
                let tr = sagebrush_modsym::traces::orbit_traces(n, k, &eps, &r, bound)?;
                // LMFDB order: by dimension, then trace form
                let mut orbits: Vec<(usize, Vec<BigInt>, Vec<BigInt>)> = r.dims.iter().cloned().zip(tr).zip(r.orbits.iter().cloned()).map(|((d, t), u)| (d, t, u)).collect();
                orbits.sort();
                out["newforms"] = json!(orbits.iter().enumerate().map(|(i, (dim, t, u))| {
                    let mut x = i;
                    let mut s = vec![];
                    loop {
                        s.push((b'a' + (x % 26) as u8) as char);
                        x /= 26;
                        if x == 0 {
                            break;
                        }
                    }
                    let letter: String = s.iter().rev().collect();
                    json!({ "letter": letter, "dim": dim, "traces": big(t), "charpoly": big(u) })
                }).collect::<Vec<_>>());
            }
            Ok(out)
        }
        // ---- sagebrush.ap: traces of Frobenius of elliptic curves ----
        "ap" => {
            let p = u(v, "p")?;
            if p < 2 || !sagebrush_modsym::exact::is_prime(p) || p >= 1 << 62 {
                return Err(format!("p = {} must be a prime below 2^62", p));
            }
            Ok(json!(curve(v.get("a"))?.ap(p)))
        }
        "aplist" => {
            let e = curve(v.get("a"))?;
            Ok(json!(sagebrush_ap::aplist(&e, u(v, "n")?).into_iter().map(|(p, x)| json!([p, x])).collect::<Vec<_>>()))
        }
        "ec_point_search" => {
            let b = bigs(v.get("b"))?;
            let p = |x: &BigInt| x.to_string().parse::<i128>().map_err(|_| "b-invariants too large for the point search".to_string());
            if b.len() != 3 {
                return Err("b is [b2, b4, b6]".into());
            }
            let xs = sagebrush_ap::search::x_coordinates(p(&b[0])?, p(&b[1])?, p(&b[2])?, u(v, "rmax")?, u(v, "smax")?, size(v, "limit", Some(100000), 1 << 28)?)?;
            Ok(json!(xs.iter().map(|(r, s)| json!([r.to_string(), s])).collect::<Vec<_>>()))
        }
        "quartic_search" => {
            let p = |k: &str| -> Result<i128, String> {
                big1(v.get(k))?.to_string().parse::<i128>().map_err(|_| format!("{} is too large for the quartic search", k))
            };
            let max_cost = v.get("max_cost").and_then(Value::as_f64).unwrap_or(1e10) as u64;
            let s = sagebrush_ap::quartic::search(p("I")?, p("J")?, max_cost)?;
            let qs: Vec<Value> = s.quartics.iter().map(|f| json!(f.iter().map(|x| x.to_string()).collect::<Vec<_>>())).collect();
            Ok(json!({ "quartics": qs, "work": s.work, "amax": s.amax, "cost": s.cost }))
        }
        "aplist_many" => {
            let es = v.get("curves").and_then(Value::as_array).ok_or("missing curves")?.iter().map(|c| curve(Some(c))).collect::<Result<Vec<_>, _>>()?;
            let r = sagebrush_ap::aplist_many(&es, u(v, "n")?);
            Ok(json!(r.into_iter().map(|l| l.into_iter().map(|(p, x)| json!([p, x])).collect::<Vec<_>>()).collect::<Vec<_>>()))
        }
        "moments" => {
            let e = curve(v.get("a"))?;
            let (count, m) = sagebrush_ap::moments(&e, u(v, "n")?, size(v, "kmax", Some(4), 64)?);
            Ok(json!([count, m]))
        }
        _ => Err(format!("unknown fn '{}'", f)),
    }
}
