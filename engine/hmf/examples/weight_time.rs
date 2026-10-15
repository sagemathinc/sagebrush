//! Timings in weight k: weight_time a,b k1,k2 [bound]
//! The space, the newform orbits (separating operator and factorization over
//! F), the exact eigenvalues of every orbit at the primes of norm <= bound,
//! and the characteristic polynomials of T_P on the full space for the
//! primes of norm <= 11.
use sagebrush_hmf::field::{primes_of_bounded_norm, Elt, Ideal};
use sagebrush_hmf::weight::Weight;
use sagebrush_hmf::weightnew::WeightNewspaces;
use std::time::Instant;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let v: Vec<i64> = args[0].split(',').map(|x| x.trim().parse().unwrap()).collect();
    let k: Vec<u32> = args[1].split(',').map(|x| x.trim().parse().unwrap()).collect();
    let bound: u64 = args.get(2).map_or(100, |b| b.parse().unwrap());
    let level = Ideal::principal(Elt::new(v[0], v[1])).unwrap();
    let t = Instant::now();
    let ns = WeightNewspaces::new(level, Weight::new(k[0], k[1]).unwrap()).unwrap();
    let (dim, new) = (ns.top().dimension(), ns.new_dimension().unwrap());
    let t_space = t.elapsed().as_secs_f64();
    let t = Instant::now();
    for p in primes_of_bounded_norm(11) {
        ns.hecke_charpoly(&p).unwrap();
    }
    let t_cp = t.elapsed().as_secs_f64();
    let t = Instant::now();
    let o = ns.newform_orbits().unwrap();
    let t_orbits = t.elapsed().as_secs_f64();
    let t = Instant::now();
    let primes = primes_of_bounded_norm(bound);
    ns.orbit_eigenvalues(&o, &primes).unwrap();
    let t_eig = t.elapsed().as_secs_f64();
    println!(
        "level {} weight {:?}: dim {} new {} orbits {:?}; space {:.3} s, T_P charpolys (N(P) <= 11) {:.3} s, orbits {:.3} s, eigenvalues at {} primes {:.3} s",
        ns.level.gen, k, dim, new, o.orbits.iter().map(|g| g.len() - 1).collect::<Vec<_>>(), t_space, t_cp, t_orbits, primes.len(), t_eig
    );
}
