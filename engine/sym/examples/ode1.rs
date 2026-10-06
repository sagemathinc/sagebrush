//! Solve ODEs in y(x): cargo run --example ode1 -- 'diff(y(x), x) + y(x) == x' ...
use sagebrush_sym::{ode::desolve, parse::parse, to_string};

fn main() {
    sagebrush_sym::err::install_quiet_hook();
    for a in std::env::args().skip(1) {
        let (de, ics) = match a.split_once(';') {
            Some((d, i)) => (d.to_string(), i.split(',').map(|s| parse(s.trim())).collect::<Vec<_>>()),
            None => (a.clone(), vec![]),
        };
        match sagebrush_sym::err::catch(|| desolve(&parse(&de), "y", "x", &ics)) {
            Ok(r) => println!("{}  ->  {}", a, to_string(&r)),
            Err(e) => println!("{}  ->  error: {}", a, e),
        }
    }
}
