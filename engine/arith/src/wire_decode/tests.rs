use super::*;
use crate::coprime::{gcd_in_place, gcd_work, pair_work, row_entry_work, row_fixed_work, Fault, Meter};
use dashu_int::UBig;
use sagebrush_wire::{mqr1, qv1, zv1, Arg, ElemKind};

// ---------------------------------------------------------------- payloads

type Int = (bool, Vec<u64>);

fn int(neg: bool, x: &UBig) -> Int {
    (neg, x.as_words().iter().copied().filter(|_| *x != UBig::ZERO).collect())
}

fn pos(x: &UBig) -> Int {
    int(false, x)
}

fn small(v: i64) -> Int {
    int(v < 0, &UBig::from(v.unsigned_abs()))
}

fn put_zv(out: &mut Vec<u8>, xs: &[Int]) {
    out.extend_from_slice(b"ZV_1");
    out.extend_from_slice(&(xs.len() as u64).to_le_bytes());
    for (neg, l) in xs {
        out.extend_from_slice(&(((l.len() as u32) << 1) | u32::from(*neg)).to_le_bytes());
        for w in l {
            out.extend_from_slice(&w.to_le_bytes());
        }
    }
}

fn qv_bytes(nums: &[Int], dens: &[Int]) -> Vec<u8> {
    let mut b = b"QV_1".to_vec();
    put_zv(&mut b, nums);
    put_zv(&mut b, dens);
    b
}

fn mqr_bytes(cols: usize, rows: &[Vec<Int>]) -> Vec<u8> {
    let mut b = b"MQR1".to_vec();
    b.extend_from_slice(&(rows.len() as u32).to_le_bytes());
    b.extend_from_slice(&(cols as u32).to_le_bytes());
    for r in rows {
        put_zv(&mut b, r);
    }
    b
}

const BASE: u64 = 1000;

fn arg(b: &[u8]) -> Arg<'_> {
    Arg { bytes: b, offset: BASE }
}

fn rnd(words: usize, seed: &mut u64) -> UBig {
    let v: Vec<u64> = (0..words)
        .map(|_| {
            *seed ^= *seed << 13;
            *seed ^= *seed >> 7;
            *seed ^= *seed << 17;
            *seed
        })
        .collect();
    UBig::from_words(&v)
}

fn fib(k: usize) -> (UBig, UBig) {
    let (mut a, mut b) = (UBig::ZERO, UBig::ONE);
    for _ in 0..k {
        let c = &a + &b;
        a = b;
        b = c;
    }
    (b, a)
}

fn gcd_ref(x: &UBig, y: &UBig) -> UBig {
    dashu_int::ops::Gcd::gcd(x, y)
}

/// gcd_in_place on x, y: the gcd, the meter's units, the bound.
fn run(x: &UBig, y: &UBig) -> (UBig, u64, u64) {
    let (lx, ly) = (x.as_words().len() * usize::from(*x != UBig::ZERO), y.as_words().len() * usize::from(*y != UBig::ZERO));
    let l = lx.max(ly);
    let mut ws = vec![0u64; 2 * (l + 1)];
    let (s0, s1) = ws.split_at_mut(l + 1);
    s0[..lx].copy_from_slice(&x.as_words()[..lx]);
    s1[..ly].copy_from_slice(&y.as_words()[..ly]);
    let bound = gcd_work(lx as u64, ly as u64).unwrap();
    let mut m = Meter::new(bound);
    let (slot, n) = gcd_in_place(s0, lx, s1, ly, &mut m).unwrap();
    let (g, other) = if slot { (&s1[..n], &s0[..]) } else { (&s0[..n], &s1[..]) };
    assert!(other.iter().all(|&w| w == 0), "the other slot is not zero");
    (UBig::from_words(g), m.used(), bound)
}

/// The shapes of the sweep at `w` limbs: random, a common factor, equal,
/// zero, one, unbalanced against 1 limb and against w/2, all-ones limbs
/// (gcd 2^(64 gcd(i, j)) - 1), top bits only.
fn shapes(w: usize, seed: &mut u64) -> Vec<(UBig, UBig)> {
    let a = rnd(w, seed);
    let b = rnd(w, seed);
    let g = rnd(1 + w / 3, seed);
    let ones = |k: usize| (UBig::ONE << (64 * k)) - UBig::ONE;
    vec![
        (a.clone(), b.clone()),
        (&a * &g, &b * &g),
        (a.clone(), a.clone()),
        (a.clone(), UBig::ZERO),
        (a.clone(), UBig::ONE),
        (a.clone(), rnd(1, seed)),
        (a.clone(), rnd((w / 2).max(1), seed)),
        (ones(w), ones((w / 2).max(1))),
        (ones(w), ones(w.saturating_sub(1).max(1))),
        (UBig::ONE << (64 * w - 1), (UBig::ONE << (64 * w - 1)) - UBig::ONE),
        (b, a),
    ]
}

#[test]
fn the_gcd_is_dashus_and_its_work_within_the_bound() {
    let mut seed = 0x9e37_79b9_7f4a_7c15u64;
    let mut worst: f64 = 0.0;
    for &w in &[1usize, 2, 3, 4, 5, 8, 17, 33, 64, 100, 257, 1000] {
        for _ in 0..6 {
            for (x, y) in shapes(w, &mut seed) {
                let (g, used, bound) = run(&x, &y);
                assert_eq!(g, gcd_ref(&x, &y), "{} limbs", w);
                assert!(used <= bound, "{} limbs: {} units over the bound {}", w, used, bound);
                if y != UBig::ZERO {
                    // (b = 0 is charged exactly: one comparison)
                    worst = worst.max(used as f64 / bound as f64);
                }
            }
        }
    }
    // consecutive Fibonacci numbers: the most Euclidean steps per bit
    for k in [100usize, 1000, 30_000] {
        let (x, y) = fib(k);
        let (g, used, bound) = run(&x, &y);
        assert_eq!(g, UBig::ONE);
        assert!(used <= bound);
        worst = worst.max(used as f64 / bound as f64);
        let m = rnd(20, &mut seed);
        let (g, used, bound) = run(&(&x * &m), &(&y * &m));
        assert_eq!(g, m);
        assert!(used <= bound);
    }
    eprintln!("the largest share of the work bound used: {:.5}", worst);
}

#[test]
fn work_bounds_are_the_closed_forms() {
    // gcd_work(la, lb) = T (4 la + 3 lb + 101) + (la + 2 T)(2 lb + 4) + 3 la + 95,
    // T = 93 lb + 2
    let f = |la: u64, lb: u64| {
        let t = 93 * lb + 2;
        t * (4 * la + 3 * lb + 101) + (la + 2 * t) * (2 * lb + 4) + 3 * la + 95
    };
    assert_eq!(gcd_work(1, 1), Some(11504));
    for (a, b) in [(1, 1), (2, 1), (5, 3), (16384, 16384), (16384, 1), (100, 7)] {
        assert_eq!(gcd_work(a, b), Some(f(a, b)));
        assert_eq!(gcd_work(b, a), Some(f(a, b)));
    }
    assert_eq!(gcd_work(9, 0), Some(11));
    assert_eq!(pair_work(5, 3), Some(f(5, 3) + 5 + 3 + 2 + 2 * (5 + 2)));
    assert_eq!(row_entry_work(0, 7), Some(0));
    assert_eq!(row_entry_work(5, 3), Some(f(5, 3) + 5 + 3 + 5 + 4));
    assert_eq!(row_fixed_work(3, 9), Some(3 + 9 + 3));
    // checked: overflow is None, never a wrapped or saturated charge
    assert_eq!(gcd_work(u64::MAX, 1), None);
    assert_eq!(gcd_work(1 << 40, 1 << 40), None);
    assert_eq!(pair_work(u64::MAX, 0), None);
    assert_eq!(workspace_words(u64::MAX), None);
    assert_eq!(workspace_words(16384), Some(2 * 16385));
}

#[test]
fn a_workspace_one_word_short_is_an_invariant_failure() {
    let mut seed = 7u64;
    let (x, y) = (rnd(6, &mut seed), rnd(5, &mut seed));
    let p = qv_bytes(&[pos(&x)], &[pos(&y)]);
    let q = qv1(arg(&p)).unwrap();
    let (n, d) = (q.num.iter().next().unwrap(), q.den.iter().next().unwrap());
    let mut m = Meter::new(u64::MAX);
    let mut ws = vec![0u64; 2 * 7];
    assert_eq!(coprime::coprime_pair(&mut ws, &n, &d, &mut m), Ok(gcd_ref(&x, &y) == UBig::ONE));
    assert!(ws.iter().all(|&w| w == 0), "the workspace is left zero");
    let mut short = vec![0u64; 2 * 7 - 1];
    assert_eq!(coprime::coprime_pair(&mut short, &n, &d, &mut m), Err(Fault::Invariant));
}

// ---------------------------------------------------------------- QV_1

fn size_of_vec(n: usize) -> u64 {
    (n * size_of::<BigInt>() + size_of::<Vec<BigInt>>()) as u64
}

#[test]
fn qv_needs_and_decodes() {
    let mut seed = 11u64;
    let (a, b, c) = (rnd(3, &mut seed), rnd(4, &mut seed), rnd(1, &mut seed));
    let g = gcd_ref(&a, &b);
    let (a, b) = (&a / &g, &b / &g);
    // a/b (checked), 0/1 and 5/1 and -1/7 (evident), -c/(c+1) (checked)
    let nums = [pos(&a), small(0), small(5), small(-1), int(true, &c)];
    let dens = [pos(&b), small(1), small(1), small(7), pos(&(&c + UBig::ONE))];
    let p = qv_bytes(&nums, &dens);
    let q = qv1(arg(&p)).unwrap();
    let need = need_qv(&q).unwrap();
    let la = a.as_words().len() as u64;
    let lb = b.as_words().len() as u64;
    let lc1 = (&c + UBig::ONE).as_words().len() as u64;
    assert_eq!(need.work, pair_work(la, lb).unwrap() + pair_work(1, lc1).unwrap());
    let heap = |k: u64| sagebrush_wire::bigint_heap_words(k).unwrap();
    let l = la.max(lb).max(lc1);
    let bytes = 2 * size_of_vec(5) + 8 * (heap(la) + heap(lb) + heap(1) + heap(lc1) + heap(1) + 2 * heap(1)) + 8 * 2 * (l + 1);
    assert_eq!(need.bytes, bytes);
    let (n, d) = decode_qv(&q, &need).unwrap();
    let want_n: Vec<BigInt> = [BigInt::from_bytes_le(Sign::Plus, &a.to_le_bytes()), 0.into(), 5.into(), (-1).into(), -BigInt::from_bytes_le(Sign::Plus, &c.to_le_bytes())].into();
    assert_eq!(n, want_n);
    assert_eq!(d[0], BigInt::from_bytes_le(Sign::Plus, &b.to_le_bytes()));
    assert_eq!(d[3], 7.into());
    // all evident: no work, no workspace
    let p = qv_bytes(&[small(0), small(3)], &[small(1), small(1)]);
    let need = need_qv(&qv1(arg(&p)).unwrap()).unwrap();
    assert_eq!(need, Need { bytes: 2 * size_of_vec(2), work: 0 });
}

#[test]
fn a_rational_not_in_lowest_terms_is_refused_at_its_numerator() {
    let mut seed = 3u64;
    let g = rnd(2, &mut seed);
    let (x, y) = (&rnd(4, &mut seed) * &g, &rnd(3, &mut seed) * &g);
    let nums = [small(2), pos(&x)];
    let dens = [small(3), pos(&y)];
    let p = qv_bytes(&nums, &dens);
    let q = qv1(arg(&p)).unwrap();
    let need = need_qv(&q).unwrap();
    let e = decode_qv(&q, &need).unwrap_err();
    // tag, count, then the first entry (4 + 8 bytes): the second entry
    let at = BASE + 4 + 4 + 8 + (4 + 8);
    assert_eq!((e.code, e.offset), (Code::Schema, at), "{:?}", e);
    // 6/4 too, at a small size
    let p = qv_bytes(&[small(6)], &[small(4)]);
    let q = qv1(arg(&p)).unwrap();
    assert_eq!(decode_qv(&q, &need_qv(&q).unwrap()).unwrap_err().code, Code::Schema);
}

#[test]
fn the_limb_cap_is_exact_and_refused_before_any_work() {
    let cap = LIMB_CAP as usize;
    let mut seed = 5u64;
    for (k, ok) in [(cap - 1, true), (cap, true), (cap + 1, false)] {
        let big = rnd(k, &mut seed) | (UBig::ONE << (64 * k - 1));
        // in a numerator (after a small entry), then in a denominator
        for in_den in [false, true] {
            let (nums, dens) = if in_den { (vec![small(1), small(1)], vec![small(1), pos(&big)]) } else { (vec![small(1), pos(&big)], vec![small(1), small(1)]) };
            let p = qv_bytes(&nums, &dens);
            let q = qv1(arg(&p)).unwrap();
            let r = need_qv(&q);
            if ok {
                assert!(r.is_ok(), "{} limbs", k);
            } else {
                let e = r.unwrap_err();
                let zv_at = if in_den { BASE + 4 + (4 + 8 + 2 * (4 + 8)) } else { BASE + 4 };
                assert_eq!((e.code, e.offset), (Code::Cap, zv_at + 4 + 8 + (4 + 8)), "{:?}", e);
                assert!(e.what.contains("2^20 bits"));
            }
        }
        // the same integer in a ZV_1 is not capped (no gcd: a linear decode)
        let mut p = Vec::new();
        put_zv(&mut p, &[pos(&big)]);
        let z = zv1(arg(&p)).unwrap();
        assert!(need_zv(&z).is_ok());
        assert_eq!(decode_zv(&z).len(), 1);
    }
}

#[test]
fn an_overrun_of_the_admitted_work_is_internal_and_terminal() {
    let (x, y) = fib(3000);
    let p = qv_bytes(&[pos(&x)], &[pos(&y)]);
    let q = qv1(arg(&p)).unwrap();
    let need = need_qv(&q).unwrap();
    assert!(decode_qv(&q, &need).is_ok());
    // far less than the bound (the meter, not the bound's slack, refuses)
    let short = Need { work: need.work / 10_000, ..need };
    let e = decode_qv(&q, &short).unwrap_err();
    assert_eq!(e.code, Code::Internal);
    assert!(e.what.contains("admitted work"));
}

// ---------------------------------------------------------------- MAT1

#[test]
fn mat1_of_rationals_is_two_flat_vectors() {
    let mut b = b"MAT1".to_vec();
    b.extend_from_slice(&2u32.to_le_bytes());
    b.extend_from_slice(&2u32.to_le_bytes());
    b.extend_from_slice(&qv_bytes(&[small(1), small(-2), small(0), small(9)], &[small(2), small(3), small(1), small(4)]));
    let m = sagebrush_wire::mat1(arg(&b), ElemKind::Rationals, false).unwrap();
    let need = need_mat(&m).unwrap();
    assert_eq!(need.bytes, 2 * size_of_vec(4) + 8 * 2 * 2);
    assert!(need.work > 0);
    match decode_mat(&m, &need).unwrap() {
        MatValues::Rationals(n, d) => {
            assert_eq!(n, vec![1.into(), (-2).into(), 0.into(), 9.into()]);
            assert_eq!(d, vec![2.into(), 3.into(), 1.into(), 4.into()]);
        }
        v => panic!("{:?}", v),
    }
    let mut b = b"MAT1".to_vec();
    b.extend_from_slice(&1u32.to_le_bytes());
    b.extend_from_slice(&2u32.to_le_bytes());
    b.extend_from_slice(b"I641");
    b.extend_from_slice(&2u64.to_le_bytes());
    for v in [i64::MIN, i64::MAX] {
        b.extend_from_slice(&v.to_le_bytes());
    }
    let m = sagebrush_wire::mat1(arg(&b), ElemKind::Ints, false).unwrap();
    let need = need_mat(&m).unwrap();
    assert_eq!(need, Need { bytes: size_of_vec(2), work: 0 });
    assert_eq!(decode_mat(&m, &need).unwrap(), MatValues::Ints(vec![i64::MIN.into(), i64::MAX.into()]));
}

// ---------------------------------------------------------------- MQR1

#[test]
fn mqr_rows_are_checked_by_their_running_gcd() {
    let mut seed = 19u64;
    let (p, q, r) = (UBig::from(1_000_003u64), UBig::from(1_000_033u64), rnd(3, &mut seed));
    // d = p q: n1 shares p, n2 shares q, n3 coprime: the running gcd p q,
    // then q, then 1
    let d = &p * &q;
    let ok_row = vec![pos(&d), pos(&(&p * UBig::from(5u8))), pos(&(&q * UBig::from(7u8))), small(11)];
    // the same without n3: gcd q stays
    let bad_row = vec![pos(&d), pos(&(&p * &q * UBig::from(2u8))), pos(&(&q * UBig::from(7u8))), small(0)];
    let unit_row = vec![small(1), pos(&r), small(-4), small(0)];
    let zero_row = vec![small(1), small(0), small(0), small(0)];
    let b = mqr_bytes(3, &[unit_row.clone(), ok_row.clone(), zero_row.clone()]);
    let m = mqr1(arg(&b)).unwrap();
    let need = need_mqr(&m).unwrap();
    let ld = d.as_words().len() as u64;
    let lrow = ok_row.iter().map(|x| x.1.len() as u64).max().unwrap();
    let want = row_fixed_work(ld, lrow).unwrap() + ok_row[1..].iter().map(|x| row_entry_work(x.1.len() as u64, ld).unwrap()).sum::<u64>();
    assert_eq!(need.work, want, "only the second row is checked");
    let (dens, nums) = decode_mqr(&m, &need).unwrap();
    assert_eq!(dens.len(), 3);
    assert_eq!(nums.len(), 9);
    assert_eq!(nums[5], 11.into());
    let b = mqr_bytes(3, &[unit_row, bad_row, zero_row]);
    let m = mqr1(arg(&b)).unwrap();
    let e = decode_mqr(&m, &need_mqr(&m).unwrap()).unwrap_err();
    // the second row's denominator: after MQR1, rows, cols and the first row
    let first = 4 + 8 + 4 * 4 + 8 * (1 + 3 + 1);
    let at = BASE + 4 + 8 + first as u64 + 4 + 8;
    assert_eq!((e.code, e.offset), (Code::Schema, at), "{:?}", e);
}

#[test]
fn hostile_shapes_decode_within_their_need() {
    // many rows of zero columns (d = 1 each), zero-limb integers, a long
    // vector of zeros as rationals
    let rows: Vec<Vec<Int>> = (0..2000).map(|_| vec![small(1)]).collect();
    let b = mqr_bytes(0, &rows);
    let m = mqr1(arg(&b)).unwrap();
    let need = need_mqr(&m).unwrap();
    assert_eq!(need, Need { bytes: size_of_vec(2000) + size_of_vec(0), work: 0 });
    let (d, n) = decode_mqr(&m, &need).unwrap();
    assert_eq!((d.len(), n.len()), (2000, 0));
    let zeros: Vec<Int> = (0..5000).map(|_| small(0)).collect();
    let ones: Vec<Int> = (0..5000).map(|_| small(1)).collect();
    let p = qv_bytes(&zeros, &ones);
    let q = qv1(arg(&p)).unwrap();
    let need = need_qv(&q).unwrap();
    assert_eq!(need, Need { bytes: 2 * size_of_vec(5000), work: 0 });
    assert_eq!(decode_qv(&q, &need).unwrap().0.len(), 5000);
}
