//! scikit-learn's best splitter (sklearn 1.9.1: tree/_splitter.pyx `Splitter.init`, `node_reset` and
//! `node_split_best`, the dense case), line by line: the features drawn without replacement by Fisher–Yates with the
//! XorShift, the constant-feature bookkeeping that persists from a node to its descendants, the two search passes
//! when a feature has missing values, the strict `>` on the proxy improvement, the threshold as the float64 sum of
//! two float32 halves, and the children's impurities and the improvement computed again after the final partition,
//! over the re-partitioned order.
//!
//! Ported from scikit-learn (BSD-3-Clause, Copyright (c) 2007-2026 The scikit-learn developers; NOTICE.md).

use crate::criterion::Criterion;
use crate::data::Error;
use crate::partition::{Partitioner, FEATURE_THRESHOLD};
use crate::rng::rand_int;
use crate::work::Ticker;

/// `SplitRecord`.
#[derive(Debug, Clone, Copy)]
pub struct SplitRecord {
    pub feature: usize,
    pub pos: usize,
    pub threshold: f64,
    pub improvement: f64,
    pub impurity_left: f64,
    pub impurity_right: f64,
    pub missing_go_to_left: bool,
}

impl SplitRecord {
    /// `_init_split(&split, start_pos)`.
    pub fn new(start_pos: usize) -> Self {
        SplitRecord { feature: 0, pos: start_pos, threshold: 0.0, improvement: f64::NEG_INFINITY, impurity_left: f64::INFINITY, impurity_right: f64::INFINITY, missing_go_to_left: false }
    }
}

/// `ParentInfo` (without the monotonic bounds: monotonic_cst isn't supported).
#[derive(Debug, Clone, Copy)]
pub struct ParentInfo {
    pub impurity: f64,
    pub n_constant_features: usize,
}

/// The fit's inputs, borrowed: X row-major float32 (n, f), y row-major float64 (n, outputs), the sample weights,
/// the missing-value mask.
#[derive(Clone, Copy)]
pub struct Inputs<'a> {
    pub x: &'a [f32],
    pub f: usize,
    pub y: &'a [f64],
    pub sample_weight: Option<&'a [f64]>,
    pub missing: Option<&'a [u8]>,
}

pub struct Splitter {
    pub criterion: Criterion,
    pub part: Partitioner,
    features: Vec<usize>,
    constant_features: Vec<usize>,
    pub max_features: usize,
    pub min_samples_leaf: usize,
    pub min_weight_leaf: f64,
    rand_r_state: u32,
    /// the positive-weight samples
    pub n_samples: usize,
    pub weighted_n_samples: f64,
    pub start: usize,
    pub end: usize,
}

fn index_vec(n: usize) -> Result<Vec<usize>, Error> {
    let mut v = Vec::new();
    v.try_reserve_exact(n).map_err(|_| Error::Memory)?;
    let mut t = Ticker::default();
    for i in 0..n {
        v.push(i);
        t.step();
    }
    t.finish();
    Ok(v)
}

impl Splitter {
    /// `Splitter.init`: the samples with a nonzero weight, in index order; the total weight of ALL samples, in index
    /// order; the features 0..f.  `seed` is the XorShift's state, `random_state.randint(0, RAND_R_MAX)` drawn by the
    /// caller as scikit-learn draws it.
    pub fn new(input: Inputs, n: usize, criterion: Criterion, max_features: usize, min_samples_leaf: usize, min_weight_leaf: f64, seed: u32) -> Result<Self, Error> {
        let mut samples = Vec::new();
        samples.try_reserve_exact(n).map_err(|_| Error::Memory)?;
        let mut weighted_n_samples = 0.0;
        let mut t = Ticker::default();
        for i in 0..n {
            // only work with positively weighted samples
            match input.sample_weight {
                None => samples.push(i),
                Some(sw) if sw[i] != 0.0 => samples.push(i),
                _ => {}
            }
            weighted_n_samples += input.sample_weight.map_or(1.0, |sw| sw[i]);
            t.step();
        }
        t.finish();
        let n_samples = samples.len();
        Ok(Splitter {
            criterion,
            part: Partitioner::new(samples)?,
            features: index_vec(input.f)?,
            constant_features: index_vec(input.f)?,
            max_features,
            min_samples_leaf,
            min_weight_leaf,
            rand_r_state: seed,
            n_samples,
            weighted_n_samples,
            start: 0,
            end: 0,
        })
    }

    /// `node_reset(start, end)`: the criterion over samples[start:end]; its total weight.
    pub fn node_reset(&mut self, input: Inputs, start: usize, end: usize) -> f64 {
        self.start = start;
        self.end = end;
        self.criterion.init(input.y, input.sample_weight, self.weighted_n_samples, &self.part.samples, start, end);
        self.criterion.weighted_n_node_samples
    }

    /// `node_split_best(...)`: the best split of samples[start:end] (pos == end: none).
    pub fn node_split(&mut self, input: Inputs, parent: &mut ParentInfo) -> SplitRecord {
        let (start, end) = (self.start, self.end);
        let n_features = input.f;
        let mut best = SplitRecord::new(end);
        let mut current = SplitRecord::new(end);
        let mut best_proxy_improvement = f64::NEG_INFINITY;
        let mut f_i = n_features;
        let mut n_visited_features = 0usize;
        // features discovered constant here, and known constant (by an ancestor) and drawn
        let mut n_found_constants = 0usize;
        let mut n_drawn_constants = 0usize;
        let n_known_constants = parent.n_constant_features;
        let mut n_total_constants = n_known_constants;
        let (y, sw) = (input.y, input.sample_weight);

        self.part.init_node_split(start, end);
        // Fisher–Yates over `features`: [0:n_drawn) drawn known constants, [n_drawn:n_known) known constants not yet
        // drawn, [n_known:n_total) newly found constants, [n_total:f_i) not drawn and not known constant, [f_i:) drawn
        while f_i > n_total_constants && (n_visited_features < self.max_features || n_visited_features <= n_found_constants + n_drawn_constants) {
            n_visited_features += 1;
            crate::work::tick(1);
            let mut f_j = rand_int(n_drawn_constants as i64, (f_i - n_found_constants) as i64, &mut self.rand_r_state) as usize;
            if f_j < n_known_constants {
                // f_j in [n_drawn_constants, n_known_constants)
                self.features.swap(n_drawn_constants, f_j);
                n_drawn_constants += 1;
                continue;
            }
            // f_j in [n_total_constants, f_i)
            f_j += n_found_constants;
            current.feature = self.features[f_j];
            self.part.sort_samples_and_feature_values(input.x, input.f, current.feature, input.missing);
            let n_missing = self.part.n_missing;
            let end_non_missing = end - n_missing;
            let fv = &self.part.feature_values;
            if end_non_missing == start || (fv[end_non_missing - 1] <= fv[start] + FEATURE_THRESHOLD && n_missing == 0) {
                // all values missing, or the feature is constant (max - min <= FEATURE_THRESHOLD): not split on
                self.features.swap(f_j, n_total_constants);
                n_found_constants += 1;
                n_total_constants += 1;
                continue;
            }
            f_i -= 1;
            self.features.swap(f_i, f_j);
            let has_missing = n_missing != 0;
            // with missing values, two searches: missing on the right (with "missing alone on the right"), then left
            let n_searches = if has_missing { 2 } else { 1 };
            for pass in 0..n_searches {
                let missing_go_to_left = pass == 1;
                if missing_go_to_left {
                    self.part.shift_missing_to_the_left();
                }
                self.criterion.reset();
                let mut p = start;
                while p < end {
                    let (p_prev, next) = self.part.next_p(p, missing_go_to_left);
                    p = next;
                    if p == end {
                        continue;
                    }
                    // reject if min_samples_leaf is not guaranteed
                    let (n_left, n_right) = (p - start, end - p);
                    if n_left < self.min_samples_leaf || n_right < self.min_samples_leaf {
                        continue;
                    }
                    current.pos = p;
                    self.criterion.update(y, sw, &self.part.samples, current.pos);
                    // reject if min_weight_leaf is not satisfied
                    if self.criterion.weighted_n_left < self.min_weight_leaf || self.criterion.weighted_n_right < self.min_weight_leaf {
                        continue;
                    }
                    let current_proxy_improvement = self.criterion.proxy_impurity_improvement(y, sw, &self.part.samples);
                    if current_proxy_improvement > best_proxy_improvement {
                        best_proxy_improvement = current_proxy_improvement;
                        let fv = &self.part.feature_values;
                        current.threshold = if p == end_non_missing && !missing_go_to_left {
                            // the right node is the missing values alone: inf, since nan <= inf is false
                            f64::INFINITY
                        } else {
                            // between two non-missing values: the sum of halves (float32 widened to float64)
                            f64::from(fv[p_prev]) / 2.0 + f64::from(fv[p]) / 2.0
                        };
                        // with no missing values in the node, missing values at predict go to the larger side
                        current.missing_go_to_left = if n_missing == 0 { n_left > n_right } else { missing_go_to_left };
                        best = current;
                    }
                }
            }
        }

        // samples[start:best.pos] + samples[best.pos:end]; then the children's impurities and the improvement from a
        // second pass over that order
        if best.pos < end {
            self.part.partition_samples_final(input.x, input.f, best.threshold, best.feature, best.missing_go_to_left);
            self.criterion.reset();
            self.criterion.update(y, sw, &self.part.samples, best.pos);
            let (impurity_left, impurity_right) = self.criterion.children_impurity(y, sw, &self.part.samples);
            best.impurity_left = impurity_left;
            best.impurity_right = impurity_right;
            best.improvement = self.criterion.impurity_improvement(parent.impurity, impurity_left, impurity_right);
        }

        // the invariant for constant features: features[:n_known_constants] keeps its order for siblings and children
        self.features[..n_known_constants].copy_from_slice(&self.constant_features[..n_known_constants]);
        // and the newly found constant features are recorded
        self.constant_features[n_known_constants..n_known_constants + n_found_constants].copy_from_slice(&self.features[n_known_constants..n_known_constants + n_found_constants]);
        parent.n_constant_features = n_total_constants;
        best
    }
}
