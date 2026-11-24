//! scikit-learn's split criteria (sklearn 1.9.1: tree/_criterion.pyx), line by line: `ClassificationCriterion`
//! with `Gini` and `Entropy` (log_loss is Entropy), and `RegressionCriterion` with `MSE` (squared_error).  The
//! sums run in the order of the samples as the partitioner leaves them, the forward or reverse `update` is chosen as
//! scikit-learn chooses it, and every expression keeps scikit-learn's order of operations: these decide the split
//! and the bits of every impurity, value and improvement.  Entropy's logarithm is glibc's (engine/glibm), as
//! CPython's compiled scikit-learn calls it.
//!
//! Ported from scikit-learn (BSD-3-Clause, Copyright (c) 2007-2026 The scikit-learn developers; NOTICE.md).

use crate::data::Error;
use crate::work::Ticker;

/// Which criterion (`criterion=`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Gini,
    /// `entropy` and `log_loss`
    Entropy,
    /// `squared_error`
    Mse,
}

/// `log(x) = ln(x) / ln(2.0)` (tree/_utils.pyx), with glibc's ln.
#[inline]
fn log(x: f64) -> f64 {
    sagebrush_glibm::log(x) / sagebrush_glibm::log(2.0)
}

/// A criterion's state over one fit.  y is row-major (n_samples, n_outputs); for a classifier it holds class
/// indices.  The sums are (n_outputs, stride): stride is max_n_classes for a classifier, 1 for a regressor.
pub struct Criterion {
    pub kind: Kind,
    pub n_outputs: usize,
    pub n_classes: Vec<usize>,
    pub stride: usize,
    sum_total: Vec<f64>,
    sum_left: Vec<f64>,
    sum_right: Vec<f64>,
    sq_sum_total: f64,
    pub weighted_n_samples: f64,
    pub weighted_n_node_samples: f64,
    pub weighted_n_left: f64,
    pub weighted_n_right: f64,
    pub start: usize,
    pub pos: usize,
    pub end: usize,
}

fn zeros(n: usize) -> Result<Vec<f64>, Error> {
    let mut v = Vec::new();
    v.try_reserve_exact(n).map_err(|_| Error::Memory)?;
    crate::work::chunks(n, |lo, hi| {
        v.extend(std::iter::repeat_n(0.0, hi - lo));
        Ok(())
    })?;
    Ok(v)
}

impl Criterion {
    /// A classification criterion (Gini or Entropy) for `n_classes` per output, or a regression one (Mse, `n_classes`
    /// ignored) for `n_outputs`.
    pub fn new(kind: Kind, n_outputs: usize, n_classes: &[usize]) -> Result<Self, Error> {
        let stride = if kind == Kind::Mse { 1 } else { n_classes.iter().copied().max().unwrap_or(0) };
        let n = n_outputs.checked_mul(stride).ok_or(Error::Shape)?;
        Ok(Criterion {
            kind,
            n_outputs,
            n_classes: if kind == Kind::Mse { vec![1; n_outputs] } else { n_classes.to_vec() },
            stride,
            sum_total: zeros(n)?,
            sum_left: zeros(n)?,
            sum_right: zeros(n)?,
            sq_sum_total: 0.0,
            weighted_n_samples: 0.0,
            weighted_n_node_samples: 0.0,
            weighted_n_left: 0.0,
            weighted_n_right: 0.0,
            start: 0,
            pos: 0,
            end: 0,
        })
    }

    #[inline]
    fn classify(&self) -> bool {
        self.kind != Kind::Mse
    }

    /// `init(y, sample_weight, weighted_n_samples, sample_indices, start, end)`: the node's totals, then `reset`.
    pub fn init(&mut self, y: &[f64], sample_weight: Option<&[f64]>, weighted_n_samples: f64, samples: &[usize], start: usize, end: usize) {
        self.start = start;
        self.end = end;
        self.weighted_n_samples = weighted_n_samples;
        self.weighted_n_node_samples = 0.0;
        let o = self.n_outputs;
        let mut t = Ticker::default();
        let mut w = 1.0;
        if self.classify() {
            for k in 0..o {
                for c in 0..self.n_classes[k] {
                    self.sum_total[k * self.stride + c] = 0.0;
                    t.step();
                }
            }
            for &i in &samples[start..end] {
                if let Some(sw) = sample_weight {
                    w = sw[i];
                }
                for k in 0..o {
                    let c = y[i * o + k] as usize;
                    self.sum_total[k * self.stride + c] += w;
                    t.step();
                }
                self.weighted_n_node_samples += w;
            }
        } else {
            self.sq_sum_total = 0.0;
            for k in 0..o {
                self.sum_total[k] = 0.0;
            }
            for &i in &samples[start..end] {
                if let Some(sw) = sample_weight {
                    w = sw[i];
                }
                for k in 0..o {
                    let y_ik = y[i * o + k];
                    let w_y_ik = w * y_ik;
                    self.sum_total[k] += w_y_ik;
                    self.sq_sum_total += w_y_ik * y_ik;
                    t.step();
                }
                self.weighted_n_node_samples += w;
            }
        }
        t.finish();
        self.reset();
    }

    /// `_move_sums_*`: sum_1 := 0, sum_2 := sum_total, per output over its classes.
    fn move_sums(&mut self, to_right: bool) {
        let mut t = Ticker::default();
        for k in 0..self.n_outputs {
            for c in 0..self.n_classes[k] {
                let j = k * self.stride + c;
                let total = self.sum_total[j];
                if to_right {
                    self.sum_left[j] = 0.0;
                    self.sum_right[j] = total;
                } else {
                    self.sum_right[j] = 0.0;
                    self.sum_left[j] = total;
                }
                t.step();
            }
        }
        t.finish();
        if to_right {
            self.weighted_n_left = 0.0;
            self.weighted_n_right = self.weighted_n_node_samples;
        } else {
            self.weighted_n_right = 0.0;
            self.weighted_n_left = self.weighted_n_node_samples;
        }
    }

    /// `reset()`: pos = start, everything on the right.
    pub fn reset(&mut self) {
        self.pos = self.start;
        self.move_sums(true);
    }

    /// `reverse_reset()`: pos = end, everything on the left.
    pub fn reverse_reset(&mut self) {
        self.pos = self.end;
        self.move_sums(false);
    }

    /// `update(new_pos)`: samples[pos:new_pos] move to the left, forward from pos or backward from the end, whichever
    /// is shorter, as scikit-learn chooses; then the right side is total - left.
    pub fn update(&mut self, y: &[f64], sample_weight: Option<&[f64]>, samples: &[usize], new_pos: usize) {
        let pos = self.pos;
        let o = self.n_outputs;
        let mut t = Ticker::default();
        let mut w = 1.0;
        if new_pos - pos <= self.end - new_pos {
            for &i in &samples[pos..new_pos] {
                if let Some(sw) = sample_weight {
                    w = sw[i];
                }
                for k in 0..o {
                    let j = if self.classify() { k * self.stride + y[i * o + k] as usize } else { k };
                    if self.classify() {
                        self.sum_left[j] += w;
                    } else {
                        self.sum_left[j] += w * y[i * o + k];
                    }
                    t.step();
                }
                self.weighted_n_left += w;
            }
        } else {
            self.reverse_reset();
            for p in (new_pos..self.end).rev() {
                let i = samples[p];
                if let Some(sw) = sample_weight {
                    w = sw[i];
                }
                for k in 0..o {
                    let j = if self.classify() { k * self.stride + y[i * o + k] as usize } else { k };
                    if self.classify() {
                        self.sum_left[j] -= w;
                    } else {
                        self.sum_left[j] -= w * y[i * o + k];
                    }
                    t.step();
                }
                self.weighted_n_left -= w;
            }
        }
        self.weighted_n_right = self.weighted_n_node_samples - self.weighted_n_left;
        for k in 0..o {
            for c in 0..self.n_classes[k] {
                let j = k * self.stride + c;
                self.sum_right[j] = self.sum_total[j] - self.sum_left[j];
                t.step();
            }
        }
        t.finish();
        self.pos = new_pos;
    }

    /// Gini's or Entropy's impurity of one side's sums and weight.
    fn class_impurity(&self, sums: &[f64], weight: f64) -> f64 {
        let mut total = 0.0;
        let mut t = Ticker::default();
        for k in 0..self.n_outputs {
            let row = &sums[k * self.stride..];
            match self.kind {
                Kind::Gini => {
                    let mut sq_count = 0.0;
                    for &count_k in &row[..self.n_classes[k]] {
                        sq_count += count_k * count_k;
                        t.step();
                    }
                    total += 1.0 - sq_count / (weight * weight);
                }
                Kind::Entropy => {
                    for &count in &row[..self.n_classes[k]] {
                        // (empty classes are skipped: 0 log 0 would be NaN)
                        if count > 0.0 {
                            let count_k = count / weight;
                            total -= count_k * log(count_k);
                        }
                        t.step();
                    }
                }
                Kind::Mse => unreachable!(),
            }
        }
        t.finish();
        total / self.n_outputs as f64
    }

    /// `node_impurity()`: the impurity of samples[start:end].
    pub fn node_impurity(&self) -> f64 {
        match self.kind {
            Kind::Gini | Kind::Entropy => self.class_impurity(&self.sum_total, self.weighted_n_node_samples),
            Kind::Mse => {
                let mut impurity = self.sq_sum_total / self.weighted_n_node_samples;
                for k in 0..self.n_outputs {
                    // (`(x)**2.0`: pow(x, 2.0), correctly rounded, which is x*x)
                    let m = self.sum_total[k] / self.weighted_n_node_samples;
                    impurity -= m * m;
                }
                impurity / self.n_outputs as f64
            }
        }
    }

    /// `children_impurity()`: the left (samples[start:pos]) and right (samples[pos:end]) impurities.
    pub fn children_impurity(&self, y: &[f64], sample_weight: Option<&[f64]>, samples: &[usize]) -> (f64, f64) {
        match self.kind {
            Kind::Gini | Kind::Entropy => (self.class_impurity(&self.sum_left, self.weighted_n_left), self.class_impurity(&self.sum_right, self.weighted_n_right)),
            Kind::Mse => {
                let o = self.n_outputs;
                let mut sq_sum_left = 0.0;
                let mut w = 1.0;
                let mut t = Ticker::default();
                for &i in &samples[self.start..self.pos] {
                    if let Some(sw) = sample_weight {
                        w = sw[i];
                    }
                    for k in 0..o {
                        let y_ik = y[i * o + k];
                        sq_sum_left += w * y_ik * y_ik;
                        t.step();
                    }
                }
                t.finish();
                let sq_sum_right = self.sq_sum_total - sq_sum_left;
                let mut left = sq_sum_left / self.weighted_n_left;
                let mut right = sq_sum_right / self.weighted_n_right;
                for k in 0..o {
                    let l = self.sum_left[k] / self.weighted_n_left;
                    left -= l * l;
                    let r = self.sum_right[k] / self.weighted_n_right;
                    right -= r * r;
                }
                (left / o as f64, right / o as f64)
            }
        }
    }

    /// `proxy_impurity_improvement()`: what the split search maximizes.
    pub fn proxy_impurity_improvement(&self, y: &[f64], sample_weight: Option<&[f64]>, samples: &[usize]) -> f64 {
        match self.kind {
            Kind::Gini | Kind::Entropy => {
                let (impurity_left, impurity_right) = self.children_impurity(y, sample_weight, samples);
                -self.weighted_n_right * impurity_right - self.weighted_n_left * impurity_left
            }
            Kind::Mse => {
                let (mut proxy_left, mut proxy_right) = (0.0, 0.0);
                for k in 0..self.n_outputs {
                    proxy_left += self.sum_left[k] * self.sum_left[k];
                    proxy_right += self.sum_right[k] * self.sum_right[k];
                }
                proxy_left / self.weighted_n_left + proxy_right / self.weighted_n_right
            }
        }
    }

    /// `impurity_improvement(impurity_parent, impurity_left, impurity_right)`.
    pub fn impurity_improvement(&self, impurity_parent: f64, impurity_left: f64, impurity_right: f64) -> f64 {
        (self.weighted_n_node_samples / self.weighted_n_samples)
            * (impurity_parent - (self.weighted_n_right / self.weighted_n_node_samples * impurity_right) - (self.weighted_n_left / self.weighted_n_node_samples * impurity_left))
    }

    /// `node_value(dest)`: the class fractions per output (dest's rows `stride` apart), or the means.
    pub fn node_value(&self, dest: &mut [f64]) {
        let mut t = Ticker::default();
        for k in 0..self.n_outputs {
            for c in 0..self.n_classes[k] {
                dest[k * self.stride + c] = self.sum_total[k * self.stride + c] / self.weighted_n_node_samples;
                t.step();
            }
        }
        t.finish();
    }
}
