//! Stabilizer chains (bases and strong generating sets) by the Schreier-Sims
//! algorithm.
//!
//! A chain for G on {0..n-1} is a base b_0, ..., b_{k-1} and levels
//! G = G^(0) >= G^(1) >= ... >= G^(k) = 1, with G^(i+1) the stabilizer of b_i
//! in G^(i).  Each level keeps the strong generators lying in G^(i), the
//! orbit of b_i under them, and a transversal: for each orbit point p an
//! element u_p of G^(i) with b_i^(u_p) = p.  Then |G| is the product of the
//! orbit lengths and every g in G factors uniquely as g = t_{k-1} ... t_1 t_0
//! with t_i in the i-th transversal (sifting).
//!
//! Construction: a randomized phase (random elements by product replacement
//! are sifted, and what does not sift becomes a new strong generator) builds a
//! chain quickly; then the deterministic Schreier-Sims test checks every
//! Schreier generator u_p s u_{p^s}^-1 of every level, adding generators
//! until all of them sift.  The result is therefore proven, not probable
//! (Sims; see Holt, Eick and O'Brien, Handbook of Computational Group
//! Theory, ch. 4, and Seress, Permutation Group Algorithms, ch. 4).  Pairs
//! already checked are not checked again: a Schreier generator that sifted
//! still sifts after lower levels grow.

use crate::perm::{Perm, Rng};

#[derive(Clone, Debug)]
pub struct Level {
    pub base: u32,
    /// strong generators in this level's group
    pub gens: Vec<Perm>,
    /// the orbit of the base point, in discovery order
    pub orbit: Vec<u32>,
    /// trans[p] = (u_p, u_p^-1) for p in the orbit
    pub trans: Vec<Option<(Perm, Perm)>>,
    /// (orbit length, number of generators) up to which Schreier generators are known to sift
    checked: (usize, usize),
}

impl Level {
    fn new(n: usize, base: u32, gens: Vec<Perm>) -> Level {
        let mut l = Level { base, gens, orbit: vec![], trans: vec![None; n], checked: (0, 0) };
        let id = Perm::identity(n);
        l.trans[base as usize] = Some((id.clone(), id));
        l.orbit.push(base);
        l.extend_orbit();
        l
    }

    /// Grow the orbit and transversal under the current generators.
    fn extend_orbit(&mut self) {
        let mut i = 0;
        // new generators may move old points to new ones: scan every orbit point
        while i < self.orbit.len() {
            let p = self.orbit[i];
            for s in 0..self.gens.len() {
                let q = self.gens[s].image(p);
                if self.trans[q as usize].is_none() {
                    let u = self.trans[p as usize].as_ref().unwrap().0.mul(&self.gens[s]);
                    let ui = u.inv();
                    self.trans[q as usize] = Some((u, ui));
                    self.orbit.push(q);
                }
            }
            i += 1;
        }
    }
}

#[derive(Clone, Debug)]
pub struct Chain {
    pub n: usize,
    pub levels: Vec<Level>,
}

impl Chain {
    pub fn base(&self) -> Vec<u32> {
        self.levels.iter().map(|l| l.base).collect()
    }

    /// Sift g from level `from`: (residue, level reached).  g is in the group
    /// iff the level reached is the length of the chain and the residue is 1.
    pub fn sift(&self, g: &Perm, from: usize) -> (Perm, usize) {
        let mut g = g.clone();
        for l in from..self.levels.len() {
            let lv = &self.levels[l];
            let p = g.image(lv.base);
            match &lv.trans[p as usize] {
                None => return (g, l),
                Some((_, ui)) => g = g.mul(ui),
            }
        }
        (g, self.levels.len())
    }

    pub fn contains(&self, g: &Perm) -> bool {
        let (h, j) = self.sift(g, 0);
        j == self.levels.len() && h.is_identity()
    }

    /// h (which fixes the base points of levels < j) becomes a strong
    /// generator in levels from..=j; a new level if j is past the end.
    fn add_strong(&mut self, h: Perm, from: usize, j: usize) {
        if j == self.levels.len() {
            let b = h.first_moved().expect("adding the identity");
            self.levels.push(Level::new(self.n, b, vec![]));
        }
        for l in from..=j {
            self.levels[l].gens.push(h.clone());
            self.levels[l].extend_orbit();
        }
    }

    /// Sift g from level `from` and keep what does not sift; true if g was new.
    fn absorb(&mut self, g: &Perm, from: usize) -> bool {
        let (h, j) = self.sift(g, from);
        if j < self.levels.len() || !h.is_identity() {
            self.add_strong(h, from, j);
            true
        } else {
            false
        }
    }

    /// The deterministic Schreier-Sims test, completing the chain.
    fn complete(&mut self) {
        let mut i = self.levels.len() as isize - 1;
        while i >= 0 {
            let li = i as usize;
            let mut added = None;
            let (done_o, done_s) = self.levels[li].checked;
            let mut pi = 0;
            'scan: while pi < self.levels[li].orbit.len() {
                let mut si = 0;
                while si < self.levels[li].gens.len() {
                    if pi < done_o && si < done_s {
                        si += 1;
                        continue;
                    }
                    sagebrush_interrupt::check();
                    let lv = &self.levels[li];
                    let p = lv.orbit[pi];
                    let s = &lv.gens[si];
                    let q = s.image(p);
                    let sg = lv.trans[p as usize].as_ref().unwrap().0.mul(s).mul(&lv.trans[q as usize].as_ref().unwrap().1);
                    if !sg.is_identity() {
                        let (h, j) = self.sift(&sg, li + 1);
                        if j < self.levels.len() || !h.is_identity() {
                            self.add_strong(h, li + 1, j);
                            added = Some(j);
                            break 'scan;
                        }
                    }
                    si += 1;
                }
                pi += 1;
            }
            match added {
                Some(j) => i = j as isize,
                None => {
                    let lv = &mut self.levels[li];
                    lv.checked = (lv.orbit.len(), lv.gens.len());
                    i -= 1;
                }
            }
        }
    }

    /// A chain for the group generated by `gens` on {0..n-1}, with base
    /// starting with `prefix`.
    pub fn new(n: usize, gens: &[Perm], prefix: &[u32]) -> Chain {
        let gens: Vec<Perm> = gens.iter().filter(|g| !g.is_identity()).cloned().collect();
        let mut ch = Chain { n, levels: vec![] };
        for &b in prefix {
            ch.levels.push(Level::new(n, b, vec![]));
        }
        if gens.is_empty() {
            // the trivial group: no levels are needed beyond the requested prefix
            return ch;
        }
        // each generator, sifted; what does not sift becomes a strong
        // generator (g = residue * transversal elements, so the group is the same)
        for g in &gens {
            ch.absorb(g, 0);
        }
        // randomized phase: stop after 20 random elements in a row sift
        let mut rng = Rng::new(0x5eed ^ (n as u64) ^ ((gens.len() as u64) << 32));
        let mut pr = ProductReplacement::new(&gens, &mut rng);
        let mut run = 0;
        while run < 20 {
            sagebrush_interrupt::check();
            let r = pr.next(&mut rng);
            if ch.absorb(&r, 0) {
                run = 0;
            } else {
                run += 1;
            }
        }
        // the proof
        ch.complete();
        ch
    }

    /// |G| as the product of the orbit lengths.
    pub fn order(&self) -> sagebrush_bigint::BigInt {
        let mut r = sagebrush_bigint::BigInt::from(1u32);
        for l in &self.levels {
            r *= sagebrush_bigint::BigInt::from(l.orbit.len() as u64);
        }
        r
    }

    /// A uniformly random element.
    pub fn random(&self, rng: &mut Rng) -> Perm {
        let mut g = Perm::identity(self.n);
        for l in self.levels.iter().rev() {
            let p = l.orbit[rng.below(l.orbit.len())];
            g = g.mul(&l.trans[p as usize].as_ref().unwrap().0);
        }
        g
    }

    /// Every element (the caller bounds the order).
    pub fn elements(&self) -> Vec<Perm> {
        let mut out = vec![Perm::identity(self.n)];
        for l in self.levels.iter().rev() {
            let mut next = Vec::with_capacity(out.len() * l.orbit.len());
            for g in &out {
                for &p in &l.orbit {
                    next.push(g.mul(&l.trans[p as usize].as_ref().unwrap().0));
                }
            }
            out = next;
        }
        out
    }

    /// The strong generators (those of level 0).
    pub fn strong_gens(&self) -> Vec<Perm> {
        self.levels.first().map(|l| l.gens.clone()).unwrap_or_default()
    }

    /// The chain of the stabilizer of the first base point.
    pub fn tail(&self) -> Chain {
        Chain { n: self.n, levels: self.levels[1.min(self.levels.len())..].to_vec() }
    }
}

/// Random elements by product replacement (Celler, Leedham-Green, Murray,
/// Niemeyer and O'Brien), with an accumulator ("rattle").
struct ProductReplacement {
    v: Vec<Perm>,
    acc: Perm,
}

impl ProductReplacement {
    fn new(gens: &[Perm], rng: &mut Rng) -> ProductReplacement {
        let n = gens[0].degree();
        let mut v: Vec<Perm> = vec![];
        while v.len() < 10.max(gens.len()) {
            v.push(gens[v.len() % gens.len()].clone());
        }
        let mut pr = ProductReplacement { v, acc: Perm::identity(n) };
        for _ in 0..50 {
            pr.next(rng);
        }
        pr
    }

    fn next(&mut self, rng: &mut Rng) -> Perm {
        let k = self.v.len();
        let i = rng.below(k);
        let mut j = rng.below(k - 1);
        if j >= i {
            j += 1;
        }
        self.v[i] = if rng.below(2) == 0 { self.v[i].mul(&self.v[j]) } else { self.v[j].mul(&self.v[i]) };
        self.acc = self.acc.mul(&self.v[i]);
        self.acc.clone()
    }
}
