//! The a_p lists' admission covers their results (A09b): moments'
//! kmax numbers and their JSON are reserved with the sieve, so a tiny
//! allowance refuses moments(kmax = 64) even at n = 0; a large one admits
//! it; and every reservation is released once the reply is text (call()).
//! (A file of its own: the ledger's fake rows are process-wide.)

#[test]
fn moments_result_and_the_reply_are_admitted() {
    let held = sagebrush_web::sb_outstanding_bytes();
    let req = r#"{"fn":"moments","a":[0,0,0,-1,0],"n":0,"kmax":64}"#;
    sagebrush_ledger::hooks::set_fake_rows(Some(vec![(4096, 0, None)]));
    let r = sagebrush_web::call(req);
    assert!(r.contains("refused"), "{}", r);
    sagebrush_ledger::hooks::set_fake_rows(Some(vec![(1 << 30, 0, None)]));
    let r = sagebrush_web::call(req);
    assert!(r.starts_with(r#"{"ok":[0,"#), "{}", r);
    let r = sagebrush_web::call(r#"{"fn":"aplist","a":[0,0,0,-1,0],"n":1000}"#);
    assert!(r.starts_with(r#"{"ok":[[2,"#), "{}", &r[..60]);
    sagebrush_ledger::hooks::set_fake_rows(None);
    assert_eq!(sagebrush_web::sb_outstanding_bytes(), held, "released once the replies are text");
}

