//! Check the "D" lines of a (partial) magma-weight.txt: weight_dims FILE
use sagebrush_hmf::field::{Elt, Ideal};
use sagebrush_hmf::weight::{Weight, WeightSpace};

fn main() {
    let path = std::env::args().nth(1).unwrap();
    let text = std::fs::read_to_string(path).unwrap();
    let (mut ok, mut bad) = (0, 0);
    for l in text.lines().filter(|l| l.starts_with("D ")) {
        let p: Vec<Vec<i64>> = l[2..].split('|').map(|s| s.split_whitespace().map(|x| x.parse().unwrap()).collect()).collect();
        let n = Ideal::principal(Elt::new(p[0][0], p[0][1])).unwrap();
        let s = WeightSpace::new(n, Weight::new(p[1][0] as u32, p[1][1] as u32).unwrap()).unwrap();
        if s.dimension() as i64 == p[2][0] {
            ok += 1;
        } else {
            bad += 1;
            println!("MISMATCH {}: ours {}", l, s.dimension());
        }
    }
    println!("{} agree, {} differ", ok, bad);
}
