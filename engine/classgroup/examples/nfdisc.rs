//! cargo run --release -p sagebrush-classgroup --example nfdisc -- c0,c1,...,1 ...
//! The field discriminant of Q[x]/(f) for monic f (coefficients from the
//! constant term), by Round 2, with the time.
use sagebrush_bigint::BigInt;
fn main() {
    for a in std::env::args().skip(1) {
        let f: Vec<BigInt> = a.split(',').map(|c| c.trim().parse().unwrap()).collect();
        let t = std::time::Instant::now();
        let (o, _) = sagebrush_classgroup::nf::order::maximal_order(&f);
        println!("{} {} {:.2} ms", a, o.disc(), t.elapsed().as_secs_f64() * 1e3);
    }
}
