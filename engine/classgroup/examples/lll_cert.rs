// Certify LLL outputs (sagebrush_poly::lll_cert, eta 0.51, delta 0.99): not shipped.
//   lll_cert IN OUT       -> "ok SECONDS exact" or "ok SECONDS interval<p>", or the refusal
//   lll_cert IN OUT both  -> the interval oracle's verdict first (flushed, so a timeout of the exact
//                            check keeps it), then the exact check's, and MISMATCH if the oracle proved
//                            what the exact check refuses; the lattice containment is checked as usual
use std::io::Write;
fn read(p: &str) -> Vec<Vec<sagebrush_bigint::BigInt>> {
    let t = std::fs::read_to_string(p).unwrap();
    t.lines().skip(1).filter(|l| !l.trim().is_empty()).map(|l| l.split_whitespace().map(|x| x.parse().unwrap()).collect()).collect()
}
fn main() {
    use sagebrush_poly::lll_cert::{certify_by, integral_combination, reduced, By};
    let a: Vec<String> = std::env::args().collect();
    let (inp, out) = (read(&a[1]), read(&a[2]));
    let (eta, delta) = ((51, 100), (99, 100));
    let t = std::time::Instant::now();
    if a.get(3).map(|s| s.as_str()) == Some("both") {
        let lattice = out.len() == inp.len() && integral_combination(&inp, &out).is_ok() && integral_combination(&out, &inp).is_ok();
        println!("lattice {} {:.3}", if lattice { "ok" } else { "REFUSED" }, t.elapsed().as_secs_f64());
        std::io::stdout().flush().unwrap();
        let t1 = std::time::Instant::now();
        let iv = sagebrush_poly::lll_cert::reduced_interval(&out, eta, delta);
        println!("interval {} {:.3}", iv.map_or("inconclusive".to_string(), |p| format!("ok p{p}")), t1.elapsed().as_secs_f64());
        std::io::stdout().flush().unwrap();
        let t2 = std::time::Instant::now();
        let ex = reduced(&out, eta, delta);
        println!("exact {} {:.3}", if ex.is_ok() { "ok".to_string() } else { format!("REFUSED {:?}", ex.as_ref().err().unwrap()) }, t2.elapsed().as_secs_f64());
        if iv.is_some() && ex.is_err() {
            println!("MISMATCH");
        }
        return;
    }
    match certify_by(&inp, &out, eta, delta) {
        Ok(By::Exact) => println!("ok {:.3} exact", t.elapsed().as_secs_f64()),
        Ok(By::Interval(p)) => println!("ok {:.3} interval{p}", t.elapsed().as_secs_f64()),
        Err(e) => println!("REFUSED {e:?}"),
    }
}
