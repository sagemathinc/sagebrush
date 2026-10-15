//! The newforms of weight 2 and level N over a real quadratic field
//! Q(sqrt d) (defnew.rs): the Galois orbits, and a_P for the primes of
//! small norm (rational forms) or the characteristic polynomial of a_P
//! (larger orbits). N is given by generators "a,b" (a + b w).
//!
//! cargo run -p sagebrush-hmf --release --example general_newforms -- 106 1,0
//! cargo run -p sagebrush-hmf --release --example general_newforms -- 3 3,1
use sagebrush_hmf::defnew::Newspaces;
use sagebrush_hmf::quatalg::{MaximalOrder, QuatAlg};
use sagebrush_hmf::rqf::{QElt, QuadField};
use std::time::Instant;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let d: i64 = args[0].parse().unwrap();
    let gens: Vec<QElt> = args[1..]
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
    let ns = Newspaces::new(&o, &n).unwrap();
    let cg = ns.top().classes().class_group();
    println!("F = Q(sqrt {}), h = {}, h+ = {}; level N = {:?} of norm {}", d, cg.h(), cg.narrow_h(), n.hnf(), n.norm());
    println!("dim S_2(N) = {}, dim S_2(N)^new = {}", ns.top().cusp_dimension(), ns.new_dimension().unwrap());
    let orbits = ns.newform_orbits().unwrap();
    println!("newform orbits of dimensions {:?}", orbits.dimensions());
    let primes = f.primes_of_bounded_norm(13).unwrap();
    for (k, g) in orbits.orbits.iter().enumerate() {
        let es = ns.orbit_eigenspace(&orbits, k).unwrap();
        if g.len() == 2 {
            let ap: Vec<String> = primes.iter().map(|p| format!("{}", ns.eigenvalue(&es, p).unwrap().num[0])).collect();
            println!("  orbit {} (rational): a_P = [{}]", k, ap.join(", "));
        } else {
            let p = &primes[0];
            let cp = es.charpoly_of(&ns.eigenvalue(&es, p).unwrap()).unwrap();
            println!("  orbit {} (dimension {}): charpoly of a_P at N(P) = {}: {:?}", k, g.len() - 1, p.norm, cp.iter().map(|c| c.to_string()).collect::<Vec<_>>());
        }
    }
    println!("primes: {:?}", primes.iter().map(|p| (p.norm, p.ideal.hnf())).collect::<Vec<_>>());
    println!("{:.2} s", t.elapsed().as_secs_f64());
}
