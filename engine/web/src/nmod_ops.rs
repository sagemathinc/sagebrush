//! Linear algebra and polynomial arithmetic over GF(p), p a prime below
//! 2^63: the engine ops behind Sage's and Magma's GF(p) matrices
//! (echelon form, rank, determinant, inverse, solving: `nmod_echelon`) and
//! GF(p)[x] (`nmod_poly_mul`, `nmod_poly_divrem`, `nmod_poly_gcd`).
//!
//! Each op admits a request by closed-form caps before any size-dependent
//! work (plan r3 97ad2109, sections 2 and 3): the whole request by
//! [`call`](crate::call) before serde parses it ([`OPS`], found by one
//! scan of the last top-level "fn" that owns no text); then the text of
//! each field, then the row/coefficient counts by scans that allocate
//! nothing, then the entries into one vector reserved exactly.  The serde
//! Value is dropped before the arithmetic, and the reply, the whole
//! `{"ok":...}` text, is written into one String reserved to its bound.
//! Products use the op's own transform tables (ntt::LocalTables), never
//! the shared cache.  Every loop asks for Stop at most about 2^16
//! multiply-adds apart.
//!
//! The peak live memory of an admitted call beyond the heap at its entry
//! (sb_call frees the previous reply first), with R the request bytes, E =
//! rows cols, la and lb the coefficient counts, N <= 2^16 the transform
//! length, phase by phase (parse / compute / reply), is bounded by the
//! constants below (checked at compile time):
//! - nmod_echelon: R + 28 E + 33 KiB             <= ECH_PEAK < 49 MiB;
//! - nmod_poly_mul: R + 8 (la + lb) + 128 N      <= MUL_PEAK = 12 MiB;
//! - nmod_poly_divrem: R + 16 (la + lb) + 32 ql + 128 N <= DIV_PEAK = 14 MiB;
//! - nmod_poly_gcd: R + 28 (la + lb)             <= GCD_PEAK = 2 MiB.

use sagebrush_arith::nmod::{is_prime, Modulus};
use sagebrush_arith::nmod_mat::Mat;
use sagebrush_arith::{nmod_poly, ntt};
use serde_json::{json, Map, Value};
use std::fmt::Write;

/// One row of the boundary table: the op's fixed caps.
pub struct Op {
    pub name: &'static str,
    /// The whole request, admitted before serde.
    pub max_request: usize,
    /// The bound on the call's peak live memory (bytes), and on its work
    /// (multiply-adds or butterflies), from the closed forms in the docs.
    pub peak: usize,
    pub work: u64,
    /// The op's own path (None: dispatch's, after the request cap).
    pub(crate) run: Option<fn(Map<String, Value>) -> Result<String, String>>,
}

const fn mul(a: usize, b: usize) -> usize {
    match a.checked_mul(b) {
        Some(x) => x,
        None => panic!("overflow"),
    }
}

const fn add(a: usize, b: usize) -> usize {
    match a.checked_add(b) {
        Some(x) => x,
        None => panic!("overflow"),
    }
}

const MIB: usize = 1 << 20;
/// Bytes of text per entry: at most 19 digits (below 2^63) and a separator.
const ENTRY_TEXT: usize = 20;
/// Room for the request's other fields.
const FIELDS: usize = 4096;
/// The longest transform of the polynomial ops, 2^16 points.
const NTT_N: usize = 1 << 16;

/// nmod_echelon: 1 <= rows, cols <= ECH_MAX_DIM, so E = rows cols <=
/// 2^20 (a 1023 x 1023 system with one right-hand side; an inverse
/// [A | I] up to n = 512).  The library sends a matrix only when its
/// transport fits the process's budget (lib/_sage_ffmat.py,
/// _engine_echelon_transport_fits).
pub const ECH_MAX_DIM: usize = 1024;
pub const ECH_MAX_TEXT: usize = mul(ENTRY_TEXT, mul(ECH_MAX_DIM, ECH_MAX_DIM));
pub const ECH_MAX_REQUEST: usize = add(ECH_MAX_TEXT, FIELDS);
/// parse: R + 20 E (serde's "m") + 8 E; compute: R + 8 E + 28 KiB (the
/// accumulator, a partial sum and the pivots); reply: R + 8 E + 20 E +
/// 8 KiB.
pub const ECH_PEAK: usize = add(add(ECH_MAX_REQUEST, mul(28, mul(ECH_MAX_DIM, ECH_MAX_DIM))), 33 * 1024);
/// Elimination and back substitution: at most 2 E min(rows, cols).
pub const ECH_WORK: u64 = 2 * (ECH_MAX_DIM * ECH_MAX_DIM) as u64 * ECH_MAX_DIM as u64;

/// nmod_poly_mul: 1 <= la, lb <= MUL_MAX_LEN, so N <= 2^16.
pub const MUL_MAX_LEN: usize = 1 << 15;
pub const MUL_MAX_REQUEST: usize = add(mul(2 * ENTRY_TEXT, MUL_MAX_LEN), FIELDS);
/// compute: R + 8 (la + lb) + 32 N (transform buffers) + 96 N (at most
/// three tables).
pub const MUL_PEAK: usize = add(add(MUL_MAX_REQUEST, mul(16, MUL_MAX_LEN)), mul(128, NTT_N));
/// 3 primes x 3 transforms of (N / 2) log N butterflies, plus 12 N.
pub const MUL_WORK: u64 = 9 * (NTT_N as u64 / 2) * 16 + 12 * NTT_N as u64;

/// nmod_poly_divrem: 1 <= lb, la <= DIV_MAX_LEN (Newton products shorter
/// than 2 max(ql, lb) <= 2^16).
pub const DIV_MAX_LEN: usize = 1 << 15;
pub const DIV_MAX_REQUEST: usize = add(mul(2 * ENTRY_TEXT, DIV_MAX_LEN), FIELDS);
/// compute: R + 8 (la + lb) + 8 (la + lb + 4 ql) + 32 N + 96 N.
pub const DIV_PEAK: usize = add(add(DIV_MAX_REQUEST, mul(8, mul(8, DIV_MAX_LEN))), mul(128, NTT_N));
/// Newton: 6 products of length 2^16 at most (the classical path: 59 2^15).
pub const DIV_WORK: u64 = 6 * MUL_WORK;

/// nmod_poly_gcd (Euclid): 1 <= la, lb <= GCD_MAX_LEN.
pub const GCD_MAX_LEN: usize = 1 << 14;
pub const GCD_MAX_REQUEST: usize = add(mul(2 * ENTRY_TEXT, GCD_MAX_LEN), FIELDS);
/// parse: R + 28 (la + lb); then R + 8 (la + 2 lb) + 20 lb.
pub const GCD_PEAK: usize = add(GCD_MAX_REQUEST, mul(28, 2 * GCD_MAX_LEN));
/// lb (la + lb) + 129 lb + 128: the quotient rows of all Euclid steps
/// number at most la + lb, each at most lb multiply-adds; an inversion
/// per step and the final normalization.
pub const GCD_WORK: u64 = (GCD_MAX_LEN as u64) * (2 * GCD_MAX_LEN as u64) + 129 * GCD_MAX_LEN as u64 + 128;

const _: () = assert!(ECH_PEAK <= 49 * MIB);
const _: () = assert!(MUL_PEAK <= 12 * MIB);
const _: () = assert!(DIV_PEAK <= 14 * MIB);
const _: () = assert!(GCD_PEAK <= 2 * MIB);

/// The ops whose requests are capped before serde (looked up by the exact
/// name of the request's last top-level "fn").
pub static OPS: [Op; 5] = [
    Op {
        name: "nmod_charpoly",
        max_request: crate::NMOD_MAX_REQUEST,
        peak: 19 * MIB,
        work: 1 << 27,
        run: None,
    },
    Op { name: "nmod_echelon", max_request: ECH_MAX_REQUEST, peak: ECH_PEAK, work: ECH_WORK, run: Some(echelon) },
    Op { name: "nmod_poly_mul", max_request: MUL_MAX_REQUEST, peak: MUL_PEAK, work: MUL_WORK, run: Some(poly_mul) },
    Op { name: "nmod_poly_divrem", max_request: DIV_MAX_REQUEST, peak: DIV_PEAK, work: DIV_WORK, run: Some(poly_divrem) },
    Op { name: "nmod_poly_gcd", max_request: GCD_MAX_REQUEST, peak: GCD_PEAK, work: GCD_WORK, run: Some(poly_gcd) },
];

/// The admitted request's own path (the request is at most op.max_request
/// bytes): parse, run, and the whole reply text.
pub(crate) fn run(op: &Op, req: &str, f: fn(Map<String, Value>) -> Result<String, String>) -> String {
    let parsed = {
        let _phase = sagebrush_interrupt::enter("parse");
        serde_json::from_str::<Value>(req)
    };
    let r = match parsed {
        Ok(Value::Object(o)) => f(o),
        Ok(_) => Err(format!("{}: the request is not an object", op.name)),
        Err(e) => Err(e.to_string()),
    };
    match r {
        Ok(s) => s,
        Err(e) => json!({ "error": e }).to_string(),
    }
}

/// The prime p (a decimal string) below 2^63.
fn prime(o: &Map<String, Value>, op: &str) -> Result<Modulus, String> {
    let p = o.get("p").and_then(Value::as_str).and_then(|s| s.parse::<u64>().ok());
    match p.filter(|&p| p < 1 << 63 && is_prime(p)) {
        Some(p) => Ok(Modulus::new(p)),
        None => Err(format!("{} needs a prime p below 2^63", op)),
    }
}

/// The string field `k`, taken out of the request (no copy).
fn take_str(o: &mut Map<String, Value>, k: &str, op: &str) -> Result<String, String> {
    match o.remove(k) {
        Some(Value::String(s)) => Ok(s),
        _ => Err(format!("{} needs the string '{}'", op, k)),
    }
}

/// The entries of one comma-separated list into `out` (each in [0, p)),
/// exactly `want` of them (or any number up to `want` when `exact` is
/// false); polled for Stop every 2^12 entries.
fn parse_list(s: &str, want: usize, exact: bool, p: u64, out: &mut Vec<u64>, op: &str) -> Result<usize, String> {
    let mut count = 0;
    for t in s.split(',') {
        count += 1;
        if count > want {
            return Err(format!("{}: more than {} entries in a row", op, want));
        }
        if count & 0xfff == 0 {
            sagebrush_interrupt::check_coarse();
        }
        match t.parse::<u64>() {
            Ok(x) if x < p && t.len() <= 19 && t.bytes().all(|c| c.is_ascii_digit()) => out.push(x),
            _ => return Err(format!("{}: entries must be integers in [0, p)", op)),
        }
    }
    if exact && count != want {
        return Err(format!("{}: a row with {} entries, not {}", op, count, want));
    }
    Ok(count)
}

/// A polynomial's coefficients (constant first, "c0,c1,..."), at most
/// `max` of them, at least one: counted without allocating, then parsed
/// into a vector reserved exactly.
fn poly(s: &str, max: usize, p: u64, op: &str) -> Result<Vec<u64>, String> {
    if s.len() > mul(ENTRY_TEXT, max) {
        return Err(format!("{}: a polynomial text of {} bytes, more than {}", op, s.len(), ENTRY_TEXT * max));
    }
    let n = if s.is_empty() { 0 } else { s.bytes().filter(|&c| c == b',').count() + 1 };
    if n == 0 {
        return Err(format!("{}: a zero polynomial (handled by the caller)", op));
    }
    if n > max {
        return Err(format!("{}: {} coefficients, more than {}", op, n, max));
    }
    let mut v = Vec::with_capacity(n);
    parse_list(s, n, true, p, &mut v, op)?;
    Ok(v)
}

/// The reply text, written into one reserved String: `{"ok":` + body + `}`.
struct Reply(String);

impl Reply {
    fn new(cap: usize) -> Reply {
        sagebrush_interrupt::check_coarse();
        let mut s = String::with_capacity(cap + 16);
        s.push_str("{\"ok\":");
        Reply(s)
    }
    fn raw(&mut self, t: &str) {
        self.0.push_str(t);
    }
    /// "c0,c1,..." as a JSON string.
    fn list(&mut self, v: &[u64]) {
        self.0.push('"');
        for (i, x) in v.iter().enumerate() {
            if i > 0 {
                self.0.push(',');
            }
            if i & 0xffff == 0xffff {
                sagebrush_interrupt::check_coarse();
            }
            let _ = write!(self.0, "{}", x);
        }
        self.0.push('"');
    }
    fn done(mut self) -> String {
        self.0.push('}');
        self.0
    }
}

/// nmod_echelon: {p, rows, cols, m: "a,b;c,d", reduced, want_rows} ->
/// {pivots: "0,2", det: "5", rows: "1,0;0,1" (with want_rows)}: the
/// (reduced, if asked) row echelon form (every row, the zero rows last),
/// the pivot columns, and the product of the pivots times the sign of the
/// row permutation (the determinant of a full-rank square matrix).  The
/// pivot of each column is its first nonzero entry from the current row
/// down, as in lib/_sage_ffmat.py's _echelon.
fn echelon(mut o: Map<String, Value>) -> Result<String, String> {
    const OP: &str = "nmod_echelon";
    let m = prime(&o, OP)?;
    let dim = |o: &Map<String, Value>, k: &str| o.get(k).and_then(Value::as_u64).filter(|&x| x >= 1 && x <= ECH_MAX_DIM as u64).map(|x| x as usize);
    let (Some(rows), Some(cols)) = (dim(&o, "rows"), dim(&o, "cols")) else {
        return Err(format!("{}: rows and cols must be integers in [1, {}]", OP, ECH_MAX_DIM));
    };
    let flag = |o: &Map<String, Value>, k: &str| o.get(k).and_then(Value::as_bool).unwrap_or(false);
    let (reduced, want_rows) = (flag(&o, "reduced"), flag(&o, "want_rows"));
    let s = take_str(&mut o, "m", OP)?;
    drop(o);
    let e = rows * cols;
    if s.len() > ENTRY_TEXT * e {
        return Err(format!("{}: the matrix text has {} bytes, more than {}", OP, s.len(), ENTRY_TEXT * e));
    }
    let n = s.bytes().filter(|&c| c == b';').count() + 1;
    if n != rows {
        return Err(format!("{}: {} rows, not {}", OP, n, rows));
    }
    let mut d = Vec::with_capacity(e);
    {
        let _phase = sagebrush_interrupt::enter("parse");
        for r in s.split(';') {
            sagebrush_interrupt::check_coarse();
            parse_list(r, cols, true, m.n, &mut d, OP)?;
        }
    }
    drop(s);
    let mut a = Mat { rows, cols, m, d };
    let (piv, det) = a.echelon(reduced, true);
    let _phase = sagebrush_interrupt::enter("reply");
    let mut out = Reply::new(if want_rows { ENTRY_TEXT * e } else { 0 } + ENTRY_TEXT * (piv.len() + 1) + 64);
    out.raw("{\"pivots\":\"");
    for (i, c) in piv.iter().enumerate() {
        if i > 0 {
            out.raw(",");
        }
        let _ = write!(out.0, "{}", c);
    }
    let _ = write!(out.0, "\",\"det\":\"{}\"", det);
    if want_rows {
        out.raw(",\"rows\":\"");
        for i in 0..rows {
            sagebrush_interrupt::check_coarse();
            if i > 0 {
                out.raw(";");
            }
            for (j, x) in a.row(i).iter().enumerate() {
                if j > 0 {
                    out.raw(",");
                }
                let _ = write!(out.0, "{}", x);
            }
        }
        out.raw("\"");
    }
    out.raw("}");
    Ok(out.done())
}

/// The prime and the two polynomials a and b of a polynomial op.
fn two_polys(mut o: Map<String, Value>, op: &str, max: usize) -> Result<(Modulus, Vec<u64>, Vec<u64>), String> {
    let m = prime(&o, op)?;
    let (sa, sb) = (take_str(&mut o, "a", op)?, take_str(&mut o, "b", op)?);
    drop(o);
    let _phase = sagebrush_interrupt::enter("parse");
    let a = poly(&sa, max, m.n, op)?;
    drop(sa);
    let b = poly(&sb, max, m.n, op)?;
    Ok((m, a, b))
}

/// nmod_poly_mul: {p, a: "c0,c1,...", b} -> the product's coefficients
/// (a and b nonzero: the caller answers a zero factor).
fn poly_mul(o: Map<String, Value>) -> Result<String, String> {
    let (m, a, b) = two_polys(o, "nmod_poly_mul", MUL_MAX_LEN)?;
    let len = nmod_poly::mul_table_len(a.len(), b.len());
    let c = if len == 0 {
        nmod_poly::mul(&a, &b, &m)
    } else {
        let lt = ntt::LocalTables::new(&m, len);
        nmod_poly::mul_in(&a, &b, &m, &lt)
    };
    drop((a, b));
    let _phase = sagebrush_interrupt::enter("reply");
    let mut out = Reply::new(ENTRY_TEXT * c.len() + 2);
    out.list(&c);
    Ok(out.done())
}

/// nmod_poly_divrem: {p, a, b} -> {q, r} with a = q b + r, deg r < deg b
/// (b nonzero; the caller raises for a zero divisor).
fn poly_divrem(o: Map<String, Value>) -> Result<String, String> {
    let (m, a, b) = two_polys(o, "nmod_poly_divrem", DIV_MAX_LEN)?;
    let b = nmod_poly::trim(b);
    if b.is_empty() {
        return Err("nmod_poly_divrem: division by zero polynomial".into());
    }
    let len = nmod_poly::divrem_table_len(a.len(), b.len());
    let (q, r) = if len == 0 {
        nmod_poly::divrem(&a, &b, &m)
    } else {
        let lt = ntt::LocalTables::new(&m, len);
        nmod_poly::divrem_in(&a, &b, &m, &lt)
    };
    drop((a, b));
    let _phase = sagebrush_interrupt::enter("reply");
    let mut out = Reply::new(ENTRY_TEXT * (q.len() + r.len()) + 16);
    out.raw("{\"q\":");
    out.list(&q);
    out.raw(",\"r\":");
    out.list(&nmod_poly::trim(r));
    out.raw("}");
    Ok(out.done())
}

/// nmod_poly_gcd: {p, a, b} -> the monic gcd's coefficients, by Euclid's
/// algorithm (a and b nonzero: the caller answers gcd(f, 0) = monic f).
fn poly_gcd(o: Map<String, Value>) -> Result<String, String> {
    let (m, a, b) = two_polys(o, "nmod_poly_gcd", GCD_MAX_LEN)?;
    let g = nmod_poly::gcd_classical(a, b, &m);
    let _phase = sagebrush_interrupt::enter("reply");
    let mut out = Reply::new(ENTRY_TEXT * g.len() + 2);
    out.list(&g);
    Ok(out.done())
}
