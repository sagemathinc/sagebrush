//! Exact arithmetic for the Sagebrush engines, in the spirit of FLINT's
//! nmod, nmod_poly, fmpz_poly and fmpz_mat layers (clean-room, from the
//! literature cited in each module):
//!
//! - [`nmod`]: arithmetic modulo a word, primality of words, primes for
//!   multimodular algorithms;
//! - [`ntt`]: number-theoretic transforms and the convolutions on them;
//! - [`crt`]: Chinese remaindering of many values over fixed primes;
//! - [`nmod_poly`]: polynomials over Z/n;
//! - [`nmod_mat`]: dense matrices over Z/p;
//! - [`zmat`]: dense matrices over Z and Q (multimodular, certified);
//! - [`zpoly`]: polynomials over Z (Kronecker products, modular gcd).

// word-size moduli and the NTT live in sagebrush-bigint (its huge
// products use them); re-exported here
pub use sagebrush_bigint::{nmod, ntt};
pub mod crt;
pub mod nmod_poly;
pub mod nmod_mat;
pub mod zmat;
pub mod zpoly;
