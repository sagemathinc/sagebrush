use super::*;
use crate::nmod::Modulus;
use crate::nmod_poly as np;
use std::sync::Mutex;
use Family::{ModArith, Move, MulNtt, MulSchool};

fn poly(len: usize, seed: u64, m: &Modulus) -> Vec<u64> {
    let mut s = seed | 1;
    (0..len)
        .map(|_| {
            s ^= s << 13;
            s ^= s >> 7;
            s ^= s << 17;
            s % m.n
        })
        .collect()
}

/// Units with the given counts in the given families, zero elsewhere (so a
/// pin reads the same whatever families are added).
const fn units_of(pairs: &[(Family, u64)]) -> [u64; FAMILIES] {
    let mut u = [0; FAMILIES];
    let mut i = 0;
    while i < pairs.len() {
        u[pairs[i].0 as usize] = pairs[i].1;
        i += 1;
    }
    u
}

fn acct() -> Meter {
    Meter::accounting(u64::MAX)
}

/// A schoolbook product charges exactly its multiply-adds (la lb) as
/// MulSchool, and the meter's total equals the units charged.
#[test]
fn a_schoolbook_product_charges_its_multiply_adds() {
    let m = Modulus::new(65537);
    let (a, b) = (poly(10, 1, &m), poly(20, 2, &m));
    let mut meter = acct();
    let c = metered(&mut meter, || np::mul(&a, &b, &m));
    assert_eq!(c.len(), 29);
    let u = meter.units();
    assert_eq!(u.get(Family::MulSchool), 200);
    assert_eq!(u.total(), Some(meter.used()));
}

/// Unit counts pinned on fixed inputs (drift fails here): an NTT product,
/// a classical and a Newton division, a gcd, a power mod f.
#[test]
fn pinned_units_on_fixed_inputs() {
    let m = Modulus::new(65537);
    let f = poly(300, 3, &m);
    let g = poly(200, 4, &m);
    let mut rows = vec![];
    let mut run = |name: &'static str, op: &mut dyn FnMut()| {
        let mut meter = acct();
        metered(&mut meter, op);
        assert_eq!(meter.units().total(), Some(meter.used()), "{}", name);
        rows.push((name, meter.units().0));
    };
    run("mul 300x200", &mut || drop(np::mul(&f, &g, &m)));
    run("divrem 300/20", &mut || drop(np::divrem(&f, &g[..20], &m)));
    run("divrem 300/200", &mut || drop(np::divrem(&f, &g, &m)));
    run("gcd 300,200", &mut || drop(np::gcd(&f, &g, &m)));
    run("powmod 65537", &mut || {
        let pm = np::PolyModulus::new(&f, &m);
        drop(pm.powmod(&[0, 1], &[65537]));
    });
    for (name, u) in &rows {
        eprintln!("{:>16}: {:?}", name, u);
    }
    let want = PINNED;
    for ((name, u), (wn, wu)) in rows.iter().zip(want.iter()) {
        assert_eq!(name, wn);
        assert_eq!(u, wu, "{}: units drifted", name);
    }
}

// Families in Family order: MulSchool, MulNtt, Div, DivNewton, Gcd, Move,
// ModArith, Other.  The products at p = 65537 use one transform prime; the
// 300 x 200 product transforms at N = 512: 3 (N/2) log N + N = 7424
// butterflies and pointwise products, 2N = 1024 zero fills, 500 + 499
// input and result reductions and 499 CRT reductions = 1498.
const PINNED: [(&str, [u64; FAMILIES]); 5] = [
    ("mul 300x200", units_of(&[(MulNtt, 7424), (Move, 1024), (ModArith, 1498)])),
    ("divrem 300/20", units_of(&[(MulSchool, 5620), (Move, 300), (ModArith, 1)])),
    ("divrem 300/200", units_of(&[(MulSchool, 5460), (MulNtt, 17408), (Move, 3259), (ModArith, 2915)])),
    ("gcd 300,200", units_of(&[(MulSchool, 59604), (Move, 500), (ModArith, 202)])),
    ("powmod 65537", units_of(&[(MulSchool, 7855), (MulNtt, 396032), (Move, 55654), (ModArith, 50818)])),
];

/// Nested regions charge once: in release the inner region charges
/// nothing and the outer one everything; in debug the nested call is
/// flagged (a panic), and the outer region's Drop guard still charges the
/// work done before it.
#[test]
fn nested_regions_charge_once() {
    let m = Modulus::new(65537);
    let (a, b) = (poly(10, 5, &m), poly(20, 6, &m));
    let mut outer = acct();
    let mut inner = acct();
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        metered(&mut outer, || {
            drop(np::mul(&a, &b, &m));
            metered(&mut inner, || drop(np::mul(&a, &b, &m)));
        })
    }));
    if cfg!(debug_assertions) {
        assert!(r.is_err(), "a nested region is flagged in debug");
        assert_eq!(outer.units().get(Family::MulSchool), 200, "the work before the panic is charged");
    } else {
        assert!(r.is_ok());
        assert_eq!(outer.units().get(Family::MulSchool), 400, "the outer region charges both products");
    }
    assert_eq!(inner.used(), 0, "the inner region charges nothing");
    // and the region is released: a new one charges normally
    let mut again = acct();
    metered(&mut again, || drop(np::mul(&a, &b, &m)));
    assert_eq!(again.units().get(Family::MulSchool), 200);
}

/// The Drop guard charges the work done before an unwinding (a Stop is
/// one), not only on a normal return.
#[test]
fn work_before_an_unwind_is_charged() {
    let m = Modulus::new(65537);
    let (a, b) = (poly(30, 7, &m), poly(30, 8, &m));
    let mut meter = acct();
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        metered(&mut meter, || {
            drop(np::mul(&a, &b, &m));
            panic!("stop");
        })
    }));
    assert!(r.is_err());
    assert_eq!(meter.units().get(Family::MulSchool), 900);
}

/// The documented limit: nmod work on another thread inside a region is
/// NOT counted (the counters are thread-locals).
#[test]
fn work_on_another_thread_is_not_counted() {
    let m = Modulus::new(65537);
    let (a, b) = (poly(10, 9, &m), poly(20, 10, &m));
    let mut meter = acct();
    metered(&mut meter, || {
        let (a2, b2) = (a.clone(), b.clone());
        std::thread::spawn(move || drop(np::mul(&a2, &b2, &Modulus::new(65537)))).join().unwrap();
    });
    assert_eq!(meter.units().get(Family::MulSchool), 0, "work on a spawned thread is not seen");
    // (only the region's own clones, a Move of 30, at most)
    assert!(meter.used() <= 30);
}

/// A region's progress is published at the kernels' Stop polls (every
/// 2^16 units) and is readable from another thread while the region runs
/// (a value strictly between 0 and the end, seen by a watcher thread: the
/// call is repeated until the watcher runs during it, which a loaded
/// machine may delay); at the end it equals the units charged.
#[test]
fn progress_is_published_during_the_call() {
    use std::sync::atomic::AtomicBool;
    let m = Modulus::new(65537);
    let f = poly(2000, 11, &m);
    let mut seen_mid = false;
    for _ in 0..200 {
        let progress = Progress::new();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let done = Arc::new(AtomicBool::new(false));
        let watcher = {
            let (p, seen, done) = (progress.clone(), seen.clone(), done.clone());
            std::thread::spawn(move || {
                while !done.load(Relaxed) {
                    seen.lock().unwrap().push(p.units().total().unwrap_or(0));
                    std::thread::yield_now();
                }
            })
        };
        let mut meter = acct();
        metered_with(&mut meter, Some(progress.clone()), || {
            // a long schoolbook-dominated Euclid gcd (below GCD_CUTOFF)
            drop(np::gcd(&f[..900], &f[1000..1800], &m));
        });
        done.store(true, Relaxed);
        watcher.join().unwrap();
        let total = meter.used();
        assert_eq!(progress.units().total(), Some(total), "the final publish equals the charge");
        if seen.lock().unwrap().iter().any(|&t| 0 < t && t < total) {
            seen_mid = true;
            break;
        }
    }
    assert!(seen_mid, "progress was seen mid-call");
}

/// metered needs an accounting meter (it charges after the work).
#[test]
#[should_panic(expected = "accounting meter")]
fn metered_refuses_a_refusing_meter() {
    let mut meter = Meter::new(1000);
    metered(&mut meter, || ());
}

/// An explicit meter run inside a region reaches the region only through
/// tally_all of its units at the end (one mechanism per site): both kinds
/// of work are then charged once, family by family.
#[test]
fn an_inner_explicit_meter_merges_through_tally_all() {
    let m = Modulus::new(65537);
    let (a, b) = (poly(10, 1, &m), poly(20, 2, &m));
    let mut outer = acct();
    metered(&mut outer, || {
        let mut inner = Meter::new(1000);
        inner.add_in(Family::Gcd, 50).unwrap();
        inner.add_in(Family::Div, 7).unwrap();
        drop(np::mul(&a, &b, &m));
        tally_all(&inner.units().0);
    });
    let u = outer.units();
    assert_eq!((u.get(Family::Gcd), u.get(Family::Div), u.get(Family::MulSchool)), (50, 7, 200));
    assert_eq!(u.total(), Some(outer.used()));
    // without the merge, the inner meter's units are not the region's
    let mut lost = acct();
    metered(&mut lost, || {
        let mut inner = Meter::new(1000);
        inner.add_in(Family::Gcd, 50).unwrap();
    });
    assert_eq!(lost.used(), 0);
}

/// The BigInt helpers' formulas, each in its one family.
#[test]
fn bigint_helpers_pinned() {
    let only = |u: Units, f: Family| {
        assert_eq!(u.total(), Some(u.get(f)));
        u.get(f)
    };
    assert_eq!(only(bigmul_units(3, 5), Family::MulSchool), 15);
    assert_eq!(only(bigmul_units(0, 5), Family::MulSchool), 0);
    assert_eq!(only(bigdiv_units(10, 4), Family::Div), 28);
    assert_eq!(only(bigdiv_units(2, 4), Family::Div), 4);
    assert_eq!(only(bigeuclid_units(10, 4), Family::Gcd), 56);
    assert_eq!(only(bigeuclid_units(4, 4), Family::Gcd), 8);
    assert_eq!(only(bigmul_units(usize::MAX, usize::MAX), Family::MulSchool), u64::MAX);
    assert_eq!(only(bigeuclid_units(usize::MAX, 2), Family::Gcd), u64::MAX);
    // through a region, charged to the meter
    let mut meter = acct();
    metered(&mut meter, || {
        let mut acc = Units::default();
        acc.add(&bigmul_units(3, 5));
        acc.add(&bigdiv_units(10, 4));
        tally_all(&acc.0);
    });
    assert_eq!((meter.units().get(Family::MulSchool), meter.units().get(Family::Div)), (15, 28));
}

fn rand_mat(r: usize, c: usize, m: Modulus, seed: u64) -> crate::nmod_mat::Mat {
    let rows: Vec<Vec<u64>> = (0..r).map(|i| poly(c, 2 * (seed + i as u64) + 1, &m)).collect();
    crate::nmod_mat::Mat::from_rows(&rows, m)
}

/// nmod_mat's units on fixed inputs, per public op: each op's own count
/// (its callees inside nmod_mat count themselves, once).
#[test]
fn nmod_mat_pinned_units() {
    let small = Modulus::new(65537);
    let big = Modulus::new((1u64 << 62) - 57);
    let a = rand_mat(40, 40, small, 1);
    let b = rand_mat(40, 30, small, 100);
    let ab = rand_mat(40, 40, big, 1);
    // rank 20 of 40: rows 20.. are sums of rows ..20
    let mut low = rand_mat(40, 50, small, 7);
    for i in 20..40 {
        for j in 0..50 {
            let x = small.add(low.get(i - 20, j), low.get((i - 19) % 20, j));
            low.set(i, j, x);
        }
    }
    let lu = a.lu().unwrap();
    let rhs = poly(40, 9, &small);
    type Op<'a> = (&'a str, Box<dyn Fn() + 'a>);
    let ops: Vec<Op> = vec![
        ("from_rows 40x40", Box::new(|| drop(rand_mat(40, 40, small, 1)))),
        ("mul 40x40 40x30", Box::new(|| drop(a.mul(&b)))),
        ("mul 40x40 big p", Box::new(|| drop(ab.mul(&ab)))),
        ("mul_vec 40", Box::new(|| drop(a.mul_vec(&rhs)))),
        ("transpose 40x30", Box::new(|| drop(b.transpose()))),
        ("rank 40x40", Box::new(|| { let _ = a.rank(); })),
        ("det 40x40 big p", Box::new(|| { let _ = ab.det(); })),
        ("rref rank 20 40x50", Box::new(|| drop(low.clone().rref()))),
        ("lu 40", Box::new(|| drop(a.lu()))),
        ("solve_vec 40", Box::new(|| drop(lu.solve_vec(&rhs)))),
        ("solve 40 by 30", Box::new(|| drop(a.solve(&b)))),
        ("inverse 40", Box::new(|| drop(a.inverse()))),
        ("nullspace 40x50 rank 20", Box::new(|| drop(low.nullspace()))),
        ("charpoly 40 small p (Hessenberg)", Box::new(|| drop(a.charpoly()))),
        ("charpoly 40 big p (Krylov)", Box::new(|| drop(ab.charpoly()))),
    ];
    const PINNED: [(&str, [u64; FAMILIES]); 15] = [
        ("from_rows 40x40", units_of(&[(ModArith, 1600)])),
        ("mul 40x40 40x30", units_of(&[(MulSchool, 48000), (Move, 3600), (ModArith, 1200)])),
        ("mul 40x40 big p", units_of(&[(MulSchool, 64000), (Move, 4800), (ModArith, 4800)])),
        ("mul_vec 40", units_of(&[(MulSchool, 1600), (ModArith, 40)])),
        ("transpose 40x30", units_of(&[(Move, 2400)])),
        ("rank 40x40", units_of(&[(MulSchool, 20540), (Move, 2951), (ModArith, 2919)])),
        ("det 40x40 big p", units_of(&[(MulSchool, 20540), (Move, 2951), (ModArith, 3599)])),
        ("rref rank 20 40x50", units_of(&[(MulSchool, 28570), (Move, 3284), (ModArith, 4240)])),
        ("lu 40", units_of(&[(MulSchool, 20540), (Move, 2951), (ModArith, 2919)])),
        ("solve_vec 40", units_of(&[(MulSchool, 1560), (Move, 80), (ModArith, 158)])),
        ("solve 40 by 30", units_of(&[(MulSchool, 87880), (Move, 9371), (ModArith, 8139)])),
        ("inverse 40", units_of(&[(MulSchool, 103480), (Move, 12851), (ModArith, 9619)])),
        ("nullspace 40x50 rank 20", units_of(&[(MulSchool, 28570), (Move, 6784), (ModArith, 4840)])),
        ("charpoly 40 small p (Hessenberg)", units_of(&[(MulSchool, 29640), (Move, 1600), (ModArith, 35840)])),
        ("charpoly 40 big p (Krylov)", units_of(&[(MulSchool, 106640), (Move, 5519), (ModArith, 10375)])),
    ];
    assert_eq!(ops.len(), PINNED.len());
    for ((name, f), (pname, pin)) in ops.iter().zip(PINNED) {
        assert_eq!(*name, pname);
        let mut meter = acct();
        metered(&mut meter, f);
        assert_eq!(meter.units().total(), Some(meter.used()), "{}", name);
        assert_eq!(meter.units().0, pin, "{}", name);
    }
    // the products' counts by formula: r k c multiply-adds, one reduction
    // per entry and batch of 16 (p near 2^62), the result and B's transpose
    // filled and copied
    assert_eq!(PINNED[1].1[Family::MulSchool as usize], 40 * 40 * 30);
    assert_eq!(PINNED[2].1[Family::ModArith as usize], 40 * 40 * 40u64.div_ceil(16));
    assert_eq!(PINNED[1].1[Family::Move as usize], 40 * 30 + 2 * 40 * 30);
    // the leaf rule: solve is the augment, the rref of [A | B] and the copy
    // of X out; inverse is solve with the identity (its fill counted too)
    let mut meter = acct();
    metered(&mut meter, || drop(a.augment(&b).rref()));
    let rref = meter.units().0;
    assert_eq!(PINNED[10].1[Family::MulSchool as usize], rref[Family::MulSchool as usize]);
    assert_eq!(PINNED[10].1[Family::Move as usize], rref[Family::Move as usize] + 40 * 30);
}

/// nmod_poly's Poll flushes its accumulator when it drops while unwinding
/// (a panic, or a Stop raised outside its own poll): the units it held
/// reach the tally.
#[test]
fn a_poll_flushes_when_unwinding() {
    let before = tallied();
    let r = std::panic::catch_unwind(|| {
        let mut poll = crate::nmod_poly::Poll::new();
        poll.mul_adds(1000);
        poll.add_weighted(Family::ModArith, 3, 128);
        panic!("mid-kernel");
    });
    assert!(r.is_err());
    let now = tallied();
    assert_eq!(now.get(Family::MulSchool).wrapping_sub(before.get(Family::MulSchool)), 1000);
    assert_eq!(now.get(Family::ModArith).wrapping_sub(before.get(Family::ModArith)), 3);
}
