//! Stop during FGLM over GF(p) (the interrupt crate's test hooks): the lex
//! basis of (x^1000000) over GF(32003) goes through FGLM, whose setup (the
//! staircase of a million monomials, the border, the normal forms and the
//! multiplication maps) and walk check Stop once per monomial or row.  A
//! Stop armed in any of them stops there, the setup's longest stretch of
//! CPU time between two simulated WebAssembly host polls is short, and the
//! next call works.  One test: the hooks and the request flag are
//! process-wide.

use num_traits::One;
use sagebrush_bigint::BigInt;
use sagebrush_interrupt::{catch, hooks};
use sagebrush_mpoly::{call, QPoly};

fn gfp(n: usize, text: &str, p: u64) -> Vec<u8> {
    let f = QPoly::from_text(n, text).unwrap();
    QPoly { num: f.num.reduce_mod(p), den: BigInt::one(), p }.to_bytes()
}

/// The lex basis of the polynomials (bytes) as text, or the Stop.
fn lex(fs: &[Vec<u8>]) -> Result<Result<Vec<String>, String>, sagebrush_interrupt::Interrupted> {
    let mut args: Vec<&[u8]> = vec![b"lex"];
    args.extend(fs.iter().map(|f| f.as_slice()));
    catch(|| call("groebner", &args).map(|out| out.iter().map(|b| QPoly::from_bytes(b).unwrap().to_text()).collect()))
}

/// Run with a Stop armed at the k-th check of `phase` and, so that a
/// phase that never checks fails promptly rather than running on, at the
/// `backstop`-th check of any: (stopped?, the phase it stopped in, the
/// checks made, the longest CPU time between two host polls in ms).
fn stop_in(phase: &'static str, k: u64, backstop: u64, fs: &[Vec<u8>]) -> (bool, &'static str, u64, f64) {
    hooks::reset();
    hooks::trace();
    hooks::arm_in_phase(phase, k);
    hooks::arm_after(backstop);
    let r = lex(fs);
    let (at, total, cpu) = (hooks::stopped_in(), hooks::total(), hooks::max_poll_gap_cpu_ns() as f64 / 1e6);
    hooks::reset();
    sagebrush_interrupt::clear();
    (r.is_err(), at, total, cpu)
}

#[test]
fn fglm_stops_in_its_setup_and_walk_and_recovers() {
    // WebAssembly runs FGLM on one thread
    std::env::set_var("SAGEBRUSH_THREADS", "1");
    let big = vec![gfp(1, "1000000:1", 32003)];
    let small = vec![gfp(2, "2,0:1;0,1:-1", 32003), gfp(2, "0,2:1;0,0:-2", 32003)];
    let small_basis = lex(&small).unwrap().unwrap();
    // 1. a Stop at the walk's first check: the whole setup ran, polling the
    // host within 250 ms of CPU time throughout (a loaded host stretches the
    // wall time of the same work, not the CPU time: this bound is the work's)
    let (stopped, at, setup_checks, cpu) = stop_in("fglm.walk", 1, 20_000_000, &big);
    assert!(stopped && at == "fglm.walk", "stopped {} in {:?}", stopped, at);
    eprintln!("setup ran in full: {} checks; longest CPU time between host polls {:.2} ms", setup_checks, cpu);
    if hooks::thread_cpu_ns().is_some() {
        assert!(cpu > 0.0 && cpu <= 250.0, "{:.2} ms of CPU time between two host polls in FGLM's setup", cpu);
    }
    // 2. a Stop in each loop of the setup (the staircase of a million
    // monomials, the border, the normal forms, the multiplication map), at
    // its k-th check, stops there: each loop checks as it goes, however fast
    // the host (one that didn't would run to its end, and the backstop just
    // past the setup's checks would stop the walk instead)
    for (phase, k) in [("fglm.staircase", 200_000), ("fglm.border", 200_000), ("fglm.normal_forms", 1), ("fglm.mult", 200_000)] {
        let (stopped, at, _, _) = stop_in(phase, k, setup_checks + 16, &big);
        assert!(stopped && at == phase, "{}: stopped {} in {:?}", phase, stopped, at);
    }
    // 3. the walk's product (a million coordinates: a check every 4096) and
    // its elimination (a check every 1024 echelon rows and at each row it
    // reduces by) check in their own phases: a Stop armed in each, at its
    // 100th and first check, stops there, within the walk's first steps
    // (without the product's or the elimination's checks, the backstop a
    // thousand checks past the setup stops the walk elsewhere)
    for (phase, k) in [("fglm.walk.apply", 100), ("fglm.walk.reduce", 1)] {
        let (stopped, at, _, _) = stop_in(phase, k, setup_checks + 1000, &big);
        assert!(stopped && at == phase, "{}: stopped {} in {:?}", phase, stopped, at);
    }
    // 4. the next call works, with the basis it had before
    assert_eq!(lex(&small).unwrap().unwrap(), small_basis);
    assert_eq!(small_basis.len(), 2);
}
