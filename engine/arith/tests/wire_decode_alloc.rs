//! The big-integer decoder's allocations, by a counting allocator (S2,
//! E1-E3): computing a payload's need allocates nothing; a decode's peak
//! live memory is within its reservation and at least its memory lower
//! bound; a refused pair allocates exactly its gcd workspace; an integer
//! far above the former cap decodes within its need; a refused aggregate
//! memory admission allocates nothing.  One test (the counters are
//! global).

use dashu_int::UBig;
use sagebrush_arith::coprime::pair_work;
use sagebrush_arith::cost::Cost;
use sagebrush_arith::wire_decode::*;
use sagebrush_wire::{mat1, mqr1, qv1, zv1, Arg, Code, ElemKind, WireError};
use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicUsize, Ordering::Relaxed};

struct Counting;

static LIVE: AtomicUsize = AtomicUsize::new(0);
static PEAK: AtomicUsize = AtomicUsize::new(0);
/// Armed (1): the live bytes just after the next allocation are recorded
/// in FIRST_LIVE, with its size in FIRST_SIZE.
static FIRST_ARMED: AtomicUsize = AtomicUsize::new(0);
static FIRST_LIVE: AtomicUsize = AtomicUsize::new(0);
static FIRST_SIZE: AtomicUsize = AtomicUsize::new(0);

// SAFETY: every method forwards to `System` with the caller's own arguments,
// so System's GlobalAlloc contract carries over; the counting only updates
// atomics.
#[allow(unsafe_code)]
unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, l: Layout) -> *mut u8 {
        let p = System.alloc(l);
        if !p.is_null() {
            let live = LIVE.fetch_add(l.size(), Relaxed) + l.size();
            PEAK.fetch_max(live, Relaxed);
            if FIRST_ARMED.swap(0, Relaxed) == 1 {
                FIRST_LIVE.store(live, Relaxed);
                FIRST_SIZE.store(l.size(), Relaxed);
            }
        }
        p
    }
    unsafe fn dealloc(&self, p: *mut u8, l: Layout) {
        System.dealloc(p, l);
        LIVE.fetch_sub(l.size(), Relaxed);
    }
    unsafe fn realloc(&self, p: *mut u8, l: Layout, new: usize) -> *mut u8 {
        let q = System.realloc(p, l, new);
        if !q.is_null() {
            // (the old and new blocks may coexist while copying)
            PEAK.fetch_max(LIVE.load(Relaxed) + new, Relaxed);
            if new >= l.size() {
                LIVE.fetch_add(new - l.size(), Relaxed);
            } else {
                LIVE.fetch_sub(l.size() - new, Relaxed);
            }
        }
        q
    }
}

#[global_allocator]
static COUNTING: Counting = Counting;

/// f's result and its peak live bytes above the live bytes before it.
fn measured<T>(f: impl FnOnce() -> T) -> (T, u64) {
    let base = LIVE.load(Relaxed);
    PEAK.store(base, Relaxed);
    let out = f();
    (out, (PEAK.load(Relaxed) - base) as u64)
}

type Int = (bool, Vec<u64>);

/// x's u64 limbs, whatever dashu's word size (32 bits in WebAssembly).
fn limbs(x: &UBig) -> Vec<u64> {
    x.to_le_bytes()
        .chunks(8)
        .map(|c| {
            let mut w = [0u8; 8];
            w[..c.len()].copy_from_slice(c);
            u64::from_le_bytes(w)
        })
        .collect()
}

fn pos(x: &UBig) -> Int {
    (false, limbs(x))
}

fn small(v: i64) -> Int {
    let m = v.unsigned_abs();
    (v < 0, if m == 0 { Vec::new() } else { vec![m] })
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

fn mat_bytes(rows: u32, cols: u32, elems: &[u8]) -> Vec<u8> {
    let mut b = b"MAT1".to_vec();
    b.extend_from_slice(&rows.to_le_bytes());
    b.extend_from_slice(&cols.to_le_bytes());
    b.extend_from_slice(elems);
    b
}

fn arg(b: &[u8]) -> Arg<'_> {
    Arg { bytes: b, offset: 0 }
}

fn rnd(words: usize, seed: &mut u64) -> UBig {
    let v = (0..words)
        .map(|_| {
            *seed ^= *seed << 13;
            *seed ^= *seed >> 7;
            *seed ^= *seed << 17;
            *seed
        })
        .collect::<Vec<u64>>()
        .iter()
        .flat_map(|w| w.to_le_bytes())
        .collect::<Vec<u8>>();
    UBig::from_le_bytes(&v) | (UBig::ONE << (64 * words - 1))
}

/// A coprime pair of a and b limbs (b divided by the gcd keeps b's size
/// for random input; retried otherwise).
fn coprime_pair(a: usize, b: usize, seed: &mut u64) -> (UBig, UBig) {
    loop {
        let (x, y) = (rnd(a, seed), rnd(b, seed));
        if dashu_int::ops::Gcd::gcd(&x, &y) == UBig::ONE {
            return (x, y);
        }
    }
}

/// A consumer's admission, as a stand-in for its ledger reservation: the
/// bytes left (the engine cost policy: memory may refuse, the work's upper
/// bound never does); it records what it admitted.
struct Grant {
    bytes: u64,
    seen: Option<(u64, Cost)>,
}

impl Admit for Grant {
    fn admit(&mut self, bytes: u64, cost: Cost) -> Result<(), WireError> {
        if bytes > self.bytes {
            return Err(WireError { code: Code::Cap, offset: 0, what: "over the grant" });
        }
        self.bytes -= bytes;
        self.seen = Some((bytes, cost));
        Ok(())
    }
}

fn open() -> Grant {
    Grant { bytes: u64::MAX, seen: None }
}

/// Decode through an enforced entry point: the result, dropped, and the
/// peak; an admitted decode's peak is within its reservation and at least
/// its memory lower bound (the TESTS lane's observed >= L).
fn checked<T>(f: impl FnOnce(&mut Grant) -> Result<T, WireError>) -> (Result<(), WireError>, u64) {
    let mut g = open();
    let (r, peak) = measured(|| f(&mut g).map(drop));
    if r.is_ok() {
        let (bytes, cost) = g.seen.expect("an admitted decode");
        assert!(cost.mem_lower <= bytes, "L_mem {} above the reservation {}", cost.mem_lower, bytes);
        assert!(peak <= bytes, "peak {} over the reservation {}", peak, bytes);
        assert!(peak >= cost.mem_lower, "peak {} below L_mem {}", peak, cost.mem_lower);
    }
    (r, peak)
}

/// Decode a QV_1 through its enforced entry point with `bytes` granted: the
/// bytes left after, or the refusal; the peak is within the need, and a
/// refusal allocates nothing.
fn admit_and_decode_qv(p: &[u8], bytes: u64) -> Result<u64, &'static str> {
    let q = qv1(arg(p)).map_err(|e| e.what)?;
    let (need, peak) = measured(|| need_qv(&q));
    assert_eq!(peak, 0, "need_qv allocated");
    let need = need.map_err(|e| e.what)?;
    let mut g = Grant { bytes, seen: None };
    let (r, peak) = measured(|| decode_qv(&q, &mut g).map(drop));
    match r {
        Ok(()) => {
            assert!(peak <= need.bytes, "QV_1 peak {} over its need {}", peak, need.bytes);
            assert!(peak >= need.cost.mem_lower, "QV_1 peak {} below L_mem {}", peak, need.cost.mem_lower);
            Ok(g.bytes)
        }
        Err(e) => {
            assert_eq!(peak, 0, "a refused admission allocated");
            Err(e.what)
        }
    }
}

#[test]
fn decodes_allocate_within_their_need() {
    let mut seed = 0x2545_f491_4f6c_dd1du64;

    // ZV_1 and QV_1 across limb counts (E1: inline up to two limbs, then
    // dashu's buffer), with coprime pairs checked (E2)
    for k in [1usize, 2, 3, 4, 5, 8, 9, 100, 1000, 4097] {
        let xs: Vec<Int> = (0..7).map(|i| pos(&rnd(k + i % 3, &mut seed))).collect();
        let mut p = Vec::new();
        put_zv(&mut p, &xs);
        let z = zv1(arg(&p)).unwrap();
        let (need, peak) = measured(|| need_zv(&z).unwrap());
        assert_eq!(peak, 0);
        let (_, peak) = checked(|g| decode_zv(&z, g));
        assert!(peak <= need.bytes, "ZV_1 {} limbs: peak {} over {}", k, peak, need.bytes);

        let pairs: Vec<(UBig, UBig)> = (0..3).map(|i| coprime_pair(k + i, (k / 2).max(1), &mut seed)).collect();
        let nums: Vec<Int> = pairs.iter().map(|p| pos(&p.0)).collect();
        let dens: Vec<Int> = pairs.iter().map(|p| pos(&p.1)).collect();
        assert!(admit_and_decode_qv(&qv_bytes(&nums, &dens), u64::MAX).is_ok(), "{} limbs", k);

        // MAT1 of rationals and of integers (E3)
        let m = mat_bytes(1, 3, &qv_bytes(&nums, &dens));
        let m = mat1(arg(&m), ElemKind::Rationals, false).unwrap();
        let need = need_mat(&m).unwrap();
        let (_, peak) = checked(|g| decode_mat(&m, g));
        assert!(peak <= need.bytes, "MAT1 rationals {} limbs: {} over {}", k, peak, need.bytes);
        let mut zb = Vec::new();
        put_zv(&mut zb, &nums);
        let m = mat_bytes(3, 1, &zb);
        let m = mat1(arg(&m), ElemKind::Ints, false).unwrap();
        let need = need_mat(&m).unwrap();
        let (_, peak) = checked(|g| decode_mat(&m, g));
        assert!(peak <= need.bytes, "MAT1 integers {} limbs: {} over {}", k, peak, need.bytes);

        // MQR1: a checked row and a row with denominator 1
        let (d, n1) = coprime_pair((k / 2).max(1), k, &mut seed);
        let g = rnd((k / 3).max(1), &mut seed);
        let rows = vec![vec![pos(&d), pos(&(&n1 * &g)), (true, pos(&n1).1), small(0)], vec![small(1), pos(&g), small(0), small(2)]];
        let b = mqr_bytes(3, &rows);
        let m = mqr1(arg(&b)).unwrap();
        let (need, peak) = measured(|| need_mqr(&m).unwrap());
        assert_eq!(peak, 0);
        let (r, peak) = checked(|g| decode_mqr(&m, g));
        assert!(r.is_ok(), "MQR1 {} limbs: {:?}", k, r);
        assert!(peak <= need.bytes, "MQR1 {} limbs: {} over {}", k, peak, need.bytes);
    }

    // the inline boundary alone (E1): many integers of exactly 1, 2 and 3
    // limbs (inline up to two limbs on 64-bit targets, one on 32-bit ones)
    for k in [1usize, 2, 3] {
        let xs: Vec<Int> = (0..1000).map(|_| pos(&rnd(k, &mut seed))).collect();
        let mut p = Vec::new();
        put_zv(&mut p, &xs);
        let z = zv1(arg(&p)).unwrap();
        let need = need_zv(&z).unwrap();
        let (_, peak) = checked(|g| decode_zv(&z, g));
        assert!(peak <= need.bytes, "1000 integers of {} limbs: peak {} over {}", k, peak, need.bytes);
    }

    // E2 exactly: a refused pair allocates its workspace and nothing else
    for k in [1usize, 3, 50, 700] {
        let g = rnd(2, &mut seed);
        let (x, y) = (&rnd(k, &mut seed) * &g, &rnd(k, &mut seed) * &g);
        let p = qv_bytes(&[pos(&x)], &[pos(&y)]);
        let q = qv1(arg(&p)).unwrap();
        let (r, peak) = checked(|g| decode_qv(&q, g));
        assert_eq!(r.unwrap_err().code, Code::Schema);
        let l = limbs(&x).len().max(limbs(&y).len()) as u64;
        assert_eq!(peak, 8 * 2 * (l + 1), "{} limbs", k);
    }

    // an integer far above the old cap decodes within its need (no cap:
    // the engine cost policy); its pair with 3 is checked in one-limb steps
    let big = &rnd(16385, &mut seed) * UBig::from(3u8) + UBig::ONE;
    let p = qv_bytes(&[pos(&big)], &[small(3)]);
    let q = qv1(arg(&p)).unwrap();
    let (r, _) = checked(|g| decode_qv(&q, g));
    assert!(r.is_ok());

    // the aggregate memory: admitted exactly, refused one byte short with
    // nothing allocated; the work's upper bound is reported, never refused
    let pairs: Vec<(UBig, UBig)> = (0..40).map(|_| coprime_pair(20, 19, &mut seed)).collect();
    let nums: Vec<Int> = pairs.iter().map(|p| pos(&p.0)).collect();
    let dens: Vec<Int> = pairs.iter().map(|p| pos(&p.1)).collect();
    let p = qv_bytes(&nums, &dens);
    let need = need_qv(&qv1(arg(&p)).unwrap()).unwrap();
    assert_eq!(need.cost.work_upper, Some(40 * pair_work(20, 19).unwrap()));
    assert_eq!(admit_and_decode_qv(&p, need.bytes), Ok(0));
    let (r, peak) = measured(|| admit_and_decode_qv(&p, need.bytes - 1));
    assert_eq!((r, peak), (Err("over the grant"), 0));
}
