//! Time the eigenvalues of all newform orbits at a level: eigen_time a,b [bound]
use sagebrush_hmf::field::{primes_of_bounded_norm, Elt, Ideal};
use sagebrush_hmf::newspace::Newspaces;
use std::time::Instant;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let v: Vec<i64> = args[0].split(',').map(|x| x.trim().parse().unwrap()).collect();
    let bound: u64 = args.get(1).map_or(30, |b| b.parse().unwrap());
    let t = Instant::now();
    let ns = Newspaces::new(Ideal::principal(Elt::new(v[0], v[1])).unwrap()).unwrap();
    let o = ns.newform_orbits().unwrap();
    println!("level {} dim {}: orbits {:?} in {:.3} s", ns.level.gen, ns.top().dimension(), o.dimensions(), t.elapsed().as_secs_f64());
    let primes = primes_of_bounded_norm(bound);
    let t_all = Instant::now();
    for k in 0..o.orbits.len() {
        let t = Instant::now();
        let e = ns.orbit_eigenspace(&o, k).unwrap();
        let t1 = t.elapsed().as_secs_f64();
        for p in &primes {
            let a = e.eigenvalue(&ns, p).unwrap();
            if std::env::var("NO_CHARPOLY").is_err() {
                let _ = e.charpoly_of(&a).unwrap();
            }
        }
        if std::env::var("QUIET").is_ok() { continue; }
        println!("  orbit {} (degree {}): eigenspace {:.3} s, {} eigenvalues + charpolys {:.3} s", k, e.degree(), t1, primes.len(), t.elapsed().as_secs_f64() - t1);
    }
    println!("  all orbits, {} primes: {:.3} s", primes.len(), t_all.elapsed().as_secs_f64());
}
