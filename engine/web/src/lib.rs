//! Sagebrush engines as a plain wasm32 module with a JSON ABI, so that one
//! small JavaScript file (web/sagebrush.mjs) can embed and call it anywhere
//! WebAssembly runs, including chat artifacts that forbid fetch().
//!
//! ABI: sb_alloc(len) -> ptr; write a UTF-8 JSON request there;
//! sb_call(ptr, len) -> ptr of a UTF-8 JSON reply whose length is
//! sb_reply_len().  Requests are {"fn": NAME, ...args}; replies are
//! {"ok": RESULT} or {"error": MESSAGE}.  Single-threaded.

use num_bigint::BigInt;
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
    let reply = match serde_json::from_str::<Value>(req).map_err(|e| e.to_string()).and_then(|v| dispatch(&v)) {
        Ok(v) => json!({ "ok": v }),
        Err(e) => json!({ "error": e }),
    };
    let r = &mut *std::ptr::addr_of_mut!(REPLY);
    *r = reply.to_string().into_bytes();
    r.as_ptr()
}

fn u(v: &Value, k: &str) -> Result<u64, String> {
    v.get(k).and_then(Value::as_u64).ok_or_else(|| format!("missing integer argument '{}'", k))
}

fn character(n: u64, v: &Value) -> Result<Character, String> {
    match v.get("chi") {
        None | Some(Value::Null) => Ok(Character::trivial(n)),
        Some(c) => {
            let a = c.as_array().ok_or("chi must be [order, gens, vals]")?;
            let ints = |x: &Value| -> Vec<u64> { x.as_array().map(|a| a.iter().filter_map(Value::as_u64).collect()).unwrap_or_default() };
            Character::from_generators(n, a[0].as_u64().unwrap_or(1), &ints(&a[1]), &ints(&a[2]))
        }
    }
}

fn big(v: &[BigInt]) -> Vec<String> {
    v.iter().map(|x| x.to_string()).collect()
}

fn dispatch(v: &Value) -> Result<Value, String> {
    let f = v.get("fn").and_then(Value::as_str).ok_or("missing fn")?;
    match f {
        "characters" => {
            let n = u(v, "n")?;
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
                                 "chi": [chi.order, g.gens.clone(), vals] }));
            }
            Ok(json!(out))
        }
        "dims" => {
            use sagebrush_modsym::dims::*;
            let n = u(v, "n")?;
            let k = u(v, "k")? as usize;
            let eps = character(n, v)?.minimal();
            Ok(json!({ "order": eps.order, "conductor": eps.conductor(), "cusp": dim_cusp_forms(&eps, k),
                       "eisenstein": dim_eisenstein(&eps, k), "modsym": dim_modsym(&eps, k) }))
        }
        "charpoly" => {
            let (n, k, q) = (u(v, "n")?, u(v, "k").unwrap_or(2) as usize, u(v, "q")?);
            let sign = v.get("sign").and_then(Value::as_i64).unwrap_or(0) as i32;
            let eps = character(n, v)?;
            let e = sagebrush_modsym::general_exact::exact_charpoly(n, k, &eps, sign, q)?;
            let coeffs: Vec<Vec<String>> = e.coeffs.iter().map(|c| big(c)).collect();
            Ok(json!({ "m": e.m, "dim": e.dim, "coeffs": coeffs, "status": e.status, "checks": e.checks }))
        }
        "charpoly_mod" => {
            let (n, k, q) = (u(v, "n")?, u(v, "k").unwrap_or(2) as usize, u(v, "q")?);
            let sign = v.get("sign").and_then(Value::as_i64).unwrap_or(0) as i32;
            let eps = character(n, v)?.minimal();
            let sp = GeneralSpace::new(n, k, &eps, sign)?;
            Ok(json!({ "dim": sp.dimension(), "ell": sp.p, "charpoly": sp.hecke_charpoly(q)? }))
        }
        "weight2" => {
            // The weight-2 trivial-character engine: proven charpoly of T_q on M_2(N)^+.
            let e = sagebrush_modsym::exact::exact_charpoly(u(v, "n")?, u(v, "q")?)?;
            Ok(json!({ "dim": e.dim, "genus": e.genus, "coeffs": big(&e.coeffs), "status": e.status }))
        }
        "aplist" => {
            let a: Vec<i64> = v.get("a").and_then(Value::as_array).ok_or("missing a")?.iter().filter_map(Value::as_i64).collect();
            let a: [i64; 5] = a.try_into().map_err(|_| "a must have 5 entries")?;
            let e = sagebrush_ap::EllipticCurve::new(a)?;
            let out: Vec<Value> = sagebrush_ap::aplist(&e, u(v, "n")?).into_iter().map(|(p, x)| json!([p, x])).collect();
            Ok(json!(out))
        }
        _ => Err(format!("unknown fn '{}'", f)),
    }
}
