//! Montgomery multiplication speed, native or wasm32-wasip1 (ECM's inner loop):
//!   cargo run --release --example montbench
use sagebrush_bigint::BigUint;
use sagebrush_classgroup::nf::ecm::Mont;
use std::time::Instant;

fn main() {
    for bits in [128u32, 256, 512, 960] {
        let n: BigUint = (BigUint::from(1u32) << bits as usize) + 1u32 + (BigUint::from(1u32) << (bits / 3) as usize) * 2u32;
        let m = Mont::new(&n).unwrap();
        let mut x = m.to_mont(&BigUint::from(123456789u64));
        let y = m.to_mont(&BigUint::from(987654321u64));
        let reps = 2_000_000u32;
        let t = Instant::now();
        for _ in 0..reps {
            x = m.mul(&x, &y);
        }
        let ns = t.elapsed().as_secs_f64() * 1e9 / reps as f64;
        println!("{} bits: {:.1} ns per Montgomery multiplication (check {})", bits, ns, m.from_mont(&x).bits());
    }
}
