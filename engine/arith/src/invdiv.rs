//! Division by an invariant divisor (Möller and Granlund, "Improved division
//! by invariant integers", IEEE Trans. Computers 60(2), 2011: Algorithms 4,
//! 5 and 6), for coprime's Knuth D and one-limb loops.  A reciprocal of the
//! normalized divisor is made once; each quotient limb then takes one
//! double-width product, a few adds and at most two corrections, where a
//! u128 division (a software loop on wasm32) took one or two.
//!
//! With b = 2^BITS and a normalized divisor (its top bit set):
//! - [`recip`]: v = floor((b^2 - 1) / d) - b, in [0, b);
//! - [`div2by1`]: (u1 b + u0) = q d + r for u1 < d (Algorithm 4);
//! - [`recip3`]: v3 = floor((b^3 - 1) / (d1 b + d0)) - b (Algorithm 6);
//! - [`div3by2`]: q = floor((u2 b^2 + u1 b + u0) / (d1 b + d0)) and its
//!   remainder, for (u2, u1) < (d1, d0) (Algorithm 5).
//!
//! **The wraps.**  In [`div2by1`], step 1's sum v u1 + (u1 + 1) b + u0 can
//! reach b^2 (q1 = b, one more than any true quotient): it wraps to 0, the
//! candidate remainder is then negative, and step 3's test r > q0 takes q1
//! back to b - 1.  In [`div3by2`], step 4's q1 + 1 wraps the same way when
//! q1 = b - 1, and step 5 takes it back.  So those steps are written with
//! wrapping operations; every other add, subtraction and product here is
//! plain, so a test build (overflow checks on) panics on any wrap the proof
//! doesn't allow.  The steps are generated for (u8, u16), (u16, u32) and
//! (u64, u128) from one macro: the narrow ones are tested exhaustively.

macro_rules! invdiv {
    ($name:ident, $L:ty, $W:ty) => {
        invdiv!($name, $L, $W, |a: $L, b: $L| {
            let p = (a as $W) * (b as $W);
            ((p >> <$L>::BITS) as $L, p as $L)
        });
    };
    ($name:ident, $L:ty, $W:ty, $mul:expr) => {
        pub(crate) mod $name {
            #[allow(unused_imports)]
            use super::*;

            const BITS: u32 = <$L>::BITS;

            /// a b as (high, low).
            #[inline]
            pub(crate) fn mul(a: $L, b: $L) -> ($L, $L) {
                ($mul)(a, b)
            }

            /// v = floor((b^2 - 1) / d) - b for a normalized d: the
            /// numerator (b - 1 - d) b + (b - 1) = b^2 - 1 - d b, below d b
            /// (as b - 1 - d < d), so the quotient fits a limb.
            #[inline]
            pub(crate) fn recip(d: $L) -> $L {
                debug_assert!(d >> (BITS - 1) == 1);
                let num = (((!d) as $W) << BITS) | (<$L>::MAX as $W);
                (num / (d as $W)) as $L
            }

            /// (q, r) with u1 b + u0 = q d + r, 0 <= r < d; u1 < d, d
            /// normalized, v = recip(d).
            #[inline]
            pub(crate) fn div2by1(u1: $L, u0: $L, d: $L, v: $L) -> ($L, $L) {
                debug_assert!(u1 < d);
                // 1. (q1, q0) = v u1 + (u1 + 1, u0) mod b^2 (it can wrap)
                let (p1, p0) = mul(v, u1);
                let (q0, c) = p0.overflowing_add(u0);
                let mut q1 = p1.wrapping_add(u1 + 1).wrapping_add(c as $L);
                // 2. r = u0 - q1 d mod b
                let mut r = u0.wrapping_sub(q1.wrapping_mul(d));
                // 3. a negative candidate remainder: one back (wrapping)
                if r > q0 {
                    q1 = q1.wrapping_sub(1);
                    r = r.wrapping_add(d);
                }
                // 4. rare: one forward (here q1 + 1 is the true quotient)
                if r >= d {
                    q1 += 1;
                    r -= d;
                }
                (q1, r)
            }

            /// v3 = floor((b^3 - 1) / (d1 b + d0)) - b for a normalized d1
            /// (Algorithm 6), from v = recip(d1).
            #[inline]
            pub(crate) fn recip3(d1: $L, d0: $L, v: $L) -> $L {
                let mut v = v;
                let mut p = d1.wrapping_mul(v).wrapping_add(d0);
                if p < d0 {
                    v -= 1;
                    if p >= d1 {
                        v -= 1;
                        p -= d1;
                    }
                    p = p.wrapping_sub(d1);
                }
                let (t1, t0) = mul(v, d0);
                p = p.wrapping_add(t1);
                if p < t1 {
                    v -= 1;
                    if (p, t0) >= (d1, d0) {
                        v -= 1;
                    }
                }
                v
            }

            /// (q, r1, r0) with u2 b^2 + u1 b + u0 = q (d1 b + d0) + (r1 b
            /// + r0), the remainder below d1 b + d0; (u2, u1) < (d1, d0),
            /// d1 normalized, v3 = recip3(d1, d0, recip(d1)).
            #[inline]
            pub(crate) fn div3by2(u2: $L, u1: $L, u0: $L, d1: $L, d0: $L, v3: $L) -> ($L, $L, $L) {
                debug_assert!((u2, u1) < (d1, d0));
                // 1. (q1, q0) = v3 u2 + (u2, u1): below b^2 here (checked)
                let (p1, p0) = mul(v3, u2);
                let (q0, c) = p0.overflowing_add(u1);
                let mut q1 = p1 + u2 + (c as $L);
                // 2. r1 = u1 - q1 d1 mod b
                let r1 = u1.wrapping_sub(q1.wrapping_mul(d1));
                // 3. (r1, r0) = (r1, u0) - (d1, d0) - d0 q1 mod b^2
                let (t1, t0) = mul(d0, q1);
                let (r0, bw) = u0.overflowing_sub(d0);
                let r1 = r1.wrapping_sub(d1).wrapping_sub(bw as $L);
                let (r0, bw) = r0.overflowing_sub(t0);
                let mut r1 = r1.wrapping_sub(t1).wrapping_sub(bw as $L);
                let mut r0 = r0;
                // 4. q1 + 1 (it can wrap)
                q1 = q1.wrapping_add(1);
                // 5. a negative candidate remainder: one back (wrapping)
                if r1 >= q0 {
                    q1 = q1.wrapping_sub(1);
                    let (s0, cy) = r0.overflowing_add(d0);
                    r1 = r1.wrapping_add(d1).wrapping_add(cy as $L);
                    r0 = s0;
                }
                // 6. rare: one forward
                if (r1, r0) >= (d1, d0) {
                    q1 += 1;
                    let (s0, bw) = r0.overflowing_sub(d0);
                    r1 = r1 - d1 - (bw as $L);
                    r0 = s0;
                }
                (q1, r1, r0)
            }
        }
    };
}

/// a b as (high, low), 64 x 64 -> 128 bits.  On wasm32 a u128 product is
/// a call to the general 128 x 128 routine (`__multi3`); there it is four
/// 32 x 32 -> 64 products (native i64.mul) instead.  Elsewhere the u128
/// product, which is the machine's own wide multiply.
#[inline]
pub(crate) fn mul_wide(a: u64, b: u64) -> (u64, u64) {
    #[cfg(target_arch = "wasm32")]
    {
        mul_wide32(a, b)
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        let p = u128::from(a) * u128::from(b);
        ((p >> 64) as u64, p as u64)
    }
}

/// a b from four 32 x 32 -> 64 products: the middle sum is below 2^34, and
/// the high word can't overflow (a b < 2^128).  Compiled on every target,
/// so native tests check it against the u128 product.
#[inline]
#[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
pub(crate) fn mul_wide32(a: u64, b: u64) -> (u64, u64) {
    const M: u64 = 0xffff_ffff;
    let (a0, a1, b0, b1) = (a & M, a >> 32, b & M, b >> 32);
    let (p00, p01, p10, p11) = (a0 * b0, a0 * b1, a1 * b0, a1 * b1);
    let mid = (p00 >> 32) + (p01 & M) + (p10 & M);
    (p11 + (p01 >> 32) + (p10 >> 32) + (mid >> 32), (p00 & M) | (mid << 32))
}

invdiv!(w8, u8, u16);
invdiv!(w16, u16, u32);
invdiv!(w64, u64, u128, mul_wide);

pub(crate) use w64::{div2by1, div3by2, recip, recip3};

#[cfg(test)]
mod tests;
