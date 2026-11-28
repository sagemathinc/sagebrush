use sagebrush_group::{primitive, Group};
fn inv(g: &Group) -> String {
    format!("{} {} {} {} {} {} {} {}", g.order(), g.is_primitive().unwrap() as u8, g.is_solvable().unwrap() as u8, g.is_abelian() as u8,
        g.transitivity().unwrap(), g.blocks_containing(0).unwrap().len(), g.derived_subgroup().unwrap().order(), g.stabilizer(0).unwrap().order())
}
fn main() {
    let data = std::fs::read_to_string("tests/data/transitive-2-15.txt").unwrap();
    for n in [5usize, 7, 10, 11, 12, 13] {
        let mut theirs: Vec<String> = data.lines().filter(|l| l.starts_with(&format!("{} ", n))).map(|l| {
            let f: Vec<&str> = l.split_once(';').unwrap().0.split_whitespace().collect();
            f[2..10].join(" ")
        }).filter(|s| s.split(' ').nth(1) == Some("1")).collect();
        let mut mine: Vec<String> = primitive::primitive_groups(n).unwrap().iter().map(inv).collect();
        theirs.sort(); mine.sort();
        println!("degree {}: {} primitive, agree with Magma: {}", n, mine.len(), theirs == mine);
        if theirs != mine { println!("  ours   {:?}\n  Magma  {:?}", mine, theirs); }
    }
}
