//! Number fields whose roots lie past the doubles: (x + M) translations,
//! M = 2^1024 + 3, of x^2 - 2, x^2 + 1, x^3 - 2, x^3 - x - 1 and x^4 - x - 1.
//! The precision of the embeddings came from the roots as doubles, infinite
//! here, so w was 0 and unproven; Sage 10.10 gives 2, 4, 2, 2 and 2.
use sagebrush_bigint::BigInt;
use sagebrush_classgroup::api::nf_data;

// f(x + m)'s coefficients, constant first, from f's (constant first)
fn translate(f: &[i64], m: &BigInt) -> Vec<BigInt> {
    let mut out: Vec<BigInt> = vec![BigInt::from(0); f.len()];
    // Horner: g = ((a_n (x + m) + a_{n-1}) (x + m) + ...)
    for &c in f.iter().rev() {
        let mut next = vec![BigInt::from(0); f.len()];
        for (i, a) in out.iter().enumerate() {
            if i + 1 < f.len() {
                next[i + 1] += a;
            }
            next[i] += a * m;
        }
        next[0] += BigInt::from(c);
        out = next;
    }
    out
}

#[test]
fn roots_of_unity_of_translated_fields() {
    let m = (BigInt::from(1) << 1024usize) + BigInt::from(3);
    for (f, w, r1, r2) in [
        (&[-2i64, 0, 1][..], 2u32, 2usize, 0usize),
        (&[1, 0, 1][..], 4, 0, 1),
        (&[-2, 0, 0, 1][..], 2, 1, 1),
        (&[-1, -1, 0, 1][..], 2, 1, 1),
        (&[-1, -1, 0, 0, 1][..], 2, 2, 1),
    ] {
        for shift in [BigInt::from(0), m.clone()] {
            let g = translate(f, &shift);
            let d = nf_data(&g).unwrap();
            assert_eq!((d.w, d.w_proven, d.r1, d.r2), (w, true, r1, r2), "{:?} translated by {}", f, shift.bits());
        }
    }
}
