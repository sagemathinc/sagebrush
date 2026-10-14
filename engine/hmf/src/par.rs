//! Parallel map when the `parallel` feature is on, sequential otherwise
//! (as in sagebrush-modsym).

#[cfg(feature = "parallel")]
use rayon::prelude::*;

pub fn map_range<T: Send, F: Fn(usize) -> T + Sync + Send>(n: usize, f: F) -> Vec<T> {
    #[cfg(feature = "parallel")]
    return (0..n).into_par_iter().map(f).collect();
    #[cfg(not(feature = "parallel"))]
    return (0..n).map(f).collect();
}
