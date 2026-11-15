//! Prime-number functions for Sage mode, written from published methods:
//!
//! * `li`: the logarithmic integral li(x) and its offset form Li(x);
//! * `sieve`: the sieve of Eratosthenes, whole and segmented (the primes in a window, and their count);
//! * `prime_pi`: pi(x), the number of primes up to x, by the combinatorial method (Lagarias, Miller, Odlyzko;
//!   Deleglise, Rivat);
//! * `zeta`: the Riemann-Siegel theta and Z functions, Gram points, and the zeros of zeta on the critical line.

pub mod li;
mod li_cheb;
pub mod prime_pi;
pub mod sieve;
pub mod zeta;
mod zeta_rs_cheb;

pub use li::{li, li_offset};
pub use prime_pi::{prime_pi, PRIME_PI_MAX};
pub use sieve::{count_in, primes_in};
pub use zeta::{zeta_zeros, ZETA_ZERO_INDEX_MAX};
