//! Stop inside each phase of the nmod ops (the interrupt crate's test
//! hooks: every check counted per phase, Stop requested at a chosen one),
//! the checks' density, and the shared transform cache left alone after
//! other ops filled it.  One test: the hooks and the flag are global.

use sagebrush_interrupt::hooks;
use sagebrush_web::call;

fn rng(s: &mut u64) -> u64 {
    *s ^= *s << 13;
    *s ^= *s >> 7;
    *s ^= *s << 17;
    *s
}

fn csv(v: &[u64]) -> String {
    v.iter().map(|x| x.to_string()).collect::<Vec<_>>().join(",")
}

fn rand_poly(s: &mut u64, n: usize, p: u64) -> Vec<u64> {
    let mut v: Vec<u64> = (0..n).map(|_| rng(s) % p).collect();
    v[n - 1] = v[n - 1].max(1);
    v
}

fn stats() -> (u64, u64, u64) {
    let v: serde_json::Value = serde_json::from_str(&call(r#"{"fn":"ntt_cache_stats"}"#)).unwrap();
    let v = &v["ok"];
    (v[0].as_u64().unwrap(), v[1].as_u64().unwrap(), v[2].as_u64().unwrap())
}

const P: u64 = 9223372036854775783;
const NTT_P: u64 = 4601552919265804289;

/// Run req traced; then, for each phase, Stop at its median check: the
/// call must stop in that phase, and the next call must work.  `min` is
/// the fewest checks each phase must have made (work / 2^16, rounded down
/// conservatively).
fn phases(label: &str, req: &str, want: &[(&str, usize)]) {
    let cache = stats();
    hooks::reset();
    hooks::trace();
    let full = call(req);
    assert!(full.starts_with("{\"ok\":"), "{}: {}", label, &full[..full.len().min(200)]);
    let gap = hooks::max_gap_ns();
    let counts: Vec<(&str, Vec<u64>)> = want.iter().map(|&(ph, _)| (ph, hooks::traced(ph))).collect();
    let total = hooks::total();
    hooks::reset();
    eprintln!("{}: {} checks; longest gap {:.2} ms; {:?}", label, total, gap as f64 / 1e6, counts.iter().map(|(p, v)| (*p, v.len())).collect::<Vec<_>>());
    // (wall time: generous, a loop without checks at these sizes takes
    // far longer)
    assert!(gap < 250_000_000, "{}: {} ns between two checks", label, gap);
    assert_eq!(stats().0, cache.0, "{}: the shared transform cache was used", label);
    for (&(ph, min), (_, idx)) in want.iter().zip(&counts) {
        assert!(idx.len() >= min.max(1), "{}: {} checks in {}, want at least {}", label, idx.len(), ph, min);
        hooks::reset();
        hooks::arm_at(idx[idx.len() / 2]);
        let r = sagebrush_interrupt::catch(|| call(req));
        let at = hooks::stopped_in();
        hooks::reset();
        sagebrush_interrupt::clear();
        assert!(r.is_err(), "{}: no Stop in {}", label, ph);
        assert_eq!(at, ph, "{}: stopped in {} instead of {}", label, at, ph);
    }
    assert_eq!(call(req), full, "{}: the next call", label);
}

#[test]
fn stop_in_every_phase() {
    // fill the shared cache with other ops' tables first (integer
    // polynomial products: many primes, several lengths)
    let mut s = 99u64;
    for len in [100usize, 1000, 5000, 20000] {
        let a: Vec<String> = (0..len).map(|_| format!("{}{}", rng(&mut s), rng(&mut s))).collect();
        let r = call(&format!(r#"{{"fn":"poly_mul","a":{:?},"b":{:?}}}"#, a, a));
        assert!(r.starts_with("{\"ok\""), "{}", &r[..r.len().min(200)]);
    }
    let filled = stats();
    eprintln!("shared cache: {:?}", filled);
    assert!(filled.1 >= 3);

    // nmod_echelon, 400 x 401, reduced: n^3 / 3 multiply-adds in each of
    // elimination and back substitution
    let m: Vec<Vec<u64>> = (0..400).map(|_| (0..401).map(|_| rng(&mut s) % P).collect()).collect();
    let text = m.iter().map(|r| csv(r)).collect::<Vec<_>>().join(";");
    let req = format!(r#"{{"fn":"nmod_echelon","p":"{}","rows":400,"cols":401,"m":"{}","reduced":true,"want_rows":true}}"#, P, text);
    phases("echelon", &req, &[("parse", 400), ("eliminate", 150), ("back-substitute", 150), ("reply", 400)]);

    // nmod_poly_mul at the cap: 9 (N / 2) log N butterflies
    let (a, b) = (rand_poly(&mut s, 1 << 15, P), rand_poly(&mut s, 1 << 15, P));
    let req = format!(r#"{{"fn":"nmod_poly_mul","p":"{}","a":"{}","b":"{}"}}"#, P, csv(&a), csv(&b));
    phases("mul", &req, &[("parse", 8), ("ntt", 50), ("reply", 1)]);

    // nmod_poly_divrem: Newton, and the classical path
    let (a, b) = (rand_poly(&mut s, 1 << 15, NTT_P), rand_poly(&mut s, (1 << 14) + 1, NTT_P));
    let req = format!(r#"{{"fn":"nmod_poly_divrem","p":"{}","a":"{}","b":"{}"}}"#, NTT_P, csv(&a), csv(&b));
    phases("divrem newton", &req, &[("parse", 4), ("newton-inverse", 10), ("ntt", 20), ("newton-divide", 2), ("reply", 1)]);
    let (a, b) = (rand_poly(&mut s, 1 << 15, P), rand_poly(&mut s, 59, P));
    let req = format!(r#"{{"fn":"nmod_poly_divrem","p":"{}","a":"{}","b":"{}"}}"#, P, csv(&a), csv(&b));
    phases("divrem classical", &req, &[("classical-divide", 25)]);

    // nmod_poly_gcd at the cap: about 2^28 multiply-adds
    let (a, b) = (rand_poly(&mut s, 1 << 14, P), rand_poly(&mut s, 1 << 14, P));
    let req = format!(r#"{{"fn":"nmod_poly_gcd","p":"{}","a":"{}","b":"{}"}}"#, P, csv(&a), csv(&b));
    phases("gcd", &req, &[("parse", 2), ("euclid", 3000)]);

    // churn: products and divisions modulo 100 distinct NTT primes
    // c 2^20 + 1, between three-prime ones: the shared cache unchanged
    let before = stats();
    let mut c = 1u64 << 21;
    let mut n = 0;
    while n < 100 {
        c += 1;
        let p = (c << 20) + 1;
        if !sagebrush_arith::nmod::is_prime(p) {
            continue;
        }
        n += 1;
        let (a, b) = (rand_poly(&mut s, 3000, p), rand_poly(&mut s, 1500, p));
        for f in ["nmod_poly_mul", "nmod_poly_divrem"] {
            let r = call(&format!(r#"{{"fn":"{}","p":"{}","a":"{}","b":"{}"}}"#, f, p, csv(&a), csv(&b)));
            assert!(r.starts_with("{\"ok\""), "{}", r);
        }
        let r = call(&format!(r#"{{"fn":"nmod_poly_mul","p":"{}","a":"{}","b":"{}"}}"#, P, csv(&a), csv(&b)));
        assert!(r.starts_with("{\"ok\""));
    }
    assert_eq!(stats(), before);
}
