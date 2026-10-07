//! Subgroups of a group G <= Sym(n) that are conjugate in Sym(n) to a given
//! transitive group H, up to conjugacy in G, and from them the maximal
//! transitive subgroups of G: the data that Galois group descent needs.
//!
//! H = <h_1, ..., h_r>.  A subgroup H^y <= G is <h_1^y, ..., h_r^y>, so we
//! search tuples (x_1, ..., x_r) in G that are simultaneously conjugate in
//! Sym(n) to (h_1, ..., h_r): x_1 runs over representatives of the classes
//! of G, x_2 over representatives of the orbits of the centralizer C_G(x_1)
//! (by conjugation), and the cycle types of the x_i and of the products
//! x_i x_j must be those of the h_i and h_i h_j.  Whether a candidate tuple
//! is conjugate to the h's is decided by building the conjugating
//! permutation point by point (H is transitive, so one image decides it).
//!
//! Every subgroup of G conjugate in Sym(n) to H is G-conjugate to one of
//! those found.  Duplicates, and subgroups lying in a conjugate of a larger
//! one already kept, are recognized by the action of G on the cosets of the
//! kept subgroups: K <= M^g if and only if K fixes the coset of g.

use crate::lattice::Table;
use crate::{Group, Perm};

/// An x with g_i^x = h_i for all i and x(0) = y0, if any (<g_i> transitive).
pub fn tuple_conjugator(n: usize, gs: &[Perm], hs: &[Perm], y0: u32) -> Option<Perm> {
    let mut x = vec![u32::MAX; n];
    let mut used = vec![false; n];
    x[0] = y0;
    used[y0 as usize] = true;
    let mut queue = vec![0u32];
    while let Some(p) = queue.pop() {
        for (g, h) in gs.iter().zip(hs) {
            let (gp, hx) = (g.image(p), h.image(x[p as usize]));
            if x[gp as usize] == u32::MAX {
                if used[hx as usize] {
                    return None;
                }
                x[gp as usize] = hx;
                used[hx as usize] = true;
                queue.push(gp);
            } else if x[gp as usize] != hx {
                return None;
            }
        }
    }
    if x.iter().any(|&v| v == u32::MAX) {
        return None;
    }
    Some(Perm(x))
}

/// A few elements generating h (two if possible, found at random).
pub fn few_generators(h: &Group) -> Vec<Perm> {
    let mut rng = crate::perm::Rng::new(0x5eed);
    let order = h.order();
    if h.is_trivial() {
        return vec![];
    }
    for r in 1..=4usize {
        for _ in 0..200 {
            let gs: Vec<Perm> = (0..r).map(|_| h.random(&mut rng)).collect();
            if Group::new(h.n, gs.clone()).unwrap().order() == order {
                return gs;
            }
        }
    }
    let mut g = h.clone();
    g.reduce_gens();
    g.gens.clone()
}

/// A group G with its elements tabulated, its conjugacy classes and its
/// elements sorted by cycle type.
pub struct Ambient {
    pub g: Group,
    pub t: Table,
    pub class: Vec<u32>,
    pub by_type: Vec<Vec<u32>>,
    pub gens: Vec<u32>,
}

impl Ambient {
    pub fn new(g: &Group, limit: usize) -> Result<Ambient, String> {
        let t = Table::new(g, limit)?;
        let gens: Vec<u32> = g.gens.iter().map(|p| t.lookup(p).unwrap()).collect();
        let mut class = vec![u32::MAX; t.order];
        let mut nc = 0u32;
        for e in 0..t.order as u32 {
            if class[e as usize] != u32::MAX {
                continue;
            }
            class[e as usize] = nc;
            let mut orb = vec![e];
            let mut i = 0;
            while i < orb.len() {
                for &s in &gens {
                    let c = t.conj(orb[i], s);
                    if class[c as usize] == u32::MAX {
                        class[c as usize] = nc;
                        orb.push(c);
                    }
                }
                i += 1;
            }
            nc += 1;
        }
        let mut by_type = vec![vec![]; t.types.len()];
        for e in 0..t.order as u32 {
            by_type[t.ctype[e as usize] as usize].push(e);
        }
        Ok(Ambient { g: g.clone(), t, class, by_type, gens })
    }

    fn type_index(&self, p: &Perm) -> Option<usize> {
        let ct = p.cycle_type();
        self.t.types.iter().position(|t| *t == ct)
    }

    /// The number of elements of each cycle type.
    pub fn type_counts(&self) -> Vec<(Vec<usize>, usize)> {
        self.t.types.iter().cloned().zip(self.by_type.iter().map(|v| v.len())).collect()
    }

    fn centralizer(&self, x: u32) -> Vec<u32> {
        (0..self.t.order as u32).filter(|&e| self.t.conj(x, e) == x).collect()
    }

    fn generators_of(&self, els: &[u32]) -> Vec<u32> {
        let mut gens: Vec<u32> = vec![];
        let mut sub = Group::trivial(self.g.n);
        let target = num_traits::cast::FromPrimitive::from_usize(els.len()).unwrap();
        let mut rng = crate::perm::Rng::new(7);
        while sub.order() != target {
            let e = els[rng.below(els.len())];
            let p = self.t.perm(e);
            if !sub.contains(&p) {
                gens.push(e);
                sub = Group::new(self.g.n, gens.iter().map(|&i| self.t.perm(i)).collect()).unwrap();
            }
        }
        gens
    }

    /// Calls visit(y) for conjugates H^y <= G of h = <hs> (transitive), at
    /// least one in each G-class of them; stops when visit returns true.
    pub fn conjugates(&self, hs: &[Perm], visit: &mut dyn FnMut(&Perm) -> bool) -> bool {
        let n = self.g.n;
        let r = hs.len();
        if r == 0 {
            return visit(&Perm::identity(n));
        }
        let mut types = vec![];
        for h in hs {
            match self.type_index(h) {
                Some(i) => types.push(i),
                None => return false,
            }
        }
        // the cycle types of the products h_i h_j (i < j)
        let mut prod = vec![vec![None; r]; r];
        for i in 0..r {
            for j in i + 1..r {
                match self.type_index(&hs[i].mul(&hs[j])) {
                    Some(k) => prod[i][j] = Some(k as u32),
                    None => return false,
                }
            }
        }
        let t = &self.t;
        let ok_with = |xs: &[u32], e: u32| -> bool {
            let j = xs.len();
            (0..j).all(|i| Some(t.ctype[t.mul(xs[i], e) as usize]) == prod[i][j])
        };
        let finish = |xs: &[u32], visit: &mut dyn FnMut(&Perm) -> bool| -> bool {
            let ps: Vec<Perm> = xs.iter().map(|&i| t.perm(i)).collect();
            for y0 in 0..n as u32 {
                if let Some(y) = tuple_conjugator(n, hs, &ps, y0) {
                    return visit(&y);
                }
            }
            false
        };
        fn rest(a: &Ambient, xs: &mut Vec<u32>, types: &[usize], ok_with: &dyn Fn(&[u32], u32) -> bool, finish: &dyn Fn(&[u32], &mut dyn FnMut(&Perm) -> bool) -> bool, visit: &mut dyn FnMut(&Perm) -> bool) -> bool {
            if xs.len() == types.len() {
                return finish(xs, visit);
            }
            for &e in &a.by_type[types[xs.len()]] {
                sagebrush_interrupt::check();
                if ok_with(xs, e) {
                    xs.push(e);
                    if rest(a, xs, types, ok_with, finish, visit) {
                        return true;
                    }
                    xs.pop();
                }
            }
            false
        }
        let mut done_class = std::collections::HashSet::new();
        for &x1 in &self.by_type[types[0]] {
            // one x1 per class
            if !done_class.insert(self.class[x1 as usize]) {
                continue;
            }
            if r == 1 {
                if finish(&[x1], visit) {
                    return true;
                }
                continue;
            }
            let c = self.centralizer(x1);
            let cg = self.generators_of(&c);
            let mut seen = vec![false; t.order];
            for &x2 in &self.by_type[types[1]] {
                if seen[x2 as usize] || !ok_with(&[x1], x2) {
                    continue;
                }
                // the orbit of x2 under C_G(x1)
                let mut orb = vec![x2];
                seen[x2 as usize] = true;
                let mut i = 0;
                while i < orb.len() {
                    for &s in &cg {
                        let d = t.conj(orb[i], s);
                        if !seen[d as usize] {
                            seen[d as usize] = true;
                            orb.push(d);
                        }
                    }
                    i += 1;
                }
                let mut xs = vec![x1, x2];
                if rest(self, &mut xs, &types, &ok_with, &finish, visit) {
                    return true;
                }
            }
        }
        false
    }
}

/// The action of G on the cosets gM of a subgroup M (elements by number).
pub struct Cosets {
    pub order: usize,
    /// the coset of each element of G
    id: Vec<u32>,
    reps: Vec<u32>,
}

impl Cosets {
    pub fn new(a: &Ambient, m: &[u32]) -> Cosets {
        let t = &a.t;
        let msub = crate::lattice::closure(t, m);
        let mels = msub.elements();
        let mut id = vec![u32::MAX; t.order];
        let mut reps = vec![];
        for e in 0..t.order as u32 {
            if id[e as usize] != u32::MAX {
                continue;
            }
            let c = reps.len() as u32;
            reps.push(e);
            for &x in &mels {
                id[t.mul(e, x) as usize] = c;
            }
        }
        Cosets { order: mels.len(), id, reps }
    }

    /// Does <ks> lie in a conjugate g M g^-1 of M (fix a coset gM)?
    pub fn fixes_a_coset(&self, a: &Ambient, ks: &[u32]) -> bool {
        self.reps.iter().any(|&g| ks.iter().all(|&k| self.id[a.t.mul(k, g) as usize] == self.id[g as usize]))
    }
}

/// The maximal transitive subgroups of G (with |G| tabulated, G not Sym(n)
/// or Alt(n)) among the given transitive groups (one per Sym(n)-class),
/// up to conjugacy in G: pairs (i, y) with candidates[i]^y <= G, largest
/// first.  `gens[i]` are a few generators of candidates[i], `counts[i]` the
/// numbers of elements of each cycle type in it.
pub fn maximal_transitive(a: &Ambient, candidates: &[Group], gens: &[Vec<Perm>], counts: &[Vec<(Vec<usize>, usize)>]) -> Vec<(usize, Perm)> {
    let order = a.t.order;
    let mine = a.type_counts();
    let fits = |c: &Vec<(Vec<usize>, usize)>| c.iter().all(|(t, k)| mine.iter().any(|(u, l)| u == t && l >= k));
    let mut idx: Vec<usize> = (0..candidates.len()).collect();
    idx.sort_by_key(|&i| std::cmp::Reverse(candidates[i].order()));
    let mut kept: Vec<(usize, Perm, Cosets)> = vec![];
    for i in idx {
        // (groups too big for a machine word are bigger than G)
        let Some(hord) = num_traits::ToPrimitive::to_usize(&candidates[i].order()) else { continue };
        if hord >= order || order % hord != 0 || !fits(&counts[i]) {
            continue;
        }
        let mut found: Vec<(usize, Perm, Cosets)> = vec![];
        a.conjugates(&gens[i], &mut |y: &Perm| {
            let ks: Vec<u32> = gens[i].iter().map(|h| a.t.lookup(&h.conj(y)).unwrap()).collect();
            // in a conjugate of a larger one kept, or of one of this type found already?
            if !kept.iter().chain(found.iter()).any(|(_, _, c)| c.fixes_a_coset(a, &ks)) {
                found.push((i, y.clone(), Cosets::new(a, &ks)));
            }
            false
        });
        kept.extend(found);
    }
    kept.into_iter().map(|(i, y, _)| (i, y)).collect()
}
