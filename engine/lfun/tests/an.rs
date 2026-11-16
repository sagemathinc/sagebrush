// a_n against tests/an_reference.txt (Sage's anlist, run as an oracle by gen/an_reference.sage), on
// minimal models and on a non-minimal one; and the refusals.
use sagebrush_lfun::{anlist, Local};

fn local(name: &str) -> Vec<Local> {
    let bad = |v: &[(u64, i64)]| v.iter().map(|&(p, ap)| Local { p, ap, good: false }).collect();
    match name {
        "11a1" => bad(&[(11, 1)]),
        "37a1" => bad(&[(37, -1)]),
        "27a1" => bad(&[(3, 0)]),
        "N99974" => bad(&[(2, -1), (7, -1), (37, -1), (193, 1)]),
        _ => unreachable!(),
    }
}

#[test]
fn anlist_against_sage() {
    let mut it = include_str!("an_reference.txt").lines().filter(|l| !l.starts_with('#'));
    let mut curves = 0;
    while let (Some(head), Some(values)) = (it.next(), it.next()) {
        let w: Vec<&str> = head.split_whitespace().collect();
        let a = [0, 1, 2, 3, 4].map(|i| w[2 + i].parse().unwrap());
        let want: Vec<i64> = values.split_whitespace().map(|x| x.parse().unwrap()).collect();
        let got = anlist(a, &local(w[1]), want.len()).unwrap();
        assert_eq!(got[0], 0);
        assert_eq!(&got[1..], &want[..], "{}", w[1]);
        curves += 1;
    }
    assert_eq!(curves, 4);
}

#[test]
fn a_non_minimal_model_with_a_good_prime_dividing_its_discriminant() {
    // 11a1 with x = 4 x', y = 8 y': the discriminant gains 2^12, and 2 stays a good prime (a_2 = -2)
    let minimal = anlist([0, -1, 1, -10, -20], &local("11a1"), 500).unwrap();
    let mut loc = local("11a1");
    assert!(anlist([0, -4, 8, -160, -1280], &loc, 500).is_err(), "a_2 is needed");
    loc.push(Local { p: 2, ap: -2, good: true });
    assert_eq!(anlist([0, -4, 8, -160, -1280], &loc, 500).unwrap(), minimal);
}

#[test]
fn refusals() {
    assert!(anlist([0, -1, 1, -10, -20], &[], 100).is_err(), "11 divides the discriminant");
    assert!(anlist([0, -1, 1, -10, -20], &[Local { p: 11, ap: 2, good: false }], 100).is_err());
    assert!(anlist([0, 0, 0, 0, 0], &[], 10).is_err(), "singular");
    assert!(anlist([0, -1, 1, -10, -20], &local("11a1"), sagebrush_lfun::an::MAX_TERMS + 1).is_err());
    assert_eq!(anlist([0, -1, 1, -10, -20], &local("11a1"), 0).unwrap(), vec![0]);
}
