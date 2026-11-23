// browser_frames against the sidecars' own codec: tests/browser-frames-vectors.json is lib/fleet/browser/frames.mjs
// (the agent repo at VECTORS_COMMIT, the file at FRAMES_SHA256) run over every case by
// tests/make-browser-frames-vectors.mjs.  To update it, rerun the generator on a newer agent checkout and change both
// pins together.
use super::*;
use serde_json::json;

const VECTORS: &str = include_str!("../tests/browser-frames-vectors.json");
const VECTORS_COMMIT: &str = "b95a4c97b2798c4f9d56cfe47598d9f60574bbe2";
const FRAMES_SHA256: &str = "12564cfdf8ba626eee6316cdbff5e24e32ab68415e0cab5734054c49edd4bced";

fn b64(s: &str) -> Vec<u8> {
    const A: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let (mut out, mut acc, mut bits) = (Vec::new(), 0u32, 0u32);
    for c in s.bytes().filter(|&c| c != b'=') {
        acc = acc << 6 | A.iter().position(|&x| x == c).unwrap() as u32;
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
fn the_vectors_are_the_pinned_codec_s() {
    let v: Value = serde_json::from_str(VECTORS).unwrap();
    assert_eq!(v["agent_commit"], VECTORS_COMMIT);
    assert_eq!(v["frames_sha256"], FRAMES_SHA256);
    assert_eq!(v["limits"]["headBytes"], HEAD_MAX as u64);
    assert_eq!(v["limits"]["totalBytes"], TOTAL_MAX as u64);
    assert_eq!(v["limits"]["idBytes"], ID_MAX as u64);
    assert_eq!(v["limits"]["reasonBytes"], REASON_MAX as u64);
    assert_eq!(v["limits"]["urlBytes"], URL_MAX as u64);
    assert_eq!(v["limits"]["credentialBytes"], CREDENTIAL_MAX as u64);
}

#[test]
fn every_vector_decodes_as_the_sidecars_codec_decodes_it() {
    let v: Value = serde_json::from_str(VECTORS).unwrap();
    let cases = v["cases"].as_array().unwrap();
    assert!(cases.len() >= 200, "{}", cases.len());
    let mut disagree = Vec::new();
    for c in cases {
        let to = Party::from_name(c["to"].as_str().unwrap()).unwrap();
        let from = c["from"].as_str().map(|f| Party::from_name(f).unwrap());
        let mut d = Decoder::to(to, from);
        let got = d.push(&b64(c["bytes_b64"].as_str().unwrap())).and_then(|frames| d.end().map(|_| frames));
        let (code, kinds) = match got {
            Ok(frames) => ("ok", frames.iter().map(|f| f.kind).collect::<Vec<_>>()),
            Err(e) => (e.code(), vec![]),
        };
        let want_kinds: Vec<&str> = c["kinds"].as_array().unwrap().iter().map(|k| k.as_str().unwrap()).collect();
        if code != c["expect"] || kinds != want_kinds {
            disagree.push(format!("{}: rust {code} {kinds:?}, js {} {want_kinds:?}", c["name"], c["expect"]));
        }
    }
    assert!(disagree.is_empty(), "{} of {} disagree:\n{}", disagree.len(), cases.len(), disagree.join("\n"));
}

#[test]
fn rust_reads_a_sidecar_s_output_whichever_party_it_addresses_but_not_itself() {
    // (the cdp sidecar's output: to Rust, or to net through Rust; never to cdp)
    let cdp = |head: Value, body: &[u8]| {
        let h = canon(&head, HEAD_MAX).unwrap().into_bytes();
        let mut out = ((4 + h.len() + body.len()) as u32).to_be_bytes().to_vec();
        out.extend_from_slice(&(h.len() as u32).to_be_bytes());
        out.extend_from_slice(&h);
        out.extend_from_slice(body);
        out
    };
    let mut d = Decoder::from_sidecar(Party::Cdp);
    let a = cdp(json!({"to": "rust", "kind": "rust.cdp_state", "state": "ready"}), b"");
    let b = cdp(json!({"to": "net", "kind": "net.result", "seq": 3}), b"{\"result\":{}}");
    let frames = d.push(&[a.clone(), b.clone()].concat()).unwrap();
    assert_eq!(frames.iter().map(|f| (f.kind, f.to)).collect::<Vec<_>>(), vec![("rust.cdp_state", Party::Rust), ("net.result", Party::Net)]);
    assert_eq!(frames[1].bytes, b, "a forwarded frame is its exact bytes");
    // (a kind cdp doesn't send, even one addressed to Rust; and anything to cdp itself)
    for bad in [
        json!({"to": "rust", "kind": "rust.net_hello", "app_session_pub": "k", "proxy_port": 50000, "proxy_username": "u", "proxy_password": "p"}),
        json!({"to": "cdp", "kind": "cdp.retire"}),
        json!({"to": "cdp", "kind": "cdp.command", "seq": 1}),
    ] {
        assert_eq!(Decoder::from_sidecar(Party::Cdp).push(&cdp(bad.clone(), b"")).unwrap_err(), FrameError::Route, "{bad}");
    }
    // (and net's output likewise)
    let mut n = Decoder::from_sidecar(Party::Net);
    let c = cdp(json!({"to": "cdp", "kind": "cdp.command", "seq": 1}), b"{}");
    assert_eq!(n.push(&c).unwrap()[0].to, Party::Cdp);
    assert_eq!(Decoder::from_sidecar(Party::Net).push(&cdp(json!({"to": "net", "kind": "net.retire"}), b"")).unwrap_err(), FrameError::Route);
}

#[test]
fn rust_encodes_only_its_own_kinds_canonically() {
    let f = encode(Party::Rust, &json!({"to": "cdp", "kind": "cdp.proxy_auth", "username": "u", "password": "p", "proxy_port": 50000}), b"").unwrap();
    let frames = Decoder::to(Party::Cdp, Some(Party::Rust)).push(&f).unwrap();
    assert_eq!(frames[0].kind, "cdp.proxy_auth");
    assert_eq!(&f[8..], br#"{"kind":"cdp.proxy_auth","password":"p","proxy_port":50000,"to":"cdp","username":"u"}"#);
    let rec = encode(Party::Rust, &json!({"to": "net", "kind": "net.record"}), b"signed").unwrap();
    assert_eq!(Decoder::to(Party::Net, Some(Party::Rust)).push(&rec).unwrap()[0].body, b"signed");
    for (head, body, e) in [
        (json!({"to": "rust", "kind": "rust.cdp_state", "state": "ready"}), &b""[..], FrameError::Route),
        (json!({"to": "net", "kind": "net.result", "seq": 1}), &b"{}"[..], FrameError::Route),
        (json!({"to": "cdp", "kind": "cdp.start", "chrome_pid": 0}), &b""[..], FrameError::Schema),
        (json!({"to": "cdp", "kind": "cdp.retire"}), &b"x"[..], FrameError::Body),
        (json!({"to": "cdp", "kind": "cdp.nope"}), &b""[..], FrameError::Kind),
        (json!([1]), &b""[..], FrameError::Head),
    ] {
        assert_eq!(encode(Party::Rust, &head, body).unwrap_err(), e, "{head}");
    }
}

#[test]
fn a_decoder_is_dead_after_an_error_and_lengths_are_checked_first() {
    let mut d = Decoder::to(Party::Cdp, None);
    assert_eq!(d.push(&((TOTAL_MAX + 1) as u32).to_be_bytes()).unwrap_err(), FrameError::Oversize);
    assert_eq!(d.push(b"").unwrap_err(), FrameError::Dead);
    assert_eq!(d.end().unwrap_err(), FrameError::Dead);
    let mut e = Decoder::to(Party::Cdp, None);
    assert!(e.push(&((TOTAL_MAX) as u32).to_be_bytes()).unwrap().is_empty(), "at the limit: waits for the rest");
}

#[test]
fn js_whitespace_is_javascript_s_not_rust_s() {
    for c in ['\u{feff}', '\u{a0}', '\u{2028}', '\u{3000}', ' ', '\t'] {
        assert!(js_space(c), "{c:?}");
    }
    assert!(!js_space('\u{85}') && '\u{85}'.is_whitespace(), "U+0085 is Rust's, not JavaScript's");
    assert!(js_space('\u{feff}') && !'\u{feff}'.is_whitespace(), "U+FEFF is JavaScript's, not Rust's");
    assert!(!js_space('\u{180e}'));
}
