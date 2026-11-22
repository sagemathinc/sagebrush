//! The work estimate's models in u64 at sizes past 32 bits, so that they
//! hold where usize is 32 bits (wasm32): a model's term crossing 2^32
//! keeps its value, a cap whose size is 2^32 words still binds as a size
//! (not as zero), a size product with a zero factor is zero whatever the
//! others, and an overflowing term saturates.

use sagebrush_arith::cost::{size_product, Family};
use sagebrush_arith::smith::estimate::{cyclic_model, part_a_model, trailing_model};

#[test]
fn model_terms_cross_32_bit_sizes() {
    let n = 1usize << 16;
    let u = cyclic_model(n, 1, 1, 1, 2, true, 5);
    assert_eq!(u.0[Family::ModArith as usize], (1u64 << 32) + 2 * (n as u64 - 1) + 8);
    let a = part_a_model(n, 3, 1, 1, 1, 1, true, 0.0);
    assert_eq!(a.0[Family::ModArith as usize], 3u64 << 32);
}

#[test]
fn a_transform_cap_of_2_to_the_32_words_is_kept() {
    // (the cap ceil((3 (bits + 1) + 6) / 64) is 2^32 words here: cast to a
    // 32-bit usize it would be zero, and V^-1's estimate would shrink; at
    // these sizes neither cap binds, so the model is that of 1000 bits)
    let bits = 91_625_968_978u64;
    assert_eq!((3 * (bits + 1) + 6).div_ceil(64), 1u64 << 32);
    let a = trailing_model(3, 2, 2, 1, 1, false, 1000, &[1, 2], 1.5, 0.92);
    let b = trailing_model(3, 2, 2, 1, 1, false, bits, &[1, 2], 1.5, 0.92);
    assert_eq!(a, b);
}

#[test]
fn zero_factors_and_saturated_terms() {
    assert_eq!(size_product(&[usize::MAX, usize::MAX, 0]), 0);
    assert_eq!(size_product(&[0, usize::MAX, usize::MAX]), 0);
    let u = cyclic_model(usize::MAX, 1, 1, 1, 2, true, 5);
    assert_eq!(u.0[Family::ModArith as usize], u64::MAX);
}
