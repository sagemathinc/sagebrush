//! Parallel map when this crate's own `parallel` feature is on, sequential
//! otherwise: the engine's one wrapper (sagebrush-par; every closure runs
//! under its caller's ledger context, sequentially in exclusive mode).  The
//! gate is this crate's feature, not sagebrush-par's, so a build that opts out
//! (`engine/web`, `engine/wasm`: `default-features = false`) stays sequential
//! even when another crate in it turns sagebrush-par's `parallel` on.

#[cfg(feature = "parallel")]
#[allow(unused_imports)]
pub use sagebrush_par::{for_each_chunk_mut, for_each_mut, map_range, map_slice};
#[cfg(not(feature = "parallel"))]
#[allow(unused_imports)]
pub use sagebrush_par::seq::{for_each_chunk_mut, for_each_mut, map_range, map_slice};

#[cfg(test)]
mod tests {
    /// Parallel exactly when this crate's own feature is on.  Run also as
    /// `--no-default-features --features sagebrush-par/parallel`, the
    /// unification case.
    #[test]
    fn every_entry_is_parallel_iff_this_crates_feature_is_on() {
        let here = std::thread::current().id();
        let slow = || {
            std::thread::sleep(std::time::Duration::from_millis(1));
            std::thread::current().id()
        };
        let a = super::map_range(64, |_| slow());
        let b = super::map_slice(&[0u8; 64], |_| slow());
        let mut c = vec![here; 64];
        super::for_each_mut(&mut c, |_, x| *x = slow());
        let mut d = vec![here; 64];
        super::for_each_chunk_mut(&mut d, 4, |_, xs| xs.iter_mut().for_each(|x| *x = slow()));
        for (name, ids) in [("map_range", a), ("map_slice", b), ("for_each_mut", c), ("for_each_chunk_mut", d)] {
            assert_eq!(ids.iter().all(|&t| t == here), !cfg!(feature = "parallel"), "{name}");
        }
    }
}
