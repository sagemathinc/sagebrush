//! The whole-table scans of a character poll Stop, counted by the
//! interrupt hooks: in its own test binary, since the counts are
//! process-wide and the crate's other tests would add theirs.

use sagebrush_modsym::general::Character;

/// The whole-table scans of a character poll Stop once an element at
/// least: the closure walk of from_generators, minimal and is_trivial
/// (and from_exponents' check), so a Stop raised during them is seen
/// within one element's work.
#[test]
fn table_scans_poll() {
    use sagebrush_interrupt::hooks;
    let n = 1009u64; // prime; 11 generates (Z/n)^*
    let count = |f: &dyn Fn()| {
        hooks::reset();
        f();
        hooks::total()
    };
    let chi = Character::from_generators(n, n - 1, &[11], &[1]).unwrap();
    assert_eq!(chi.order, n - 1);
    let all = count(&|| drop(Character::from_generators(n, n - 1, &[11], &[1]).unwrap()));
    let exps: Vec<u32> = (0..n).map(|x| chi.exponent(x as i64).unwrap_or(u32::MAX)).collect();
    let check = count(&|| drop(Character::from_exponents(n, chi.order, exps.clone()).unwrap()));
    let minimal = count(&|| drop(chi.minimal()));
    // from_exponents: its unit scan, its pairs' check and the exponents'
    // normalization, a check each
    assert!(check >= n * n + 2 * n, "from_exponents: {} checks", check);
    // the closure walk alone: a check per element and per generator
    assert!(all - check - minimal >= 2 * (n - 1), "walk: {} checks", all - check - minimal);
    // minimal's two scans, is_trivial's and the trivial table's
    assert!(minimal >= 2 * (n - 1), "minimal: {} checks", minimal);
    assert!(count(&|| assert!(Character::trivial(n).is_trivial())) >= 2 * n);
}
