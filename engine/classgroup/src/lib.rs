//! Class groups, clean-room (from Cohen's books and the literature; PARI is
//! used only as an outside oracle and benchmark).  Quadratic fields so far:
//! imaginary (imag.rs) and real, with the regulator (realq.rs), from
//! relations found by Jacobson's sieve (relations.rs).
pub mod arith;
pub mod form;
pub mod relations;
pub mod linalg;
pub mod imag;
pub mod real;
pub mod realq;
