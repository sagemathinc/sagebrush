//! The mat_smith_form op of the JSON dispatcher: (D, U, V) with U m V = D,
//! the route taken (route 3, "hermite", for singular and rectangular
//! input), a row-less matrix's width from "cols", and its floor
//! L (the transforms' entries) admitted by the memory ledger before
//! anything is allocated.
use serde_json::{json, Value};

fn call(req: Value) -> Value {
    serde_json::from_str(&sagebrush_web::call(&req.to_string())).unwrap()
}

fn rows(v: &Value) -> Vec<Vec<i64>> {
    v.as_array().unwrap().iter().map(|r| r.as_array().unwrap().iter().map(|x| x.as_str().unwrap().parse().unwrap()).collect()).collect()
}

#[test]
fn mat_smith_form_answers_and_admits_its_floor() {
    let r = call(json!({"fn": "mat_smith_form", "m": [[2, 4], [6, 8]]}));
    let ok = &r["ok"];
    assert_eq!(rows(&ok["d"]), vec![vec![2, 0], vec![0, 4]]);
    assert_eq!(ok["route"], json!("trailing"));
    let (u, v) = (rows(&ok["u"]), rows(&ok["v"]));
    let a = [[2i64, 4], [6, 8]];
    let ua: Vec<Vec<i64>> = (0..2).map(|i| (0..2).map(|j| (0..2).map(|t| u[i][t] * a[t][j]).sum()).collect()).collect();
    let uav: Vec<Vec<i64>> = (0..2).map(|i| (0..2).map(|j| (0..2).map(|t| ua[i][t] * v[t][j]).sum()).collect()).collect();
    assert_eq!(uav, vec![vec![2, 0], vec![0, 4]]);
    // singular and rectangular input: route 3
    for m in [json!([[2, 4], [1, 2]]), json!([[6, 10, 15], [4, 8, 12]])] {
        let r = call(json!({"fn": "mat_smith_form", "m": m}));
        assert_eq!(r["ok"]["route"], json!("hermite"), "{r}");
    }
    // a matrix with no rows: its width from "cols"
    let r = call(json!({"fn": "mat_smith_form", "m": [], "cols": 3}));
    assert_eq!(r["ok"]["v"].as_array().unwrap().len(), 3);
    // a 1 x 2^17 row asks for 2^34 entries of V: refused by the ledger
    // before any is allocated (the floor, not an out-of-memory abort)
    let r = call(json!({"fn": "mat_smith_form", "m": [vec![1; 1 << 17]]}));
    let e = r["error"].as_str().unwrap_or_else(|| panic!("refused: {r}"));
    assert!(e.contains("the Smith form's transforms"), "{e}");
}
