//! scikit-learn's `simultaneous_sort` (sklearn 1.9.1: utils/_sorting.pyx), line by line: an unstable introsort of
//! values carrying their sample indices, with a 3-way partition (what the tree partitioner asks for) or a 2-way
//! one, heapsort past the depth limit and insertion sort below 16 elements.  Equal values' order is whatever this
//! exact sequence of swaps leaves, and the tree's sums follow that order, so it is reproduced swap for swap: no
//! stable sort, no other pivot rule.  NaN never reaches it (the partitioner moves NaNs out first).
//!
//! Every loop over the data steps a Ticker (work.rs): a poll of Stop every 4096 iterations, inside the loop.
//!
//! Ported from scikit-learn (BSD-3-Clause, Copyright (c) 2007-2026 The scikit-learn developers; NOTICE.md).

use crate::work::{tick, Ticker};

/// The value types scikit-learn instantiates it for (`floating`: float32 and float64).
pub trait Value: Copy + PartialOrd {}
impl Value for f32 {}
impl Value for f64 {}

#[inline]
fn swap<T: Value>(values: &mut [T], indices: &mut [usize], i: usize, j: usize) {
    values.swap(i, j);
    indices.swap(i, j);
}

/// `simultaneous_sort(values, indices, n, use_three_way_partition)`: sort `values[..n]` with `indices[..n]` alongside.
pub fn simultaneous_sort<T: Value>(values: &mut [T], indices: &mut [usize], n: usize, use_three_way_partition: bool) {
    if n == 0 {
        return;
    }
    // (`maxd = 2 * <intp_t>log2(n)`: libm's log2 truncated, which is the integer floor of log2(n) for every n below
    // 2^49 - 1; every n a wasm32 memory can hold is below 2^32)
    let maxd = 2 * i64::from(usize::BITS - 1 - n.leading_zeros());
    if use_three_way_partition {
        introsort_3way(values, indices, 0, n, maxd);
    } else {
        introsort_2way(values, indices, 0, n, maxd);
    }
}

// The pointers `values` and `indices` of the reference, advanced over the sorted left part, are `lo` here.

fn introsort_2way<T: Value>(values: &mut [T], indices: &mut [usize], mut lo: usize, mut n: usize, mut maxd: i64) {
    while n > 15 {
        if maxd <= 0 {
            // max depth limit exceeded ("gone quadratic")
            heapsort(values, indices, lo, n);
            return;
        }
        maxd -= 1;
        let pivot = inplace_median3(values, indices, lo, n);
        // the median3 step ensures values[0] <= pivot and values[-1] >= pivot
        let (mut i, mut j) = (1usize, n - 2);
        let mut t = Ticker::default();
        loop {
            // find an element >= pivot from the left, and one <= pivot from the right
            while i <= j && values[lo + i] < pivot {
                i += 1;
                t.step();
            }
            while i <= j && values[lo + j] > pivot {
                j -= 1;
                t.step();
            }
            if i >= j {
                break;
            }
            swap(values, indices, lo + i, lo + j);
            i += 1;
            j -= 1;
            t.step();
        }
        t.finish();
        // put the pivot at pivot_idx
        let pivot_idx = i;
        swap(values, indices, lo + pivot_idx, lo + n - 1);
        // recursively sort the left side of the pivot, then continue with the right side
        introsort_2way(values, indices, lo, pivot_idx, maxd);
        lo += pivot_idx + 1;
        n -= pivot_idx + 1;
    }
    // in the small-array case, insertion sort is faster
    insertion_sort(values, indices, lo, n);
}

fn introsort_3way<T: Value>(values: &mut [T], indices: &mut [usize], mut lo: usize, mut n: usize, mut maxd: i64) {
    while n > 15 {
        if maxd <= 0 {
            heapsort(values, indices, lo, n);
            return;
        }
        maxd -= 1;
        let pivot = median3(values, lo, n);
        let (mut i, mut l, mut r) = (0usize, 0usize, n);
        let mut t = Ticker::default();
        while i < r {
            t.step();
            if values[lo + i] < pivot {
                swap(values, indices, lo + i, lo + l);
                i += 1;
                l += 1;
            } else if values[lo + i] > pivot {
                r -= 1;
                swap(values, indices, lo + i, lo + r);
            } else {
                i += 1;
            }
        }
        t.finish();
        // values[:l] < pivot, values[l:r] == pivot, values[r:] > pivot: sort the left side, continue with the right
        introsort_3way(values, indices, lo, l, maxd);
        lo += r;
        n -= r;
    }
    insertion_sort(values, indices, lo, n);
}

// (the tests' count of heapsort fallbacks: which inputs reach the depth limit)
#[cfg(test)]
pub(crate) static HEAPSORTS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

fn heapsort<T: Value>(values: &mut [T], indices: &mut [usize], lo: usize, n: usize) {
    #[cfg(test)]
    HEAPSORTS.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    // heapify (`start = (n - 2) / 2`: n > 15 here)
    let mut start = (n - 2) / 2;
    let end = n;
    loop {
        sift_down(values, indices, lo, start, end);
        if start == 0 {
            break;
        }
        start -= 1;
    }
    // sort by shrinking the heap, putting the max element immediately after it
    let mut end = n - 1;
    while end > 0 {
        swap(values, indices, lo, lo + end);
        sift_down(values, indices, lo, 0, end);
        end -= 1;
    }
}

/// Restore heap order in values[start:end] by moving the max element to start.
fn sift_down<T: Value>(values: &mut [T], indices: &mut [usize], lo: usize, start: usize, end: usize) {
    let mut root = start;
    loop {
        let child = root * 2 + 1;
        // find max of root, left child, right child
        let mut maxind = root;
        if child < end && values[lo + maxind] < values[lo + child] {
            maxind = child;
        }
        if child + 1 < end && values[lo + maxind] < values[lo + child + 1] {
            maxind = child + 1;
        }
        // (a step of the sift: its depth is the work, log n per sift)
        tick(1);
        if maxind == root {
            break;
        }
        swap(values, indices, lo + root, lo + maxind);
        root = maxind;
    }
}

/// Median-of-three pivot selection: the smallest of the three moves to the beginning, the middle (the pivot value)
/// to the end, and the largest to the pivot index.
fn inplace_median3<T: Value>(values: &mut [T], indices: &mut [usize], lo: usize, n: usize) -> T {
    let pivot_idx = n / 2;
    if values[lo] > values[lo + n - 1] {
        swap(values, indices, lo, lo + n - 1);
    }
    if values[lo + n - 1] > values[lo + pivot_idx] {
        swap(values, indices, lo + n - 1, lo + pivot_idx);
        if values[lo] > values[lo + n - 1] {
            swap(values, indices, lo, lo + n - 1);
        }
    }
    values[lo + n - 1]
}

/// Median of three, after Bentley and McIlroy (1993), without moving anything.
fn median3<T: Value>(values: &[T], lo: usize, n: usize) -> T {
    let (a, b, c) = (values[lo], values[lo + n / 2], values[lo + n - 1]);
    if a < b {
        if b < c {
            b
        } else if a < c {
            c
        } else {
            a
        }
    } else if b < c {
        if a < c {
            a
        } else {
            c
        }
    } else {
        b
    }
}

fn insertion_sort<T: Value>(values: &mut [T], indices: &mut [usize], lo: usize, n: usize) {
    for i in 1..n {
        let temp_val = values[lo + i];
        let temp_idx = indices[lo + i];
        let mut j = i;
        while j > 0 && values[lo + j - 1] > temp_val {
            values[lo + j] = values[lo + j - 1];
            indices[lo + j] = indices[lo + j - 1];
            j -= 1;
        }
        values[lo + j] = temp_val;
        indices[lo + j] = temp_idx;
    }
    // (at most 15 elements: a bounded constant, counted all the same)
    tick(n as u64);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sorted_with_indices<T: Value + std::fmt::Debug>(v: &[T], three: bool) -> (Vec<T>, Vec<usize>) {
        let (mut v, mut ix): (Vec<T>, Vec<usize>) = (v.to_vec(), (0..v.len()).collect());
        let n = v.len();
        simultaneous_sort(&mut v, &mut ix, n, three);
        (v, ix)
    }

    #[test]
    fn sorts_and_carries_the_indices() {
        let _g = crate::work::tests_serial();
        let mut s = 7u32;
        for &n in &[0usize, 1, 2, 15, 16, 17, 100, 1000] {
            for three in [false, true] {
                let v: Vec<f32> = (0..n).map(|_| (crate::rng::our_rand_r(&mut s) % 50) as f32).collect();
                let (w, ix) = sorted_with_indices(&v, three);
                assert!(w.windows(2).all(|p| p[0] <= p[1]), "n={n}");
                assert!(ix.iter().zip(&w).all(|(&i, &x)| v[i] == x), "n={n}");
                let mut seen = ix.clone();
                seen.sort_unstable();
                assert_eq!(seen, (0..n).collect::<Vec<_>>());
            }
        }
    }

    #[test]
    fn a_large_sort_polls_with_its_work() {
        let _g = crate::work::tests_serial();
        sagebrush_interrupt::hooks::reset();
        let mut s = 3u32;
        let v: Vec<f64> = (0..200_000).map(|_| f64::from(crate::rng::our_rand_r(&mut s) % 1000)).collect();
        let _ = sorted_with_indices(&v, true);
        // (each partition pass ticks its length: at least n / 4096 polls for the first pass alone)
        assert!(sagebrush_interrupt::hooks::total() >= 200_000 / 4096);
    }
}
