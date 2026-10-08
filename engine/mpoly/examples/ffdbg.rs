//! Factors a polynomial over GF(p) given as engine text (debugging).
use sagebrush_mpoly::QPoly;
fn main() {
    let a: Vec<String> = std::env::args().collect();
    let p: u64 = a[1].parse().unwrap();
    let n: usize = a[2].parse().unwrap();
    let text = std::fs::read_to_string(&a[3]).unwrap();
    let f = QPoly::from_text(n, text.trim()).unwrap();
    let t = std::time::Instant::now();
    let r = sagebrush_mpoly::factor_p::factor_p(&f.num, p);
    match r {
        Ok((u, fs)) => println!("unit {} factors {:?} in {:.3}s", u, fs.iter().map(|(h, e)| (h.len(), *e)).collect::<Vec<_>>(), t.elapsed().as_secs_f64()),
        Err(e) => println!("ERR {}", e),
    }
}
