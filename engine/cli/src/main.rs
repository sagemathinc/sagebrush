//! sagebrush <engine> ...   (engines: modsym, ap)
//!
//! sagebrush modsym N q [p] [--threads T] [--exact] [--commute r] [--level]
//! sagebrush ap "[a1,a2,a3,a4,a6]" N [--threads T]   (a_p for p <= N: count, sum, Sato-Tate moments)
//!
//! Default: characteristic polynomial of T_q mod p (prints a hash).
//! --exact: the characteristic polynomial over Z, with its status.
//! --commute r: check T_q T_r == T_r T_q mod p.
//! --level: genus, cusps and dimension from the formulas only.

fn take_flag(args: &mut Vec<String>, name: &str) -> bool {
    match args.iter().position(|a| a == name) {
        Some(i) => {
            args.remove(i);
            true
        }
        None => false,
    }
}

fn take_value(args: &mut Vec<String>, name: &str) -> Option<String> {
    let i = args.iter().position(|a| a == name)?;
    let v = args[i + 1].clone();
    args.drain(i..i + 2);
    Some(v)
}

fn fail(e: &str) -> ! {
    eprintln!("error: {}", e);
    std::process::exit(2)
}

const USAGE: &str = "usage: sagebrush modsym N q [p] [--threads T] [--exact] [--commute r] [--level]\n       sagebrush ap \"[a1,a2,a3,a4,a6]\" N [--threads T]";

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("modsym") => modsym(args[1..].to_vec()),
        Some("ap") => ap(args[1..].to_vec()),
        _ => fail(USAGE),
    }
}

/// Weight-2 modular symbols for Gamma0(N), sign +1.
fn modsym(mut args: Vec<String>) {
    let threads: usize = take_value(&mut args, "--threads").map_or(0, |s| s.parse().unwrap());
    let commute: Option<u64> = take_value(&mut args, "--commute").map(|s| s.parse().unwrap());
    let exact = take_flag(&mut args, "--exact");
    let level = take_flag(&mut args, "--level");
    let n: u64 = args.first().map_or(389, |s| s.parse().unwrap());
    let q: u64 = args.get(1).map_or(2, |s| s.parse().unwrap());
    let p: u64 = args.get(2).map_or(67108859, |s| s.parse().unwrap());
    let nthreads = sagebrush_par::install(threads, sagebrush_par::current_num_threads);
    let t = std::time::Instant::now();
    if level {
        let (psi, g, c, e, d) = sagebrush_modsym::exact::level_data(n);
        println!("N={} psi={} genus={} cusps={} eisenstein+={} dim={}", n, psi, g, c, e, d);
        return;
    }
    if let Some(r) = commute {
        let ok = sagebrush_par::install(threads, || sagebrush_modsym::hecke_commute(n, q, r, p)).unwrap_or_else(|e| fail(&e));
        println!("N={} T_{} T_{} commute mod {}: {} ({:.0} ms)", n, q, r, p, ok, t.elapsed().as_secs_f64() * 1000.0);
        return;
    }
    if exact {
        match sagebrush_par::install(threads, || sagebrush_modsym::exact::exact_charpoly(n, q)) {
            Err(e) => fail(&e),
            Ok(e) => {
                let shown: Vec<String> = e.coeffs.iter().map(|c| c.to_string()).collect();
                let poly = if shown.len() <= 12 { shown.join(", ") } else { format!("{}, ..., {}", shown[..4].join(", "), shown[shown.len() - 4..].join(", ")) };
                println!("N={} q={} genus={} cusps={} dim={} status={}", e.n, e.q, e.genus, e.cusps, e.dim, e.status);
                println!("charpoly (constant term first): [{}]", poly);
                // FNV-1a of the comma-joined decimal coefficients, to compare runs.
                let h = shown.join(",").bytes().fold(0xcbf29ce484222325u64, |h, b| (h ^ b as u64).wrapping_mul(0x100000001b3));
                println!("coefficients digest {:016x}", h);
                println!("primes used {} (rejected {:?}), bound {:.0} bits; {:.0} ms on {} threads", e.primes_used.len(), e.primes_rejected, e.bound_bits, t.elapsed().as_secs_f64() * 1000.0, nthreads);
                for c in &e.checks {
                    println!("  check: {}", c);
                }
            }
        }
        return;
    }
    let r = sagebrush_par::install(threads, || sagebrush_modsym::hecke_charpoly(n, q, p)).unwrap_or_else(|e| fail(&e));
    println!(
        "N={} q={} p={} symbols={} gens={} dim={} eisenstein_root={} charpoly_hash={}",
        r.n, r.q, r.p, r.symbols, r.gens, r.dim, if r.eisenstein_root() { "True" } else { "False" }, r.hash()
    );
    println!(
        "times: symbols {:.0} ms, T_{} {:.0} ms, charpoly {:.0} ms, total {:.0} ms ({} threads)",
        r.ms[0], q, r.ms[1], r.ms[2], r.ms.iter().sum::<f64>(), nthreads
    );
}

/// Traces of Frobenius of an elliptic curve over Q for all p <= N.
fn ap(mut args: Vec<String>) {
    let threads: usize = take_value(&mut args, "--threads").map_or(0, |s| s.parse().unwrap());
    if args.len() < 2 {
        fail(USAGE);
    }
    let a: Vec<i64> = args[0].trim_matches(|c| c == '[' || c == ']').split(',').map(|s| s.trim().parse().unwrap_or_else(|_| fail(USAGE))).collect();
    let n: u64 = args[1].parse().unwrap_or_else(|_| fail(USAGE));
    let a: [i64; 5] = a.try_into().unwrap_or_else(|_| fail("a curve is [a1,a2,a3,a4,a6]"));
    let e = sagebrush_ap::EllipticCurve::new(a).unwrap_or_else(|e| fail(&e));
    let nthreads = sagebrush_par::install(threads, sagebrush_par::current_num_threads);
    let t = std::time::Instant::now();
    let r = sagebrush_par::install(threads, || sagebrush_ap::aplist(&e, n));
    let secs = t.elapsed().as_secs_f64();
    let good: Vec<(u64, i64)> = r.iter().filter_map(|&(p, a)| a.map(|a| (p, a))).collect();
    let sum: i64 = good.iter().map(|g| g.1).sum();
    let m: Vec<String> = (1..=4).map(|k| format!("{:.3}", good.iter().map(|&(p, a)| ((a * a) as f64 / p as f64).powi(k)).sum::<f64>() / good.len() as f64)).collect();
    println!("{:?} p <= {}: {} good primes, sum of a_p {}, moments of a_p^2/p [{}]", a, n, good.len(), sum, m.join(", "));
    println!("{:.3} s on {} threads", secs, nthreads);
}
