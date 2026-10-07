// For the transitive groups nTk in tables/transitive-<n>.txt write
//   tables/maximal-<n>.txt: the maximal transitive subgroups of each nTk up to
//     conjugacy in nTk (for Alt(n), possibly with a duplicate per class):
//       k ; j:y j:y ...   meaning (nTj)^y <= nTk, y as images of 1..n
//   tables/cycletypes-<n>.txt: the number of elements of each cycle type:
//       k ; type:count ...   a type as its cycle lengths, e.g. 3.3.1
// computed by sagebrush-group (src/embed.rs) from the groups alone.
//   cargo run --release --example write_lattice -- 2 3 ... 12
use num_traits::ToPrimitive;
use sagebrush_group::embed::{few_generators, maximal_transitive, Ambient};
use sagebrush_group::{Group, Perm};
use std::collections::BTreeMap;

const LIMIT: usize = 12_000_000;

fn parse_gens(n: usize, s: &str) -> Vec<Perm> {
    s.split_whitespace().map(|g| Perm::from_images(g.split(',').map(|x| x.parse::<u32>().unwrap() - 1).collect()).unwrap()).filter(|p| p.degree() == n).collect()
}

fn partitions(n: usize, max: usize) -> Vec<Vec<usize>> {
    if n == 0 {
        return vec![vec![]];
    }
    let mut out = vec![];
    for k in (1..=max.min(n)).rev() {
        for mut rest in partitions(n - k, k) {
            rest.insert(0, k);
            out.push(rest);
        }
    }
    out
}

fn factorial(n: usize) -> u128 {
    (1..=n as u128).product()
}

/// n! / z_lambda, the size of the class of cycle type lambda in Sym(n).
fn class_size(n: usize, t: &[usize]) -> u128 {
    let mut z: u128 = 1;
    let mut mult: BTreeMap<usize, u32> = BTreeMap::new();
    for &l in t {
        *mult.entry(l).or_default() += 1;
    }
    for (&l, &m) in &mult {
        z *= (l as u128).pow(m) * factorial(m as usize);
    }
    factorial(n) / z
}

fn type_str(t: &[usize]) -> String {
    t.iter().map(|x| x.to_string()).collect::<Vec<_>>().join(".")
}

fn main() {
    for n in std::env::args().skip(1).map(|a| a.parse::<usize>().unwrap()) {
        let t0 = std::time::Instant::now();
        let groups: Vec<Group> = std::fs::read_to_string(format!("tables/transitive-{}.txt", n))
            .unwrap()
            .lines()
            .filter(|l| !l.starts_with('#') && !l.trim().is_empty())
            .map(|l| Group::new(n, parse_gens(n, l.split(';').nth(1).unwrap())).unwrap())
            .collect();
        let m = groups.len();
        let sym_order = groups[m - 1].order();
        let is_sym = |g: &Group| g.order() == sym_order;
        let is_alt = |g: &Group| n > 2 && g.order() * sagebrush_bigint::BigInt::from(2u32) == sym_order;
        let gens: Vec<Vec<Perm>> = groups.iter().map(few_generators).collect();
        // cycle type counts
        let counts: Vec<Vec<(Vec<usize>, u128)>> = groups
            .iter()
            .map(|g| {
                if is_sym(g) || is_alt(g) {
                    partitions(n, n)
                        .into_iter()
                        .filter(|t| is_sym(g) || t.iter().filter(|&&l| l % 2 == 0).count() % 2 == 0)
                        .map(|t| {
                            let c = class_size(n, &t);
                            (t, c)
                        })
                        .collect()
                } else {
                    let a = Ambient::new(g, LIMIT).unwrap();
                    let mut c: Vec<(Vec<usize>, u128)> = a.type_counts().into_iter().map(|(t, k)| (t, k as u128)).collect();
                    c.sort();
                    c.reverse();
                    c
                }
            })
            .collect();
        let even = |i: usize| counts[i].iter().all(|(t, _)| t.iter().filter(|&&l| l % 2 == 0).count() % 2 == 0);
        let mut ct = format!("# Cycle types of the transitive groups of degree {} (tables/transitive-{}.txt):\n# k ; type:count ...  (computed by examples/write_lattice.rs)\n", n, n);
        for (k, c) in counts.iter().enumerate() {
            let parts: Vec<String> = c.iter().map(|(t, x)| format!("{}:{}", type_str(t), x)).collect();
            ct += &format!("{} ; {}\n", k + 1, parts.join(" "));
        }
        std::fs::write(format!("tables/cycletypes-{}.txt", n), ct).unwrap();
        // does group i embed in group j (as a conjugate)?
        let embeds = |i: usize, amb: &Ambient| amb.conjugates(&gens[i], &mut |_| true);
        let mut out = format!(
            "# Maximal transitive subgroups of the transitive groups of degree {} (tables/transitive-{}.txt),\n\
             # up to conjugacy in the group (for Alt(n) each class may be listed twice).  Per line:\n\
             # k ; j:y ...  meaning (nTj)^y = y^-1 (nTj) y <= nTk, y as images of 1..n\n\
             # (computed by examples/write_lattice.rs, src/embed.rs)\n",
            n, n
        );
        let mut ambients: BTreeMap<usize, Ambient> = BTreeMap::new();
        fn amb<'a>(ambients: &'a mut BTreeMap<usize, Ambient>, groups: &[Group], i: usize) -> &'a Ambient {
            ambients.entry(i).or_insert_with(|| Ambient::new(&groups[i], LIMIT).unwrap())
        }
        for k in 0..m {
            let g = &groups[k];
            let mut maxes: Vec<(usize, Perm)> = vec![];
            if is_sym(g) || is_alt(g) {
                // Alt(n), then the largest groups (odd ones for Sym(n), even ones
                // for Alt(n)) not in a conjugate of one already taken
                let want_even = is_alt(g);
                let mut idx: Vec<usize> = (0..m).filter(|&i| !is_sym(&groups[i]) && !is_alt(&groups[i]) && even(i) == want_even).collect();
                idx.sort_by_key(|&i| std::cmp::Reverse(groups[i].order()));
                if !want_even && n > 2 {
                    maxes.push((m - 2, Perm::identity(n)));
                }
                let mut kept: Vec<usize> = vec![];
                for i in idx {
                    if !kept.iter().any(|&j| groups[j].order() > groups[i].order() && embeds(i, amb(&mut ambients, &groups, j))) {
                        kept.push(i);
                        maxes.push((i, Perm::identity(n)));
                        if want_even {
                            maxes.push((i, Perm::from_cycles(n, &[vec![0, 1]]).unwrap()));
                        }
                    }
                }
            } else {
                let a = amb(&mut ambients, &groups, k);
                let small: Vec<Vec<(Vec<usize>, usize)>> = counts.iter().map(|c| c.iter().map(|(t, k)| (t.clone(), (*k).min(usize::MAX as u128) as usize)).collect()).collect();
                maxes = maximal_transitive(a, &groups, &gens, &small);
            }
            // check: each is a subgroup of the right order
            for (j, y) in &maxes {
                assert!(gens[*j].iter().all(|h| g.contains(&h.conj(y))));
            }
            let parts: Vec<String> = maxes.iter().map(|(j, y)| format!("{}:{}", j + 1, y.0.iter().map(|x| (x + 1).to_string()).collect::<Vec<_>>().join(","))).collect();
            out += &format!("{} ; {}\n", k + 1, parts.join(" "));
            if g.order().to_u64().unwrap_or(u64::MAX) > 20000 {
                eprintln!("  {}T{} (order {}): {} maximal transitive subgroups, {:.1}s", n, k + 1, g.order(), maxes.len(), t0.elapsed().as_secs_f64());
            }
            // free the big tables we no longer need
            ambients.retain(|&i, _| groups[i].order().to_u64().unwrap_or(u64::MAX) < 200_000 || i > k);
        }
        std::fs::write(format!("tables/maximal-{}.txt", n), out).unwrap();
        eprintln!("degree {}: {:.1}s", n, t0.elapsed().as_secs_f64());
    }
}
