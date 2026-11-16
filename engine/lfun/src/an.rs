//! The Dirichlet coefficients a_n of L(E, s) from the a_p.
//!
//! a_1 = 1; a_mn = a_m a_n for coprime m, n; at a prime p of good reduction
//! a_(p^(k+1)) = a_p a_(p^k) - p a_(p^(k-1)), and at a prime of bad reduction
//! a_(p^k) = a_p^k with a_p in {-1, 0, 1} (Silverman, The Arithmetic of
//! Elliptic Curves, 2nd ed., V.2 and C.16).

use sagebrush_ap::{aplist, EllipticCurve};

/// The largest n an `anlist` may be asked for.
pub const MAX_TERMS: usize = 50_000_000;

/// a_p at one prime, and whether E has good reduction there.  `anlist` needs
/// one for each prime dividing the discriminant of the model it is given
/// (that model need not be minimal: a prime of good reduction may divide it).
#[derive(Clone, Copy, Debug)]
pub struct Local {
    pub p: u64,
    pub ap: i64,
    pub good: bool,
}

/// [0, a_1, ..., a_n] for the curve with Weierstrass coefficients `a`; `local`
/// gives a_p at every prime dividing the discriminant of that model (and may
/// give it at others, which it then overrides).  An error if a prime dividing
/// the discriminant is missing, a bad prime's a_p is not -1, 0 or 1, n exceeds
/// MAX_TERMS, or the curve is singular.  Interruptible.
pub fn anlist(a: [i64; 5], local: &[Local], n: usize) -> Result<Vec<i64>, String> {
    if n > MAX_TERMS {
        return Err(format!("anlist: at most {} coefficients", MAX_TERMS));
    }
    for l in local {
        if !l.good && !(-1..=1).contains(&l.ap) {
            return Err(format!("anlist: a_p at the bad prime {} must be -1, 0 or 1, not {}", l.p, l.ap));
        }
    }
    let e = EllipticCurve::new(a)?;
    let mut an = vec![1i64; n + 1];
    an[0] = 0;
    if n == 0 {
        return Ok(an);
    }
    let aps = aplist(&e, n as u64);
    // (after aplist, whose sieve and a_p loop check in their own phases)
    let _phase = sagebrush_interrupt::enter("lfun.anlist");
    for (p, ap) in aps {
        let (ap, good) = match local.iter().find(|l| l.p == p) {
            Some(l) => (l.ap, l.good),
            None => match ap {
                Some(v) => (v, true),
                None => return Err(format!("anlist: a_p at {}, which divides the discriminant, is needed", p)),
            },
        };
        // a_(p^k) for p^k <= n, and each multiple j of p^k with p^(k+1) not dividing j
        let (mut prev, mut cur) = (1i64, ap);
        let mut pk = p as usize;
        loop {
            let mut j = pk;
            while j <= n {
                if !(j / pk).is_multiple_of(p as usize) {
                    an[j] *= cur;
                }
                j += pk;
            }
            sagebrush_interrupt::check_coarse();
            let next = if good { ap * cur - p as i64 * prev } else { ap * cur };
            prev = cur;
            cur = next;
            match pk.checked_mul(p as usize) {
                Some(x) if x <= n => pk = x,
                _ => break,
            }
        }
    }
    Ok(an)
}
