//! Parallel map when this crate's own `parallel` feature is on, sequential
//! otherwise (as in sagebrush-modsym): the engine's one wrapper, sagebrush-par.
//! The gate is this crate's feature, not sagebrush-par's, so a build that
//! opts out (`engine/web`: `default-features = false`) stays sequential even
//! when another crate in it turns sagebrush-par's `parallel` on.

#[cfg(feature = "parallel")]
pub use sagebrush_par::map_range;
#[cfg(not(feature = "parallel"))]
pub use sagebrush_par::seq::map_range;

#[cfg(test)]
mod tests {
    /// Parallel exactly when this crate's own feature is on.  Run also as
    /// `--no-default-features --features sagebrush-par/parallel`, the
    /// unification case.
    #[test]
    fn map_range_is_parallel_iff_this_crates_feature_is_on() {
        let here = std::thread::current().id();
        let ids = super::map_range(64, |_| {
            std::thread::sleep(std::time::Duration::from_millis(1));
            std::thread::current().id()
        });
        assert_eq!(ids.iter().all(|&t| t == here), !cfg!(feature = "parallel"));
    }
}
