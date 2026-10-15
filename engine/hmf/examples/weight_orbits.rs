//! Newform orbits in weight k: weight_orbits a,b k1,k2 [bound]
use sagebrush_hmf::field::{primes_of_bounded_norm, Elt, Ideal};
use sagebrush_hmf::fpoly::FPoly;
use sagebrush_hmf::weight::Weight;
use sagebrush_hmf::weightnew::WeightNewspaces;
use std::time::Instant;

fn show(f: &FPoly) -> String {
    f.iter().map(|c| format!("[{}]", c)).collect::<Vec<_>>().join(" ")
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let v: Vec<i64> = args[0].split(',').map(|x| x.trim().parse().unwrap()).collect();
    let k: Vec<u32> = args[1].split(',').map(|x| x.trim().parse().unwrap()).collect();
    let bound: u64 = args.get(2).map_or(30, |b| b.parse().unwrap());
    let t = Instant::now();
    let level = Ideal::principal(Elt::new(v[0], v[1])).unwrap();
    let ns = WeightNewspaces::new(level, Weight::new(k[0], k[1]).unwrap()).unwrap();
    println!("dim {} new {} ({:.3} s)", ns.top().dimension(), ns.new_dimension().unwrap(), t.elapsed().as_secs_f64());
    let o = ns.newform_orbits().unwrap();
    println!("op {:?}", o.op.iter().map(|(p, c)| (p.gen, *c)).collect::<Vec<_>>());
    println!("orbit degrees {:?} ({:.3} s)", o.orbits.iter().map(|g| g.len() - 1).collect::<Vec<_>>(), t.elapsed().as_secs_f64());
    let primes = primes_of_bounded_norm(bound);
    let cps = ns.orbit_charpolys(&o, &primes).unwrap();
    for (g, row) in o.orbits.iter().zip(&cps) {
        println!("orbit {}", show(g));
        for (p, f) in primes.iter().zip(row) {
            println!("  {:?} (norm {}): {}", p.gen, p.norm, show(f));
        }
    }
    println!("total {:.3} s", t.elapsed().as_secs_f64());
}
