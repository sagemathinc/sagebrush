//! Every operation, refused part-way (design/mpmath-core.md §4.5): under a
//! limb limit too small for its work, and at a precision no limit admits,
//! each call ends promptly in a value or the limit's refusal, never a panic,
//! a hang or another failure; and the session goes on afterwards, its next
//! call exact.

use sagebrush_mp::abi::{code, op, Core, Val};
use sagebrush_mp::int::Int;
use sagebrush_mp::mpf::{self, Mpf, Rnd};
use sagebrush_mp::nat::{set_max_limbs, Nat};
use std::time::Instant;

fn f(sign: u32, man: u128, exp: i64) -> Mpf {
    sagebrush_mp::fail::checked(|| mpf::from_man_exp(sign, Nat::from_u128(man), exp.into(), 0, Rnd::Nearest)).unwrap()
}

/// (operation, register values) for every operation code.
fn cases() -> Vec<(i32, Vec<Val>)> {
    let x = Val::F(f(0, 0x1234_5678_9abc_def0_1357_9bdf, -100));
    let y = Val::F(f(1, 0xfedc_ba98_7654_3210, 3));
    let big = Val::F(f(0, 3, 4000));
    let i = |v: i64| Val::I(Int::from_i64(v));
    let mut v = vec![];
    for o in [op::ADD, op::SUB, op::MUL, op::DIV, op::POW] {
        v.push((o, vec![x.clone(), y.clone()]));
        v.push((o, vec![big.clone(), x.clone()]));
    }
    for o in [op::SQRT, op::EXP, op::LOG, op::COS, op::SIN, op::NORMALIZE, op::NORMALIZE1] {
        v.push((o, vec![x.clone()]));
        v.push((o, vec![big.clone()]));
    }
    v.push((op::POW, vec![x.clone(), Val::F(f(0, 7, -1))]));
    v.push((op::FROM_MAN_EXP, vec![i(-12345), i(77)]));
    for o in [op::MPC_EXP, op::MPC_SQRT] {
        v.push((o, vec![x.clone(), y.clone()]));
        v.push((o, vec![big.clone(), x.clone()]));
    }
    v.push((op::EXP_FIXED, vec![i(1 << 40), Val::None]));
    v.push((op::COS_SIN_FIXED, vec![i(1 << 50), Val::None]));
    v.push((op::LOG_INT_FIXED, vec![i(1999), Val::None]));
    v.push((op::LOG_INT_FIXED, vec![i(123456789), Val::None]));
    for o in [op::PI_FIXED, op::LN2_FIXED, op::E_FIXED] {
        v.push((o, vec![]));
    }
    for o in [op::BITCOUNT, op::TRAILING, op::ISQRT, op::SQRTREM] {
        v.push((o, vec![i(1 << 40)]));
    }
    // (300!: 2^40! would take the reference hours too)
    v.push((op::IFAC, vec![i(300)]));
    v
}

fn run(c: &mut Core, o: i32, regs: &[Val], prec: f64) -> i32 {
    for (k, r) in regs.iter().enumerate() {
        c.regs[k] = r.clone();
    }
    for k in regs.len()..4 {
        c.set_none(k);
    }
    c.run(o, prec, 0)
}

#[test]
fn refused_part_way_every_operation_ends_cleanly() {
    let mut c = Core::default();
    for (o, regs) in cases() {
        // the exact value, with room
        set_max_limbs(1 << 22);
        let want = run(&mut c, o, &regs, 3000.0);
        assert!(want >= 0, "op {} fails with room: {}", o, want);
        let want_out = c.out.clone();
        for limit in [0usize, 1, 2, 3, 5, 8, 13, 21, 40, 80] {
            set_max_limbs(limit);
            let t = Instant::now();
            if std::env::var("MP_TRACE").is_ok() {
                eprintln!("op {} limit {}", o, limit);
            }
            let got = run(&mut c, o, &regs, 3000.0);
            assert!(t.elapsed().as_secs() < 5, "op {} at {} limbs: {:?}", o, limit, t.elapsed());
            assert!(got >= 0 || got == code::LIMIT, "op {} at {} limbs: {}", o, limit, got);
            if got < 0 {
                assert_eq!(c.out, [Val::None, Val::None], "op {}: a refused call leaves no result", o);
            }
        }
        // the session goes on: the same call, with room again, is exact
        set_max_limbs(1 << 22);
        assert_eq!(run(&mut c, o, &regs, 3000.0), want, "op {}", o);
        assert_eq!(c.out, want_out, "op {} after its refusals", o);
    }
}

#[test]
fn a_precision_no_limit_admits_is_refused_promptly() {
    let mut c = Core::default();
    set_max_limbs(1 << 16);
    for (o, regs) in cases() {
        let t = Instant::now();
        if std::env::var("MP_TRACE").is_ok() {
            eprintln!("op {} at 1e15", o);
        }
        let got = run(&mut c, o, &regs, 1e15);
        assert!(t.elapsed().as_secs() < 5, "op {}: {:?}", o, t.elapsed());
        assert!(got >= 0 || got == code::LIMIT, "op {}: {}", o, got);
    }
    set_max_limbs(1 << 22);
}
