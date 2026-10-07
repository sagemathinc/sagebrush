// Put tables/transitive-<n>.txt (our own groups, computed by transitive.rs)
// into the standard numbering nTk of the transitive groups library
// (Butler-McKay, Royle, Hulpke), as used by GAP, Magma and the LMFDB.
// The numbering and the names come from GAP, used as an oracle: GAP's
// generators (tests/data/gap-transitive.txt, made by tests/gap-transitive.g)
// are only used to decide which of our groups is conjugate in Sym(n) to its
// group number k.  Our generators are kept.
//   cargo run --release --example label_tables -- 2 3 ... 12
use sagebrush_group::transitive::{conjugate_profiled, Profile};
use sagebrush_group::{Group, Perm};

fn parse_gens(n: usize, s: &str) -> Vec<Perm> {
    s.split_whitespace()
        .map(|g| Perm::from_images(g.trim_end_matches(',').split(',').map(|x| x.parse::<u32>().unwrap() - 1).collect()).unwrap())
        .filter(|p| p.degree() == n)
        .collect()
}

fn main() {
    let gap = std::fs::read_to_string("tests/data/gap-transitive.txt").unwrap();
    for n in std::env::args().skip(1).map(|a| a.parse::<usize>().unwrap()) {
        let ours: Vec<(String, Group)> = std::fs::read_to_string(format!("tables/transitive-{}.txt", n))
            .unwrap()
            .lines()
            .filter(|l| !l.starts_with('#') && !l.trim().is_empty())
            .map(|l| {
                let f: Vec<&str> = l.split(';').collect();
                (f[1].trim().to_string(), Group::new(n, parse_gens(n, f[1])).unwrap())
            })
            .collect();
        let theirs: Vec<(usize, Group, String)> = gap
            .lines()
            .filter(|l| l.starts_with(&format!("{} ", n)))
            .map(|l| {
                let f: Vec<&str> = l.splitn(3, ';').collect();
                let k = f[0].split_whitespace().nth(1).unwrap().parse().unwrap();
                (k, Group::new(n, parse_gens(n, f[1])).unwrap(), f[2].trim().to_string())
            })
            .collect();
        assert_eq!(ours.len(), theirs.len());
        let mut used = vec![false; ours.len()];
        let mut out = format!(
            "# The {} transitive groups of degree {} up to conjugacy, computed by sagebrush-group\n\
             # (src/transitive.rs, from scratch).  Line k is the group nTk: the standard numbering\n\
             # and the names (last field) were matched against GAP's transitive groups library,\n\
             # used as an oracle (examples/label_tables.rs).  Per line:\n\
             # order ; generators as image lists of 1..{} ; name\n",
            ours.len(),
            n,
            n
        );
        // invariants of conjugacy classes: candidates must agree on them
        let key = |g: &Group| -> String {
            let mut rng = sagebrush_group::Rng::new(1);
            let (c, _) = g.cycle_type_counts(3_000_000, 0, &mut rng);
            format!("{} {:?} {} {} {}", g.order(), c, g.blocks_containing(0).len(), g.derived_subgroup().order(), g.stabilizer(0).orbits().len())
        };
        let our_keys: Vec<String> = ours.iter().map(|(_, g)| key(g)).collect();
        for (k, h, name) in &theirs {
            let hk = key(h);
            let cands: Vec<usize> = (0..ours.len()).filter(|&i| !used[i] && our_keys[i] == hk).collect();
            let i = if cands.len() == 1 {
                cands[0]
            } else {
                let prof = Profile::new(h, 3_000_000).unwrap();
                *cands.iter().find(|&&i| conjugate_profiled(&ours[i].1, h, &prof).unwrap()).unwrap_or_else(|| panic!("{}T{}: no match", n, k))
            };
            used[i] = true;
            out += &format!("{} ; {} ; {}\n", h.order(), ours[i].0, name);
        }
        std::fs::write(format!("tables/transitive-{}.txt", n), out).unwrap();
        eprintln!("degree {}: labeled {} groups", n, ours.len());
    }
}
