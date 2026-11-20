//! Truncated power series over Z and Q, the Euler product and sigma_k: the
//! engine ops behind Sage mode's series and modular forms arithmetic
//! (`series_mul`, `series_pow`, `series_euler`, `sigma_table`), on
//! sagebrush_arith::zseries's one residue backend; and products in Z[x]
//! (`poly_mul`, sagebrush_arith::zmul: Kronecker substitution on one NTT
//! product with the call's own tables) and Q[x] (`qpoly_mul`,
//! sagebrush_arith::qpoly: the common denominators, zmul's product, then
//! each coefficient reduced), admitted the same way.
//!
//! **Admission, before anything sized by the request is allocated:**
//! 1. the request's bytes, at most the op's `max_request`, by
//!    [`call`](crate::call) before any parse (the op found by one scan of the
//!    last top-level "fn" that owns no text);
//! 2. a strict parse of the flat request object that allocates nothing:
//!    exactly the op's keys, each at most once (an unknown key is refused
//!    before its value is read, so no nested value is ever descended), string
//!    values borrowed (an escape is refused: none is legal here), integers
//!    and booleans typed; nothing else is accepted;
//! 3. one scan of each coefficient list (zseries::scan): the grammar
//!    `-?(0|[1-9a-f][0-9a-f]*)`, the counts, the largest token, the limbs,
//!    the valuation;
//! 4. the op's closed forms (zseries's `*_admit`): output bits, primes,
//!    work, peak bytes and the reply's bytes, in checked u64, against the
//!    caps and the op's `work` and `peak` below;
//! 5. then the work, into one reply String reserved to its bound.
//!
//! **Replies:** series_mul and series_pow give `{"c": "c0,c1,...", "d": "d"}`
//! (raw, or over Z) or `{"c": "c0,n1/d1,..."}` (reduced, over Q: each
//! coefficient in lowest terms), in hex, trailing zeros dropped (the zero
//! series is "").  series_euler gives "1,-1,-1,0,0,1,..."; sigma_table its n
//! values in hex.  poly_mul gives the product's coefficients in hex, trailing
//! zeros dropped (the zero polynomial is ""); qpoly_mul the same, each
//! coefficient `[-]num[/den]` in lowest terms; qpoly_clear one factor's
//! denominators cleared, `{"d": d, "c": "c0,c1,..."}`; zpoly_divrem the
//! quotient and remainder in Z[x] by Sage's rule, `{"q": ..., "r": ...}`
//! (its work metered, its memory on a word ledger).  qpoly_mul's admission has
//! two phases: the lcms' memory from the scans, their work metered (a named
//! refusal at its limit); then the product's closed forms from the actual
//! lcms, before any of its allocations.

use sagebrush_arith::{pdivrem, qpoly, zmul, zseries};
use serde_json::json;

/// One row of the series ops' table: the op's caps and its path.
pub struct SeriesOp {
    pub name: &'static str,
    /// The whole request, admitted before any parse.
    pub max_request: usize,
    /// The most bytes and word operations an admitted call may need
    /// (zseries's closed forms, checked per request).
    pub peak: u64,
    pub work: u64,
    pub(crate) run: fn(&str, &SeriesOp) -> Result<String, String>,
}

const MIB: u64 = 1 << 20;

/// A series op's request: two lists of at most 2^17 coefficients of at most
/// 1024 hex digits would be 268 MB of text, so the request cap (16 MiB) is
/// what bounds the input; the output is bounded by n beta <= 2^26.
pub const SERIES_MAX_REQUEST: usize = 1 << 24;
/// series_euler's and sigma_table's requests: scalars only.
pub const SMALL_MAX_REQUEST: usize = 256;

// (the peaks: the largest of the closed forms over the admitted corners, 53.3
// MiB for the series ops and 29.0 MiB for sigma_table, with room; the
// corner test in tests/series_ops.rs checks them)
pub static OPS: [SeriesOp; 8] = [
    SeriesOp { name: "series_mul", max_request: SERIES_MAX_REQUEST, peak: 64 * MIB, work: zseries::WORK_MAX, run: series_mul },
    SeriesOp { name: "series_pow", max_request: SERIES_MAX_REQUEST, peak: 64 * MIB, work: zseries::WORK_MAX, run: series_pow },
    SeriesOp { name: "series_euler", max_request: SMALL_MAX_REQUEST, peak: 8 * MIB, work: zseries::WORK_MAX, run: series_euler },
    SeriesOp { name: "sigma_table", max_request: SMALL_MAX_REQUEST, peak: 32 * MIB, work: zseries::WORK_MAX, run: sigma_table },
    // (each request is admitted on its own closed-form peak and work, zmul::admit)
    SeriesOp { name: "poly_mul", max_request: zmul::REQUEST_MAX as usize, peak: zmul::PEAK_MAX, work: zmul::WORK_MAX, run: poly_mul },
    // (each request admitted in two phases, qpoly::admit_a and admit_b)
    SeriesOp { name: "qpoly_mul", max_request: zmul::REQUEST_MAX as usize, peak: zmul::PEAK_MAX, work: zmul::WORK_MAX, run: qpoly_mul },
    // (one factor's denominators cleared: qpoly's phase A and scaling)
    SeriesOp { name: "qpoly_clear", max_request: zmul::REQUEST_MAX as usize, peak: zmul::PEAK_MAX, work: zmul::WORK_MAX, run: qpoly_clear },
    // (division with remainder in Z[x], Sage's rule: the work metered and the
    // memory on a word ledger, both within these caps)
    SeriesOp { name: "zpoly_divrem", max_request: zmul::REQUEST_MAX as usize, peak: zmul::PEAK_MAX, work: zmul::WORK_MAX, run: zpoly_divrem },
];

/// The admitted request's path: run, then the reply text (an error reply
/// carries "internal" for a failed proved invariant).
pub(crate) fn run(op: &SeriesOp, req: &str) -> String {
    match (op.run)(req, op) {
        Ok(s) => s,
        Err(e) if e.contains(zseries::INTERNAL_PREFIX) => json!({ "error": e, "internal": true }).to_string(),
        Err(e) => json!({ "error": e }).to_string(),
    }
}

/// A value of the flat request object.
#[derive(Clone, Copy, Debug, PartialEq)]
enum Val<'a> {
    Str(&'a str),
    Int(i128),
    Bool(bool),
}

/// The request's values for `keys` (in that order; "fn" is checked by the
/// caller's lookup), refusing anything else: an unknown key (before its
/// value), a duplicate, an escape, a nested value, a malformed number.  One
/// pass over the bytes; nothing allocated.
fn fields<'a, const K: usize>(req: &'a str, keys: [&str; K], op: &str) -> Result<[Option<Val<'a>>; K], String> {
    let b = req.as_bytes();
    let mut i = 0;
    let ws = |i: &mut usize| {
        while *i < b.len() && matches!(b[*i], b' ' | b'\t' | b'\n' | b'\r') {
            *i += 1;
        }
    };
    // a string's bytes (borrowed: no escapes, no control characters)
    let string = |i: &mut usize| -> Result<&'a str, String> {
        *i += 1;
        let start = *i;
        while *i < b.len() {
            match b[*i] {
                b'"' => {
                    let s = &req[start..*i];
                    *i += 1;
                    return Ok(s);
                }
                b'\\' => return Err(format!("{}: escapes are not accepted in the request", op)),
                c if c < 0x20 => return Err(format!("{}: a control character in a string", op)),
                _ => *i += 1,
            }
        }
        Err(format!("{}: an unterminated string", op))
    };
    let mut out: [Option<Val<'a>>; K] = [None; K];
    let mut seen_fn = false;
    ws(&mut i);
    if b.get(i) != Some(&b'{') {
        return Err(format!("{}: the request is not an object", op));
    }
    i += 1;
    ws(&mut i);
    if b.get(i) == Some(&b'}') {
        return Err(format!("{}: an empty request", op));
    }
    loop {
        ws(&mut i);
        if b.get(i) != Some(&b'"') {
            return Err(format!("{}: a key must be a string", op));
        }
        let key = string(&mut i)?;
        let slot = if key == "fn" {
            if seen_fn {
                return Err(format!("{}: the key \"fn\" appears twice", op));
            }
            seen_fn = true;
            None
        } else {
            match keys.iter().position(|&k| k == key) {
                Some(j) if out[j].is_some() => return Err(format!("{}: the key {:?} appears twice", op, key)),
                Some(j) => Some(j),
                None => return Err(format!("{}: unknown key {:?} (accepted: fn, {})", op, zseries::preview(key, 40), keys.join(", "))),
            }
        };
        ws(&mut i);
        if b.get(i) != Some(&b':') {
            return Err(format!("{}: a key without a value", op));
        }
        i += 1;
        ws(&mut i);
        let v = match b.get(i) {
            Some(b'"') => Val::Str(string(&mut i)?),
            Some(b't') if b[i..].starts_with(b"true") => {
                i += 4;
                Val::Bool(true)
            }
            Some(b'f') if b[i..].starts_with(b"false") => {
                i += 5;
                Val::Bool(false)
            }
            Some(&c) if c == b'-' || c.is_ascii_digit() => {
                let start = i;
                if c == b'-' {
                    i += 1;
                }
                let digits = i;
                while i < b.len() && b[i].is_ascii_digit() {
                    i += 1;
                }
                let d = &req[digits..i];
                if d.is_empty() || d.len() > 20 || (d.len() > 1 && d.starts_with('0')) || matches!(b.get(i), Some(b'.' | b'e' | b'E')) {
                    return Err(format!("{}: {:?} must be an integer", op, key));
                }
                Val::Int(req[start..i].parse::<i128>().map_err(|_| format!("{}: {:?} must be an integer", op, key))?)
            }
            _ => return Err(format!("{}: {:?} must be a string, an integer or a boolean (no lists or objects)", op, key)),
        };
        if let Some(j) = slot {
            out[j] = Some(v);
        } else if !matches!(v, Val::Str(_)) {
            return Err(format!("{}: \"fn\" must be a string", op));
        }
        ws(&mut i);
        match b.get(i) {
            Some(b',') => i += 1,
            Some(b'}') => {
                i += 1;
                ws(&mut i);
                if i != b.len() {
                    return Err(format!("{}: text after the request object", op));
                }
                return Ok(out);
            }
            _ => return Err(format!("{}: expected ',' or '}}' in the request", op)),
        }
    }
}

fn get_str<'a>(v: Option<Val<'a>>, key: &str, op: &str) -> Result<Option<&'a str>, String> {
    match v {
        None => Ok(None),
        Some(Val::Str(s)) => Ok(Some(s)),
        Some(_) => Err(format!("{}: {:?} must be a string", op, key)),
    }
}

fn get_bool(v: Option<Val>, key: &str, op: &str) -> Result<bool, String> {
    match v {
        None => Ok(false),
        Some(Val::Bool(x)) => Ok(x),
        Some(_) => Err(format!("{}: {:?} must be true or false", op, key)),
    }
}

/// A required nonnegative integer at most `max`; past it, the refusal names
/// the cap and how to stay under it.
fn get_size(v: Option<Val>, key: &str, max: u64, how: &str, op: &str) -> Result<u64, String> {
    match v {
        None => Err(format!("{}: missing integer argument {:?}", op, key)),
        Some(Val::Int(x)) if x < 0 => Err(format!("{}: {:?} must be at least 0", op, key)),
        Some(Val::Int(x)) if x > max as i128 => Err(format!("{}: {} = {} is more than {} ({})", op, key, x, max, how)),
        Some(Val::Int(x)) => Ok(x as u64),
        Some(_) => Err(format!("{}: {:?} must be an integer", op, key)),
    }
}

fn need<'a>(v: Option<&'a str>, key: &str, op: &str) -> Result<&'a str, String> {
    v.ok_or_else(|| format!("{}: missing string argument {:?}", op, key))
}

/// The reply buffer, reserved to the admitted bound: `{"ok":` ... `}`.
fn reply(adm: &zseries::Admitted, op: &SeriesOp, f: impl FnOnce(&mut String) -> Result<(), String>) -> Result<String, String> {
    if adm.peak > op.peak {
        return Err(format!("{}: needs {} bytes of memory, more than {} (fewer coefficients per call)", op.name, adm.peak, op.peak));
    }
    if adm.work > op.work {
        return Err(format!("{}: needs {} word operations, more than {} (fewer coefficients per call)", op.name, adm.work, op.work));
    }
    sagebrush_interrupt::check_coarse();
    let mut out = String::with_capacity(adm.reply as usize + 16);
    out.push_str("{\"ok\":");
    f(&mut out)?;
    out.push('}');
    Ok(out)
}

const SERIES_HOW: &str = "fewer coefficients per call; a longer truncated product is a future op";

/// series_mul: {a, b, n, da?, db?, raw?} -> (a/da)(b/db) mod q^n.
fn series_mul(req: &str, op: &SeriesOp) -> Result<String, String> {
    let name = op.name;
    let [a, b, n, da, db, raw] = fields(req, ["a", "b", "n", "da", "db", "raw"], name)?;
    let n = get_size(n, "n", zseries::SERIES_N_MAX as u64, SERIES_HOW, name)? as usize;
    let (a, b) = (need(get_str(a, "a", name)?, "a", name)?, need(get_str(b, "b", name)?, "b", name)?);
    let (da, db) = (get_str(da, "da", name)?, get_str(db, "db", name)?);
    let raw = get_bool(raw, "raw", name)?;
    let pre = |e: String| format!("{}: {}", name, e);
    let ca = zseries::scan(a, n, true).map_err(pre)?;
    let cb = zseries::scan(b, n, true).map_err(pre)?;
    let cda = da.map(zseries::scan_denominator).transpose().map_err(pre)?;
    let cdb = db.map(zseries::scan_denominator).transpose().map_err(pre)?;
    let adm = zseries::mul_admit(&ca, &cb, cda.as_ref(), cdb.as_ref(), n, raw, req.len() as u64).map_err(pre)?;
    reply(&adm, op, |out| zseries::mul(&ca, &cb, cda.as_ref(), cdb.as_ref(), n, raw, &adm, out).map_err(pre))
}

/// series_pow: {a, k, n, da?, raw?} -> (a/da)^k mod q^n, k >= 0.
fn series_pow(req: &str, op: &SeriesOp) -> Result<String, String> {
    let name = op.name;
    let [a, k, n, da, raw] = fields(req, ["a", "k", "n", "da", "raw"], name)?;
    let n = get_size(n, "n", zseries::SERIES_N_MAX as u64, SERIES_HOW, name)? as usize;
    let k = match k {
        Some(Val::Int(x)) if x < 0 => return Err(format!("{}: k = {} must be at least 0 (a series inverse is another op)", name, x)),
        Some(Val::Int(x)) if x > u64::MAX as i128 => return Err(format!("{}: k = {} is too large", name, x)),
        Some(Val::Int(x)) => x as u64,
        Some(_) => return Err(format!("{}: \"k\" must be an integer", name)),
        None => return Err(format!("{}: missing integer argument \"k\"", name)),
    };
    let a = need(get_str(a, "a", name)?, "a", name)?;
    let da = get_str(da, "da", name)?;
    let raw = get_bool(raw, "raw", name)?;
    let pre = |e: String| format!("{}: {}", name, e);
    let ca = zseries::scan(a, n, true).map_err(pre)?;
    let cda = da.map(zseries::scan_denominator).transpose().map_err(pre)?;
    // (the answers decided from the scan, each a reply of a few bytes: the
    // empty series, the constant 1, zero)
    let zero = "{\"ok\":{\"c\":\"\",\"d\":\"1\"}}".to_string();
    if n == 0 {
        return Ok(zero);
    }
    if k == 0 {
        return Ok("{\"ok\":{\"c\":\"1\",\"d\":\"1\"}}".to_string());
    }
    if ca.all_zero {
        return Ok(zero);
    }
    let v = ca.valuation as u64;
    if v >= 1 && k > (n as u64 - 1) / v {
        // k v >= n, decided by division: (q^v g)^k = q^(kv) g^k = 0 mod q^n
        return Ok(zero);
    }
    let adm = zseries::pow_admit(&ca, k, cda.as_ref(), n, raw, req.len() as u64).map_err(pre)?;
    reply(&adm, op, |out| zseries::pow(&ca, k, cda.as_ref(), n, raw, &adm, out).map_err(pre))
}

/// series_euler: {n} -> prod_{m >= 1} (1 - q^m) mod q^n.
fn series_euler(req: &str, op: &SeriesOp) -> Result<String, String> {
    let name = op.name;
    let [n] = fields(req, ["n"], name)?;
    let n = get_size(n, "n", zseries::EULER_N_MAX as u64, "fewer coefficients per call", name)? as usize;
    let adm = zseries::euler_admit(n, req.len() as u64).map_err(|e| format!("{}: {}", name, e))?;
    reply(&adm, op, |out| {
        zseries::euler(n, out);
        Ok(())
    })
}

/// sigma_table: {k, n} -> sigma_k(1), ..., sigma_k(n).
fn sigma_table(req: &str, op: &SeriesOp) -> Result<String, String> {
    let name = op.name;
    let [k, n] = fields(req, ["k", "n"], name)?;
    let n = get_size(n, "n", zseries::SIGMA_N_MAX as u64, "fewer values per call", name)? as usize;
    let k = get_size(k, "k", zseries::SIGMA_K_MAX, "a smaller k", name)?;
    if n == 0 {
        return Ok("{\"ok\":\"\"}".to_string());
    }
    let pre = |e: String| format!("{}: {}", name, e);
    let adm = zseries::sigma_admit(k, n, req.len() as u64).map_err(pre)?;
    reply(&adm, op, |out| zseries::sigma(k, n, &adm, out).map_err(pre))
}

/// poly_mul: {a, b} -> a b in Z[x] (hex coefficients, constant first).
fn poly_mul(req: &str, op: &SeriesOp) -> Result<String, String> {
    let name = op.name;
    let [a, b] = fields(req, ["a", "b"], name)?;
    let (a, b) = (need(get_str(a, "a", name)?, "a", name)?, need(get_str(b, "b", name)?, "b", name)?);
    let pre = |e: String| format!("{}: {}", name, e);
    let ca = zmul::scan(a).map_err(pre)?;
    let cb = zmul::scan(b).map_err(pre)?;
    match zmul::admit(&ca, &cb, req.len() as u64, &zmul::CAPS).map_err(pre)? {
        // (an empty or all-zero factor: the zero polynomial)
        None => Ok("{\"ok\":\"\"}".to_string()),
        Some(plan) => {
            // (the row's caps first, then the product, then the reply reserved:
            // the transforms and the reply are never live together)
            if plan.admitted.peak > op.peak || plan.admitted.work > op.work {
                return reply(&plan.admitted, op, |_| Ok(()));
            }
            let product = zmul::product(&ca, &cb, &plan);
            reply(&plan.admitted, op, |out| {
                out.push('"');
                zmul::emit(&product, &plan, out).map_err(pre)?;
                out.push('"');
                Ok(())
            })
        }
    }
}

/// qpoly_mul: {a, b} -> a b in Q[x] (tokens `[-]num[/den]` in hex, constant
/// first; the reply's coefficients in lowest terms).
fn qpoly_mul(req: &str, op: &SeriesOp) -> Result<String, String> {
    let name = op.name;
    let [a, b] = fields(req, ["a", "b"], name)?;
    let (a, b) = (need(get_str(a, "a", name)?, "a", name)?, need(get_str(b, "b", name)?, "b", name)?);
    let pre = |e: String| format!("{}: {}", name, e);
    let (ca, cb) = (qpoly::scan(a).map_err(pre)?, qpoly::scan(b).map_err(pre)?);
    qpoly::reply(&ca, &cb, req.len() as u64, &qpoly::CAPS).map_err(pre)
}

/// qpoly_clear: {a} -> {"d": the lcm of the nonzero numerators'
/// denominators, as given, "c": the integer tokens n_i (d / d_i), one per
/// token} (hex).
fn qpoly_clear(req: &str, op: &SeriesOp) -> Result<String, String> {
    let name = op.name;
    let [a] = fields(req, ["a"], name)?;
    let a = need(get_str(a, "a", name)?, "a", name)?;
    let pre = |e: String| format!("{}: {}", name, e);
    let ca = qpoly::scan(a).map_err(pre)?;
    qpoly::clear_reply(&ca, req.len() as u64, &qpoly::CAPS).map_err(pre)
}

/// zpoly_divrem: {a, b} -> {"q": q, "r": r} with a = q b + r in Z[x] by
/// Sage's rule (hex integers, constant first; trailing zeros dropped).
fn zpoly_divrem(req: &str, op: &SeriesOp) -> Result<String, String> {
    let name = op.name;
    let [a, b] = fields(req, ["a", "b"], name)?;
    let (a, b) = (need(get_str(a, "a", name)?, "a", name)?, need(get_str(b, "b", name)?, "b", name)?);
    let pre = |e: String| format!("{}: {}", name, e);
    let (ca, cb) = (qpoly::scan_ints(a).map_err(pre)?, qpoly::scan_ints(b).map_err(pre)?);
    pdivrem::reply_z(&ca, &cb, req.len() as u64, &qpoly::CAPS).map_err(pre)
}
