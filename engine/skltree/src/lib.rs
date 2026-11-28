//! Sagebrush's decision-tree kernel for its scikit-learn subset (the design
//! note sklearn-trees r3).
//!
//! The kernel ports scikit-learn 1.9.1's C-level tree code line by line
//! (BSD-3-Clause, Copyright (c) 2007-2026 The scikit-learn developers;
//! NOTICE.md), so that a tree, a forest or a bagging ensemble grown here has
//! the same bits as real scikit-learn's for the same `random_state`.
//! Everything RandomState decides stays in Python, on Sagebrush's numpy; this
//! crate gets only the splitter's 32-bit seed.
//!
//! So far, with no estimator yet:
//! - [`data`]: datasets (X as float32, y as float64, the missing-value mask),
//!   handed over once and kept by handle, so every tree of an ensemble shares
//!   one copy;
//! - [`work`]: the Stop polls every data-sized loop makes (`tick`, `Ticker`);
//! - [`rng`], [`sort`], [`partition`]: scikit-learn's XorShift, its introsort
//!   and its dense partitioner, checked against real scikit-learn's own test
//!   hooks (`oracle/`);
//! - `wasm` (wasm32 only): the module's exports, the runtime's
//!   src/runtime/skltree.ts their one caller.
//!
//! Memory: the heap is engine/wasmheap's, bounded at its source; the host
//! admits each call's growth (page-rounded) before it makes it, and sets the
//! bound to exactly that (`skt_begin`).  Every allocation here is fallible
//! (`try_reserve_exact`): a refused one is the call's error code, not a trap.

pub mod data;
pub mod partition;
pub mod rng;
pub mod sort;
pub mod work;

#[cfg(test)]
mod oracle_tests;

#[cfg(target_arch = "wasm32")]
mod wasm;
