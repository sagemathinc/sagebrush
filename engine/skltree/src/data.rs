//! Datasets: X, y and the missing-value mask, handed over once and kept by
//! handle (design note sklearn-trees r3 §3).
//!
//! The host makes a dataset in three steps: [`Table::create`] allocates its
//! three buffers (fallibly: a refused allocation is [`Error::Memory`], never a
//! trap) and returns a handle; the host copies the arrays straight into them
//! (no staging copy); [`Table::seal`] then checks what was copied before any
//! tree may use it.  A dataset no tree may use yet is "open".
//!
//! Handles are never reused within an instance: a handle the host kept after
//! [`Table::release`] names nothing, and every use of it is
//! [`Error::Handle`].  (Across instances, the host's generations tell a stale
//! dataset apart: src/runtime/skltree.ts.)

use crate::work::chunks;
use std::collections::BTreeMap;

/// A call's failure, as the export returns it (negative).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Error {
    /// A dimension is 0, or a size overflows usize.
    Shape = -1,
    /// The heap refused an allocation (its page bound: engine/wasmheap).
    Memory = -2,
    /// X holds a NaN in a column the mask says has none (detail: row, column).
    NanInX = -3,
    /// X holds an infinity (detail: row, column).
    InfInX = -4,
    /// y holds a NaN or an infinity (detail: row, output).
    NonFiniteY = -5,
    /// No such dataset (never made, released, or the handles ran out).
    Handle = -6,
    /// The dataset is sealed already, or not yet sealed where it must be.
    State = -7,
    /// A mask entry is neither 0 nor 1 (detail: 0, column).
    Mask = -8,
    /// A fit's parameters are out of range (max_features, min_samples_*, n_classes for the outputs).
    Params = -9,
    /// A classifier's y holds something other than a class index of its output (detail: row, output).
    Labels = -10,
    /// A sample weight isn't finite (detail: row), or every weight is zero.
    Weights = -11,
}

/// One dataset: n samples of f features (X, row-major float32), their
/// outputs (y, row-major float64), and the missing-value mask (one byte a
/// feature, 1 where the column may hold NaN), or none when no column may.
#[derive(Debug)]
pub struct Dataset {
    pub n: usize,
    pub f: usize,
    pub outputs: usize,
    pub x: Vec<f32>,
    pub y: Vec<f64>,
    pub mask: Option<Vec<u8>>,
    pub sealed: bool,
}

impl Dataset {
    /// The bytes its buffers hold.
    pub fn bytes(&self) -> usize {
        self.x.capacity() * 4 + self.y.capacity() * 8 + self.mask.as_ref().map_or(0, |m| m.capacity())
    }
}

/// What a handle names: a dataset, a buffer (a fit's weights or class counts, copied in) or a fitted tree with its
/// raw importances (until copied out).
#[derive(Debug)]
enum Item {
    Set(Dataset),
    Buf(Vec<f64>),
    Tree(crate::tree::Tree, Vec<f64>),
}

/// The instance's datasets, buffers and fitted trees, by handle.  Handles come from one counter, never reused, and
/// a handle of one kind names nothing of another ([`Error::Handle`]).  (One map, not one a kind: each map's code is
/// generated again for its kind, and three were about 15 KB of the module.)
#[derive(Debug, Default)]
pub struct Table {
    items: BTreeMap<u32, Item>,
    next: u32,
    /// A failure's detail: (row, column or output).
    pub detail: (u64, u64),
}

/// A buffer of `len` zeros, allocated fallibly and filled in polled chunks
/// (a fill is a data-sized loop like any other: work::tick).
fn zeros<T: Copy + Default>(len: usize) -> Result<Vec<T>, Error> {
    let mut v: Vec<T> = Vec::new();
    v.try_reserve_exact(len).map_err(|_| Error::Memory)?;
    chunks(len, |lo, hi| {
        v.extend(std::iter::repeat_n(T::default(), hi - lo));
        Ok(())
    })?;
    Ok(v)
}

impl Table {
    /// Remove what `h` names if `kind` accepts it (a handle of another kind is left alone).
    fn take(&mut self, h: u32, kind: fn(&Item) -> bool) -> Option<Item> {
        if self.items.get(&h).is_some_and(kind) {
            self.items.remove(&h)
        } else {
            None
        }
    }

    fn next_handle(&mut self) -> Result<u32, Error> {
        // (a handle is returned as a positive i32)
        let h = self.next.checked_add(1).filter(|&h| h <= i32::MAX as u32).ok_or(Error::Handle)?;
        self.next = h;
        Ok(h)
    }

    /// A buffer of `len` float64 zeros (allocated fallibly, filled in polled chunks): its handle.
    pub fn buffer(&mut self, len: usize) -> Result<u32, Error> {
        len.checked_mul(8).ok_or(Error::Shape)?;
        let v = zeros::<f64>(len)?;
        let h = self.next_handle()?;
        self.items.insert(h, Item::Buf(v));
        Ok(h)
    }

    pub fn buffer_mut(&mut self, h: u32) -> Result<&mut Vec<f64>, Error> {
        match self.items.get_mut(&h) {
            Some(Item::Buf(b)) => Ok(b),
            _ => Err(Error::Handle),
        }
    }

    pub fn buffer_take(&mut self, h: u32) -> Result<Vec<f64>, Error> {
        match self.take(h, |i| matches!(i, Item::Buf(_))) {
            Some(Item::Buf(b)) => Ok(b),
            _ => Err(Error::Handle),
        }
    }

    /// Keep a fitted tree and its raw importances until the host has copied them out: its handle.
    pub fn put_tree(&mut self, tree: crate::tree::Tree, importances: Vec<f64>) -> Result<u32, Error> {
        let h = self.next_handle()?;
        self.items.insert(h, Item::Tree(tree, importances));
        Ok(h)
    }

    pub fn tree(&self, h: u32) -> Result<(&crate::tree::Tree, &Vec<f64>), Error> {
        match self.items.get(&h) {
            Some(Item::Tree(t, imp)) => Ok((t, imp)),
            _ => Err(Error::Handle),
        }
    }

    pub fn release_tree(&mut self, h: u32) -> bool {
        self.take(h, |i| matches!(i, Item::Tree(..))).is_some()
    }

    /// Make an open dataset of n samples, f features and `outputs` outputs
    /// (with a mask when `masked`): its handle (at least 1).
    pub fn create(&mut self, n: usize, f: usize, outputs: usize, masked: bool) -> Result<u32, Error> {
        if n == 0 || f == 0 || outputs == 0 {
            return Err(Error::Shape);
        }
        let nx = n.checked_mul(f).ok_or(Error::Shape)?;
        let ny = n.checked_mul(outputs).ok_or(Error::Shape)?;
        // (and their byte counts: a buffer's bytes must fit usize too)
        nx.checked_mul(4).ok_or(Error::Shape)?;
        ny.checked_mul(8).ok_or(Error::Shape)?;
        let x = zeros::<f32>(nx)?;
        let y = zeros::<f64>(ny)?;
        let mask = if masked { Some(zeros::<u8>(f)?) } else { None };
        let handle = self.next_handle()?;
        self.items.insert(handle, Item::Set(Dataset { n, f, outputs, x, y, mask, sealed: false }));
        Ok(handle)
    }

    /// An open dataset, for the host's copy into its buffers.
    pub fn open(&mut self, h: u32) -> Result<&mut Dataset, Error> {
        let Some(Item::Set(d)) = self.items.get_mut(&h) else {
            return Err(Error::Handle);
        };
        if d.sealed {
            return Err(Error::State);
        }
        Ok(d)
    }

    /// A sealed dataset, for the trees.
    pub fn get(&self, h: u32) -> Result<&Dataset, Error> {
        let Some(Item::Set(d)) = self.items.get(&h) else {
            return Err(Error::Handle);
        };
        if !d.sealed {
            return Err(Error::State);
        }
        Ok(d)
    }

    /// Check an open dataset and seal it, as scikit-learn's fit checks its
    /// input before any tree is grown: the mask's entries are 0 or 1; X has no
    /// infinity, and a NaN only in a column the mask marks; y is finite.  The
    /// host's Python checks these first, with scikit-learn's messages; these
    /// are the kernel's own, so nothing reaches a tree unchecked.
    pub fn seal(&mut self, h: u32) -> Result<(), Error> {
        let mut detail = (0u64, 0u64);
        let r = self.check(h, &mut detail);
        self.detail = detail;
        r?;
        self.open(h)?.sealed = true;
        Ok(())
    }

    fn check(&mut self, h: u32, detail: &mut (u64, u64)) -> Result<(), Error> {
        let d = self.open(h)?;
        let f = d.f;
        if let Some(m) = &d.mask {
            chunks(m.len(), |lo, hi| match m[lo..hi].iter().position(|&b| b > 1) {
                Some(j) => {
                    *detail = (0, (lo + j) as u64);
                    Err(Error::Mask)
                }
                None => Ok(()),
            })?;
        }
        let mask = d.mask.as_deref();
        chunks(d.x.len(), |lo, hi| {
            for (k, v) in d.x[lo..hi].iter().enumerate() {
                if v.is_finite() {
                    continue;
                }
                let at = lo + k;
                *detail = ((at / f) as u64, (at % f) as u64);
                if v.is_infinite() {
                    return Err(Error::InfInX);
                }
                if !mask.is_some_and(|m| m[at % f] == 1) {
                    return Err(Error::NanInX);
                }
            }
            Ok(())
        })?;
        let outputs = d.outputs;
        chunks(d.y.len(), |lo, hi| match d.y[lo..hi].iter().position(|v| !v.is_finite()) {
            Some(k) => {
                *detail = (((lo + k) / outputs) as u64, ((lo + k) % outputs) as u64);
                Err(Error::NonFiniteY)
            }
            None => Ok(()),
        })
    }

    /// Release a dataset: its memory back to the heap.  Whether it existed.
    pub fn release(&mut self, h: u32) -> bool {
        self.take(h, |i| matches!(i, Item::Set(_))).is_some()
    }

    /// The bytes every live dataset, buffer and tree holds (for the host's tests).
    pub fn live_bytes(&self) -> usize {
        self.items
            .values()
            .map(|item| match item {
                Item::Set(d) => d.bytes(),
                Item::Buf(b) => b.capacity() * 8,
                Item::Tree(t, imp) => t.bytes() + imp.capacity() * 8,
            })
            .sum()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn filled(t: &mut Table, x: &[f32], y: &[f64], n: usize, f: usize, mask: Option<&[u8]>) -> u32 {
        let h = t.create(n, f, y.len() / n, mask.is_some()).unwrap();
        let d = t.open(h).unwrap();
        d.x.copy_from_slice(x);
        d.y.copy_from_slice(y);
        if let Some(m) = mask {
            d.mask.as_mut().unwrap().copy_from_slice(m);
        }
        h
    }

    #[test]
    fn shapes_are_checked_before_anything_is_allocated() {
        let _g = crate::work::tests_serial();
        let mut t = Table::default();
        assert_eq!(t.create(0, 3, 1, false), Err(Error::Shape));
        assert_eq!(t.create(3, 0, 1, false), Err(Error::Shape));
        assert_eq!(t.create(3, 3, 0, false), Err(Error::Shape));
        assert_eq!(t.create(usize::MAX / 2, 3, 1, false), Err(Error::Shape));
        // (the byte counts overflow, not the element counts)
        assert_eq!(t.create(usize::MAX / 4 + 1, 1, 1, false), Err(Error::Shape));
        assert_eq!(t.create(1, 1, usize::MAX / 8 + 1, false), Err(Error::Shape));
        assert_eq!(t.live_bytes(), 0);
    }

    #[test]
    fn a_dataset_is_sealed_once_and_used_only_sealed() {
        let _g = crate::work::tests_serial();
        let mut t = Table::default();
        let h = filled(&mut t, &[1.0, 2.0, 3.0, 4.0], &[0.0, 1.0], 2, 2, None);
        assert_eq!(t.get(h).unwrap_err(), Error::State);
        t.seal(h).unwrap();
        assert_eq!(t.get(h).unwrap().x, vec![1.0, 2.0, 3.0, 4.0]);
        assert_eq!(t.open(h).unwrap_err(), Error::State);
        assert_eq!(t.seal(h), Err(Error::State));
        assert_eq!(t.live_bytes(), 4 * 4 + 2 * 8);
        assert!(t.release(h));
        assert!(!t.release(h));
        assert_eq!(t.get(h).unwrap_err(), Error::Handle);
        assert_eq!(t.live_bytes(), 0);
        // (handles are never reused)
        let h2 = t.create(1, 1, 1, false).unwrap();
        assert!(h2 > h);
    }

    #[test]
    fn a_handle_of_one_kind_names_nothing_of_another() {
        let _g = crate::work::tests_serial();
        let mut t = Table::default();
        let d = filled(&mut t, &[1.0, 2.0], &[0.0, 1.0], 2, 1, None);
        let b = t.buffer(3).unwrap();
        t.seal(d).unwrap();
        let p = crate::fit::FitParams { kind: crate::criterion::Kind::Mse, max_depth: 1, min_samples_split: 2, min_samples_leaf: 1, min_weight_leaf: 0.0, max_features: 1, min_impurity_decrease: 0.0, seed: 1 };
        let (tree, imp) = crate::fit::fit(t.get(d).unwrap(), None, &[], &p, &mut (0, 0)).unwrap();
        let r = t.put_tree(tree, imp).unwrap();
        let bytes = t.live_bytes();
        for h in [b, r] {
            assert_eq!(t.get(h).unwrap_err(), Error::Handle);
            assert_eq!(t.open(h).unwrap_err(), Error::Handle);
            assert_eq!(t.seal(h), Err(Error::Handle));
            assert!(!t.release(h));
        }
        for h in [d, r] {
            assert_eq!(t.buffer_mut(h).unwrap_err(), Error::Handle);
            assert_eq!(t.buffer_take(h).unwrap_err(), Error::Handle);
        }
        for h in [d, b] {
            assert_eq!(t.tree(h).unwrap_err(), Error::Handle);
            assert!(!t.release_tree(h));
        }
        // (nothing was removed by the refused calls)
        assert_eq!(t.live_bytes(), bytes);
        assert_eq!(t.buffer_take(b).unwrap().len(), 3);
        assert!(t.release_tree(r));
        assert!(t.release(d));
        assert_eq!(t.live_bytes(), 0);
    }

    #[test]
    fn nan_only_where_the_mask_allows_and_never_an_infinity() {
        let _g = crate::work::tests_serial();
        let mut t = Table::default();
        let x = [1.0, f32::NAN, 3.0, 4.0, 5.0, 6.0];
        let h = filled(&mut t, &x, &[0.0, 1.0], 2, 3, None);
        assert_eq!(t.seal(h), Err(Error::NanInX));
        assert_eq!(t.detail, (0, 1));
        let h = filled(&mut t, &x, &[0.0, 1.0], 2, 3, Some(&[0, 0, 1]));
        assert_eq!(t.seal(h), Err(Error::NanInX));
        let h = filled(&mut t, &x, &[0.0, 1.0], 2, 3, Some(&[0, 1, 0]));
        assert_eq!(t.seal(h), Ok(()));
        let h = filled(&mut t, &[1.0, 2.0, 3.0, 4.0, f32::NEG_INFINITY, 6.0], &[0.0, 1.0], 2, 3, Some(&[1, 1, 1]));
        assert_eq!(t.seal(h), Err(Error::InfInX));
        assert_eq!(t.detail, (1, 1));
        let h = filled(&mut t, &[1.0, 2.0], &[0.0, 1.0], 2, 1, Some(&[2]));
        assert_eq!(t.seal(h), Err(Error::Mask));
        let h = filled(&mut t, &[1.0, 2.0], &[0.0, 1.0, 2.0, f64::NAN], 2, 1, None);
        assert_eq!(t.seal(h), Err(Error::NonFiniteY));
        assert_eq!(t.detail, (1, 1));
    }

    #[test]
    fn a_large_dataset_is_filled_and_checked_with_polls() {
        let _g = crate::work::tests_serial();
        sagebrush_interrupt::hooks::reset();
        let mut t = Table::default();
        let (n, f) = (10_000, 7);
        let h = t.create(n, f, 1, false).unwrap();
        let after_fill = sagebrush_interrupt::hooks::total();
        // the zero fills: at least one poll per 4096 elements
        assert!(after_fill >= ((n * f + n) / 4096) as u64, "{after_fill}");
        t.seal(h).unwrap();
        assert!(sagebrush_interrupt::hooks::total() - after_fill >= ((n * f + n) / 4096) as u64);
    }
}
