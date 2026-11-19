//! The binary GF(p)[x] ops against the JSON ops (the same arithmetic,
//! nmod_ops.rs) and factor_mod over Z; every refusal's code and offset;
//! every truncation of a request.  The allocation spy and the peaks are
//! tests/bin_alloc.rs.

use super::*;
use serde_json::Value;

const P63: u64 = 9223372036854775783;

fn rng(s: &mut u64) -> u64 {
    *s ^= *s << 13;
    *s ^= *s >> 7;
    *s ^= *s << 17;
    *s
}

fn u641(w: &[u64]) -> Vec<u8> {
    let mut v = Vec::new();
    wire::put_u641(&mut v, w);
    v
}

fn frame(op: &str, args: &[Vec<u8>]) -> Vec<u8> {
    let mut v = wire::MAGIC.to_vec();
    v.extend_from_slice(&(op.len() as u32).to_le_bytes());
    v.extend_from_slice(op.as_bytes());
    v.extend_from_slice(&(args.len() as u32).to_le_bytes());
    for a in args {
        v.extend_from_slice(&(a.len() as u32).to_le_bytes());
        v.extend_from_slice(a);
    }
    v
}

fn req(op: &str, p: u64, polys: &[&[u64]]) -> Vec<u8> {
    let mut args = vec![u641(&[p])];
    args.extend(polys.iter().map(|q| u641(q)));
    frame(op, &args)
}

/// The results as word vectors, or the error's (code, offset).
fn results(r: &[u8]) -> Result<Vec<Vec<u64>>, (u16, u64)> {
    match wire::parse_reply(r).expect("a well-formed reply") {
        Ok(ps) => Ok(ps
            .iter()
            .map(|p| {
                let a = wire::Arg { bytes: p, offset: 0 };
                wire::u641(a).expect("a U641 result").iter().collect()
            })
            .collect()),
        Err(e) => Err(e),
    }
}

fn poly(s: &mut u64, n: usize, p: u64) -> Vec<u64> {
    let mut v: Vec<u64> = (0..n).map(|_| rng(s) % p).collect();
    if let Some(l) = v.last_mut() {
        if *l == 0 {
            *l = 1;
        }
    }
    v
}

fn csv(v: &[u64]) -> String {
    v.iter().map(|x| x.to_string()).collect::<Vec<_>>().join(",")
}

fn parse_csv(v: &Value) -> Vec<u64> {
    let s = v.as_str().unwrap();
    if s.is_empty() {
        vec![]
    } else {
        s.split(',').map(|t| t.parse().unwrap()).collect()
    }
}

fn json(op: &str, p: u64, a: &[u64], b: &[u64]) -> Value {
    let r = crate::call(&format!("{{\"fn\":\"{}\",\"p\":\"{}\",\"a\":\"{}\",\"b\":\"{}\"}}", op, p, csv(a), csv(b)));
    serde_json::from_str::<Value>(&r).unwrap()["ok"].clone()
}

#[test]
fn the_ops_agree_with_the_json_ops() {
    let mut s = 0x1234_5678_9abc_def1u64;
    // both sides of every cutoff (schoolbook/NTT, classical/Newton,
    // Euclid/half-gcd), small and 63-bit primes
    for &p in &[2u64, 3, 65537, 4294967291, P63] {
        for &(la, lb) in &[(1, 1), (5, 3), (40, 40), (200, 150), (1500, 1200), (3000, 1100)] {
            let a = poly(&mut s, la, p);
            let b = poly(&mut s, lb, p);
            let r = results(&call_bin(&req("nmod_poly_mul", p, &[&a, &b]))).unwrap();
            assert_eq!(r, vec![parse_csv(&json("nmod_poly_mul", p, &a, &b))], "mul {p} {la} {lb}");
            let r = results(&call_bin(&req("nmod_poly_divrem", p, &[&a, &b]))).unwrap();
            let j = json("nmod_poly_divrem", p, &a, &b);
            assert_eq!(r, vec![parse_csv(&j["q"]), parse_csv(&j["r"])], "divrem {p} {la} {lb}");
            let r = results(&call_bin(&req("nmod_poly_gcd", p, &[&a, &b]))).unwrap();
            assert_eq!(r, vec![parse_csv(&json("nmod_poly_gcd", p, &a, &b))], "gcd {p} {la} {lb}");
        }
    }
}

#[test]
fn factor_mod_agrees_with_the_bigint_entry() {
    let mut s = 0x0bad_cafe_1234_5678u64;
    for &p in &[2u64, 3, 7, 65537, 4294967291] {
        for n in [1usize, 2, 3, 8, 30] {
            let mut f = poly(&mut s, n, p);
            // a square factor now and then
            if n == 8 {
                let g = f.clone();
                f = nmod_poly::mul(&g, &g, &Modulus::new(p));
            }
            let big: Vec<sagebrush_bigint::BigInt> = f.iter().map(|&c| c.into()).collect();
            let want = sagebrush_poly::factor_mod(&big, p);
            let r = results(&call_bin(&req("factor_mod", p, &[&f]))).unwrap();
            let mut got = vec![];
            let mut at = 0;
            for w in r[1].chunks(2) {
                let len = w[0] as usize;
                got.push((r[0][at..at + len].to_vec(), w[1] as u32));
                at += len;
            }
            assert_eq!(at, r[0].len());
            assert_eq!(got, want, "p {p} n {n}");
            // within the reply bound: total length and shape at most 2 la
            assert!(r[0].len() <= 2 * f.len() && r[1].len() <= 2 * f.len());
        }
    }
}

/// The offset of argument i's payload in a request of op `op` (name
/// length n): the header, name, count, then (length + payload) each.
fn arg_at(op: &str, args: &[Vec<u8>], i: usize) -> u64 {
    let mut at = 4 + 4 + op.len() + 4;
    for a in &args[..i] {
        at += 4 + a.len();
    }
    (at + 4) as u64
}

#[test]
fn refusals_have_their_codes_and_offsets() {
    let op = "nmod_poly_mul";
    let a = vec![1u64, 2, 3];
    let check = |args: Vec<Vec<u8>>, code: Code, at: u64| {
        let r = call_bin(&frame(op, &args));
        assert_eq!(results(&r), Err((code as u16, at)), "{:?}", wire::parse_reply(&r));
    };
    // p: not prime, too large, not a scalar
    for p in [0u64, 1, 4, 1 << 63, u64::MAX] {
        let args = vec![u641(&[p]), u641(&a), u641(&a)];
        let at = arg_at(op, &args, 0) + 12;
        check(args, Code::Domain, at);
    }
    let args = vec![u641(&[7, 7]), u641(&a), u641(&a)];
    check(args.clone(), Code::Count, arg_at(op, &args, 0));
    // a coefficient >= p, at its own offset; a zero leading coefficient
    let args = vec![u641(&[7]), u641(&a), u641(&[1, 7, 1])];
    let at = arg_at(op, &args, 2) + 12 + 8;
    check(args, Code::Domain, at);
    let args = vec![u641(&[7]), u641(&a), u641(&[1, 0])];
    let at = arg_at(op, &args, 2) + 12 + 8;
    check(args, Code::Domain, at);
    // lengths 0 and the cap + 1 (the cap itself is the peak test's)
    let args = vec![u641(&[7]), u641(&[]), u641(&a)];
    let at = arg_at(op, &args, 1) + 4;
    check(args, Code::Count, at);
    let long = vec![1u64; MUL_MAX_LEN + 1];
    let args = vec![u641(&[7]), u641(&long), u641(&a)];
    let at = arg_at(op, &args, 1) + 4;
    check(args, Code::Count, at);
    // the argument count and the op cap
    let args = vec![u641(&[7]), u641(&a)];
    check(args, Code::Count, (4 + 4 + op.len()) as u64);
    let args = vec![u641(&[7]), u641(&vec![1u64; MUL_MAX_LEN]), u641(&vec![1u64; MUL_MAX_LEN + 3])];
    let n = frame(op, &args).len();
    assert!(n > request_cap(2, MUL_MAX_LEN));
    check(args, Code::Cap, 0);
    // factor_mod's p is below 2^32
    let args = vec![u641(&[4294967311]), u641(&a)];
    let at = arg_at("factor_mod", &args, 0) + 12;
    let r = call_bin(&frame("factor_mod", &args));
    assert_eq!(results(&r), Err((Code::Domain as u16, at)));
    // divrem's dividend at least as long as the divisor
    let args = vec![u641(&[7]), u641(&[1]), u641(&a)];
    let at = arg_at("nmod_poly_divrem", &args, 1) - 4 + 4;
    let r = call_bin(&frame("nmod_poly_divrem", &args));
    assert_eq!(results(&r), Err((Code::Domain as u16, at)));
    // an unknown op, a JSON request, a legacy mpoly frame
    assert_eq!(results(&call_bin(&frame("nmod_poly_xgcd", &[]))).unwrap_err().0, Code::Op as u16);
    assert_eq!(results(&call_bin(b"{\"fn\":\"nmod_poly_mul\"}")).unwrap_err().0, Code::Header as u16);
    assert_eq!(results(&call_bin(&frame(op, &[])[4..])).unwrap_err().0, Code::Header as u16);
}

#[test]
fn every_truncation_and_mangling_is_an_error_reply() {
    let mut s = 77u64;
    let a = poly(&mut s, 9, 101);
    let b = poly(&mut s, 4, 101);
    for (op, polys) in [("nmod_poly_mul", vec![&a[..], &b[..]]), ("factor_mod", vec![&a[..]])] {
        let r = req(op, 101, &polys);
        assert!(results(&call_bin(&r)).is_ok());
        for cut in 0..r.len() {
            let e = results(&call_bin(&r[..cut])).unwrap_err();
            assert!(e.1 <= cut as u64, "{op} {cut}: {e:?}");
        }
        for i in 0..r.len() {
            for x in [0u8, 0xff, 0x80] {
                let mut m = r.clone();
                m[i] ^= x | 1;
                // a typed reply either way; never a panic
                let _ = results(&call_bin(&m));
            }
        }
    }
}
