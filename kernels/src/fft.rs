//! The mixed-radix Stockham FFT and the real-FFT split step of
//! src/runtime/numpy_fft.ts, operation for operation.  Complex numbers are
//! interleaved (re, im), so one f64x2 holds one of them.  Twiddle tables and
//! the radix-3/5 constants come from the TS (Math.cos/sin), so results are
//! the same bits.

use core::arch::wasm32::*;

#[inline(always)]
unsafe fn ld(p: *const f64) -> v128 {
    v128_load(p as *const v128)
}
#[inline(always)]
unsafe fn st(p: *mut f64, v: v128) {
    v128_store(p as *mut v128, v)
}
#[inline(always)]
fn swap(v: v128) -> v128 {
    i64x2_shuffle::<1, 0>(v, v)
}
/// A complex twiddle w as the pair of vectors ([wr, wr], [-wi, wi]).
#[inline(always)]
fn tw(wr: f64, wi: f64) -> (v128, v128) {
    (f64x2_splat(wr), f64x2(-wi, wi))
}
/// a w = (ar wr - ai wi, ai wr + ar wi), as (ar*wr - ai*wi, ar*wi + ai*wr)
#[inline(always)]
fn cmul(a: v128, w: (v128, v128)) -> v128 {
    f64x2_add(f64x2_mul(a, w.0), f64x2_mul(swap(a), w.1))
}

/// One complex FFT of length n of x (interleaved), y scratch of the same
/// size.  factors: the radices (as doubles), tc/ts: cos/sin(2 pi k/n) for
/// k < n; consts: cos/sin(2 pi/3), cos/sin(4 pi/3), cos/sin(2 pi/5),
/// cos/sin(4 pi/5).  Returns 0 if the result is in x, 1 if in y.  As
/// stockhamI() in the TS.
#[no_mangle]
pub unsafe extern "C" fn fft_stockham(
    x: *mut f64,
    y: *mut f64,
    n: usize,
    factors: *const f64,
    nf: usize,
    tc: *const f64,
    ts: *const f64,
    consts: *const f64,
    inverse: i32,
) -> i32 {
    let sg = if inverse != 0 { 1.0 } else { -1.0 };
    // rot(b) = (-sg bi, sg br): the "- sg Bi, + sg Br" of the butterflies
    let rs = f64x2(-sg, sg);
    let rot = |b: v128| f64x2_mul(swap(b), rs);
    let (mut xx, mut yy) = (x, y);
    let mut ns = 1usize;
    let mut vv = [f64x2_splat(0.0); 16];
    let mut ww = [(f64x2_splat(0.0), f64x2_splat(0.0)); 16];
    for fi in 0..nf {
        let r = *factors.add(fi) as usize;
        let stride = n / r;
        let blocks = stride / ns;
        let step = n / (ns * r);
        let s2 = 2 * stride;
        let n2 = 2 * ns;
        let w = |t: usize| tw(*tc.add(t), sg * *ts.add(t));
        if r == 4 {
            for jm in 0..ns {
                let t1 = jm * step;
                let (w1, w2, w3) = (w(t1), w(2 * t1), w(3 * t1));
                let mut src = 2 * jm;
                let mut dst = 2 * jm;
                for _ in 0..blocks {
                    let x0 = ld(xx.add(src));
                    let x1 = cmul(ld(xx.add(src + s2)), w1);
                    let x2 = cmul(ld(xx.add(src + 2 * s2)), w2);
                    let x3 = cmul(ld(xx.add(src + 3 * s2)), w3);
                    let (s0, d0) = (f64x2_add(x0, x2), f64x2_sub(x0, x2));
                    let (s1, d1) = (f64x2_add(x1, x3), f64x2_sub(x1, x3));
                    st(yy.add(dst), f64x2_add(s0, s1));
                    st(yy.add(dst + n2), f64x2_add(d0, rot(d1)));
                    st(yy.add(dst + 2 * n2), f64x2_sub(s0, s1));
                    st(yy.add(dst + 3 * n2), f64x2_sub(d0, rot(d1)));
                    src += n2;
                    dst += 4 * n2;
                }
            }
        } else if r == 2 {
            for jm in 0..ns {
                let w1 = w(jm * step);
                let mut src = 2 * jm;
                let mut dst = 2 * jm;
                for _ in 0..blocks {
                    let x1 = cmul(ld(xx.add(src + s2)), w1);
                    let x0 = ld(xx.add(src));
                    st(yy.add(dst), f64x2_add(x0, x1));
                    st(yy.add(dst + n2), f64x2_sub(x0, x1));
                    src += n2;
                    dst += 2 * n2;
                }
            }
        } else if r == 3 || r == 5 {
            let c = if r == 3 { consts } else { consts.add(4) };
            let (c1, sn1, c2, sn2) = (f64x2_splat(*c), f64x2_splat(*c.add(1)), f64x2_splat(*c.add(2)), f64x2_splat(*c.add(3)));
            let half = f64x2_splat(0.5);
            for jm in 0..ns {
                for k in 1..r {
                    ww[k] = w(k * jm * step);
                }
                let mut src = 2 * jm;
                let mut dst = 2 * jm;
                for _ in 0..blocks {
                    let x0 = ld(xx.add(src));
                    for k in 1..r {
                        vv[k] = cmul(ld(xx.add(src + k * s2)), ww[k]);
                    }
                    if r == 3 {
                        let t1 = f64x2_add(vv[1], vv[2]);
                        let t2 = f64x2_sub(vv[1], vv[2]);
                        let a = f64x2_sub(x0, f64x2_mul(half, t1));
                        let b = f64x2_mul(sn1, t2);
                        st(yy.add(dst), f64x2_add(x0, t1));
                        st(yy.add(dst + n2), f64x2_add(a, rot(b)));
                        st(yy.add(dst + 2 * n2), f64x2_sub(a, rot(b)));
                    } else {
                        let t1 = f64x2_add(vv[1], vv[4]);
                        let t2 = f64x2_add(vv[2], vv[3]);
                        let t3 = f64x2_sub(vv[1], vv[4]);
                        let t4 = f64x2_sub(vv[2], vv[3]);
                        let a1 = f64x2_add(f64x2_add(x0, f64x2_mul(c1, t1)), f64x2_mul(c2, t2));
                        let a2 = f64x2_add(f64x2_add(x0, f64x2_mul(c2, t1)), f64x2_mul(c1, t2));
                        let b1 = f64x2_add(f64x2_mul(sn1, t3), f64x2_mul(sn2, t4));
                        let b2 = f64x2_sub(f64x2_mul(sn2, t3), f64x2_mul(sn1, t4));
                        st(yy.add(dst), f64x2_add(f64x2_add(x0, t1), t2));
                        st(yy.add(dst + n2), f64x2_add(a1, rot(b1)));
                        st(yy.add(dst + 4 * n2), f64x2_sub(a1, rot(b1)));
                        st(yy.add(dst + 2 * n2), f64x2_add(a2, rot(b2)));
                        st(yy.add(dst + 3 * n2), f64x2_sub(a2, rot(b2)));
                    }
                    src += n2;
                    dst += r * n2;
                }
            }
        } else {
            let stn = n / r;
            for jm in 0..ns {
                for k in 1..r {
                    ww[k] = w(k * jm * step);
                }
                let mut src = 2 * jm;
                let mut dst = 2 * jm;
                for _ in 0..blocks {
                    vv[0] = ld(xx.add(src));
                    for k in 1..r {
                        vv[k] = cmul(ld(xx.add(src + k * s2)), ww[k]);
                    }
                    for k in 0..r {
                        let mut s = vv[0];
                        for q in 1..r {
                            s = f64x2_add(s, cmul(vv[q], w(((q * k) % r) * stn)));
                        }
                        st(yy.add(dst + k * n2), s);
                    }
                    src += n2;
                    dst += r * n2;
                }
            }
        }
        core::mem::swap(&mut xx, &mut yy);
        ns *= r;
    }
    if xx == x {
        0
    } else {
        1
    }
}

/// The real FFT of each of `rows` rows of length n (even) of data, through
/// a complex FFT of length h = n/2 and a split step, into out (rows x
/// (h+1) interleaved complex).  z, y: 2h doubles of scratch; tch/tsh:
/// the length-h tables, tcn/tsn: the length-n tables.  As rfftEven() in
/// the TS.
#[no_mangle]
pub unsafe extern "C" fn rfft_rows(
    data: *const f64,
    rows: usize,
    n: usize,
    out: *mut f64,
    z: *mut f64,
    y: *mut f64,
    factors: *const f64,
    nf: usize,
    tch: *const f64,
    tsh: *const f64,
    tcn: *const f64,
    tsn: *const f64,
    consts: *const f64,
) {
    let h = n / 2;
    for row in 0..rows {
        let src = data.add(row * n);
        for i in 0..n {
            *z.add(i) = *src.add(i);
        }
        let zz = if fft_stockham(z, y, h, factors, nf, tch, tsh, consts, 0) == 0 { z } else { y };
        let o = out.add(row * 2 * (h + 1));
        for k in 0..=h {
            let a = k % h;
            let b = (h - k) % h;
            let (zar, zai, zbr, zbi) = (*zz.add(2 * a), *zz.add(2 * a + 1), *zz.add(2 * b), *zz.add(2 * b + 1));
            let er = (zar + zbr) / 2.0;
            let ei = (zai - zbi) / 2.0;
            let or = (zai + zbi) / 2.0;
            let oi = -(zar - zbr) / 2.0;
            let c = *tcn.add(k);
            let sn = -*tsn.add(k);
            *o.add(2 * k) = er + (or * c - oi * sn);
            *o.add(2 * k + 1) = ei + (or * sn + oi * c);
        }
    }
}
