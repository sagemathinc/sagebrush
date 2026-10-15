//! Dimensions of S_k(N) for a few levels: weight_dimprobe k1,k2 a,b ... (level a + b w)
use sagebrush_hmf::field::{Elt, Ideal};
use sagebrush_hmf::weight::{Weight, WeightSpace};

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let k: Vec<u32> = args[0].split(',').map(|x| x.parse().unwrap()).collect();
    for n in &args[1..] {
        let v: Vec<i64> = n.split(',').map(|x| x.parse().unwrap()).collect();
        let s = WeightSpace::new(Ideal::principal(Elt::new(v[0], *v.get(1).unwrap_or(&0))).unwrap(), Weight::new(k[0], k[1]).unwrap()).unwrap();
        println!("({}) weight {:?}: dim {}", n, k, s.dimension());
    }
}
