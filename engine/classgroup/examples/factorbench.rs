//! factor_integer timing (native or wasm32-wasip1): cargo run --release --example factorbench
use sagebrush_bigint::BigInt;
use std::time::Instant;
fn main() {
    for s in ["340282366920938463463374607431768211457", "10000000000000000000000000000000000002379"] {
        let n: BigInt = s.parse().unwrap();
        let t = Instant::now();
        let f = sagebrush_classgroup::api::factor_integer(&n).unwrap();
        println!("{:.3} s {:?}", t.elapsed().as_secs_f64(), f.iter().map(|(p, e)| (p.to_string(), *e)).collect::<Vec<_>>());
    }
}
