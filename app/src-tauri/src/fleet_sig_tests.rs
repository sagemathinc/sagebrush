// fleet_sig against the shared vectors: tests/fleet-fixtures.json is a byte-exact copy of the agent's
// test/fixtures/fleet-fixtures.json at sagebrush-agent main FIXTURES_COMMIT (built by its make-fleet-fixtures.mjs from
// schemas r2.3, sha256 db905c9d).  To update it, copy the file from a newer main and change both pins together.
use super::*;
use serde_json::json;

const FIXTURES: &str = include_str!("../tests/fleet-fixtures.json");
const FIXTURES_COMMIT: &str = "d0c632f7337906c2ad1d588fe6fbd3e0c27d34f7";
const FIXTURES_SHA256: &str = "560fe3fdbfe463bca22e60fe773928a716bb24f45cf0bfc91003c61442702d80";

fn fixtures() -> Value {
    serde_json::from_str(FIXTURES).unwrap()
}
fn hex(s: &str) -> Vec<u8> {
    (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap()).collect()
}
// (fixture bytes given as plain base64url of any length, padding stripped: a test helper, not the canonical decoder)
fn b64_any(s: &str) -> Vec<u8> {
    let mut out = Vec::new();
    let (mut acc, mut bits) = (0u32, 0u32);
    for c in s.bytes() {
        acc = acc << 6 | B64.iter().position(|&x| x == c).unwrap() as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
            acc &= (1 << bits) - 1;
        }
    }
    out
}

#[test]
fn the_fixtures_are_the_pinned_copy() {
    let got: String = Sha256::digest(FIXTURES.as_bytes()).iter().map(|b| format!("{b:02x}")).collect();
    assert_eq!(got, FIXTURES_SHA256, "tests/fleet-fixtures.json isn't sagebrush-agent {FIXTURES_COMMIT}'s");
    assert_eq!(fixtures()["freeze"], "db905c9d72ba5d4e18620d3267ea9214992d3a82c735289dda4088970dddc7e3");
}

#[test]
fn canonical_cases() {
    let f = fixtures();
    let cases = f["canonical"].as_array().unwrap();
    assert_eq!(cases.len(), 17);
    for c in cases {
        let bytes = b64_any(c["bytes_b64"].as_str().unwrap());
        let got = match parse_canonical(&bytes, SIGNED_MAX) {
            Ok(_) => "ok",
            Err(r) => r.code(),
        };
        assert_eq!(got, c["expect"], "{}", c["name"]);
    }
}

#[test]
fn ed25519_cases() {
    let f = fixtures();
    let cases = f["ed25519"].as_array().unwrap();
    assert_eq!(cases.len(), 6);
    for c in cases {
        let public = b64_any(c["public"].as_str().unwrap());
        let sig = b64_any(c["sig"].as_str().unwrap());
        let msg = b64_any(c["msg_b64"].as_str().unwrap());
        assert_eq!(verify_strict(&public, &msg, &sig), c["expect"].as_bool().unwrap(), "{}", c["name"]);
    }
}

#[test]
fn base64url_cases() {
    let f = fixtures();
    let cases = f["base64url"].as_array().unwrap();
    assert_eq!(cases.len(), 8);
    for c in cases {
        let len = c["len"].as_u64().unwrap() as usize;
        let got = match unb64(c["value"].as_str().unwrap(), len) {
            Ok(b) => {
                assert_eq!(b64(&b), c["value"].as_str().unwrap(), "{}", c["name"]);
                "ok"
            }
            Err(r) => r.code(),
        };
        assert_eq!(got, c["expect"], "{}", c["name"]);
    }
}

#[test]
fn id_cases() {
    let f = fixtures();
    for c in f["ids_cases"].as_array().unwrap() {
        assert_eq!(is_id(c["value"].as_str().unwrap()), c["expect"] == "ok", "{}", c["value"]);
    }
    for (name, id) in f["ids"].as_object().unwrap() {
        assert!(is_id(id.as_str().unwrap()), "{name}");
    }
}

#[test]
fn keys_from_seeds_give_the_fixture_public_keys_and_ids() {
    let f = fixtures();
    let keys = f["keys"].as_object().unwrap();
    assert_eq!(keys.len(), 10);
    for (name, k) in keys {
        let seed: [u8; 32] = hex(k["seed"].as_str().unwrap()).try_into().unwrap();
        let raw = SigningKey::from_bytes(&seed).verifying_key().to_bytes();
        assert_eq!(b64(&raw), k["public"], "{name}");
        assert_eq!(key_id(&raw), k["key_id"], "{name}");
        assert!(public_key_ok(&raw), "{name}");
    }
}

/// Every envelope the fixtures hold, as text.
fn envelopes(f: &Value) -> Vec<String> {
    let o = &f["objects"];
    let mut out: Vec<String> = Vec::new();
    for s in o["chain"].as_array().unwrap().iter().chain(f["service_keys"]["chain"].as_array().unwrap()) {
        out.push(s.as_str().unwrap().into());
    }
    out.push(o["host_cert"].as_str().unwrap().into());
    for group in ["envelopes", "approvals", "grants", "host_ops"] {
        for c in o[group].as_array().unwrap() {
            out.push(c["bytes"].as_str().unwrap().into());
        }
    }
    out
}

#[test]
fn sealing_reproduces_every_honestly_signed_device_envelope_byte_for_byte() {
    let f = fixtures();
    let mut seeds = std::collections::HashMap::new();
    for k in f["keys"].as_object().unwrap().values() {
        let seed: [u8; 32] = hex(k["seed"].as_str().unwrap()).try_into().unwrap();
        seeds.insert(k["key_id"].as_str().unwrap().to_string(), SigningKey::from_bytes(&seed));
    }
    let (mut resealed, mut tampered) = (0, 0);
    for text in envelopes(&f) {
        let env = parse_canonical(text.as_bytes(), SIGNED_MAX).expect("every fixture envelope is canonical");
        let (ty, signer, body) = (env["type"].as_str().unwrap(), &env["signer"], &env["body"]);
        let Some(key) = seeds.get(signer["key"].as_str().unwrap()) else { continue };
        let sig = unb64(env["sig"].as_str().unwrap(), 64).unwrap();
        let honest = verify_strict(&key.verifying_key().to_bytes(), &signed_bytes(ty, signer, body).unwrap(), &sig);
        let device_sealable = signer["kind"] == "device" && env.get("sig2").is_none() && DEVICE_TYPES.contains(&ty);
        if !device_sealable {
            assert!(seal(ty, signer, body, key).is_err(), "only device envelopes are sealed here: {ty}");
            continue;
        }
        // (an envelope with another field, though its signature is honest, isn't what seal makes)
        let exact = env.as_object().unwrap().len() == 5;
        if honest && exact {
            assert_eq!(String::from_utf8(seal(ty, signer, body, key).unwrap()).unwrap(), text, "{ty}");
            resealed += 1;
        } else {
            assert_ne!(String::from_utf8(seal(ty, signer, body, key).unwrap()).unwrap(), text);
            tampered += 1;
        }
    }
    // (the chain's device entries, the host certificate, the approvals, grants and host ops; and the tampered rows)
    assert!(resealed >= 20, "resealed {resealed}");
    assert!(tampered >= 1, "tampered {tampered}");
}

#[test]
fn seal_refuses_a_signer_that_isn_t_the_key_s_own_device_block() {
    let f = fixtures();
    let k = &f["keys"]["device-native"];
    let seed: [u8; 32] = hex(k["seed"].as_str().unwrap()).try_into().unwrap();
    let key = SigningKey::from_bytes(&seed);
    let raw = key.verifying_key().to_bytes();
    let id = f["ids"]["device_native"].as_str().unwrap();
    let signer = device_signer(id, &raw).unwrap();
    let body = json!({ "aud": "https://dev.sagebrush.space", "fleet": f["ids"]["fleet"] });
    assert!(seal("sb.host-op.v1", &signer, &body, &key).is_ok());
    // (another key's id; another kind; an extra field; a bad id; a type no device signs; a chain "add"; a body that isn't an object)
    let other = device_signer(id, &SigningKey::from_bytes(&[7; 32]).verifying_key().to_bytes()).unwrap();
    assert_eq!(seal("sb.host-op.v1", &other, &body, &key), Err(Refusal::BadForm));
    let mut host = signer.clone();
    host["kind"] = json!("host");
    assert_eq!(seal("sb.host-op.v1", &host, &body, &key), Err(Refusal::BadForm));
    let mut extra = signer.clone();
    extra["x"] = json!(1);
    assert_eq!(seal("sb.host-op.v1", &extra, &body, &key), Err(Refusal::BadForm));
    assert_eq!(device_signer("not-an-id", &raw), Err(Refusal::BadForm));
    for ty in ["sb.grant-ack.v1", "sb.audit-event.v1", "sb.audit-ack.v1", "sb.nope.v1"] {
        assert_eq!(seal(ty, &signer, &body, &key), Err(Refusal::BadForm), "{ty}");
    }
    assert_eq!(seal("sb.device-chain.v1", &signer, &json!({ "op": "add" }), &key), Err(Refusal::BadForm));
    assert_eq!(seal("sb.host-op.v1", &signer, &json!([1]), &key), Err(Refusal::BadForm));
}

#[test]
fn canon_rules_and_bounds() {
    // (sorted by UTF-16 code units; escapes as ES2019 JSON.stringify; nothing else escaped)
    assert_eq!(canon(&json!({"b": 1, "a": [true, null, "x"]}), SIGNED_MAX).unwrap(), r#"{"a":[true,null,"x"],"b":1}"#);
    assert_eq!(canon(&json!({"\u{ffff}": 1, "\u{1f600}": 2}), SIGNED_MAX).unwrap(), "{\"\u{1f600}\":2,\"\u{ffff}\":1}");
    assert_eq!(canon(&json!("\"\\\u{8}\t\n\u{c}\r\u{1}\u{1f}\u{7f}é/"), SIGNED_MAX).unwrap(), "\"\\\"\\\\\\b\\t\\n\\f\\r\\u0001\\u001f\u{7f}é/\"");
    // (safe integers only)
    assert!(canon(&json!(9007199254740991u64), SIGNED_MAX).is_ok());
    assert!(canon(&json!(-9007199254740991i64), SIGNED_MAX).is_ok());
    assert_eq!(canon(&json!(9007199254740992u64), SIGNED_MAX), Err(Refusal::BadForm));
    assert_eq!(canon(&json!(-9007199254740992i64), SIGNED_MAX), Err(Refusal::BadForm));
    assert_eq!(canon(&json!(1.5), SIGNED_MAX), Err(Refusal::BadForm));
    assert_eq!(parse_canonical(b"-0", SIGNED_MAX), Err(Refusal::BadForm));
    // (depth: 32 nested arrays are allowed, 33 aren't, as the agent's canonText)
    let mut v = json!(0);
    for _ in 0..32 {
        v = json!([v]);
    }
    assert!(canon(&v, SIGNED_MAX).is_ok());
    assert_eq!(canon(&json!([v]), SIGNED_MAX), Err(Refusal::BadForm));
    // (size: at most max bytes of output; a received text over max is refused before it is parsed)
    let s = json!("a".repeat(SIGNED_MAX - 2));
    assert_eq!(canon(&s, SIGNED_MAX).unwrap().len(), SIGNED_MAX);
    assert_eq!(canon(&json!("a".repeat(SIGNED_MAX - 1)), SIGNED_MAX), Err(Refusal::Limit));
    assert_eq!(parse_canonical(&vec![b' '; SIGNED_MAX + 1], SIGNED_MAX), Err(Refusal::Limit));
}

#[test]
fn strict_verification_refuses_every_malleable_or_weak_form() {
    let key = SigningKey::from_bytes(&[9; 32]);
    let raw = key.verifying_key().to_bytes();
    let sig = key.sign(b"m").to_bytes();
    assert!(verify_strict(&raw, b"m", &sig));
    assert!(!verify_strict(&raw, b"n", &sig));
    assert!(!verify_strict(&raw[..31], b"m", &sig));
    assert!(!verify_strict(&raw, b"m", &sig[..63]));
    // (S + L: the same signature, another spelling)
    let mut s_plus_l = sig;
    let mut carry = 0u16;
    for i in 0..32 {
        let t = s_plus_l[32 + i] as u16 + L[i] as u16 + carry;
        s_plus_l[32 + i] = t as u8;
        carry = t >> 8;
    }
    assert!(!verify_strict(&raw, b"m", &s_plus_l));
    // (the small-order points, under either sign bit, aren't keys; nor are non-canonical encodings)
    let mut identity = [0u8; 32];
    identity[0] = 1;
    assert!(!public_key_ok(&identity));
    let mut neg_zero = identity;
    neg_zero[31] |= 0x80;
    assert!(!canonical_point(&neg_zero));
    let mut y_is_p = P;
    assert!(!canonical_point(&y_is_p));
    y_is_p[0] = 0xec;
    assert!(canonical_point(&y_is_p));
    assert!(!public_key_ok(&[0u8; 32]));
}

#[test]
fn base64url_round_trips_and_refuses_other_spellings() {
    for len in [16usize, 32, 64] {
        let b: Vec<u8> = (0..len as u8).map(|i| i.wrapping_mul(37).wrapping_add(11)).collect();
        assert_eq!(unb64(&b64(&b), len).unwrap(), b);
    }
    assert_eq!(unb64(&b64(&[0; 32]), 16), Err(Refusal::BadForm));
    assert_eq!(unb64(&format!("{}=", b64(&[0; 32])), 32), Err(Refusal::BadForm));
    assert_eq!(unb64(&b64(&[0; 32]).replace('A', "+"), 32), Err(Refusal::BadForm));
}
