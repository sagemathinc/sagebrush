//! How long a Stop in the browser can go unnoticed during F4 over GF(p):
//! the longest wall time between two polls of the WebAssembly host, as the
//! interrupt crate's test hooks simulate them (every check_coarse, every
//! 1024th check), on cyclic-7 and cyclic-8 mod 32003, on one thread as in
//! WebAssembly.  One test: the hooks are global.

use num_traits::One;
use sagebrush_bigint::BigInt;
use sagebrush_interrupt::hooks;
use sagebrush_mpoly::f4::groebner_p;
use sagebrush_mpoly::order::Order;
use sagebrush_mpoly::QPoly;

/// The cyclic-n system mod p: for k = 1..n-1 the sum over i of
/// x_i x_{i+1} ... x_{i+k-1} (indices mod n), and x_0 x_1 ... x_{n-1} - 1.
fn cyclic(n: usize, p: u64) -> Vec<QPoly> {
    let mut out = vec![];
    for k in 1..n {
        let terms: Vec<String> = (0..n)
            .map(|i| {
                let mut e = vec![0; n];
                for j in 0..k {
                    e[(i + j) % n] = 1;
                }
                format!("{}:1", e.iter().map(|x| x.to_string()).collect::<Vec<_>>().join(","))
            })
            .collect();
        out.push(terms.join(";"));
    }
    out.push(format!("{}:1;{}:-1", vec!["1"; n].join(","), vec!["0"; n].join(",")));
    out.iter()
        .map(|s| {
            let f = QPoly::from_text(n, s).unwrap();
            QPoly { num: f.num.reduce_mod(p), den: BigInt::one(), p }
        })
        .collect()
}

#[test]
fn f4_host_poll_gap() {
    // WebAssembly runs F4 on one thread
    std::env::set_var("SAGEBRUSH_THREADS", "1");
    for n in [7, 8] {
        let fs = cyclic(n, 32003);
        hooks::reset();
        hooks::trace();
        let t = std::time::Instant::now();
        let g = groebner_p(&fs, Order::DegRevLex, 32003).unwrap();
        let secs = t.elapsed().as_secs_f64();
        let poll = hooks::max_poll_gap_ns();
        let gap = hooks::max_gap_ns();
        let total = hooks::total();
        hooks::reset();
        eprintln!("cyclic-{}: {} elements in {:.2} s; {} checks; longest gap between checks {:.2} ms, between host polls {:.2} ms", n, g.len(), secs, total, gap as f64 / 1e6, poll as f64 / 1e6);
        assert!(poll > 0, "cyclic-{}: no host poll traced", n);
        // (generous for slow runners: before the coarse checks in the row
        // loops this was 4.1 s on cyclic-8, and 0.07 s after)
        assert!(poll < 1_000_000_000, "cyclic-{}: {:.2} s between two host polls", n, poll as f64 / 1e9);
    }
}
