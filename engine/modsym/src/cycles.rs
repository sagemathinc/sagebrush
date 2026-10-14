//! The values of a modular symbol functional on closed cycles.
//!
//! Each Manin symbol (c : d), lifted to g = [a b; c d] in SL_2(Z), is the
//! path g{0, oo} = {b/d, a/c}: an edge of a graph whose vertices are the
//! cusp classes of Gamma0(N) (cusps.rs).  Integer combinations of edges
//! with zero boundary are the cycles of this graph, and they map onto
//! H_1(X_0(N), Z) (Manin, Parabolic points and zeta functions of modular
//! curves, 1972, Thm 1.9).  The fundamental cycles of a spanning forest
//! are a Z-basis of the cycles, so the gcd of X over them generates
//! X(H_1(X_0(N), Z)).
//!
//! For a cusp r Gamma0(N)-equivalent to 0 the path {0, r} is closed, so
//! X({0, r}) lies in this lattice: this bounds the denominators of the
//! modular symbols [a/p^k] (p not dividing N) used by p-adic L-series.

use crate::cusps::{lift_to_sl2, Cusps};
use crate::p1::P1List;
use num_traits::{Signed, Zero};
use sagebrush_bigint::BigInt;

fn gcd_big(a: &BigInt, b: &BigInt) -> BigInt {
    let (mut a, mut b) = (a.abs(), b.abs());
    while !b.is_zero() {
        let r = &a % &b;
        a = std::mem::replace(&mut b, r);
    }
    a
}

/// A union-find over cusp classes that keeps, for each class, the value
/// of X along a forest path from its root: pot(v) = X({root, v}).
struct Forest {
    parent: Vec<usize>,
    /// X({parent, v})
    up: Vec<BigInt>,
}

impl Forest {
    fn add(&mut self) {
        self.parent.push(self.parent.len());
        self.up.push(BigInt::zero());
    }

    /// (root, X({root, v}))
    fn find(&mut self, v: usize) -> (usize, BigInt) {
        let mut path = vec![];
        let mut r = v;
        while self.parent[r] != r {
            path.push(r);
            r = self.parent[r];
        }
        // compress: from the node nearest the root outwards
        let mut acc = BigInt::zero();
        for &u in path.iter().rev() {
            acc = &acc + &self.up[u];
            self.up[u] = acc.clone();
            self.parent[u] = r;
        }
        (r, if v == r { BigInt::zero() } else { self.up[v].clone() })
    }
}

/// The non-negative generator of X(H_1(X_0(N), Z)): the gcd of X over the
/// fundamental cycles of the Manin symbol graph.  `x` is X on each Manin
/// symbol, by P1List index.
pub fn cycle_content(p1: &P1List, x: &[BigInt]) -> BigInt {
    let n = p1.level() as i64;
    let mut cusps = Cusps::new(n as u64, false);
    let mut forest = Forest { parent: vec![], up: vec![] };
    let mut g = BigInt::zero();
    for (i, xi) in x.iter().enumerate().take(p1.len()) {
        let (c, d) = p1.get(i);
        let (a, b, c, d) = lift_to_sl2(c as i64, d as i64, n);
        let (tail, head) = (cusps.class(b, d), cusps.class(a, c));
        while forest.parent.len() < cusps.count() {
            forest.add();
        }
        let (rt, pt) = forest.find(tail);
        let (rh, ph) = forest.find(head);
        if rt == rh {
            // the edge closes a cycle: X(edge) - X(forest path tail -> head)
            g = gcd_big(&g, &(xi - (&ph - &pt)));
        } else {
            // hang the head's tree below the tail's root: pot(head) = pot(tail) + X(edge)
            forest.parent[rh] = rt;
            forest.up[rh] = &pt + xi - &ph;
        }
    }
    g
}

#[cfg(test)]
mod tests {
    use super::*;

    /// X = 0 gives the zero lattice (the curves are in ec_map.rs's tests).
    #[test]
    fn zero_functional() {
        let p1 = P1List::new(11);
        let x = vec![BigInt::zero(); p1.len()];
        assert_eq!(cycle_content(&p1, &x), BigInt::zero());
    }
}
