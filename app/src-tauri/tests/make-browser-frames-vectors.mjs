// The browser lane's frame vectors for the app's Rust router (src/browser_frames.rs): every case decoded by the
// sidecars' own codec, lib/fleet/browser/frames.mjs in the sagebrush-agent repo, so the two implementations agree
// case by case. Writes tests/browser-frames-vectors.json beside this file.
//
//   node app/src-tauri/tests/make-browser-frames-vectors.mjs <sagebrush-agent checkout>
//
// The vector file records the agent commit and frames.mjs's sha256; src/browser_frames_tests.rs pins both.

import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

const agent = process.argv[2];
if (!agent) throw new Error("usage: make-browser-frames-vectors.mjs <sagebrush-agent checkout>");
const framesPath = join(agent, "lib/fleet/browser/frames.mjs");
const { createEncoder, createDecoder, FrameError, KINDS, LIMITS } = await import(framesPath);
const commit = execFileSync("git", ["-C", agent, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const sha256 = createHash("sha256").update(readFileSync(framesPath)).digest("hex");

const SAMPLE = {
  "net.start": { session: "s-1", browser_gen: 3, host_static_pub: "x".repeat(43), relay_url: "wss://relay.example/s" },
  "net.record": {}, "net.policy": { exceptions: [] }, "net.takeover": { reason: "the person took over" }, "net.resume": {}, "net.retire": { reason: "done" },
  "rust.net_hello": { app_session_pub: "k".repeat(43), proxy_port: 50123, proxy_username: "u1", proxy_password: "p".repeat(128) },
  "rust.net_state": { state: "open" },
  "cdp.start": { chrome_pid: 4242 }, "cdp.proxy_auth": { username: "u1", password: "pw", proxy_port: 50123 },
  "cdp.takeover": {}, "cdp.resume": {}, "cdp.retire": { reason: "budget spent" },
  "rust.cdp_state": { state: "ended", reason: "pipe ended" }, "rust.takeover_done": {}, "rust.takeover_failed": { reason: "drain timed out" },
  "cdp.command": { seq: 0 }, "net.result": { seq: 9007199254740991 }, "net.event": {}, "net.refused": { seq: 7, reason: "takeover" },
};
const to = (kind) => kind.split(".")[0];
const head = (kind, extra = {}) => ({ to: to(kind), kind, ...SAMPLE[kind], ...extra });
const canonical = (o) => JSON.stringify(Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : 1))));
function raw(h, body = Buffer.alloc(0), { total, headLen } = {}) {
  const hb = Buffer.from(typeof h === "string" ? h : canonical(h), "utf8");
  const out = Buffer.alloc(8 + hb.length + body.length);
  out.writeUInt32BE(total ?? 4 + hb.length + body.length, 0);
  out.writeUInt32BE(headLen ?? hb.length, 4);
  hb.copy(out, 8);
  Buffer.from(body).copy(out, 8 + hb.length);
  return out;
}

const cases = [];
/** Decode `bytes` as `to` would (from `from`, if given), and record what the sidecars' codec says. */
function add(name, bytes, recv, from) {
  let expect, frames = [];
  try {
    const d = createDecoder(from ? { to: recv, from } : { to: recv });
    frames = d.push(bytes);
    d.end();
    expect = "ok";
  } catch (e) {
    if (!(e instanceof FrameError)) throw e;
    expect = e.code;
  }
  cases.push({ name, to: recv, from: from ?? null, bytes_b64: Buffer.from(bytes).toString("base64"), expect, kinds: expect === "ok" ? frames.map((f) => f.head.kind) : [] });
}

// Every kind, from its sender, decoded with and without the sender named; and from every other party.
for (const [kind, k] of Object.entries(KINDS)) {
  const body = k.body ? Buffer.from(kind === "net.result" ? '{"result":{}}' : `{"x":"${kind}"}`) : Buffer.alloc(0);
  const bytes = createEncoder({ from: k.from })(head(kind), body);
  add(`${kind}: from its sender`, bytes, to(kind), k.from);
  add(`${kind}: sender unnamed`, bytes, to(kind));
  for (const other of ["rust", "cdp", "net"]) if (other !== k.from && other !== to(kind)) add(`${kind}: from ${other}`, bytes, to(kind), other);
  add(`${kind}: to the wrong party`, raw(head(kind)), to(kind) === "rust" ? "cdp" : "rust");
  add(`${kind}: an extra field`, raw(head(kind, { extra: 1 })), to(kind));
  for (const f of Object.keys(k.fields)) { const h = head(kind); delete h[f]; add(`${kind}: without ${f}`, raw(h), to(kind)); }
  add(`${kind}: a body`, raw(head(kind), Buffer.from("x")), to(kind));
}
// Bounds, at and past each cap.
const bounds = [
  ["net.start", { session: "" }], ["net.start", { session: "s".repeat(64) }], ["net.start", { session: "s".repeat(65) }], ["net.start", { session: "é".repeat(32) }], ["net.start", { session: "é".repeat(33) }],
  ["net.start", { browser_gen: -1 }], ["net.start", { browser_gen: 0 }],
  ["net.start", { relay_url: "ws://relay.example/" }], ["net.start", { relay_url: "https://relay.example/" }], ["net.start", { relay_url: "wss://" }],
  ["net.start", { relay_url: "wss://" + "r".repeat(2042) }], ["net.start", { relay_url: "wss://" + "r".repeat(2043) }],
  ["net.start", { relay_url: "wss://a b" }], ["net.start", { relay_url: "wss://a b" }], ["net.start", { relay_url: "wss://a\u0085b" }], ["net.start", { relay_url: "wss://a﻿b" }],
  ["net.start", { relay_url: "wss://a b" }], ["net.start", { relay_url: "wss://a᠎b" }], ["net.start", { relay_url: 5 }],
  ["net.policy", { exceptions: ["10.0.0.0/8"] }], ["net.policy", { exceptions: {} }],
  ["rust.net_hello", { proxy_port: 1023 }], ["rust.net_hello", { proxy_port: 1024 }], ["rust.net_hello", { proxy_port: 65535 }], ["rust.net_hello", { proxy_port: 65536 }], ["rust.net_hello", { proxy_port: "50000" }],
  ["rust.net_hello", { proxy_password: "" }], ["rust.net_hello", { proxy_password: "p".repeat(129) }],
  ["rust.net_state", { state: "closed" }], ["rust.net_state", { state: "resuming" }], ["rust.net_state", { reason: "r".repeat(256) }], ["rust.net_state", { reason: "r".repeat(257) }], ["rust.net_state", { reason: "" }],
  ["cdp.start", { chrome_pid: 0 }], ["cdp.start", { chrome_pid: 2 ** 31 - 1 }], ["cdp.start", { chrome_pid: 2 ** 31 }], ["cdp.start", { chrome_pid: true }],
  ["cdp.proxy_auth", { proxy_port: 1023 }], ["cdp.proxy_auth", { username: null }],
  ["rust.cdp_state", { state: "READY" }], ["cdp.takeover", { reason: 1 }],
  ["cdp.command", { seq: -1 }], ["cdp.command", { seq: 9007199254740991 }], ["net.result", { seq: "1" }],
  ["net.refused", { reason: "filter" }], ["net.refused", { reason: "credits" }], ["net.refused", { reason: "bad" }],
  ["net.refused", { reason: "abandoned" }], ["net.refused", { reason: "takeover" }], ["net.refused", { reason: "ABANDONED" }], ["net.refused", { reason: "unknown" }],
];
for (const [kind, x] of bounds) add(`${kind}: ${JSON.stringify(x).slice(0, 60)}`, raw(head(kind, x)), to(kind));
// Framing and heads.
const len = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
const good = canonical(head("cdp.start"));
add("framing: total 5", len(5), "cdp");
add("framing: total 0", len(0), "cdp");
add("framing: total past the limit", len(LIMITS.totalBytes + 1), "cdp");
add("framing: total at the limit, unfinished", len(LIMITS.totalBytes), "cdp");
add("framing: head length 1", raw(good, undefined, { headLen: 1 }), "cdp");
add("framing: head length past the frame", raw(good, undefined, { headLen: good.length + 1 }), "cdp");
add("framing: head past 64 KiB", raw(good, Buffer.alloc(70000), { headLen: LIMITS.headBytes + 1 }), "cdp");
add("framing: truncated", raw(good).subarray(0, 12), "cdp");
add("framing: two frames", Buffer.concat([raw(good), raw(canonical(head("cdp.retire")))]), "cdp");
for (const [name, text] of [
  ["unsorted keys", JSON.stringify({ to: "cdp", kind: "cdp.start", chrome_pid: 1 })], ["whitespace", good.replace(",", ", ")],
  ["a duplicate key", '{"chrome_pid":1,"kind":"cdp.start","kind":"cdp.start","to":"cdp"}'], ["trailing bytes", good + " "],
  ["a byte-order mark", "﻿" + good], ["a float", '{"chrome_pid":1.0,"kind":"cdp.start","to":"cdp"}'],
  ["an escaped plain character", '{"chrome_pid":1,"kind":"cdp.st\\u0061rt","to":"cdp"}'], ["an array", "[1]"], ["a string", '"x"'],
  ["an unknown kind", canonical({ to: "cdp", kind: "cdp.open" })], ["a kind that is a prototype name", canonical({ to: "cdp", kind: "__proto__" })], ["no kind", canonical({ to: "cdp" })],
  ["keys by UTF-16 order (an astral key before U+FFFF)", '{"\u{1f600}":1,"￿":2,"kind":"cdp.start","to":"cdp"}'],
]) add(`head: ${name}`, raw(text), "cdp");
const inv = raw("{}"); inv[8] = 0xff;
add("head: invalid UTF-8", inv, "cdp");

const out = { $comment: "Frame vectors from the sagebrush-agent codec (lib/fleet/browser/frames.mjs), for the app's Rust router. Made by tests/make-browser-frames-vectors.mjs.", agent_commit: commit, frames_sha256: sha256, limits: LIMITS, cases };
writeFileSync(new URL("./browser-frames-vectors.json", import.meta.url), JSON.stringify(out, null, 1) + "\n");
console.log(`${cases.length} cases from ${commit} (frames.mjs ${sha256.slice(0, 8)}): ${Object.entries(cases.reduce((m, c) => ((m[c.expect] = (m[c.expect] ?? 0) + 1), m), {})).map(([k, v]) => `${k} ${v}`).join(", ")}`);
