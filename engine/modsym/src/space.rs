//! The quotient over GF(p): the relations in sparse echelon form, the
//! quotient basis, and Hecke operators.
//!
//! No dense coordinate table is stored.  The relations keep about two
//! nonzeros per row after elimination, so a functional on the quotient
//! extends to every generator in O(m) (`extend`), and the matrix of T_q is
//! assembled a block of columns at a time from such functionals.  Memory is
//! O(m + dim^2) instead of O(m dim).

use crate::linalg;
use crate::par;
use crate::presentation::Presentation;

pub struct Space {
    pub p: u64,
    /// Number of free generators (after the 2-term relations).
    pub m: usize,
    /// For each basis element, the free generator it is.
    pub basis_gen: Vec<u32>,
    /// The relations in echelon form: x_pc + sum v_k x_k = 0, in creation
    /// order; about two nonzeros each.
    pub pivots: Vec<(u32, Vec<(u32, u64)>)>,
}

/// Columns of T_q assembled per pass (bounds the scratch memory).
const BLOCK: usize = 64;

impl Space {
    pub fn new(pres: &Presentation, p: u64) -> Self {
        let rows: Vec<Vec<(u32, u64)>> = pres.rows.iter().map(|r| r.iter().map(|&(g, v)| (g, v.rem_euclid(p as i64) as u64)).filter(|e| e.1 != 0).collect()).collect();
        let (pivots, pivot_of) = linalg::sparse_echelon(&rows, pres.m, p);
        let basis_gen = (0..pres.m as u32).filter(|&g| pivot_of[g as usize] == u32::MAX).collect();
        Space { p, m: pres.m, basis_gen, pivots }
    }

    pub fn dimension(&self) -> usize {
        self.basis_gen.len()
    }

    /// A functional on the quotient (given on the basis) as a functional on
    /// every free generator, through the sparse relations: psi(x_pc) =
    /// -sum v_k psi(x_k), latest pivots first (they only involve later
    /// generators).  About two operations per generator.
    pub fn extend(&self, phi: &[u64]) -> Vec<u64> {
        let p = self.p;
        let mut psi = vec![0u64; self.m];
        for (t, &g) in self.basis_gen.iter().enumerate() {
            psi[g as usize] = phi[t];
        }
        for (pc, rest) in self.pivots.iter().rev() {
            let s = rest.iter().fold(0u128, |acc, &(k, v)| acc + v as u128 * psi[k as usize] as u128) % p as u128;
            psi[*pc as usize] = (p - s as u64) % p;
        }
        psi
    }

    /// T_q(x) for the generator g as a sparse combination of generators.
    pub fn hecke_image(pres: &Presentation, h: &[(i64, i64, i64, i64)], g: u32) -> Vec<(u32, i64)> {
        let (i, s) = pres.sym_of_gen[g as usize];
        let (c, d) = pres.p1.get(i as usize);
        let (c, d) = (c as i64, d as i64);
        let mut out: Vec<(u32, i64)> = vec![];
        for &(a, b, cc, dd) in h {
            if let Some((g2, s2)) = pres.rep_of[pres.p1.index(c * a + d * cc, c * b + d * dd)] {
                out.push((g2, if s2 ^ s { -1 } else { 1 }));
            }
        }
        out.sort_unstable_by_key(|e| e.0);
        let mut merged: Vec<(u32, i64)> = vec![];
        for (g2, v) in out {
            match merged.last_mut() {
                Some(last) if last.0 == g2 => last.1 += v,
                _ => merged.push((g2, v)),
            }
        }
        merged.retain(|e| e.1 != 0);
        merged
    }

    /// Matrix of T_q (q prime, not dividing N); row i is T_q(basis_i).
    /// Entry (i, j) pairs the image of basis_i with the extension of the
    /// j-th coordinate functional, computed BLOCK columns at a time.
    pub fn hecke_matrix(&self, pres: &Presentation, q: u64) -> Vec<Vec<u64>> {
        let h = linalg::heilbronn(q as i64);
        let p = self.p;
        let d = self.dimension();
        let images = par::map_slice(&self.basis_gen, |&g| Self::hecke_image(pres, &h, g));
        let mut t = vec![vec![0u64; d]; d];
        for j0 in (0..d).step_by(BLOCK) {
            sagebrush_interrupt::check();
            let js: Vec<usize> = (j0..(j0 + BLOCK).min(d)).collect();
            let psis = par::map_slice(&js, |&j| {
                let mut e = vec![0u64; d];
                e[j] = 1;
                self.extend(&e)
            });
            let cols = par::map_slice(&images, |img| {
                psis.iter()
                    .map(|psi| img.iter().fold(0i128, |acc, &(g2, c)| acc + c as i128 * psi[g2 as usize] as i128).rem_euclid(p as i128) as u64)
                    .collect::<Vec<u64>>()
            });
            for (i, col) in cols.into_iter().enumerate() {
                t[i][j0..j0 + col.len()].copy_from_slice(&col);
            }
        }
        t
    }
}
