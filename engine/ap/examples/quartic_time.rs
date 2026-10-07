// Time the 2-descent quartic search: cargo run --release -p sagebrush-ap --example quartic_time -- I J
fn main() {
    let a: Vec<i128> = std::env::args().skip(1).map(|s| s.parse().unwrap()).collect();
    let t = std::time::Instant::now();
    let s = sagebrush_ap::quartic::search(a[0], a[1], u64::MAX).unwrap();
    println!("{} quartics, work {}, amax {}, {:?}", s.quartics.len(), s.work, s.amax, t.elapsed());
}
