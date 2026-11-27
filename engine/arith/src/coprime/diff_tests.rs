//! The invariant-division routines against today's (kept in `old`), on the
//! same inputs: the same result, every buffer the same after the call (x,
//! y, q), the same `used()` and `largest_charge()` exactly, and the same
//! result and buffers when the meter runs out at every limit up to the
//! call's units (every limit on small calls, a spread on large ones).  So
//! the outputs, the work units and the Overrun points are unchanged.
//! Random inputs (sizes 1..40, skewed limbs) and the hard cases, each with
//! a coverage counter that must move: normalization shifts 0 and 63, ny = 1,
//! 2, 3, nx = ny, the boundary digit (u2, u1) = (y1, y2), today's D3 loop's
//! corrections (qhat >= b; once and twice by the second-limb test; the rh
//! overflow break), the add-back, divisors of all ones, 2^63 and 2^63 + 1.

use super::{hits, old, Fault, Meter};
use dashu_int::UBig;

struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_f491_4f6c_dd1d)
    }
    /// A limb from a skewed distribution: uniform, all ones, zero, one
    /// bit, the top half, near 2^63.
    fn limb(&mut self) -> u64 {
        match self.next() % 8 {
            0..=2 => self.next(),
            3 => u64::MAX,
            4 => 0,
            5 => 1 << (self.next() % 64),
            6 => (1 << 63) + (self.next() % 3),
            _ => u64::MAX - (self.next() % 3),
        }
    }
    fn big(&mut self, n: usize) -> Vec<u64> {
        let mut v: Vec<u64> = (0..n).map(|_| self.limb()).collect();
        if n > 0 && v[n - 1] == 0 {
            v[n - 1] = 1 + (self.next() >> 1);
        }
        v
    }
}

fn words(x: &UBig, n: usize) -> Vec<u64> {
    // (through bytes: dashu's Word is 32 bits on wasm32)
    let b = x.to_le_bytes();
    let mut v: Vec<u64> = b.chunks(8).map(|c| c.iter().rev().fold(0u64, |a, &y| (a << 8) | u64::from(y))).collect();
    v.resize(n.max(v.len()), 0);
    v
}

fn ubig(x: &[u64]) -> UBig {
    let mut r = UBig::ZERO;
    for &w in x.iter().rev() {
        r = (r << 64) + UBig::from(w);
    }
    r
}

/// The limits to probe: all up to `used` when it is small, else a spread
/// with both ends and the neighborhoods of the start.
fn limits(used: u64) -> Vec<u64> {
    if used <= 600 {
        return (0..=used).collect();
    }
    let mut v: Vec<u64> = (0..64).collect();
    v.extend((0..256).map(|i| used * i / 256));
    v.extend(used - 64..=used);
    v.sort_unstable();
    v.dedup();
    v
}

/// Run `f` (old or new) on fresh copies of the buffers with a meter of
/// `limit`; its result, the buffers after, the units and the largest charge.
type Bufs = (Vec<u64>, Vec<u64>, Vec<u64>);
type Routine<'a, T> = &'a dyn Fn(&mut [u64], &mut [u64], &mut [u64], &mut Meter) -> Result<T, Fault>;

fn run<T>(f: Routine<T>, b: &Bufs, limit: u64) -> (Result<T, Fault>, Bufs, u64, u64) {
    let (mut x, mut y, mut q) = b.clone();
    let mut m = Meter::new(limit);
    let r = f(&mut x, &mut y, &mut q, &mut m);
    (r, (x, y, q), m.used(), m.largest_charge())
}

/// Old against new on one input, at an unbounded meter and at every probed
/// limit.  Returns the unbounded result of the new routine.
fn same<T: PartialEq + std::fmt::Debug>(name: &str, old: Routine<T>, new: Routine<T>, b: &Bufs) -> Result<T, Fault> {
    let (ro, bo, uo, lo) = run(old, b, u64::MAX);
    let (rn, bn, un, ln) = run(new, b, u64::MAX);
    assert_eq!(rn, ro, "{name}: result, x {:x?} y {:x?}", b.0, b.1);
    assert_eq!(bn, bo, "{name}: buffers");
    assert_eq!((un, ln), (uo, lo), "{name}: units and largest charge");
    for l in limits(uo) {
        let (ro, bo, uo2, lo2) = run(old, b, l);
        let (rn, bn, un2, ln2) = run(new, b, l);
        assert_eq!(rn, ro, "{name}: result at limit {l}");
        assert_eq!(bn, bo, "{name}: buffers at limit {l}");
        assert_eq!((un2, ln2), (uo2, lo2), "{name}: units and largest charge at limit {l}");
    }
    rn
}

/// divrem, divexact (on y k, so it divides; and on y k + 1, refused) and,
/// for ny >= 2, rem, on (x, y).
fn all_three(x: &[u64], y: &[u64], rng: &mut Rng) {
    let (nx, ny) = (x.len(), y.len());
    let b: Bufs = ({ let mut v = x.to_vec(); v.push(0); v }, y.to_vec(), vec![0; nx - ny + 1]);
    let r = same(
        "divrem",
        &|x, y, q, m| old::divrem_in_place(x, nx, y, ny, q, m),
        &|x, y, q, m| super::divrem_in_place(x, nx, y, ny, q, m),
        &b,
    );
    // (and the answer itself, against dashu)
    let (nq, nr) = r.expect("divrem");
    let (_, (xa, _, qa), _, _) = run(&|x, y, q, m| super::divrem_in_place(x, nx, y, ny, q, m), &b, u64::MAX);
    let (qq, rr) = (ubig(x) / ubig(y), ubig(x) % ubig(y));
    assert_eq!((ubig(&qa[..nq]), ubig(&xa[..nr])), (qq, rr));
    if ny >= 2 && ubig(x) >= ubig(y) {
        let b: Bufs = ({ let mut v = x.to_vec(); v.push(0); v }, y.to_vec(), vec![]);
        let _ = same("rem", &|x, y, _q, m| old::rem_in_place(x, nx, y, ny, m), &|x, y, _q, m| super::rem_in_place(x, nx, y, ny, m), &b);
    }
    // divexact on y k (k random, so the product has at most nx + 1 limbs)
    let k = ubig(&rng.big((nx - ny).max(1)));
    let p = ubig(y) * &k;
    let np = words(&p, 0).iter().rposition(|&w| w != 0).map_or(0, |i| i + 1);
    if np >= ny {
        for (v, tag) in [(p.clone(), "divexact"), (p + UBig::ONE, "divexact, not exact")] {
            let mut w = words(&v, 0);
            let nv = w.iter().rposition(|&x| x != 0).map_or(0, |i| i + 1);
            if nv < ny {
                continue;
            }
            w.truncate(nv);
            w.push(0);
            let b: Bufs = (w, y.to_vec(), vec![0; nv - ny + 1]);
            let _ = same(tag, &|x, y, q, m| old::divexact_in_place(x, nv, y, ny, q, m), &|x, y, q, m| super::divexact_in_place(x, nv, y, ny, q, m), &b);
        }
    }
}

/// gcd_in_place and gcd_unbalanced on (x, y), old against new (their
/// one-limb step and remainder steps changed).
fn gcds(x: &[u64], y: &[u64]) {
    let n = x.len().max(y.len()) + 1;
    let pad = |v: &[u64]| { let mut w = v.to_vec(); w.resize(n, 0); w };
    let b: Bufs = (pad(x), pad(y), vec![]);
    let (nx, ny) = (x.len(), y.len());
    let _ = same("gcd", &|x, y, _q, m| old::gcd_in_place(x, nx, y, ny, m), &|x, y, _q, m| super::gcd_in_place(x, nx, y, ny, m), &b);
    let _ = same("gcd_unbalanced", &|x, y, _q, m| old::gcd_unbalanced(x, nx, y, ny, m), &|x, y, _q, m| super::gcd_unbalanced(x, nx, y, ny, m), &b);
}

#[test]
fn random_against_today() {
    let mut rng = Rng(0x5eed_1234_abcd_0001);
    for i in 0..4000 {
        let ny = 1 + (rng.next() % if i % 3 == 0 { 3 } else { 14 }) as usize;
        let nx = ny + (rng.next() % 28) as usize;
        let (x, y) = (rng.big(nx), rng.big(ny));
        all_three(&x, &y, &mut rng);
        if i % 4 == 0 {
            gcds(&x, &y);
        }
    }
}

#[test]
fn hard_cases_against_today() {
    let mut rng = Rng(77);
    let h = 1u64 << 63;
    let rows = [hits::BOUNDARY, hits::ADD_BACK, hits::D3_QBIG, hits::D3_Y2_ONCE, hits::D3_Y2_TWICE, hits::D3_RH_BREAK];
    let before = rows.map(hits::get);
    let mut shift0 = 0;
    let mut shift63 = 0;
    let mut divisors: Vec<Vec<u64>> = vec![
        vec![u64::MAX],
        vec![h],
        vec![h + 1],
        vec![1],
        vec![u64::MAX; 2],
        vec![u64::MAX; 3],
        vec![0, h],
        vec![1, h],
        vec![u64::MAX, h],
        vec![0, 0, h],
        vec![u64::MAX, 0, 1],
        vec![3, 1],
        vec![u64::MAX; 13],
    ];
    divisors.extend((0..60).map(|i| rng.big(1 + i % 5)));
    for y in &divisors {
        let ny = y.len();
        let top = y[ny - 1];
        for extra in [0usize, 1, 2, 3, 7] {
            let nx = ny + extra;
            // x = y b^k - 1 (the boundary digit when ny >= 3), x = y (nx =
            // ny), x all ones, x a power of two, x random
            let k = extra.max(2);
            let yb = ubig(y) << (64 * k);
            let cands = [
                words(&(yb - UBig::ONE), 0),
                y.to_vec(),
                vec![u64::MAX; nx],
                { let mut v = vec![0; nx]; v[nx - 1] = h; v },
                rng.big(nx),
            ];
            for x in cands {
                let nxx = x.iter().rposition(|&w| w != 0).map_or(0, |i| i + 1);
                if nxx < ny {
                    continue;
                }
                // (the shifts counted on divisions actually run)
                shift0 += usize::from(top >> 63 == 1);
                shift63 += usize::from(top == 1);
                all_three(&x[..nxx], y, &mut rng);
                gcds(&x[..nxx], y);
            }
        }
    }
    // the add-back and today's over-by-2 are rare on random limbs: limbs
    // from {0, 1, 2^63 - 1, 2^63, 2^64 - 1} reach them
    let pick = [0u64, 1, h - 1, h, u64::MAX];
    for i in 0..60000u64 {
        let ny = 2 + (i % 3) as usize;
        let nx = ny + 1 + (i % 4) as usize;
        let mut y: Vec<u64> = (0..ny).map(|_| pick[(rng.next() % 5) as usize]).collect();
        y[ny - 1] |= 1 << (rng.next() % 64);
        let x: Vec<u64> = (0..nx).map(|_| pick[(rng.next() % 5) as usize]).collect();
        let nxx = x.iter().rposition(|&w| w != 0).map_or(0, |i| i + 1);
        if nxx >= ny {
            all_three(&x[..nxx], &y, &mut rng);
        }
    }
    let got: Vec<u64> = rows.iter().zip(before).map(|(&r, b)| hits::get(r) - b).collect();
    eprintln!("hard-case coverage: boundary {}, add-back {}, D3 q >= b {}, D3 second-limb once {}, twice {}, rh break {}; shift 0 {shift0}, shift 63 {shift63} (divisions run)", got[0], got[1], got[2], got[3], got[4], got[5]);
    assert!(got.iter().all(|&g| g > 0) && shift0 > 0 && shift63 > 0, "a hard-case row was never reached: {got:?}");
}
