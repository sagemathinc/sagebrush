use super::*;
use crate::coprime::{gcd_in_place, gcd_work, pair_work, row_entry_work, row_fixed_work, Fault, Meter};
use crate::cost::accounting_overruns;
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

/// Admits everything (the tests of what is decoded).
struct Open;

impl Admit for Open {
    fn admit(&mut self, _bytes: u64, _cost: Cost) -> Result<(), WireError> {
        Ok(())
    }
}

/// Records what it is asked to admit, and refuses after `left` calls.
struct Seen {
    asked: Vec<(u64, Cost)>,
    left: usize,
}

impl Admit for Seen {
    fn admit(&mut self, bytes: u64, cost: Cost) -> Result<(), WireError> {
        self.asked.push((bytes, cost));
        if self.left == 0 {
            return Err(WireError { code: Code::Cap, offset: 0, what: "refused by the caller" });
        }
        self.left -= 1;
        Ok(())
    }
}

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

const BI: u64 = size_of::<BigInt>() as u64;

/// The need of a payload with no gcd check: its reservation and its exact
/// allocation, no work.
fn free(bytes: u64, mem_lower: u64) -> Need {
    Need { bytes, cost: Cost { mem_lower, work_lower: 0, work_estimate: None, work_upper: Some(0) } }
}

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
    assert_eq!(need.cost.work_upper, Some(pair_work(la, lb).unwrap() + pair_work(1, lc1).unwrap()));
    // L: the slots' loads and clears of the two checked pairs
    let floor = |x: u64, y: u64| x + y + 2 + 2 * (x.max(y) + 2);
    assert_eq!(need.cost.work_lower, floor(la, lb) + floor(1, lc1));
    assert_eq!(need.cost.work_estimate, None);
    let heap = |k: u64| sagebrush_wire::bigint_heap_words(k).unwrap();
    let l = la.max(lb).max(lc1);
    let bytes = 2 * size_of_vec(5) + 8 * (heap(la) + heap(lb) + heap(1) + heap(lc1) + heap(1) + 2 * heap(1)) + 8 * 2 * (l + 1);
    assert_eq!(need.bytes, bytes);
    // L_mem: the larger phase, the workspace or the vectors' elements and
    // the values' exact heap (dashu's k + k/8 + 2 words past two limbs)
    let exact = |k: u64| if k <= 2 { 0 } else { 8 * (k + k / 8 + 2) };
    let values = 10 * BI + exact(la) + exact(lb) + exact(lc1);
    assert_eq!(need.cost.mem_lower, values.max(8 * 2 * (l + 1)));
    let (n, d) = decode_qv(&q, &mut Open).unwrap();
    let want_n: Vec<BigInt> = [BigInt::from_bytes_le(Sign::Plus, &a.to_le_bytes()), 0.into(), 5.into(), (-1).into(), -BigInt::from_bytes_le(Sign::Plus, &c.to_le_bytes())].into();
    assert_eq!(n, want_n);
    assert_eq!(d[0], BigInt::from_bytes_le(Sign::Plus, &b.to_le_bytes()));
    assert_eq!(d[3], 7.into());
    // all evident: no work, no workspace
    let p = qv_bytes(&[small(0), small(3)], &[small(1), small(1)]);
    let need = need_qv(&qv1(arg(&p)).unwrap()).unwrap();
    assert_eq!(need, free(2 * size_of_vec(2), 4 * BI));
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
    let e = decode_qv(&q, &mut Open).unwrap_err();
    // tag, count, then the first entry (4 + 8 bytes): the second entry
    let at = BASE + 4 + 4 + 8 + (4 + 8);
    assert_eq!((e.code, e.offset), (Code::Schema, at), "{:?}", e);
    // 6/4 too, at a small size
    let p = qv_bytes(&[small(6)], &[small(4)]);
    let q = qv1(arg(&p)).unwrap();
    assert_eq!(decode_qv(&q, &mut Open).unwrap_err().code, Code::Schema);
}

#[test]
fn integers_far_above_the_old_cap_are_admitted() {
    // no size cap (the engine cost policy): a large integer costs its owner
    // time only; a checked pair is costed (its gcd is quadratic: the
    // Stop test runs one), an evident one decoded
    let mut seed = 5u64;
    for k in [16385usize, 50_000] {
        let big = rnd(k, &mut seed) | (UBig::ONE << (64 * k - 1));
        let p = qv_bytes(&[pos(&big), pos(&big)], &[pos(&(&big - UBig::ONE)), small(1)]);
        let q = qv1(arg(&p)).unwrap();
        let need = need_qv(&q).unwrap();
        assert_eq!(need.cost.work_upper, pair_work(k as u64, k as u64), "{} limbs: the first pair only", k);
        assert!(need.cost.mem_lower <= need.bytes);
        let p = qv_bytes(&[pos(&big)], &[small(1)]);
        let q = qv1(arg(&p)).unwrap();
        assert_eq!(decode_qv(&q, &mut Open).unwrap().0.len(), 1);
        // and in a ZV_1, as before
        let mut p = Vec::new();
        put_zv(&mut p, &[pos(&big)]);
        assert_eq!(decode_zv(&zv1(arg(&p)).unwrap(), &mut Open).unwrap().len(), 1);
    }
}

#[test]
fn overflowing_figures_drop_the_promise_or_refuse_the_memory() {
    let big = 1u64 << 40;
    assert_eq!(pair_work(big, big), None);
    assert_eq!(row_entry_work(big, big), None);
    // an upper bound that overflows is no promise, never a refusal; the
    // lower bound still holds
    let mut s = Sum::new();
    s.work(pair_floor(big, big), pair_work(big, big));
    s.work(pair_floor(3, 2), pair_work(3, 2));
    let need = s.need().unwrap();
    assert_eq!(need.cost.work_upper, None);
    assert_eq!(need.cost.work_lower, pair_floor(big, big).unwrap() + pair_floor(3, 2).unwrap());
    // a lower bound that overflows falls back to 0 (still a lower bound)
    let mut s = Sum::new();
    s.work(Some(u64::MAX), Some(1));
    s.work(Some(1), Some(1));
    assert_eq!(s.need().unwrap().cost.work_lower, 0);
    // a reservation that overflows cannot fit: a memory refusal
    for l in [u64::MAX, 1 << 61] {
        let mut s = Sum::new();
        s.workspace(l);
        let e = s.need().unwrap_err();
        assert_eq!(e.code, Code::Cap);
        assert!(e.what.contains("cannot fit"), "{}", e.what);
    }
    // and a sum of reservations that overflows, each term fitting
    let mut s = Sum::new();
    s.bytes(Ok(u64::MAX - 1));
    s.bytes(Ok(2));
    assert!(s.need().unwrap_err().what.contains("cannot fit"));
    assert_eq!(value_heap(u64::MAX), None);
    assert_eq!(value_heap(1 << 61), None);
}

#[test]
fn the_memory_lower_bound_is_the_larger_phase() {
    // a 100-limb numerator over a 1-limb denominator: the checks' workspace
    // (2 (100 + 1) words) outweighs the values (two BigInts and one buffer
    // of 100 + 12 + 2 words), so it is L_mem
    let mut seed = 31u64;
    let big = rnd(100, &mut seed) | (UBig::ONE << 6399);
    let p = qv_bytes(&[pos(&big)], &[small(3)]);
    let q = qv1(arg(&p)).unwrap();
    let need = need_qv(&q).unwrap();
    let values = 2 * BI + 8 * (100 + 12 + 2);
    let workspace = 8 * 2 * 101;
    assert!(workspace > values);
    assert_eq!(need.cost.mem_lower, workspace);
    // and an evident pair has no workspace: the values are L_mem
    let p = qv_bytes(&[pos(&big)], &[small(1)]);
    let need = need_qv(&qv1(arg(&p)).unwrap()).unwrap();
    assert_eq!(need.cost.mem_lower, values);
}

#[test]
fn an_overrun_of_the_proven_bound_is_an_accounting_event_never_a_refusal() {
    let (x, y) = fib(3000);
    let p = qv_bytes(&[pos(&x)], &[pos(&y)]);
    let q = qv1(arg(&p)).unwrap();
    let need = need_qv(&q).unwrap();
    assert!(decode_qv(&q, &mut Open).is_ok());
    // a wrong upper bound (far below the work): a debug build fails at the
    // overrun, so tests catch it; a release build counts it and finishes
    let short = Need { cost: Cost { work_upper: need.cost.work_upper.map(|u| u / 10_000), ..need.cost }, ..need };
    let before = accounting_overruns();
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| qv_admitted(&q, &short)));
    assert!(accounting_overruns() > before, "the overrun is counted");
    if cfg!(debug_assertions) {
        assert!(r.is_err(), "a debug build fails at the overrun");
    } else {
        assert!(r.unwrap().is_ok(), "a release build finishes");
    }
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
    assert!(need.cost.work_upper > Some(0));
    match decode_mat(&m, &mut Open).unwrap() {
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
    assert_eq!(need, free(size_of_vec(2), 2 * BI));
    assert_eq!(decode_mat(&m, &mut Open).unwrap(), MatValues::Ints(vec![i64::MIN.into(), i64::MAX.into()]));
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
    assert_eq!(need.cost.work_upper, Some(want), "only the second row is checked");
    let (dens, nums) = decode_mqr(&m, &mut Open).unwrap();
    assert_eq!(dens.len(), 3);
    assert_eq!(nums.len(), 9);
    assert_eq!(nums[5], 11.into());
    let b = mqr_bytes(3, &[unit_row, bad_row, zero_row]);
    let m = mqr1(arg(&b)).unwrap();
    let e = decode_mqr(&m, &mut Open).unwrap_err();
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
    assert_eq!(need, free(size_of_vec(2000) + size_of_vec(0), 2000 * BI));
    let (d, n) = decode_mqr(&m, &mut Open).unwrap();
    assert_eq!((d.len(), n.len()), (2000, 0));
    let zeros: Vec<Int> = (0..5000).map(|_| small(0)).collect();
    let ones: Vec<Int> = (0..5000).map(|_| small(1)).collect();
    let p = qv_bytes(&zeros, &ones);
    let q = qv1(arg(&p)).unwrap();
    let need = need_qv(&q).unwrap();
    assert_eq!(need, free(2 * size_of_vec(5000), 10000 * BI));
    assert_eq!(decode_qv(&q, &mut Open).unwrap().0.len(), 5000);
}

#[test]
fn every_decode_admits_its_exact_need_first() {
    let mut seed = 23u64;
    let (x, y) = (rnd(4, &mut seed), rnd(3, &mut seed));
    let g = gcd_ref(&x, &y);
    let (x, y) = (&x / &g, &y / &g);
    let p = qv_bytes(&[pos(&x), small(2)], &[pos(&y), small(3)]);
    let q = qv1(arg(&p)).unwrap();
    let need = need_qv(&q).unwrap();
    let mut a = Seen { asked: vec![], left: 1 };
    assert!(decode_qv(&q, &mut a).is_ok());
    assert_eq!(a.asked, vec![(need.bytes, need.cost)]);
    // a refusal is the decode's answer, and nothing is checked or built
    let mut a = Seen { asked: vec![], left: 0 };
    assert_eq!(decode_qv(&q, &mut a).unwrap_err().what, "refused by the caller");
    // the same for every payload kind
    let mut zb = Vec::new();
    put_zv(&mut zb, &[pos(&x)]);
    let z = zv1(arg(&zb)).unwrap();
    let mut a = Seen { asked: vec![], left: 0 };
    assert!(decode_zv(&z, &mut a).is_err());
    let nz = need_zv(&z).unwrap();
    assert_eq!(a.asked, vec![(nz.bytes, nz.cost)]);
    let ints = sagebrush_wire::ints(arg(&zb)).unwrap();
    assert!(decode_ints(&ints, &mut Seen { asked: vec![], left: 0 }).is_err());
    let b = mqr_bytes(1, &[vec![pos(&y), pos(&x)]]);
    let m = mqr1(arg(&b)).unwrap();
    let mut a = Seen { asked: vec![], left: 0 };
    assert!(decode_mqr(&m, &mut a).is_err());
    let nm = need_mqr(&m).unwrap();
    assert_eq!(a.asked, vec![(nm.bytes, nm.cost)]);
    let mut mb = b"MAT1".to_vec();
    mb.extend_from_slice(&1u32.to_le_bytes());
    mb.extend_from_slice(&2u32.to_le_bytes());
    mb.extend_from_slice(&p);
    let m = sagebrush_wire::mat1(arg(&mb), ElemKind::Rationals, false).unwrap();
    let mut a = Seen { asked: vec![], left: 0 };
    assert!(decode_mat(&m, &mut a).is_err());
    assert_eq!(a.asked, vec![(need.bytes, need.cost)]);
}
