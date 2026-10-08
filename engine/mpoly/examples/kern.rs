//! Microbenchmark of the dense inner loop with different accumulators
//! (for choosing the WebAssembly kernel).
use std::time::Instant;

#[inline(never)]
fn run_i64(acc: &mut [i64], ia: &[u32], xa: &[i64], ib: &[u32], xb: &[i64]) {
    for (t, &c) in xa.iter().enumerate() {
        let row = &mut acc[ia[t] as usize..];
        for (j, &x) in ib.iter().enumerate() {
            unsafe {
                let s = row.get_unchecked_mut(x as usize);
                *s = s.wrapping_add(c.wrapping_mul(*xb.get_unchecked(j)));
            }
        }
    }
}

#[inline(never)]
fn run_i128(acc: &mut [i128], ia: &[u32], xa: &[i64], ib: &[u32], xb: &[i64]) {
    for (t, &c) in xa.iter().enumerate() {
        let row = &mut acc[ia[t] as usize..];
        let c = c as i128;
        for (j, &x) in ib.iter().enumerate() {
            unsafe {
                let s = row.get_unchecked_mut(x as usize);
                *s = s.wrapping_add(c * *xb.get_unchecked(j) as i128);
            }
        }
    }
}

/// Two u64 lanes per slot: (lo, hi) with an explicit carry; the product by
/// 32-bit halves of nonnegative words (the sign folded in by the caller).
#[inline(never)]
fn run_split(acc: &mut [(u64, u64)], ia: &[u32], xa: &[i64], ib: &[u32], xb0: &[u64], xb1: &[u64]) {
    for (t, &c) in xa.iter().enumerate() {
        let row = &mut acc[ia[t] as usize..];
        let c = c as u64;
        let (c0, c1) = (c & 0xffff_ffff, c >> 32);
        for (j, &x) in ib.iter().enumerate() {
            unsafe {
                let (y0, y1) = (*xb0.get_unchecked(j), *xb1.get_unchecked(j));
                let p00 = c0 * y0;
                let mid = (p00 >> 32) + (c0 * y1 & 0xffff_ffff) + (c1 * y0 & 0xffff_ffff);
                let lo = (p00 & 0xffff_ffff) | (mid << 32);
                let hi = c1 * y1 + (c0 * y1 >> 32) + (c1 * y0 >> 32) + (mid >> 32);
                let s = row.get_unchecked_mut(x as usize);
                let (l, cy) = s.0.overflowing_add(lo);
                s.0 = l;
                s.1 = s.1.wrapping_add(hi + cy as u64);
            }
        }
    }
}

/// Like run_split with f64 lanes: the products of 26-bit pieces are exact.
#[inline(never)]
fn run_f64(acc: &mut [[f64; 3]], ia: &[u32], xa: &[[f64; 2]], ib: &[u32], xb: &[[f64; 2]]) {
    for (t, c) in xa.iter().enumerate() {
        let row = &mut acc[ia[t] as usize..];
        for (j, &x) in ib.iter().enumerate() {
            unsafe {
                let y = xb.get_unchecked(j);
                let s = row.get_unchecked_mut(x as usize);
                s[0] += c[0] * y[0];
                s[1] += c[0] * y[1] + c[1] * y[0];
                s[2] += c[1] * y[1];
            }
        }
    }
}

fn main() {
    let (la, lb, boxsize) = (100usize, 100usize, 4096usize);
    let mut seed = 12345u64;
    let mut rnd = || {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        seed
    };
    let ia: Vec<u32> = (0..la).map(|_| (rnd() % 2000) as u32).collect();
    let ib: Vec<u32> = (0..lb).map(|_| (rnd() % 2000) as u32).collect();
    let xa: Vec<i64> = (0..la).map(|_| (rnd() >> 4) as i64).collect();
    let xb: Vec<i64> = (0..lb).map(|_| (rnd() >> 4) as i64).collect();
    let reps = 20000;
    let ops = (la * lb * reps) as f64;
    let t = Instant::now();
    let mut a1 = vec![0i64; boxsize];
    for _ in 0..reps {
        run_i64(&mut a1, &ia, &xa, &ib, &xb);
    }
    println!("i64     {:.2} ns/op ({})", t.elapsed().as_secs_f64() * 1e9 / ops, a1[7]);
    let t = Instant::now();
    let mut a2 = vec![0i128; boxsize];
    for _ in 0..reps {
        run_i128(&mut a2, &ia, &xa, &ib, &xb);
    }
    println!("i128    {:.2} ns/op ({})", t.elapsed().as_secs_f64() * 1e9 / ops, a2[7]);
    let xb0: Vec<u64> = xb.iter().map(|&x| x as u64 & 0xffff_ffff).collect();
    let xb1: Vec<u64> = xb.iter().map(|&x| x as u64 >> 32).collect();
    let t = Instant::now();
    let mut a3 = vec![(0u64, 0u64); boxsize];
    for _ in 0..reps {
        run_split(&mut a3, &ia, &xa, &ib, &xb0, &xb1);
    }
    println!("split   {:.2} ns/op ({})", t.elapsed().as_secs_f64() * 1e9 / ops, a3[7].0);
    let fa: Vec<[f64; 2]> = xa.iter().map(|&x| [(x & 0x3ff_ffff) as f64, (x >> 26 & 0x3ff_ffff) as f64]).collect();
    let fb: Vec<[f64; 2]> = xb.iter().map(|&x| [(x & 0x3ff_ffff) as f64, (x >> 26 & 0x3ff_ffff) as f64]).collect();
    let t = Instant::now();
    let mut a4 = vec![[0f64; 3]; boxsize];
    for _ in 0..reps {
        run_f64(&mut a4, &ia, &fa, &ib, &fb);
    }
    println!("f64x3   {:.2} ns/op ({})", t.elapsed().as_secs_f64() * 1e9 / ops, a4[7][0]);
}
