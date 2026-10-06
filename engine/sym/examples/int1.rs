//! Integrate one expression and show the steps: cargo run --example int1 -- 'x*log(x)'
use sagebrush_sym::{integrate::{integrate_steps, Step}, parse::parse, to_string};

fn show(s: &Step, d: usize) {
    println!("{}{}: {} -> {}", "  ".repeat(d), s.rule, to_string(&s.integrand), to_string(&s.result));
    for t in &s.sub {
        show(t, d + 1);
    }
}

fn main() {
    sagebrush_sym::err::install_quiet_hook();
    for a in std::env::args().skip(1) {
        match sagebrush_sym::err::catch(|| integrate_steps(&parse(&a), "x")) {
            Ok(Some((r, st))) => {
                println!("{} = {}", a, to_string(&r));
                show(&st, 1);
            }
            Ok(None) => println!("{}: not found", a),
            Err(e) => println!("{}: error {}", a, e),
        }
    }
}
