// Time the quartic search over lines "label I J" on stdin.
use std::io::BufRead;
fn main() {
    for line in std::io::stdin().lock().lines() {
        let line = line.unwrap();
        let w: Vec<&str> = line.split_whitespace().collect();
        let (i, j): (i128, i128) = (w[1].parse().unwrap(), w[2].parse().unwrap());
        let t = std::time::Instant::now();
        match sagebrush_ap::quartic::search(i, j, u64::MAX) {
            Ok(s) => println!("{} I={} work {} cost {} amax {} {:.3}s", w[0], i, s.work, s.cost, s.amax, t.elapsed().as_secs_f64()),
            Err(e) => println!("{} I={} ERROR {}", w[0], i, e),
        }
    }
}
