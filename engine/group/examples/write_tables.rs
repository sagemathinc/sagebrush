// Write tables/transitive-<n>.txt: the transitive groups of degree n computed by
// this crate (transitive.rs), one per line, smallest order first:
//   order ; generators as image lists (points 1..n)
use sagebrush_group::transitive;
fn main() {
    for n in std::env::args().skip(1).map(|a| a.parse::<usize>().unwrap()) {
        let gs = transitive::transitive_groups(n).unwrap();
        let mut out = format!("# The {} transitive groups of degree {} up to conjugacy, computed by sagebrush-group\n# (src/transitive.rs, from scratch); per line: order ; generators as image lists of 1..{}\n", gs.len(), n, n);
        for g in &gs {
            let gens: Vec<String> = g.gens.iter().map(|p| p.0.iter().map(|x| (x + 1).to_string()).collect::<Vec<_>>().join(",")).collect();
            out += &format!("{} ; {}\n", g.order(), gens.join(" "));
        }
        std::fs::create_dir_all("tables").unwrap();
        std::fs::write(format!("tables/transitive-{}.txt", n), out).unwrap();
        eprintln!("degree {}: {} groups", n, gs.len());
    }
}
