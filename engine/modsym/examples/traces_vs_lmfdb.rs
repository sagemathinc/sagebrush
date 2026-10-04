//! Trace forms tr a_n (n <= B) of every newform orbit, against LMFDB's
//! mf_newforms.traces; orbits sorted by (dimension, trace form) as LMFDB
//! does, so agreement also reproduces LMFDB's labels (N.k.c.x).
//!   cargo run --release --example traces_vs_lmfdb -- [B] [MAX_DIM] [SPACE...]
use num_bigint::BigInt;
use sagebrush_modsym::general::Character;
use sagebrush_modsym::newspace::newspace_orbits;
use sagebrush_modsym::traces::orbit_traces;
use serde_json::Value;
use std::collections::HashMap;
use std::time::Instant;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let bound: usize = args.first().and_then(|a| a.parse().ok()).unwrap_or(1000);
    let max_dim: u64 = args.get(1).and_then(|a| a.parse().ok()).unwrap_or(u64::MAX);
    let only: Vec<&String> = args.iter().skip(2).collect();
    let home = std::env::var("HOME").unwrap();
    let spaces = std::env::var("NEWSPACES").unwrap_or(format!("{}/data/lmfdb/mf_newspaces_wt2plus_Nk2le1000.jsonl", home));
    let forms = std::env::var("NEWFORMS").unwrap_or(format!("{}/data/lmfdb/mf_newforms_traces_Nk2le1000.jsonl", home));
    let mut lmfdb: HashMap<String, Vec<(String, Vec<BigInt>)>> = HashMap::new();
    for line in std::fs::read_to_string(forms).unwrap().lines() {
        let r: Value = serde_json::from_str(line).unwrap();
        let tr: Vec<BigInt> = r["traces"].as_array().unwrap().iter().take(bound).map(|x| x.as_str().unwrap().parse().unwrap()).collect();
        lmfdb.entry(r["space"].as_str().unwrap().to_string()).or_default().push((r["label"].as_str().unwrap().to_string(), tr));
    }
    let factor = |f: &[BigInt]| sagebrush_flint::factor(f).1;
    let (mut ok, mut bad, mut forms_ok, mut skipped) = (0, 0, 0, 0);
    let mut slowest = (0.0f64, String::new());
    let t0 = Instant::now();
    for line in std::fs::read_to_string(spaces).unwrap().lines() {
        let r: Value = serde_json::from_str(line).unwrap();
        let label = r["label"].as_str().unwrap().to_string();
        if (!only.is_empty() && !only.iter().any(|l| **l == label)) || r["dim"].as_u64().unwrap() == 0 {
            continue;
        }
        if r["dim"].as_u64().unwrap() > max_dim {
            skipped += 1;
            continue;
        }
        let (n, k) = (r["level"].as_u64().unwrap(), r["weight"].as_u64().unwrap() as usize);
        let cv = r["char_values"].as_array().unwrap();
        let ints = |v: &Value| v.as_array().unwrap().iter().map(|x| x.as_u64().unwrap()).collect::<Vec<u64>>();
        let eps = Character::from_generators(n, cv[1].as_u64().unwrap(), &ints(&cv[2]), &ints(&cv[3])).unwrap();
        let t = Instant::now();
        let result = newspace_orbits(n, k, &eps, &factor).and_then(|res| orbit_traces(n, k, &eps, &res, bound).map(|tr| (res, tr)));
        let secs = t.elapsed().as_secs_f64();
        if secs > slowest.0 {
            slowest = (secs, label.clone());
        }
        let want = lmfdb.get(&label).cloned().unwrap_or_default();
        match result {
            Ok((res, tr)) => {
                let mut ours: Vec<(usize, Vec<BigInt>)> = res.dims.iter().cloned().zip(tr).collect();
                ours.sort();
                let mismatch: Vec<String> = want.iter().zip(&ours).filter(|(w, o)| w.1 != o.1).map(|(w, o)| {
                    let i = w.1.iter().zip(&o.1).position(|(a, b)| a != b).unwrap_or(0);
                    format!("{}: n = {}: LMFDB {} ours {}", w.0, i + 1, w.1[i], o.1.get(i).cloned().unwrap_or_default())
                }).collect();
                if ours.len() == want.len() && mismatch.is_empty() {
                    ok += 1;
                    forms_ok += ours.len();
                } else {
                    bad += 1;
                    if bad <= 20 {
                        println!("{}: {} orbits vs LMFDB {}; {}", label, ours.len(), want.len(), mismatch.join("; "));
                    }
                }
            }
            Err(e) => {
                bad += 1;
                if bad <= 20 {
                    println!("{}: error {}", label, e);
                }
            }
        }
    }
    println!("{} nonzero spaces agree ({} newforms: trace forms to n = {} and labels), {} differ, {} skipped; {:.1} s, slowest {} {:.2} s",
        ok, forms_ok, bound, bad, skipped, t0.elapsed().as_secs_f64(), slowest.1, slowest.0);
}
