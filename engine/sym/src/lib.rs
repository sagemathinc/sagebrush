//! sagebrush-sym: a symbolic expression engine for the Sagebrush Sage
//! layer (clean-room, MIT OR Apache-2.0): canonical expressions with
//! automatic simplification, Sage-compatible printing and LaTeX, and the
//! calculus on them.

pub mod diff;
pub mod err;
pub mod eval;
pub mod expand;
pub mod expr;
pub mod func;
pub mod limit;
pub mod num;
pub mod ops;
pub mod parse;
pub mod poly;
pub mod mpoly;
pub mod print;
pub mod series;
pub mod simplify;
pub mod solve;

pub use err::{catch, SymError};
pub use expr::Expr;
pub use parse::parse;
pub use print::{to_latex, to_string};
