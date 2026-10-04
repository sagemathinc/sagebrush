//! Recompute LMFDB's newspaces S_k^new(N, [chi]) (k >= 2): dimensions of
//! S_k, E_k and the newspace, and the dimensions of the Galois orbits of
//! newforms, from ~/data/lmfdb/mf_newspaces_wt2plus_Nk2le1000.jsonl
//! (fetch_newspaces.py; another file via NEWSPACES=path).
//!   cargo run --release --example newspaces_vs_lmfdb -- [MAX_DIM] [LABEL...]
use sagebrush_modsym::dims::{dim_cusp_forms, dim_eisenstein};
use sagebrush_modsym::general::Character;
use sagebrush_modsym::newspace::newspace_orbits;
use serde_json::Value;
use std::time::Instant;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let max_dim: u64 = args.first().and_then(|a| a.parse().ok()).unwrap_or(u64::MAX);
    let only: Vec<&String> = args.iter().skip(1).collect();
    let path = std::env::var("NEWSPACES").unwrap_or_else(|_| format!("{}/data/lmfdb/mf_newspaces_wt2plus_Nk2le1000.jsonl", std::env::var("HOME").unwrap()));
    let factor = |f: &[num_bigint::BigInt]| sagebrush_flint::factor(f).1;
    let (mut ok, mut bad, mut skipped) = (0, 0, 0);
    let (mut orbits, mut slowest) = (0usize, (0.0f64, String::new()));
    let t0 = Instant::now();
    for line in std::fs::read_to_string(path).unwrap().lines() {
        let r: Value = serde_json::from_str(line).unwrap();
        let label = r["label"].as_str().unwrap().to_string();
        if !only.is_empty() && !only.iter().any(|l| **l == label) {
            continue;
        }
        if r["dim"].as_u64().unwrap() > max_dim {
            skipped += 1;
            continue;
        }
        let g = |key: &str| r[key].as_u64().unwrap();
        let (n, k) = (g("level"), g("weight") as usize);
        let cv = r["char_values"].as_array().unwrap();
        let ints = |v: &Value| v.as_array().unwrap().iter().map(|x| x.as_u64().unwrap()).collect::<Vec<u64>>();
        let eps = Character::from_generators(n, cv[1].as_u64().unwrap(), &ints(&cv[2]), &ints(&cv[3])).unwrap();
        let deg = |e: &Character| (1..=e.order).filter(|j| sagebrush_modsym::p1::gcd(*j, e.order) == 1).count() as u64;
        let phi = deg(&eps);
        let mut msgs = vec![];
        let ours_dims = (phi * dim_cusp_forms(&eps, k), phi * dim_eisenstein(&eps, k), eps.conductor(), eps.order);
        let lmfdb_dims = (g("cusp_dim"), g("eis_dim"), g("char_conductor"), g("char_order"));
        if ours_dims != lmfdb_dims {
            msgs.push(format!("(dim S, dim E, cond, order) ours {:?} LMFDB {:?}", ours_dims, lmfdb_dims));
        }
        let t = Instant::now();
        match newspace_orbits(n, k, &eps, &factor) {
            Ok(res) => {
                let mut want: Vec<usize> = r["hecke_orbit_dims"].as_array().unwrap().iter().map(|x| x.as_u64().unwrap() as usize).collect();
                want.sort();
                if res.status != "proven" || res.dim as u64 != g("dim") || res.dims != want {
                    msgs.push(format!("{}: dim {} orbits {:?}; LMFDB dim {} orbits {:?}; {:?}", res.status, res.dim, res.dims, g("dim"), want, res.checks));
                }
                orbits += res.dims.len();
            }
            Err(e) => msgs.push(format!("error: {}", e)),
        }
        let secs = t.elapsed().as_secs_f64();
        if secs > slowest.0 {
            slowest = (secs, label.clone());
        }
        if msgs.is_empty() {
            ok += 1;
        } else {
            bad += 1;
            if bad <= 20 {
                println!("{}: {}", label, msgs.join("; "));
            }
        }
    }
    println!("{} newspaces agree ({} orbits), {} differ, {} skipped (dim > {}); {:.1} s total, slowest {} {:.2} s",
        ok, orbits, bad, skipped, max_dim, t0.elapsed().as_secs_f64(), slowest.1, slowest.0);
}
