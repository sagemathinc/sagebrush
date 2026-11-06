// ES256 (ECDSA on P-256 with SHA-256) for the remote runner (design remote-v1 §3, r1.7): the page's DPoP
// proofs are verified here, with RustCrypto's p256, not in Python.  JOSE only (RFC 7518 §3.4): a public key is
// its two 32-byte affine coordinates, a signature is 64 bytes r || s; no DER, no other curve or algorithm.
// Every refusal is `false`: wrong lengths, a point not on the curve (or the identity), r or s zero or >= n, a
// signature that doesn't verify.  The work is bounded by the caller's caps on the message (the proof's signing
// input, at most a few KiB), and the inputs are public, so nothing here needs constant time.
use p256::ecdsa::signature::{Signer, Verifier};
use p256::ecdsa::{Signature, SigningKey, VerifyingKey};
use pyo3::prelude::*;
use pyo3::types::PyBytes;

/// The public key (x, y), if it is one: SEC1 uncompressed (0x04 || x || y), whose parse refuses a point off the
/// curve, the identity and coordinates >= p.
fn key(x: &[u8], y: &[u8]) -> Option<VerifyingKey> {
    if x.len() != 32 || y.len() != 32 {
        return None;
    }
    let mut sec1 = [0u8; 65];
    sec1[0] = 4;
    sec1[1..33].copy_from_slice(x);
    sec1[33..].copy_from_slice(y);
    VerifyingKey::from_sec1_bytes(&sec1).ok()
}

pub fn verify(x: &[u8], y: &[u8], message: &[u8], signature: &[u8]) -> bool {
    if signature.len() != 64 {
        return false;
    }
    let Some(key) = key(x, y) else { return false };
    let Ok(sig) = Signature::from_slice(signature) else { return false };
    key.verify(message, &sig).is_ok()
}

/// `es256_verify(x, y, message, signature) -> bool`: x, y the key's coordinates (32 bytes each), signature 64
/// bytes r || s over `message` (SHA-256 inside).
#[pyfunction(name = "es256_verify")]
fn es256_verify_py(x: &[u8], y: &[u8], message: &[u8], signature: &[u8]) -> bool {
    verify(x, y, message, signature)
}

/// `es256_key_ok(x, y) -> bool`: (x, y) is a P-256 public key (on the curve, not the identity).
#[pyfunction(name = "es256_key_ok")]
fn es256_key_ok_py(x: &[u8], y: &[u8]) -> bool {
    key(x, y).is_some()
}

// ---- the runner's own key (design remote-v1 §3; astra's r1.4 ruling: signing in p256, never in
// Python).  The secret scalar d is 32 bytes the caller drew from the OS (os.urandom); a value that isn't a
// valid scalar (0 or >= n) is refused, and the caller draws again.  Signing is RFC 6979 (deterministic nonces,
// p256's default): no randomness, and no nonce arithmetic, outside this crate.

fn signing_key(d: &[u8]) -> Option<SigningKey> {
    if d.len() != 32 {
        return None;
    }
    SigningKey::from_slice(d).ok()
}

/// `es256_public(d) -> (x, y) | None`: the public key of the secret scalar d (32 bytes), as its two
/// 32-byte coordinates, or None if d isn't a valid scalar.
#[pyfunction(name = "es256_public")]
fn es256_public_py(py: Python<'_>, d: &[u8]) -> Option<(Py<PyBytes>, Py<PyBytes>)> {
    let k = signing_key(d)?;
    let p = k.verifying_key().to_encoded_point(false);
    let (x, y) = (p.x()?, p.y()?);
    Some((PyBytes::new(py, x).unbind(), PyBytes::new(py, y).unbind()))
}

/// `es256_sign(d, message) -> bytes | None`: ES256 over message (SHA-256 inside), 64 bytes r || s
/// (JOSE), with the secret scalar d; None if d isn't a valid scalar.
#[pyfunction(name = "es256_sign")]
fn es256_sign_py(py: Python<'_>, d: &[u8], message: &[u8]) -> Option<Py<PyBytes>> {
    let k = signing_key(d)?;
    let sig: Signature = k.sign(message);
    Some(PyBytes::new(py, &sig.to_bytes()).unbind())
}

pub fn register(m: &Bound<'_, PyModule>) -> PyResult<()> {
    let remote = PyModule::new(m.py(), "remote")?;
    remote.add_function(wrap_pyfunction!(es256_verify_py, &remote)?)?;
    remote.add_function(wrap_pyfunction!(es256_key_ok_py, &remote)?)?;
    remote.add_function(wrap_pyfunction!(es256_public_py, &remote)?)?;
    remote.add_function(wrap_pyfunction!(es256_sign_py, &remote)?)?;
    m.add_submodule(&remote)
}
