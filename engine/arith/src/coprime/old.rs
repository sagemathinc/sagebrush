//! Today's Knuth D and one-limb divisions (before invariant division),
//! kept verbatim for the differential test only: the u128 `/` and `%`
//! per quotient limb, the D3 correction loop.  Never used outside tests.
//! The only change from the original: counters of the D3 loop's
//! corrections (`hits`), for the differential test's coverage rows.

use super::{apply_window, less, norm, rem_first, window, Fault, Meter, LEHMER_STEPS};

/// x mod y in place (Knuth D, the quotient discarded), for ny >= 2, x >= y
/// (nx >= ny), x with room for nx + 1 limbs.  y is normalized in place and
/// restored.  The remainder's length.
pub(super) fn rem_in_place(x: &mut [u64], nx: usize, y: &mut [u64], ny: usize, m: &mut Meter) -> Result<usize, Fault> {
    let s = y[ny - 1].leading_zeros();
    m.add(nx + ny + 2)?;
    if s > 0 {
        for i in (1..ny).rev() {
            y[i] = (y[i] << s) | (y[i - 1] >> (64 - s));
        }
        y[0] <<= s;
        x[nx] = x[nx - 1] >> (64 - s);
        for i in (1..nx).rev() {
            x[i] = (x[i] << s) | (x[i - 1] >> (64 - s));
        }
        x[0] <<= s;
    } else {
        x[nx] = 0;
    }
    let (y1, y2) = (u128::from(y[ny - 1]), u128::from(y[ny - 2]));
    for j in (0..=nx - ny).rev() {
        m.add(2 * ny + 4)?;
        let top = (u128::from(x[j + ny]) << 64) | u128::from(x[j + ny - 1]);
        // top < y1 2^64 (the running remainder is below y): qh < 2^64 + 2
        let mut qh = top / y1;
        let mut rh = top % y1;
        // at most two corrections (Knuth D3)
        let (mut big, mut by_y2, mut brk) = (0, 0, false);
        while qh >> 64 != 0 || qh * y2 > ((rh << 64) | u128::from(x[j + ny - 2])) {
            if qh >> 64 != 0 {
                big += 1;
            } else {
                by_y2 += 1;
            }
            qh -= 1;
            rh += y1;
            if rh >> 64 != 0 {
                brk = true;
                break;
            }
        }
        if big > 0 {
            super::hits::hit(super::hits::D3_QBIG);
        }
        if by_y2 >= 1 {
            super::hits::hit(super::hits::D3_Y2_ONCE);
        }
        if by_y2 >= 2 {
            super::hits::hit(super::hits::D3_Y2_TWICE);
        }
        if brk {
            super::hits::hit(super::hits::D3_RH_BREAK);
        }
        // x[j .. j + ny + 1] -= qh y
        let (mut borrow, mut carry) = (0u64, 0u128);
        for i in 0..ny {
            let p = qh * u128::from(y[i]) + carry;
            carry = p >> 64;
            let (d, b1) = x[j + i].overflowing_sub(p as u64);
            let (d, b2) = d.overflowing_sub(borrow);
            x[j + i] = d;
            borrow = u64::from(b1) + u64::from(b2);
        }
        let (d, b1) = x[j + ny].overflowing_sub(carry as u64);
        let (d, b2) = d.overflowing_sub(borrow);
        x[j + ny] = d;
        if b1 || b2 {
            // qh was one too large (Knuth D6): add y back once
            let mut c = 0u128;
            for i in 0..ny {
                let t = u128::from(x[j + i]) + u128::from(y[i]) + c;
                x[j + i] = t as u64;
                c = t >> 64;
            }
            x[j + ny] = x[j + ny].wrapping_add(c as u64);
        }
    }
    m.add(2 * ny + nx + 1)?;
    if s > 0 {
        for i in 0..ny - 1 {
            x[i] = (x[i] >> s) | (x[i + 1] << (64 - s));
        }
        x[ny - 1] >>= s;
        for i in 0..ny - 1 {
            y[i] = (y[i] >> s) | (y[i + 1] << (64 - s));
        }
        y[ny - 1] >>= s;
    }
    for v in &mut x[ny..=nx] {
        *v = 0;
    }
    let r = norm(x, ny);
    if !less(x, r, y, ny) {
        return Err(Fault::Invariant);
    }
    Ok(r)
}

/// x / y exactly (Knuth D, the quotient kept: the sibling of
/// `rem_in_place`), for `1 <= ny <= nx`, y normalized (`y[ny - 1] != 0`), x
/// with room for `nx + 1` limbs and q for `nx - ny + 1`.  The quotient goes
/// to q and its length is returned.  x is left all zero (its remainder,
/// checked: a nonzero remainder is an invariant failure, never a wrong
/// answer); y is the caller's copy and is left normalized (shifted), not
/// restored.  Units: `nx + ny + 2` for the shifts, `2 ny + 4` per quotient
/// limb (6 for a one-limb divisor), `nx + 2` for the remainder check: at
/// most [`quot_work`]`(nx, ny)`, since `2 nx + ny + 4 <= 3 nx + 8`.
pub(super) fn divexact_in_place(x: &mut [u64], nx: usize, y: &mut [u64], ny: usize, q: &mut [u64], m: &mut Meter) -> Result<usize, Fault> {
    if ny == 0 || nx < ny || x.len() <= nx || y.len() < ny || y[ny - 1] == 0 || q.len() < nx - ny + 1 {
        return Err(Fault::Invariant);
    }
    m.add(nx + ny + 2)?;
    if ny == 1 {
        let d = u128::from(y[0]);
        let mut r = 0u128;
        for j in (0..nx).rev() {
            m.add(6)?;
            let t = (r << 64) | u128::from(x[j]);
            q[j] = (t / d) as u64;
            r = t % d;
            x[j] = 0;
        }
        m.add(nx + 2)?;
        x[nx] = 0;
        if r != 0 {
            return Err(Fault::Invariant);
        }
        return Ok(norm(q, nx));
    }
    let s = y[ny - 1].leading_zeros();
    if s > 0 {
        for i in (1..ny).rev() {
            y[i] = (y[i] << s) | (y[i - 1] >> (64 - s));
        }
        y[0] <<= s;
        x[nx] = x[nx - 1] >> (64 - s);
        for i in (1..nx).rev() {
            x[i] = (x[i] << s) | (x[i - 1] >> (64 - s));
        }
        x[0] <<= s;
    } else {
        x[nx] = 0;
    }
    let (y1, y2) = (u128::from(y[ny - 1]), u128::from(y[ny - 2]));
    for j in (0..=nx - ny).rev() {
        m.add(2 * ny + 4)?;
        let top = (u128::from(x[j + ny]) << 64) | u128::from(x[j + ny - 1]);
        let mut qh = top / y1;
        let mut rh = top % y1;
        let (mut big, mut by_y2, mut brk) = (0, 0, false);
        while qh >> 64 != 0 || qh * y2 > ((rh << 64) | u128::from(x[j + ny - 2])) {
            if qh >> 64 != 0 {
                big += 1;
            } else {
                by_y2 += 1;
            }
            qh -= 1;
            rh += y1;
            if rh >> 64 != 0 {
                brk = true;
                break;
            }
        }
        if big > 0 {
            super::hits::hit(super::hits::D3_QBIG);
        }
        if by_y2 >= 1 {
            super::hits::hit(super::hits::D3_Y2_ONCE);
        }
        if by_y2 >= 2 {
            super::hits::hit(super::hits::D3_Y2_TWICE);
        }
        if brk {
            super::hits::hit(super::hits::D3_RH_BREAK);
        }
        let (mut borrow, mut carry) = (0u64, 0u128);
        for i in 0..ny {
            let p = qh * u128::from(y[i]) + carry;
            carry = p >> 64;
            let (d, b1) = x[j + i].overflowing_sub(p as u64);
            let (d, b2) = d.overflowing_sub(borrow);
            x[j + i] = d;
            borrow = u64::from(b1) + u64::from(b2);
        }
        let (d, b1) = x[j + ny].overflowing_sub(carry as u64);
        let (d, b2) = d.overflowing_sub(borrow);
        x[j + ny] = d;
        if b1 || b2 {
            qh -= 1;
            let mut c = 0u128;
            for i in 0..ny {
                let t = u128::from(x[j + i]) + u128::from(y[i]) + c;
                x[j + i] = t as u64;
                c = t >> 64;
            }
            x[j + ny] = x[j + ny].wrapping_add(c as u64);
        }
        q[j] = qh as u64;
    }
    // (the remainder, still shifted, is x[..ny]; above it everything is zero)
    m.add(nx + 2)?;
    if x[..=nx].iter().any(|&w| w != 0) {
        return Err(Fault::Invariant);
    }
    Ok(norm(q, nx - ny + 1))
}

/// x = q y + r with 0 <= r < y (Knuth D keeping both, magnitudes), for `1
/// <= ny <= nx`, y normalized, x with room for `nx + 1` limbs and q for `nx
/// - ny + 1`.  The quotient goes to q; the remainder is left in x's first
/// limbs (everything above it zero); y is restored.  Returns (the
/// quotient's length, the remainder's).  Every unit is charged before the
/// work it counts: at most [`divrem_work`]`(nx, ny)`.
pub(super) fn divrem_in_place(x: &mut [u64], nx: usize, y: &mut [u64], ny: usize, q: &mut [u64], m: &mut Meter) -> Result<(usize, usize), Fault> {
    if ny == 0 || nx < ny || x.len() <= nx || y.len() < ny || y[ny - 1] == 0 || q.len() < nx - ny + 1 {
        return Err(Fault::Invariant);
    }
    m.add(nx + ny + 2)?;
    if ny == 1 {
        let d = u128::from(y[0]);
        let mut r = 0u128;
        for j in (0..nx).rev() {
            m.add(6)?;
            let t = (r << 64) | u128::from(x[j]);
            q[j] = (t / d) as u64;
            r = t % d;
            x[j] = 0;
        }
        m.add(nx + 2)?;
        x[nx] = 0;
        x[0] = r as u64;
        return Ok((norm(q, nx), usize::from(r != 0)));
    }
    let s = y[ny - 1].leading_zeros();
    if s > 0 {
        for i in (1..ny).rev() {
            y[i] = (y[i] << s) | (y[i - 1] >> (64 - s));
        }
        y[0] <<= s;
        x[nx] = x[nx - 1] >> (64 - s);
        for i in (1..nx).rev() {
            x[i] = (x[i] << s) | (x[i - 1] >> (64 - s));
        }
        x[0] <<= s;
    } else {
        x[nx] = 0;
    }
    let (y1, y2) = (u128::from(y[ny - 1]), u128::from(y[ny - 2]));
    for j in (0..=nx - ny).rev() {
        m.add(2 * ny + 4)?;
        let top = (u128::from(x[j + ny]) << 64) | u128::from(x[j + ny - 1]);
        let mut qh = top / y1;
        let mut rh = top % y1;
        let (mut big, mut by_y2, mut brk) = (0, 0, false);
        while qh >> 64 != 0 || qh * y2 > ((rh << 64) | u128::from(x[j + ny - 2])) {
            if qh >> 64 != 0 {
                big += 1;
            } else {
                by_y2 += 1;
            }
            qh -= 1;
            rh += y1;
            if rh >> 64 != 0 {
                brk = true;
                break;
            }
        }
        if big > 0 {
            super::hits::hit(super::hits::D3_QBIG);
        }
        if by_y2 >= 1 {
            super::hits::hit(super::hits::D3_Y2_ONCE);
        }
        if by_y2 >= 2 {
            super::hits::hit(super::hits::D3_Y2_TWICE);
        }
        if brk {
            super::hits::hit(super::hits::D3_RH_BREAK);
        }
        let (mut borrow, mut carry) = (0u64, 0u128);
        for i in 0..ny {
            let p = qh * u128::from(y[i]) + carry;
            carry = p >> 64;
            let (d, b1) = x[j + i].overflowing_sub(p as u64);
            let (d, b2) = d.overflowing_sub(borrow);
            x[j + i] = d;
            borrow = u64::from(b1) + u64::from(b2);
        }
        let (d, b1) = x[j + ny].overflowing_sub(carry as u64);
        let (d, b2) = d.overflowing_sub(borrow);
        x[j + ny] = d;
        if b1 || b2 {
            qh -= 1;
            let mut c = 0u128;
            for i in 0..ny {
                let t = u128::from(x[j + i]) + u128::from(y[i]) + c;
                x[j + i] = t as u64;
                c = t >> 64;
            }
            x[j + ny] = x[j + ny].wrapping_add(c as u64);
        }
        q[j] = qh as u64;
    }
    // (the remainder, shifted, is x[..ny]; unshift it and y, zero the rest)
    m.add(2 * ny + nx + 1)?;
    if s > 0 {
        for i in 0..ny - 1 {
            x[i] = (x[i] >> s) | (x[i + 1] << (64 - s));
        }
        x[ny - 1] >>= s;
        for i in 0..ny - 1 {
            y[i] = (y[i] >> s) | (y[i + 1] << (64 - s));
        }
        y[ny - 1] >>= s;
    }
    for v in &mut x[ny..=nx] {
        *v = 0;
    }
    let r = norm(x, ny);
    if !less(x, r, y, ny) {
        return Err(Fault::Invariant);
    }
    Ok((norm(q, nx - ny + 1), r))
}

fn gcd_u64(mut a: u64, mut b: u64) -> u64 {
    while b != 0 {
        (a, b) = (b, a % b);
    }
    a
}

/// gcd(x, y) in place, x of nx limbs and y of ny (normalized), each slice
/// with room for max(nx, ny) + 1 limbs and zero beyond its length.  The
/// gcd's slot (false: x, true: y) and length; the other slot holds 0.
pub(super) fn gcd_in_place(x: &mut [u64], nx: usize, y: &mut [u64], ny: usize, m: &mut Meter) -> Result<(bool, usize), Fault> {
    let (mut a, mut b) = (x, y);
    let (mut na, mut nb) = (nx, ny);
    let mut swapped = false;
    loop {
        m.add(na + 2)?;
        if less(a, na, b, nb) {
            std::mem::swap(&mut a, &mut b);
            std::mem::swap(&mut na, &mut nb);
            swapped = !swapped;
        }
        if nb == 0 {
            return Ok((swapped, na));
        }
        if nb == 1 {
            m.add(2 * na + 93)?;
            let d = b[0];
            let mut r = 0u128;
            for i in (0..na).rev() {
                r = ((r << 64) | u128::from(a[i])) % u128::from(d);
            }
            let g = gcd_u64(d, r as u64);
            for v in &mut a[..na] {
                *v = 0;
            }
            a[0] = g;
            b[0] = 0;
            return Ok((swapped, 1));
        }
        // a >= b, nb >= 2: one Lehmer window, or a remainder
        let shift = (64 * na - a[na - 1].leading_zeros() as usize).saturating_sub(63);
        let (mut xh, mut yh) = (i128::from(window(a, na, shift)), i128::from(window(b, nb, shift)));
        let (mut ca, mut cb, mut cc, mut cd) = (1i128, 0i128, 0i128, 1i128);
        if na <= nb + 1 {
            m.add(LEHMER_STEPS as usize)?;
            for _ in 0..LEHMER_STEPS {
                // (Algorithm L's invariant keeps these positive; checked,
                // so a truncating division is a floor)
                if yh + cc <= 0 || yh + cd <= 0 || xh + ca < 0 || xh + cb < 0 {
                    break;
                }
                let q = (xh + ca) / (yh + cc);
                if q != (xh + cb) / (yh + cd) {
                    break;
                }
                (ca, cc) = (cc, ca - q * cc);
                (cb, cd) = (cd, cb - q * cd);
                (xh, yh) = (yh, xh - q * yh);
            }
        }
        if cb == 0 {
            na = rem_in_place(a, na, b, nb, m)?;
            continue;
        }
        m.add(3 * na)?;
        apply_window(a, b, na, [ca, cb, cc, cd])?;
        let n = na;
        na = norm(a, n);
        nb = norm(b, n);
    }
}

/// gcd(x, y) as [`gcd_in_place`] (the same slices, the same result: the
/// gcd's slot, false: x, true: y, and length; the other slot 0), its work
/// at most [`gcd_unbalanced_work`]`(nx, ny)`.  On operands of very
/// different sizes ([`rem_first`]), one remainder step first: x mod y in
/// place (y, the smaller, normalized there and restored; a zero remainder
/// makes y the gcd), then [`gcd_in_place`] on two operands of at most `ny`
/// limbs.  Otherwise [`gcd_in_place`] itself.
pub(super) fn gcd_unbalanced(x: &mut [u64], nx: usize, y: &mut [u64], ny: usize, m: &mut Meter) -> Result<(bool, usize), Fault> {
    if nx < ny {
        let (slot, len) = gcd_unbalanced(y, ny, x, nx, m)?;
        return Ok((!slot, len));
    }
    if rem_first(nx as u64, ny as u64) {
        if x[nx - 1] == 0 || y[ny - 1] == 0 || x.len() <= nx {
            return Err(Fault::Invariant);
        }
        let nr = rem_in_place(x, nx, y, ny, m)?;
        if nr == 0 {
            return Ok((true, ny));
        }
        let (slot, len) = gcd_in_place(y, ny, x, nr, m)?;
        return Ok((!slot, len));
    }
    gcd_in_place(x, nx, y, ny, m)
}
