//! orbits N [BOUND]: the Galois orbits of newforms at prime level N (FLINT
//! for factoring), with dimensions and the first traces tr(T_p | A).
fn main() {
    let a: Vec<u64> = std::env::args().skip(1).map(|s| s.parse().unwrap()).collect();
    let factor = |f: &[sagebrush_bigint::BigInt]| sagebrush_flint::factor(f).1;
    let t = std::time::Instant::now();
    let orbits = sagebrush_modsym::orbits::newform_orbits(a[0], *a.get(1).unwrap_or(&100), &factor).unwrap();
    for o in &orbits {
        println!("dim {:>3}  T={:?}  traces {:?}", o.dim, o.ops, &o.traces[..o.traces.len().min(8)]);
    }
    println!("N={}: {} orbits, total dim {}, {:.3} s", a[0], orbits.len(), orbits.iter().map(|o| o.dim).sum::<usize>(), t.elapsed().as_secs_f64());
}
