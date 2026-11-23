// The browser lane's frames (browser-lane3-runtime.md sha256 8ef03f9c, "The two sidecars and their IPC" and SEC §1):
// the app's side of the codec the two sidecars share (lib/fleet/browser/frames.mjs in the agent repo). Rust is the
// only router between them, so it checks every frame against the same tables: exact framing, a canonical head
// (fleet_sig's canon, so no duplicate key, no whitespace, nothing after the value), one closed schema per kind on its
// one path (sender and receiver), the doc's caps, and a body only on the four kinds that carry one. It routes on the
// head alone (a body is never parsed, and never logged) and forwards a frame's exact bytes.
//
// tests/browser-frames-vectors.json is the sidecars' own codec run over every case (made by
// tests/make-browser-frames-vectors.mjs from a pinned agent commit); browser_frames_tests.rs requires this file to
// agree with every one.
use crate::fleet_sig::{canon, parse_canonical};
use serde_json::Value;

pub const HEAD_MAX: usize = 64 * 1024;
pub const TOTAL_MAX: usize = 64 * 1024 * 1024 + 64 * 1024;
const ID_MAX: usize = 64;
const REASON_MAX: usize = 256;
const URL_MAX: usize = 2048;
const CREDENTIAL_MAX: usize = 128;
const SAFE_MAX: u64 = (1 << 53) - 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Party {
    Rust,
    Cdp,
    Net,
}

impl Party {
    pub fn name(self) -> &'static str {
        match self {
            Party::Rust => "rust",
            Party::Cdp => "cdp",
            Party::Net => "net",
        }
    }
    pub fn from_name(s: &str) -> Option<Party> {
        match s {
            "rust" => Some(Party::Rust),
            "cdp" => Some(Party::Cdp),
            "net" => Some(Party::Net),
            _ => None,
        }
    }
}

/// A frame that breaks the rules; after one, a decoder is dead.  `code()` is the sidecars' codec's name for it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FrameError {
    Short,
    Oversize,
    Head,
    Kind,
    Route,
    Schema,
    Body,
    Truncated,
    Dead,
}

impl FrameError {
    pub fn code(self) -> &'static str {
        match self {
            FrameError::Short => "short",
            FrameError::Oversize => "oversize",
            FrameError::Head => "head",
            FrameError::Kind => "kind",
            FrameError::Route => "route",
            FrameError::Schema => "schema",
            FrameError::Body => "body",
            FrameError::Truncated => "truncated",
            FrameError::Dead => "dead",
        }
    }
}

#[derive(Debug, Clone, Copy)]
enum Check {
    Id,
    U64,
    Wss,
    NoExceptions,
    Port,
    Credential,
    Reason,
    NetState,
    CdpState,
    ChromePid,
    RefusedReason,
}

/// JavaScript's `\s`, exactly (the sidecars' codec checks relay_url with /^wss:\/\/[^\s]+$/): Rust's is_whitespace
/// differs (it has U+0085 and lacks U+FEFF).
fn js_space(c: char) -> bool {
    matches!(c, '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}')
}

fn string_within(v: &Value, max: usize) -> Option<&str> {
    v.as_str().filter(|s| !s.is_empty() && s.len() <= max)
}

impl Check {
    fn ok(self, v: &Value) -> bool {
        match self {
            Check::Id => string_within(v, ID_MAX).is_some(),
            Check::Reason => string_within(v, REASON_MAX).is_some(),
            Check::Credential => string_within(v, CREDENTIAL_MAX).is_some(),
            Check::U64 => v.as_u64().is_some_and(|n| n <= SAFE_MAX),
            Check::Port => v.as_u64().is_some_and(|n| (1024..=65535).contains(&n)),
            Check::ChromePid => v.as_u64().is_some_and(|n| (1..=0x7fff_ffff).contains(&n)),
            Check::Wss => string_within(v, URL_MAX).and_then(|s| s.strip_prefix("wss://")).is_some_and(|rest| !rest.is_empty() && !rest.chars().any(js_space)),
            Check::NoExceptions => v.as_array().is_some_and(|a| a.is_empty()),
            Check::NetState => matches!(v.as_str(), Some("connecting" | "open" | "resuming" | "ended")),
            Check::CdpState => matches!(v.as_str(), Some("starting" | "ready" | "paused" | "ended")),
            // (takeover and bad: not run; abandoned: sent to Chrome and abandoned by the takeover, so it may have run)
            Check::RefusedReason => matches!(v.as_str(), Some("takeover" | "bad" | "abandoned")),
        }
    }
}

pub struct Kind {
    pub name: &'static str,
    pub from: Party,
    fields: &'static [(&'static str, Check)],
    optional: &'static [(&'static str, Check)],
    pub body: bool,
}

const REASON: &[(&str, Check)] = &[("reason", Check::Reason)];
const NONE: &[(&str, Check)] = &[];
use Party::{Cdp, Net, Rust};

/// The doc's 20 kinds: each with one sender, one receiver (its prefix) and a closed schema.
pub const KINDS: &[Kind] = &[
    // Rust -> net
    Kind { name: "net.start", from: Rust, fields: &[("session", Check::Id), ("browser_gen", Check::U64), ("host_static_pub", Check::Id), ("relay_url", Check::Wss)], optional: NONE, body: false },
    Kind { name: "net.record", from: Rust, fields: NONE, optional: NONE, body: true },
    Kind { name: "net.policy", from: Rust, fields: &[("exceptions", Check::NoExceptions)], optional: NONE, body: false },
    Kind { name: "net.takeover", from: Rust, fields: NONE, optional: REASON, body: false },
    Kind { name: "net.resume", from: Rust, fields: NONE, optional: REASON, body: false },
    Kind { name: "net.retire", from: Rust, fields: NONE, optional: REASON, body: false },
    // net -> Rust
    Kind { name: "rust.net_hello", from: Net, fields: &[("app_session_pub", Check::Id), ("proxy_port", Check::Port), ("proxy_username", Check::Credential), ("proxy_password", Check::Credential)], optional: NONE, body: false },
    Kind { name: "rust.net_state", from: Net, fields: &[("state", Check::NetState)], optional: REASON, body: false },
    // Rust -> cdp
    Kind { name: "cdp.start", from: Rust, fields: &[("chrome_pid", Check::ChromePid)], optional: NONE, body: false },
    Kind { name: "cdp.proxy_auth", from: Rust, fields: &[("username", Check::Credential), ("password", Check::Credential), ("proxy_port", Check::Port)], optional: NONE, body: false },
    Kind { name: "cdp.takeover", from: Rust, fields: NONE, optional: REASON, body: false },
    Kind { name: "cdp.resume", from: Rust, fields: NONE, optional: REASON, body: false },
    Kind { name: "cdp.retire", from: Rust, fields: NONE, optional: REASON, body: false },
    // cdp -> Rust
    Kind { name: "rust.cdp_state", from: Cdp, fields: &[("state", Check::CdpState)], optional: REASON, body: false },
    Kind { name: "rust.takeover_done", from: Cdp, fields: NONE, optional: REASON, body: false },
    Kind { name: "rust.takeover_failed", from: Cdp, fields: NONE, optional: REASON, body: false },
    // net -> cdp, through Rust
    Kind { name: "cdp.command", from: Net, fields: &[("seq", Check::U64)], optional: NONE, body: true },
    // cdp -> net, through Rust
    Kind { name: "net.result", from: Cdp, fields: &[("seq", Check::U64)], optional: NONE, body: true },
    Kind { name: "net.event", from: Cdp, fields: NONE, optional: NONE, body: true },
    Kind { name: "net.refused", from: Cdp, fields: &[("seq", Check::U64), ("reason", Check::RefusedReason)], optional: NONE, body: false },
];

fn receiver(kind: &str) -> Option<Party> {
    kind.split_once('.').and_then(|(p, _)| Party::from_name(p))
}

/// Check a head against its kind's schema, in the sidecars' codec's order (the head, the kind, the path, the fields,
/// the body).  `from`: the sender, when the reader knows it; `to`: the receiver, or None for "whichever the kind
/// names, but not the sender" (Rust reading a sidecar's output).
pub fn check(head: &Value, body_len: usize, from: Option<Party>, to: Option<Party>) -> Result<&'static Kind, FrameError> {
    let o = head.as_object().ok_or(FrameError::Head)?;
    let name = o.get("kind").and_then(Value::as_str).ok_or(FrameError::Kind)?;
    let k = KINDS.iter().find(|k| k.name == name).ok_or(FrameError::Kind)?;
    let recv = receiver(name).ok_or(FrameError::Route)?;
    let to_ok = o.get("to").and_then(Value::as_str) == Some(recv.name());
    let path_ok = match (from, to) {
        (_, Some(t)) => t == recv,
        (Some(f), None) => f != recv,
        (None, None) => false,
    };
    if !to_ok || !path_ok || from.is_some_and(|f| f != k.from) {
        return Err(FrameError::Route);
    }
    for (key, v) in o {
        if key == "to" || key == "kind" {
            continue;
        }
        let c = k.fields.iter().chain(k.optional).find(|(n, _)| n == key).ok_or(FrameError::Schema)?;
        if !c.1.ok(v) {
            return Err(FrameError::Schema);
        }
    }
    if k.fields.iter().any(|(n, _)| !o.contains_key(*n)) {
        return Err(FrameError::Schema);
    }
    if body_len > 0 && !k.body {
        return Err(FrameError::Body);
    }
    Ok(k)
}

/// One decoded frame: its head, its body, and its exact bytes (what is forwarded).
#[derive(Debug, Clone)]
pub struct Frame {
    pub head: Value,
    pub kind: &'static str,
    pub to: Party,
    pub body: Vec<u8>,
    pub bytes: Vec<u8>,
}

/// An incremental decoder: push the reader's bytes, get the whole frames in order.  Every frame's length is checked
/// from its first 4 bytes; after any error the decoder is dead.
pub struct Decoder {
    from: Option<Party>,
    to: Option<Party>,
    buf: Vec<u8>,
    dead: bool,
}

impl Decoder {
    /// A party's reader of what Rust (or, through Rust, the other sidecar) sends it, as the sidecars read stdin.
    pub fn to(to: Party, from: Option<Party>) -> Decoder {
        Decoder { from, to: Some(to), buf: Vec::new(), dead: false }
    }
    /// Rust's reader of one sidecar's output: frames from it, to Rust or to the other sidecar.
    pub fn from_sidecar(from: Party) -> Decoder {
        Decoder { from: Some(from), to: None, buf: Vec::new(), dead: false }
    }

    pub fn push(&mut self, chunk: &[u8]) -> Result<Vec<Frame>, FrameError> {
        if self.dead {
            return Err(FrameError::Dead);
        }
        self.buf.extend_from_slice(chunk);
        let mut frames = Vec::new();
        loop {
            if self.buf.len() < 4 {
                break;
            }
            let total = u32::from_be_bytes(self.buf[..4].try_into().unwrap()) as usize;
            if total < 4 + 2 {
                return self.die(FrameError::Short);
            }
            if total > TOTAL_MAX {
                return self.die(FrameError::Oversize);
            }
            if self.buf.len() < 4 + total {
                break;
            }
            let bytes: Vec<u8> = self.buf.drain(..4 + total).collect();
            match self.parse(bytes) {
                Ok(f) => frames.push(f),
                Err(e) => return self.die(e),
            }
        }
        Ok(frames)
    }

    /// The stream ended: an error if it stopped inside a frame.
    pub fn end(&mut self) -> Result<(), FrameError> {
        if self.dead {
            return Err(FrameError::Dead);
        }
        if !self.buf.is_empty() {
            return self.die(FrameError::Truncated);
        }
        Ok(())
    }

    fn die<T>(&mut self, e: FrameError) -> Result<T, FrameError> {
        self.dead = true;
        self.buf = Vec::new();
        Err(e)
    }

    fn parse(&self, bytes: Vec<u8>) -> Result<Frame, FrameError> {
        let head_len = u32::from_be_bytes(bytes[4..8].try_into().unwrap()) as usize;
        if head_len < 2 || head_len > bytes.len() - 8 {
            return Err(FrameError::Short);
        }
        if head_len > HEAD_MAX {
            return Err(FrameError::Oversize);
        }
        let head = parse_canonical(&bytes[8..8 + head_len], HEAD_MAX).map_err(|_| FrameError::Head)?;
        let body = bytes[8 + head_len..].to_vec();
        let k = check(&head, body.len(), self.from, self.to)?;
        Ok(Frame { to: receiver(k.name).unwrap(), kind: k.name, head, body, bytes })
    }
}

/// Encode a frame Rust sends (`from` Rust), checked against its kind's schema; the head is canonical.
pub fn encode(from: Party, head: &Value, body: &[u8]) -> Result<Vec<u8>, FrameError> {
    let to = head.get("kind").and_then(Value::as_str).and_then(receiver);
    check(head, body.len(), Some(from), to.or(Some(from)))?;
    let h = canon(head, HEAD_MAX).map_err(|_| FrameError::Head)?.into_bytes();
    let total = 4 + h.len() + body.len();
    if total > TOTAL_MAX {
        return Err(FrameError::Oversize);
    }
    let mut out = Vec::with_capacity(4 + total);
    out.extend_from_slice(&(total as u32).to_be_bytes());
    out.extend_from_slice(&(h.len() as u32).to_be_bytes());
    out.extend_from_slice(&h);
    out.extend_from_slice(body);
    Ok(out)
}

#[cfg(test)]
#[path = "browser_frames_tests.rs"]
mod tests;
