// What build.rs refuses to build (K1): a signed build with the self-test's controls.  The self-test's controls, each
// leaving one guard out (lib.rs SELFTEST_CONTROLS, the cargo feature selftest-controls), are for the self-test's
// unsigned build only; a build that is told it is signed (SAGEBRUSH_SIGNED_BUILD, or a team id) may never have them, by
// hand or in CI.  Shared by build.rs and the app's tests.

/// Why this build may not be made, or None: `controls` (the feature is on), the signed-build flag and the team ids as
/// the environment gives them (unset or empty: not given).
pub fn refusal(controls: bool, signed_build: Option<&str>, team_ids: &[Option<&str>]) -> Option<&'static str> {
    let given = |v: &Option<&str>| v.is_some_and(|s| !s.is_empty());
    let signed = given(&signed_build) || team_ids.iter().any(given);
    (controls && signed).then_some("a signed build (SAGEBRUSH_SIGNED_BUILD or a team id set) can't have the self-test's controls (the cargo feature selftest-controls)")
}

#[cfg(test)]
mod tests {
    use super::refusal;

    #[test]
    fn a_signed_build_with_the_controls_is_refused() {
        // (the controls with any sign of a signed build: refused)
        for (signed, teams) in [(Some("1"), [None, None]), (Some("yes"), [None, None]), (None, [Some("ABCDE12345"), None]), (None, [None, Some("ABCDE12345")]), (Some("1"), [Some("ABCDE12345"), Some("ABCDE12345")])] {
            assert!(refusal(true, signed, &teams).is_some(), "{signed:?} {teams:?}");
        }
        // (the controls alone, the self-test's build: made; empty values are unset)
        assert_eq!(refusal(true, None, &[None, None]), None);
        assert_eq!(refusal(true, Some(""), &[Some(""), None]), None);
        // (a signed build without them, or any other build: made)
        assert_eq!(refusal(false, Some("1"), &[Some("ABCDE12345"), Some("ABCDE12345")]), None);
        assert_eq!(refusal(false, None, &[None, None]), None);
    }
}
