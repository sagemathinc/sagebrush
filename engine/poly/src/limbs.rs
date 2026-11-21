//! Rows of integers in fixed-width two's complement limbs, for the L^2 row
//! operations: b_k -= x b_j in place, without allocation. Arithmetic is
//! modulo 2^(64 w) (w limbs per entry), which is exact as long as every
//! result fits in 64 w - 1 bits: callers widen the row first (`need_bits`).

use sagebrush_bigint::{for_each_u64_limb, from_limbs, BigInt};
use num_traits::Signed;

/// Row entries, w little-endian limbs each, two's complement.
#[derive(Clone, Debug)]
pub struct WRow {
    pub w: usize,
    pub v: Vec<u64>,
}

/// Negate a two's complement number in place.
fn negate(c: &mut [u64]) {
    let mut carry = true;
    for x in c.iter_mut() {
        let (r, o) = (!*x).overflowing_add(carry as u64);
        *x = r;
        carry = o;
    }
}

/// An upper bound of the bits of |c| (exact for c >= 0, one more for c < 0).
fn entry_bits(c: &[u64]) -> u64 {
    let m = if (c[c.len() - 1] as i64) < 0 { u64::MAX } else { 0 };
    for i in (0..c.len()).rev() {
        let x = c[i] ^ m;
        if x != 0 {
            return 64 * i as u64 + (64 - x.leading_zeros()) as u64 + (m & 1);
        }
    }
    m & 1
}

impl WRow {
    /// Entries of at most `bits` bits, with a limb of headroom.
    pub fn width_for(bits: u64) -> usize {
        bits as usize / 64 + 2
    }

    pub fn len(&self) -> usize {
        self.v.len() / self.w
    }

    pub fn is_empty(&self) -> bool {
        self.v.is_empty()
    }

    pub fn from_big(b: &[BigInt]) -> WRow {
        let mb = b.iter().map(|x| x.bits()).max().unwrap_or(0);
        let w = WRow::width_for(mb);
        let mut v = vec![0u64; w * b.len()];
        for (e, x) in b.iter().enumerate() {
            let c = &mut v[e * w..(e + 1) * w];
            let mut i = 0;
            for_each_u64_limb(x, |l| {
                c[i] = l;
                i += 1;
            });
            if x.is_negative() {
                negate(c);
            }
        }
        WRow { w, v }
    }

    pub fn from_i64(a: &[i64], w: usize) -> WRow {
        let mut v = vec![0u64; w * a.len()];
        for (e, &x) in a.iter().enumerate() {
            let ext = if x < 0 { u64::MAX } else { 0 };
            v[e * w] = x as u64;
            for l in &mut v[e * w + 1..(e + 1) * w] {
                *l = ext;
            }
        }
        WRow { w, v }
    }

    /// The same entries in w2 >= w limbs (sign-extended).
    pub fn widen(&mut self, w2: usize) {
        if w2 <= self.w {
            return;
        }
        let n = self.len();
        let mut v = vec![0u64; w2 * n];
        for e in 0..n {
            let c = &self.v[e * self.w..(e + 1) * self.w];
            let ext = if (c[self.w - 1] as i64) < 0 { u64::MAX } else { 0 };
            v[e * w2..e * w2 + self.w].copy_from_slice(c);
            for l in &mut v[e * w2 + self.w..(e + 1) * w2] {
                *l = ext;
            }
        }
        self.w = w2;
        self.v = v;
    }

    /// The number of nonzero entries.
    pub fn nnz(&self) -> usize {
        self.v.chunks_exact(self.w).filter(|c| c.iter().any(|&l| l != 0)).count()
    }

    /// The same entries in w2 < w limbs (they must fit in 64 w2 - 1 bits).
    pub fn narrow(&mut self, w2: usize) {
        if w2 >= self.w {
            return;
        }
        let n = self.len();
        let mut v = vec![0u64; w2 * n];
        for e in 0..n {
            v[e * w2..(e + 1) * w2].copy_from_slice(&self.v[e * self.w..e * self.w + w2]);
        }
        self.w = w2;
        self.v = v;
    }

    /// An upper bound of the bits of the largest |entry|.
    pub fn max_bits(&self) -> u64 {
        self.v.chunks_exact(self.w).map(entry_bits).max().unwrap_or(0)
    }

    pub fn to_big(&self) -> Vec<BigInt> {
        let mut t = vec![0u64; self.w];
        self.v
            .chunks_exact(self.w)
            .map(|c| {
                let neg = (c[self.w - 1] as i64) < 0;
                t.copy_from_slice(c);
                if neg {
                    negate(&mut t);
                }
                from_limbs(neg, &t)
            })
            .collect()
    }

    /// The entries arithmetically shifted right by sh, truncated to i64:
    /// exact when every |entry| < 2^(sh + 63).
    pub fn shifted(&self, sh: u64, out: &mut Vec<f64>) {
        let (q, r) = ((sh / 64) as usize, (sh % 64) as u32);
        let w = self.w;
        out.extend(self.v.chunks_exact(w).map(|c| {
            let ext = if (c[w - 1] as i64) < 0 { u64::MAX } else { 0 };
            let at = |i: usize| if i < w { c[i] } else { ext };
            let lo = if r == 0 { at(q) } else { (at(q) >> r) | (at(q + 1) << (64 - r)) };
            lo as i64 as f64
        }));
    }

    /// The entries arithmetically shifted right by sh, truncated to i128:
    /// exact when every |entry| < 2^(sh + 127).
    pub fn shifted128(&self, sh: u64, out: &mut Vec<i128>) {
        let (q, r) = ((sh / 64) as usize, (sh % 64) as u32);
        let w = self.w;
        out.extend(self.v.chunks_exact(w).map(|c| {
            let ext = if (c[w - 1] as i64) < 0 { u64::MAX } else { 0 };
            let at = |i: usize| if i < w { c[i] } else { ext };
            let word = |k: usize| if r == 0 { at(k) } else { (at(k) >> r) | (at(k + 1) << (64 - r)) };
            ((word(q) as u128) | ((word(q + 1) as u128) << 64)) as i128
        }));
    }

    /// Entry e as an i64 (valid when it fits).
    pub fn low(&self, e: usize) -> i64 {
        self.v[e * self.w] as i64
    }

    /// self -= x o (o given by its limbs, sign-extended to self's width),
    /// modulo 2^(64 w): exact when the results fit in 64 w - 1 bits.
    pub fn sub_mul(&mut self, o: Src<'_>, x: i64) {
        let w = self.w;
        let (xa, sub) = (x.unsigned_abs(), x >= 0);
        for (e, u) in self.v.chunks_exact_mut(w).enumerate() {
            let (mut mc, mut bc) = (0u64, false);
            for (i, ui) in u.iter_mut().enumerate() {
                let vi = o.limb(e, i);
                let p = vi as u128 * xa as u128 + mc as u128;
                let lo = p as u64;
                mc = (p >> 64) as u64;
                if sub {
                    let (r1, b1) = ui.overflowing_sub(lo);
                    let (r2, b2) = r1.overflowing_sub(bc as u64);
                    *ui = r2;
                    bc = b1 || b2;
                } else {
                    let (r1, b1) = ui.overflowing_add(lo);
                    let (r2, b2) = r1.overflowing_add(bc as u64);
                    *ui = r2;
                    bc = b1 || b2;
                }
            }
        }
    }
}

/// Rows as sign-magnitude limbs of one width, for exact dot products: the
/// Gram matrix of rows with large entries in machine-word arithmetic.
pub struct MagRows {
    w: usize,
    mag: Vec<Vec<u64>>,
    neg: Vec<Vec<bool>>,
}

impl MagRows {
    pub fn new(rows: &[Vec<BigInt>]) -> MagRows {
        let w = rows.iter().flatten().map(|x| x.bits().div_ceil(64) as usize).max().unwrap_or(0).max(1);
        let mut mag = vec![];
        let mut neg = vec![];
        for r in rows {
            let mut m = vec![0u64; w * r.len()];
            for (e, x) in r.iter().enumerate() {
                let mut i = 0;
                for_each_u64_limb(x, |l| {
                    m[e * w + i] = l;
                    i += 1;
                });
            }
            mag.push(m);
            neg.push(r.iter().map(|x| x.is_negative()).collect());
        }
        MagRows { w, mag, neg }
    }

    /// Limbs an entry.
    pub fn width(&self) -> usize {
        self.w
    }

    /// The exact dot product of rows i and j.
    pub fn dot(&self, i: usize, j: usize) -> BigInt {
        let w = self.w;
        let n = self.neg[i].len();
        // positive and negative products summed apart, 2 w + 2 limbs each
        let mut acc = [vec![0u64; 2 * w + 2], vec![0u64; 2 * w + 2]];
        let mut p = vec![0u64; 2 * w];
        let (a, b) = (&self.mag[i], &self.mag[j]);
        for e in 0..n {
            let (x, y) = (&a[e * w..(e + 1) * w], &b[e * w..(e + 1) * w]);
            if x.iter().all(|&l| l == 0) || y.iter().all(|&l| l == 0) {
                continue;
            }
            p.iter_mut().for_each(|l| *l = 0);
            for (s, &xs) in x.iter().enumerate() {
                if xs == 0 {
                    continue;
                }
                let mut c = 0u128;
                for (t, &yt) in y.iter().enumerate() {
                    let v = xs as u128 * yt as u128 + p[s + t] as u128 + c;
                    p[s + t] = v as u64;
                    c = v >> 64;
                }
                p[s + w] = c as u64;
            }
            let acc = &mut acc[(self.neg[i][e] != self.neg[j][e]) as usize];
            let mut c = false;
            for (t, l) in acc.iter_mut().enumerate() {
                let v = if t < 2 * w { p[t] } else { 0 };
                let (r1, c1) = l.overflowing_add(v);
                let (r2, c2) = r1.overflowing_add(c as u64);
                *l = r2;
                c = c1 || c2;
                if t >= 2 * w && !c {
                    break;
                }
            }
        }
        from_limbs(false, &acc[0]) - from_limbs(false, &acc[1])
    }
}

/// The other row of a row operation: machine integers or limbs.
#[derive(Clone, Copy)]
pub enum Src<'a> {
    S(&'a [i64]),
    W(&'a WRow),
}

impl Src<'_> {
    #[inline]
    fn limb(&self, e: usize, i: usize) -> u64 {
        match self {
            Src::S(a) => {
                if i == 0 {
                    a[e] as u64
                } else if a[e] < 0 {
                    u64::MAX
                } else {
                    0
                }
            }
            Src::W(r) => {
                let c = &r.v[e * r.w..(e + 1) * r.w];
                if i < r.w {
                    c[i]
                } else if (c[r.w - 1] as i64) < 0 {
                    u64::MAX
                } else {
                    0
                }
            }
        }
    }

    pub fn max_bits(&self) -> u64 {
        match self {
            Src::S(a) => a.iter().map(|&x| 64 - x.unsigned_abs().leading_zeros() as u64).max().unwrap_or(0),
            Src::W(r) => r.max_bits(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use num_traits::ToPrimitive;

    /// sub_mul, widen, shifted and the conversions agree with big integers
    /// on random rows of mixed signs, widths and multipliers.
    #[test]
    fn limb_rows_agree_with_big_integers() {
        let mut seed = 0x2545_f491_4f6c_dd1du64;
        let mut rnd = || {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            seed
        };
        for case in 0..400 {
            let n = 1 + (rnd() % 7) as usize;
            let mut big = |bits: u64| {
                let mut x = BigInt::from(0);
                for _ in 0..bits.div_ceil(64) {
                    x = (x << 64usize) + BigInt::from(rnd());
                }
                x = x >> (bits.div_ceil(64) * 64 - bits) as usize;
                if rnd() % 2 == 0 { -x } else { x }
            };
            let a: Vec<BigInt> = (0..n).map(|_| big(1 + (case % 300) as u64)).collect();
            let b: Vec<BigInt> = (0..n).map(|_| big(1 + (case * 7 % 250) as u64)).collect();
            let x = (rnd() as i64) >> (rnd() % 64);
            let mut wa = WRow::from_big(&a);
            assert_eq!(wa.to_big(), a);
            let mr = MagRows::new(&[a.clone(), b.clone()]);
            let dot = |u: &[BigInt], v: &[BigInt]| u.iter().zip(v).fold(BigInt::from(0), |s, (x, y)| s + x * y);
            assert_eq!(mr.dot(0, 1), dot(&a, &b), "case {case} MagRows");
            assert_eq!(mr.dot(1, 1), dot(&b, &b), "case {case} MagRows");
            let wb = WRow::from_big(&b);
            let need = wa.max_bits().max(wb.max_bits() + 64) + 2;
            wa.widen(WRow::width_for(need));
            wa.sub_mul(Src::W(&wb), x);
            let want: Vec<BigInt> = a.iter().zip(&b).map(|(u, v)| u - v * BigInt::from(x)).collect();
            assert_eq!(wa.to_big(), want, "case {case}");
            assert!(want.iter().all(|y| y.bits() <= wa.max_bits()));
            // machine-integer source
            let s: Vec<i64> = (0..n).map(|_| rnd() as i64 >> (rnd() % 64)).collect();
            wa.sub_mul(Src::S(&s), x);
            let want: Vec<BigInt> = want.iter().zip(&s).map(|(u, &v)| u - BigInt::from(v) * BigInt::from(x)).collect();
            assert_eq!(wa.to_big(), want, "case {case} S");
            let mb = wa.max_bits();
            wa.narrow(WRow::width_for(mb));
            assert_eq!(wa.to_big(), want, "case {case} narrowed");
            // shifted: floor(y / 2^sh) for sh leaving 63 bits
            let sh = wa.max_bits().saturating_sub(63);
            let sh2 = wa.max_bits().saturating_sub(120);
            let mut o2 = vec![];
            wa.shifted128(sh2, &mut o2);
            for (y, &f) in want.iter().zip(&o2) {
                let q = if y.is_negative() { -((-y - 1i32) >> sh2 as usize) - 1i32 } else { y >> sh2 as usize };
                assert_eq!(q, BigInt::from(f), "case {case} shifted128");
            }
            let mut out = vec![];
            wa.shifted(sh, &mut out);
            for (y, f) in want.iter().zip(&out) {
                let q = if y.is_negative() { -((-y - 1i32) >> sh as usize) - 1i32 } else { y >> sh as usize };
                assert_eq!(q.to_f64().unwrap(), *f, "case {case} shifted");
            }
        }
    }
}

#[cfg(test)]
mod calib {
    use super::*;

    #[test]
    #[ignore]
    fn row_op_costs() {
        let mut seed = 77u64;
        let mut rnd = || {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            seed
        };
        let n = 120;
        for bits in [70u64, 100, 128, 160, 250, 400, 700, 1000] {
            let mut big = |bits: u64| {
                let mut x = BigInt::from(0);
                for _ in 0..bits.div_ceil(64) {
                    x = (x << 64usize) + BigInt::from(rnd());
                }
                x >> (bits.div_ceil(64) * 64 - bits) as usize
            };
            let a: Vec<BigInt> = (0..n).map(|_| big(bits)).collect();
            let b: Vec<BigInt> = (0..n).map(|_| big(bits)).collect();
            let reps = 20000;
            let mut ab = a.clone();
            let t = std::time::Instant::now();
            for r in 0..reps {
                let x = BigInt::from(if r % 2 == 0 { 3 } else { -3 });
                for (u, v) in ab.iter_mut().zip(&b) {
                    sagebrush_bigint::sub_mul_assign(u, &x, v);
                }
            }
            let tb = t.elapsed().as_secs_f64() / reps as f64 / n as f64 * 1e9;
            let mut wa = WRow::from_big(&a);
            let wb = WRow::from_big(&b);
            wa.widen(WRow::width_for(bits + 4));
            let t = std::time::Instant::now();
            for r in 0..reps {
                wa.sub_mul(Src::W(&wb), if r % 2 == 0 { 3 } else { -3 });
                let _ = wa.max_bits() + wb.max_bits();
            }
            let tw = t.elapsed().as_secs_f64() / reps as f64 / n as f64 * 1e9;
            eprintln!("bits {bits} w {} big {tb:.1} ns/entry limbs {tw:.1} ns/entry ({:.2} ns/limb)", wa.w, tw / wa.w as f64);
        }
        for mb in [1000u64, 10000, 100000, 1000000, 10000000] {
            let mut big = |bits: u64| {
                let mut x = BigInt::from(0);
                for _ in 0..bits.div_ceil(64) {
                    x = (x << 64usize) + BigInt::from(rnd());
                }
                x
            };
            let (p, q) = (big(mb), big(mb));
            let reps = if mb <= 10000 { 20000 } else if mb <= 100000 { 500 } else if mb <= 1000000 { 20 } else { 3 };
            let t = std::time::Instant::now();
            for _ in 0..reps {
                std::hint::black_box(&p * &q);
            }
            eprintln!("mul {mb} bits dashu {:.3} us", t.elapsed().as_secs_f64() / reps as f64 * 1e6);
        }
    }
}
