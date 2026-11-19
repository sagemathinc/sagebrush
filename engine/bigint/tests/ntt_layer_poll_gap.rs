//! How long a Stop can go unnoticed in a transform: a layer longer than
//! BLOCK butterflies runs in BLOCK-sized chunks with a poll between them, so
//! a product of 2^19 points (poly_mul's largest) never runs a whole top
//! layer of 2^18 butterflies between two polls.  Its own test binary: the
//! interrupt hooks are global.

use sagebrush_bigint::ntt::mul_words_local;
use sagebrush_interrupt::hooks;

#[test]
fn layer_poll_gap_at_two_to_the_19() {
    let half = 1usize << 18;
    let mut s = 7u64;
    let mut rng = || {
        s ^= s << 13;
        s ^= s >> 7;
        s ^= s << 17;
        s
    };
    let a: Vec<u64> = (0..half).map(|_| rng()).collect();
    let b: Vec<u64> = (0..half).map(|_| rng()).collect();
    hooks::reset();
    hooks::trace();
    let z = mul_words_local(&a, &b);
    let polls = hooks::total();
    let gap = hooks::max_gap_ns();
    let ntt = hooks::traced("ntt");
    hooks::reset();
    assert_eq!(z.len(), 2 * half);
    // per prime and transform, every layer above BLOCK polls once per 2^12
    // butterflies: at least 3 x 3 x (2^18 / 2^12) polls in the top layers
    assert!(polls >= 9 * 64, "{} polls in a product of 2^19 points", polls);
    eprintln!("product of 2^19 points: {} polls, longest gap {:.3} ms", polls, gap as f64 / 1e6);
    assert!(gap <= 20_000_000, "{:.2} ms between two polls in a transform", gap as f64 / 1e6);

    // a Stop at the transforms' first, a middle and their last poll stops the
    // product (an unwind; the op-local tables simply drop), and the next
    // product is the same (where a panic unwinds: in WebAssembly a Stop traps
    // and the host discards the instance)
    assert!(ntt.len() >= 3, "{} polls in the transforms", ntt.len());
    #[cfg(panic = "unwind")]
    for at in [ntt[0], ntt[ntt.len() / 2], ntt[ntt.len() - 1]] {
        hooks::reset();
        hooks::arm_at(at);
        let r = sagebrush_interrupt::catch(|| mul_words_local(&a, &b));
        let phase = hooks::stopped_in();
        hooks::reset();
        sagebrush_interrupt::clear();
        assert!(r.is_err(), "no Stop at poll {}", at);
        assert_eq!(phase, "ntt", "stopped at poll {} in {:?}", at, phase);
    }
    #[cfg(panic = "unwind")]
    assert_eq!(mul_words_local(&a, &b), z, "the product after the Stops");
}
