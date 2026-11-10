//! Large products of 32-bit limbs.
//!
//! This is the 32-bit-limb form of [`crate::ntt`]: Gentleman-Sande
//! forward transforms and Cooley-Tukey inverse transforms meet in
//! bit-reversed order, so there is no permutation pass.  Tables are
//! cached by transform length and the large layers recurse into
//! cache-sized halves.

use std::sync::{Arc, Mutex};

// All three primes are below 2^30.  Thus lazy values below 4p fit in u32.
// Their product is > 2^88, enough for a 2^23-long convolution of base-2^32
// digits.  The roots have orders 2^26, 2^23 and 2^24 respectively.
const PRIMES: [(u32, u32, u32); 3] = [
    (469_762_049, 3, 26),
    (998_244_353, 3, 23),
    (754_974_721, 11, 24),
];
const MAX_LOG: u32 = 23;
const BLOCK: usize = 1 << 12;

#[inline(always)]
fn mul_mod(a: u32, b: u32, p: u32) -> u32 {
    (a as u64 * b as u64 % p as u64) as u32
}

fn pow_mod(mut a: u32, mut n: u64, p: u32) -> u32 {
    let mut r = 1;
    while n != 0 {
        if n & 1 != 0 {
            r = mul_mod(r, a, p);
        }
        a = mul_mod(a, a, p);
        n >>= 1;
    }
    r
}

#[inline(always)]
fn shoup(w: u32, p: u32) -> u32 {
    (((w as u64) << 32) / p as u64) as u32
}

/// `a*w mod p`, in `[0, 2p)`, for `a < 4p` and `w < p`.
#[inline(always)]
fn mul_shoup_lazy(a: u32, w: u32, wp: u32, p: u32) -> u32 {
    let q = ((a as u64 * wp as u64) >> 32) as u32;
    a.wrapping_mul(w).wrapping_sub(q.wrapping_mul(p))
}

struct Table {
    p: u32,
    log: u32,
    tw: Vec<u32>,
    twp: Vec<u32>,
    itw: Vec<u32>,
    itwp: Vec<u32>,
}

impl Table {
    fn new(p: u32, primitive_root: u32, max_root_log: u32, log: u32) -> Table {
        assert!(log <= max_root_log);
        let n = 1usize << log;
        let root = pow_mod(primitive_root, (p as u64 - 1) >> log, p);
        let iroot = pow_mod(root, p as u64 - 2, p);
        let mut tw = vec![0; n.max(2)];
        let mut itw = vec![0; n.max(2)];
        let half = n / 2;
        let (mut w, mut iw) = (1, 1);
        for j in 0..half {
            if j & (BLOCK - 1) == 0 {
                sagebrush_interrupt::check_coarse();
            }
            tw[half + j] = w;
            itw[half + j] = iw;
            w = mul_mod(w, root, p);
            iw = mul_mod(iw, iroot, p);
        }
        let mut k = half / 2;
        while k >= 1 {
            for j in 0..k {
                tw[k + j] = tw[2 * k + 2 * j];
                itw[k + j] = itw[2 * k + 2 * j];
            }
            k /= 2;
        }
        let twp = tw.iter().map(|&x| shoup(x, p)).collect();
        let itwp = itw.iter().map(|&x| shoup(x, p)).collect();
        Table {
            p,
            log,
            tw,
            twp,
            itw,
            itwp,
        }
    }
}

static CACHE: Mutex<Vec<Arc<Table>>> = Mutex::new(Vec::new());

#[cfg(test)]
fn cache_stats() -> (usize, usize) {
    let cache = CACHE.lock().unwrap_or_else(|e| e.into_inner());
    (cache.len(), cache.iter().map(|t| t.tw.len() * 16).sum())
}

fn table(prime: usize, log: u32) -> Arc<Table> {
    let (p, g, max_log) = PRIMES[prime];
    let mut cache = CACHE.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(i) = cache.iter().position(|t| t.p == p && t.log >= log) {
        let t = cache.remove(i);
        cache.push(t.clone());
        return t;
    }
    let t = Arc::new(Table::new(p, g, max_log, log.max(8)));
    cache.retain(|t| t.p != p);
    // Match the shared 64-bit NTT's policy: keep the most recently used
    // tables, but never let reusable twiddles grow without a byte bound.
    let mut total = cache.iter().map(|t| t.tw.len() * 16).sum::<usize>() + t.tw.len() * 16;
    while !cache.is_empty() && total > 1 << 28 {
        total -= cache[0].tw.len() * 16;
        cache.remove(0);
    }
    cache.push(t.clone());
    t
}

#[inline(always)]
fn dif_layer(lo: &mut [u32], hi: &mut [u32], w: &[u32], wp: &[u32], p: u32) {
    let p2 = 2 * p;
    for j in 0..lo.len() {
        let (x, y) = (lo[j], hi[j]);
        let s = x + y;
        lo[j] = if s >= p2 { s - p2 } else { s };
        hi[j] = mul_shoup_lazy(x + p2 - y, w[j], wp[j], p);
    }
}

#[inline(always)]
fn dit_layer(lo: &mut [u32], hi: &mut [u32], w: &[u32], wp: &[u32], p: u32) {
    let p2 = 2 * p;
    for j in 0..lo.len() {
        let mut x = lo[j];
        if x >= p2 {
            x -= p2;
        }
        let t = mul_shoup_lazy(hi[j], w[j], wp[j], p);
        lo[j] = x + t;
        hi[j] = x + p2 - t;
    }
}

fn dif(a: &mut [u32], t: &Table) {
    let n = a.len();
    if n <= 1 {
        return;
    }
    if n > BLOCK {
        sagebrush_interrupt::check_coarse();
        let (lo, hi) = a.split_at_mut(n / 2);
        dif_layer(lo, hi, &t.tw[n / 2..n], &t.twp[n / 2..n], t.p);
        dif(lo, t);
        dif(hi, t);
        return;
    }
    let mut m = n / 2;
    while m >= 1 {
        for chunk in a.chunks_exact_mut(2 * m) {
            let (lo, hi) = chunk.split_at_mut(m);
            dif_layer(lo, hi, &t.tw[m..2 * m], &t.twp[m..2 * m], t.p);
        }
        m /= 2;
    }
}

fn dit(a: &mut [u32], t: &Table) {
    let n = a.len();
    if n <= 1 {
        return;
    }
    if n > BLOCK {
        let (lo, hi) = a.split_at_mut(n / 2);
        dit(lo, t);
        dit(hi, t);
        sagebrush_interrupt::check_coarse();
        dit_layer(lo, hi, &t.itw[n / 2..n], &t.itwp[n / 2..n], t.p);
        return;
    }
    let mut m = 1;
    while m < n {
        for chunk in a.chunks_exact_mut(2 * m) {
            let (lo, hi) = chunk.split_at_mut(m);
            dit_layer(lo, hi, &t.itw[m..2 * m], &t.itwp[m..2 * m], t.p);
        }
        m *= 2;
    }
}

fn convolution(a: &[u32], b: &[u32], prime: usize) -> Vec<u32> {
    let len = a.len() + b.len() - 1;
    let log = len.next_power_of_two().trailing_zeros();
    assert!(log <= MAX_LOG, "32-bit NTT is too long");
    let n = 1usize << log;
    let t = table(prime, log);
    let p = t.p;
    let mut fa = vec![0; n];
    for (d, &s) in fa.iter_mut().zip(a) {
        *d = (s as u64 % p as u64) as u32;
    }
    dif(&mut fa, &t);
    let square = std::ptr::eq(a, b);
    let fb = if square {
        None
    } else {
        let mut v = vec![0; n];
        for (d, &s) in v.iter_mut().zip(b) {
            *d = (s as u64 % p as u64) as u32;
        }
        dif(&mut v, &t);
        Some(v)
    };
    let ninv = pow_mod(n as u32, p as u64 - 2, p);
    for i in 0..n {
        let x = if fa[i] >= p { fa[i] - p } else { fa[i] };
        let y0 = fb
            .as_ref()
            .map_or(x, |v| if v[i] >= p { v[i] - p } else { v[i] });
        fa[i] = mul_mod(mul_mod(x, y0, p), ninv, p);
    }
    dit(&mut fa, &t);
    fa.truncate(len);
    for x in &mut fa {
        if *x >= 2 * p {
            *x -= 2 * p;
        }
        if *x >= p {
            *x -= p;
        }
    }
    fa
}

fn inv_mod(a: u32, p: u32) -> u32 {
    pow_mod(a, p as u64 - 2, p)
}

/// Product of nonnegative integers represented as little-endian u32 limbs.
pub fn mul_words(a: &[u32], b: &[u32]) -> Vec<u32> {
    let _phase = sagebrush_interrupt::enter("bigint.ntt32");
    let mut out = vec![0; a.len() + b.len()];
    if a.is_empty() || b.is_empty() {
        return out;
    }
    let (p0, p1, p2) = (PRIMES[0].0, PRIMES[1].0, PRIMES[2].0);
    let (r0, r1, r2) = (
        convolution(a, b, 0),
        convolution(a, b, 1),
        convolution(a, b, 2),
    );
    let c01 = inv_mod(p0 % p1, p1);
    let p01 = p0 as u64 * p1 as u64;
    let c012 = inv_mod((p01 % p2 as u64) as u32, p2);
    let mut carry = 0u128;
    for i in 0..r0.len() {
        if i & (BLOCK - 1) == 0 {
            sagebrush_interrupt::check_coarse();
        }
        let d1 = if r1[i] >= r0[i] % p1 {
            r1[i] - r0[i] % p1
        } else {
            r1[i] + p1 - r0[i] % p1
        };
        let t1 = mul_mod(d1, c01, p1);
        let v = r0[i] as u128 + p0 as u128 * t1 as u128;
        let vm2 = (v % p2 as u128) as u32;
        let d2 = if r2[i] >= vm2 {
            r2[i] - vm2
        } else {
            r2[i] + p2 - vm2
        };
        let t2 = mul_mod(d2, c012, p2);
        let coefficient = v + p01 as u128 * t2 as u128;
        let total = coefficient + carry;
        out[i] = total as u32;
        carry = total >> 32;
    }
    let mut i = r0.len();
    while carry != 0 {
        out[i] = carry as u32;
        carry >>= 32;
        i += 1;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use dashu_int::UBig;
    use std::process::Command;

    fn rng(seed: &mut u64) -> u32 {
        *seed ^= *seed << 13;
        *seed ^= *seed >> 7;
        *seed ^= *seed << 17;
        *seed as u32
    }

    fn ubig(words: &[u32]) -> UBig {
        UBig::from_le_bytes(
            &words
                .iter()
                .flat_map(|w| w.to_le_bytes())
                .collect::<Vec<_>>(),
        )
    }

    #[test]
    fn products_match_dashu() {
        let mut seed = 17;
        for (la, lb) in [
            (1, 1),
            (2, 3),
            (31, 33),
            (100, 73),
            (4096, 4095),
            (10_000, 10_000),
        ] {
            let a: Vec<_> = (0..la).map(|_| rng(&mut seed)).collect();
            let b: Vec<_> = (0..lb).map(|_| rng(&mut seed)).collect();
            assert_eq!(ubig(&mul_words(&a, &b)), ubig(&a) * ubig(&b), "{la}x{lb}");
            assert_eq!(ubig(&mul_words(&a, &a)), ubig(&a).pow(2), "square {la}");
        }
        let ones = vec![u32::MAX; 5000];
        assert_eq!(ubig(&mul_words(&ones, &ones)), ubig(&ones).pow(2));
    }

    #[test]
    fn transforms_match_schoolbook() {
        let mut seed = 91;
        for prime in 0..3 {
            let p = PRIMES[prime].0 as u64;
            for (la, lb) in [(1, 1), (2, 3), (31, 33), (100, 73)] {
                let a: Vec<_> = (0..la).map(|_| rng(&mut seed)).collect();
                let b: Vec<_> = (0..lb).map(|_| rng(&mut seed)).collect();
                let mut want = vec![0u64; la + lb - 1];
                for (i, &x) in a.iter().enumerate() {
                    for (j, &y) in b.iter().enumerate() {
                        want[i + j] = (want[i + j] + x as u64 * y as u64) % p;
                    }
                }
                assert_eq!(
                    convolution(&a, &b, prime),
                    want.iter().map(|&x| x as u32).collect::<Vec<_>>(),
                    "prime {prime} {la}x{lb}"
                );
            }
        }
    }

    #[test]
    fn cache_has_the_shared_ntt_byte_bound() {
        let a = vec![u32::MAX; 10_000];
        let _ = mul_words(&a, &a);
        let (tables, bytes) = cache_stats();
        assert_eq!(tables, 3);
        assert_eq!(bytes, 3 * 16 * (1 << 15));
        assert!(bytes <= 1 << 28);
    }

    #[test]
    fn stop_unwinds_and_the_next_product_recovers() {
        const CHILD: &str = "SAGEBRUSH_NTT32_STOP_CHILD";
        if std::env::var_os(CHILD).is_some() {
            sagebrush_interrupt::clear();
            sagebrush_interrupt::hooks::reset();
            sagebrush_interrupt::hooks::arm_after(3);
            let a = vec![u32::MAX; 20_000];
            assert_eq!(
                sagebrush_interrupt::catch(|| mul_words(&a, &a)),
                Err(sagebrush_interrupt::Interrupted)
            );
            assert_eq!(sagebrush_interrupt::hooks::stopped_in(), "bigint.ntt32");
            sagebrush_interrupt::clear();
            sagebrush_interrupt::hooks::reset();
            let got = mul_words(&a[..5000], &a[..5000]);
            assert_eq!(ubig(&got), ubig(&a[..5000]).pow(2));
            return;
        }
        let status = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "ntt32::tests::stop_unwinds_and_the_next_product_recovers",
            ])
            .env(CHILD, "1")
            .status()
            .unwrap();
        assert!(status.success());
    }
}
