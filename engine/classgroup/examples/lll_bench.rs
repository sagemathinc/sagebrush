// LLL benchmark driver (not shipped): reduce one matrix file and print the seconds taken.
//   cargo run --release -p sagebrush-classgroup --example lll_bench -- MODE IN [OUT]
// MODE: l2 / l2proof (sagebrush_poly::l2 / l2_proof: the five-rung reducer and its proof checks, with a REPORT line), poly (sagebrush_poly::lll::lll, unlimited budget) or api (sagebrush_classgroup::api::lll, which first
// takes the HNF to handle dependent rows). IN: "rows cols" then one row per line. OUT: the reduced rows.
use sagebrush_bigint::BigInt;
use std::io::Write;
use std::time::Instant;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let (mode, path) = (&args[1], &args[2]);
    let text = std::fs::read_to_string(path).unwrap();
    let mut lines = text.lines();
    let _dims = lines.next().unwrap();
    let rows: Vec<Vec<BigInt>> = lines
        .filter(|l| !l.trim().is_empty())
        .map(|l| l.split_whitespace().map(|x| x.parse::<BigInt>().unwrap()).collect())
        .collect();
    let t = Instant::now();
    let out: Vec<Vec<BigInt>> = match mode.as_str() {
        "poly" => {
            let d = rows.len();
            let e = rows.iter().flatten().map(|x| x.bits()).max().unwrap_or(1);
            let cap = sagebrush_poly::lll::cap_bits(d, e).unwrap();
            let b = sagebrush_poly::budget::Budget::unlimited();
            sagebrush_poly::lll::lll(&b, rows, cap).map_err(|_| "refused").unwrap().basis
        }
        "api" => sagebrush_classgroup::api::lll(&rows).unwrap(),
        "l2" | "l2proof" => {
            let (r, rep) = sagebrush_poly::l2::l2_report(rows, mode == "l2proof");
            let rungs: Vec<String> = rep.rungs.iter().map(|(k, s)| format!("{k}:{s:.4}")).collect();
            eprintln!("REPORT rungs {} check {} check_secs {:.4}", rungs.join(","), rep.check, rep.check_secs);
            r.map_err(|e| format!("{:?}", e.0)).unwrap()
        }
        // the fast rung alone (no escalation), then which check proves it (proved_by's whole chain)
        "l2stat" => {
            let mut s = sagebrush_poly::l2::L2::<sagebrush_poly::l2::Fe>::new_fast(rows);
            s.run().map_err(|e| format!("{e:?}")).unwrap();
            let t1 = t.elapsed().as_secs_f64();
            let d = s.basis.len();
            let rung = s.proved_by(false).unwrap_or_else(|| "UNREDUCED".into());
            let t2 = t.elapsed().as_secs_f64();
            eprintln!("STAT reduce {t1:.4} check {:.4} rung {rung} d {d}", t2 - t1);
            s.into_basis()
        }
        _ => panic!("mode"),
    };
    let secs = t.elapsed().as_secs_f64();
    println!("{secs:.6}");
    if let Some(o) = args.get(3) {
        let mut f = std::fs::File::create(o).unwrap();
        writeln!(f, "{} {}", out.len(), out.first().map_or(0, |r| r.len())).unwrap();
        for r in &out {
            let s: Vec<String> = r.iter().map(|x| x.to_string()).collect();
            writeln!(f, "{}", s.join(" ")).unwrap();
        }
    }
}
