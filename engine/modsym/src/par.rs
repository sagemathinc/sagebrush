//! Parallel map when the `parallel` feature is on, sequential otherwise: the
//! engine's one wrapper (sagebrush-par; every closure runs under its caller's
//! ledger context, sequentially in exclusive mode).

#[allow(unused_imports)]
pub use sagebrush_par::{for_each_chunk_mut, for_each_mut, map_range, map_slice};
