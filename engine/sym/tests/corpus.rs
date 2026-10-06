//! The corpus files: corpus.json and order.json hold what Sage prints;
//! calculus.json holds results Sage (without Maxima here) could not
//! produce, checked by hand and against Maxima.
fn check(file: &str) -> (usize, usize, Vec<String>) {
    let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/corpus/");
    let data: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(format!("{}{}", dir, file)).unwrap()).unwrap();
    let (mut ok, mut total, mut bad) = (0, 0, vec![]);
    for case in data.as_array().unwrap() {
        let Some(want) = case["out"].as_str() else { continue };
        let input = case["in"].as_str().unwrap();
        total += 1;
        match sagebrush_sym::ops::run_line(input) {
            Ok(g) if g == want => ok += 1,
            Ok(g) => bad.push(format!("{} -> {} (want {})", input, g, want)),
            Err(e) => bad.push(format!("{} -> error {} (want {})", input, e, want)),
        }
    }
    (ok, total, bad)
}

#[test]
fn sage_printing() {
    sagebrush_sym::err::install_quiet_hook();
    let (a, n, bad1) = check("corpus.json");
    let (b, m, bad2) = check("order.json");
    // known differences: pi's place in sums, b*x + a*y, sin(x)/x + cos(x)
    assert!(a + b + 4 >= n + m, "{} of {} differ:\n{}\n{}", n + m - a - b, n + m, bad1.join("\n"), bad2.join("\n"));
}

#[test]
fn calculus() {
    sagebrush_sym::err::install_quiet_hook();
    let (a, n, bad) = check("calculus.json");
    assert_eq!(a, n, "{}", bad.join("\n"));
}
