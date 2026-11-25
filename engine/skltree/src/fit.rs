//! One tree's fit on a sealed dataset: the kernel's own checks of what Python resolved (the class indices, the
//! weights, the parameters), then scikit-learn's builder (tree.rs) and the raw importances.  Every check is the
//! kernel's own, so nothing reaches the builder unchecked: the Python side checks first, with scikit-learn's
//! messages; these are the backstop, an error code, never a trap.

use crate::criterion::{Criterion, Kind};
use crate::data::{Dataset, Error};
use crate::splitter::{Inputs, Splitter};
use crate::tree::{build, importances, Params, Tree};
use crate::work::Ticker;

/// The parameters as `_classes.py:_fit` resolves them (max_depth None is 2^31 - 1).
#[derive(Debug, Clone, Copy)]
pub struct FitParams {
    pub kind: Kind,
    pub max_depth: u64,
    pub min_samples_split: usize,
    pub min_samples_leaf: usize,
    pub min_weight_leaf: f64,
    pub max_features: usize,
    pub min_impurity_decrease: f64,
    pub seed: u32,
}

/// A fitted tree and its raw importances (each split's weighted impurity decrease, in node order, over the root's
/// weight; Python normalizes with np.sum).  `detail` gets (row, column) of a refused input.
pub fn fit(d: &Dataset, sample_weight: Option<&[f64]>, n_classes: &[usize], p: &FitParams, detail: &mut (u64, u64)) -> Result<(Tree, Vec<f64>), Error> {
    let o = d.outputs;
    let classify = p.kind != Kind::Mse;
    if p.max_features == 0 || p.max_features > d.f || p.min_samples_leaf == 0 || p.min_samples_split < 2 || !p.min_weight_leaf.is_finite() || !p.min_impurity_decrease.is_finite() {
        return Err(Error::Params);
    }
    if classify {
        if n_classes.len() != o || n_classes.contains(&0) {
            return Err(Error::Params);
        }
        // every y a class index of its output
        let mut t = Ticker::default();
        for (j, &v) in d.y.iter().enumerate() {
            let k = j % o;
            if !(v >= 0.0 && v.fract() == 0.0 && (v as usize) < n_classes[k]) {
                *detail = ((j / o) as u64, k as u64);
                return Err(Error::Labels);
            }
            t.step();
        }
        t.finish();
    }
    if let Some(sw) = sample_weight {
        if sw.len() != d.n {
            return Err(Error::Shape);
        }
        let mut t = Ticker::default();
        for (i, &w) in sw.iter().enumerate() {
            if !w.is_finite() {
                *detail = (i as u64, 0);
                return Err(Error::Weights);
            }
            t.step();
        }
        t.finish();
        // (no positive-weight sample: scikit-learn's Python refuses first; here, nothing to grow)
        if sw.iter().all(|&w| w == 0.0) {
            return Err(Error::Weights);
        }
    }
    let input = Inputs { x: &d.x, f: d.f, y: &d.y, sample_weight, missing: d.mask.as_deref() };
    let criterion = Criterion::new(p.kind, o, n_classes)?;
    let mut splitter = Splitter::new(input, d.n, criterion, p.max_features, p.min_samples_leaf, p.min_weight_leaf, p.seed)?;
    let params = Params { max_depth: p.max_depth, min_samples_split: p.min_samples_split, min_samples_leaf: p.min_samples_leaf, min_weight_leaf: p.min_weight_leaf, min_impurity_decrease: p.min_impurity_decrease };
    let tree = build(input, &mut splitter, &params)?;
    let imp = importances(&tree, d.f)?;
    Ok((tree, imp))
}

/// The bytes a fit may allocate beyond the dataset, for the host's admission: the weights' copy, the splitter's
/// buffers, the criterion's sums, the class counts (one an output, twice: as the export reads them and the
/// criterion's copy), the builder's stack and the tree at its bound (each node 57 bytes of arrays and 8 a value),
/// the importances.  An upper bound: n stands for the positive-weight samples.  (usize counted at 8 bytes)
pub fn fit_bytes(n: u64, f: u64, n_outputs: u64, stride: u64, max_depth: u64, min_samples_leaf: u64) -> Option<u64> {
    let s = n_outputs.checked_mul(stride)?;
    let nodes = crate::tree::node_bound(usize::try_from(n).ok()?, max_depth, usize::try_from(min_samples_leaf).ok()?) as u64;
    let per_node = 57u64.checked_add(s.checked_mul(8)?)?;
    let sw = n.checked_mul(8)?;
    // samples 8n, feature_values 4n, the swap buffers 8n + 4n
    let splitter = n.checked_mul(24)?.checked_add(f.checked_mul(16)?)?;
    let criterion = s.checked_mul(24)?.checked_add(n_outputs.checked_mul(16)?)?;
    let stack = (max_depth.min(n) + 2).checked_mul(64)?;
    let tree = nodes.checked_mul(per_node)?;
    sw.checked_add(splitter)?.checked_add(criterion)?.checked_add(stack)?.checked_add(tree)?.checked_add(f.checked_mul(8)?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::data::Table;

    fn ds(t: &mut Table, x: &[f32], y: &[f64], n: usize, f: usize) -> u32 {
        let h = t.create(n, f, y.len() / n, false).unwrap();
        let d = t.open(h).unwrap();
        d.x.copy_from_slice(x);
        d.y.copy_from_slice(y);
        t.seal(h).unwrap();
        h
    }

    fn params(kind: Kind) -> FitParams {
        FitParams { kind, max_depth: 1 << 31, min_samples_split: 2, min_samples_leaf: 1, min_weight_leaf: 0.0, max_features: 1, min_impurity_decrease: 0.0, seed: 1 }
    }

    #[test]
    fn a_fit_checks_what_python_resolved() {
        let _g = crate::work::tests_serial();
        let mut t = Table::default();
        let h = ds(&mut t, &[0.0, 1.0, 2.0, 3.0], &[0.0, 1.0, 1.0, 2.0], 4, 1);
        let h2 = ds(&mut t, &[0.0, 1.0], &[0.5, 1.0], 2, 1);
        let d = t.get(h).unwrap();
        let mut det = (0, 0);
        // a label past its output's class count; one that isn't an integer
        assert_eq!(fit(d, None, &[2], &params(Kind::Gini), &mut det).unwrap_err(), Error::Labels);
        assert_eq!(det, (3, 0));
        assert_eq!(fit(d, None, &[3], &params(Kind::Gini), &mut det).map(|r| r.0.node_count()).unwrap(), 5);
        assert_eq!(fit(t.get(h2).unwrap(), None, &[2], &params(Kind::Gini), &mut det).unwrap_err(), Error::Labels);
        // n_classes per output; parameters out of range; weights not finite, all zero, the wrong length
        assert_eq!(fit(d, None, &[3, 3], &params(Kind::Gini), &mut det).unwrap_err(), Error::Params);
        assert_eq!(fit(d, None, &[3], &FitParams { max_features: 2, ..params(Kind::Gini) }, &mut det).unwrap_err(), Error::Params);
        assert_eq!(fit(d, None, &[3], &FitParams { min_samples_split: 1, ..params(Kind::Gini) }, &mut det).unwrap_err(), Error::Params);
        assert_eq!(fit(d, Some(&[1.0, f64::NAN, 1.0, 1.0]), &[3], &params(Kind::Gini), &mut det).unwrap_err(), Error::Weights);
        assert_eq!(fit(d, Some(&[0.0; 4]), &[3], &params(Kind::Gini), &mut det).unwrap_err(), Error::Weights);
        assert_eq!(fit(d, Some(&[1.0; 3]), &[3], &params(Kind::Gini), &mut det).unwrap_err(), Error::Shape);
        // a regressor ignores n_classes and takes any finite y
        assert_eq!(fit(d, None, &[], &params(Kind::Mse), &mut det).map(|r| r.1.len()).unwrap(), 1);
    }

    #[test]
    fn the_admitted_bytes_bound_what_a_fit_holds() {
        // (checked arithmetic: an overflowing shape is None, refused, never wrapped)
        assert!(fit_bytes(u64::MAX / 2, 3, 1, 1, 10, 1).is_none());
        assert!(fit_bytes(1000, 10, 1 << 40, 1 << 40, 10, 1).is_none());
        let b = fit_bytes(1000, 10, 1, 3, u64::from(u32::MAX), 1).unwrap();
        // 1999 nodes at 57 + 24 bytes, the buffers, the weights
        assert!(b >= 1999 * 81 + 1000 * 32);
    }
}
