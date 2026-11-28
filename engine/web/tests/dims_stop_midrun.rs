//! Stop raised while dims runs, at checks spread over the whole call (the
//! explicit character's closure walk, its tables, the sums' scans): each
//! armed check interrupts it, and the next call answers as before. In its
//! own test binary (the hooks are process-wide).

use sagebrush_interrupt::hooks;

#[test]
fn dims_stops_mid_run() {
    // a character of order 100 mod 101 (generator 2), and the trivial one at 42
    for req in [r#"{"fn":"dims","n":101,"k":2,"chi":[100,[2],[1]]}"#, r#"{"fn":"dims","n":42,"k":4}"#] {
        hooks::reset();
        let want = sagebrush_web::call(req);
        let total = hooks::total();
        assert!(total > 100, "{}: {} checks", req, total);
        for i in 1..=8 {
            let at = (total * i / 8).max(1);
            hooks::reset();
            hooks::arm_at(at);
            let r = sagebrush_interrupt::catch(|| sagebrush_web::call(req));
            sagebrush_interrupt::clear();
            hooks::reset();
            assert!(r.is_err(), "{}: stopped at check {} of {}", req, at, total);
            assert_eq!(sagebrush_web::call(req), want, "{}: answers after the stop", req);
        }
    }
}
