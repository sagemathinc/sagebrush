// The device key (Autonomous agents, app pairing r4's native tier; N1 part 2): one Ed25519 key per installed app,
// made in Rust from the OS's CSPRNG and kept in the OS keychain.  Its private half never crosses IPC: Rust signs
// (fleet_sig::seal) and only the public key and signatures leave this module.
//   - Storage: the macOS Keychain (the `keyring` crate, its apple-native store only), a generic password item under
//     SERVICE / ACCOUNT holding the 32-byte seed.  Windows (DPAPI) comes with Windows signing; elsewhere there is no
//     store, so no key is ever made where it couldn't be kept.
//   - A stored item that isn't exactly 32 bytes, or a read that fails, is refused: never replaced by a new key, which
//     would silently be another device.  The only way to a new key is "Reset this device" (reset()).
//   - Enrollment as `native` is allowed only in a signed build (native_tier()): a build-time flag the signed release
//     job sets, and on macOS two runtime checks under the pinned team's requirement: the running code (dynamic), and
//     the whole bundle on disk (static: every architecture, nested code and every sealed resource, strictly), since
//     the dynamic check covers only what establishes the code's identity, not every resource the signer trusts.
//     Anything else, Linux included, enrolls as `browser` tier.
//   - The gate runs again immediately before the signer window is made (signer.rs) and, in part 3, at every native
//     signing command: a failed or changed validation refuses native signing.
// The signer's commands (enrollment, signing typed approvals) come with the pending list, N1 part 3.
use ed25519_dalek::SigningKey;
use zeroize::Zeroizing;

pub const SERVICE: &str = "space.sagebrush.app.device-key";
pub const ACCOUNT: &str = "device";

/// Where the seed is kept.  The app's is the keychain; tests use an in-memory one.
pub trait SeedStore {
    /// The stored seed, None if there is none; an error for a failed read or an item of the wrong size.
    fn load(&self) -> Result<Option<Zeroizing<[u8; 32]>>, String>;
    fn save(&self, seed: &[u8; 32]) -> Result<(), String>;
    /// Delete the stored seed (no error if there is none).
    fn delete(&self) -> Result<(), String>;
}

/// The device key: the stored one, or a new one made and stored (only if none is stored).  A new key is read back
/// from the store before it is used, so a key that wasn't kept is never used.
pub fn load_or_create(store: &dyn SeedStore) -> Result<SigningKey, String> {
    if let Some(seed) = store.load()? {
        return Ok(SigningKey::from_bytes(&seed));
    }
    let mut seed = Zeroizing::new([0u8; 32]);
    getrandom::fill(&mut seed[..]).map_err(|e| format!("no randomness: {e}"))?;
    store.save(&seed)?;
    match store.load()? {
        Some(back) if *back == *seed => Ok(SigningKey::from_bytes(&back)),
        _ => Err("the device key wasn't kept".into()),
    }
}

/// "Reset this device": delete the key, so the next one made is a new device (enrolled again, F2/F4).
pub fn reset(store: &dyn SeedStore) -> Result<(), String> {
    store.delete()
}

fn seed_of(bytes: &[u8]) -> Result<Zeroizing<[u8; 32]>, String> {
    let seed: [u8; 32] = bytes.try_into().map_err(|_| "the stored device key isn't a key".to_string())?;
    Ok(Zeroizing::new(seed))
}

/// The macOS Keychain.
#[cfg(target_os = "macos")]
pub struct Keychain {
    pub service: &'static str,
    pub account: &'static str,
}

#[cfg(target_os = "macos")]
impl Keychain {
    fn entry(&self) -> Result<keyring::Entry, String> {
        keyring::Entry::new(self.service, self.account).map_err(|e| format!("the keychain: {e}"))
    }
}

#[cfg(target_os = "macos")]
impl SeedStore for Keychain {
    fn load(&self) -> Result<Option<Zeroizing<[u8; 32]>>, String> {
        match self.entry()?.get_secret() {
            Ok(v) => seed_of(&Zeroizing::new(v)).map(Some),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(format!("the keychain: {e}")),
        }
    }
    fn save(&self, seed: &[u8; 32]) -> Result<(), String> {
        self.entry()?.set_secret(seed).map_err(|e| format!("the keychain: {e}"))
    }
    fn delete(&self) -> Result<(), String> {
        match self.entry()?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(format!("the keychain: {e}")),
        }
    }
}

/// The app's key store, where there is one.
#[cfg(target_os = "macos")]
pub fn app_store() -> Option<Keychain> {
    Some(Keychain { service: SERVICE, account: ACCOUNT })
}
#[cfg(not(target_os = "macos"))]
pub fn app_store() -> Option<std::convert::Infallible> {
    None
}

/// The signing team, from the signed release job (a 10-character Apple team id), or None in any other build.
fn signed_team() -> Option<&'static str> {
    let team = option_env!("SAGEBRUSH_TEAM_ID")?;
    let signed = option_env!("SAGEBRUSH_SIGNED_BUILD") == Some("1");
    (signed && team.len() == 10 && team.bytes().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit())).then_some(team)
}

/// Whether this app may enroll as `native`: a signed build whose running code, and whole bundle, check as its team's.
pub fn native_tier() -> Result<(), &'static str> {
    let Some(team) = signed_team() else { return Err("not a signed build") };
    code_signed_by(team)
}

#[cfg(target_os = "macos")]
fn code_signed_by(team: &str) -> Result<(), &'static str> {
    use security_framework::os::macos::code_signing::{Flags, SecCode, SecRequirement, SecStaticCode};
    let req: SecRequirement = format!("anchor apple generic and certificate leaf[subject.OU] = \"{team}\"")
        .parse()
        .map_err(|_| "the code requirement didn't parse")?;
    // (the running code: SecCodeCheckValidity)
    let me = SecCode::for_self(Flags::NONE).map_err(|_| "this app's code couldn't be found")?;
    me.check_validity(Flags::NONE, &req).map_err(|_| "this app isn't signed by its team")?;
    // (the bundle it was loaded from, in full: SecStaticCodeCheckValidity with no resource-skipping or basic-only flag)
    let path = me.path(Flags::NONE).map_err(|_| "this app's bundle couldn't be found")?;
    let bundle = SecStaticCode::from_path(&path, Flags::NONE).map_err(|_| "this app's bundle couldn't be read")?;
    bundle.check_validity(STATIC_FLAGS, &req).map_err(|_| "this app's bundle isn't intact and signed by its team")
}

/// The static validation's flags: every architecture, nested code, strict; never DO_NOT_VALIDATE_RESOURCES,
/// DO_NOT_VALIDATE_EXECUTABLE, BASIC_VALIDATE_ONLY or QUICK_CHECK.
#[cfg(target_os = "macos")]
const STATIC_FLAGS: security_framework::os::macos::code_signing::Flags = security_framework::os::macos::code_signing::Flags::CHECK_ALL_ARCHITECTURES
    .union(security_framework::os::macos::code_signing::Flags::CHECK_NESTED_CODE)
    .union(security_framework::os::macos::code_signing::Flags::STRICT_VALIDATE);

/// The self-test's tier probe (SAGEBRUSH_APP_SELFTEST with SAGEBRUSH_APP_TIER_PROBE): one line on stderr, then exit,
/// before any window.  The signed release job runs it on copies of the signed app, intact and with one sealed resource
/// changed.
pub fn tier_probe() {
    if std::env::var_os("SAGEBRUSH_APP_SELFTEST").is_none() || std::env::var_os("SAGEBRUSH_APP_TIER_PROBE").is_none() {
        return;
    }
    match native_tier() {
        Ok(()) => eprintln!("[tier] native: yes"),
        Err(why) => eprintln!("[tier] native: no ({why})"),
    }
    std::process::exit(0);
}
#[cfg(not(target_os = "macos"))]
fn code_signed_by(_team: &str) -> Result<(), &'static str> {
    Err("only signed macOS builds enroll as native")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    #[derive(Default)]
    struct Mem {
        item: RefCell<Option<Vec<u8>>>,
        fail_read: bool,
        drop_writes: bool,
    }
    impl SeedStore for Mem {
        fn load(&self) -> Result<Option<Zeroizing<[u8; 32]>>, String> {
            if self.fail_read {
                return Err("read failed".into());
            }
            self.item.borrow().as_deref().map(seed_of).transpose()
        }
        fn save(&self, seed: &[u8; 32]) -> Result<(), String> {
            if !self.drop_writes {
                *self.item.borrow_mut() = Some(seed.to_vec());
            }
            Ok(())
        }
        fn delete(&self) -> Result<(), String> {
            *self.item.borrow_mut() = None;
            Ok(())
        }
    }

    #[test]
    fn one_key_made_once_then_the_same_key() {
        let m = Mem::default();
        let a = load_or_create(&m).unwrap();
        let b = load_or_create(&m).unwrap();
        assert_eq!(a.to_bytes(), b.to_bytes());
        assert_ne!(a.to_bytes(), [0u8; 32]);
        assert!(crate::fleet_sig::public_key_ok(&a.verifying_key().to_bytes()));
    }

    #[test]
    fn reset_makes_the_next_key_a_new_one() {
        let m = Mem::default();
        let a = load_or_create(&m).unwrap();
        reset(&m).unwrap();
        reset(&m).unwrap();
        assert_ne!(a.to_bytes(), load_or_create(&m).unwrap().to_bytes());
    }

    #[test]
    fn a_bad_item_or_a_failed_read_is_refused_never_replaced() {
        for bad in [vec![], vec![1u8; 31], vec![1u8; 33], vec![1u8; 64]] {
            let m = Mem { item: RefCell::new(Some(bad.clone())), ..Default::default() };
            assert!(load_or_create(&m).is_err(), "{}", bad.len());
            assert_eq!(m.item.borrow().as_deref(), Some(&bad[..]), "the item is left as it was");
        }
        let m = Mem { fail_read: true, ..Default::default() };
        assert!(load_or_create(&m).is_err());
        assert!(m.item.borrow().is_none(), "nothing was written");
    }

    #[test]
    fn a_key_that_wasn_t_kept_isn_t_used() {
        let m = Mem { drop_writes: true, ..Default::default() };
        assert_eq!(load_or_create(&m).unwrap_err(), "the device key wasn't kept");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn the_static_check_asks_for_every_resource_and_the_code_check_refuses_another_team() {
        use security_framework::os::macos::code_signing::Flags;
        assert!(STATIC_FLAGS.contains(Flags::CHECK_ALL_ARCHITECTURES | Flags::CHECK_NESTED_CODE | Flags::STRICT_VALIDATE));
        for skip in [Flags::DO_NOT_VALIDATE_RESOURCES, Flags::DO_NOT_VALIDATE_EXECUTABLE, Flags::BASIC_VALIDATE_ONLY, Flags::QUICK_CHECK] {
            assert!(!STATIC_FLAGS.intersects(skip));
        }
        // (this test binary is at most ad hoc signed: no team's requirement holds for it)
        assert!(code_signed_by("ABCDE12345").is_err());
    }

    #[test]
    fn a_build_without_the_signed_flag_is_browser_tier() {
        // (cargo test builds are never the signed release job's)
        if option_env!("SAGEBRUSH_SIGNED_BUILD").is_none() {
            assert_eq!(signed_team(), None);
            assert_eq!(native_tier(), Err("not a signed build"));
        }
    }
}
