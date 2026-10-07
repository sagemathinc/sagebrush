//! The transitive groups of a given degree, generated from scratch.
//!
//! Degree <= 9: the transitive classes of subgroups of Sym(n) (lattice.rs).
//! Larger degrees: a transitive group is primitive (primitive.rs builds
//! those) or has blocks; with b the smallest block size it lies in the
//! wreath product P wr Sym(n/b), P primitive of degree b, after conjugation.
//! So the imprimitive ones are the transitive subgroups, with smallest
//! block size b, of those wreath products (their subgroup lattices), taken
//! up to conjugacy in Sym(n).
//!
//! Conjugacy in Sym(n) of transitive groups H1 = <g_1, ..., g_k> and H2:
//! they are conjugate iff some tuple (h_1, ..., h_k) of elements of H2 is
//! simultaneously conjugate to (g_1, ..., g_k); since H1 is transitive, the
//! image x(0) of one point determines x by x(g_i(p)) = h_i(x(p)).  The first
//! h_1 runs over representatives of the classes of H2 of the cycle type of
//! g_1, the others over the elements of H2 of the right cycle types.

use crate::group::Group;
use crate::lattice::Lattice;
use crate::named;
use crate::perm::Perm;
use crate::primitive;
use crate::embed::tuple_conjugator;
use std::collections::HashMap;

/// The wreath product P wr A on a*b points: block i is {i b, ..., i b + b - 1}.
pub fn wreath(p: &Group, a: &Group) -> Group {
    let (b, na) = (p.n, a.n);
    let n = b * na;
    let mut gens = vec![];
    for g in &p.gens {
        // g on block 0
        gens.push(Perm((0..n as u32).map(|x| if (x as usize) < b { g.image(x) } else { x }).collect()));
    }
    for s in &a.gens {
        gens.push(Perm((0..n as u32).map(|x| s.image(x / b as u32) * b as u32 + x % b as u32).collect()));
    }
    if na > 1 && a.gens.is_empty() {
        // (a trivial top group is not transitive; not used)
    }
    Group::new(n, gens).unwrap()
}

/// The smallest size of a nontrivial block (n if the group is primitive).
pub fn min_block_size(g: &Group) -> usize {
    g.blocks_containing(0).first().map_or(g.n, |b| b.len())
}

/// A group's elements by cycle type, for conjugacy tests against it.
pub struct Profile {
    by_type: HashMap<Vec<usize>, Vec<Perm>>,
}

impl Profile {
    pub fn new(h: &Group, limit: u64) -> Result<Profile, String> {
        let els = h.elements(limit).ok_or_else(|| format!("conjugacy test: more than {} elements", limit))?;
        let mut by_type: HashMap<Vec<usize>, Vec<Perm>> = HashMap::new();
        for e in els {
            by_type.entry(e.cycle_type()).or_default().push(e);
        }
        Ok(Profile { by_type })
    }
}

/// Are the transitive groups h1 and h2 conjugate in Sym(n)?
pub fn conjugate_in_sym(h1: &Group, h2: &Group, limit: u64) -> Result<bool, String> {
    if h1.order() != h2.order() {
        return Ok(false);
    }
    conjugate_profiled(h1, h2, &Profile::new(h2, limit)?)
}

/// The same, with h2's elements already sorted by cycle type.
pub fn conjugate_profiled(h1: &Group, h2: &Group, prof: &Profile) -> Result<bool, String> {
    let n = h1.n;
    if h1.order() != h2.order() {
        return Ok(false);
    }
    let mut g1 = h1.clone();
    g1.reduce_gens();
    let gs: Vec<Perm> = g1.gens.iter().filter(|g| !g.is_identity()).cloned().collect();
    if gs.is_empty() {
        return Ok(h2.is_trivial());
    }
    let by_type = &prof.by_type;
    let cand: Vec<&Vec<Perm>> = gs.iter().map(|g| by_type.get(&g.cycle_type())).collect::<Option<Vec<_>>>().map_or(vec![], |v| v);
    if cand.len() != gs.len() {
        return Ok(false);
    }
    // class representatives for the first generator's images
    let mut reps: Vec<Perm> = vec![];
    let mut seen: std::collections::HashSet<Perm> = std::collections::HashSet::new();
    for e in cand[0] {
        if seen.contains(e) {
            continue;
        }
        reps.push(e.clone());
        let mut orb = vec![e.clone()];
        seen.insert(e.clone());
        let mut i = 0;
        while i < orb.len() {
            for s in &h2.gens {
                let c = orb[i].conj(s);
                if seen.insert(c.clone()) {
                    orb.push(c);
                }
            }
            i += 1;
        }
    }
    // the rest, recursively
    fn rec(n: usize, gs: &[Perm], cand: &[&Vec<Perm>], chosen: &mut Vec<Perm>, h2: &Group) -> bool {
        if chosen.len() == gs.len() {
            return (0..n as u32).any(|y| tuple_conjugator(n, gs, chosen, y).map_or(false, |x| gs.iter().all(|g| h2.contains(&g.conj(&x)))));
        }
        let i = chosen.len();
        for h in cand[i] {
            sagebrush_interrupt::check();
            chosen.push(h.clone());
            // prune: the pairs so far must be simultaneously conjugate on the orbit structure
            if rec(n, gs, cand, chosen, h2) {
                return true;
            }
            chosen.pop();
        }
        false
    }
    for r in reps {
        let mut chosen = vec![r];
        if rec(n, &gs, &cand, &mut chosen, h2) {
            return Ok(true);
        }
    }
    Ok(false)
}

/// The outer automorphism of Sym(6): the action of Sym(6) by conjugation
/// on the six transitive subgroups PGL(2, 5) (each an S5 acting on 6 points),
/// as the images of the generators of `s6`.
fn outer_s6(s6: &Group) -> Vec<Perm> {
    let p = primitive::projective_line(5, "pgl").unwrap();
    // the conjugates of p
    let mut conjs: Vec<Group> = vec![p.clone()];
    let mut i = 0;
    while i < conjs.len() {
        for g in &s6.gens {
            let c = Group::new(6, conjs[i].gens.iter().map(|x| x.conj(g)).collect()).unwrap();
            if !conjs.iter().any(|d| d.contains_group(&c)) {
                conjs.push(c);
            }
        }
        i += 1;
    }
    assert_eq!(conjs.len(), 6);
    s6.gens
        .iter()
        .map(|g| {
            Perm((0..6).map(|j| {
                let c = Group::new(6, conjs[j].gens.iter().map(|x| x.conj(g)).collect()).unwrap();
                conjs.iter().position(|d| d.contains_group(&c)).unwrap() as u32
            }).collect())
        })
        .collect()
}

/// The transitive groups of degree 2b with two blocks of size b on which
/// the block stabilizer acts as P = Sym(b) or Alt(b) (Goursat): the kernel
/// K <= P x P projects onto P on both blocks, so it is P x P, the pairs
/// with equal sign (P = Sym(b)), or a diagonal {(x, x^alpha)} for an
/// automorphism alpha (inner, conjugation by a transposition for Alt(b),
/// and Sym(6)'s outer one); then G = <K, (u, 1) t> with t swapping the
/// blocks, u in Sym(b), and |G| = 2|K|.
fn two_block_groups(p: &Group, b: usize) -> Vec<Group> {
    let n = 2 * b;
    let on1 = |g: &Perm| Perm((0..n as u32).map(|x| if (x as usize) < b { g.image(x) } else { x }).collect());
    let on2 = |g: &Perm| Perm((0..n as u32).map(|x| if (x as usize) >= b { g.image(x - b as u32) + b as u32 } else { x }).collect());
    let both = |g: &Perm, h: &Perm| on1(g).mul(&on2(h));
    let is_sym = p.order() == named::symmetric(b).order();
    let mut kernels: Vec<Vec<Perm>> = vec![];
    // P x P
    kernels.push(p.gens.iter().map(&on1).chain(p.gens.iter().map(&on2)).collect());
    if is_sym {
        // equal signs: A x A and (t, t) for a transposition
        let a = named::alternating(b);
        let t = Perm::from_cycles(b, &[vec![0, 1]]).unwrap();
        let mut k: Vec<Perm> = a.gens.iter().map(&on1).chain(a.gens.iter().map(&on2)).collect();
        k.push(both(&t, &t));
        kernels.push(k);
    }
    // diagonals
    let mut auts: Vec<Vec<Perm>> = vec![p.gens.clone()];
    if !is_sym {
        let t = Perm::from_cycles(b, &[vec![0, 1]]).unwrap();
        auts.push(p.gens.iter().map(|g| g.conj(&t)).collect());
    } else if b == 6 {
        auts.push(outer_s6(p));
    }
    for im in &auts {
        kernels.push(p.gens.iter().zip(im).map(|(g, h)| both(g, h)).collect());
    }
    let swap = Perm((0..n as u32).map(|x| (x + b as u32) % n as u32).collect());
    let sym = named::symmetric(b);
    let all_u = sym.elements(100_000).unwrap();
    let mut out = vec![];
    for kg in kernels {
        let kk = Group::new(n, kg.clone()).unwrap();
        let ko = kk.order();
        // (u, 1) t and (v u, 1) t with (v, 1) in K give the same group: one u per coset N1 u
        let n1: Vec<Perm> = all_u.iter().filter(|v| kk.contains(&on1(v))).cloned().collect();
        let mut covered: std::collections::HashSet<Perm> = std::collections::HashSet::new();
        for u in &all_u {
            sagebrush_interrupt::check();
            if covered.contains(u) {
                continue;
            }
            for v in &n1 {
                covered.insert(v.mul(u));
            }
            let s = on1(u).mul(&swap);
            let mut gens = kg.clone();
            gens.push(s);
            let g = Group::new(n, gens).unwrap();
            if g.order() == &ko * sagebrush_bigint::BigInt::from(2u32) {
                out.push(g);
            }
        }
    }
    out
}

/// Invariants for bucketing before the conjugacy test.
fn invariant(g: &Group) -> Vec<String> {
    let mut v = vec![g.order().to_string(), min_block_size(g).to_string(), g.blocks_containing(0).len().to_string(), g.stabilizer(0).orbits().len().to_string()];
    v.push(g.derived_subgroup().order().to_string());
    // cycle types: exactly for small groups
    let mut rng = crate::perm::Rng::new(1);
    let (c, exact) = g.cycle_type_counts(200_000, 0, &mut rng);
    if exact {
        v.push(format!("{:?}", c));
    }
    v
}

/// The transitive groups of degree n up to conjugacy, smallest first
/// (degrees up to 12 for now).
fn trace(msg: impl FnOnce() -> String) {
    if std::env::var_os("SAGEBRUSH_GROUP_TRACE").is_some() {
        eprintln!("[transitive] {}", msg());
    }
}

pub fn transitive_groups(n: usize) -> Result<Vec<Group>, String> {
    let t0 = std::time::Instant::now();
    if n <= 9 {
        return crate::lattice::transitive_groups_small(n);
    }
    let mut out: Vec<Group> = primitive::primitive_groups(n)?;
    let limit = 300_000u64;
    for b in (2..n).filter(|b| n % b == 0) {
        let a = n / b;
        let top = named::symmetric(a);
        // the wreath products to search: S_b wr S_a if it is small enough,
        // else P wr S_a for each primitive P of degree b that fits
        let full = wreath(&named::symmetric(b), &top);
        let mut big: Vec<Group> = vec![];
        let ws: Vec<Group> = if full.order() <= limit.into() {
            vec![full]
        } else {
            let prims = if b <= 9 { crate::lattice::transitive_groups_small(b)?.into_iter().filter(|g| g.is_primitive()).collect::<Vec<_>>() } else { primitive::primitive_groups(b)? };
            let mut v = vec![];
            for p in prims {
                let w = wreath(&p, &top);
                if w.order() <= limit.into() {
                    v.push(w);
                } else if a == 2 && (p.order() == named::symmetric(b).order() || p.order() == named::alternating(b).order()) {
                    big.extend(two_block_groups(&p, b));
                } else {
                    return Err(format!("degree {}: the wreath product of a primitive group of order {} (degree {}) with S{} is too big for now", n, p.order(), b, a));
                }
            }
            v
        };
        let mut found: Vec<(Vec<String>, Group, Option<Profile>)> = vec![];
        let add = |g: Group, found: &mut Vec<(Vec<String>, Group, Option<Profile>)>| -> Result<(), String> {
            if !g.is_transitive() || min_block_size(&g) != b {
                return Ok(());
            }
            let inv = invariant(&g);
            for (k, h, prof) in found.iter_mut() {
                if *k == inv {
                    if prof.is_none() {
                        *prof = Some(Profile::new(h, 2_000_000)?);
                    }
                    if conjugate_profiled(&g, h, prof.as_ref().unwrap())? {
                        return Ok(());
                    }
                }
            }
            found.push((inv, g, None));
            Ok(())
        };
        trace(|| format!("b = {}: {} two-block candidates ({:?})", b, big.len(), t0.elapsed()));
        for g in std::mem::take(&mut big) {
            add(g, &mut found)?;
        }
        trace(|| format!("b = {}: {} after the two-block groups ({:?})", b, found.len(), t0.elapsed()));
        for w in ws {
            let lat = Lattice::new(&w, limit as usize)?;
            trace(|| format!("b = {}: lattice of a wreath product of order {}: {} classes ({:?})", b, w.order(), lat.classes.len(), t0.elapsed()));
            for i in 0..lat.classes.len() {
                sagebrush_interrupt::check();
                add(lat.group(i), &mut found)?;
            }
            trace(|| format!("b = {}: {} groups so far ({:?})", b, found.len(), t0.elapsed()));
        }
        out.extend(found.into_iter().map(|(_, g, _)| g));
    }
    out.sort_by(|a, b| a.order().cmp(&b.order()));
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn conjugacy_in_sym() {
        // two regular C2 x C2 x C2... : the two transitive D4 on 4 points are conjugate; C4 is not D4
        let d1 = Group::new(4, vec![Perm::from_cycles(4, &[vec![0, 1, 2, 3]]).unwrap(), Perm::from_cycles(4, &[vec![0, 2]]).unwrap()]).unwrap();
        let d2 = Group::new(4, vec![Perm::from_cycles(4, &[vec![0, 2, 1, 3]]).unwrap(), Perm::from_cycles(4, &[vec![0, 1]]).unwrap()]).unwrap();
        let c4 = named::cyclic(4);
        assert!(conjugate_in_sym(&d1, &d2, 1000).unwrap());
        assert!(!conjugate_in_sym(&d1, &c4, 1000).unwrap());
        // PGL(2,5) on 6 points and S5 acting... both order 120 transitive on 6: conjugate (S5 has one transitive class on 6)
        let p = primitive::projective_line(5, "pgl").unwrap();
        let q = primitive::projective_line(5, "pgl").unwrap();
        let x = Perm::from_cycles(6, &[vec![0, 3, 5]]).unwrap();
        let qc = Group::new(6, q.gens.iter().map(|g| g.conj(&x)).collect()).unwrap();
        assert!(conjugate_in_sym(&p, &qc, 1000).unwrap());
    }

    #[test]
    fn degree_10() {
        assert_eq!(transitive_groups(10).unwrap().len(), 45);
    }
}
