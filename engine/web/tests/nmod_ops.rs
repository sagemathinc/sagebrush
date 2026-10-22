//! nmod_echelon and the GF(p)[x] ops against direct reference versions
//! (a transcription of lib/_sage_ffmat.py's _echelon and the schoolbook
//! algorithms), their admission at each cap, and the shared transform
//! cache left alone.

use sagebrush_web::call;
use sagebrush_web::nmod_ops::*;
use serde_json::Value;

const PRIMES: [u64; 5] = [2, 7, 65537, 4601552919265804289, 9223372036854775783];

fn rng(s: &mut u64) -> u64 {
    *s ^= *s << 13;
    *s ^= *s >> 7;
    *s ^= *s << 17;
    *s
}

fn mulm(a: u64, b: u64, p: u64) -> u64 {
    (a as u128 * b as u128 % p as u128) as u64
}

fn subm(a: u64, b: u64, p: u64) -> u64 {
    ((a as u128 + p as u128 - b as u128) % p as u128) as u64
}

fn inv(a: u64, p: u64) -> u64 {
    let (mut r, mut b, mut e) = (1u64, a % p, p - 2);
    while e > 0 {
        if e & 1 == 1 {
            r = mulm(r, b, p);
        }
        b = mulm(b, b, p);
        e >>= 1;
    }
    r
}

fn ok(req: &str) -> Value {
    let r: Value = serde_json::from_str(&call(req)).unwrap();
    r.get("ok").cloned().unwrap_or_else(|| panic!("{} -> {}", &req[..req.len().min(200)], r))
}

fn err(req: &str) -> String {
    let r: Value = serde_json::from_str(&call(req)).unwrap();
    r.get("error").and_then(|e| e.as_str()).unwrap_or_else(|| panic!("{} -> {}", &req[..req.len().min(200)], r)).to_string()
}

fn csv(v: &[u64]) -> String {
    v.iter().map(|x| x.to_string()).collect::<Vec<_>>().join(",")
}

fn uncsv(s: &str) -> Vec<u64> {
    if s.is_empty() {
        vec![]
    } else {
        s.split(',').map(|t| t.parse().unwrap()).collect()
    }
}

fn rows_text(m: &[Vec<u64>]) -> String {
    m.iter().map(|r| csv(r)).collect::<Vec<_>>().join(";")
}

/// lib/_sage_ffmat.py's _echelon, transcribed.
fn gauss_jordan(mut m: Vec<Vec<u64>>, ncols: usize, p: u64) -> (Vec<Vec<u64>>, Vec<usize>, u64) {
    let mut pivots = vec![];
    let mut det = 1 % p;
    let mut r = 0;
    let nrows = m.len();
    for c in 0..ncols {
        let Some(piv) = (r..nrows).find(|&i| m[i][c] != 0) else { continue };
        if piv != r {
            m.swap(r, piv);
            det = subm(0, det, p);
        }
        let iv = inv(m[r][c], p);
        det = mulm(det, m[r][c], p);
        m[r] = m[r].iter().map(|&x| mulm(x, iv, p)).collect();
        for i in 0..nrows {
            if i != r && m[i][c] != 0 {
                let f = m[i][c];
                let pr = m[r].clone();
                m[i] = m[i].iter().zip(&pr).map(|(&x, &y)| subm(x, mulm(f, y, p), p)).collect();
            }
        }
        pivots.push(c);
        r += 1;
        if r == nrows {
            break;
        }
    }
    (m, pivots, det)
}

fn echelon_req(m: &[Vec<u64>], cols: usize, p: u64, reduced: bool, want_rows: bool) -> String {
    format!(
        r#"{{"fn":"nmod_echelon","p":"{}","rows":{},"cols":{},"m":"{}","reduced":{},"want_rows":{}}}"#,
        p,
        m.len(),
        cols,
        rows_text(m),
        reduced,
        want_rows
    )
}

/// A random rows x cols matrix of rank about `rank` (products of random
/// factors), with some zero and repeated rows.
fn matrix(s: &mut u64, rows: usize, cols: usize, rank: usize, p: u64) -> Vec<Vec<u64>> {
    let a: Vec<Vec<u64>> = (0..rows).map(|_| (0..rank).map(|_| rng(s) % p).collect()).collect();
    let b: Vec<Vec<u64>> = (0..rank).map(|_| (0..cols).map(|_| rng(s) % p).collect()).collect();
    let mut m: Vec<Vec<u64>> = (0..rows)
        .map(|i| (0..cols).map(|j| (0..rank).fold(0, |acc, t| ((acc as u128 + mulm(a[i][t], b[t][j], p) as u128) % p as u128) as u64)).collect())
        .collect();
    if rows > 3 {
        m[1] = vec![0; cols];
        m[3] = m[2].clone();
    }
    m
}

fn stats() -> (u64, u64, u64) {
    let v = ok(r#"{"fn":"ntt_cache_stats"}"#);
    (v[0].as_u64().unwrap(), v[1].as_u64().unwrap(), v[2].as_u64().unwrap())
}

#[test]
fn echelon_matches_python_echelon() {
    let mut s = 0x9e3779b97f4a7c15u64;
    for &p in &PRIMES {
        for (rows, cols, rank) in [(1, 1, 1), (1, 5, 1), (5, 1, 1), (3, 3, 3), (4, 6, 2), (6, 4, 3), (17, 17, 17), (20, 35, 12), (40, 21, 21), (33, 70, 33)] {
            let m = matrix(&mut s, rows, cols, rank, p);
            let (want, wpiv, wdet) = gauss_jordan(m.clone(), cols, p);
            for (reduced, want_rows) in [(true, true), (false, false)] {
                let r = ok(&echelon_req(&m, cols, p, reduced, want_rows));
                let piv: Vec<usize> = uncsv(r["pivots"].as_str().unwrap()).into_iter().map(|x| x as usize).collect();
                assert_eq!(piv, wpiv, "p={p} {rows}x{cols}");
                assert_eq!(r["det"].as_str().unwrap(), wdet.to_string(), "p={p} {rows}x{cols}");
                if want_rows {
                    let got: Vec<Vec<u64>> = r["rows"].as_str().unwrap().split(';').map(uncsv).collect();
                    assert_eq!(got, want, "p={p} {rows}x{cols}");
                } else {
                    assert!(r.get("rows").is_none());
                }
            }
        }
    }
    // an [A | b] inconsistent only in its last column; zero matrices
    let a = vec![vec![1, 2, 3], vec![2, 4, 5]];
    let r = ok(&echelon_req(&a, 3, 7, true, true));
    assert_eq!((r["pivots"].as_str().unwrap(), r["rows"].as_str().unwrap()), ("0,2", "1,2,0;0,0,1"));
    let z = vec![vec![0, 0], vec![0, 0]];
    let r = ok(&echelon_req(&z, 2, 5, true, true));
    assert_eq!((r["pivots"].as_str().unwrap(), r["det"].as_str().unwrap(), r["rows"].as_str().unwrap()), ("", "1", "0,0;0,0"));
}

#[test]
fn echelon_long_back_substitution() {
    // more than 64 pivots in 1024 columns: back substitution in chunks
    let p = 65537;
    let mut s = 77u64;
    let m = matrix(&mut s, 150, 1024, 140, p);
    let (want, wpiv, wdet) = gauss_jordan(m.clone(), 1024, p);
    let r = ok(&echelon_req(&m, 1024, p, true, true));
    assert_eq!(uncsv(r["pivots"].as_str().unwrap()).len(), wpiv.len());
    assert_eq!(r["det"].as_str().unwrap(), wdet.to_string());
    let got: Vec<Vec<u64>> = r["rows"].as_str().unwrap().split(';').map(uncsv).collect();
    assert_eq!(got, want);
}

fn naive_mul(a: &[u64], b: &[u64], p: u64) -> Vec<u64> {
    let mut c = vec![0u64; a.len() + b.len() - 1];
    for (i, &x) in a.iter().enumerate() {
        for (j, &y) in b.iter().enumerate() {
            c[i + j] = ((c[i + j] as u128 + mulm(x, y, p) as u128) % p as u128) as u64;
        }
    }
    trim(c)
}

fn trim(mut v: Vec<u64>) -> Vec<u64> {
    while v.last() == Some(&0) {
        v.pop();
    }
    v
}

fn naive_divrem(a: &[u64], b: &[u64], p: u64) -> (Vec<u64>, Vec<u64>) {
    let mut r = a.to_vec();
    let db = b.len() - 1;
    if r.len() <= db {
        return (vec![], trim(r));
    }
    let li = inv(b[db], p);
    let mut q = vec![0u64; r.len() - db];
    for i in (0..r.len() - db).rev() {
        let c = mulm(r[i + db], li, p);
        q[i] = c;
        for j in 0..=db {
            r[i + j] = subm(r[i + j], mulm(c, b[j], p), p);
        }
    }
    r.truncate(db);
    (trim(q), trim(r))
}

fn naive_gcd(a: &[u64], b: &[u64], p: u64) -> Vec<u64> {
    let (mut a, mut b) = (trim(a.to_vec()), trim(b.to_vec()));
    while !b.is_empty() {
        let r = naive_divrem(&a, &b, p).1;
        a = std::mem::replace(&mut b, r);
    }
    match a.last() {
        None => a,
        Some(&l) => {
            let li = inv(l, p);
            a.iter().map(|&x| mulm(x, li, p)).collect()
        }
    }
}

fn poly(s: &mut u64, n: usize, p: u64) -> Vec<u64> {
    let mut v: Vec<u64> = (0..n).map(|_| rng(s) % p).collect();
    if v[n - 1] == 0 {
        v[n - 1] = 1;
    }
    v
}

fn preq(f: &str, a: &[u64], b: &[u64], p: u64) -> String {
    format!(r#"{{"fn":"{}","p":"{}","a":"{}","b":"{}"}}"#, f, p, csv(a), csv(b))
}

#[test]
fn polys_match_schoolbook() {
    let before = stats();
    let mut s = 4242u64;
    for &p in &PRIMES {
        for (la, lb) in [(1, 1), (1, 9), (39, 39), (40, 40), (41, 300), (300, 41), (59, 59), (200, 60), (400, 130), (1000, 61), (61, 2)] {
            let (a, b) = (poly(&mut s, la, p), poly(&mut s, lb, p));
            assert_eq!(uncsv(ok(&preq("nmod_poly_mul", &a, &b, p)).as_str().unwrap()), naive_mul(&a, &b, p), "p={p} {la} {lb}");
            let (q, r) = naive_divrem(&a, &b, p);
            let got = ok(&preq("nmod_poly_divrem", &a, &b, p));
            assert_eq!((uncsv(got["q"].as_str().unwrap()), uncsv(got["r"].as_str().unwrap())), (q, r), "p={p} {la} {lb}");
            // a common factor
            let g = poly(&mut s, 1 + la / 3, p);
            let (ga, gb) = (naive_mul(&a, &g, p), naive_mul(&b, &g, p));
            assert_eq!(uncsv(ok(&preq("nmod_poly_gcd", &ga, &gb, p)).as_str().unwrap()), naive_gcd(&ga, &gb, p), "p={p} {la} {lb}");
        }
        // equal operands, constants, an exact quotient
        let a = poly(&mut s, 100, p);
        assert_eq!(uncsv(ok(&preq("nmod_poly_gcd", &a, &a, p)).as_str().unwrap()), naive_gcd(&a, &a, p));
        assert_eq!(ok(&preq("nmod_poly_gcd", &a, &[1 % p.max(2)], p)).as_str().unwrap(), "1");
        let b = poly(&mut s, 70, p);
        let ab = naive_mul(&a, &b, p);
        let got = ok(&preq("nmod_poly_divrem", &ab, &b, p));
        assert_eq!((uncsv(got["q"].as_str().unwrap()), got["r"].as_str().unwrap()), (a.clone(), ""));
        let got = ok(&preq("nmod_poly_divrem", &b, &a, p));
        assert_eq!((got["q"].as_str().unwrap(), uncsv(got["r"].as_str().unwrap())), ("", b.clone()));
    }
    // the ops built their own tables: the shared cache was not used
    assert_eq!(stats().0, before.0);
}

#[test]
fn caps_and_refusals() {
    // dimensions: cap - 1, cap, cap + 1 (no work: zero matrices)
    let zeros = |r: usize, c: usize| vec![vec!["0"; c].join(","); r].join(";");
    let ech = |r: usize, c: usize| format!(r#"{{"fn":"nmod_echelon","p":"7","rows":{},"cols":{},"m":"{}"}}"#, r, c, zeros(r, c));
    assert_eq!(ok(&ech(1, 1023))["pivots"], "");
    assert_eq!(ok(&ech(1, ECH_MAX_DIM))["pivots"], "");
    assert!(err(&ech(1, ECH_MAX_DIM + 1)).contains("rows and cols"));
    assert!(err(&ech(ECH_MAX_DIM + 1, 1)).contains("rows and cols"));
    assert_eq!(ok(&ech(400, 401))["det"], "1");
    assert!(err(&ech(401, 401)).contains("entries, more than"));
    assert!(err(&format!(r#"{{"fn":"nmod_echelon","p":"7","rows":0,"cols":1,"m":""}}"#)).contains("rows and cols"));
    // declared shape and text disagree; entries out of range
    for bad in [
        r#"{"fn":"nmod_echelon","p":"7","rows":2,"cols":2,"m":"1,2"}"#,
        r#"{"fn":"nmod_echelon","p":"7","rows":1,"cols":2,"m":"1,2,3"}"#,
        r#"{"fn":"nmod_echelon","p":"7","rows":1,"cols":2,"m":"1"}"#,
        r#"{"fn":"nmod_echelon","p":"7","rows":1,"cols":2,"m":"1,7"}"#,
        r#"{"fn":"nmod_echelon","p":"7","rows":1,"cols":2,"m":"1,+2"}"#,
        r#"{"fn":"nmod_echelon","p":"8","rows":1,"cols":2,"m":"1,2"}"#,
        r#"{"fn":"nmod_echelon","p":"9223372036854775837","rows":1,"cols":1,"m":"1"}"#,
        r#"{"fn":"nmod_echelon","p":"7","rows":1,"cols":1}"#,
    ] {
        assert!(err(bad).starts_with("nmod_echelon"), "{}", bad);
    }
    // coefficient counts: cap and cap + 1; a zero polynomial is the caller's
    let ones = |n: usize| vec!["1"; n].join(",");
    let req = |f: &str, la: usize, lb: usize| format!(r#"{{"fn":"{}","p":"7","a":"{}","b":"{}"}}"#, f, ones(la), ones(lb));
    for (f, cap) in [("nmod_poly_mul", MUL_MAX_LEN), ("nmod_poly_divrem", DIV_MAX_LEN), ("nmod_poly_gcd", GCD_MAX_LEN)] {
        assert!(err(&req(f, cap + 1, 1)).contains("coefficients, more than"), "{f}");
        assert!(err(&req(f, 1, cap + 1)).contains("coefficients, more than"), "{f}");
        assert!(err(&format!(r#"{{"fn":"{}","p":"7","a":"","b":"1"}}"#, f)).contains("zero polynomial"), "{f}");
        let _ = ok(&req(f, cap, 2));
        let _ = ok(&req(f, cap - 1, 1));
    }
    assert!(err(r#"{"fn":"nmod_poly_divrem","p":"7","a":"1,2","b":"0,0"}"#).contains("division by zero"));
    // the whole request: at the cap admitted, one byte more refused before
    // serde (padding inside the object is whitespace)
    for op in OPS.iter().skip(1) {
        let base = format!(r#"{{"fn":"{}","p":"7","a":"1","b":"1","rows":1,"cols":1,"m":"1""#, op.name);
        let at = format!("{}{}}}", base, " ".repeat(op.max_request - base.len() - 1));
        assert_eq!(at.len(), op.max_request);
        let r: Value = serde_json::from_str(&call(&at)).unwrap();
        assert!(r.get("ok").is_some(), "{}: {}", op.name, r);
        let over = format!("{} }}", &at[..at.len() - 1]);
        assert!(err(&over).contains("the request has"), "{}", op.name);
    }
}

#[test]
fn last_fn_decides() {
    let big = |name: &str, extra: &str| format!(r#"{{"fn":"{}","x":"{}"{}}}"#, name, "0".repeat(ECH_MAX_REQUEST), extra);
    // an oversized request whose last fn is capped is refused, whichever
    // fn came first
    assert!(err(&big("mat_det", r#","fn":"nmod_echelon""#)).contains("nmod_echelon: the request has"));
    assert!(err(&big("nmod_charpoly", r#","fn":"nmod_poly_gcd""#)).contains("nmod_poly_gcd: the request has"));
    assert!(err(&big("nmod_echelon", r#","fn":"nmod_poly_mul""#)).contains("nmod_poly_mul: the request has"));
    // last fn uncapped or unknown: as before (serde's and dispatch's own
    // errors), never a capped op's path
    assert!(!err(&big("nmod_echelon", r#","fn":"mat_det""#)).contains("the request has"));
    assert!(err(&big("nmod_echelon", r#","fn":"nmod_poly""#)).contains("unknown fn"));
    assert!(err(&big("nmod_echelon", r#","fn":"nmod_poly_mulx""#)).contains("unknown fn"));
    // escapes decoded
    assert!(err(&big("x", r#","fn":"nmod_poly_gcd""#)).contains("nmod_poly_gcd: the request has"));
    // malformed: serde's error
    let e = err(&format!(r#"{{"fn":"nmod_echelon","x":"{}""#, "0".repeat(ECH_MAX_REQUEST)));
    assert!(!e.contains("the request has"), "{}", e);
}
