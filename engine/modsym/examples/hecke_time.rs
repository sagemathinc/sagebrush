//! Times cusp_hecke_matrix (SAGEBRUSH_TIMING=1 adds the phases).
//!
//!     cargo run --release --example hecke_time N k p [N k p ...]

use sagebrush_bigint::BigInt;
use sagebrush_modsym::hecke_q::{cusp_hecke_matrix, sturm_bound, Admit};

struct Free;
impl Admit for Free {
    fn admit(&mut self, _work: u64, _bytes: u64) -> Result<(), String> {
        Ok(())
    }
}

fn main() {
    let factor = |f: &[BigInt]| sagebrush_poly::factor(f).1;
    let a: Vec<u64> = std::env::args().skip(1).map(|s| s.parse().unwrap()).collect();
    for c in a.chunks(3) {
        let (n, k, p) = (c[0], c[1] as usize, c[2]);
        let prec = sturm_bound(n, k).unwrap() as usize + 2;
        let t = std::time::Instant::now();
        let h = cusp_hecke_matrix(n, k, p, prec, false, &factor, &mut Free).unwrap();
        println!("{}.{} p={}: dim {} in {:.3} s ({} primes, set aside {})", n, k, p, h.dim, t.elapsed().as_secs_f64(), h.stats.primes, h.stats.rejected_total());
    }
}
