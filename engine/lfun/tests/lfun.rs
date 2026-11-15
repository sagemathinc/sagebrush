// L(E, s) against tests/lfun_reference.txt: PARI/GP's lfun at 38 digits (run as an oracle by
// gen/lfun_reference.sage) for fourteen curves, ranks 0 to 5, with and without CM, conductors 11 to
// 22,329,098, at points inside and outside the critical strip and up to |Im s| = 1000.
use sagebrush_lfun::{anlist, root_number, terms_needed, LSeries, Local, C64};

struct Curve {
    name: String,
    a: [i64; 5],
    conductor: u64,
    eps: i32,
    local: Vec<Local>,
    values: Vec<(C64, C64)>,
}

fn reference() -> Vec<Curve> {
    let mut out: Vec<Curve> = vec![];
    for line in include_str!("lfun_reference.txt").lines() {
        if line.starts_with('#') || line.is_empty() {
            continue;
        }
        let w: Vec<&str> = line.split_whitespace().collect();
        if w[0] == "curve" {
            let a = [0, 1, 2, 3, 4].map(|i| w[2 + i].parse().unwrap());
            let local = w[9..]
                .iter()
                .map(|pa| {
                    let (p, ap) = pa.split_once(':').unwrap();
                    Local { p: p.parse().unwrap(), ap: ap.parse().unwrap(), good: false }
                })
                .collect();
            out.push(Curve { name: w[1].into(), a, conductor: w[7].parse().unwrap(), eps: w[8].parse().unwrap(), local, values: vec![] });
        } else {
            let f: Vec<f64> = w.iter().map(|x| x.parse().unwrap()).collect();
            out.last_mut().unwrap().values.push((C64::new(f[0], f[1]), C64::new(f[2], f[3])));
        }
    }
    out
}

#[test]
fn values_and_root_numbers_against_pari() {
    let mut worst = 0f64;
    for c in reference() {
        let m = c.values.iter().map(|&(s, _)| terms_needed(c.conductor, s).unwrap()).max().unwrap();
        let m = m.max(terms_needed(c.conductor, C64::new(1.1, 0.37)).unwrap() * 2) + 1;
        let an = anlist(c.a, &c.local, m).unwrap();
        assert_eq!(root_number(&an, c.conductor), Ok(c.eps), "{}: root number", c.name);
        let l = LSeries::new(&an, c.conductor, c.eps).unwrap();
        for &(s, want) in &c.values {
            let got = l.value(s).unwrap();
            let err = (got - want).abs() / want.abs().max(1.0);
            worst = worst.max(err);
            eprintln!("{:>10} s = {:>5}{:+}i  err {:.1e}", c.name, s.re, s.im, err);
            assert!(err < 1e-11, "{}: L({:?}) = {:?}, PARI {:?} (error {:.1e})", c.name, s, got, want, err);
        }
    }
    eprintln!("largest error {:.2e}", worst);
}
