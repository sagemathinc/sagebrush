//! Stop inside each phase of the binary nmod_echelon (the interrupt crate's
//! test hooks): at every check in turn, the call ends, its reservation is
//! released, the units it charged are a prefix of the whole call's (Move
//! counted after each run of words, never before), and the next call
//! works.  One test: the hooks and the flag are global.

use sagebrush_arith::cost::{metered, Family, Meter};
use sagebrush_interrupt::hooks;
use sagebrush_web::bin_ops::{call_bin, ECH_CHUNK};
use sagebrush_wire as wire;

fn rng(s: &mut u64) -> u64 {
    *s ^= *s << 13;
    *s ^= *s >> 7;
    *s ^= *s << 17;
    *s
}

fn u641(w: &[u64]) -> Vec<u8> {
    let mut v = Vec::new();
    wire::put_u641(&mut v, w);
    v
}

fn req(p: u64, rows: usize, cols: usize, words: &[u64], flags: u64) -> Vec<u8> {
    let mut m = b"MAT1".to_vec();
    m.extend_from_slice(&(rows as u32).to_le_bytes());
    m.extend_from_slice(&(cols as u32).to_le_bytes());
    m.extend(u641(words));
    let args = [u641(&[p]), m, u641(&[flags])];
    let op = "nmod_echelon";
    let mut v = wire::MAGIC.to_vec();
    v.extend_from_slice(&(op.len() as u32).to_le_bytes());
    v.extend_from_slice(op.as_bytes());
    v.extend_from_slice(&(args.len() as u32).to_le_bytes());
    for a in &args {
        v.extend_from_slice(&(a.len() as u32).to_le_bytes());
        v.extend_from_slice(a);
    }
    v
}

#[test]
fn stop_in_every_phase_releases_and_charges_a_prefix() {
    sagebrush_web::sb_set_memory_total((1u64 << 34) as f64, 0, 0);
    let mut s = 0x5eed_u64;
    // 128 x 256: E = 8 runs of ECH_CHUNK words; the u128 route's prime, so
    // the elimination polls too
    let (r, c, p) = (128usize, 256usize, 9223372036854775783u64);
    assert_eq!((r * c) % ECH_CHUNK, 0);
    let runs = (r * c / ECH_CHUNK) as u64;
    let w: Vec<u64> = (0..r * c).map(|_| rng(&mut s) % p).collect();
    let q = req(p, r, c, &w, 3);

    hooks::reset();
    hooks::trace();
    let mut whole = Meter::accounting(u64::MAX);
    let full = metered(&mut whole, || call_bin(&q));
    assert!(matches!(wire::parse_reply(&full), Ok(Ok(_))));
    let phases: Vec<(&str, Vec<u64>)> = ["scan", "decode", "eliminate", "back-substitute", "reply"].iter().map(|&ph| (ph, hooks::traced(ph))).collect();
    let total = hooks::total();
    hooks::reset();
    eprintln!("{total} checks: {:?}", phases.iter().map(|(p, v)| (*p, v.len())).collect::<Vec<_>>());
    assert_eq!(phases[0].1.len() as u64, runs, "a scan check per run");
    assert_eq!(phases[1].1.len() as u64, runs, "a decode check per run");
    assert!(phases[4].1.len() as u64 >= runs, "a reply check per run of the rows");
    assert!(!phases[2].1.is_empty() && !phases[3].1.is_empty());

    let held = sagebrush_web::sb_outstanding_bytes();
    let mut stops = 0;
    for k in 1..=total {
        hooks::reset();
        hooks::arm_at(k);
        let mut meter = Meter::accounting(u64::MAX);
        let out = sagebrush_interrupt::catch(|| metered(&mut meter, || call_bin(&q)));
        let at = hooks::stopped_in();
        hooks::reset();
        sagebrush_interrupt::clear();
        assert!(out.is_err(), "check {k}: no Stop");
        stops += 1;
        assert_eq!(sagebrush_web::sb_outstanding_bytes(), held, "check {k} ({at}): the reservation is released");
        for (got, all) in meter.units().0.iter().zip(whole.units().0) {
            assert!(*got <= all, "check {k} ({at}): {:?} of {:?}", meter.units(), whole.units());
        }
        // (count after work: a Stop at the j-th scan check has counted
        // exactly j runs; at the j-th decode check, all the scan's and j)
        let mv = meter.units().get(Family::Move);
        if let Some(j) = phases[0].1.iter().position(|&x| x == k) {
            assert_eq!(at, "scan");
            assert_eq!(mv, (j as u64 + 1) * ECH_CHUNK as u64, "scan check {j}");
        }
        if let Some(j) = phases[1].1.iter().position(|&x| x == k) {
            assert_eq!(at, "decode");
            assert_eq!(mv, (runs + j as u64 + 1) * ECH_CHUNK as u64, "decode check {j}");
        }
    }
    assert_eq!(stops, total);
    // and the next call works, with the same reply
    assert_eq!(call_bin(&q), full);
}
