//! Stop in the Heilbronn kernels: Cremona's continued fractions, Merel's
//! loops and a Hecke prime's images check as they go, so a large prime on a
//! small space stops within one matrix's work; and the twisted traces' CRT
//! checks once a digit.  (A file of its own: the
//! Stop hooks are global.  Native only: a Stop unwinds.)

#![cfg(not(target_arch = "wasm32"))]

use sagebrush_interrupt::hooks;
use sagebrush_modsym::general::{heilbronn_merel, Character, GeneralSpace};
use sagebrush_modsym::linalg::heilbronn;
use sagebrush_modsym::traces::{hecke_primes, pins};

fn checks(f: impl FnOnce()) -> u64 {
    sagebrush_interrupt::clear();
    hooks::reset();
    f();
    let t = hooks::total();
    hooks::reset();
    t
}

#[test]
fn heilbronn_kernels_stop() {
    // Cremona: a check per continued fraction (q of them, of O(log q)
    // steps); Merel: one per a, per d and per c
    let q = 10007;
    assert!(checks(|| drop(heilbronn(q))) >= q as u64);
    let p = 211;
    // (one per a, per d and per c: 217,562 at p = 211; without the c loop's,
    // 43,564)
    assert!(checks(|| drop(heilbronn_merel(p))) > 4 * (p * p) as u64);
    // a large Hecke prime on a small space: a check per Heilbronn matrix's
    // image at least, so the checks outnumber the matrices
    let eps = Character::trivial(11);
    let sp = GeneralSpace::new(11, 2, &eps, 0).unwrap();
    let q = 20011u64;
    let want = sp.hecke_matrix(q).unwrap();
    let total = checks(|| drop(sp.hecke_matrix(q).unwrap()));
    assert!(total > heilbronn(q as i64).len() as u64, "{} checks", total);
    // the longest time between two checks over the whole T_q, traced
    sagebrush_interrupt::clear();
    hooks::reset();
    hooks::trace();
    let _ = sp.hecke_matrix(q).unwrap();
    let gap = hooks::max_gap_ns();
    hooks::reset();
    assert!(gap < 50_000_000, "a gap of {} ns between checks", gap);
    // a Stop at checks spread over T_q stops it, and the next call answers
    for i in 1..=6 {
        let at = (total * i / 6).max(1);
        sagebrush_interrupt::clear();
        hooks::reset();
        hooks::arm_at(at);
        let r = sagebrush_interrupt::catch(|| sp.hecke_matrix(q).unwrap());
        hooks::reset();
        sagebrush_interrupt::clear();
        assert!(r.is_err(), "stopped at check {} of {}", at, total);
        assert_eq!(sp.hecke_matrix(q).unwrap(), want);
    }
    // the CRT: r primes, a check per inverse and per digit of each entry
    let ls: Vec<u64> = hecke_primes(1).take(300).collect();
    let residues: Vec<(u64, Vec<Vec<u64>>)> = ls.iter().map(|&l| (l, vec![vec![7], vec![l - 5]])).collect();
    let mut out = vec![];
    let n = checks(|| out = pins::crt(&residues, 1, 1));
    assert!(n >= 300 + 2 * 300, "{} checks", n);
    assert_eq!(out.iter().map(|c| c[0].to_string()).collect::<Vec<_>>(), ["7", "-5"]);
}
