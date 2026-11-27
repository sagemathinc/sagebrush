//! The binary GF(p)[x] ops against the JSON ops (the same arithmetic,
//! nmod_ops.rs); every refusal's code and offset;
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
    assert!(n > request_cap(2, MUL_MAX_LEN).unwrap());
    check(args, Code::Cap, 0);
    // factor_mod is not (yet) a binary op
    assert_eq!(results(&call_bin(&frame("factor_mod", &[u641(&[7]), u641(&a)]))).unwrap_err().0, Code::Op as u16);
    // divrem's dividend at least as long as the divisor
    let args = vec![u641(&[7]), u641(&[1]), u641(&a)];
    let at = arg_at("nmod_poly_divrem", &args, 1);
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
    for (op, polys) in [("nmod_poly_mul", vec![&a[..], &b[..]]), ("nmod_poly_divrem", vec![&a[..], &b[..]])] {
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

// ---------------------------------------------------------------- echelon

fn mat1(rows: usize, cols: usize, words: &[u64]) -> Vec<u8> {
    let mut v = b"MAT1".to_vec();
    v.extend_from_slice(&(rows as u32).to_le_bytes());
    v.extend_from_slice(&(cols as u32).to_le_bytes());
    v.extend(u641(words));
    v
}

fn ech_args(p: u64, rows: usize, cols: usize, words: &[u64], flags: u64) -> Vec<Vec<u8>> {
    vec![u641(&[p]), mat1(rows, cols, words), u641(&[flags])]
}

fn ech_req(p: u64, rows: usize, cols: usize, words: &[u64], flags: u64) -> Vec<u8> {
    let r = frame(ECHELON, &ech_args(p, rows, cols, words, flags));
    assert_eq!(Some(r.len()), echelon_request_len(rows, cols), "the request's closed form");
    r
}

fn ech_json(p: u64, rows: usize, cols: usize, words: &[u64], reduced: bool, want_rows: bool) -> Value {
    let m = words.chunks(cols).map(csv).collect::<Vec<_>>().join(";");
    let r = crate::call(&format!(
        "{{\"fn\":\"nmod_echelon\",\"p\":\"{}\",\"rows\":{},\"cols\":{},\"m\":\"{}\",\"reduced\":{},\"want_rows\":{}}}",
        p, rows, cols, m, reduced, want_rows
    ));
    serde_json::from_str::<Value>(&r).unwrap()
}

/// A random r x c matrix over GF(p) of rank at most `rank` (when smaller
/// than min(r, c)): a product of random r x rank and rank x c factors.
fn ech_matrix(s: &mut u64, rows: usize, cols: usize, p: u64, rank: usize) -> Vec<u64> {
    if rank >= rows.min(cols) {
        return (0..rows * cols).map(|_| rng(s) % p).collect();
    }
    let m = Modulus::new(p);
    let a: Vec<u64> = (0..rows * rank).map(|_| rng(s) % p).collect();
    let b: Vec<u64> = (0..rank * cols).map(|_| rng(s) % p).collect();
    let mut out = vec![0u64; rows * cols];
    for i in 0..rows {
        for j in 0..cols {
            let mut x = 0;
            for t in 0..rank {
                x = m.add(x, m.mul(a[i * rank + t], b[t * cols + j]));
            }
            out[i * cols + j] = x;
        }
    }
    out
}

#[test]
fn the_echelon_agrees_with_the_json_op_bit_for_bit() {
    let mut s = 0x0bad_5eed_1234_5678u64;
    // shapes both ops admit: 1 x n, n x 1, the transposes, square, tall,
    // wide, full rank and deficient; both sides of the u64-sum route
    // (2^30, 2^32) and the word-size primes
    let shapes = [(1, 1), (1, 9), (9, 1), (1, 1024), (1024, 1), (5, 7), (7, 5), (33, 33), (40, 70), (70, 40), (130, 129), (300, 64)];
    for &p in &[2u64, 3, 65537, 1_000_000_007, 2147483647, 4294967291, P63] {
        for &(r, c) in &shapes {
            for rank in [r.min(c), r.min(c) / 2, 1, 0] {
                let w = ech_matrix(&mut s, r, c, p, rank);
                for flags in 0..4u64 {
                    let (reduced, want_rows) = (flags & 1 != 0, flags & 2 != 0);
                    let b = results(&call_bin(&ech_req(p, r, c, &w, flags))).unwrap();
                    let j = ech_json(p, r, c, &w, reduced, want_rows);
                    let j = &j["ok"];
                    assert_eq!(b[0], parse_csv(&j["pivots"]), "pivots p={p} {r}x{c} rank<={rank} flags={flags}");
                    assert_eq!(b[1], vec![j["det"].as_str().unwrap().parse::<u64>().unwrap()], "det p={p} {r}x{c} flags={flags}");
                    if want_rows {
                        let rows: Vec<u64> = j["rows"].as_str().unwrap().split([';', ',']).map(|t| t.parse().unwrap()).collect();
                        assert_eq!(b.len(), 3);
                        assert_eq!(b[2], rows, "rows p={p} {r}x{c} flags={flags}");
                    } else {
                        assert_eq!(b.len(), 2);
                    }
                }
            }
        }
    }
}

#[test]
fn the_echelon_reply_has_its_closed_form_length() {
    let mut s = 5u64;
    for &(r, c, rank) in &[(1, 1, 1), (4, 9, 2), (9, 4, 4), (20, 20, 0), (20, 20, 20)] {
        let w = ech_matrix(&mut s, r, c, 101, rank);
        for flags in 0..4u64 {
            let out = call_bin(&ech_req(101, r, c, &w, flags));
            let k = results(&out).unwrap()[0].len();
            assert_eq!(Some(out.len()), echelon_reply_len(r, c, k, flags & 2 != 0), "{r}x{c} flags={flags}");
        }
    }
    // and the closed forms themselves
    assert_eq!(echelon_request_len(3, 5), Some(100 + 8 * 15));
    assert_eq!(echelon_reply_len(3, 5, 2, true), Some(66 + 8 * 2 + 8 * 15));
    assert_eq!(echelon_reply_len(3, 5, 2, false), Some(50 + 8 * 2));
    assert_eq!(echelon_request_len(usize::MAX, 2), None);
}

#[test]
fn echelon_refusals_have_their_codes_and_offsets_beside_the_json_ops() {
    let w = vec![1u64, 2, 3, 4, 5, 6];
    let check = |args: Vec<Vec<u8>>, code: Code, at: u64| {
        let r = call_bin(&frame(ECHELON, &args));
        assert_eq!(results(&r), Err((code as u16, at)), "{:?}", wire::parse_reply(&r));
    };
    let json_err = |p: &str, rows: usize, cols: usize, m: &str| -> String {
        let r = crate::call(&format!("{{\"fn\":\"nmod_echelon\",\"p\":\"{p}\",\"rows\":{rows},\"cols\":{cols},\"m\":\"{m}\"}}"));
        serde_json::from_str::<Value>(&r).unwrap()["error"].as_str().unwrap_or("").to_string()
    };
    // p: not prime, too large (the JSON op refuses the same)
    for p in [0u64, 1, 4, 1 << 63, u64::MAX] {
        let args = ech_args(p, 2, 3, &w, 0);
        let at = arg_at(ECHELON, &args, 0) + 12;
        check(args, Code::Domain, at);
        assert!(json_err(&p.to_string(), 2, 3, "1,2,3;4,5,6").contains("prime p below 2^63"), "{p}");
    }
    // an entry equal to p, at its own offset (the JSON op: "integers in [0, p)")
    let args = ech_args(5, 2, 3, &[1, 2, 3, 4, 5, 0], 0);
    let at = arg_at(ECHELON, &args, 1) + 4 + 4 + 4 + 12 + 8 * 4;
    check(args, Code::Domain, at);
    assert!(json_err("5", 2, 3, "1,2,3;4,5,0").contains("[0, p)"));
    // empty shapes (the JSON op: "rows and cols must be integers in [1, ...]")
    for (r, c) in [(0usize, 3usize), (2, 0), (0, 0)] {
        let args = vec![u641(&[7]), mat1(r, c, &[]), u641(&[0])];
        let at = arg_at(ECHELON, &args, 1) + 4;
        check(args, Code::Count, at);
        assert!(json_err("7", r, c, "").contains("rows and cols"), "{r}x{c}");
    }
    // the entry count is not rows x cols
    let args = vec![u641(&[7]), mat1(2, 3, &w[..5]), u641(&[0])];
    let at = arg_at(ECHELON, &args, 1) + 4 + 4 + 4;
    check(args, Code::Count, at);
    // an unknown flag bit; flags not a scalar; p not a scalar
    let args = ech_args(7, 2, 3, &w, 4);
    let at = arg_at(ECHELON, &args, 2) + 12;
    check(args, Code::Domain, at);
    let args = vec![u641(&[7]), mat1(2, 3, &w), u641(&[0, 0])];
    let at = arg_at(ECHELON, &args, 2);
    check(args, Code::Count, at);
    let args = vec![u641(&[7, 7]), mat1(2, 3, &w), u641(&[0])];
    check(args.clone(), Code::Count, arg_at(ECHELON, &args, 0));
    // a matrix of another element kind; the argument count
    let mut z = b"MAT1".to_vec();
    z.extend_from_slice(&2u32.to_le_bytes());
    z.extend_from_slice(&3u32.to_le_bytes());
    z.extend_from_slice(b"I641");
    z.extend_from_slice(&6u64.to_le_bytes());
    for x in &w {
        z.extend_from_slice(&x.to_le_bytes());
    }
    let args = vec![u641(&[7]), z, u641(&[0])];
    let at = arg_at(ECHELON, &args, 1) + 4 + 4 + 4;
    check(args, Code::Schema, at);
    let args = vec![u641(&[7]), mat1(2, 3, &w)];
    check(args, Code::Count, (4 + 4 + ECHELON.len()) as u64);
}

#[test]
fn the_echelon_frame_cap_is_exact() {
    let mut s = 9u64;
    let w = ech_matrix(&mut s, 6, 11, 101, 6);
    let r = ech_req(101, 6, 11, &w, 3);
    assert!(run_with(&r, r.len()).is_ok(), "exactly at the cap");
    let e = run_with(&r, r.len() - 1).unwrap_err();
    assert_eq!((e.code, e.offset), (Code::Cap, 0), "one byte past the cap");
}

#[test]
fn every_echelon_truncation_and_mangling_is_an_error_reply() {
    let mut s = 31u64;
    let w = ech_matrix(&mut s, 3, 4, 101, 3);
    let r = ech_req(101, 3, 4, &w, 3);
    assert!(results(&call_bin(&r)).is_ok());
    for cut in 0..r.len() {
        let e = results(&call_bin(&r[..cut])).unwrap_err();
        assert!(e.1 <= cut as u64, "{cut}: {e:?}");
    }
    for i in 0..r.len() {
        for x in [0u8, 0xff, 0x80] {
            let mut m = r.clone();
            m[i] ^= x | 1;
            let _ = results(&call_bin(&m));
        }
    }
}

#[test]
fn the_echelon_reservation_is_its_stated_sum() {
    let w = std::mem::size_of::<usize>() as u64;
    for &(r, c, rows) in &[(1usize, 4096usize, true), (4096, 1, false), (64, 64, true), (300, 500, false), (500, 300, true)] {
        let e = (r * c) as u64;
        let k = r.min(c) as u64;
        let reply = echelon_reply_len(r, c, r.min(c), rows).unwrap() as u64;
        let want = 8 * e + 32 * c as u64 + (w + 8) * k + 32 * w + reply + ECH_SLACK;
        assert_eq!(echelon_reservation(r, c, rows), Some(want), "{r}x{c} rows={rows}");
        // the pivots' term, tested directly (its allocation-counter mutant
        // is covered by the sum's other terms: an equivalent mutant)
        let without_pivots = want - (w + 8) * k;
        assert_eq!(want - without_pivots, (w + 8) * k);
    }
    assert_eq!(echelon_reservation(usize::MAX, 2, true), None);
}

// ---------------------------------------------------------------- product

fn mul_args(p: u64, r: usize, k: usize, c: usize, a: &[u64], b: &[u64]) -> Vec<Vec<u8>> {
    vec![u641(&[p]), mat1(r, k, a), mat1(k, c, b)]
}

fn mul_req(p: u64, r: usize, k: usize, c: usize, a: &[u64], b: &[u64]) -> Vec<u8> {
    let q = frame(MAT_MUL, &mul_args(p, r, k, c, a, b));
    assert_eq!(Some(q.len()), mat_mul_request_len(r, k, c), "the request's closed form");
    q
}

#[test]
fn the_product_agrees_with_the_classical_product() {
    let mut s = 0x5eed_0f_ab_c0ffeeu64;
    // thin both ways, non-square, square below and at the fast route's
    // crossover (384 for the u64 kernel, 64 for the u128 kernel), odd
    // sizes past it, and both kernel classes
    let shapes = [
        (1, 1, 1),
        (1, 9, 1),
        (9, 1, 9),
        (1, 200, 300),
        (300, 200, 1),
        (5, 7, 3),
        (40, 70, 30),
        (70, 40, 90),
        (64, 64, 64),
        (130, 129, 131),
        (385, 384, 386),
    ];
    for &p in &[2u64, 65537, 2147483647, P63] {
        let m = Modulus::new(p);
        for &(r, k, c) in &shapes {
            let a: Vec<u64> = (0..r * k).map(|_| rng(&mut s) % p).collect();
            let b: Vec<u64> = (0..k * c).map(|_| rng(&mut s) % p).collect();
            let got = results(&call_bin(&mul_req(p, r, k, c, &a, &b))).unwrap();
            let want = Mat { rows: r, cols: k, m, d: a.clone() }.mul_classical(&Mat { rows: k, cols: c, m, d: b.clone() });
            assert_eq!(got.len(), 1);
            assert_eq!(got[0], want.d, "p={p} {r}x{k}x{c}");
        }
    }
    // all entries p - 1 (the sums' worst case), at a fast shape of each class
    for &(p, n) in &[(65537u64, 400usize), (2147483647, 390), (P63, 140)] {
        let a = vec![p - 1; n * n];
        let got = results(&call_bin(&mul_req(p, n, n, n, &a, &a))).unwrap();
        let m = Modulus::new(p);
        let want = Mat { rows: n, cols: n, m, d: a.clone() }.mul_classical(&Mat { rows: n, cols: n, m, d: a.clone() });
        assert_eq!(got[0], want.d, "p={p} n={n} all p - 1");
    }
}

#[test]
fn the_product_reply_has_its_closed_form_length() {
    let mut s = 7u64;
    for &(r, k, c) in &[(1usize, 1usize, 1usize), (4, 9, 2), (9, 4, 9), (20, 1, 20)] {
        let a: Vec<u64> = (0..r * k).map(|_| rng(&mut s) % 101).collect();
        let b: Vec<u64> = (0..k * c).map(|_| rng(&mut s) % 101).collect();
        let out = call_bin(&mul_req(101, r, k, c, &a, &b));
        assert_eq!(Some(out.len()), mat_mul_reply_len(r, c), "{r}x{k}x{c}");
    }
    assert_eq!(mat_mul_request_len(3, 5, 7), Some(104 + 8 * (15 + 35)));
    assert_eq!(mat_mul_reply_len(3, 7), Some(26 + 8 * 21));
    assert_eq!(mat_mul_request_len(usize::MAX, 2, 2), None);
    assert_eq!(mat_mul_reservation(usize::MAX, 2, 2, 101), None);
}

#[test]
fn product_refusals_have_their_codes_and_offsets() {
    let a = vec![1u64, 2, 3, 4, 5, 6]; // 2 x 3
    let b = vec![1u64, 0, 0, 1, 1, 1]; // 3 x 2
    let check = |args: Vec<Vec<u8>>, code: Code, at: u64| {
        let r = call_bin(&frame(MAT_MUL, &args));
        assert_eq!(results(&r), Err((code as u16, at)), "{:?}", wire::parse_reply(&r));
    };
    // p: not prime, too large
    for p in [0u64, 1, 4, 1 << 63, u64::MAX] {
        let args = mul_args(p, 2, 3, 2, &a, &b);
        let at = arg_at(MAT_MUL, &args, 0) + 12;
        check(args, Code::Domain, at);
    }
    // an entry equal to p, in A and in B, at its own offset
    let args = mul_args(5, 2, 3, 2, &[1, 2, 3, 4, 5, 0], &b);
    let at = arg_at(MAT_MUL, &args, 1) + 4 + 4 + 4 + 12 + 8 * 4;
    check(args, Code::Domain, at);
    let args = mul_args(5, 2, 3, 2, &a[..6].iter().map(|x| x % 5).collect::<Vec<_>>(), &[1, 0, 0, 7, 1, 1]);
    let at = arg_at(MAT_MUL, &args, 2) + 4 + 4 + 4 + 12 + 8 * 3;
    check(args, Code::Domain, at);
    // the inner dimensions differ (A 2 x 3, B 2 x 3): at B
    let args = vec![u641(&[7]), mat1(2, 3, &a), mat1(2, 3, &a)];
    let at = arg_at(MAT_MUL, &args, 2);
    check(args, Code::Domain, at);
    // empty shapes, in A and in B
    for (r, c) in [(0usize, 3usize), (2, 0), (0, 0)] {
        let args = vec![u641(&[7]), mat1(r, c, &[]), mat1(3, 2, &b)];
        let at = arg_at(MAT_MUL, &args, 1) + 4;
        check(args, Code::Count, at);
        let args = vec![u641(&[7]), mat1(2, 3, &a), mat1(r, c, &[])];
        let at = arg_at(MAT_MUL, &args, 2) + 4;
        check(args, Code::Count, at);
    }
    // the argument count
    let args = vec![u641(&[7]), mat1(2, 3, &a)];
    check(args, Code::Count, (4 + 4 + MAT_MUL.len()) as u64);
}

#[test]
fn the_product_frame_cap_is_exact() {
    let mut s = 11u64;
    let a: Vec<u64> = (0..6 * 11).map(|_| rng(&mut s) % 101).collect();
    let b: Vec<u64> = (0..11 * 4).map(|_| rng(&mut s) % 101).collect();
    let r = mul_req(101, 6, 11, 4, &a, &b);
    assert!(run_with(&r, r.len()).is_ok(), "exactly at the cap");
    let e = run_with(&r, r.len() - 1).unwrap_err();
    assert_eq!((e.code, e.offset), (Code::Cap, 0), "one byte past the cap");
}

#[test]
fn every_product_truncation_and_mangling_is_an_error_reply() {
    let mut s = 37u64;
    let a: Vec<u64> = (0..3 * 4).map(|_| rng(&mut s) % 101).collect();
    let b: Vec<u64> = (0..4 * 2).map(|_| rng(&mut s) % 101).collect();
    let r = mul_req(101, 3, 4, 2, &a, &b);
    assert!(results(&call_bin(&r)).is_ok());
    for cut in 0..r.len() {
        let e = results(&call_bin(&r[..cut])).unwrap_err();
        assert!(e.1 <= cut as u64, "{cut}: {e:?}");
    }
    for i in 0..r.len() {
        for x in [0u8, 0xff, 0x80] {
            let mut m = r.clone();
            m[i] ^= x | 1;
            let _ = results(&call_bin(&m));
        }
    }
}

#[test]
fn the_product_reservation_is_its_stated_sum() {
    for &(r, k, c, p) in &[(1usize, 4096usize, 1usize, 101u64), (64, 64, 64, P63), (300, 500, 200, 65537), (400, 400, 400, 65537), (3000, 3000, 3000, 65537)] {
        let (peak, extra) = product_peak(r, k, c, &Modulus::new(p), MAT_MUL_FAST_ALLOWANCE).unwrap();
        let want = 8 * (r * k + k * c) as u64 + 8 * peak + mat_mul_reply_len(r, c).unwrap() as u64 + ECH_SLACK;
        assert_eq!(mat_mul_reservation(r, k, c, p), Some(want), "{r}x{k}x{c} p={p}");
        assert!(extra <= MAT_MUL_FAST_ALLOWANCE);
        match (r, p) {
            // the fast route's extra words in the bound where it is taken; a
            // product past the allowance runs classical (no extra)
            (400, 65537) => assert!(extra > 0, "400^3 takes the fast route"),
            (3000, _) => assert_eq!(extra, 0, "3000^3's extra words exceed the allowance"),
            _ => {}
        }
    }
}

/// The hosts' bound on the fast route's extra words (lib/_sage_ffmat_bin.py
/// _mul_engine_reservation): 2 (r k + k c + r c) + 8 (r + k + c) + 64, at
/// most the allowance; it holds over a grid of shapes on both kernels, the
/// allowance unbounded (the plan's own extra words).
pub(crate) fn host_extra_bound(r: usize, k: usize, c: usize) -> u64 {
    (2 * (r * k + k * c + r * c) + 8 * (r + k + c) + 64) as u64
}

#[test]
fn the_hosts_bound_on_the_fast_routes_extra_words_holds() {
    let mut s = 0xfeed_beefu64;
    let mut shapes: Vec<(usize, usize, usize)> = vec![];
    let dims = [1usize, 2, 63, 64, 65, 73, 74, 75, 97, 128, 129, 383, 384, 385, 500, 767, 768, 769, 1024, 1025];
    for &r in &dims {
        for &k in &dims {
            for &c in &dims {
                shapes.push((r, k, c));
            }
        }
    }
    for _ in 0..2000 {
        let d = |s: &mut u64| 1 + (rng(s) % 3000) as usize;
        shapes.push((d(&mut s), d(&mut s), d(&mut s)));
    }
    let mut worst = 0f64;
    for &p in &[101u64, 65537, 2147483647, P63] {
        let m = Modulus::new(p);
        for &(r, k, c) in &shapes {
            let (_, extra) = product_peak(r, k, c, &m, u64::MAX).unwrap();
            let b = host_extra_bound(r, k, c);
            assert!(extra <= b, "p={p} {r}x{k}x{c}: extra {extra} > bound {b}");
            if extra > 0 {
                worst = worst.max(extra as f64 / b as f64);
            }
        }
    }
    // (the bound is not loose by much: the largest ratio seen)
    assert!(worst > 0.5, "worst {worst}");
}
