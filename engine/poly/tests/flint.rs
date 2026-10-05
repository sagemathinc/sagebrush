//! sagebrush-poly's factor() against FLINT's on random products.
use num_bigint::BigInt;

struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    fn int(&mut self, b: i64) -> i64 {
        (self.next() % (2 * b as u64 + 1)) as i64 - b
    }
}

fn mul(a: &[BigInt], b: &[BigInt]) -> Vec<BigInt> {
    let mut r = vec![BigInt::from(0); a.len() + b.len() - 1];
    for (i, x) in a.iter().enumerate() {
        for (j, y) in b.iter().enumerate() {
            r[i + j] += x * y;
        }
    }
    r
}

fn sorted(mut fs: Vec<(Vec<BigInt>, u32)>) -> Vec<(Vec<BigInt>, u32)> {
    fs.sort_by(|a, b| a.0.len().cmp(&b.0.len()).then_with(|| a.0.iter().rev().cmp(b.0.iter().rev())).then(a.1.cmp(&b.1)));
    fs
}

#[test]
fn random_products_agree_with_flint() {
    let mut rng = Rng(12345);
    for trial in 0..400 {
        let mut f = vec![BigInt::from(rng.int(5).max(1) * if trial % 7 == 0 { -6 } else { 1 })];
        let nf = 1 + rng.next() % 5;
        for _ in 0..nf {
            let d = 1 + (rng.next() % if trial % 3 == 0 { 9 } else { 4 }) as usize;
            let bound = if trial % 5 == 0 { 1000 } else { 9 };
            let mut g: Vec<BigInt> = (0..d).map(|_| BigInt::from(rng.int(bound))).collect();
            g.push(BigInt::from(rng.int(3).abs().max(1)));
            for _ in 0..1 + rng.next() % 2 {
                f = mul(&f, &g);
            }
        }
        let (c1, f1) = sagebrush_poly::factor(&f);
        let (c2, f2) = sagebrush_flint::factor(&f);
        assert_eq!((c1.clone(), sorted(f1)), (c2, sorted(f2)), "trial {} f = {:?}", trial, f);
    }
}

#[test]
fn cyclotomic_and_hard() {
    // x^n - 1 for n up to 60, and x^(2^k) + 1
    for n in 1..=60usize {
        let mut f = vec![BigInt::from(0); n + 1];
        f[0] = BigInt::from(-1);
        f[n] = BigInt::from(1);
        assert_eq!(sorted(sagebrush_poly::factor(&f).1), sorted(sagebrush_flint::factor(&f).1), "x^{} - 1", n);
    }
    for k in 1..=6u32 {
        let n = 1usize << k;
        let mut f = vec![BigInt::from(0); n + 1];
        f[0] = BigInt::from(1);
        f[n] = BigInt::from(1);
        assert_eq!(sagebrush_poly::factor(&f).1.len(), 1, "x^{} + 1 is irreducible", n);
    }
}
