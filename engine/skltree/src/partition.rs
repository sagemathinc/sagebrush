//! scikit-learn's `DensePartitioner` (sklearn 1.9.1: tree/_partitioner.pyx), line by line, for the best splitter:
//! gathering a node's values of one feature (missing values moved to the end, the rest sorted with
//! `simultaneous_sort`'s 3-way introsort), stepping over the candidate split positions (`next_p`), moving the
//! missing values to the left for the second search pass, and the final partition of the node's samples.  The
//! random splitter's pieces (find_min_max, partition_samples) aren't ported: it isn't supported.
//!
//! The samples' order after each step is part of the bits: the criteria sum in it.  Every loop steps a Ticker.
//!
//! Ported from scikit-learn (BSD-3-Clause, Copyright (c) 2007-2026 The scikit-learn developers; NOTICE.md).

use crate::data::Error;
use crate::sort::simultaneous_sort;
use crate::work::{chunks, Ticker};

/// `FEATURE_THRESHOLD`: values closer than this are one value (a float32, added in float32).
pub const FEATURE_THRESHOLD: f32 = 1e-7;

/// The partitioner's state over one fit: the samples (the positive-weight ones, rearranged node by node), the
/// current feature's values for the current node, and the buffers `swap_array_slices` moves through.
pub struct Partitioner {
    pub samples: Vec<usize>,
    pub feature_values: Vec<f32>,
    swap_samples: Vec<usize>,
    swap_values: Vec<f32>,
    pub start: usize,
    pub end: usize,
    pub n_missing: usize,
}

fn buffer<T: Copy + Default>(n: usize) -> Result<Vec<T>, Error> {
    let mut v = Vec::new();
    v.try_reserve_exact(n).map_err(|_| Error::Memory)?;
    chunks(n, |lo, hi| {
        v.extend(std::iter::repeat_n(T::default(), hi - lo));
        Ok(())
    })?;
    Ok(v)
}

impl Partitioner {
    /// A partitioner over `samples` (as Splitter.init leaves them), its buffers allocated fallibly.
    pub fn new(samples: Vec<usize>) -> Result<Self, Error> {
        let n = samples.len();
        Ok(Partitioner { samples, feature_values: buffer(n)?, swap_samples: buffer(n)?, swap_values: buffer(n)?, start: 0, end: 0, n_missing: 0 })
    }

    /// `init_node_split(start, end)`.
    pub fn init_node_split(&mut self, start: usize, end: usize) {
        self.start = start;
        self.end = end;
        self.n_missing = 0;
    }

    /// `sort_samples_and_feature_values(current_feature)`: the node's values of the feature into feature_values,
    /// the missing ones moved to the end (when the feature may have any, `missing`), the rest sorted with their
    /// samples.  `x` is X row-major, `f` features a row.
    pub fn sort_samples_and_feature_values(&mut self, x: &[f32], f: usize, current_feature: usize, missing: Option<&[u8]>) {
        let mut n_missing = 0;
        let mut t = Ticker::default();
        if missing.is_some_and(|m| m[current_feature] != 0) {
            // missing values are placed at the end and do not participate in the sorting
            let (mut i, mut current_end) = (self.start as isize, self.end as isize - 1);
            while i <= current_end {
                t.step();
                // the right-most value that is not missing, so that it can be swapped with missing values at its left
                if x[self.samples[current_end as usize] * f + current_feature].is_nan() {
                    n_missing += 1;
                    current_end -= 1;
                    continue;
                }
                // X[samples[current_end], current_feature] is a non-missing value
                if x[self.samples[i as usize] * f + current_feature].is_nan() {
                    self.samples.swap(i as usize, current_end as usize);
                    n_missing += 1;
                    current_end -= 1;
                }
                self.feature_values[i as usize] = x[self.samples[i as usize] * f + current_feature];
                i += 1;
            }
        } else {
            // with no missing values, only the copy
            for i in self.start..self.end {
                t.step();
                self.feature_values[i] = x[self.samples[i] * f + current_feature];
            }
        }
        t.finish();
        let n = self.end - self.start - n_missing;
        simultaneous_sort(&mut self.feature_values[self.start..], &mut self.samples[self.start..], n, true);
        self.n_missing = n_missing;
    }

    /// `shift_missing_to_the_left()`: the node's missing values (grouped at its right) moved to its left, the
    /// non-missing ones to the right, each group's inner order kept.
    pub fn shift_missing_to_the_left(&mut self) {
        let n_non_missing = self.end - self.start - self.n_missing;
        swap_array_slices(&mut self.samples, self.start, self.end, n_non_missing, &mut self.swap_samples);
        swap_array_slices(&mut self.feature_values, self.start, self.end, n_non_missing, &mut self.swap_values);
    }

    /// `next_p(&p_prev, &p, missing_go_to_left)`: the next candidate split position after `p`, skipping ties up to
    /// FEATURE_THRESHOLD; returns (p_prev, p).  See scikit-learn's docstring for the two passes' layouts.
    pub fn next_p(&self, p: usize, missing_go_to_left: bool) -> (usize, usize) {
        let end_non_missing = if missing_go_to_left { self.end } else { self.end - self.n_missing };
        if p == end_non_missing && !missing_go_to_left {
            // skip the missing values up to the end (which ends the best split function's loop)
            return (self.end, self.end);
        }
        let mut p = p;
        if missing_go_to_left && p == self.start {
            // skip the missing values up to the first non-missing value
            p = self.start + self.n_missing;
        }
        p += 1;
        let mut t = Ticker::default();
        // (float32 + float32, compared in float32, as C computes `float <= float + float`)
        while p < end_non_missing && self.feature_values[p] <= self.feature_values[p - 1] + FEATURE_THRESHOLD {
            p += 1;
            t.step();
        }
        t.finish();
        (p - 1, p)
    }

    /// `partition_samples_final(best_split)`: the node's samples split at `threshold` on `feature` (X's value
    /// widened to float64 and compared `<=`; a NaN goes left when `missing_go_to_left`).
    pub fn partition_samples_final(&mut self, x: &[f32], f: usize, threshold: f64, feature: usize, missing_go_to_left: bool) {
        let (mut partition_start, mut partition_end) = (self.start, self.end);
        let mut t = Ticker::default();
        while partition_start < partition_end {
            t.step();
            let current_value = x[self.samples[partition_start] * f + feature];
            let go_to_left = if current_value.is_nan() { missing_go_to_left } else { f64::from(current_value) <= threshold };
            if go_to_left {
                partition_start += 1;
            } else {
                partition_end -= 1;
                self.samples.swap(partition_start, partition_end);
            }
        }
        t.finish();
    }
}

/// `swap_array_slices(array, start, end, n, buffer)`: array[start..start+n] and array[start+n..end] swap places,
/// each keeping its inner order, through `buffer` (at least end - start - n long).  As scikit-learn's memcpy,
/// memmove and memcpy, in chunks of at most 4096 elements, each ticked.
pub fn swap_array_slices<T: Copy>(array: &mut [T], start: usize, end: usize, n: usize, buffer: &mut [T]) {
    if start >= end {
        return;
    }
    let n_rev = end - start - n;
    // array[start + n : end] into the buffer
    let _ = chunks::<()>(n_rev, |lo, hi| {
        buffer[lo..hi].copy_from_slice(&array[start + n + lo..start + n + hi]);
        Ok(())
    });
    // array[start : start + n] to array[start + n_rev : end]: an overlapping move to the right, so the chunks go
    // from the last to the first (each chunk's own overlap is copy_within's, which is memmove's)
    let mut hi = n;
    let mut t = Ticker::default();
    while hi > 0 {
        let lo = hi.saturating_sub(crate::work::STRIDE as usize);
        array.copy_within(start + lo..start + hi, start + n_rev + lo);
        for _ in lo..hi {
            t.step();
        }
        hi = lo;
    }
    t.finish();
    // the buffer to array[start : start + n_rev]
    let _ = chunks::<()>(n_rev, |lo, hi| {
        array[start + lo..start + hi].copy_from_slice(&buffer[lo..hi]);
        Ok(())
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn swap_array_slices_is_a_rotation_keeping_each_side_in_order() {
        let _g = crate::work::tests_serial();
        for (len, start, end, n) in [(10, 0, 10, 3), (10, 2, 9, 0), (10, 2, 9, 7), (10, 4, 4, 0), (9000, 1, 8999, 4100), (9000, 0, 9000, 8999)] {
            let mut a: Vec<usize> = (0..len).collect();
            let mut want = a.clone();
            want[start..end].rotate_left(n.min(end - start));
            let mut buf = vec![0usize; len];
            swap_array_slices(&mut a, start, end, n, &mut buf);
            assert_eq!(a, want, "{len} {start} {end} {n}");
        }
    }

    fn part(x: &[f32], start: usize, end: usize) -> Partitioner {
        let mut p = Partitioner::new((0..x.len()).collect()).unwrap();
        p.init_node_split(start, end);
        p
    }

    #[test]
    fn missing_values_go_to_the_end_in_scikit_learns_swap_order() {
        let _g = crate::work::tests_serial();
        // one feature: samples 1 and 4 missing (traced by hand through the reference's loop)
        let x = [3.0, f32::NAN, 1.0, 2.0, f32::NAN, 0.5];
        let mut p = part(&x, 0, 6);
        p.sort_samples_and_feature_values(&x, 1, 0, Some(&[1]));
        assert_eq!(p.n_missing, 2);
        assert_eq!(&p.feature_values[..4], &[0.5, 1.0, 2.0, 3.0]);
        // (the loop: i=0 keeps 0; i=1 is NaN and swaps with 5 (4 being NaN was skipped from the right first), so the
        // missing ones end as [.., 1, 4] in that order)
        let mut tail = p.samples[4..].to_vec();
        tail.sort_unstable();
        assert_eq!(tail, vec![1, 4]);
        assert_eq!(&p.samples[..4], &[5, 2, 3, 0]);
        // with no mask, the same values are copied as they are (no NaN expected)
        let y = [3.0, 1.0, 2.0];
        let mut q = part(&y, 0, 3);
        q.sort_samples_and_feature_values(&y, 1, 0, None);
        assert_eq!((&q.feature_values[..3], &q.samples[..3], q.n_missing), (&[1.0, 2.0, 3.0][..], &[1, 2, 0][..], 0));
    }

    #[test]
    fn next_p_skips_float32_ties_and_walks_both_passes() {
        let _g = crate::work::tests_serial();
        // values 1, 1 + 5e-8 (a tie within FEATURE_THRESHOLD), 2, 2, 3, then two missing
        let x = [1.0f32, 1.0 + 5e-8, 2.0, 2.0, 3.0, f32::NAN, f32::NAN];
        let mut p = part(&x, 0, 7);
        p.sort_samples_and_feature_values(&x, 1, 0, Some(&[1]));
        assert_eq!(p.n_missing, 2);
        let mut seen = vec![];
        let mut at = p.start;
        while at < p.end {
            let (prev, next) = p.next_p(at, false);
            seen.push((prev, next));
            at = next;
        }
        // first pass: candidates between distinct values, then "all non-missing left", then the end
        assert_eq!(seen, vec![(1, 2), (3, 4), (4, 5), (7, 7)]);
        p.shift_missing_to_the_left();
        // (the missing samples moved left; their feature_values slots hold whatever was there, as scikit-learn's do:
        // the gather never writes a missing value, and next_p never reads those slots)
        assert!(x[p.samples[0]].is_nan() && x[p.samples[1]].is_nan());
        assert_eq!(&p.feature_values[2..7], &[1.0, 1.0 + 5e-8, 2.0, 2.0, 3.0]);
        let mut seen = vec![];
        let mut at = p.start;
        while at < p.end {
            let (prev, next) = p.next_p(at, true);
            seen.push((prev, next));
            at = next;
        }
        // second pass: the missing ones on the left, candidates among the rest, then the end
        assert_eq!(seen, vec![(3, 4), (5, 6), (6, 7)]);
    }

    #[test]
    fn the_final_partition_compares_in_float64_and_sends_nan_as_told() {
        let _g = crate::work::tests_serial();
        let x = [0.1f32, f32::NAN, 0.3, 0.2];
        let t = f64::from(0.1f32) / 2.0 + f64::from(0.2f32) / 2.0;
        for (missing_left, want_left) in [(true, 2), (false, 1)] {
            let mut p = part(&x, 0, 4);
            p.partition_samples_final(&x, 1, t, 0, missing_left);
            let left: Vec<usize> = p.samples[..4].iter().copied().take_while(|&s| x[s].is_nan() && missing_left || f64::from(x[s]) <= t).collect();
            assert_eq!(left.len(), want_left, "missing_go_to_left {missing_left}");
        }
    }
}
