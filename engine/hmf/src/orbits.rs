//! The orbits of the icosian group R^x_1 on P^1(O_F/N), a basis of the
//! space M_2^B(N) = C[R^x \ P^1(O_F/N)] of weight 2 quaternionic modular
//! forms (Dembélé 2005, Proposition 3.1), ported from PSAGE's
//! IcosiansModP1ModN.compute_std_to_rep_table.
//!
//! As in PSAGE, orbits are numbered in the order of their least standard
//! index, which is their representative. The action is componentwise, so
//! each generator acts on each local factor by a permutation table, and
//! orbits are found by a search over the generators rather than all 120
//! elements. PSAGE's two consistency checks are kept: orbits are disjoint
//! (automatic here), and every orbit size divides 60 = #(R^x_1 / {+-1}),
//! which fails if the local splittings or the arithmetic are wrong.

use crate::p1::P1;
use crate::quat::Quat;
use crate::split::LocalSplitting;

pub struct Orbits {
    /// orbit[i] = the number of the orbit of the point with global index i.
    pub orbit: Vec<u32>,
    /// reps[j] = the least global index in orbit j.
    pub reps: Vec<u64>,
    /// sizes[j] = the number of points in orbit j.
    pub sizes: Vec<u32>,
}

/// Local permutation tables of g on each factor of P^1.
pub fn local_permutations(p1: &P1, splittings: &[LocalSplitting], g: &Quat) -> Result<Vec<Vec<u32>>, String> {
    let c = g.to_e().ok_or("element not in R")?;
    p1.locals
        .iter()
        .zip(splittings)
        .map(|(l, s)| {
            let m = s.image(&l.ring, &c);
            (0..l.size).map(|i| l.act(&m, i).map(|j| j as u32).ok_or_else(|| "a unit of R acted singularly on P^1".to_string())).collect()
        })
        .collect()
}

impl Orbits {
    pub fn new(p1: &P1, splittings: &[LocalSplitting], gens: &[Quat]) -> Result<Orbits, String> {
        let perms: Vec<Vec<Vec<u32>>> = gens.iter().map(|g| local_permutations(p1, splittings, g)).collect::<Result<_, _>>()?;
        let n = p1.size as usize;
        let r = p1.locals.len();
        let mut orbit = vec![u32::MAX; n];
        let (mut reps, mut sizes) = (vec![], vec![]);
        let mut stack = vec![];
        let mut digits = vec![0u64; r];
        for start in 0..n {
            if orbit[start] != u32::MAX {
                continue;
            }
            let id = reps.len() as u32;
            reps.push(start as u64);
            orbit[start] = id;
            stack.push(start as u64);
            let mut size = 1u32;
            while let Some(x) = stack.pop() {
                p1.digits(x, &mut digits);
                for perm in &perms {
                    let y: u64 = (0..r).map(|k| perm[k][digits[k] as usize] as u64 * p1.radix[k]).sum();
                    if orbit[y as usize] == u32::MAX {
                        orbit[y as usize] = id;
                        size += 1;
                        stack.push(y);
                    }
                }
            }
            if 60 % size != 0 {
                return Err(format!("orbit of size {} does not divide 60: the local splittings are inconsistent", size));
            }
            sizes.push(size);
        }
        Ok(Orbits { orbit, reps, sizes })
    }
    pub fn len(&self) -> usize {
        self.reps.len()
    }
}
