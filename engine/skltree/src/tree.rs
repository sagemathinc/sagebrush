//! scikit-learn's tree and its depth-first builder (sklearn 1.9.1: tree/_tree.pyx `Tree._add_node`,
//! `DepthFirstTreeBuilder.build`, `Tree._apply_dense`, `Tree.compute_feature_importances`), line by line: the stack
//! that pushes the right child before the left, the leaf tests and their order, EPSILON, each node's impurity from
//! its parent's split, the values as class fractions or means, apply's float32 value widened to float64 against the
//! threshold with NaN following missing_go_to_left, and the importances in node order.
//!
//! Memory: the node arrays are allocated once, fallibly, at a bound the tree can't exceed (`node_bound`), so a build
//! never grows them: no transient old-plus-new peak.  scikit-learn's capacity sequence changes memory, never bits.
//!
//! Ported from scikit-learn (BSD-3-Clause, Copyright (c) 2007-2026 The scikit-learn developers; NOTICE.md).

use crate::data::Error;
use crate::splitter::{Inputs, ParentInfo, SplitRecord, Splitter};
use crate::work::{tick, Ticker};

/// `_TREE_LEAF` and `_TREE_UNDEFINED`.
pub const TREE_LEAF: i64 = -1;
pub const TREE_UNDEFINED: i64 = -2;
/// `EPSILON = np.finfo('double').eps`.
const EPSILON: f64 = f64::EPSILON;

/// The tree's arrays, as `tree_` exposes them.  `value` is (node, output, class) with rows `stride` apart.
#[derive(Debug, Default)]
pub struct Tree {
    pub children_left: Vec<i64>,
    pub children_right: Vec<i64>,
    pub feature: Vec<i64>,
    pub threshold: Vec<f64>,
    pub impurity: Vec<f64>,
    pub n_node_samples: Vec<i64>,
    pub weighted_n_node_samples: Vec<f64>,
    pub missing_go_to_left: Vec<u8>,
    pub value: Vec<f64>,
    pub n_outputs: usize,
    pub stride: usize,
    pub max_depth: i64,
}

/// The most nodes a depth-first tree on `n_eff` positive-weight samples can have, under its parameters: a binary tree
/// with at most n_eff leaves (min_samples_leaf of them a leaf at least), and depth at most max_depth.
pub fn node_bound(n_eff: usize, max_depth: u64, min_samples_leaf: usize) -> usize {
    if n_eff == 0 {
        return 1;
    }
    let leaves = (n_eff / min_samples_leaf.max(1)).max(1);
    let mut bound = 2 * leaves - 1;
    if max_depth < 62 {
        bound = bound.min((1usize << (max_depth + 1)) - 1);
    }
    bound
}

fn reserve<T>(v: &mut Vec<T>, n: usize) -> Result<(), Error> {
    v.try_reserve_exact(n).map_err(|_| Error::Memory)
}

impl Tree {
    fn with_capacity(capacity: usize, n_outputs: usize, stride: usize) -> Result<Self, Error> {
        let mut t = Tree { n_outputs, stride, ..Default::default() };
        reserve(&mut t.children_left, capacity)?;
        reserve(&mut t.children_right, capacity)?;
        reserve(&mut t.feature, capacity)?;
        reserve(&mut t.threshold, capacity)?;
        reserve(&mut t.impurity, capacity)?;
        reserve(&mut t.n_node_samples, capacity)?;
        reserve(&mut t.weighted_n_node_samples, capacity)?;
        reserve(&mut t.missing_go_to_left, capacity)?;
        reserve(&mut t.value, capacity.checked_mul(n_outputs * stride).ok_or(Error::Shape)?)?;
        Ok(t)
    }

    /// The bytes its arrays hold.
    pub fn bytes(&self) -> usize {
        8 * (self.children_left.capacity() + self.children_right.capacity() + self.feature.capacity() + self.threshold.capacity() + self.impurity.capacity() + self.n_node_samples.capacity() + self.weighted_n_node_samples.capacity() + self.value.capacity()) + self.missing_go_to_left.capacity()
    }

    pub fn node_count(&self) -> usize {
        self.feature.len()
    }

    /// `_add_node(...)`: the new node's id; it registers itself as its parent's child.
    #[allow(clippy::too_many_arguments)]
    fn add_node(&mut self, parent: i64, is_left: bool, is_leaf: bool, split: &SplitRecord, impurity: f64, n_node_samples: usize, weighted_n_node_samples: f64) -> usize {
        let node_id = self.node_count();
        self.impurity.push(impurity);
        self.n_node_samples.push(n_node_samples as i64);
        self.weighted_n_node_samples.push(weighted_n_node_samples);
        if parent != TREE_UNDEFINED {
            if is_left {
                self.children_left[parent as usize] = node_id as i64;
            } else {
                self.children_right[parent as usize] = node_id as i64;
            }
        }
        if is_leaf {
            self.children_left.push(TREE_LEAF);
            self.children_right.push(TREE_LEAF);
            self.feature.push(TREE_UNDEFINED);
            self.threshold.push(TREE_UNDEFINED as f64);
            // (zeroed node memory: a leaf's missing_go_to_left is 0)
            self.missing_go_to_left.push(0);
        } else {
            // (the children are set when they are added)
            self.children_left.push(0);
            self.children_right.push(0);
            self.feature.push(split.feature as i64);
            self.threshold.push(split.threshold);
            self.missing_go_to_left.push(split.missing_go_to_left as u8);
        }
        self.value.extend(std::iter::repeat_n(0.0, self.n_outputs * self.stride));
        node_id
    }
}

/// The builder's parameters, resolved as `_classes.py:_fit` resolves them.
#[derive(Debug, Clone, Copy)]
pub struct Params {
    pub max_depth: u64,
    pub min_samples_split: usize,
    pub min_samples_leaf: usize,
    pub min_weight_leaf: f64,
    pub min_impurity_decrease: f64,
}

struct StackRecord {
    start: usize,
    end: usize,
    depth: u64,
    parent: i64,
    is_left: bool,
    impurity: f64,
    n_constant_features: usize,
}

/// `DepthFirstTreeBuilder.build(tree, X, y, sample_weight, missing_values_in_feature_mask)`.
pub fn build(input: Inputs, splitter: &mut Splitter, p: &Params) -> Result<Tree, Error> {
    let capacity = node_bound(splitter.n_samples, p.max_depth, p.min_samples_leaf);
    let mut tree = Tree::with_capacity(capacity, splitter.criterion.n_outputs, splitter.criterion.stride)?;
    let mut stack: Vec<StackRecord> = Vec::new();
    // (a depth-first stack holds at most one pending sibling a level, and the root)
    reserve(&mut stack, (p.max_depth.min(splitter.n_samples as u64) as usize).saturating_add(2).min(capacity + 1))?;
    stack.push(StackRecord { start: 0, end: splitter.n_samples, depth: 0, parent: TREE_UNDEFINED, is_left: false, impurity: f64::INFINITY, n_constant_features: 0 });
    let mut parent_record = ParentInfo { impurity: f64::INFINITY, n_constant_features: 0 };
    let mut split = SplitRecord::new(0);
    let mut first = true;
    let mut max_depth_seen: i64 = -1;
    while let Some(r) = stack.pop() {
        tick(1);
        parent_record.impurity = r.impurity;
        parent_record.n_constant_features = r.n_constant_features;
        let n_node_samples = r.end - r.start;
        let weighted_n_node_samples = splitter.node_reset(input, r.start, r.end);
        let mut is_leaf = r.depth >= p.max_depth
            || n_node_samples < p.min_samples_split
            || n_node_samples < 2 * p.min_samples_leaf
            || weighted_n_node_samples < 2.0 * p.min_weight_leaf;
        if first {
            parent_record.impurity = splitter.criterion.node_impurity();
            first = false;
        }
        // impurity == 0 with tolerance due to rounding errors
        is_leaf = is_leaf || parent_record.impurity <= EPSILON;
        if !is_leaf {
            split = splitter.node_split(input, &mut parent_record);
            is_leaf = is_leaf || split.pos >= r.end || split.improvement + EPSILON < p.min_impurity_decrease;
        }
        if tree.node_count() >= capacity {
            // (the bound is a proof, not a guess: reaching it is a bug)
            return Err(Error::State);
        }
        let node_id = tree.add_node(r.parent, r.is_left, is_leaf, &split, parent_record.impurity, n_node_samples, weighted_n_node_samples);
        // the value of every node, for inspection and interpretation
        let s = tree.n_outputs * tree.stride;
        splitter.criterion.node_value(&mut tree.value[node_id * s..(node_id + 1) * s]);
        if !is_leaf {
            // the right child first, then the left: the left is built first
            stack.push(StackRecord { start: split.pos, end: r.end, depth: r.depth + 1, parent: node_id as i64, is_left: false, impurity: split.impurity_right, n_constant_features: parent_record.n_constant_features });
            stack.push(StackRecord { start: r.start, end: split.pos, depth: r.depth + 1, parent: node_id as i64, is_left: true, impurity: split.impurity_left, n_constant_features: parent_record.n_constant_features });
        }
        if r.depth as i64 > max_depth_seen {
            max_depth_seen = r.depth as i64;
        }
    }
    tree.max_depth = max_depth_seen;
    Ok(tree)
}

/// `_apply_dense(X)`: each row's leaf.  X row-major float32 with f features; a float32 value widened to float64 is
/// compared `<=` with the float64 threshold; NaN follows missing_go_to_left.
pub fn apply(tree: &Tree, x: &[f32], f: usize, out: &mut [i64]) {
    let mut t = Ticker::default();
    for (i, o) in out.iter_mut().enumerate() {
        let mut node = 0usize;
        while tree.children_left[node] != TREE_LEAF {
            let v = x[i * f + tree.feature[node] as usize];
            node = if v.is_nan() {
                if tree.missing_go_to_left[node] != 0 {
                    tree.children_left[node] as usize
                } else {
                    tree.children_right[node] as usize
                }
            } else if f64::from(v) <= tree.threshold[node] {
                tree.children_left[node] as usize
            } else {
                tree.children_right[node] as usize
            };
            t.step();
        }
        *o = node as i64;
        t.step();
    }
    t.finish();
}

/// `compute_feature_importances(normalize=False)` then the division by the root's weight: each split's weighted
/// impurity decrease added to its feature in node order, each entry divided by the root's weighted_n_node_samples.
/// (The normalization, `/ np.sum`, is Python's, on its numpy: NumPy's pairwise sum.)
pub fn importances(tree: &Tree, n_features: usize) -> Result<Vec<f64>, Error> {
    let mut imp = Vec::new();
    reserve(&mut imp, n_features)?;
    imp.resize(n_features, 0.0);
    let mut t = Ticker::default();
    for node in 0..tree.node_count() {
        if tree.children_left[node] != TREE_LEAF {
            let (l, r) = (tree.children_left[node] as usize, tree.children_right[node] as usize);
            imp[tree.feature[node] as usize] += tree.weighted_n_node_samples[node] * tree.impurity[node] - tree.weighted_n_node_samples[l] * tree.impurity[l] - tree.weighted_n_node_samples[r] * tree.impurity[r];
        }
        t.step();
    }
    for v in imp.iter_mut() {
        *v /= tree.weighted_n_node_samples[0];
        t.step();
    }
    t.finish();
    Ok(imp)
}
