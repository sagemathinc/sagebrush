//! Rigorous ball arithmetic: a midpoint m 2^e (exact) and a radius (an
//! upper bound) enclosing every value a computation can take.  No
//! floating-point arithmetic enters a result.  See DESIGN.md.

mod ball;
mod complex;
mod funcs;
mod mag;
mod special;

pub use ball::{cmp_dyadic, Ball};
pub use funcs::{catalan, euler_gamma, ln2, pi};
pub use complex::CBall;
pub use mag::Mag;
pub use special::{bernoulli, li2, ti2};
