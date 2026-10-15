//! Time the space of orbits (dim M_2(N)) for levels given as "a,b" (a + b w).
//! cargo run -p sagebrush-hmf --release --example dims_time -- 1000,0 -3,2000
use sagebrush_hmf::field::Elt;
use sagebrush_hmf::Space;
use std::time::Instant;

fn main() {
    for arg in std::env::args().skip(1) {
        let v: Vec<i64> = arg.split(',').map(|x| x.trim().parse().unwrap()).collect();
        let t = Instant::now();
        let s = Space::new(Elt::new(v[0], v[1])).unwrap();
        println!("level {} norm {} #P1 {} dim S_2 {} : {:.3} s", s.level.gen, s.level.norm(), s.p1.size, s.cusp_dimension(), t.elapsed().as_secs_f64());
    }
}
