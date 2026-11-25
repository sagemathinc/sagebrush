//! The fast product's entries, from the source: the only production entry
//! is `Mat::mul`, through the admission (`fast::mul`) and the allowance
//! (`with_fast_product`), with its per-call reset (`reset_fast_product`);
//! every entry that bypasses the admission, or
//! reads its state, is compiled only with the test-hooks feature.  A new
//! entry, or one that loses its gate, fails here.

const FAST: &str = include_str!("../src/nmod_mat/fast.rs");
const NMOD_MAT: &str = include_str!("../src/nmod_mat.rs");

/// (name, visibility, gated by the test-hooks feature) of each top-level
/// fn in `src` before its tests, outside its cfg(test) modules.
fn fns(src: &str) -> Vec<(String, String, bool)> {
    let body = &src[..src.find("#[cfg(test)]\nmod tests").unwrap_or(src.len())];
    let lines: Vec<&str> = body.lines().collect();
    let mut out = vec![];
    let mut in_test_mod = false;
    for (i, l) in lines.iter().enumerate() {
        if in_test_mod {
            in_test_mod = *l != "}";
            continue;
        }
        if l.contains("mod ") && l.ends_with('{') && i > 0 && lines[i - 1] == "#[cfg(test)]" {
            in_test_mod = true;
            continue;
        }
        let t = l.trim_start();
        let indent = l.len() - t.len();
        // (top-level items, and methods of a top-level impl)
        if indent > 4 {
            continue;
        }
        let (vis, rest) = if let Some(r) = t.strip_prefix("pub(super) fn ") {
            ("pub(super)", r)
        } else if let Some(r) = t.strip_prefix("pub(crate) fn ") {
            ("pub(crate)", r)
        } else if let Some(r) = t.strip_prefix("pub fn ") {
            ("pub", r)
        } else {
            continue;
        };
        let name: String = rest.chars().take_while(|c| c.is_alphanumeric() || *c == '_').collect();
        let mut gated = false;
        for a in lines[..i].iter().rev() {
            let a = a.trim();
            if a.starts_with("#[") {
                gated |= a == "#[cfg(feature = \"test-hooks\")]";
            } else if !a.starts_with("///") {
                break;
            }
        }
        out.push((name, vis.to_string(), gated));
    }
    out
}

#[test]
fn the_fast_products_entries_are_admitted_or_gated() {
    let f = fns(FAST);
    let mut public: Vec<(&str, bool)> = f.iter().filter(|x| x.1 == "pub").map(|x| (x.0.as_str(), x.2)).collect();
    public.sort();
    assert_eq!(
        public,
        vec![
            ("fast_allowance_left", true),
            ("fast_n0", true),
            ("fast_product_state", true),
            ("leave_fast_product_state", true),
            ("reset_fast_product", false),
            ("set_fast_n0", true),
            ("with_fast_product", false)
        ]
    );
    let mut inner: Vec<&str> = f.iter().filter(|x| x.1 != "pub").map(|x| x.0.as_str()).collect();
    inner.sort();
    assert_eq!(inner, vec!["classical_peak", "classical_units", "mul", "mul_planned", "plan"]);

    // nmod_mat.rs: the fns that call into fast.rs (outside its tests), and
    // their gates
    let body = &NMOD_MAT[..NMOD_MAT.find("#[cfg(test)]\nmod tests").unwrap()];
    let all = fns(NMOD_MAT);
    let mut callers: Vec<(String, bool)> = vec![];
    let mut current: Option<&(String, String, bool)> = None;
    for l in body.lines() {
        let t = l.trim_start();
        if let Some(x) = all.iter().find(|x| t.starts_with(&format!("{} fn {}(", x.1, x.0))) {
            current = Some(x);
        }
        if t.contains("fast::") && !t.starts_with("pub use") && !t.starts_with("//") {
            let c = current.expect("a call into fast.rs outside a fn");
            if !callers.iter().any(|x| x.0 == c.0) {
                callers.push((c.0.clone(), c.2));
            }
        }
    }
    callers.sort();
    assert_eq!(callers, vec![
            ("mul".to_string(), false),
            ("mul_planned".to_string(), true),
            ("planned_levels".to_string(), true),
            ("planned_peak".to_string(), true)
        ]);
    // the one ungated caller goes through the admission
    assert!(body.contains("    pub fn mul(&self, o: &Mat) -> Mat {\n        assert_eq!(self.cols, o.rows);\n        fast::mul(self, o)\n    }"));
    // and the re-exports: the allowance in production, its state gated
    assert!(body.contains(
        "pub use fast::{reset_fast_product, with_fast_product};\n#[cfg(feature = \"test-hooks\")]\npub use fast::{fast_allowance_left, fast_n0, fast_product_state, leave_fast_product_state, set_fast_n0};\n"
    ));
}
