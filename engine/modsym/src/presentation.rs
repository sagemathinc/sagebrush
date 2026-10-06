//! The prime-independent part: Manin symbols on P^1(Z/NZ), the 2-term
//! relations (x + xS = 0, x = x*eta for sign +1) solved by a signed
//! union-find, and the 3-term relations as integer rows over the free
//! generators.  Computed once and shared by every prime.

use crate::p1::P1List;
use crate::par;

pub struct Presentation {
    pub n: u64,
    pub p1: P1List,
    /// For each Manin symbol: (free generator, negated) or None if zero.
    pub rep_of: Vec<Option<(u32, bool)>>,
    /// Number of free generators.
    pub m: usize,
    /// 3-term relations x + xT + xT^2 = 0 over the free generators.
    pub rows: Vec<Vec<(u32, i64)>>,
    /// A Manin symbol (index, negated) representing each free generator.
    pub sym_of_gen: Vec<(u32, bool)>,
}

fn find(parent: &mut [u32], neg: &mut [bool], i: usize) -> (usize, bool) {
    let mut path = vec![];
    let (mut r, mut s) = (i, false);
    while parent[r] as usize != r {
        path.push(r);
        s ^= neg[r];
        r = parent[r] as usize;
    }
    let mut acc = s; // path compression, signs relative to the root
    for &k in &path {
        let next = neg[k];
        parent[k] = r as u32;
        neg[k] = acc;
        acc ^= next;
    }
    (r, s)
}

impl Presentation {
    pub fn new(n: u64) -> Self {
        let p1 = P1List::new(n);
        let ns = p1.len();
        let mut parent: Vec<u32> = (0..ns as u32).collect();
        let mut neg = vec![false; ns];
        let mut zero = vec![false; ns];
        let mut union = |parent: &mut Vec<u32>, neg: &mut Vec<bool>, i: usize, j: usize, minus: bool| {
            let (ri, si) = find(parent, neg, i);
            let (rj, sj) = find(parent, neg, j);
            if ri == rj {
                if si != (sj ^ minus) {
                    zero[ri] = true; // x = -x, so x = 0 (2 is invertible)
                }
                return;
            }
            parent[ri] = rj as u32;
            neg[ri] = si ^ sj ^ minus;
            if zero[ri] {
                zero[rj] = true;
            }
        };
        for i in 0..ns {
            sagebrush_interrupt::check();
            let (c, d) = p1.get(i);
            let (c, d) = (c as i64, d as i64);
            union(&mut parent, &mut neg, i, p1.index(d, -c), true);
            union(&mut parent, &mut neg, i, p1.index(-c, d), false);
        }
        let mut gen_of_root = vec![u32::MAX; ns];
        let mut rep_of = vec![None; ns];
        let mut sym_of_gen = vec![];
        for i in 0..ns {
            sagebrush_interrupt::check();
            let (r, s) = find(&mut parent, &mut neg, i);
            if zero[r] {
                continue;
            }
            if gen_of_root[r] == u32::MAX {
                gen_of_root[r] = sym_of_gen.len() as u32;
                sym_of_gen.push((i as u32, s));
            }
            rep_of[i] = Some((gen_of_root[r], s));
        }
        let m = sym_of_gen.len();
        let rows = par::map_range(ns, |i| {
            let (c, d) = p1.get(i);
            let (c, d) = (c as i64, d as i64);
            let mut row: Vec<(u32, i64)> = Vec::with_capacity(3);
            for (a, b) in [(c, d), (d, -c - d), (-c - d, c)] {
                if let Some((g, s)) = rep_of[p1.index(a, b)] {
                    let v = if s { -1 } else { 1 };
                    match row.iter_mut().find(|e| e.0 == g) {
                        Some(e) => e.1 += v,
                        None => row.push((g, v)),
                    }
                }
            }
            row.retain(|e| e.1 != 0);
            row
        });
        Presentation { n, p1, rep_of, m, rows, sym_of_gen }
    }
}
