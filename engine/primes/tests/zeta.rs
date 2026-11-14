// The zeros of zeta against mpmath's (tests/zeta_reference.txt, from gen/zeta_reference.py): each gamma_n
// within 10^-13 + 10^-14 gamma_n (the worst seen natively is 1.5 10^-15 gamma_n), whether asked for alone
// or in a run; runs that start inside a Gram block, and the refusals.
use sagebrush_primes::zeta::{gram_point, theta, z};
use sagebrush_primes::{zeta_zeros, ZETA_ZERO_INDEX_MAX};

fn reference() -> Vec<(u64, f64)> {
    include_str!("zeta_reference.txt")
        .lines()
        .filter(|l| !l.starts_with('#'))
        .map(|l| {
            let (n, g) = l.split_once(' ').unwrap();
            (n.parse().unwrap(), g.parse().unwrap())
        })
        .collect()
}

fn close(got: f64, want: f64) -> bool {
    (got - want).abs() <= 1e-13 + 1e-14 * want
}

#[test]
fn the_first_300_zeros_in_one_run() {
    let r = reference();
    let got = zeta_zeros(1, 300).unwrap();
    for (n, want) in r.iter().filter(|(n, _)| *n <= 300) {
        let g = got[*n as usize - 1];
        assert!(close(g, *want), "gamma_{n} = {g}, not {want}");
    }
}

#[test]
fn every_reference_zero_alone_and_in_its_run() {
    let r = reference();
    for (n, want) in &r {
        let g = zeta_zeros(*n, 1).unwrap();
        assert!(g.len() == 1 && close(g[0], *want), "gamma_{n} alone = {g:?}, not {want}");
    }
    // the runs of 21 (and Lehmer's pair, 6700..6719) from their first n
    for start in [990u64, 9990, 99_990, 999_990, 9_999_980, 6700] {
        let run: Vec<_> = r.iter().filter(|(n, _)| *n >= start && *n < start + 21).collect();
        let got = zeta_zeros(start, run.len() as u64).unwrap();
        for ((n, want), g) in run.iter().zip(&got) {
            assert!(close(*g, *want), "gamma_{n} in a run = {g}, not {want}");
        }
    }
}

#[test]
fn zeros_increase_and_z_vanishes_there() {
    let got = zeta_zeros(1000, 200).unwrap();
    assert!(got.windows(2).all(|w| w[0] < w[1]));
    for g in got {
        // Z changes sign across each zero
        let h = 1e-9 * g;
        assert!((z(g - h) > 0.0) != (z(g + h) > 0.0), "no sign change at {g}");
    }
}

#[test]
fn theta_and_gram_points() {
    // theta is odd; g_j is where theta = j pi; Gram's law holds at g_0..g_125 and first fails at g_126
    assert_eq!(theta(-50.0), -theta(50.0));
    for j in [-1i64, 0, 5, 125, 126, 10_000] {
        let g = gram_point(j);
        assert!((theta(g) / std::f64::consts::PI - j as f64).abs() < 1e-12, "j = {j}");
    }
    for j in 0..126 {
        let zj = z(gram_point(j));
        assert!(if j % 2 == 0 { zj > 0.0 } else { zj < 0.0 }, "Gram's law at g_{j}");
    }
    let z126 = z(gram_point(126));
    assert!(z126 < 0.0, "Gram's law fails at g_126");
}

#[test]
fn refusals() {
    assert!(zeta_zeros(0, 1).is_err());
    assert!(zeta_zeros(ZETA_ZERO_INDEX_MAX, 2).is_err());
    assert!(zeta_zeros(u64::MAX, 2).is_err());
    assert_eq!(zeta_zeros(5, 0).unwrap(), Vec::<f64>::new());
    assert_eq!(zeta_zeros(ZETA_ZERO_INDEX_MAX, 1).unwrap().len(), 1);
}
