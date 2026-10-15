//! Time newform orbits and rational newforms: newforms_time a,b [aplist bound]
use sagebrush_hmf::field::{Elt, Ideal};
use sagebrush_hmf::newspace::Newspaces;
use std::time::Instant;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let bound: u64 = args.get(1).map_or(0, |b| b.parse().unwrap());
    let v: Vec<i64> = args[0].split(',').map(|x| x.trim().parse().unwrap()).collect();
    let t = Instant::now();
    let ns = Newspaces::new(Ideal::principal(Elt::new(v[0], v[1])).unwrap()).unwrap();
    let t0 = t.elapsed().as_secs_f64();
    let o = ns.newform_orbits().unwrap();
    let t1 = t.elapsed().as_secs_f64();
    let r = ns.rational_newforms_of(&o).unwrap();
    let t2 = t.elapsed().as_secs_f64();
    let nap: usize = sagebrush_hmf::newspace::aplists(ns.top(), &r, bound).unwrap().iter().map(|v| v.len()).sum();
    let t3 = t.elapsed().as_secs_f64();
    println!(
        "level {} norm {} dim S_2 {} new {}: orbits {:?} (op {} primes) | spaces {:.3} s, orbits {:.3} s, rational newforms ({}) {:.3} s, {} a_p up to {}: {:.3} s",
        ns.level.gen, ns.level.norm(), ns.top().cusp_dimension(), ns.new_dimension(), o.dimensions(), o.op.len(), t0, t1 - t0, r.len(), t2 - t1, nap, bound, t3 - t2
    );
}
