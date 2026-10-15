//! Scan levels up to a norm bound, printing the slow ones (eigenvalues of all orbits).
use sagebrush_hmf::field::{ideals_of_bounded_norm, primes_of_bounded_norm};
use sagebrush_hmf::newspace::Newspaces;
use std::time::Instant;

fn main() {
    let b: u64 = std::env::args().nth(1).unwrap().parse().unwrap();
    let primes = primes_of_bounded_norm(30);
    let t0 = Instant::now();
    for n in ideals_of_bounded_norm(b) {
        if n.is_one() { continue; }
        eprintln!("level {} norm {}", n.gen, n.norm());
        let t = Instant::now();
        let ns = Newspaces::new(n.clone()).unwrap();
        let o = ns.newform_orbits().unwrap();
        let t1 = t.elapsed().as_secs_f64();
        for k in 0..o.orbits.len() {
            let e = ns.orbit_eigenspace(&o, k).unwrap();
            for p in &primes {
                let a = e.eigenvalue(&ns, p).unwrap();
                let _ = e.charpoly_of(&a).unwrap();
            }
        }
        let dt = t.elapsed().as_secs_f64();
        if dt > 0.5 {
            println!("level {} norm {} dim {} orbits {:?}: orbits {:.2} s, total {:.2} s", n.gen, n.norm(), ns.top().dimension(), o.dimensions(), t1, dt);
        }
    }
    println!("total {:.1} s", t0.elapsed().as_secs_f64());
}
