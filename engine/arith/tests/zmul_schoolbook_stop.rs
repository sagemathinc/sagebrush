//! A Stop inside poly_mul's word schoolbook: it polls once per row chunk of
//! 2^12 columns, and a Stop at its first, a middle and its last poll stops
//! the product (an unwind), after which the next product is the same.  Its
//! own test binary: the interrupt hooks are global.  Only where a panic
//! unwinds (in WebAssembly a Stop traps and the host discards the instance).

#[cfg(panic = "unwind")]
#[test]
fn the_schoolbook_stops_at_its_first_middle_and_last_poll() {
    use sagebrush_arith::zmul::mul_words_schoolbook;
    use sagebrush_interrupt::hooks;
    let mut s = 0x77u64;
    let mut rng = || {
        s ^= s << 13;
        s ^= s >> 7;
        s ^= s << 17;
        s
    };
    let x: Vec<u64> = (0..(1 << 15)).map(|_| rng()).collect();
    let y: Vec<u64> = (0..100).map(|_| rng()).collect();
    let z = mul_words_schoolbook(&x, &y);
    hooks::reset();
    hooks::trace();
    let _ = mul_words_schoolbook(&x, &y);
    let polls = hooks::total();
    hooks::reset();
    // a poll per row chunk of 2^12 columns: 100 rows x 8 chunks
    assert_eq!(polls, 800);
    for at in [1, polls / 2, polls] {
        hooks::reset();
        hooks::arm_at(at);
        let r = sagebrush_interrupt::catch(|| mul_words_schoolbook(&x, &y));
        hooks::reset();
        sagebrush_interrupt::clear();
        assert!(r.is_err(), "no Stop at poll {}", at);
    }
    assert_eq!(mul_words_schoolbook(&x, &y), z);
}
