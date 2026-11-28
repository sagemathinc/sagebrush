//! The primitives against real scikit-learn 1.9.1 (oracle/primitives.rows, recorded by
//! oracle/record_primitives.py from its own test hooks): the XorShift's draws and chains, the introsort (3-way and
//! 2-way, float32 and float64) on every recorded input, and swap_array_slices.  The inputs are generated here
//! exactly as the recorder generates them, and every value is exact in float32, so a row can only differ by the
//! order the sort leaves.  Every row is checked; a row missing on either side fails (the counts are pinned).

/// The recorded rows: (the oracle line, then each row's tag and fields).
struct Rows {
    oracle: String,
    rows: Vec<(String, Vec<String>)>,
}

fn rows() -> Rows {
    let text = include_str!("../oracle/primitives.rows");
    let mut oracle = String::new();
    let mut rows = vec![];
    for line in text.lines().filter(|l| !l.starts_with('#') && !l.is_empty()) {
        let mut f = line.split(' ').map(str::to_string);
        let tag = f.next().unwrap();
        if tag == "oracle" {
            oracle = line["oracle ".len()..].to_string();
        } else {
            rows.push((tag, f.collect()));
        }
    }
    Rows { oracle, rows }
}

fn of(r: &Rows, tag: &str) -> Vec<Vec<String>> {
    r.rows.iter().filter(|x| x.0 == tag).map(|x| x.1.clone()).collect()
}

use crate::partition::swap_array_slices;
use crate::rng::our_rand_r;
use crate::sort::{simultaneous_sort, Value};

struct Lcg(u64);
impl Lcg {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        self.0 >> 33
    }
}

fn fnv(h: &mut u64, bytes: &[u8]) {
    for &b in bytes {
        *h = (*h ^ u64::from(b)).wrapping_mul(0x100000001b3);
    }
}

const FNV0: u64 = 0xcbf29ce484222325;

fn values(kind: &str, n: usize, seed: u64) -> Vec<f64> {
    let mut g = Lcg(seed);
    let k = n / 2;
    let p10 = 2f64.powi(-10);
    (0..n)
        .map(|i| match kind {
            "uniform" => (g.next() % (1 << 20)) as f64 * p10,
            "signed" => ((g.next() % (1 << 20)) as f64 - (1 << 19) as f64) * p10,
            "dup7" => (g.next() % 7) as f64,
            "dup2" => (g.next() % 2) as f64,
            "few100" => (g.next() % 100) as f64,
            "ulps" => 1.0 + (g.next() % 3) as f64 * 2f64.powi(-23),
            "equal" => 5.0,
            "sorted" => i as f64,
            "reversed" => (n - i) as f64,
            "organ" => i.min(n - 1 - i) as f64,
            "saw17" => (i % 17) as f64,
            "pipe2" => (if i < k { 2 * i } else { 2 * (n - i) - 1 }) as f64,
            "interleave" => (if i % 2 == 0 { i } else { n + i }) as f64,
            "mo3killer" => (if i < k {
                if i % 2 == 0 {
                    i + 1
                } else {
                    k + i
                }
            } else {
                2 * (i - k + 1)
            }) as f64,
            _ => panic!("kind {kind}"),
        })
        .collect()
}

fn sorted_hash<T: Value>(v: Vec<T>, three: bool, bytes: impl Fn(&T) -> Vec<u8>) -> u64 {
    let mut v = v;
    let n = v.len();
    let mut ix: Vec<usize> = (0..n).collect();
    simultaneous_sort(&mut v, &mut ix, n, three);
    let mut h = FNV0;
    for x in &v {
        fnv(&mut h, &bytes(x));
    }
    for &i in &ix {
        fnv(&mut h, &(i as u64).to_le_bytes());
    }
    h
}

#[test]
fn every_sort_row_matches_scikit_learn() {
    let _g = crate::work::tests_serial();
    use std::sync::atomic::Ordering::Relaxed;
    let r = rows();
    assert!(r.oracle.starts_with("scikit-learn 1.9.1,"), "{}", r.oracle);
    let sorts = of(&r, "sort");
    assert_eq!(sorts.len(), 14 * 13 * 4 + 6 * 13 * 4, "the recorded rows' count");
    let before = crate::sort::HEAPSORTS.load(Relaxed);
    let mut bad = vec![];
    for row in &sorts {
        let (kind, n, seed, f64_, three) = (row[0].as_str(), row[1].parse().unwrap(), row[2].parse().unwrap(), row[3] == "1", row[4] == "1");
        let want = u64::from_str_radix(&row[5], 16).unwrap();
        let v = values(kind, n, seed);
        let got = if f64_ {
            sorted_hash(v, three, |x: &f64| x.to_le_bytes().to_vec())
        } else {
            // (every value is exact in float32: the cast loses nothing)
            sorted_hash(v.iter().map(|&x| x as f32).collect(), three, |x: &f32| x.to_le_bytes().to_vec())
        };
        if got != want {
            bad.push(format!("{kind} n={n} seed={seed} f64={f64_} 3way={three}"));
        }
    }
    assert!(bad.is_empty(), "{} of {} rows differ: {:?}", bad.len(), sorts.len(), &bad[..bad.len().min(10)]);
    // (the depth-limit fallback is among what the rows check)
    assert!(crate::sort::HEAPSORTS.load(Relaxed) > before);
}

#[test]
fn every_xorshift_draw_and_chain_matches_scikit_learn() {
    let _g = crate::work::tests_serial();
    let r = rows();
    let draws = of(&r, "rand");
    assert_eq!(draws.len(), 2010);
    for row in &draws {
        let (seed, want): (u32, u32) = (row[0].parse().unwrap(), row[1].parse().unwrap());
        let mut s = seed;
        assert_eq!(our_rand_r(&mut s), want, "seed {seed}");
    }
    let chains = of(&r, "chain");
    assert_eq!(chains.len(), 6);
    for row in &chains {
        let s0: u32 = row[0].parse().unwrap();
        let mut s = s0;
        assert_eq!(row.len(), 65);
        for (k, want) in row[1..].iter().map(|d| d.parse::<u32>().unwrap()).enumerate() {
            assert_eq!(our_rand_r(&mut s), want, "chain from {s0}, draw {k}");
        }
    }
}

#[test]
fn every_swap_array_slices_row_matches_scikit_learn() {
    let _g = crate::work::tests_serial();
    let r = rows();
    let swaps = of(&r, "swap");
    assert_eq!(swaps.len(), 18);
    for row in &swaps {
        let p = |i: usize| row[i].parse::<usize>().unwrap();
        let (len, start, end, n, f32_) = (p(0), p(1), p(2), p(3), row[4] == "1");
        let want = u64::from_str_radix(&row[5], 16).unwrap();
        let mut h = FNV0;
        if f32_ {
            let mut a: Vec<f32> = (0..len).map(|i| i as f32 * 0.5).collect();
            let mut buf = vec![0f32; len];
            swap_array_slices(&mut a, start, end, n, &mut buf);
            a.iter().for_each(|x| fnv(&mut h, &x.to_le_bytes()));
        } else {
            let mut a: Vec<usize> = (0..len).collect();
            let mut buf = vec![0usize; len];
            swap_array_slices(&mut a, start, end, n, &mut buf);
            a.iter().for_each(|&x| fnv(&mut h, &(x as u64).to_le_bytes()));
        }
        assert_eq!(h, want, "len {len} start {start} end {end} n {n} f32 {f32_}");
    }
}
