use sagebrush_group::named::*;
use std::time::Instant;
fn main() {
    for n in std::env::args().skip(1).map(|a| a.parse::<usize>().unwrap()) {
        let t = Instant::now(); let g = symmetric(n); let o = g.order(); let e1 = t.elapsed();
        let t = Instant::now(); let s = g.is_solvable(); let p = g.is_primitive(); let e2 = t.elapsed();
        println!("S{}: order has {} digits, chain {:?}; solvable {} primitive {} in {:?}", n, o.to_string().len(), e1, s, p, e2);
    }
    if std::env::args().len() > 2 { return; }
    let t = Instant::now(); let m = mathieu(24).unwrap(); println!("M24 order {} in {:?}; transitivity {} ", m.order(), t.elapsed(), m.transitivity());
    let t = Instant::now(); let a = alternating(47); println!("A47 {} digits in {:?}", a.order().to_string().len(), t.elapsed());
}
