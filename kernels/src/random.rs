//! numpy.random's bit generators and the distributions that fill arrays, as
//! src/runtime/numpy_random.ts (which follows numpy/random/src): MT19937
//! (RandomState) and PCG64 (default_rng), the same streams bit for bit.

use crate::libm::{exp1, log1, log1p, ExpTab, LogTab};

trait Gen {
    fn next32(&mut self) -> u32;
    fn next64(&mut self) -> u64;
    fn next_double(&mut self) -> f64;
}

struct Mt {
    key: *mut u32,
    pos: usize,
}
impl Mt {
    unsafe fn twist(&mut self) {
        let k = self.key;
        let mag = |y: u32| (y >> 1) ^ ((0u32.wrapping_sub(y & 1)) & 0x9908b0df);
        let mut i = 0;
        while i < 624 - 397 {
            let y = (*k.add(i) & 0x80000000) | (*k.add(i + 1) & 0x7fffffff);
            *k.add(i) = *k.add(i + 397) ^ mag(y);
            i += 1;
        }
        while i < 623 {
            let y = (*k.add(i) & 0x80000000) | (*k.add(i + 1) & 0x7fffffff);
            *k.add(i) = *k.add(i + 397 - 624) ^ mag(y);
            i += 1;
        }
        let y = (*k.add(623) & 0x80000000) | (*k & 0x7fffffff);
        *k.add(623) = *k.add(396) ^ mag(y);
        self.pos = 0;
    }
}
impl Gen for Mt {
    #[inline(always)]
    fn next32(&mut self) -> u32 {
        unsafe {
            if self.pos == 624 {
                self.twist();
            }
            let mut y = *self.key.add(self.pos);
            self.pos += 1;
            y ^= y >> 11;
            y ^= (y << 7) & 0x9d2c5680;
            y ^= (y << 15) & 0xefc60000;
            y ^ (y >> 18)
        }
    }
    fn next64(&mut self) -> u64 {
        ((self.next32() as u64) << 32) | self.next32() as u64
    }
    #[inline(always)]
    fn next_double(&mut self) -> f64 {
        let a = (self.next32() >> 5) as f64;
        let b = (self.next32() >> 6) as f64;
        (a * 67108864.0 + b) / 9007199254740992.0
    }
}

const ZIG_NOR_R: f64 = 3.6541528853610087963519472518;
const ZIG_NOR_INV_R: f64 = 0.27366123732975827203338247596;
const ZIG_EXP_R: f64 = 7.6971174701310497140446280481;

const PCG_MULT: u128 = 0x2360ed051fc65da44385df649fccf645;
struct Pcg {
    state: u128,
    inc: u128,
    has_u32: bool,
    u32v: u32,
}
impl Gen for Pcg {
    #[inline(always)]
    fn next64(&mut self) -> u64 {
        self.state = self.state.wrapping_mul(PCG_MULT).wrapping_add(self.inc);
        let s = self.state;
        let v = ((s >> 64) as u64) ^ (s as u64);
        v.rotate_right((s >> 122) as u32)
    }
    #[inline(always)]
    fn next32(&mut self) -> u32 {
        if self.has_u32 {
            self.has_u32 = false;
            return self.u32v;
        }
        let n = self.next64();
        self.has_u32 = true;
        self.u32v = (n >> 32) as u32;
        n as u32
    }
    #[inline(always)]
    fn next_double(&mut self) -> f64 {
        (self.next64() >> 11) as f64 * (1.0 / 9007199254740992.0)
    }
}

fn mask32(max: u32) -> u32 {
    let mut m = max;
    m |= m >> 1;
    m |= m >> 2;
    m |= m >> 4;
    m |= m >> 8;
    m |= m >> 16;
    m
}

/// Fill out[0..n] with distribution `dist`:
/// 0 uniform doubles; 1 RandomState's normals (polar, with the cached
///   second value in gauss[0..2] = [has, value]); 2 RandomState's
///   exponentials (-log(1 - u)); 3 integers lo + [0, rng] by masked rejection
///   (RandomState); 4 the same by Lemire's method (Generator); 5 normals by
///   the polar method (the spare dropped at the end); 6 and 7 Generator's
///   standard normals and exponentials: NumPy's ziggurats.
/// tabs: log's tables (274), exp's (388), then the ziggurats' ki, wi, fi,
/// ke, we, fe (256 each).
unsafe fn fill<G: Gen>(g: &mut G, dist: i32, out: *mut f64, n: usize, lo: f64, rng: f64, gauss: *mut f64, tabs: *const f64) {
    let t = LogTab(tabs);
    let et = ExpTab(tabs.add(274));
    let zig = tabs.add(274 + 388);
    let z = |tab: usize, i: usize| *zig.add(256 * tab + i);
    let polar = |g: &mut G| loop {
        let x1 = 2.0 * g.next_double() - 1.0;
        let x2 = 2.0 * g.next_double() - 1.0;
        let r2 = x1 * x1 + x2 * x2;
        if !(r2 >= 1.0 || r2 == 0.0) {
            let f = crate::sqrt((-2.0 * log1(r2, &t)) / r2);
            return (f * x1, f * x2);
        }
    };
    match dist {
        0 => {
            for i in 0..n {
                *out.add(i) = g.next_double();
            }
        }
        1 => {
            for i in 0..n {
                if *gauss != 0.0 {
                    *gauss = 0.0;
                    *out.add(i) = *gauss.add(1);
                    *gauss.add(1) = 0.0;
                    continue;
                }
                let (a, b) = polar(g);
                *gauss = 1.0;
                *gauss.add(1) = a;
                *out.add(i) = b;
            }
        }
        2 => {
            for i in 0..n {
                *out.add(i) = -log1(1.0 - g.next_double(), &t);
            }
        }
        3 => {
            let r = rng as u32;
            let m = mask32(r);
            for i in 0..n {
                let v = if r == 0 {
                    0
                } else if r == 0xffffffff {
                    g.next32()
                } else {
                    loop {
                        let v = g.next32() & m;
                        if v <= r {
                            break v;
                        }
                    }
                };
                *out.add(i) = lo + v as f64;
            }
        }
        4 => {
            let r = rng as u32;
            let excl = r as u64 + 1;
            for i in 0..n {
                let v = if r == 0 {
                    0
                } else if r == 0xffffffff {
                    g.next32()
                } else {
                    let mut m = g.next32() as u64 * excl;
                    let mut left = m & 0xffffffff;
                    if left < excl {
                        let threshold = (0xffffffff - r as u64) % excl;
                        while left < threshold {
                            m = g.next32() as u64 * excl;
                            left = m & 0xffffffff;
                        }
                    }
                    (m >> 32) as u32
                };
                *out.add(i) = lo + v as f64;
            }
        }
        6 => {
            for i in 0..n {
                *out.add(i) = loop {
                    let r64 = g.next64();
                    let idx = (r64 & 0xff) as usize;
                    let r = r64 >> 8;
                    let rabs = ((r >> 1) & 0x000fffffffffffff) as f64;
                    let mut x = rabs * z(1, idx);
                    if r & 1 != 0 {
                        x = -x;
                    }
                    if rabs < z(0, idx) {
                        break x;
                    }
                    if idx == 0 {
                        let rb = (r >> 1) & 0x000fffffffffffff;
                        break loop {
                            let xx = -ZIG_NOR_INV_R * log1p(-g.next_double());
                            let yy = -log1p(-g.next_double());
                            if yy + yy > xx * xx {
                                break if (rb >> 8) & 1 != 0 { -(ZIG_NOR_R + xx) } else { ZIG_NOR_R + xx };
                            }
                        };
                    }
                    if (z(2, idx - 1) - z(2, idx)) * g.next_double() + z(2, idx) < exp1(-0.5 * x * x, &et) {
                        break x;
                    }
                };
            }
        }
        7 => {
            for i in 0..n {
                *out.add(i) = loop {
                    let r64 = g.next64() >> 3;
                    let idx = (r64 & 0xff) as usize;
                    let ri = (r64 >> 8) as f64;
                    let x = ri * z(4, idx);
                    if ri < z(3, idx) {
                        break x;
                    }
                    if idx == 0 {
                        break ZIG_EXP_R - log1p(-g.next_double());
                    }
                    if (z(5, idx - 1) - z(5, idx)) * g.next_double() + z(5, idx) < exp1(-x, &et) {
                        break x;
                    }
                };
            }
        }
        _ => {
            let mut i = 0;
            while i < n {
                let (a, b) = polar(g);
                *out.add(i) = b;
                if i + 1 < n {
                    *out.add(i + 1) = a;
                }
                i += 2;
            }
        }
    }
}

/// MT19937: key (624 u32) and meta = [pos, has_gauss, gauss] are updated.
#[no_mangle]
pub unsafe extern "C" fn mt_fill(key: *mut u32, meta: *mut f64, dist: i32, out: *mut f64, n: usize, lo: f64, rng: f64, logtab: *const f64) {
    let mut g = Mt { key, pos: *meta as usize };
    fill(&mut g, dist, out, n, lo, rng, meta.add(1), logtab);
    *meta = g.pos as f64;
}

/// PCG64: words = [state_lo, state_hi, inc_lo, inc_hi] (u64) and meta =
/// [has_u32, u32] are updated.
#[no_mangle]
pub unsafe extern "C" fn pcg_fill(words: *mut u64, meta: *mut f64, dist: i32, out: *mut f64, n: usize, lo: f64, rng: f64, logtab: *const f64) {
    let w = |i| *words.add(i) as u128;
    let mut g = Pcg { state: w(0) | (w(1) << 64), inc: w(2) | (w(3) << 64), has_u32: *meta != 0.0, u32v: *meta.add(1) as u32 };
    let mut unused = [0.0f64; 2];
    fill(&mut g, dist, out, n, lo, rng, unused.as_mut_ptr(), logtab);
    *words = g.state as u64;
    *words.add(1) = (g.state >> 64) as u64;
    *meta = g.has_u32 as u32 as f64;
    *meta.add(1) = g.u32v as f64;
}
