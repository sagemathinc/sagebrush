//! The framing's tests (S6): truncation at every byte, each count and
//! length at its maximum and one past it, exact offsets per error class,
//! non-canonical payloads, unknown op/tag/version/option, the 32-bit
//! conversions, and a fuzz run under catch_unwind.  The allocation spy and
//! the decode peaks are engine/web/tests/bin_alloc.rs.

extern crate std;

use super::*;
use alloc::vec;
use alloc::vec::Vec;

const SPEC: OpSpec = OpSpec { min_args: 1, max_args: 3, request_cap: 1 << 20 };

fn lookup(op: &str) -> Option<OpSpec> {
    match op {
        "nmod_poly_mul" | "x" => Some(SPEC),
        "abcdefghijklmnopqrstuvwxyz012345" => Some(SPEC),
        _ => None,
    }
}

fn frame(op: &[u8], args: &[&[u8]]) -> Vec<u8> {
    let mut v = MAGIC.to_vec();
    v.extend_from_slice(&(op.len() as u32).to_le_bytes());
    v.extend_from_slice(op);
    v.extend_from_slice(&(args.len() as u32).to_le_bytes());
    for a in args {
        v.extend_from_slice(&(a.len() as u32).to_le_bytes());
        v.extend_from_slice(a);
    }
    v
}

fn u641p(w: &[u64]) -> Vec<u8> {
    let mut v = Vec::new();
    put_u641(&mut v, w);
    v
}

fn i641p(w: &[i64]) -> Vec<u8> {
    let mut v = b"I641".to_vec();
    v.extend_from_slice(&(w.len() as u64).to_le_bytes());
    for x in w {
        v.extend_from_slice(&x.to_le_bytes());
    }
    v
}

/// One integer as (neg, limbs), written verbatim (canonical or not).
fn zv_body(xs: &[(bool, &[u64])]) -> Vec<u8> {
    let mut v = (xs.len() as u64).to_le_bytes().to_vec();
    for (neg, limbs) in xs {
        v.extend_from_slice(&(((limbs.len() as u32) << 1) | *neg as u32).to_le_bytes());
        for l in limbs.iter() {
            v.extend_from_slice(&l.to_le_bytes());
        }
    }
    v
}

fn zvp(xs: &[(bool, &[u64])]) -> Vec<u8> {
    let mut v = b"ZV_1".to_vec();
    v.extend(zv_body(xs));
    v
}

fn qvp(num: &[(bool, &[u64])], den: &[(bool, &[u64])]) -> Vec<u8> {
    let mut v = b"QV_1".to_vec();
    v.extend(zvp(num));
    v.extend(zvp(den));
    v
}

fn arg(b: &[u8]) -> Arg<'_> {
    Arg { bytes: b, offset: 100 }
}

const Z: (bool, &[u64]) = (false, &[]);
const ONE: (bool, &[u64]) = (false, &[1]);
const TWO: (bool, &[u64]) = (false, &[2]);

#[test]
fn a_frame_is_admitted_and_borrowed() {
    let p = u641p(&[1, 2, 3]);
    let s = u641p(&[7]);
    let req = frame(b"nmod_poly_mul", &[&p, &s]);
    let f = admit(&req, lookup).unwrap();
    assert_eq!(f.op, "nmod_poly_mul");
    assert_eq!(f.nargs(), 2);
    let a0 = f.arg(0).unwrap();
    // header 4, name length 4 + 13, count 4, arg length 4
    assert_eq!(a0.offset, 4 + 4 + 13 + 4 + 4);
    let v = u641(a0).unwrap();
    assert_eq!(v.iter().collect::<Vec<_>>(), vec![1, 2, 3]);
    assert_eq!(scalar(f.arg(1).unwrap()).unwrap(), 7);
    assert!(f.arg(2).is_none());
}

#[test]
fn every_truncation_of_a_request_is_a_typed_error() {
    let p = u641p(&[1, 2, 3]);
    let req = frame(b"x", &[&p, &u641p(&[5])]);
    for cut in 0..req.len() {
        let e = admit(&req[..cut], lookup).unwrap_err();
        assert!(matches!(e.code, Code::Header | Code::Frame), "cut {cut}: {e:?}");
        assert!(e.offset <= cut as u64, "cut {cut}: {e:?}");
    }
    assert!(admit(&req, lookup).is_ok());
    // and every truncation of each payload
    for cut in 0..p.len() {
        assert!(u641(arg(&p[..cut])).is_err());
    }
}

#[test]
fn the_header_is_exact() {
    let req = frame(b"x", &[&u641p(&[1])]);
    let mut r = req.clone();
    r[0] = b'T';
    assert_eq!(admit(&r, lookup).unwrap_err(), WireError { code: Code::Header, offset: 0, what: "not an SBW frame" });
    let mut r = req.clone();
    r[3] = b'2';
    let e = admit(&r, lookup).unwrap_err();
    assert_eq!((e.code, e.offset), (Code::Header, 3));
    // a headerless (legacy mpoly) frame is refused, never parsed
    let e = admit(&req[4..], lookup).unwrap_err();
    assert_eq!(e.code, Code::Header);
}

#[test]
fn op_names_at_the_bounds() {
    let a = u641p(&[1]);
    let ok32 = frame(b"abcdefghijklmnopqrstuvwxyz012345", &[&a]);
    assert!(admit(&ok32, lookup).is_ok());
    for (name, off) in [(&b""[..], 4u64), (&b"abcdefghijklmnopqrstuvwxyz0123456"[..], 4)] {
        let e = admit(&frame(name, &[&a]), lookup).unwrap_err();
        assert_eq!((e.code, e.offset), (Code::Op, off), "{e:?}");
    }
    for bad in [&b"X"[..], b"a-b", b"a b", b"\xff"] {
        let e = admit(&frame(bad, &[&a]), lookup).unwrap_err();
        assert_eq!((e.code, e.offset, e.what), (Code::Op, 8, "an op name with a character outside [a-z0-9_]"));
    }
    let e = admit(&frame(b"nope", &[&a]), lookup).unwrap_err();
    assert_eq!((e.code, e.offset, e.what), (Code::Op, 8, "an unknown op"));
}

#[test]
fn argument_counts_at_the_bounds() {
    let a = u641p(&[1]);
    let at = 4 + 4 + 1; // the count's offset for op "x"
    for n in 0..=MAX_ARGS + 1 {
        let args: Vec<&[u8]> = (0..n).map(|_| &a[..]).collect();
        let req = frame(b"x", &args);
        let r = admit(&req, lookup);
        if (SPEC.min_args..=SPEC.max_args).contains(&n) {
            assert_eq!(r.unwrap().nargs(), n);
        } else {
            let e = r.unwrap_err();
            assert_eq!((e.code, e.offset), (Code::Count, at as u64), "{n}");
        }
    }
    // an op declaring more than MAX_ARGS still gets at most MAX_ARGS
    let wide = |_: &str| Some(OpSpec { min_args: 0, max_args: 100, request_cap: 1 << 20 });
    let args: Vec<&[u8]> = (0..MAX_ARGS).map(|_| &a[..]).collect();
    assert!(admit(&frame(b"x", &args), wide).is_ok());
    let args: Vec<&[u8]> = (0..MAX_ARGS + 1).map(|_| &a[..]).collect();
    assert_eq!(admit(&frame(b"x", &args), wide).unwrap_err().code, Code::Count);
    // a count of u32::MAX with no bytes behind it
    let mut r = frame(b"x", &[]);
    let n = r.len();
    r[n - 4..].copy_from_slice(&u32::MAX.to_le_bytes());
    assert_eq!(admit(&r, wide).unwrap_err().code, Code::Count);
}

#[test]
fn argument_lengths_are_checked_against_the_bytes_present() {
    let a = u641p(&[1, 2]);
    let req = frame(b"x", &[&a]);
    let len_at = 4 + 4 + 1 + 4;
    // a length one past the bytes present
    let mut r = req.clone();
    r[len_at..len_at + 4].copy_from_slice(&((a.len() + 1) as u32).to_le_bytes());
    let e = admit(&r, lookup).unwrap_err();
    assert_eq!((e.code, e.offset), (Code::Frame, (len_at + 4) as u64));
    // u32::MAX
    r[len_at..len_at + 4].copy_from_slice(&u32::MAX.to_le_bytes());
    assert_eq!(admit(&r, lookup).unwrap_err().code, Code::Frame);
    // one short: the last byte is trailing
    r[len_at..len_at + 4].copy_from_slice(&((a.len() - 1) as u32).to_le_bytes());
    let e = admit(&r, lookup).unwrap_err();
    assert_eq!((e.code, e.offset), (Code::Frame, (req.len() - 1) as u64));
    // trailing bytes after the last argument
    let mut r = req.clone();
    r.push(0);
    let e = admit(&r, lookup).unwrap_err();
    assert_eq!((e.code, e.offset, e.what), (Code::Frame, req.len() as u64, "trailing bytes after the last argument"));
}

#[test]
fn the_frame_cap_and_the_op_cap() {
    let req = frame(b"x", &[&u641p(&[1, 2, 3])]);
    let n = req.len();
    assert!(admit_with(&req, lookup, usize_bound(), n).is_ok());
    let e = admit_with(&req, lookup, usize_bound(), n - 1).unwrap_err();
    assert_eq!((e.code, e.offset, e.what), (Code::Cap, 0, "the request exceeds the frame cap"));
    // the frame cap is checked first: even a headerless frame gets Cap
    let e = admit_with(&[0u8; 9], lookup, usize_bound(), 8).unwrap_err();
    assert_eq!(e.code, Code::Cap);
    let capped = |c: usize| move |_: &str| Some(OpSpec { min_args: 1, max_args: 1, request_cap: c });
    assert!(admit(&req, capped(n)).is_ok());
    let e = admit(&req, capped(n - 1)).unwrap_err();
    assert_eq!((e.code, e.offset, e.what), (Code::Cap, 0, "the request exceeds the op's cap"));
    // the op cap applies only to a well-formed frame of a known op: an
    // unknown op over any cap is an op error
    let e = admit(&frame(b"nope", &[&u641p(&[1])]), |_| None).unwrap_err();
    assert_eq!(e.code, Code::Op);
}

#[test]
fn word_vectors_at_the_bounds() {
    let p = u641p(&[1, 2, 3]);
    assert_eq!(u641(arg(&p)).unwrap().count, 3);
    // count one past the bytes present, then u64::MAX
    let mut q = p.clone();
    q[4..12].copy_from_slice(&4u64.to_le_bytes());
    let e = u641(arg(&q)).unwrap_err();
    assert_eq!((e.code, e.offset), (Code::Count, 104));
    q[4..12].copy_from_slice(&u64::MAX.to_le_bytes());
    assert_eq!(u641(arg(&q)).unwrap_err().code, Code::Count);
    // count one short: the payload is not consumed exactly
    q[4..12].copy_from_slice(&2u64.to_le_bytes());
    let e = u641(arg(&q)).unwrap_err();
    assert_eq!((e.code, e.offset), (Code::Schema, 100 + 4 + 8 + 16));
    // a wrong tag, an unknown version
    let mut q = p.clone();
    q[3] = b'2';
    let e = u641(arg(&q)).unwrap_err();
    assert_eq!((e.code, e.offset), (Code::Schema, 100));
    assert_eq!(u641(arg(&i641p(&[1]))).unwrap_err().code, Code::Schema);
    // a scalar is exactly one word
    assert_eq!(scalar(arg(&u641p(&[]))).unwrap_err().code, Code::Count);
    assert_eq!(scalar(arg(&u641p(&[1, 2]))).unwrap_err().code, Code::Count);
    assert_eq!(scalar(arg(&u641p(&[u64::MAX]))).unwrap(), u64::MAX);
}

#[test]
fn wasm32_width_conversions_refuse_what_does_not_fit() {
    let w32 = u64::from(u32::MAX);
    // a count of 2^32 words: on a 32-bit usize it is refused at conversion
    let mut q = u641p(&[]);
    q[4..12].copy_from_slice(&(1u64 << 32).to_le_bytes());
    let e = u641_with(arg(&q), w32).unwrap_err();
    assert_eq!((e.code, e.what), (Code::Count, "a count too large for this platform"));
    // u32::MAX itself converts, then fails the bytes-present check
    q[4..12].copy_from_slice(&w32.to_le_bytes());
    let e = u641_with(arg(&q), w32).unwrap_err();
    assert_eq!((e.code, e.what), (Code::Count, "an element count larger than the bytes present"));
    let mut z = zvp(&[]);
    z[4..12].copy_from_slice(&(1u64 << 32).to_le_bytes());
    assert_eq!(zv1_with(arg(&z), w32).unwrap_err().what, "a count too large for this platform");
    // rows x cols overflowing a 32-bit usize is refused by the checked
    // product before any entry is read (on 64 bits: counted against bytes)
    let mut m = b"MAT1".to_vec();
    m.extend_from_slice(&u32::MAX.to_le_bytes());
    m.extend_from_slice(&u32::MAX.to_le_bytes());
    m.extend(u641p(&[]));
    assert_eq!(mat1(arg(&m), ElemKind::Words, false).unwrap_err().code, Code::Count);
    assert_eq!(to_usize(w32 + 1, w32, 7).unwrap_err().offset, 7);
    assert_eq!(to_usize(w32, w32, 7).unwrap(), u32::MAX as usize);
    // the frame's u32 fields convert on 32 bits
    let req = frame(b"x", &[&u641p(&[1])]);
    assert!(admit_with(&req, lookup, w32, FRAME_CAP).is_ok());
}

#[test]
fn big_integers_are_canonical() {
    let ok = zvp(&[Z, ONE, (true, &[5]), (false, &[0, 1])]);
    let z = zv1(arg(&ok)).unwrap();
    assert_eq!(z.count, 4);
    assert_eq!(z.max_limbs, 2);
    let got: Vec<Option<i64>> = z.iter().map(|b| b.to_i64()).collect();
    assert_eq!(got, vec![Some(0), Some(1), Some(-5), None]);
    // a negative zero, a leading zero limb (each at its header's offset)
    let e = zv1(arg(&zvp(&[ONE, (true, &[])]))).unwrap_err();
    assert_eq!((e.code, e.offset), (Code::Schema, 100 + 4 + 8 + 12));
    let e = zv1(arg(&zvp(&[(false, &[1, 0])]))).unwrap_err();
    assert_eq!((e.code, e.offset), (Code::Schema, 100 + 4 + 8));
    let e = zv1(arg(&zvp(&[(true, &[0])]))).unwrap_err();
    assert_eq!(e.code, Code::Schema);
    // lying counts: entries and limbs
    let mut q = zvp(&[ONE]);
    q[4..12].copy_from_slice(&2u64.to_le_bytes());
    let e = zv1(arg(&q)).unwrap_err();
    assert_eq!((e.code, e.offset, e.what), (Code::Schema, 100 + 24, "a truncated integer header"));
    q[4..12].copy_from_slice(&4u64.to_le_bytes());
    let e = zv1(arg(&q)).unwrap_err();
    assert_eq!((e.code, e.offset), (Code::Count, 104));
    let mut q = zvp(&[ONE]);
    q[12..16].copy_from_slice(&(2u32 << 1).to_le_bytes());
    assert_eq!(zv1(arg(&q)).unwrap_err().code, Code::Count);
    // the maximal limb count: refused against the bytes present
    q[12..16].copy_from_slice(&u32::MAX.to_le_bytes());
    assert_eq!(zv1(arg(&q)).unwrap_err().code, Code::Count);
    for cut in 0..ok.len() {
        assert!(zv1(arg(&ok[..cut])).is_err());
    }
}

#[test]
fn heap_bounds_follow_the_closed_form() {
    assert_eq!(bigint_heap_words(0), Some(0));
    assert_eq!(bigint_heap_words(2), Some(0));
    assert_eq!(bigint_heap_words(3), Some(3 + 4));
    assert_eq!(bigint_heap_words(8), Some(8 + 2 + 4));
    assert_eq!(bigint_heap_words(u64::MAX), None);
    let p = zvp(&[(false, &[1, 1, 1]), ONE, (false, &[1; 8])]);
    let z = zv1(arg(&p)).unwrap();
    assert_eq!(z.heap_words, 7 + 14);
}

#[test]
fn the_narrowest_tag_rule_is_per_payload_at_exactly_the_i64_bounds() {
    let min = i64::MIN.unsigned_abs(); // 2^63
    let max = i64::MAX as u64;
    // as I641, the extremes are ordinary entries
    match ints(arg(&i641p(&[i64::MIN, i64::MAX]))).unwrap() {
        Ints::Small(s) => assert_eq!((s.get(0), s.get(1)), (i64::MIN, i64::MAX)),
        Ints::Big(_) => panic!(),
    }
    // as ZV_1 where all entries fit: refused, at the payload's offset
    for v in [(true, min), (false, max), (false, 0), (true, 1)] {
        let p = if v.1 == 0 { zvp(&[Z]) } else { zvp(&[(v.0, &[v.1])]) };
        let e = ints(arg(&p)).unwrap_err();
        assert_eq!((e.code, e.offset), (Code::Schema, 100), "{v:?}");
    }
    // one past either bound: accepted, and the fitting entries alongside
    // it are fine (the rule is per payload)
    for v in [(true, min + 1), (false, max + 1)] {
        let p = zvp(&[ONE, (v.0, &[v.1]), (true, &[min])]);
        match ints(arg(&p)).unwrap() {
            Ints::Big(z) => assert!(!z.all_fit_i64),
            Ints::Small(_) => panic!(),
        }
    }
    assert_eq!(ints(arg(&zvp(&[(false, &[0, 1])]))).map(|_| ()), Ok(()));
    // an empty ZV_1 here "all fits": it must be an empty I641
    assert!(ints(arg(&zvp(&[]))).is_err());
    assert!(ints(arg(&i641p(&[]))).is_ok());
    assert_eq!(ints(arg(&u641p(&[1]))).unwrap_err().code, Code::Schema);
}

#[test]
fn rationals_are_canonical_but_small_values_are_ordinary() {
    // small rationals inside QV_1 are accepted (no narrowest-tag rule)
    let q = qvp(&[Z, ONE, (true, &[1])], &[ONE, TWO, (false, &[3])]);
    let v = qv1(arg(&q)).unwrap();
    assert_eq!((v.num.count, v.den.count), (3, 3));
    // zero must be 0/1; denominators positive; counts equal
    for (num, den) in [
        (vec![Z], vec![TWO]),
        (vec![ONE], vec![Z]),
        (vec![ONE], vec![(true, &[1][..])]),
        (vec![ONE, ONE], vec![ONE]),
    ] {
        let p = qvp(&num, &den);
        let e = qv1(arg(&p)).unwrap_err();
        assert_eq!(e.code, Code::Schema, "{num:?} / {den:?}");
    }
    // a non-canonical integer inside
    assert!(qv1(arg(&qvp(&[(false, &[1, 0])], &[ONE]))).is_err());
    let mut t = q.clone();
    t.push(0);
    assert!(qv1(arg(&t)).is_err());
    for cut in 0..q.len() {
        assert!(qv1(arg(&q[..cut])).is_err());
    }
}

fn matp(rows: u32, cols: u32, elems: &[u8]) -> Vec<u8> {
    let mut m = b"MAT1".to_vec();
    m.extend_from_slice(&rows.to_le_bytes());
    m.extend_from_slice(&cols.to_le_bytes());
    m.extend_from_slice(elems);
    m
}

#[test]
fn matrices_have_exactly_rows_times_cols_entries() {
    let m = matp(2, 3, &u641p(&[1, 2, 3, 4, 5, 6]));
    let v = mat1(arg(&m), ElemKind::Words, false).unwrap();
    assert_eq!((v.rows, v.cols), (2, 3));
    for (r, c) in [(2, 2), (3, 3), (1, 6)] {
        if r * c == 6 {
            assert!(mat1(arg(&matp(r, c, &u641p(&[1, 2, 3, 4, 5, 6]))), ElemKind::Words, false).is_ok());
        } else {
            let e = mat1(arg(&matp(r, c, &u641p(&[1, 2, 3, 4, 5, 6]))), ElemKind::Words, false).unwrap_err();
            assert_eq!((e.code, e.offset), (Code::Count, 100 + 12));
        }
    }
    // the element kind is the op's
    assert_eq!(mat1(arg(&m), ElemKind::Ints, false).unwrap_err().code, Code::Schema);
    // empty only where allowed
    let e = matp(0, 3, &u641p(&[]));
    assert_eq!(mat1(arg(&e), ElemKind::Words, false).unwrap_err().code, Code::Count);
    assert!(mat1(arg(&e), ElemKind::Words, true).is_ok());
    // integer entries follow the narrowest-tag rule; rationals don't
    let small = matp(1, 2, &zvp(&[ONE, TWO]));
    assert_eq!(mat1(arg(&small), ElemKind::Ints, false).unwrap_err().code, Code::Schema);
    assert!(mat1(arg(&matp(1, 2, &i641p(&[1, 2]))), ElemKind::Ints, false).is_ok());
    let q = matp(1, 2, &qvp(&[ONE, Z], &[TWO, ONE]));
    assert!(mat1(arg(&q), ElemKind::Rationals, false).is_ok());
    let q = matp(1, 2, &qvp(&[ONE, Z], &[TWO, TWO]));
    assert!(mat1(arg(&q), ElemKind::Rationals, false).is_err());
    let mut t = m.clone();
    t.push(0);
    assert!(mat1(arg(&t), ElemKind::Words, false).is_err());
    for cut in 0..m.len() {
        assert!(mat1(arg(&m[..cut]), ElemKind::Words, false).is_err());
    }
}

fn mqrp(cols: u32, rows: &[&[(bool, &[u64])]]) -> Vec<u8> {
    let mut m = b"MQR1".to_vec();
    m.extend_from_slice(&(rows.len() as u32).to_le_bytes());
    m.extend_from_slice(&cols.to_le_bytes());
    for r in rows {
        m.extend(zvp(r));
    }
    m
}

#[test]
fn cleared_rows_are_canonical() {
    // small and all-zero rows are accepted (no narrowest-tag rule)
    let m = mqrp(2, &[&[TWO, ONE, Z], &[ONE, Z, Z], &[ONE, (false, &[0, 1]), ONE]]);
    let v = mqr1(arg(&m)).unwrap();
    assert_eq!((v.rows, v.cols, v.max_limbs), (3, 2, 2));
    assert_eq!(v.rows_iter().count(), 3);
    // an all-zero row must have d = 1; d > 0; exactly cols + 1 integers
    let row_at = 100 + 12;
    for bad in [&[TWO, Z, Z][..], &[Z, ONE, ONE], &[(true, &[1][..]), ONE, ONE], &[ONE, ONE], &[ONE, ONE, ONE, ONE]] {
        let e = mqr1(arg(&mqrp(2, &[bad]))).unwrap_err();
        assert_eq!(e.offset, row_at, "{bad:?}");
    }
    assert!(mqr1(arg(&mqrp(2, &[&[ONE, (false, &[1, 0]), ONE]]))).is_err());
    // many rows of zero columns: each row is its denominator alone
    let ones: Vec<&[(bool, &[u64])]> = (0..50).map(|_| &[ONE][..]).collect();
    assert_eq!(mqr1(arg(&mqrp(0, &ones))).unwrap().rows, 50);
    // a maximal row count with minimal bytes
    let mut h = mqrp(0, &[&[ONE]]);
    h[4..8].copy_from_slice(&u32::MAX.to_le_bytes());
    let e = mqr1(arg(&h)).unwrap_err();
    assert_eq!((e.code, e.offset), (Code::Count, 104));
    let mut h = mqrp(0, &[&[ONE]]);
    h[8..12].copy_from_slice(&u32::MAX.to_le_bytes());
    assert_eq!(mqr1(arg(&h)).unwrap_err().code, Code::Count);
    for cut in 0..m.len() {
        assert!(mqr1(arg(&m[..cut])).is_err());
    }
    let mut t = m.clone();
    t.push(0);
    assert!(mqr1(arg(&t)).is_err());
}

fn txtp(s: &[u8]) -> Vec<u8> {
    let mut v = b"TXT1".to_vec();
    v.extend_from_slice(s);
    v
}

#[test]
fn options_text_follows_the_closed_grammar() {
    let allow = ["alg", "proof", "z9"];
    let t = txtp(b"alg=bsgs\nproof=1\n");
    let o = txt1(arg(&t), &allow).unwrap();
    assert_eq!(o.get("alg"), Some("bsgs"));
    assert_eq!(o.get("proof"), Some("1"));
    assert_eq!(o.get("z9"), None);
    assert!(txt1(arg(&txtp(b"")), &allow).is_ok());
    let bad: [&[u8]; 16] = [
        b"alg=bsgs",              // no final LF
        b"alg=bsgs\r\n",          // CR
        b"\n",                    // an empty line
        b"alg=a\n\nproof=1\n",    // an empty line inside
        b"proof=1\nalg=a\n",      // out of order
        b"alg=a\nalg=b\n",        // repeated
        b"alg=\n",                // empty value
        b"alg=a=b\n",             // '=' in a value
        b"alg=a b\n",             // space
        b"alg=\x7f\n",            // DEL
        b"Alg=a\n",               // key case
        b"9=a\n",                 // key start
        b"=a\n",                  // empty key
        b"alg\n",                 // no '='
        b"other=a\n",             // not in the allowlist
        b"alg=\xc3\xa9\n",        // not ASCII
    ];
    for b in bad {
        let e = txt1(arg(&txtp(b)), &allow).unwrap_err();
        assert!(e.offset >= 104, "{e:?}");
    }
    // a 64-byte value and a 32-byte key; one more of either fails
    let k32 = [b'a'; 32];
    let mut s = k32.to_vec();
    s.push(b'=');
    s.extend([b'v'; 64]);
    s.push(b'\n');
    let k = core::str::from_utf8(&k32).unwrap();
    assert!(txt1(arg(&txtp(&s)), &[k]).is_ok());
    let mut s65 = s.clone();
    s65.insert(40, b'v');
    assert!(txt1(arg(&txtp(&s65)), &[k]).is_err());
    let mut k33 = s.clone();
    k33.insert(0, b'a');
    let k33s = core::str::from_utf8(&k33[..33]).unwrap();
    assert!(txt1(arg(&txtp(&k33)), &[k33s]).is_err());
    // 16 lines pass, 17 don't
    let keys: Vec<std::string::String> = (0..17).map(|i| std::format!("k{:02}", i)).collect();
    let refs: Vec<&str> = keys.iter().map(|s| s.as_str()).collect();
    let text = |n: usize| keys[..n].iter().map(|k| std::format!("{k}=1\n")).collect::<std::string::String>();
    assert!(txt1(arg(&txtp(text(16).as_bytes())), &refs).is_ok());
    assert_eq!(txt1(arg(&txtp(text(17).as_bytes())), &refs).unwrap_err().code, Code::Count);
    // 1 KiB passes, 1 KiB + 1 doesn't
    let line = |c: u8| {
        let mut l = b"a=".to_vec();
        l.extend([c; 61]);
        l.push(b'\n');
        l
    };
    let mut kib = Vec::new();
    for i in 0..16 {
        let mut l = line(b'x');
        l[0] = b'a' + i as u8;
        kib.extend(l);
    }
    assert_eq!(kib.len(), 1024);
    let ab: Vec<std::string::String> = (0..17).map(|i| std::format!("{}", (b'a' + i as u8) as char)).collect();
    let abr: Vec<&str> = ab.iter().map(|s| s.as_str()).collect();
    assert!(txt1(arg(&txtp(&kib)), &abr).is_ok());
    kib.insert(2, b'x');
    assert_eq!(txt1(arg(&txtp(&kib)), &abr).unwrap_err().code, Code::Cap);
}

#[test]
fn ok_replies_round_trip_and_every_truncation_is_an_error() {
    let a = u641p(&[1, 2]);
    let b = u641p(&[]);
    let need = ok_len(&[a.len(), b.len()]).unwrap();
    let mut out = Vec::with_capacity(need);
    write_ok(&mut out, &[&a, &b]).unwrap();
    assert_eq!(out.len(), need);
    assert_eq!(parse_reply(&out).unwrap().unwrap(), vec![&a[..], &b[..]]);
    for cut in 0..out.len() {
        assert!(parse_reply(&out[..cut]).is_err(), "{cut}");
    }
    let mut t = out.clone();
    t.push(0);
    assert!(parse_reply(&t).is_err());
    // a buffer not sized to the bound is an internal error, not a regrowth
    let mut small = Vec::with_capacity(need - 1);
    assert_eq!(write_ok(&mut small, &[&a, &b]).unwrap_err().code, Code::Internal);
    assert!(small.is_empty());
    assert_eq!(u641_len(2), Some(a.len()));
    assert_eq!(ok_len(&[u32::MAX as usize]), Some(10 + 4 + u32::MAX as usize));
    if usize::BITS > 32 {
        assert_eq!(ok_len(&[u32::MAX as usize + 1]), None);
    }
}

#[test]
fn error_replies_are_bounded_and_never_echo_the_request() {
    // a request whose bytes are a recognizable marker everywhere
    let mut req = frame(b"nope", &[&[0xAB; 40]]);
    req.extend([0xAB; 20]);
    let e = admit(&req, lookup).unwrap_err();
    let r = error_reply(&e);
    assert!(r.len() <= ERROR_REPLY_MAX);
    assert!(!r.windows(4).any(|w| w == b"nope"));
    assert_eq!(parse_reply(&r).unwrap(), Err((Code::Op as u16, 8)));
    for cut in 0..r.len() {
        assert!(parse_reply(&r[..cut]).is_err(), "{cut}");
    }
    // the codes are the S6 table's
    let codes = [Code::Frame, Code::Header, Code::Op, Code::Count, Code::Schema, Code::Domain, Code::Cap, Code::Internal];
    for (i, c) in codes.iter().enumerate() {
        assert_eq!(*c as u16, i as u16 + 1);
    }
}

fn rng(s: &mut u64) -> u64 {
    *s ^= *s << 13;
    *s ^= *s >> 7;
    *s ^= *s << 17;
    *s
}

/// Every view applied to every argument of a possibly-mangled frame.
fn parse_everything(req: &[u8]) {
    if let Ok(f) = admit(req, |_| Some(OpSpec { min_args: 0, max_args: 8, request_cap: 1 << 20 })) {
        for i in 0..f.nargs() {
            let a = f.arg(i).unwrap();
            let _ = u641(a);
            let _ = scalar(a);
            let _ = i641(a);
            let _ = zv1(a).map(|z| z.iter().filter_map(|b| b.to_i64()).count());
            let _ = ints(a);
            let _ = qv1(a);
            let _ = mat1(a, ElemKind::Words, true);
            let _ = mat1(a, ElemKind::Ints, true);
            let _ = mat1(a, ElemKind::Rationals, true);
            let _ = mqr1(a).map(|m| m.rows_iter().count());
            let _ = txt1(a, &["a", "b"]);
        }
    }
    let _ = parse_reply(req);
}

#[test]
fn fuzzed_frames_give_typed_errors_and_never_panic() {
    let seeds: Vec<Vec<u8>> = vec![
        frame(b"x", &[&u641p(&[1, 2, 3]), &u641p(&[7])]),
        frame(b"x", &[&zvp(&[ONE, (true, &[3, 4])]), &i641p(&[-1])]),
        frame(b"x", &[&qvp(&[ONE], &[TWO]), &matp(1, 1, &u641p(&[3]))]),
        frame(b"x", &[&mqrp(1, &[&[ONE, TWO], &[ONE, Z]]), &txtp(b"a=1\n")]),
        frame(b"x", &[&matp(1, 1, &qvp(&[ONE], &[TWO]))]),
    ];
    let mut s = 0x9E37_79B9_7F4A_7C15u64;
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        for _ in 0..20000 {
            let mut v = seeds[(rng(&mut s) % seeds.len() as u64) as usize].clone();
            for _ in 0..1 + rng(&mut s) % 4 {
                let i = (rng(&mut s) % v.len() as u64) as usize;
                match rng(&mut s) % 4 {
                    0 => v[i] = rng(&mut s) as u8,
                    1 => v[i] = [0, 1, 0xff, 0x7f, 0x80][(rng(&mut s) % 5) as usize],
                    2 => v.truncate(i),
                    _ => v.insert(i, rng(&mut s) as u8),
                }
                if v.is_empty() {
                    break;
                }
            }
            parse_everything(&v);
        }
        for _ in 0..5000 {
            let n = (rng(&mut s) % 64) as usize;
            let mut v = MAGIC.to_vec();
            v.extend((0..n).map(|_| rng(&mut s) as u8));
            parse_everything(&v);
        }
    }));
    assert!(r.is_ok());
}
