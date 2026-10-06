//! One limit with its time: lim1 'f' 'a' [plus|minus]
use sagebrush_sym::{expr::*, limit::{limit, Dir}, parse::parse, to_string};
fn main() {
    sagebrush_sym::err::install_quiet_hook();
    let a: Vec<String> = std::env::args().collect();
    let at = match a[2].as_str() { "oo" => infinity(), "-oo" => constant(Const::MinusInfinity), s => parse(s) };
    let dir = match a.get(3).map(|s| s.as_str()) { Some("plus") => Dir::Plus, Some("minus") => Dir::Minus, _ => Dir::Both };
    let t = std::time::Instant::now();
    let r = sagebrush_sym::err::catch(|| to_string(&limit(&parse(&a[1]), "x", &at, dir)));
    println!("{} -> {:?}  ({:.3} s)", a[1], r.map_err(|e| e.to_string()), t.elapsed().as_secs_f64());
}
