//! orbits_vs_lmfdb LMFDB.jsonl FROM TO [prime]: for every level N in [FROM, TO]
//! (only prime levels with "prime"),
//! the Galois orbits of newforms (dimension, tr(a_p) for primes p < 1000,
//! p != N) against LMFDB's mf_newforms (dim, traces), as multisets.
use std::collections::HashMap;

fn is_prime(n: u64) -> bool {
    n > 1 && (2..).take_while(|d| d * d <= n).all(|d| n % d != 0)
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let (from, to): (u64, u64) = (args[1].parse().unwrap(), args[2].parse().unwrap());
    let only_prime = args.get(3).map_or(false, |s| s == "prime");
    let primes: Vec<u64> = (2..1000).filter(|&p| is_prime(p)).collect();
    let mut lmfdb: HashMap<u64, Vec<(usize, Vec<i64>)>> = HashMap::new();
    for line in std::fs::read_to_string(&args[0]).unwrap().lines() {
        let v: serde_json::Value = serde_json::from_str(line).unwrap();
        let n = v["level"].as_u64().unwrap();
        if n < from || n > to || (only_prime && !is_prime(n)) {
            continue;
        }
        let tr: Vec<i64> = v["traces"].as_array().unwrap().iter().map(|x| x.as_i64().unwrap()).collect();
        let key = primes.iter().filter(|&&p| n % p != 0).map(|&p| tr[p as usize - 1]).collect();
        lmfdb.entry(n).or_default().push((v["dim"].as_u64().unwrap() as usize, key));
    }
    let levels: Vec<u64> = (from..=to).filter(|&n| !only_prime || is_prime(n)).collect();
    let factor = |f: &[sagebrush_bigint::BigInt]| sagebrush_flint::factor(f).1;
    let t = std::time::Instant::now();
    use rayon::prelude::*;
    let res: Vec<(u64, usize, usize, bool)> = levels
        .par_iter()
        .map(|&n| {
            let orbits = sagebrush_modsym::orbits::newform_orbits(n, 999, &factor).unwrap();
            let mut ours: Vec<(usize, Vec<i64>)> = orbits.iter().map(|o| (o.dim, o.traces.iter().map(|x| x.1).collect())).collect();
            let mut theirs = lmfdb.get(&n).cloned().unwrap_or_default();
            ours.sort();
            theirs.sort();
            let maxdim = ours.iter().map(|o| o.0).max().unwrap_or(0);
            (n, ours.len(), maxdim, ours == theirs)
        })
        .collect();
    let bad: Vec<_> = res.iter().filter(|r| !r.3).collect();
    for r in bad.iter().take(10) {
        println!("DISAGREE N={} orbits={}", r.0, r.1);
    }
    println!(
        "levels {}..={}: {} levels, {} Galois orbits (largest dim {}), traces of a_p for p < 1000 compared; {} levels disagree; {:.1} s",
        from, to, res.len(), res.iter().map(|r| r.1).sum::<usize>(), res.iter().map(|r| r.2).max().unwrap_or(0), bad.len(), t.elapsed().as_secs_f64()
    );
}
