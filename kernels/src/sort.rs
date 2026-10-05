//! Sorting doubles: a stable LSD radix sort on 64-bit keys that order like
//! the numbers (-0 before +0, NaN last, as a typed array's sort and NumPy).
//! Six passes of 11 bits, each skipped when every key has the same digit
//! there (small integers need one or two).

const BITS: u32 = 11;
const RADIX: usize = 1 << BITS;
const PASSES: usize = 6;

#[inline(always)]
fn key(v: f64) -> u64 {
    if v.is_nan() {
        return u64::MAX;
    }
    let b = v.to_bits();
    if b >> 63 != 0 {
        !b
    } else {
        b | (1 << 63)
    }
}
#[inline(always)]
fn digit(k: u64, d: usize) -> usize {
    ((k >> (BITS as usize * d)) as usize) & (RADIX - 1)
}

/// Counts of every digit of every key: hist[d * RADIX + digit].
unsafe fn histogram(keys: impl Fn(usize) -> u64, n: usize, hist: *mut u32) {
    for i in 0..PASSES * RADIX {
        *hist.add(i) = 0;
    }
    for i in 0..n {
        let k = keys(i);
        for d in 0..PASSES {
            *hist.add(d * RADIX + digit(k, d)) += 1;
        }
    }
}
/// Turn pass d's counts into starting offsets; false if one digit holds
/// every key (the pass would not move anything).
unsafe fn offsets(hist: *mut u32, d: usize, n: usize) -> bool {
    let h = hist.add(d * RADIX);
    let mut sum = 0u32;
    for b in 0..RADIX {
        let c = *h.add(b);
        if c as usize == n {
            return false;
        }
        *h.add(b) = sum;
        sum += c;
    }
    true
}

/// Sort x[0..n] ascending, in place; tmp: n doubles; hist: 6 * 2048 u32.
#[no_mangle]
pub unsafe extern "C" fn sort_f64(x: *mut f64, n: usize, tmp: *mut f64, hist: *mut u32) {
    if n < 64 {
        for i in 1..n {
            let v = *x.add(i);
            let k = key(v);
            let mut j = i;
            while j > 0 && key(*x.add(j - 1)) > k {
                *x.add(j) = *x.add(j - 1);
                j -= 1;
            }
            *x.add(j) = v;
        }
        return;
    }
    histogram(|i| key(*x.add(i)), n, hist);
    let (mut src, mut dst) = (x, tmp);
    for d in 0..PASSES {
        if !offsets(hist, d, n) {
            continue;
        }
        let h = hist.add(d * RADIX);
        for i in 0..n {
            let v = *src.add(i);
            let b = digit(key(v), d);
            *dst.add(*h.add(b) as usize) = v;
            *h.add(b) += 1;
        }
        core::mem::swap(&mut src, &mut dst);
    }
    if src != x {
        for i in 0..n {
            *x.add(i) = *src.add(i);
        }
    }
}

/// The stable argsort of x[0..n] into idx (n u32), with -0 equal to +0;
/// keys, keys2: n u64;
/// idx2: n u32; hist: 6 * 2048 u32.
#[no_mangle]
pub unsafe extern "C" fn argsort_f64(x: *const f64, n: usize, idx: *mut u32, keys: *mut u64, keys2: *mut u64, idx2: *mut u32, hist: *mut u32) {
    for i in 0..n {
        // -0 and +0 compare equal here (as NumPy's and the TS's comparisons)
        let v = *x.add(i);
        *keys.add(i) = key(if v == 0.0 { 0.0 } else { v });
        *idx.add(i) = i as u32;
    }
    histogram(|i| *keys.add(i), n, hist);
    let (mut ks, mut kd, mut is, mut id) = (keys, keys2, idx, idx2);
    for d in 0..PASSES {
        if !offsets(hist, d, n) {
            continue;
        }
        let h = hist.add(d * RADIX);
        for i in 0..n {
            let k = *ks.add(i);
            let b = digit(k, d);
            let o = *h.add(b) as usize;
            *kd.add(o) = k;
            *id.add(o) = *is.add(i);
            *h.add(b) += 1;
        }
        core::mem::swap(&mut ks, &mut kd);
        core::mem::swap(&mut is, &mut id);
    }
    if is != idx {
        for i in 0..n {
            *idx.add(i) = *is.add(i);
        }
    }
}
