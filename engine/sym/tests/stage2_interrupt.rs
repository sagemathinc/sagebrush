//! An interrupt between Stage-2 passes of the factoring engine's
//! recombination (rank-3 plan r3 with delta 2 r2, LIMIT-R3-D2-2), in its own
//! test binary: the Stop request is process-wide.  S_5 with Stage 1 ended
//! at once and every pass forced (feature test-faults); a Stop requested
//! when the second pass ends unwinds at the next check, and every
//! reservation of the call is released: the budget's live reservation is 0.
use num_traits::{One, Zero};
use sagebrush_bigint::BigInt;
use sagebrush_poly::test_faults as tf;
use sagebrush_poly::{Budget, Limits};

/// The interrupt flag and the check counters are process-wide: the tests
/// of this binary take turns.
static SERIAL: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn serial() -> std::sync::MutexGuard<'static, ()> {
    SERIAL.lock().unwrap_or_else(|e| e.into_inner())
}

/// S_k, the minimal polynomial of sqrt2 + sqrt3 + ... (k square roots).
fn sk(k: usize) -> Vec<BigInt> {
    let mul = |a: &[BigInt], b: &[BigInt]| -> Vec<BigInt> {
        let mut r = vec![BigInt::zero(); a.len() + b.len() - 1];
        for (i, x) in a.iter().enumerate() {
            for (j, y) in b.iter().enumerate() {
                r[i + j] += x * y;
            }
        }
        r
    };
    let z = |v: &[i64]| -> Vec<BigInt> { v.iter().map(|&c| BigInt::from(c)).collect() };
    let mut s = z(&[-2, 0, 1]);
    for &p in &[3i64, 5, 7, 11, 13, 17, 19][..k - 1] {
        let (mut a, mut c) = (vec![BigInt::zero()], vec![BigInt::zero()]);
        for coef in s.iter().rev() {
            let mut na = mul(&a, &z(&[0, 1]));
            for (i, v) in mul(&c, &z(&[p])).iter().enumerate() {
                na[i] += v;
            }
            na[0] += coef;
            let mut nc = mul(&c, &z(&[0, 1]));
            for (i, v) in a.iter().enumerate() {
                nc[i] += v;
            }
            a = na;
            c = nc;
        }
        let mut r = mul(&a, &a);
        for (i, v) in mul(&mul(&c, &c), &z(&[p])).iter().enumerate() {
            r[i] -= v;
        }
        while r.last().is_some_and(|x| x.is_zero()) {
            r.pop();
        }
        s = r;
    }
    s
}

#[test]
fn an_interrupt_between_stage2_passes_leaves_no_reservation() {
    let _serial = serial();
    let f = sk(5);
    assert_eq!(f.len(), 33);
    assert!(f.last().unwrap().is_one());
    let hooks = tf::STAGE1_EXIT | tf::S2_LAST_PASS;
    // without the Stop: Stage 2 runs all 8 passes and certifies
    let b = Budget::new(Limits { memory: 1 << 30, ..Limits::DEFAULT });
    let r = tf::with_hooks(hooks, None, false, || sagebrush_poly::try_factor_with(&f, &b).map(|x| x.1.len()));
    assert_eq!(r.unwrap(), 1);
    assert_eq!((tf::reach().s2_passes, b.live()), (8, 0));
    // with it: interrupted after the second pass, nothing left reserved
    let b = Budget::new(Limits { memory: 1 << 30, ..Limits::DEFAULT });
    let r = sagebrush_interrupt::catch(|| tf::with_hooks(hooks | tf::INTERRUPT_AFTER_PASS2, None, false, || sagebrush_poly::try_factor_with(&f, &b).map(|x| x.1.len())));
    sagebrush_interrupt::clear();
    assert!(r.is_err(), "interrupted");
    let reach = tf::reach();
    assert!(reach.s2_passes >= 2 && reach.s2_passes < 8, "{reach:?}");
    assert_eq!(b.live(), 0, "live reservations after the interrupt");
    // and the next call factors normally
    assert_eq!(sagebrush_poly::try_factor(&f).unwrap().1.len(), 1);
}

/// Stop at the middle check of each recombination LLL site (plan r3,
/// section 4.6): Stage 1's (the input as it comes) and Stage 2's (Stage 1
/// ended at once).  Each run is traced in full, then Stop is armed at the
/// middle check of the site: the call unwinds at that check, in that site,
/// and leaves no live reservation.
fn stop_in_each_lll(f: &[BigInt], memory: u64) {
    use sagebrush_interrupt::hooks;
    let _serial = serial();
    sagebrush_interrupt::clear();
    for (site, faults) in [("recombination stage 1 LLL", 0u8), ("recombination stage 2 LLL", tf::STAGE1_EXIT)] {
        hooks::reset();
        hooks::trace();
        let b = Budget::new(Limits { memory, ..Limits::DEFAULT });
        let r = tf::with_hooks(faults, None, false, || sagebrush_poly::try_factor_with(f, &b).map(|x| x.1.len()));
        assert_eq!(r.unwrap(), 1, "{site}");
        let at = hooks::traced(site);
        assert!(!at.is_empty(), "{site} never checked");
        let mid = at[at.len() / 2];
        hooks::reset();
        hooks::arm_at(mid);
        let b = Budget::new(Limits { memory, ..Limits::DEFAULT });
        let r = sagebrush_interrupt::catch(|| tf::with_hooks(faults, None, false, || sagebrush_poly::try_factor_with(f, &b).map(|x| x.1.len())));
        let (stopped, total) = (hooks::stopped_in(), hooks::total());
        sagebrush_interrupt::clear();
        hooks::reset();
        assert!(r.is_err(), "{site}: interrupted");
        assert_eq!(stopped, site, "stopped in the site");
        assert_eq!(total, mid, "{site}: stopped at the armed check itself (within one debit)");
        assert_eq!(b.live(), 0, "{site}: live reservations after the interrupt");
    }
}

#[test]
fn a_stop_in_either_stage_lll_unwinds_there() {
    stop_in_each_lll(&sk(6), 1 << 30);
}

/// S_8 (degree 256, r = 128 at its prime): the VM row of section 4.6, with a
/// 1 GiB share (S_8's lattice needs about 0.9 GB); `cargo test --release --
/// --ignored` on the VM.
#[test]
#[ignore]
fn a_stop_in_either_stage_lll_unwinds_there_s8() {
    stop_in_each_lll(&sk(8), 1 << 30);
}
