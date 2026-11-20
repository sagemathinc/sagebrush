//! Sagebrush's multiprecision core (design/mpmath-core.md): mpmath's raw
//! arithmetic, ported from mpmath 1.3.0's pure-Python reference and
//! bit-identical to it apart from reviewed fixes of upstream bugs (src/mpf.rs
//! lists them), for the `_sagebrush_mpcore` backend that python's overlay selects.
//!
//! - `nat`: natural numbers on u64 limbs, every allocation checked against
//!   the call's limb limit and the heap (§4.5).
//! - `exp`: exponents of any magnitude (i64, promoted when needed).
//! - `mpf`: the raw mpf tuples and their arithmetic (libmpf's normalize,
//!   from_man_exp, mpf_add/sub/mul/div/sqrt).

pub mod abi;
pub mod exp;
pub mod fail;
pub mod consts;
pub mod gamma;
pub mod elefun;
pub mod glibm;
pub mod int;
pub mod intmath;
pub mod kernel;
pub mod linalg;
pub mod mpc;
pub mod mpf;
pub mod nat;
#[cfg(target_arch = "wasm32")]
mod wasm;

/// How a call failed: the outcomes the host tells apart.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Fail {
    /// A number over the call's limb limit (the session's limits): the
    /// host's limit error, before anything was allocated.
    Limit { limbs: u64 },
    /// An allocation the heap refused: the host's MemoryError.
    Memory { bytes: u64 },
    /// The reference's ZeroDivisionError.
    ZeroDivision,
    /// The reference's ComplexResult (a square root of a negative number).
    ComplexResult,
    /// The reference's KeyError: its {1: finf, -1: fninf}[sign] lookup with
    /// a sign of 0 (a negative zero meeting an infinity); reproduced, not fixed.
    KeyError,
}
