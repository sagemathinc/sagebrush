//! Probe: T_2 in weights (2, 4) and (4, 2) at level (3 + w), modulo a place.
use sagebrush_hmf::field::{primes_of_bounded_norm, Elt, Ideal};
use sagebrush_hmf::weight::{place_pairs, Weight, WeightSpace};

fn main() {
    let (pl, _) = place_pairs().next().unwrap();
    let p2 = primes_of_bounded_norm(4)[0];
    for k in [(2, 4), (4, 2), (4, 4), (2, 6)] {
        let s = WeightSpace::new(Ideal::principal(Elt::new(3, 1)).unwrap(), Weight::new(k.0, k.1).unwrap()).unwrap();
        let t = s.hecke_mod(&p2, &pl).unwrap();
        let x = t.get(0, 0);
        let cands = [("4w-12", Elt::new(-12, 4)), ("conj(4w-12)", Elt::new(-12, 4).conj()), ("4", Elt::int(4)), ("8-24w", Elt::new(8, -24))];
        let hit: Vec<&str> = cands.iter().filter(|(_, e)| pl.red(*e) == x).map(|(n, _)| *n).collect();
        println!("k = {:?}: dim {}, T_2 = {} matches {:?}", k, s.dimension(), x, hit);
    }
}
