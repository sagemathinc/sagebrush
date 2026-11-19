//! Reduction modulo a sparse polynomial uses the inverse stored with it,
//! in its own test binary (the interrupt hooks' counts are process-wide).
//! For f = x^100 + 3, 1/rev(f) mod x^99 is 1: the stored inverse has one
//! coefficient but precision 99, and a reduction must not compute a Newton
//! inverse again (reduce_work charges the stored inverse's products for
//! such a reduction).

use sagebrush_arith::nmod::Modulus;
use sagebrush_arith::nmod_poly::{mul, rem, PolyModulus};
use sagebrush_interrupt::hooks;

#[test]
fn reduce_uses_the_stored_inverse_of_a_sparse_modulus() {
    let m = Modulus::new(65537);
    for (deg, c) in [(100usize, 3u64), (257, 65536), (1000, 5)] {
        let mut f = vec![0u64; deg + 1];
        f[0] = c;
        f[deg] = 1;
        let pm = PolyModulus::new(&f, &m);
        let mut s = 0x2545_F491_4F6C_DD1Du64 ^ deg as u64;
        let mut next = || {
            s ^= s << 13;
            s ^= s >> 7;
            s ^= s << 17;
            s % 65537
        };
        let a: Vec<u64> = (0..deg).map(|_| next()).collect();
        let b: Vec<u64> = (0..deg).map(|_| next()).collect();
        let x = mul(&a, &b, &m);
        hooks::reset();
        let r = pm.reduce(&x);
        let newton: u64 = hooks::counts().iter().filter(|c| c.0 == "newton-inverse").map(|c| c.1).sum();
        hooks::reset();
        assert_eq!(newton, 0, "deg {}: a Newton inverse computed during the reduction", deg);
        assert_eq!(r, rem(&x, &f, &m), "deg {}", deg);
        assert_eq!(pm.mulmod(&a, &b), r, "deg {}", deg);
    }
}
