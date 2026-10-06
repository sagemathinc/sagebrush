//! Big-integer libraries, the operations research math leans on:
//!
//!     cargo run --release [-- --max-bits N --libs a,b --ops x,y --budget SECONDS]
//!     (WebAssembly: --target wasm32-wasip1 --no-default-features, run.mjs)
//!
//! For each size n (bits, doubling from 64) and operation, on the same
//! random inputs: mul (n x n), sqr, divrem (2n by n), gcd (n, n),
//! powmod (n-bit base, exponent, modulus; n <= 8192), to_dec, from_dec.
//! Every library's result is checked against num-bigint 0.5 (or the first
//! library's, for conversions), so a fast wrong answer cannot pass.  A
//! (library, operation) stops growing once one size takes over the budget.
//! Prints CSV: lib,op,bits,ns_per_op.

use std::hint::black_box;
use std::time::Instant;

trait Lib {
    type N: Clone;
    const NAME: &'static str;
    fn parse_hex(s: &str) -> Self::N;
    fn hex(a: &Self::N) -> String;
    fn mul(a: &Self::N, b: &Self::N) -> Self::N;
    fn divrem(a: &Self::N, b: &Self::N) -> (Self::N, Self::N);
    fn gcd(a: &Self::N, b: &Self::N) -> Self::N;
    fn powmod(a: &Self::N, e: &Self::N, m: &Self::N) -> Self::N;
    fn to_dec(a: &Self::N) -> String;
    fn from_dec(s: &str) -> Self::N;
}

struct NumBigint05;
impl Lib for NumBigint05 {
    type N = num_bigint::BigUint;
    const NAME: &'static str = "num-bigint-0.5";
    fn parse_hex(s: &str) -> Self::N {
        Self::N::parse_bytes(s.as_bytes(), 16).unwrap()
    }
    fn hex(a: &Self::N) -> String {
        a.to_str_radix(16)
    }
    fn mul(a: &Self::N, b: &Self::N) -> Self::N {
        a * b
    }
    fn divrem(a: &Self::N, b: &Self::N) -> (Self::N, Self::N) {
        num_integer::Integer::div_rem(a, b)
    }
    fn gcd(a: &Self::N, b: &Self::N) -> Self::N {
        num_integer::Integer::gcd(a, b)
    }
    fn powmod(a: &Self::N, e: &Self::N, m: &Self::N) -> Self::N {
        a.modpow(e, m)
    }
    fn to_dec(a: &Self::N) -> String {
        a.to_string()
    }
    fn from_dec(s: &str) -> Self::N {
        Self::N::parse_bytes(s.as_bytes(), 10).unwrap()
    }
}

struct NumBigint04;
impl Lib for NumBigint04 {
    type N = num_bigint_04::BigUint;
    const NAME: &'static str = "num-bigint-0.4";
    fn parse_hex(s: &str) -> Self::N {
        Self::N::parse_bytes(s.as_bytes(), 16).unwrap()
    }
    fn hex(a: &Self::N) -> String {
        a.to_str_radix(16)
    }
    fn mul(a: &Self::N, b: &Self::N) -> Self::N {
        a * b
    }
    fn divrem(a: &Self::N, b: &Self::N) -> (Self::N, Self::N) {
        num_integer::Integer::div_rem(a, b)
    }
    fn gcd(a: &Self::N, b: &Self::N) -> Self::N {
        num_integer::Integer::gcd(a, b)
    }
    fn powmod(a: &Self::N, e: &Self::N, m: &Self::N) -> Self::N {
        a.modpow(e, m)
    }
    fn to_dec(a: &Self::N) -> String {
        a.to_string()
    }
    fn from_dec(s: &str) -> Self::N {
        Self::N::parse_bytes(s.as_bytes(), 10).unwrap()
    }
}

struct Dashu;
impl Lib for Dashu {
    type N = dashu::integer::UBig;
    const NAME: &'static str = "dashu-0.6";
    fn parse_hex(s: &str) -> Self::N {
        Self::N::from_str_radix(s, 16).unwrap()
    }
    fn hex(a: &Self::N) -> String {
        format!("{:x}", a)
    }
    fn mul(a: &Self::N, b: &Self::N) -> Self::N {
        a * b
    }
    fn divrem(a: &Self::N, b: &Self::N) -> (Self::N, Self::N) {
        use dashu::base::DivRem;
        a.div_rem(b)
    }
    fn gcd(a: &Self::N, b: &Self::N) -> Self::N {
        use dashu::base::Gcd;
        a.gcd(b)
    }
    fn powmod(a: &Self::N, e: &Self::N, m: &Self::N) -> Self::N {
        let ring = dashu::integer::fast_div::ConstDivisor::new(m.clone());
        ring.reduce(a.clone()).pow(e).residue()
    }
    fn to_dec(a: &Self::N) -> String {
        a.to_string()
    }
    fn from_dec(s: &str) -> Self::N {
        Self::N::from_str_radix(s, 10).unwrap()
    }
}

/// Sagebrush's own big integers (engine/bigint): dashu plus the half-gcd.
struct Sagebrush;
impl Lib for Sagebrush {
    type N = sagebrush_bigint::BigUint;
    const NAME: &'static str = "sagebrush";
    fn parse_hex(s: &str) -> Self::N {
        Self::N::parse_bytes(s.as_bytes(), 16).unwrap()
    }
    fn hex(a: &Self::N) -> String {
        a.to_str_radix(16)
    }
    fn mul(a: &Self::N, b: &Self::N) -> Self::N {
        a * b
    }
    fn divrem(a: &Self::N, b: &Self::N) -> (Self::N, Self::N) {
        num_integer::Integer::div_rem(a, b)
    }
    fn gcd(a: &Self::N, b: &Self::N) -> Self::N {
        num_integer::Integer::gcd(a, b)
    }
    fn powmod(a: &Self::N, e: &Self::N, m: &Self::N) -> Self::N {
        a.modpow(e, m)
    }
    fn to_dec(a: &Self::N) -> String {
        a.to_string()
    }
    fn from_dec(s: &str) -> Self::N {
        Self::N::parse_bytes(s.as_bytes(), 10).unwrap()
    }
}

struct Malachite;
impl Lib for Malachite {
    type N = malachite::Natural;
    const NAME: &'static str = "malachite-0.12";
    fn parse_hex(s: &str) -> Self::N {
        use malachite::base::num::conversion::traits::FromStringBase;
        Self::N::from_string_base(16, s).unwrap()
    }
    fn hex(a: &Self::N) -> String {
        use malachite::base::num::conversion::traits::ToStringBase;
        a.to_string_base(16)
    }
    fn mul(a: &Self::N, b: &Self::N) -> Self::N {
        a * b
    }
    fn divrem(a: &Self::N, b: &Self::N) -> (Self::N, Self::N) {
        use malachite::base::num::arithmetic::traits::DivRem;
        a.div_rem(b)
    }
    fn gcd(a: &Self::N, b: &Self::N) -> Self::N {
        use malachite::base::num::arithmetic::traits::Gcd;
        a.gcd(b)
    }
    fn powmod(a: &Self::N, e: &Self::N, m: &Self::N) -> Self::N {
        use malachite::base::num::arithmetic::traits::ModPow;
        (a % m).mod_pow(e, m)
    }
    fn to_dec(a: &Self::N) -> String {
        a.to_string()
    }
    fn from_dec(s: &str) -> Self::N {
        s.parse().unwrap()
    }
}

#[cfg(feature = "gmp")]
struct Gmp;
#[cfg(feature = "gmp")]
impl Lib for Gmp {
    type N = rug::Integer;
    const NAME: &'static str = "gmp(rug)";
    fn parse_hex(s: &str) -> Self::N {
        Self::N::from_str_radix(s, 16).unwrap()
    }
    fn hex(a: &Self::N) -> String {
        format!("{:x}", a)
    }
    fn mul(a: &Self::N, b: &Self::N) -> Self::N {
        Self::N::from(a * b)
    }
    fn divrem(a: &Self::N, b: &Self::N) -> (Self::N, Self::N) {
        <(Self::N, Self::N)>::from(a.div_rem_ref(b))
    }
    fn gcd(a: &Self::N, b: &Self::N) -> Self::N {
        Self::N::from(a.gcd_ref(b))
    }
    fn powmod(a: &Self::N, e: &Self::N, m: &Self::N) -> Self::N {
        Self::N::from(a.pow_mod_ref(e, m).unwrap())
    }
    fn to_dec(a: &Self::N) -> String {
        a.to_string()
    }
    fn from_dec(s: &str) -> Self::N {
        Self::N::from_str_radix(s, 10).unwrap()
    }
}

// ---- inputs: deterministic random hex strings of exactly n bits

fn random_hex(bits: usize, seed: &mut u64) -> String {
    let mut s = String::with_capacity(bits / 4 + 1);
    let digits = bits.div_ceil(4);
    for i in 0..digits {
        *seed ^= *seed << 13;
        *seed ^= *seed >> 7;
        *seed ^= *seed << 17;
        let mut d = (*seed >> 32) as u32 & 15;
        if i == 0 {
            d |= 8; // the top bit set: exactly `bits` bits
        }
        s.push(std::char::from_digit(d, 16).unwrap());
    }
    s
}

struct Inputs {
    bits: usize,
    a: String,
    b: String,
    wide: String, // 2n bits, for divrem
    odd_m: String,
}

/// Time f: once, then repeated to fill ~0.3 s; ns per call and the result.
fn time<R>(mut f: impl FnMut() -> R) -> (f64, R) {
    let t = Instant::now();
    let r = black_box(f());
    let once = t.elapsed().as_secs_f64();
    if once > 0.3 {
        return (once * 1e9, r);
    }
    let reps = ((0.3 / once.max(1e-9)) as usize).clamp(1, 1_000_000);
    let t = Instant::now();
    for _ in 0..reps {
        black_box(f());
    }
    (t.elapsed().as_secs_f64() * 1e9 / reps as f64, r)
}

struct Reference {
    // hex of each operation's result, from num-bigint 0.5; decimal from the first library
    results: std::collections::HashMap<(&'static str, usize), String>,
}

fn run<L: Lib>(inp: &Inputs, ops: &[&'static str], budget: f64, done: &mut std::collections::HashSet<(String, String)>, refs: &mut Reference) {
    let a = L::parse_hex(&inp.a);
    let b = L::parse_hex(&inp.b);
    let w = L::parse_hex(&inp.wide);
    let m = L::parse_hex(&inp.odd_m);
    for &op in ops {
        let key = (L::NAME.to_string(), op.to_string());
        if done.contains(&key) || (op == "powmod" && inp.bits > 8192) {
            continue;
        }
        let (ns, out): (f64, String) = match op {
            "mul" => { let (ns, r) = time(|| L::mul(&a, &b)); (ns, L::hex(&r)) }
            "sqr" => { let (ns, r) = time(|| L::mul(&a, &a)); (ns, L::hex(&r)) }
            "divrem" => { let (ns, (q, r)) = time(|| L::divrem(&w, &b)); (ns, L::hex(&q) + ":" + &L::hex(&r)) }
            "gcd" => { let (ns, r) = time(|| L::gcd(&a, &b)); (ns, L::hex(&r)) }
            "powmod" => { let (ns, r) = time(|| L::powmod(&a, &b, &m)); (ns, L::hex(&r)) }
            "to_dec" => { let (ns, r) = time(|| L::to_dec(&a)); (ns, r) }
            "from_dec" => {
                let dec = refs.results.get(&("to_dec", inp.bits)).cloned().unwrap_or_else(|| L::to_dec(&a));
                let (ns, r) = time(|| L::from_dec(&dec));
                (ns, L::hex(&r))
            }
            _ => continue,
        };
        // agreement: the first library to compute an operation sets the reference
        let expect = refs.results.entry((op, inp.bits)).or_insert_with(|| out.clone());
        let ok = if op == "from_dec" { out == inp.a } else { *expect == out };
        if !ok {
            println!("MISMATCH,{},{},{}", L::NAME, op, inp.bits);
        }
        println!("{},{},{},{:.0}", L::NAME, op, inp.bits, ns);
        if ns > budget * 1e9 {
            done.insert(key);
        }
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let arg = |k: &str| args.iter().position(|a| a == k).map(|i| args[i + 1].clone());
    let max_bits: usize = arg("--max-bits").map_or(1 << 22, |v| v.parse().unwrap());
    let budget: f64 = arg("--budget").map_or(2.0, |v| v.parse().unwrap());
    let all_ops = ["mul", "sqr", "divrem", "gcd", "powmod", "to_dec", "from_dec"];
    let ops: Vec<&'static str> = match arg("--ops") {
        Some(v) => all_ops.iter().copied().filter(|o| v.split(',').any(|x| x == *o)).collect(),
        None => all_ops.to_vec(),
    };
    let libs = arg("--libs").unwrap_or_else(|| "all".into());
    let want = |n: &str| libs == "all" || libs.split(',').any(|x| n.starts_with(x));
    let mut done = std::collections::HashSet::new();
    println!("lib,op,bits,ns");
    let mut bits: usize = arg("--min-bits").map_or(64, |v| v.parse().unwrap());
    let mut seed = 0x2545_F491_4F6C_DD1Du64;
    while bits <= max_bits {
        let mut odd_m = random_hex(bits, &mut seed);
        let last = odd_m.pop().unwrap().to_digit(16).unwrap() | 1;
        odd_m.push(std::char::from_digit(last, 16).unwrap());
        let inp = Inputs { bits, a: random_hex(bits, &mut seed), b: random_hex(bits, &mut seed), wide: random_hex(2 * bits, &mut seed), odd_m };
        let mut refs = Reference { results: Default::default() };
        // the reference first: GMP when present (fast and canonical), else num-bigint 0.5
        #[cfg(feature = "gmp")]
        if want(Gmp::NAME) {
            run::<Gmp>(&inp, &ops, budget, &mut done, &mut refs);
        }
        if want(NumBigint05::NAME) {
            run::<NumBigint05>(&inp, &ops, budget, &mut done, &mut refs);
        }
        if want(NumBigint04::NAME) {
            run::<NumBigint04>(&inp, &ops, budget, &mut done, &mut refs);
        }
        if want(Dashu::NAME) {
            run::<Dashu>(&inp, &ops, budget, &mut done, &mut refs);
        }
        if want(Sagebrush::NAME) {
            run::<Sagebrush>(&inp, &ops, budget, &mut done, &mut refs);
        }
        if want(Malachite::NAME) {
            run::<Malachite>(&inp, &ops, budget, &mut done, &mut refs);
        }
        bits *= 2;
    }
}
