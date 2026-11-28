// Fleet protocol signing, in Rust (Autonomous agents: schemas r2.3 §1.1-1.4; N1 part 2).  The desktop app signs for
// the person in Rust, so Rust builds the exact bytes it signs.  This is a second implementation of the agent's
// lib/fleet (bytes.mjs, canonical.mjs, ed25519.mjs, envelope.mjs), checked case by case against the shared vectors,
// tests/fleet-fixtures.json (a byte-exact copy, pinned below), so the two can't drift apart silently.
//   - canon(): the canonical JSON text of a value (sorted keys by UTF-16 code units, safe integers only, no
//     whitespace, ES2019 JSON.stringify string escapes), bounded in bytes and depth.
//   - parse_canonical(): received bytes, accepted only if they are exactly canon of what they parse to.
//   - b64 / unb64: base64url, canonical only (no padding, zero pad bits, exact lengths).
//   - key_id(), signed_bytes(), seal(): the key id, the bytes a signer signs and the sealed envelope.
//   - verify_strict(): §1.4's rules checked here, before ed25519-dalek's own verify_strict is asked.
// Nothing here touches a key store; device_key.rs holds the key.
use ed25519_dalek::{Signature, Signer, SigningKey, VerifyingKey};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

pub const SIGNED_MAX: usize = 64 * 1024;
pub const SIGNED_DEPTH: usize = 32;
const SAFE_MAX: u64 = (1u64 << 53) - 1;

/// Why a value or bytes were refused; the codes are the agent's schema/fleet/reasons.json names.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Refusal {
    BadForm,
    Limit,
    BadSignature,
}

impl Refusal {
    pub fn code(self) -> &'static str {
        match self {
            Refusal::BadForm => "bad_form",
            Refusal::Limit => "limit",
            Refusal::BadSignature => "bad_signature",
        }
    }
}

// ---- canonical JSON

fn push_string(out: &mut String, s: &str) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{8}' => out.push_str("\\b"),
            '\t' => out.push_str("\\t"),
            '\n' => out.push_str("\\n"),
            '\u{c}' => out.push_str("\\f"),
            '\r' => out.push_str("\\r"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
}

fn walk(v: &Value, depth: usize, out: &mut String, max: usize) -> Result<(), Refusal> {
    if out.len() > max {
        return Err(Refusal::Limit);
    }
    match v {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Number(n) => {
            // (safe integers only: no float, no -0, |n| <= 2^53 - 1)
            if let Some(u) = n.as_u64() {
                if u > SAFE_MAX {
                    return Err(Refusal::BadForm);
                }
                out.push_str(&u.to_string());
            } else if let Some(i) = n.as_i64() {
                if i.unsigned_abs() > SAFE_MAX {
                    return Err(Refusal::BadForm);
                }
                out.push_str(&i.to_string());
            } else {
                return Err(Refusal::BadForm);
            }
        }
        Value::String(s) => push_string(out, s),
        Value::Array(a) => {
            if depth >= SIGNED_DEPTH {
                return Err(Refusal::BadForm);
            }
            out.push('[');
            for (i, x) in a.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                walk(x, depth + 1, out, max)?;
            }
            out.push(']');
        }
        Value::Object(o) => {
            if depth >= SIGNED_DEPTH {
                return Err(Refusal::BadForm);
            }
            // (keys sorted by UTF-16 code units, as JavaScript's default sort: an astral character sorts before U+FFFF)
            let mut keys: Vec<&String> = o.keys().collect();
            keys.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
            out.push('{');
            for (i, k) in keys.into_iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                push_string(out, k);
                out.push(':');
                walk(&o[k], depth + 1, out, max)?;
            }
            out.push('}');
        }
    }
    if out.len() > max {
        return Err(Refusal::Limit);
    }
    Ok(())
}

/// The canonical text of a value, at most `max` bytes.  (Rust strings hold no lone surrogates, so none can appear.)
pub fn canon(v: &Value, max: usize) -> Result<String, Refusal> {
    let mut out = String::new();
    walk(v, 0, &mut out, max)?;
    Ok(out)
}

/// Received bytes that must be canonical: UTF-8 with no byte-order mark, JSON, and byte-identical to canon of what they
/// parse to (so duplicate keys, escapes of plain characters, whitespace and floats are all refused).
pub fn parse_canonical(bytes: &[u8], max: usize) -> Result<Value, Refusal> {
    if bytes.len() > max {
        return Err(Refusal::Limit);
    }
    let text = std::str::from_utf8(bytes).map_err(|_| Refusal::BadForm)?;
    if text.starts_with('\u{feff}') {
        return Err(Refusal::BadForm);
    }
    let v: Value = serde_json::from_str(text).map_err(|_| Refusal::BadForm)?;
    if canon(&v, max)? != text {
        return Err(Refusal::BadForm);
    }
    Ok(v)
}

// ---- base64url, canonical

const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

pub fn b64(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for c in bytes.chunks(3) {
        let n = (c[0] as u32) << 16 | (*c.get(1).unwrap_or(&0) as u32) << 8 | *c.get(2).unwrap_or(&0) as u32;
        for i in 0..=c.len() {
            out.push(B64[(n >> (18 - 6 * i) & 63) as usize] as char);
        }
    }
    out
}

/// The exact encoded length of each binary length the protocol uses.
fn b64_len(len: usize) -> Option<usize> {
    match len {
        16 => Some(22),
        32 => Some(43),
        64 => Some(86),
        _ => None,
    }
}

/// Decode base64url only if it is the one canonical spelling of `len` bytes.
pub fn unb64(s: &str, len: usize) -> Result<Vec<u8>, Refusal> {
    if Some(s.len()) != b64_len(len) {
        return Err(Refusal::BadForm);
    }
    let mut out = Vec::with_capacity(len);
    let (mut acc, mut bits) = (0u32, 0u32);
    for c in s.bytes() {
        let d = B64.iter().position(|&x| x == c).ok_or(Refusal::BadForm)? as u32;
        acc = acc << 6 | d;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
            acc &= (1 << bits) - 1;
        }
    }
    // (the unused low bits of the last character must be zero: otherwise another spelling of the same bytes)
    if acc != 0 || out.len() != len {
        return Err(Refusal::BadForm);
    }
    Ok(out)
}

// ---- Ed25519, strict (§1.4)

/// p = 2^255 - 19, little-endian.
const P: [u8; 32] = {
    let mut p = [0xffu8; 32];
    p[0] = 0xed;
    p[31] = 0x7f;
    p
};
/// The group order L, little-endian.
const L: [u8; 32] = [
    0xed, 0xd3, 0xf5, 0x5c, 0x1a, 0x63, 0x12, 0x58, 0xd6, 0x9c, 0xf7, 0xa2, 0xde, 0xf9, 0xde, 0x14, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0x10,
];

/// a < b, both little-endian.
fn lt(a: &[u8; 32], b: &[u8; 32]) -> bool {
    for i in (0..32).rev() {
        if a[i] != b[i] {
            return a[i] < b[i];
        }
    }
    false
}

/// A canonical point encoding: y < p, and no sign bit where x is 0 (y = 1 or y = p - 1).
pub fn canonical_point(b: &[u8; 32]) -> bool {
    let sign = b[31] >> 7;
    let mut y = *b;
    y[31] &= 0x7f;
    if !lt(&y, &P) {
        return false;
    }
    let mut one = [0u8; 32];
    one[0] = 1;
    let mut pm1 = P;
    pm1[0] = 0xec;
    !(sign == 1 && (y == one || y == pm1))
}

/// A public key the protocol accepts: canonical, a point on the curve, and not of small order.
pub fn public_key_ok(raw: &[u8; 32]) -> bool {
    canonical_point(raw) && VerifyingKey::from_bytes(raw).is_ok_and(|k| !k.is_weak())
}

/// Strict verification; true or false, never a panic on any bytes.
pub fn verify_strict(raw: &[u8], msg: &[u8], sig: &[u8]) -> bool {
    let (Ok(raw), Ok(sig)) = (<[u8; 32]>::try_from(raw), <[u8; 64]>::try_from(sig)) else { return false };
    if !public_key_ok(&raw) {
        return false;
    }
    let r: [u8; 32] = sig[..32].try_into().unwrap();
    let s: [u8; 32] = sig[32..].try_into().unwrap();
    if !canonical_point(&r) || !lt(&s, &L) {
        return false;
    }
    let Ok(key) = VerifyingKey::from_bytes(&raw) else { return false };
    key.verify_strict(msg, &Signature::from_bytes(&sig)).is_ok()
}

/// The key id of a public key: base64url of the first 16 bytes of SHA-256("sagebrush.key.v1\ned25519\n" + key).
pub fn key_id(raw: &[u8; 32]) -> String {
    let mut h = Sha256::new();
    h.update(b"sagebrush.key.v1\ned25519\n");
    h.update(raw);
    b64(&h.finalize()[..16])
}

// ---- envelopes (§1.3)

/// The types a device signs.  (The device-chain "add" carries a second signature, sig2, and comes with enrollment.)
pub const DEVICE_TYPES: [&str; 8] = [
    "sb.device-chain.v1",
    "sb.host-cert.v1",
    "sb.host-grant.v1",
    "sb.host-op.v1",
    "sb.revocation.v1",
    "sb.approval.v1",
    "sb.sealed-package.v1",
    "sb.browser-session.v1",
];

/// An id (§1.1): 26 lowercase base32 characters, the last one carrying two zero bits.
pub fn is_id(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 26
        && b[..25].iter().all(|c| c.is_ascii_lowercase() || (b'2'..=b'7').contains(c))
        && b"aeimquy4".contains(&b[25])
}

/// The signer block of a device key.
pub fn device_signer(device_id: &str, raw: &[u8; 32]) -> Result<Value, Refusal> {
    if !is_id(device_id) {
        return Err(Refusal::BadForm);
    }
    Ok(serde_json::json!({ "kind": "device", "id": device_id, "alg": "ed25519", "key": key_id(raw) }))
}

/// The bytes a signer signs: "sagebrush.sig.v1\n" + type + "\n" + canon(signer) + "\n" + canon(body).
pub fn signed_bytes(ty: &str, signer: &Value, body: &Value) -> Result<Vec<u8>, Refusal> {
    Ok(format!("sagebrush.sig.v1\n{ty}\n{}\n{}", canon(signer, SIGNED_MAX)?, canon(body, SIGNED_MAX)?).into_bytes())
}

fn check_device_signer(ty: &str, signer: &Value, body: &Value) -> Result<(), Refusal> {
    if !DEVICE_TYPES.contains(&ty) {
        return Err(Refusal::BadForm);
    }
    if ty == "sb.device-chain.v1" && body.get("op").and_then(Value::as_str) == Some("add") {
        return Err(Refusal::BadForm);
    }
    let o: &Map<String, Value> = signer.as_object().ok_or(Refusal::BadForm)?;
    let mut keys: Vec<&str> = o.keys().map(String::as_str).collect();
    keys.sort_unstable();
    if keys != ["alg", "id", "key", "kind"] || o["kind"] != "device" || o["alg"] != "ed25519" {
        return Err(Refusal::BadForm);
    }
    if !o["id"].as_str().is_some_and(is_id) || !o["key"].as_str().is_some_and(|k| unb64(k, 16).is_ok()) {
        return Err(Refusal::BadForm);
    }
    if !body.is_object() {
        return Err(Refusal::BadForm);
    }
    Ok(())
}

/// Seal a body with a device key: the envelope's canonical bytes.  The signer block must be the key's own.
pub fn seal(ty: &str, signer: &Value, body: &Value, key: &SigningKey) -> Result<Vec<u8>, Refusal> {
    check_device_signer(ty, signer, body)?;
    if signer["key"] != key_id(&key.verifying_key().to_bytes()).as_str() {
        return Err(Refusal::BadForm);
    }
    let msg = signed_bytes(ty, signer, body)?;
    let sig = key.sign(&msg).to_bytes();
    let env = serde_json::json!({ "v": 1, "type": ty, "signer": signer, "body": body, "sig": b64(&sig) });
    Ok(canon(&env, SIGNED_MAX)?.into_bytes())
}

#[cfg(test)]
#[path = "fleet_sig_tests.rs"]
mod tests;
