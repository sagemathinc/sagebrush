//! Time T_p at a level: hecke_time a,b q1 q2 ... (level a + b w; the
//! primes of norms q1, q2, ...; the first prime of each norm).
use sagebrush_hmf::field::{primes_of_bounded_norm, Elt};
use sagebrush_hmf::{theta, Space};
use std::time::Instant;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let v: Vec<i64> = args[0].split(',').map(|x| x.trim().parse().unwrap()).collect();
    let t = Instant::now();
    let s = Space::new(Elt::new(v[0], v[1])).unwrap();
    println!("level {} norm {} dim M_2 {}: space {:.3} s", s.level.gen, s.level.norm(), s.dimension(), t.elapsed().as_secs_f64());
    for q in &args[1..] {
        let q: u64 = q.parse().unwrap();
        let p = primes_of_bounded_norm(q).into_iter().find(|p| p.norm == q).expect("no prime of that norm");
        let t = Instant::now();
        theta::theta(&p).unwrap();
        let t1 = t.elapsed().as_secs_f64();
        let m = s.hecke_matrix(&p).unwrap();
        let tr = m.trace();
        println!("  T at {} (norm {}): theta {:.3} s, matrix {:.3} s, trace {}", p.gen, q, t1, t.elapsed().as_secs_f64() - t1, tr);
    }
}
