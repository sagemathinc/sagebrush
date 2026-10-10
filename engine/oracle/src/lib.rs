//! Sagebrush's engine against FLINT, as an independent reference: the tests
//! (`cargo test -p sagebrush-oracle`, which needs FLINT: see engine/flint)
//! and the benchmarks and LMFDB comparisons in examples/.  Kept in this
//! crate so that the shipped crates neither depend on FLINT nor need it to
//! run their own tests.
