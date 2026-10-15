//! cargo run --release -p sagebrush-modsym --example ecmap -- N a1,a2,a3,a4,a6 a/b ...
//! The exact modular symbol map (ec_map.rs) of the curve of conductor N:
//! X(0:1), then {0, a/b} in X's units for each cusp, and the time.
fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let n: u64 = args[0].parse().unwrap();
    let a: Vec<i64> = args[1].split(',').map(|c| c.parse().unwrap()).collect();
    let e = sagebrush_ap::EllipticCurve::new([a[0], a[1], a[2], a[3], a[4]]).unwrap();
    let aps: Vec<(u64, i64)> = sagebrush_ap::primes_up_to(400).into_iter().filter(|q| n % q != 0).map(|q| (q, e.ap(q).unwrap())).collect();
    let t = std::time::Instant::now();
    let m = sagebrush_modsym::ec_map::ec_map(n, &aps).unwrap();
    eprintln!("N {} map in {:.1} ms, {} symbols, q used {:?}", n, t.elapsed().as_secs_f64() * 1e3, m.x.len(), m.hecke_primes);
    println!("zero {}", m.at_zero_symbol());
    for r in &args[2..] {
        let (p, q) = r.split_once('/').unwrap();
        println!("{} {}", r, m.eval(p.parse().unwrap(), q.parse().unwrap()));
    }
}
