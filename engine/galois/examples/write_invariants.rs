// Write tables/invariants-<n>.txt: for each maximal transitive subgroup K
// (number mi in tables/maximal-<n>.txt, from 0) of each nTk, the seed of a
// relative invariant F with Stab_{nTk}(F) = K, found by find_invariant (an
// orbit sum of monomials or a product of linear forms):
//   k:mi ; m p^e ...   or   k:mi ; p U/V ...
//   cargo run --release --example write_invariants -- 2 3 ... 13
fn main() {
    for n in std::env::args().skip(1).map(|a| a.parse::<usize>().unwrap()) {
        let t0 = std::time::Instant::now();
        let groups = sagebrush_galois::tables::transitive_groups(n);
        let mut out = format!(
            "# Relative invariants for the maximal transitive subgroups of the transitive groups of\n\
             # degree {} (engine/group/tables/maximal-{}.txt), found by sagebrush-galois\n\
             # (examples/write_invariants.rs).  Per line, k:mi ; seed, where mi numbers the maximal\n\
             # subgroups of nTk from 0 and the seed is \"m p^e ...\" (the orbit sum of a monomial)\n\
             # or \"p U/V ...\" (the product over the orbits of these linear forms), points 1..n.\n",
            n, n
        );
        for g in groups {
            for mi in 0..g.maximal.len() {
                out += &format!("{}:{} ; {}\n", g.k, mi, sagebrush_galois::find_invariant_seed(n, g.k, mi));
            }
        }
        std::fs::write(format!("tables/invariants-{}.txt", n), out).unwrap();
        eprintln!("degree {}: {:.1}s", n, t0.elapsed().as_secs_f64());
    }
}
