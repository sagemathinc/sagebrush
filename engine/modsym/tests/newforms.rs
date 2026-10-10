//! Rational newforms against Cremona's tables: for every level N <= 300,
//! the multiset of (a_p for good p < 100) vectors equals Cremona's isogeny
//! classes of conductor N (fixtures/cremona_aplist_le300.txt).

use sagebrush_modsym::newforms::{newform_aps, rational_newforms};
use std::collections::HashMap;

#[test]
fn rational_newforms_match_cremona_up_to_300() {
    let primes: Vec<u64> = (2..100).filter(|&q| (2..q).all(|d| q % d != 0)).collect();
    let mut cremona: HashMap<u64, Vec<Vec<i64>>> = HashMap::new();
    for line in include_str!("fixtures/cremona_aplist_le300.txt").lines() {
        let w: Vec<&str> = line.split_whitespace().collect();
        let n: u64 = w[0].parse().unwrap();
        let aps = primes.iter().zip(&w[2..]).filter(|(q, _)| n % **q != 0).map(|(_, a)| a.parse().unwrap()).collect();
        cremona.entry(n).or_default().push(aps);
    }
    let mut total = 0;
    for n in 1..=300 {
        let forms = newform_aps(n, 40).unwrap();
        let mut ours: Vec<Vec<i64>> = forms.iter().map(|f| f.iter().filter(|x| x.0 < 100).map(|x| x.1).collect()).collect();
        let mut theirs = cremona.get(&n).cloned().unwrap_or_default();
        ours.sort();
        theirs.sort();
        assert_eq!(ours, theirs, "N={}", n);
        total += ours.len();
    }
    assert_eq!(total, cremona.values().map(|v| v.len()).sum::<usize>());
}

#[test]
fn a_p_satisfy_hasse_and_known_values() {
    // 11a: q - 2q^2 - q^3 + 2q^4 + q^5 + 2q^6 - 2q^7 ...; 37a: a_2 = -2, a_3 = -3.
    let f11 = rational_newforms(11, 1000, 40).unwrap();
    assert_eq!(f11.forms.len(), 1);
    assert_eq!(&f11.forms[0].ap[..4], &[(2, -2), (3, -1), (5, 1), (7, -2)]);
    assert!(f11.forms[0].hasse_ok());
    // checked (Hasse; the same modulo a second prime), and saying so
    assert_eq!(f11.status, "checked");
    assert_eq!(f11.checks.len(), 2);
    // Level 37 has two rational newforms: 37a (a_2 = -2, a_3 = -3) and 37b (a_2 = 0, a_3 = 1).
    let f37 = rational_newforms(37, 100, 40).unwrap();
    let firsts: Vec<_> = f37.forms.iter().map(|f| (f.ap[0], f.ap[1])).collect();
    assert_eq!(firsts, vec![((2, -2), (3, -3)), ((2, 0), (3, 1))]);
}
