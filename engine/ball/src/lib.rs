//! Rigorous ball arithmetic: a midpoint m 2^e (exact) and a radius (an
//! upper bound) enclosing every value a computation can take.  No
//! floating-point arithmetic enters a result.  See DESIGN.md.

mod ball;
mod funcs;
mod mag;

pub use ball::{cmp_dyadic, Ball};
pub use funcs::{catalan, euler_gamma, ln2, pi};
pub use mag::Mag;
