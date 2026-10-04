//! Check dims.rs: dim S_k and dim E_k against Sage
//! (examples/sage/dims.sage), and dim M = 2 S + E against our own mod-ell
//! presentations for signs 0 and +1 plus -1.
//!   cargo run --release --example dims_vs_sage -- ~/data/sage/dims_ref.jsonl
use sagebrush_modsym::dims::{dim_cusp_forms, dim_eisenstein, dim_modsym};
use sagebrush_modsym::general::{Character, GeneralSpace};
use serde_json::Value;

fn main() {
    let path = std::env::args().nth(1).unwrap();
    let text = std::fs::read_to_string(path).unwrap();
    let (mut sage_ok, mut sage_bad, mut pres_ok, mut pres_bad) = (0, 0, 0, 0);
    for line in text.lines() {
        let r: Value = serde_json::from_str(line).unwrap();
        let g = |key: &str| r[key].as_u64().unwrap();
        let (n, k) = (g("N"), g("k") as usize);
        let exps: Vec<u32> = r["exps"].as_array().unwrap().iter().map(|x| x.as_u64().map_or(u32::MAX, |v| v as u32)).collect();
        let eps = Character::from_exponents(n, g("e").max(1), exps).unwrap();
        let ours = (eps.conductor(), dim_cusp_forms(&eps, k), dim_eisenstein(&eps, k));
        let sage = (g("conductor"), g("cusp"), g("eis"));
        if ours == sage {
            sage_ok += 1;
        } else {
            sage_bad += 1;
            if sage_bad <= 10 {
                println!("N={} k={}: (cond, S, E) ours {:?} sage {:?}", n, k, ours, sage);
            }
        }
        // Presentations (kept small: they are the slow part).
        if n * k as u64 <= 600 {
            let want = dim_modsym(&eps, k) as usize;
            let d = |s| GeneralSpace::new(n, k, &eps, s).unwrap().dimension();
            let (d0, dp, dm) = (d(0), d(1), d(-1));
            if d0 == want && dp + dm == want {
                pres_ok += 1;
            } else {
                pres_bad += 1;
                if pres_bad <= 10 {
                    println!("N={} k={}: formula {} vs sign 0 {}, +1 {}, -1 {}", n, k, want, d0, dp, dm);
                }
            }
        }
    }
    println!("formulas vs Sage: {} agree, {} differ", sage_ok, sage_bad);
    println!("2 S + E vs presentations (sign 0, and +1 plus -1): {} agree, {} differ", pres_ok, pres_bad);
}
