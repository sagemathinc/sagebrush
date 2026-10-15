//! Hilbert cusp forms of weight (k1, k2) != (2, 2) and level N over a real
//! quadratic field Q(sqrt d) (defweight.rs, defweightnew.rs): dim S_k(N),
//! the characteristic polynomial of T_P at the primes of norm <= 7, the
//! newform orbits, and the characteristic polynomial over F of a_P on each
//! orbit at the first prime. N is given by generators "a,b" (a + b w); k1
//! sits at sqrt d -> -sqrt d.
//!
//! cargo run -p sagebrush-hmf --release --no-default-features --example general_weight -- 10 4 4 1,0
//! cargo run -p sagebrush-hmf --release --no-default-features --example general_weight -- 3 3 5 11,0 5,1
use sagebrush_hmf::defweightnew::WeightNewspaces;
use sagebrush_hmf::quatalg::{MaximalOrder, QuatAlg};
use sagebrush_hmf::rqf::{QElt, QuadField};
use sagebrush_hmf::weight::Weight;
use std::time::Instant;

fn show(c: &[QElt]) -> String {
    c.iter().map(|x| x.to_string()).collect::<Vec<_>>().join("; ")
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let d: i64 = args[0].parse().unwrap();
    let k = Weight::new(args[1].parse().unwrap(), args[2].parse().unwrap()).unwrap();
    let gens: Vec<QElt> = args[3..]
        .iter()
        .map(|a| {
            let v: Vec<i64> = a.split(',').map(|x| x.trim().parse().unwrap()).collect();
            QElt::new(v[0], v[1])
        })
        .collect();
    let t = Instant::now();
    let f = QuadField::new(d).unwrap();
    let n = f.ideal(&gens).unwrap();
    let o = MaximalOrder::new(&QuatAlg::unramified(f).unwrap()).unwrap();
    let ns = WeightNewspaces::new(&o, &n, k).unwrap();
    println!("F = Q(sqrt {}), weight {:?}, level {:?} of norm {}", d, k.k, n.hnf(), n.norm());
    println!("dim S_k(N) = {}, dim S_k(N)^new = {}", ns.top().dimension(), ns.new_dimension().unwrap());
    let primes = f.primes_of_bounded_norm(7).unwrap();
    for p in &primes {
        println!("  T_P at {:?}: {}", p.ideal().hnf(), show(&ns.hecke_charpoly(p).unwrap()));
    }
    let t1 = t.elapsed().as_secs_f64();
    let orbits = ns.newform_orbits().unwrap();
    let (cps, _) = ns.orbit_data(&orbits, &primes[..1]).unwrap();
    for (g, cp) in orbits.orbits.iter().zip(&cps) {
        println!("  orbit of dimension {}: a_P at {:?}: {}", g.len() - 1, primes[0].ideal().hnf(), show(&cp[0]));
    }
    println!("{:.2} s (spaces and T_P: {:.2} s)", t.elapsed().as_secs_f64(), t1);
}
