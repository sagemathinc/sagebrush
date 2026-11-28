// Only sb_call holds the a_p lists' reservations for the host's copy of its
// reply.  After sb_sym_call, sb_mp_call or sb_bin_call (which start a new run
// but make no call()), a plain native call() releases its own holds when it
// returns; under sb_call the hold lasts until the next export starts.  Its
// own test binary (the held reservations and the ledger's fake rows are the
// process's), one test.
use sagebrush_web::*;

type Entry = unsafe extern "C" fn(*const u8, usize) -> *const u8;

// SAFETY: `req` is a live slice, so (ptr, len) is readable for the call, as
// the entry points require; this binary's one test is their only caller.
#[allow(unsafe_code)]
fn enter(f: Entry, req: &[u8]) {
    unsafe {
        f(req.as_ptr(), req.len());
    }
}

#[test]
fn only_sb_call_holds_for_the_host() {
    sagebrush_ledger::hooks::set_fake_rows(Some(vec![(1 << 30, 0, None)]));
    let base = sb_outstanding_bytes();
    let aplist = r#"{"fn":"aplist","a":[0,0,0,-1,0],"n":1000}"#;
    let others: [(&str, Entry, &[u8]); 3] = [("sb_sym_call", sb_sym_call, b"nop"), ("sb_mp_call", sb_mp_call, b""), ("sb_bin_call", sb_bin_call, b"")];
    for (name, f, req) in others {
        enter(f, req);
        let r = call(aplist);
        assert!(r.starts_with(r#"{"ok":[[2,"#), "{name}: {}", &r[..r.len().min(60)]);
        assert_eq!(sb_outstanding_bytes(), base, "{name}: a native call() after it kept its holds");
    }
    // the control: sb_call's aplist holds its reservation for the host's copy,
    // until the next export starts
    enter(sb_call, aplist.as_bytes());
    assert!(sb_outstanding_bytes() > base, "sb_call's reply holds its reservation");
    enter(sb_sym_call, b"nop");
    assert_eq!(sb_outstanding_bytes(), base, "released when the next export starts");
    sagebrush_ledger::hooks::set_fake_rows(None);
}
