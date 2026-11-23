// ci: web-runner order=374 runner=bun
// The log mirror's format (web/workspace/agent-chat/mirror-format.ts): what of an agent's log a page may mirror, in
// what shape; the summaries kept and left out; the canonical encoding; the Worker's validation of an upload (exactly
// what normalize() makes, nothing else); nesting scanned before parsing; and segments split at the caps.
//   bun web/workspace/agent-chat/test-mirror-format.mjs
const { normalize, entryOk, parseBody, depthOk, canonical, safeSummary, segments, MIRROR_CAPS } = await import("./mirror-format.ts");

const results = [];
const check = (ok, what, detail) => { results.push([!!ok, what]); if (!ok) console.log("FAIL", what, JSON.stringify(detail)?.slice(0, 500)); };
const ev = (seq, event, turn_id = "t1") => ({ seq, method: "turn.event", params: { conversation: "c", turn_id, event } });

// ---- normalize: each kept kind, its fields only
{
  const u = normalize({ seq: 4, method: "chat.message", params: { conversation: "c", author: "person", id: "u1", text: "hello", steer: true, extra: "x" } });
  check(canonical(u) === canonical({ k: "user", seq: 4, id: "u1", text: "hello", steer: true }), "a person's message: id, text, steer; nothing else", u);
  check(normalize({ seq: 4, method: "chat.message", params: { author: "agent", id: "u1", text: "x" } }) === null, "a message not from the person: left out");
  check(canonical(normalize(ev(5, { type: "tool_call_finished", call: "c1", status: "ok", duration_ms: 3, summary: "Read notes.md", body: "B", diff: { path: "/p" } }))) ===
    canonical({ k: "tool_finished", seq: 5, turn: "t1", call: "c1", status: "ok", duration_ms: 3, summary: "Read notes.md" }), "a finished call: name, status, duration and its safe summary; no body, no diff");
  check(canonical(normalize(ev(6, { type: "attention", id: "a", kind: "egress", state: "denied", title: "Allow example.com", detail: "D", instance: "I" }))) ===
    canonical({ k: "approval", seq: 6, turn: "t1", id: "a", kind: "egress", state: "denied", title: "Allow example.com" }), "an approval: its outcome and title; no detail, no page token");
  check(canonical(normalize(ev(7, { type: "artifact", id: "x", kind: "code", title: "Plot", body: "B", path: "/home/u/p.py", lang: "py" }))) ===
    canonical({ k: "artifact", seq: 7, turn: "t1", id: "x", kind: "code", title: "Plot" }), "an artifact: kind, title, id; no body, no path");
  check(canonical(normalize(ev(8, { type: "turn_error", code: "rate_limited", message: "stack..." }))) === canonical({ k: "turn_error", seq: 8, turn: "t1", code: "rate_limited" }), "an error: its code, never its message");
  for (const type of ["thinking_delta", "tool_output", "turn_usage", "turn_state", "something_new"])
    check(normalize(ev(9, { type, text: "x", usage: {}, state: "x" })) === null, `${type}: left out`);
  check(normalize({ seq: 9, method: "chat.unknown", params: {} }) === null && normalize({ seq: 0, method: "chat.rejected", params: { id: "x" } }) === null, "an unknown method, or a number below 1: left out");
  check(normalize({ seq: 10, method: "turn.event", params: { conversation: "c", omitted: { at_least: 262144 } } }) === null, "the agent's stub for an oversized entry: left out");
  // (agent memory v1, §7.4: no note's text, name or id reaches the mirror; none of its events is kept)
  const SENTINEL = "MEMORY-SENTINEL-7f3";
  for (const event of [
    { type: "memory_proposal", pending: "a".repeat(32), revision: 1, op: "new", scope: "own", name: "sentinel-name", description: SENTINEL, body: SENTINEL, expires: null },
    { type: "memory_decided", pending: "a".repeat(32), outcome: "saved", note: "b".repeat(32) },
    { type: "memory_used", notes: [{ note: "b".repeat(32), name: "sentinel-name", revision: 1 }] },
  ]) check(normalize(ev(11, event)) === null, `${event.type}: left out (no note text, name or id in the mirror)`);
}

// ---- safe summaries
{
  for (const s of ["Read notes.md", "Run npm test", "Fetch https://example.com/docs/page", "Edit web/workspace/agent-chat/view.ts", "Search: fourier series"])
    check(safeSummary(s) === s, `kept: ${s}`);
  for (const s of ["Read /home/user/.ssh/id_rsa", "Run ls ~/secrets/x", "Open C:\\Users\\me\\x", "Fetch https://user:pw@example.com/", "Fetch https://example.com/a?token=abc", "Fetch https://example.com/a#frag",
    "Authorization: Bearer abcdefghijklmn", "cookie=abc", "-----BEGIN RSA PRIVATE KEY-----", "token ghp_abcdefghijklmnopqrstuvwxyz0123456789", "data " + "A".repeat(48), "x".repeat(201), "a\u0000b"])
    check(safeSummary(s) === undefined, `left out: ${s.slice(0, 40)}`);
  check(safeSummary("  Read\n  notes.md ") === "Read notes.md", "whitespace folded to one line");
}

// ---- entryOk: exactly normalize's shapes
{
  const good = { k: "tool_started", n: 1, seq: 3, turn: "t", call: "c", tool: "mcp__sagebrush__web_fetch", summary: "Fetch https://example.com/" };
  check(entryOk(good), "a normalized entry passes");
  check(!entryOk({ ...good, verified: true }) && !entryOk({ ...good, summary: "Read /etc/passwd" }) && !entryOk({ ...good, summary: " padded" }) && !entryOk({ ...good, n: 0 }) && !entryOk({ ...good, tool: "a b" }),
    "an extra field, an unsafe or unnormalized summary, a position below 1, a bad tool name: refused");
  check(!entryOk({ k: "user", n: 1, seq: 1, id: "u", text: "x", steer: false }) && !entryOk({ k: "receipt", n: 1, seq: 1, id: "u", state: "delivered", reason: "bogus" }), "an optional field with a value normalize never makes: refused");
  check(!entryOk({ k: "user", n: 1, seq: 1, id: "u", text: "x".repeat(MIRROR_CAPS.text + 1) }) && entryOk({ k: "user", n: 1, seq: 1, id: "u", text: "x".repeat(MIRROR_CAPS.text) }), "text at the cap passes; one more is refused");
  check(!entryOk({ k: "user", n: 1, seq: 1, id: "u", text: "\ud800" }), "a lone surrogate is refused");
}

// ---- parseBody and depthOk
{
  const b = (entries, extra = {}) => JSON.stringify({ schema: 1, allowlist: 1, log_instance: "abc", entries, ...extra });
  const u = (n, seq) => ({ k: "user", n, seq, id: "u" + n, text: "t" });
  const ok1 = parseBody(b([u(4, 10), u(5, 17), u(6, 30)]));
  check(ok1.range && ok1.range.first_n === 4 && ok1.range.last_n === 6 && ok1.range.first_seq === 10 && ok1.range.last_seq === 30, "a body: its range from its entries", ok1);
  check(parseBody(b([u(4, 10), u(6, 17)])).error === "order" && parseBody(b([u(4, 10), u(5, 10)])).error === "order", "positions must be contiguous; agent numbers must rise");
  check(parseBody(b([u(1, 1)], { verified: true })).error === "fields" && parseBody(b([])).error === "entries" && parseBody(b([u(1, 1)], { schema: 2 })).error === "schema", "extra top-level fields, no entries, another schema: refused");
  check(depthOk('{"a":[{"b":1}]}', 3) && !depthOk('{"a":[{"b":[1]}]}', 3) && depthOk('{"a":"[[[[[["}', 1), "nesting is scanned, strings aside");
  check(parseBody("[".repeat(100000)).error === "nesting", "a deeply nested body is refused before it is parsed");
}

// ---- canonical and segments
{
  check(canonical({ b: 1, a: [true, null, "x"], c: undefined }) === '{"a":[true,null,"x"],"b":1}', "canonical: keys sorted, undefined left out, no whitespace");
  let threw = false;
  try { canonical({ a: 1.5 }); } catch { threw = true; }
  check(threw, "canonical: a non-integer number throws");
  const drafts = Array.from({ length: 2500 }, (_, i) => ({ k: "user", seq: 10 + 2 * i, id: "u" + i, text: "t" }));
  const { bodies, stuck } = segments("abc", 7, drafts);
  check(!stuck && bodies.length === 2 && bodies[0].entries.length === MIRROR_CAPS.entries && bodies[0].entries[0].n === 7 && bodies[1].entries.at(-1).n === 7 + 2499, "segments: split at the entry cap, positions continuing", bodies.map((x) => x.entries.length));
  const big = Array.from({ length: 3 }, (_, i) => ({ k: "user", seq: i + 1, id: "u" + i, text: "y".repeat(120 * 1024) }));
  const s2 = segments("abc", 1, big);
  check(!s2.stuck && s2.bodies.length === 2 && s2.bodies.every((x) => new TextEncoder().encode(canonical(x)).length <= MIRROR_CAPS.segmentBytes), "segments: split at the byte cap");
  check(s2.bodies.every((x) => parseBody(JSON.stringify(x)).range), "every segment it makes passes the Worker's check");
}

const failed = results.filter(([ok]) => !ok).length;
console.log(`${results.length - failed}/${results.length} mirror format tests passed`);
process.exit(failed ? 1 : 0);
