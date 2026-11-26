//! Conjugacy classes of a permutation group, exactly, by enumerating its
//! elements: each class is the orbit of an element under conjugation by the
//! generators, walked from the least element (in the order of the images)
//! not yet reached, which is then the class's representative.  The
//! representatives are therefore canonical: the least element of each class,
//! whatever generators the group was given.  The classes are listed by the
//! order of their elements, then by their length, then by representative.
//!
//! The cost is the group's order times its degree, in time and memory; the
//! caller admits that first (lib/_magma_groups.py, the memory guard).

use crate::group::Group;
use crate::perm::Perm;
use std::collections::HashMap;

/// One conjugacy class: its least element, its length and the order of its
/// elements.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Class {
    pub rep: Perm,
    pub length: u64,
    pub order: u64,
}

fn elt_order(p: &Perm) -> u64 {
    let mut o: u64 = 1;
    for c in p.cycles() {
        let k = c.len() as u64;
        o = o / gcd(o, k) * k;
    }
    o
}

fn gcd(mut a: u64, mut b: u64) -> u64 {
    while b != 0 {
        let t = a % b;
        a = b;
        b = t;
    }
    a
}

/// The conjugacy classes of `g` (its elements enumerated: the caller admits
/// its order times its degree first).
pub fn conjugacy_classes(g: &Group) -> Vec<Class> {
    let mut elts = g.chain.elements();
    elts.sort();
    let index: HashMap<&[u32], usize> = elts.iter().enumerate().map(|(i, p)| (p.0.as_slice(), i)).collect();
    let gens: Vec<(Perm, Perm)> = g.gens.iter().filter(|s| !s.is_identity()).map(|s| (s.inv(), s.clone())).collect();
    let mut seen = vec![false; elts.len()];
    let mut classes = Vec::new();
    for start in 0..elts.len() {
        if seen[start] {
            continue;
        }
        seen[start] = true;
        let mut queue = vec![start];
        let mut i = 0;
        while i < queue.len() {
            if i % 1024 == 0 {
                sagebrush_interrupt::check();
            }
            let x = &elts[queue[i]];
            i += 1;
            for (si, s) in &gens {
                // s^-1 x s
                let y = si.mul(x).mul(s);
                let j = index[y.0.as_slice()];
                if !seen[j] {
                    seen[j] = true;
                    queue.push(j);
                }
            }
        }
        classes.push(Class { rep: elts[start].clone(), length: queue.len() as u64, order: elt_order(&elts[start]) });
    }
    classes.sort_by(|a, b| (a.order, a.length, &a.rep.0).cmp(&(b.order, b.length, &b.rep.0)));
    classes
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::named::{alternating, cyclic, dihedral, symmetric};

    fn lengths(g: &Group) -> Vec<(u64, u64)> {
        conjugacy_classes(g).iter().map(|c| (c.order, c.length)).collect()
    }

    #[test]
    fn symmetric_and_alternating() {
        // the number of classes: partitions (Sym), and A5's 5 (two of order 5)
        assert_eq!(conjugacy_classes(&symmetric(5)).len(), 7);
        assert_eq!(conjugacy_classes(&symmetric(6)).len(), 11);
        assert_eq!(lengths(&alternating(5)), vec![(1, 1), (2, 15), (3, 20), (5, 12), (5, 12)]);
        assert_eq!(lengths(&alternating(4)), vec![(1, 1), (2, 3), (3, 4), (3, 4)]);
        // the lengths sum to the order
        let s7 = conjugacy_classes(&symmetric(7));
        assert_eq!(s7.len(), 15);
        assert_eq!(s7.iter().map(|c| c.length).sum::<u64>(), 5040);
    }

    #[test]
    fn abelian_and_dihedral() {
        // an abelian group: every class a single element
        let c = conjugacy_classes(&cyclic(6));
        assert_eq!(c.len(), 6);
        assert!(c.iter().all(|k| k.length == 1));
        // D4 (order 8): 5 classes, D5 (order 10): 4
        assert_eq!(conjugacy_classes(&dihedral(4)).len(), 5);
        assert_eq!(lengths(&dihedral(5)), vec![(1, 1), (2, 5), (5, 2), (5, 2)]);
    }

    #[test]
    fn canonical_representatives() {
        // the least element of each class, the same for other generators of
        // the same group (Sym(4) by transpositions and by (1,2,3,4), (1,2))
        let a = conjugacy_classes(&symmetric(4));
        let t = |i: u32, j: u32| {
            let mut v: Vec<u32> = (0..4).collect();
            v.swap(i as usize, j as usize);
            Perm(v)
        };
        let b = conjugacy_classes(&Group::new(4, vec![t(0, 1), t(1, 2), t(2, 3)]).unwrap());
        assert_eq!(a, b);
        // the identity first; the transpositions' representative is (3, 4),
        // the least of them by images: [0, 1, 3, 2]
        assert!(a[0].rep.is_identity());
        assert_eq!(a.iter().find(|c| c.order == 2 && c.length == 6).unwrap().rep.0, vec![0, 1, 3, 2]);
    }
}
