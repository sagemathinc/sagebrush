//! Truncated power series over Z and Q, the Euler product and a table of
//! sigma_k: the arithmetic behind engine/web's series ops (series_mul,
//! series_pow, series_euler, sigma_table).
//!
//! **One backend.**  Every op reduces its inputs modulo P primes of a fixed
//! table ([`NTT_PRIME_ROOTS`]: primes p = 1 mod 2^32 above 2^61, with their
//! roots), straight from their hex text; computes in each GF(p) with the
//! prime's own transform table ([`LocalTables::with_root`]) and
//! [`nmod_poly::mul_in`]; and reconstructs each output value by Chinese
//! remaindering ([`MultiCrt`]), writing its hex.  With every value v of an
//! op below 2^beta in absolute value (beta from the op's closed form, the
//! strict convention), the product of the P = ceil((beta + 1) / 61) primes
//! exceeds 2^(61 P) >= 2^(beta + 1), so the signed reconstruction in
//! (-M/2, M/2] is exact.  No big-integer multiplication, division or
//! conversion of dashu's runs: the work is the sum of the closed forms
//! below, each of them proved for its loops, and an op is admitted
//! ([`Admitted`]) before anything sized by the request is allocated.
//!
//! **Over Q** a series is integer numerators and one positive denominator.
//! The result's denominator (d_a d_b, or d_a^k) is one more reconstructed
//! value, its residues formed from the denominators' residues.  Reduced
//! output (the default) writes each coefficient c_i / d in lowest terms:
//! g_i = gcd(c_i, d) by [`coprime::gcd_in_place`] (metered against its proved
//! bound), then c_i / g_i and d / g_i from the residues times g_i^-1, which
//! needs primes not dividing g_i.  So when a denominator is present the P
//! primes are the first P of the table dividing neither denominator: at
//! most floor(bits / 61) <= P - 1 table primes (all above 2^61) divide a
//! number below 2^bits, so the first 2P hold P of them.
//!
//! The work bounds are in word operations (multiply-adds, butterflies,
//! limb steps), the units of `nmod_poly::mul_work` and `ntt::table_work`;
//! the tests count the loops ([`crate::counted`]) and check every op's
//! count against its bound.

use crate::coprime::{self, Meter};
use crate::counted;
use crate::crt::{crt_bytes, MultiCrt};
use crate::nmod::Modulus;
use crate::nmod_poly;
use crate::ntt::{self, LocalTables};
pub use crate::series_primes::NTT_PRIME_ROOTS;
use sagebrush_bigint::{BigInt, Sign};
use std::fmt::Write;

/// The most primes an op reconstructs with: beta <= BETA_MAX needs at most
/// ceil((2^14 + 1) / 61) = 269 (the table holds twice as many, for the
/// selection that skips the primes dividing a denominator).
pub const P_MAX: usize = 269;
/// The most coefficients of a series op (inputs and output): its own
/// transform table, 32 bytes a point, has at most 2^18 points (8 MiB).
pub const SERIES_N_MAX: usize = 1 << 17;
/// The most values of sigma_table.
pub const SIGMA_N_MAX: usize = 1 << 20;
/// The most values of series_euler.
pub const EULER_N_MAX: usize = 1 << 20;
/// The most bits of an input coefficient or denominator (1024 hex digits).
pub const B_MAX: u64 = 1 << 12;
/// The most bits of an output value.
pub const BETA_MAX: u64 = 1 << 14;
/// The most output bits in all: n beta.
pub const N_BETA_MAX: u64 = 1 << 26;
/// The largest k of sigma_table.
pub const SIGMA_K_MAX: u64 = 1 << 20;
/// The most work an op is admitted with, in word operations (a few
/// seconds).
pub const WORK_MAX: u64 = 1 << 34;

const _: () = assert!(NTT_PRIME_ROOTS.len() == 2 * P_MAX);
const _: () = assert!((BETA_MAX + 1).div_ceil(61) as usize <= P_MAX);

macro_rules! ck {
    ($e:expr) => {
        match $e {
            Some(v) => v,
            None => return None,
        }
    };
}

/// The bit length: x < 2^bl(x), bl(0) = 0.
pub const fn bl(x: u64) -> u64 {
    64 - x.leading_zeros() as u64
}

/// The primes for values below 2^beta: ceil((beta + 1) / 61).
pub const fn primes_for(beta: u64) -> u64 {
    beta.saturating_add(1).div_ceil(61)
}

/// The limbs of a value below 2^beta (at least one).
const fn limbs(beta: u64) -> u64 {
    let w = beta.div_ceil(64);
    if w == 0 {
        1
    } else {
        w
    }
}

/// Hex digits of a value below 2^beta (at least one).
const fn hex_digits(beta: u64) -> u64 {
    let d = beta.div_ceil(4);
    if d == 0 {
        1
    } else {
        d
    }
}

/// [`MultiCrt::new`] over p primes: pm and c (p^2), prod (p (p + 2)), the
/// q_j (p small products of at most p + 2 words each, and a reduction),
/// counted in crt.rs.
pub const fn crt_new_work(p: u64) -> Option<u64> {
    let p2 = ck!(p.checked_mul(p));
    let p3 = ck!(p2.checked_mul(p));
    ck!(ck!(p3.checked_mul(2)).checked_add(ck!(p2.checked_mul(16)))).checked_add(64)
}

/// One [`MultiCrt::reconstruct`] over p primes: p rows of p + 2 products,
/// the carry pass, the product's buffer and at most two correction steps
/// (the quotient's estimate is within one: crt.rs).
pub const fn crt_work(p: u64) -> Option<u64> {
    let p2 = ck!(p.checked_mul(p));
    ck!(ck!(p2.checked_mul(2)).checked_add(ck!(p.checked_mul(24)))).checked_add(64)
}

/// Writing one value below 2^beta in hex: its limbs (copied out, then
/// formatted) and the sign.
const fn hex_work(beta: u64) -> Option<u64> {
    ck!(limbs(beta).checked_mul(2)).checked_add(4)
}

/// The own table of products up to `len` (none for a schoolbook product).
fn table_cost(la: usize, lb: usize) -> Option<u64> {
    let len = nmod_poly::mul_table_len(la, lb);
    if len == 0 {
        return Some(0);
    }
    ntt::table_work(len.next_power_of_two().trailing_zeros())
}

/// A coefficient list's text, scanned once without allocating (the
/// admission's second stage).
#[derive(Clone, Copy, Debug)]
pub struct Csv<'a> {
    pub text: &'a str,
    /// tokens (0 for the empty list, the zero series)
    pub tokens: usize,
    /// the most hex digits of a token: every |value| < 16^max_digits
    pub max_digits: usize,
    /// the limbs of all tokens, sum of ceil(digits / 16)
    pub limbs: u64,
    /// every token is 0
    pub all_zero: bool,
    /// the index of the first nonzero token (when not all zero)
    pub valuation: usize,
}

impl Csv<'_> {
    /// Every token's |value| < 2^bits.
    pub fn bits(&self) -> u64 {
        4 * self.max_digits as u64
    }
}

/// Scan a comma-separated list of hex integers (`-?(0|[1-9a-f][0-9a-f]*)`,
/// no sign when `signed` is false), at most `max_tokens` of them and each
/// at most B_MAX bits, counting what admission needs.  The work is one pass
/// over the text.
pub fn scan<'a>(text: &'a str, max_tokens: usize, signed: bool) -> Result<Csv<'a>, String> {
    let max_digits = (B_MAX / 4) as usize;
    let mut c = Csv { text, tokens: 0, max_digits: 0, limbs: 0, all_zero: true, valuation: 0 };
    if text.is_empty() {
        return Ok(c);
    }
    for (i, tok) in text.split(',').enumerate() {
        if i & 0xfff == 0 {
            sagebrush_interrupt::check_coarse();
        }
        if i >= max_tokens {
            return Err(format!("more than {} coefficients", max_tokens));
        }
        let digits = match tok.strip_prefix('-') {
            Some(d) if signed => d,
            Some(_) => return Err("a denominator must be positive".into()),
            None => tok,
        };
        let ok = !digits.is_empty()
            && digits.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            && (digits == "0" || !digits.starts_with('0'))
            && !(digits == "0" && digits.len() != tok.len());
        if !ok {
            return Err(format!("{:?} is not a hex integer (-?(0|[1-9a-f][0-9a-f]*))", &tok[..tok.len().min(40)]));
        }
        if digits.len() > max_digits {
            return Err(format!("a coefficient of {} hex digits: at most {} ({} bits)", digits.len(), max_digits, B_MAX));
        }
        c.tokens = i + 1;
        c.max_digits = c.max_digits.max(digits.len());
        c.limbs += digits.len().div_ceil(16) as u64;
        if c.all_zero && digits != "0" {
            c.all_zero = false;
            c.valuation = i;
        }
    }
    Ok(c)
}

/// A positive denominator: one token, not 0.
pub fn scan_denominator(text: &str) -> Result<Csv<'_>, String> {
    let c = scan(text, 1, false)?;
    if c.tokens != 1 || c.all_zero {
        return Err("a denominator must be a positive hex integer".into());
    }
    Ok(c)
}

/// 2^64 mod p.
fn two64(m: &Modulus) -> u64 {
    m.reduce_wide(1 % m.n, 0)
}

/// One token's residue mod p: Horner over 16-digit chunks, most significant
/// first.
fn token_residue(tok: &str, m: &Modulus, b64: u64) -> u64 {
    let (neg, digits) = match tok.strip_prefix('-') {
        Some(d) => (true, d),
        None => (false, tok),
    };
    let mut r = 0u64;
    let first = match digits.len() % 16 {
        0 => 16,
        f => f,
    };
    let mut at = 0;
    let mut end = first.min(digits.len());
    while at < digits.len() {
        let x = u64::from_str_radix(&digits[at..end], 16).expect("scanned");
        r = m.add(m.mul(r, b64), m.reduce(x));
        at = end;
        end = (at + 16).min(digits.len());
    }
    counted::add(digits.len().div_ceil(16) as u64 + 1);
    if neg {
        m.neg(r)
    } else {
        r
    }
}

/// The residues of tokens [from, from + count) of a scanned list, appended.
fn residues(c: &Csv, from: usize, count: usize, m: &Modulus, b64: u64, out: &mut Vec<u64>) {
    if count == 0 {
        return;
    }
    for (i, tok) in c.text.split(',').skip(from).take(count).enumerate() {
        if i & 0x3ff == 0 {
            sagebrush_interrupt::check_coarse();
        }
        out.push(token_residue(tok, m, b64));
    }
}

/// The primes an op reconstructs with: the first `p` of the table, or with
/// denominators the first `p` whose residues of every denominator are
/// nonzero (from the first 2p).  Their table indices, and per selected
/// prime the denominators' residues.
fn select(p: usize, dens: &[&Csv]) -> Result<(Vec<usize>, Vec<Vec<u64>>), String> {
    let mut idx = Vec::with_capacity(p);
    let mut dres = Vec::with_capacity(if dens.is_empty() { 0 } else { p });
    if dens.is_empty() {
        idx.extend(0..p);
        return Ok((idx, dres));
    }
    for j in 0..2 * p {
        if idx.len() == p {
            break;
        }
        let m = Modulus::new(NTT_PRIME_ROOTS[j].0);
        let b64 = two64(&m);
        let r: Vec<u64> = dens.iter().map(|d| token_residue(d.text, &m, b64)).collect();
        counted::add(2);
        if r.iter().all(|&x| x != 0) {
            idx.push(j);
            dres.push(r);
        }
    }
    if idx.len() < p {
        return Err(format!("{}: fewer than {} of the first {} table primes are prime to the denominators", INTERNAL_PREFIX, p, 2 * p));
    }
    Ok((idx, dres))
}

/// The marker of a failed proved invariant here (an engine bug: the
/// callers raise it as internal, never as a limit or a user error).
pub const INTERNAL_PREFIX: &str = "series: internal error";

/// An admitted request: its output bound, primes, work and peak bytes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Admitted {
    pub beta: u64,
    pub primes: u64,
    pub work: u64,
    pub peak: u64,
    /// the reply text's bound, reserved before any output
    pub reply: u64,
}

fn cap(what: &str, value: u64, max: u64, how: &str) -> Result<(), String> {
    if value > max {
        return Err(format!("{} = {} is more than {} ({})", what, value, max, how));
    }
    Ok(())
}

fn admit_common(beta: u64, n: u64, reduce: bool) -> Result<(u64, u64), String> {
    cap("an output value's bits", beta, BETA_MAX, "fewer or smaller coefficients")?;
    let nb = n.checked_mul(beta).unwrap_or(u64::MAX);
    cap("the output's bits n * beta", nb, N_BETA_MAX, "fewer coefficients per call")?;
    let p = primes_for(beta);
    let digits = hex_digits(beta);
    let per = if reduce { 2 * digits + 4 } else { digits + 2 };
    let reply = n * per + digits + 64;
    Ok((p, reply))
}

/// The normalization's work: the selection scan over 2p primes, d's
/// reconstruction, and per coefficient its gcd with d
/// (`coprime::pair_work`), g's residues and inverses, two more
/// reconstructions and two values' hex.
fn norm_work(p: u64, n: u64, beta: u64, den_limbs: u64) -> Option<u64> {
    let w = limbs(beta);
    let scan = ck!(ck!(2u64.checked_mul(p)).checked_mul(ck!(den_limbs.checked_add(4))));
    let crt = ck!(crt_work(p));
    let gcd = ck!(coprime::pair_work(w, w));
    let inv = ck!(p.checked_mul(ck!(w.checked_add(140))));
    let per = ck!(ck!(ck!(ck!(gcd.checked_add(ck!(crt.checked_mul(2)))).checked_add(inv)).checked_add(ck!(hex_work(beta)).saturating_mul(2))).checked_add(8));
    ck!(ck!(scan.checked_add(crt)).checked_add(ck!(n.checked_mul(per)))).checked_add(16)
}

/// The normalization's peak bytes: d's limbs, the gcd's workspace, g's
/// residues and inverses, the 2p candidate residues of two denominators,
/// two reconstructions' results.
fn norm_peak(p: u64, beta: u64) -> Option<u64> {
    let w = limbs(beta);
    let ws = ck!(ck!(coprime::workspace_words(w)).checked_mul(8));
    let big = ck!(ck!(w.checked_add(4)).checked_mul(24));
    ck!(ck!(ck!(ws.checked_add(ck!(big.checked_mul(4)))).checked_add(ck!(p.checked_mul(8 * 3)))).checked_add(ck!(p.checked_mul(8 * 2 * 2 + 48)))).checked_add(256)
}

/// The output stage shared by the series ops: MultiCrt over p primes
/// (built once), n + 1 reconstructions and their hex, the residue matrix's
/// zero scan.
fn emit_work(p: u64, n: u64, beta: u64) -> Option<u64> {
    let per = ck!(ck!(ck!(crt_work(p)).checked_add(ck!(hex_work(beta)))).checked_add(1));
    ck!(ck!(crt_new_work(p)).checked_add(ck!(ck!(n.checked_add(1)).checked_mul(per)))).checked_add(ck!(p.checked_mul(n)))
}

/// The output stage's peak: the residue matrix, MultiCrt (resident,
/// construction, one reconstruct), one column, one value's limbs.
fn emit_peak(p: u64, n: u64, beta: u64) -> Option<u64> {
    let crt = ck!(crt_bytes(p as usize, ck!(p.checked_mul(62))));
    let matrix = ck!(ck!(p.checked_mul(n)).checked_mul(8));
    let w = limbs(beta);
    ck!(ck!(ck!(ck!(matrix.checked_add(crt.resident)).checked_add(crt.construction)).checked_add(crt.reconstruct)).checked_add(ck!(p.checked_mul(8)))).checked_add(ck!(w.checked_add(8)).saturating_mul(24))
}

/// One product's peak in GF(p) for factors of la and lb coefficients: the
/// two residue vectors, the product before truncation (capacity at most
/// twice its length), the own table and the transform buffers.
fn product_peak(la: u64, lb: u64) -> Option<u64> {
    let len = ck!(ck!(la.checked_add(lb)).checked_sub(1).or(Some(0)));
    let nn = ck!(len.max(1).checked_next_power_of_two());
    ck!(ck!(ck!(la.checked_add(lb)).checked_mul(8)).checked_add(ck!(len.checked_mul(16)))).checked_add(ck!(nn.checked_mul(64)))
}

/// The allocator's share beyond the sized terms: the small allocations every
/// call makes (the reply's `{"ok":` wrapper, scalars' Strings, a message,
/// MultiCrt's fixed headers) and, in WebAssembly, the memory's growth in
/// 64 KiB pages with freed blocks of one phase not always serving a larger
/// block of the next: at least 1 MiB, and a sixteenth of the sized terms.
/// (Measured on the wasm build at the admitted corners: the memory grew at
/// most 1.0 MiB past the sized terms; tests/series_alloc.rs checks the
/// native live peak against the whole bound.)
const SLACK_MIN: u64 = 1 << 20;

fn finish(beta: u64, p: u64, work: Option<u64>, peak: Option<u64>, reply: u64, request: u64) -> Result<Admitted, String> {
    let work = work.and_then(|w| w.checked_add(request)).ok_or("the work bound overflows")?;
    let sized = peak.and_then(|x| x.checked_add(reply)).and_then(|x| x.checked_add(request)).ok_or("the memory bound overflows")?;
    let peak = sized.checked_add((sized / 16).max(SLACK_MIN)).ok_or("the memory bound overflows")?;
    cap("the work", work, WORK_MAX, "fewer coefficients per call, or raw")?;
    Ok(Admitted { beta, primes: p, work, peak, reply })
}

/// series_mul's admission: a, b (at most n coefficients each), the
/// optional denominators, `raw` (unreduced output), and the request's bytes
/// (the scan's work and the request's own memory).
pub fn mul_admit(a: &Csv, b: &Csv, da: Option<&Csv>, db: Option<&Csv>, n: usize, raw: bool, request: u64) -> Result<Admitted, String> {
    let (ta, tb) = (a.tokens as u64, b.tokens as u64);
    let m = ta.min(tb);
    let beta_c = if m == 0 { 1 } else { a.bits() + b.bits() + bl(m) };
    let beta_d = da.map_or(0, |d| d.bits()) + db.map_or(0, |d| d.bits());
    let beta = beta_c.max(beta_d).max(1);
    let has_den = da.is_some() || db.is_some();
    let reduce = has_den && !raw;
    let n64 = n as u64;
    let (p, reply) = admit_common(beta, n64, reduce)?;
    let den_limbs = da.map_or(0, |d| d.limbs) + db.map_or(0, |d| d.limbs);
    let work = (|| {
        let res = ck!(p.checked_mul(ck!(ck!(ck!(ck!(a.limbs.checked_add(b.limbs)).checked_add(den_limbs)).checked_add(ck!(ta.checked_add(tb)))).checked_add(4))));
        let prod = ck!(ck!(ck!(table_cost(a.tokens, b.tokens)).checked_add(ck!(nmod_poly::mul_work(a.tokens, b.tokens)))).checked_add(ck!(n64.checked_mul(2))));
        let w = ck!(ck!(res.checked_add(ck!(p.checked_mul(prod)))).checked_add(ck!(emit_work(p, n64, beta))));
        let w = ck!(w.checked_add(ck!(ck!(p.checked_mul(2)).checked_mul(ck!(den_limbs.checked_add(4))))));
        if reduce {
            w.checked_add(ck!(norm_work(p, n64, beta, den_limbs)))
        } else {
            Some(w)
        }
    })();
    let peak = (|| {
        let x = ck!(ck!(product_peak(ta, tb)).checked_add(ck!(emit_peak(p, n64, beta))));
        x.checked_add(ck!(norm_peak(p, beta)))
    })();
    finish(beta, p, work, peak, reply, request)
}

/// series_pow's admission (k >= 1, a not all zero, k v < n: the caller
/// answers the other cases), with m = n - k v coefficients computed.
pub fn pow_admit(a: &Csv, k: u64, da: Option<&Csv>, n: usize, raw: bool, request: u64) -> Result<Admitted, String> {
    let v = a.valuation as u64;
    let n64 = n as u64;
    // (the caller decided k v >= n by division; here k v < n)
    let kv = k.checked_mul(v).filter(|&x| x < n64).ok_or_else(|| format!("{}: series_pow admitted with k v >= n", INTERNAL_PREFIX))?;
    let m = n64 - kv;
    let g = (a.tokens as u64 - v).min(m);
    let beta_c = k.checked_mul(a.bits() + bl(g)).unwrap_or(u64::MAX);
    let beta_d = da.map_or(0, |d| d.bits()).checked_mul(k).unwrap_or(u64::MAX);
    let beta = beta_c.max(beta_d).max(1);
    let reduce = da.is_some() && !raw;
    let (p, reply) = admit_common(beta, n64, reduce)?;
    let den_limbs = da.map_or(0, |d| d.limbs);
    let steps = 2 * bl(k);
    let mm = m as usize;
    let work = (|| {
        let res = ck!(p.checked_mul(ck!(ck!(ck!(a.limbs.checked_add(a.tokens as u64)).checked_add(den_limbs)).checked_add(4))));
        let one = ck!(ck!(nmod_poly::mul_work(mm, mm)).checked_add(m));
        let per = ck!(ck!(ck!(ck!(table_cost(mm, mm)).checked_add(ck!(steps.checked_mul(one)))).checked_add(ck!(steps.checked_mul(2)))).checked_add(ck!(n64.checked_mul(2))));
        let w = ck!(ck!(ck!(res.checked_add(ck!(p.checked_mul(per)))).checked_add(ck!(emit_work(p, n64, beta)))).checked_add(n64));
        let w = ck!(w.checked_add(ck!(ck!(p.checked_mul(2)).checked_mul(ck!(ck!(den_limbs.checked_add(4)).checked_add(steps))))));
        if reduce {
            w.checked_add(ck!(norm_work(p, n64, beta, den_limbs)))
        } else {
            Some(w)
        }
    })();
    let peak = (|| {
        // the base, the accumulator and the product: three of product_peak's
        // shapes at length m
        let x = ck!(ck!(ck!(product_peak(m, m)).checked_add(ck!(m.checked_mul(48)))).checked_add(ck!(emit_peak(p, n64, beta))));
        x.checked_add(ck!(norm_peak(p, beta)))
    })();
    finish(beta, p, work, peak, reply, request)
}

/// sigma_table's admission (n >= 1).
pub fn sigma_admit(k: u64, n: usize, request: u64) -> Result<Admitted, String> {
    cap("k", k, SIGMA_K_MAX, "a smaller k")?;
    let n64 = n as u64;
    let beta = (k + 1).checked_mul(bl(n64)).unwrap_or(u64::MAX);
    let (p, reply) = admit_common(beta, n64, false)?;
    let work = (|| {
        // per prime: the zero fill, the powers d^k (2 bl(k) products each),
        // the sieve's additions (sum floor(n/d) <= n (bl(n) + 1)), the copy
        let adds = ck!(n64.checked_mul(bl(n64) + 1));
        let per = ck!(ck!(ck!(ck!(n64.checked_mul(2 * bl(k) + 2)).checked_add(adds)).checked_add(ck!(n64.checked_mul(2)))).checked_add(8));
        ck!(p.checked_mul(per)).checked_add(ck!(emit_work(p, n64, beta)))
    })();
    let peak = (|| ck!(n64.checked_add(1)).checked_mul(8)?.checked_add(ck!(emit_peak(p, n64, beta))))();
    finish(beta, p, work, peak, reply, request)
}

/// series_euler's admission.
pub fn euler_admit(n: usize, request: u64) -> Result<Admitted, String> {
    let n64 = n as u64;
    let reply = 3 * n64 + 64;
    finish(1, 0, Some(4 * n64 + 16), Some(64), reply, request)
}

/// The value with these residues (one per selected prime), as hex into
/// `out`; whether it is zero.
fn write_hex(x: &BigInt, out: &mut String) {
    let (s, w) = x.to_u64_digits();
    counted::add(2 * w.len() as u64 + 4);
    if w.is_empty() {
        out.push('0');
        return;
    }
    if s == Sign::Minus {
        out.push('-');
    }
    let _ = write!(out, "{:x}", w[w.len() - 1]);
    for x in w[..w.len() - 1].iter().rev() {
        let _ = write!(out, "{:016x}", x);
    }
}

/// The output stage: the selected primes' residue matrix (row j: the
/// values mod prime j), `len` values from index `skip` (leading zeros
/// written first), trailing zeros dropped; reduced by d when given.
struct Emit<'a> {
    primes: Vec<u64>,
    matrix: &'a [u64],
    len: usize,
    /// d's residues per selected prime (a denominator present)
    d: Option<Vec<u64>>,
    reduce: bool,
    /// the list alone, as a JSON string (sigma_table), not the object
    bare: bool,
}

impl Emit<'_> {
    fn column(&self, i: usize, col: &mut [u64]) {
        for (j, c) in col.iter_mut().enumerate() {
            *c = self.matrix[j * self.len + i];
        }
    }

    /// `{"c":"...","d":"..."}` (raw, or no denominator: "d" is "1" without
    /// one) or `{"c":"..."}` with reduced "num/den" tokens.
    fn write(&self, leading: usize, out: &mut String) -> Result<(), String> {
        let p = self.primes.len();
        // the last nonzero value: zero exactly when every residue is
        let mut last = 0;
        for i in 0..self.len {
            if i & 0xfff == 0 {
                sagebrush_interrupt::check_coarse();
            }
            if (0..p).any(|j| self.matrix[j * self.len + i] != 0) {
                last = i + 1;
            }
        }
        counted::add((p * self.len) as u64);
        let crt = MultiCrt::new(&self.primes);
        let mut col = vec![0u64; p];
        let d = self.d.as_ref().map(|r| crt.reconstruct(r));
        // (d's limbs, kept for the gcds)
        let dl: Vec<u64> = d.as_ref().map_or_else(Vec::new, |d| d.to_u64_digits().1);
        out.push_str(if self.bare { "\"" } else { "{\"c\":\"" });
        if last > 0 {
            for i in 0..leading {
                if i > 0 {
                    out.push(',');
                }
                out.push('0');
            }
        }
        let mut ws: Vec<u64> = Vec::new();
        for i in 0..last {
            if i & 0xff == 0 {
                sagebrush_interrupt::check_coarse();
            }
            if leading > 0 || i > 0 {
                out.push(',');
            }
            self.column(i, &mut col);
            let x = crt.reconstruct(&col);
            match (&d, self.reduce) {
                (Some(dv), true) => self.write_reduced(&x, &col, dv, &dl, &crt, &mut ws, out)?,
                _ => write_hex(&x, out),
            }
        }
        out.push('"');
        if self.bare {
            return Ok(());
        }
        if !self.reduce {
            out.push_str(",\"d\":\"");
            match &d {
                Some(dv) if last > 0 => write_hex(dv, out),
                _ => out.push('1'),
            }
            out.push('"');
        }
        out.push('}');
        Ok(())
    }

    /// c / d in lowest terms: g = gcd(c, d) (coprime's metered Lehmer gcd),
    /// then c / g and d / g from the residues times g^-1 (no selected prime
    /// divides d, so none divides g).
    #[allow(clippy::too_many_arguments)]
    fn write_reduced(&self, x: &BigInt, col: &[u64], d: &BigInt, dl: &[u64], crt: &MultiCrt, ws: &mut Vec<u64>, out: &mut String) -> Result<(), String> {
        let (_, xl) = x.to_u64_digits();
        if xl.is_empty() {
            out.push('0');
            return Ok(());
        }
        let l = xl.len().max(dl.len());
        let half = l + 1;
        ws.clear();
        ws.resize(2 * half, 0);
        ws[..xl.len()].copy_from_slice(&xl);
        ws[half..half + dl.len()].copy_from_slice(dl);
        let (lx, ld) = (xl.len() as u64, dl.len() as u64);
        let limit = coprime::gcd_work(lx, ld).ok_or_else(|| format!("{}: the gcd's bound overflows", INTERNAL_PREFIX))?;
        let mut meter = Meter::new(limit);
        let (left, right) = ws.split_at_mut(half);
        let (slot, len) = coprime::gcd_in_place(left, xl.len(), right, dl.len(), &mut meter).map_err(|f| format!("{}: the gcd's meter: {:?}", INTERNAL_PREFIX, f))?;
        counted::add(meter.used() + 2 * (lx + ld + 4));
        let g: &[u64] = if slot { &right[..len] } else { &left[..len] };
        if g.len() == 1 && g[0] == 1 {
            write_hex(x, out);
            if !(dl.len() == 1 && dl[0] == 1) {
                out.push('/');
                write_hex(d, out);
            }
            return Ok(());
        }
        // c / g and d / g from the residues
        let p = self.primes.len();
        let dres = self.d.as_ref().expect("reduced output has d");
        let mut num = vec![0u64; p];
        let mut den = vec![0u64; p];
        for j in 0..p {
            let m = Modulus::new(self.primes[j]);
            let b64 = two64(&m);
            let mut r = 0u64;
            for &limb in g.iter().rev() {
                r = m.add(m.mul(r, b64), m.reduce(limb));
            }
            let gi = m.inv(r).ok_or_else(|| format!("{}: a selected prime divides gcd(c, d)", INTERNAL_PREFIX))?;
            num[j] = m.mul(col[j], gi);
            den[j] = m.mul(dres[j], gi);
        }
        counted::add(p as u64 * (g.len() as u64 + 140));
        let (nv, dv) = (crt.reconstruct(&num), crt.reconstruct(&den));
        write_hex(&nv, out);
        let (_, dvl) = dv.to_u64_digits();
        if !(dvl.len() == 1 && dvl[0] == 1) {
            out.push('/');
            write_hex(&dv, out);
        }
        Ok(())
    }
}

/// The selected primes' moduli.
fn moduli(idx: &[usize]) -> Vec<u64> {
    idx.iter().map(|&j| NTT_PRIME_ROOTS[j].0).collect()
}

/// a b mod q^n in GF(p) for one prime: the residues, the product with the
/// prime's own table (schoolbook below the cutoff), the first n values into
/// `row`.
fn mul_row(a: &Csv, b: &Csv, j: usize, row: &mut [u64]) {
    let (p, root) = NTT_PRIME_ROOTS[j];
    let m = Modulus::new(p);
    let b64 = two64(&m);
    let mut x = Vec::with_capacity(a.tokens);
    residues(a, 0, a.tokens, &m, b64, &mut x);
    let mut y = Vec::with_capacity(b.tokens);
    residues(b, 0, b.tokens, &m, b64, &mut y);
    let c = product(&x, &y, &m, root, None);
    drop((x, y));
    let k = c.len().min(row.len());
    row[..k].copy_from_slice(&c[..k]);
    counted::add(2 * row.len() as u64);
}

/// x y in GF(p) (with the given own table, or one built for this length),
/// counted as nmod_poly::mul_work plus the table's build.
fn product(x: &[u64], y: &[u64], m: &Modulus, root: u64, lt: Option<&LocalTables>) -> Vec<u64> {
    counted::add(nmod_poly::mul_work(x.len(), y.len()).unwrap_or(u64::MAX));
    let len = nmod_poly::mul_table_len(x.len(), y.len());
    if len == 0 {
        return nmod_poly::mul(x, y, m);
    }
    match lt {
        Some(t) => nmod_poly::mul_in(x, y, m, t),
        None => {
            counted::add(table_cost(x.len(), y.len()).unwrap_or(u64::MAX));
            let t = LocalTables::with_root(m, root, len);
            nmod_poly::mul_in(x, y, m, &t)
        }
    }
}

/// series_mul: (a / d_a)(b / d_b) mod q^n, admitted by [`mul_admit`]; the
/// reply object into `out` (reserved by the caller to the admitted bound).
pub fn mul(a: &Csv, b: &Csv, da: Option<&Csv>, db: Option<&Csv>, n: usize, raw: bool, adm: &Admitted, out: &mut String) -> Result<(), String> {
    if n == 0 || a.all_zero || b.all_zero {
        out.push_str("{\"c\":\"\",\"d\":\"1\"}");
        return Ok(());
    }
    let p = adm.primes as usize;
    let dens: Vec<&Csv> = da.into_iter().chain(db).collect();
    let (idx, dres) = select(p, &dens)?;
    let mut matrix = vec![0u64; p * n];
    for (r, &j) in idx.iter().enumerate() {
        sagebrush_interrupt::check_coarse();
        mul_row(a, b, j, &mut matrix[r * n..(r + 1) * n]);
    }
    let d = if dens.is_empty() {
        None
    } else {
        Some(idx.iter().zip(&dres).map(|(&j, r)| {
            let m = Modulus::new(NTT_PRIME_ROOTS[j].0);
            r.iter().fold(1 % m.n, |acc, &x| m.mul(acc, x))
        }).collect())
    };
    let e = Emit { primes: moduli(&idx), matrix: &matrix, len: n, d, reduce: !dens.is_empty() && !raw, bare: false };
    e.write(0, out)
}

/// g^k mod q^m in GF(p), g with g.len() <= m values, k >= 1: left-to-right
/// binary powering, each product truncated to m, with one own table for
/// products of length 2m - 1.
fn pow_row(g: &[u64], k: u64, m_len: usize, md: &Modulus, root: u64) -> Vec<u64> {
    let len = nmod_poly::mul_table_len(m_len, m_len);
    let lt = if len == 0 {
        None
    } else {
        counted::add(table_cost(m_len, m_len).unwrap_or(u64::MAX));
        Some(LocalTables::with_root(md, root, len))
    };
    let mut acc = g.to_vec();
    for bit in (0..bl(k) - 1).rev() {
        sagebrush_interrupt::check_coarse();
        let mut s = product(&acc, &acc, md, root, lt.as_ref());
        s.truncate(m_len);
        counted::add(m_len as u64 + 2);
        acc = s;
        if (k >> bit) & 1 == 1 {
            let mut t = product(&acc, g, md, root, lt.as_ref());
            t.truncate(m_len);
            counted::add(m_len as u64 + 2);
            acc = t;
        }
    }
    acc
}

/// series_pow: (a / d_a)^k mod q^n.  The cases decided before admission
/// (by the caller, from the scan): n = 0, k = 0, a all zero, k v >= n.
pub fn pow(a: &Csv, k: u64, da: Option<&Csv>, n: usize, raw: bool, adm: &Admitted, out: &mut String) -> Result<(), String> {
    let v = a.valuation;
    let m_len = n - (k as usize) * v;
    let g_len = (a.tokens - v).min(m_len);
    let p = adm.primes as usize;
    let dens: Vec<&Csv> = da.into_iter().collect();
    let (idx, dres) = select(p, &dens)?;
    let mut matrix = vec![0u64; p * m_len];
    for (r, &j) in idx.iter().enumerate() {
        sagebrush_interrupt::check_coarse();
        let (pr, root) = NTT_PRIME_ROOTS[j];
        let md = Modulus::new(pr);
        let b64 = two64(&md);
        let mut g = Vec::with_capacity(g_len);
        residues(a, v, g_len, &md, b64, &mut g);
        let c = pow_row(&g, k, m_len, &md, root);
        let row = &mut matrix[r * m_len..(r + 1) * m_len];
        let t = c.len().min(m_len);
        row[..t].copy_from_slice(&c[..t]);
        counted::add(2 * m_len as u64);
    }
    let d = if dens.is_empty() {
        None
    } else {
        Some(idx.iter().zip(&dres).map(|(&j, r)| {
            let md = Modulus::new(NTT_PRIME_ROOTS[j].0);
            counted::add(2 * bl(k));
            md.pow(r[0], k)
        }).collect())
    };
    let e = Emit { primes: moduli(&idx), matrix: &matrix, len: m_len, d, reduce: !dens.is_empty() && !raw, bare: false };
    e.write(k as usize * v, out)
}

/// sigma_table: sigma_k(1), ..., sigma_k(n) (n >= 1), admitted by
/// [`sigma_admit`].
pub fn sigma(k: u64, n: usize, adm: &Admitted, out: &mut String) -> Result<(), String> {
    let p = adm.primes as usize;
    let mut matrix = vec![0u64; p * n];
    for (r, &(pr, _)) in NTT_PRIME_ROOTS[..p].iter().enumerate() {
        sagebrush_interrupt::check_coarse();
        let m = Modulus::new(pr);
        let mut s = vec![0u64; n + 1];
        counted::add(n as u64 + 1);
        let mut adds = 0u64;
        for d in 1..=n {
            let t = m.pow(d as u64, k);
            counted::add(2 * bl(k) + 2);
            let mut j = d;
            while j <= n {
                s[j] = m.add(s[j], t);
                j += d;
                adds += 1;
                if adds & 0xffff == 0 {
                    sagebrush_interrupt::check_coarse();
                }
            }
        }
        counted::add(adds);
        matrix[r * n..(r + 1) * n].copy_from_slice(&s[1..]);
        counted::add(2 * n as u64);
    }
    // (positive values: no sign, and no denominator)
    let e = Emit { primes: moduli(&(0..p).collect::<Vec<_>>()), matrix: &matrix, len: n, d: None, reduce: false, bare: true };
    e.write(0, out)
}

/// The generalized pentagonal numbers e(j) = j (3j - 1) / 2 for j = 0, 1,
/// -1, 2, -2, ... (0, 1, 2, 5, 7, 12, 15, ...): the i-th, its sign (-1)^j.
fn pentagonal(i: usize) -> (usize, bool) {
    let j = i.div_ceil(2);
    let e = if i % 2 == 1 { j * (3 * j - 1) / 2 } else { j * (3 * j + 1) / 2 };
    (e, j % 2 == 1)
}

/// series_euler: prod_{m >= 1} (1 - q^m) mod q^n, written straight into
/// `out` as a JSON string of the coefficients -1, 0 and 1, trailing zeros
/// dropped: by Euler's pentagonal number theorem the coefficient of q^e(j)
/// is (-1)^j and every other one is 0.  The pentagonal numbers increase, so
/// one pass with the next one in hand.
pub fn euler(n: usize, out: &mut String) {
    out.push('"');
    // the last nonzero coefficient below n: the largest pentagonal number
    // below n (one scan of at most 2 sqrt(n) + 2 of them)
    let mut count = 0;
    while pentagonal(count).0 < n {
        count += 1;
    }
    counted::add(2 * count as u64 + 2);
    let last = if count == 0 { 0 } else { pentagonal(count - 1).0 + 1 };
    let mut i = 0; // the next pentagonal number's index
    for e in 0..last {
        if e & 0xffff == 0 {
            sagebrush_interrupt::check_coarse();
        }
        if e > 0 {
            out.push(',');
        }
        let (next, negative) = pentagonal(i);
        if e == next {
            out.push_str(if negative { "-1" } else { "1" });
            i += 1;
        } else {
            out.push('0');
        }
    }
    counted::add(2 * last as u64);
    out.push('"');
}

#[cfg(test)]
mod tests;
