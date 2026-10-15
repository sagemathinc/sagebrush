//! Write the characteristic polynomial over O_F of T_P on S_k(N) to a file:
//! weight_dump a,b k1,k2 c,d FILE (level a + b w, prime c + d w)
use sagebrush_hmf::field::{Elt, Ideal};
use sagebrush_hmf::weight::Weight;
use sagebrush_hmf::weightnew::WeightNewspaces;
use std::io::Write;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let pair = |s: &str| -> Vec<i64> { s.split(',').map(|x| x.trim().parse().unwrap()).collect() };
    let (v, k, q) = (pair(&args[0]), pair(&args[1]), pair(&args[2]));
    let level = Ideal::principal(Elt::new(v[0], v[1])).unwrap();
    let p = Ideal::principal(Elt::new(q[0], q[1])).unwrap().factors[0].0;
    let ns = WeightNewspaces::new(level.clone(), Weight::new(k[0] as u32, k[1] as u32).unwrap()).unwrap();
    let f = ns.hecke_charpoly(&p).unwrap();
    let mut out = std::fs::File::create(&args[3]).unwrap();
    writeln!(out, "# charpoly of T_P on S_k(N) over F = Q(w), w = (1 + sqrt 5)/2, w^2 = w + 1").unwrap();
    writeln!(out, "# N = ({}), N(N) = {}; k = ({}, {}); P = ({}), N(P) = {}; degree {}", level.gen, level.norm(), k[0], k[1], p.gen, p.norm, f.len() - 1).unwrap();
    writeln!(out, "# one coefficient per line, constant term first: a b meaning a + b w").unwrap();
    for c in &f {
        writeln!(out, "{} {}", c.a, c.b).unwrap();
    }
    let bits = f.iter().map(|c| c.a.bits().max(c.b.bits())).max().unwrap_or(0);
    println!("{}: degree {}, max coefficient {} bits", args[3], f.len() - 1, bits);
}
