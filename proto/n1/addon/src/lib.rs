//! #825 N1 prototype: the engine's JSON ABI as an N-API add-on (design/native-desktop.md §4.1, §5.3).
//! Every call is armed with the run's token (host word, no SIGINT handler); `stop(token)` is the control
//! thread's compare-and-swap. The E3 exports time the kernel, encoding and decoding separately.
use napi::bindgen_prelude::{BigInt, Buffer, Int32Array};
use napi_derive::napi;
use sagebrush_bigint::BigInt as Big;
use sagebrush_interrupt as intr;
use std::time::Instant;

const INTERRUPTED: &str = "{\"interrupted\":true}";

fn token(t: &BigInt) -> napi::Result<u64> {
    let (neg, v, lossless) = t.get_u64();
    if neg || !lossless || v == 0 || v >> 63 != 0 {
        return Err(napi::Error::from_reason("token must be 1 ..= 2^63 - 1"));
    }
    Ok(v)
}

/// Run `f` armed with `t`; an interrupted call answers `interrupted` and leaves the add-on reusable.
fn armed<T>(t: u64, f: impl FnOnce() -> T, on_interrupt: impl FnOnce() -> T) -> napi::Result<T> {
    if !intr::host_arm(t) {
        return Err(napi::Error::from_reason("another engine call is armed"));
    }
    let r = intr::catch(f);
    intr::host_disarm(t);
    Ok(r.unwrap_or_else(|_| on_interrupt()))
}

#[napi]
pub fn call(req: String, t: BigInt) -> napi::Result<String> {
    armed(token(&t)?, || sagebrush_web::call(&req), || INTERRUPTED.to_string())
}

#[napi]
pub fn sym_call(req: String, t: BigInt) -> napi::Result<String> {
    armed(token(&t)?, || sagebrush_sym::api::call(&req), || INTERRUPTED.to_string())
}

#[napi]
pub fn mp_call(req: Buffer, t: BigInt) -> napi::Result<Buffer> {
    armed(token(&t)?, || sagebrush_mpoly::call_framed(&req).into(), || INTERRUPTED.as_bytes().to_vec().into())
}

/// The control thread's Stop: true only if `t` is the armed call and wasn't stopped yet.
#[napi]
pub fn stop(t: BigInt) -> napi::Result<bool> {
    Ok(intr::host_stop(token(&t)?))
}

/// A deliberately blocking engine call for the Stop pins: spins `ms` milliseconds, checking.
#[napi]
pub fn spin(ms: u32, t: BigInt) -> napi::Result<String> {
    armed(token(&t)?, || {
        let end = Instant::now() + std::time::Duration::from_millis(ms as u64);
        while Instant::now() < end {
            intr::check();
        }
        "{\"ok\":\"done\"}".to_string()
    }, || INTERRUPTED.to_string())
}

// ---- E3: the bounded binary experiment (uncounted)

#[napi(object)]
pub struct TimedText { pub reply: String, pub kernel_ms: f64, pub encode_ms: f64 }
#[napi(object)]
pub struct TimedBin { pub reply: Buffer, pub kernel_ms: f64, pub encode_ms: f64 }
#[napi(object)]
pub struct TimedDet { pub det: String, pub decode_ms: f64, pub kernel_ms: f64 }

fn curve(a: &[i64]) -> napi::Result<sagebrush_ap::EllipticCurve> {
    let a: [i64; 5] = a.try_into().map_err(|_| napi::Error::from_reason("a curve is [a1..a6] (5 integers)"))?;
    sagebrush_ap::EllipticCurve::new(a).map_err(napi::Error::from_reason)
}
fn ms(t: Instant) -> f64 { t.elapsed().as_secs_f64() * 1e3 }

/// aplist with engine/web's JSON reply shape ({"ok":[[p, ap|null], ...]}), kernel and encoding timed apart.
#[napi]
pub fn aplist_json(a: Vec<i64>, n: u32) -> napi::Result<TimedText> {
    let e = curve(&a)?;
    let t0 = Instant::now();
    let r = sagebrush_ap::aplist(&e, n as u64);
    let kernel_ms = ms(t0);
    let t1 = Instant::now();
    let reply = serde_json::json!({ "ok": r.into_iter().map(|(p, x)| serde_json::json!([p, x])).collect::<Vec<_>>() }).to_string();
    Ok(TimedText { reply, kernel_ms, encode_ms: ms(t1) })
}

/// aplist as a binary reply: little-endian pairs (u64 p, i64 ap), ap = i64::MIN for none.
#[napi]
pub fn aplist_bin(a: Vec<i64>, n: u32) -> napi::Result<TimedBin> {
    let e = curve(&a)?;
    let t0 = Instant::now();
    let r = sagebrush_ap::aplist(&e, n as u64);
    let kernel_ms = ms(t0);
    let t1 = Instant::now();
    let mut out = Vec::with_capacity(r.len() * 16);
    for (p, x) in r {
        out.extend_from_slice(&p.to_le_bytes());
        out.extend_from_slice(&x.unwrap_or(i64::MIN).to_le_bytes());
    }
    Ok(TimedBin { reply: out.into(), kernel_ms, encode_ms: ms(t1) })
}

/// det from engine/web's request text ("a,b;c,d"): decoding and the kernel timed apart.
#[napi]
pub fn det_text(m: String) -> napi::Result<TimedDet> {
    let t0 = Instant::now();
    let rows: Vec<Vec<Big>> = m.split(';').map(|r| r.split(',').map(|x| x.trim().parse::<Big>().map_err(|_| napi::Error::from_reason("bad entry"))).collect()).collect::<Result<_, _>>()?;
    let n = rows.len();
    if rows.iter().any(|r| r.len() != n) {
        return Err(napi::Error::from_reason("not square"));
    }
    let zm = sagebrush_arith::zmat::ZMat { rows: n, cols: n, d: rows.into_iter().flatten().collect() };
    let decode_ms = ms(t0);
    let t1 = Instant::now();
    let det = sagebrush_arith::zmat::det(&zm).to_string();
    Ok(TimedDet { det, decode_ms, kernel_ms: ms(t1) })
}

/// det from a binary request (row-major Int32Array, n x n): decoding and the kernel timed apart.
#[napi]
pub fn det_bin(m: Int32Array, n: u32) -> napi::Result<TimedDet> {
    let n = n as usize;
    if m.len() != n * n {
        return Err(napi::Error::from_reason("length is not n*n"));
    }
    let t0 = Instant::now();
    let zm = sagebrush_arith::zmat::ZMat { rows: n, cols: n, d: m.iter().map(|&x| Big::from(x as i64)).collect() };
    let decode_ms = ms(t0);
    let t1 = Instant::now();
    let det = sagebrush_arith::zmat::det(&zm).to_string();
    Ok(TimedDet { det, decode_ms, kernel_ms: ms(t1) })
}

/// Sato-Tate moments over the primes up to n (parallel over chunks, checking per prime): the parallel
/// kernel the Stop pins use, since sagebrush_ap::aplist itself has no interrupt check (an N1 finding).
#[napi]
pub fn moments(a: Vec<i64>, n: u32, t: BigInt) -> napi::Result<String> {
    let e = curve(&a)?;
    armed(token(&t)?, || {
        let (count, m) = sagebrush_ap::moments(&e, n as u64, 4);
        serde_json::json!({ "ok": [count, m] }).to_string()
    }, || INTERRUPTED.to_string())
}

/// aplist as a binary reply of little-endian f64 pairs (p, ap), NaN for none: exact for p < 2^53, and
/// read in JavaScript through a Float64Array view, with no BigInt.
#[napi]
pub fn aplist_f64(a: Vec<i64>, n: u32) -> napi::Result<TimedBin> {
    let e = curve(&a)?;
    let t0 = Instant::now();
    let r = sagebrush_ap::aplist(&e, n as u64);
    let kernel_ms = ms(t0);
    let t1 = Instant::now();
    let mut out = Vec::with_capacity(r.len() * 16);
    for (p, x) in r {
        out.extend_from_slice(&(p as f64).to_le_bytes());
        out.extend_from_slice(&x.map_or(f64::NAN, |v| v as f64).to_le_bytes());
    }
    Ok(TimedBin { reply: out.into(), kernel_ms, encode_ms: ms(t1) })
}
