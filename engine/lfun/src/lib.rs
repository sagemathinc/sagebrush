//! L-functions of elliptic curves over Q in double precision.
//!
//! * `complex`: a minimal complex double.
//! * `gamma`: ln Gamma(z) and the incomplete Gamma(a, z) for complex a and z.
//! * `an`: the coefficients a_n of L(E, s) from the a_p.
//! * `lseries`: L(E, s) at any complex s, and the root number.

pub mod an;
pub mod complex;
pub mod gamma;
pub mod lseries;

pub use an::{anlist, Local};
pub use complex::C64;
pub use gamma::{gamma_inc, ln_gamma, Scaled};
pub use lseries::{root_number, terms_needed, LSeries};
