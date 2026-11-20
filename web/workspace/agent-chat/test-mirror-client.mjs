// ci: web-runner order=374 runner=bun
// The log mirror's page side (web/workspace/agent-chat/mirror.ts, M2 design r4), headless: the uploader reading the
// agent's log through tagged replays, the reader and the reconcile, against a fake agent and an in-memory fake of the
// site's mirror routes (the real Worker is test-mirror-page.mjs's).
//   bun web/workspace/agent-chat/test-mirror-client.mjs
const { Mirror, MIRROR_TAG } = await import("./mirror.ts");
const { normalize, canonical } = await import("./mirror-format.ts");

const results = [];
const check = (ok, what, detail) => { results.push([!!ok, what]); if (!ok) console.log("FAIL", what, JSON.stringify(detail)?.slice(0, 600)); };
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const settle = async () => { for (let i = 0; i < 20; i++) await tick(); };

/** A fake agent: a log per conversation, in one run; it answers chat.resume as the agent does (the tag given back). */
function agent({ instance = "aaaaaaaa11", features = ["chat.resume", "chat.resume.tag"], chunk = 0 } = {}) {
  const a = {
    state: "granted", hello: { agent: { name: "Claude" }, features, log: { instance } }, sent: [], logs: new Map(), seq: 0, mirror: null, quiet: false, dropped: new Map(), chunk,
    log(conversation, method, params) { a.seq++; const l = a.logs.get(conversation) ?? []; l.push({ seq: a.seq, method, params: { conversation, ...params } }); a.logs.set(conversation, l); return a.seq; },
    notify(m, params) {
      a.sent.push([m, params]);
      if (m !== "chat.resume" || a.quiet) return true;
      // (as lib/log.mjs: entries dropped at its bounds are gone; asking from before them says reset)
      const drop = a.dropped.get(params.conversation) ?? 0;
      const all = (a.logs.get(params.conversation) ?? []).filter((e) => e.seq > params.after && e.seq > drop);
      const last = (a.logs.get(params.conversation) ?? []).at(-1)?.seq ?? 0;
      const reset = params.after < drop;
      const events = a.chunk ? all.slice(0, a.chunk) : all;
      const done = events.length === all.length;
      setTimeout(() => a.mirror?.onReplay({ conversation: params.conversation, instance: a.hello.log.instance, last, running: [], events, done, ...(reset ? { reset: true } : {}), ...(params.tag !== undefined ? { tag: params.tag } : {}) }, a), 0);
      return true;
    },
    notifyWhy(m, p) { return a.notify(m, p) ? "ok" : "full"; },
  };
  return a;
}

/** The site's mirror routes, in memory, with the Worker's answers for each case the uploader meets. */
function site({ quota = 1e9, on = true } = {}) {
  const s = { on, quota, bytes: 0, convs: new Map(), csrf: "tok", calls: [], missing: new Set(), staleCalls: [], made: 0 };
  const res = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const conv = (locator) => [...s.convs.values()].find((c) => c.locator === locator);
  s.fetch = async (path, init = {}) => {
    const m = init.method ?? "GET";
    s.calls.push([m, path]);
    if (s.failList && path === "/api/mirror/v1/conversations" && m === "GET") return res(503, { error: "busy" });
    if (m !== "GET" && init.headers?.["x-sb-mirror-csrf"] !== s.csrf) return res(403, { error: "forbidden" });
    if (path === "/api/mirror/v1/status") return res(200, { available: true, state: s.on ? "on" : "off", bytes: s.bytes, quota: s.quota, pending: 0, conversations: s.convs.size, csrf: s.csrf });
    if (path === "/api/mirror/v1/enable") { s.on = true; return res(200, { state: "on" }); }
    if (path === "/api/mirror/v1/disable") { s.on = false; s.convs.clear(); return res(200, { state: "off" }); }
    if (!s.on) return res(409, { error: "off" });
    if (path === "/api/mirror/v1/conversations" && m === "GET")
      return res(200, { conversations: [...s.convs.values()].map((c) => ({ conversation: c.conversation, locator: c.locator, mode: "B", streams: [...c.streams.entries()].map(([log_instance, st]) => ({ log_instance, next_n: st.next_n, last_seq: st.last_seq, last_digest: st.digest ?? "0".repeat(64), stale_from: st.stale_from, stale_reason: st.stale_reason })) })) });
    if (path === "/api/mirror/v1/conversations" && m === "POST") {
      const { conversation } = JSON.parse(init.body);
      if (!s.convs.has(conversation)) s.convs.set(conversation, { conversation, locator: (++s.made).toString(16).padStart(32, "0"), streams: new Map() });
      return res(200, { locator: s.convs.get(conversation).locator });
    }
    let x;
    if ((x = path.match(/^\/api\/mirror\/v1\/conversations\/([0-9a-f]{32})$/)) && m === "DELETE") { const c = conv(x[1]); if (c) s.convs.delete(c.conversation); return res(200, {}); }
    if ((x = path.match(/^\/api\/mirror\/v1\/append\/([0-9a-f]{32})$/))) {
      s.onAppend?.();
      if (s.appendDelay) await new Promise((r) => setTimeout(r, s.appendDelay));
      const c = conv(x[1]);
      if (!c) return res(404, { error: "missing" });
      const [inst, fn, ln, fs, ls] = init.headers["x-sb-mirror-range"].split(" ");
      const body = JSON.parse(init.body);
      const st = c.streams.get(inst) ?? { next_n: 1, last_seq: 0, segs: [], stale_from: null, stale_reason: null };
      const range = { first_n: +fn, last_n: +ln, first_seq: +fs, last_seq: +ls };
      if (range.first_n !== st.next_n) {
        const d = st.segs.find((g) => g.first_n === range.first_n && g.last_n === range.last_n && g.first_seq === range.first_seq && g.last_seq === range.last_seq);
        if (d) return d.text === canonical(body) ? res(200, { segment: 0, digest: "d" }) : res(409, { error: "conflict", message: "another history holds this range" });
        return res(409, { error: "conflict", message: range.first_n > st.next_n ? "a gap" : "an overlap" });
      }
      if (st.segs.length && range.first_seq <= st.last_seq) return res(409, { error: "conflict", message: "agent numbers must increase" });
      const size = init.body.length;
      if (s.bytes + size > s.quota) return res(507, { error: "storage_full" });
      s.bytes += size;
      st.segs.push({ ...range, text: canonical(body), entries: body.entries });
      st.next_n = range.last_n + 1;
      st.last_seq = range.last_seq;
      st.digest = (s.made * 1000 + st.segs.length).toString(16).padStart(64, "0");
      c.streams.set(inst, st);
      return res(200, { segment: st.segs.length - 1, digest: st.digest, first_n: range.first_n, last_n: range.last_n });
    }
    if ((x = path.match(/^\/api\/mirror\/v1\/read\/([0-9a-f]{32})\/([A-Za-z0-9_-]+)\?after=(\d+)$/))) {
      const st = conv(x[1])?.streams.get(x[2]);
      if (!st) return res(404, { error: "missing" });
      const stale = { stale_from: st.stale_from, stale_reason: st.stale_reason };
      const g = st.segs.find((g) => g.first_n === +x[3] + 1);
      if (!g) return res(200, { end: true, ...stale });
      if (s.missing.has(g.first_n)) return res(200, { missing: true, reason: "corrupt", first_n: g.first_n, last_n: g.last_n, ...stale });
      return res(200, { log_instance: x[2], first_n: g.first_n, last_n: g.last_n, entries: g.entries, ...stale });
    }
    if (path === "/api/mirror/v1/stale") {
      const b = JSON.parse(init.body);
      s.staleCalls.push(b);
      const st = conv(b.locator)?.streams.get(b.log_instance);
      if (!st) return res(404, { error: "missing" });
      if (!(b.from_n >= 1 && b.from_n < st.next_n)) return res(400, { error: "invalid" });
      if (st.stale_from === null || b.from_n < st.stale_from) { st.stale_from = b.from_n; st.stale_reason = b.reason; }
      return res(200, { stale_from: st.stale_from, stale_reason: st.stale_reason });
    }
    return res(404, { error: "not found" });
  };
  s.stream = (conversation, inst) => s.convs.get(conversation)?.streams.get(inst);
  s.entries = (conversation, inst) => (s.stream(conversation, inst)?.segs ?? []).flatMap((g) => g.entries);
  return s;
}

function setup(o = {}) {
  const a = agent(o.agent);
  const s = site(o.site);
  const kept = { cursors: o.cursors ?? null, changed: 0 };
  let current = a;
  const m = new Mirror({ fetch: s.fetch, pairing: () => current, loadCursors: () => kept.cursors, storeCursors: (c) => { kept.cursors = JSON.parse(JSON.stringify(c)); }, changed: () => kept.changed++, replayMs: 300, quietMs: 20, drainMs: 400, wholeQuietMs: 60 });
  a.mirror = m;
  return { a, s, m, kept, setPairing: (p) => { current = p; if (p) p.mirror = m; } };
}

/** A turn of the agent's, as its log has it: the person's message, the turn, a tool call with arguments, usage. */
function turn(a, conv, text, n = 1) {
  a.log(conv, "chat.message", { author: "person", id: `m${a.seq + 1}`, text });
  const t = `t${a.seq + 1}`;
  a.log(conv, "turn.event", { turn_id: t, event: { type: "turn_started" } });
  for (let i = 0; i < n; i++) a.log(conv, "turn.event", { turn_id: t, event: { type: "text_delta", message: "a1", revision: i, text: "reply " + i } });
  a.log(conv, "turn.event", { turn_id: t, event: { type: "tool_call_started", call: "c1", tool: "Bash", args: { command: "cat ~/.ssh/id_rsa" }, summary: "Read a file" } });
  a.log(conv, "turn.event", { turn_id: t, event: { type: "usage", input_tokens: 10 } });
  a.log(conv, "turn.event", { turn_id: t, event: { type: "turn_finished", outcome: "completed" } });
}
const TAG = /^mirror[a-z]{10}$/;
/** the tag of the agent's last tagged request for a conversation (each request has its own) */
const tagOf = (a, conv) => [...a.sent].reverse().find(([mm, q]) => mm === "chat.resume" && q.conversation === conv)?.[1].tag;
const expected = (a, conv) => {
  let n = 0;
  return (a.logs.get(conv) ?? []).map(normalize).filter(Boolean).map((d) => ({ ...d, n: ++n }));
};

// ---- the uploader
{
  const { a, s, m, kept } = setup();
  await m.refresh();
  check(m.on() && m.agentCan(), "on, and the agent says chat.resume.tag: the mirror may read it");
  turn(a, "c1", "hello, my key is sk-live-0123456789abcdef");
  await m.kick("c1");
  await settle();
  const got = s.entries("c1", "aaaaaaaa11");
  const want = expected(a, "c1");
  check(got.length === want.length && canonical(got) === canonical(want), "a kick uploads what the log has, normalized by the allowlist, positions from 1", { got, want });
  check(!JSON.stringify(got).includes("id_rsa") && !JSON.stringify(got).includes("input_tokens"), "tool arguments and usage are left out (allowlist a)");
  check(got.some((e) => e.k === "user" && e.text === "hello, my key is sk-live-0123456789abcdef"), "a secret pasted into a message is uploaded as written (allowlist d: not redaction)");
  const asks = a.sent.filter(([mm]) => mm === "chat.resume");
  check(asks.length === 1 && TAG.test(asks[0][1].tag) && asks[0][1].after === 0 && asks[0][1].instance === "aaaaaaaa11" && Object.keys(asks[0][1]).sort().join() === "after,conversation,instance,tag", "it asks with a tagged chat.resume, from its cursor, in the hello's run", asks);
  check(kept.cursors?.c1?.seq === a.seq && kept.cursors.c1.n === want.length + 1 && kept.cursors.c1.instance === "aaaaaaaa11", "the cursor moves past everything read, the excluded usage entry included", kept.cursors);
  check(kept.cursors.c1.digest === s.stream("c1", "aaaaaaaa11").digest, "after an append, the cursor's chain digest is the stream's, with n and seq", { cursor: kept.cursors.c1.digest, site: s.stream("c1", "aaaaaaaa11").digest });
  turn(a, "c1", "again");
  await m.kick("c1");
  await settle();
  const got2 = s.entries("c1", "aaaaaaaa11");
  check(canonical(got2) === canonical(expected(a, "c1")) && a.sent.filter(([mm]) => mm === "chat.resume").at(-1)[1].after === kept.cursors.c1.seq - 6, "the next kick uploads only what's new, its positions going on", got2.map((e) => e.n));
  check(a.sent.every(([mm]) => mm === "chat.resume"), "the uploader only ever reads the agent's log (S6e)", a.sent.map(([mm]) => mm));
}

// ---- only with the feature, only when on
{
  const { a, m } = setup({ agent: { features: ["chat.resume"] } });
  await m.refresh();
  a.log("c1", "chat.message", { author: "person", id: "m1", text: "hi" });
  await m.kick("c1");
  check(!m.agentCan() && a.sent.length === 0, "an agent without chat.resume.tag isn't mirrored at all (no fallback on the display's cursor)", a.sent);
  const o = setup({ site: { on: false } });
  await o.m.refresh();
  o.a.log("c1", "chat.message", { author: "person", id: "m1", text: "hi" });
  await o.m.kick("c1");
  check(!o.m.on() && o.a.sent.length === 0, "the mirror off: nothing is asked or uploaded");
  const u = setup();
  await u.m.refresh();
  u.a.state = "paired";
  u.a.log("c1", "chat.message", { author: "person", id: "m1", text: "hi" });
  await u.m.kick("c1");
  check(u.a.sent.length === 0, "a pairing not yet granted: nothing");
}

// ---- which replays the mirror takes (SEC §6)
{
  const { a, s, m, setPairing } = setup();
  await m.refresh();
  turn(a, "c1", "x");
  check(m.onReplay({ conversation: "c1", instance: "aaaaaaaa11", last: 1, events: [], done: true }, a) === false, "an untagged replay is the display's: the mirror doesn't take it");
  check(m.onReplay({ conversation: "c1", instance: "aaaaaaaa11", last: 1, events: [], done: true, tag: "mirrorabcdefghij" }, a) === true, "a tagged replay with no request in flight: dropped (it goes to neither reader)");
  a.quiet = true;
  const p = m.kick("c1");
  await settle();
  const good = { conversation: "c1", instance: "aaaaaaaa11", last: a.seq, done: true, tag: tagOf(a, "c1"), events: a.logs.get("c1") };
  m.onReplay({ ...good, tag: "other" }, a);
  m.onReplay({ ...good, instance: "bbbbbbbb22" }, a);
  m.onReplay({ ...good, events: [...good.events, { seq: a.seq + 1, method: "turn.event", params: { conversation: "c2", turn_id: "t", event: { type: "turn_started" } } }] }, a);
  m.onReplay({ ...good, events: [{ seq: 0, method: "x", params: { conversation: "c1" } }] }, a);
  const other = agent();
  m.onReplay(good, other);
  await settle();
  check(!s.stream("c1", "aaaaaaaa11"), "a wrong tag, another run, an entry of another conversation, a bad number, another pairing: each dropped whole, nothing uploaded");
  m.onReplay(good, a);
  await p;
  await settle();
  check(s.entries("c1", "aaaaaaaa11").length === expected(a, "c1").length, "the right answer, after all of those: taken");
  // (a replay from a pairing that is no longer the page's)
  a.quiet = false;
  turn(a, "c2", "y");
  const b = agent({ instance: "aaaaaaaa11" });
  b.logs = a.logs;
  a.quiet = true;
  const q = m.kick("c2");
  await settle();
  setPairing(b);
  m.onReplay({ conversation: "c2", instance: "aaaaaaaa11", last: a.seq, done: true, tag: tagOf(a, "c2"), events: a.logs.get("c2") }, a);
  await q;
  await tick(350);
  check(!s.stream("c2", "aaaaaaaa11"), "an answer through a replaced pairing changes nothing");
}

// ---- an agent that stops early (done: false, nothing more): the part is uploaded, and only once that request has
//      ended (drained) is the next asked, from where the upload got to
{
  const { a, s, m } = setup({ agent: { chunk: 3 } });
  await m.refresh();
  turn(a, "c1", "long", 4);
  await m.kick("c1");
  await settle();
  check(a.sent.filter(([mm]) => mm === "chat.resume").length === 1 && s.entries("c1", "aaaaaaaa11").length > 0, "a part cut short: what came is uploaded, and no second request goes while the first may still send", a.sent.length);
  // (no other trigger: the rest is asked for by itself, once each cut request has drained)
  for (let i = 0; i < 12 && canonical(s.entries("c1", "aaaaaaaa11")) !== canonical(expected(a, "c1")); i++) { await tick(450); await settle(); }
  const asks = a.sent.filter(([mm]) => mm === "chat.resume");
  check(asks.length >= 3 && asks.every(([, p]) => TAG.test(p.tag)) && asks[1][1].after === 3, "after it drained, asked again from the last number read, tagged", asks.map(([, p]) => p.after));
  check(canonical(s.entries("c1", "aaaaaaaa11")) === canonical(expected(a, "c1")), "all of it uploaded, once");
}

// ---- a slow part: the rest of an answer arriving after the caller took it as partial is that request's, discarded;
//      it is never read as another request's answer (round 2's sequence), and a kick refused meanwhile runs after
{
  const { a, s, m } = setup();
  await m.refresh();
  turn(a, "c1", "slow", 3);
  const log = a.logs.get("c1");
  a.quiet = true;
  void m.kick("c1");
  await settle();
  // (part 1 of the answer, then nothing for longer than the quiet period)
  m.onReplay({ conversation: "c1", instance: "aaaaaaaa11", last: a.seq, done: false, running: [], tag: tagOf(a, "c1"), events: log.slice(0, 3) }, a);
  await tick(60);
  await settle();
  const after1 = s.entries("c1", "aaaaaaaa11").length;
  const asked = a.sent.filter(([mm]) => mm === "chat.resume").length;
  // (part 2 of the same answer, late, with done: true: discarded, and the request ends)
  m.onReplay({ conversation: "c1", instance: "aaaaaaaa11", last: a.seq, done: true, running: [], tag: tagOf(a, "c1"), events: log.slice(3) }, a);
  check(asked === 1 && after1 > 0 && s.entries("c1", "aaaaaaaa11").length === after1, "the late rest of the first answer is discarded; nothing else was asked while it could arrive", { asked, after1 });
  a.quiet = false;
  await settle();
  await tick(50);
  await settle();
  check(canonical(s.entries("c1", "aaaaaaaa11")) === canonical(expected(a, "c1")) && a.sent.filter(([mm]) => mm === "chat.resume").length === 2, "once it ended, with no other trigger: asked again from the cursor by itself, everything uploaded, once", a.sent.map(([, p]) => p.after));
}

// ---- another page moved the stream: reload its state, all of it, then go on
{
  const { a, s, m, kept } = setup();
  await m.refresh();
  turn(a, "c1", "one");
  await m.kick("c1");
  await settle();
  turn(a, "c1", "two");
  // (a second page of the same account uploads the new turn first)
  const other = setup();
  other.s.fetch = s.fetch;
  const m2 = new Mirror({ fetch: s.fetch, pairing: () => a, loadCursors: () => JSON.parse(JSON.stringify(kept.cursors)), storeCursors: () => {}, changed: () => {}, replayMs: 300 });
  await m2.refresh();
  a.mirror = m2;
  await m2.kick("c1");
  await settle();
  a.mirror = m;
  turn(a, "c1", "three");
  await m.kick("c1");
  await settle();
  const got = s.entries("c1", "aaaaaaaa11");
  check(canonical(got) === canonical(expected(a, "c1")), "after another page's upload: an overlap, the stream's state reloaded (next_n with last_seq), no entry twice", got.map((e) => [e.n, e.seq]));
  check(/^[0-9a-f]{64}$/.test(kept.cursors.c1.digest ?? "") && kept.cursors.c1.digest !== "0".repeat(64), "the reload took the chain digest with them, all three together", kept.cursors.c1);
  // (a stream whose digest isn't 64 hex: its state isn't taken at all)
  const bad = async (path, init) => { const r = await s.fetch(path, init); if (path !== "/api/mirror/v1/conversations" || (init?.method ?? "GET") !== "GET") return r; const j = await r.json(); for (const c of j.conversations) for (const x of c.streams) x.last_digest = "nothex"; return new Response(JSON.stringify(j), { status: 200 }); };
  const mb = new Mirror({ fetch: bad, pairing: () => a, loadCursors: () => null, storeCursors: () => {}, changed: () => {} });
  await mb.refresh();
  const lb = await mb.remote(true);
  check(lb.length > 0 && lb.every((c) => c.streams.length === 0), "a stream state with a malformed digest is refused whole", lb);
}

// ---- a conflict: the same range, other entries
{
  const { a, s, m } = setup();
  await m.refresh();
  turn(a, "c1", "mine");
  // (another history holds positions 1.. of this run's stream)
  const loc = (await (await s.fetch("/api/mirror/v1/conversations", { method: "POST", headers: { "x-sb-mirror-csrf": "tok" }, body: JSON.stringify({ conversation: "c1" }) })).json()).locator;
  const theirs = expected(a, "c1").map((e) => (e.k === "user" ? { ...e, text: "not mine" } : e));
  await s.fetch(`/api/mirror/v1/append/${loc}`, { method: "POST", headers: { "x-sb-mirror-csrf": "tok", "x-sb-mirror-range": `aaaaaaaa11 1 ${theirs.length} ${theirs[0].seq} ${theirs.at(-1).seq}` }, body: JSON.stringify({ schema: 1, allowlist: 1, log_instance: "aaaaaaaa11", entries: theirs }) });
  // (a page whose cursor, in this same run, says nothing is uploaded yet: it tries 1..)
  const m3 = new Mirror({ fetch: s.fetch, pairing: () => a, loadCursors: () => ({ c1: { locator: loc, instance: "aaaaaaaa11", seq: 0, n: 1 } }), storeCursors: () => {}, changed: () => {}, replayMs: 300 });
  a.mirror = m3;
  await m3.refresh();
  await m3.kick("c1");
  await settle();
  check(s.staleCalls.some((c) => c.reason === "conflict" && c.from_n === 1 && c.log_instance === "aaaaaaaa11") && s.stream("c1", "aaaaaaaa11").stale_from === 1, "the same range with other entries: the upload stops and the stream is marked stale (conflict)", s.staleCalls);
  check(s.entries("c1", "aaaaaaaa11").every((e) => e.k !== "user" || e.text === "not mine"), "nothing of the page's was mixed into the other history");
}

// ---- out of storage (507): the cursor stays; the next trigger goes on once there's room
{
  const { a, s, m, kept } = setup({ site: { quota: 10 } });
  await m.refresh();
  turn(a, "c1", "big");
  await m.kick("c1");
  await settle();
  check(m.full && !s.stream("c1", "aaaaaaaa11") && kept.cursors.c1.seq === 0 && kept.cursors.c1.n === 1, "an upload that doesn't fit: full, the cursor where it was", kept.cursors);
  s.quota = 1e9;
  await m.kick("c1");
  await settle();
  check(!m.full && canonical(s.entries("c1", "aaaaaaaa11")) === canonical(expected(a, "c1")), "with room again, the next kick uploads it, and full clears");
}

// ---- the reader: gaps, never partial text; the stale mark
{
  const { a, s, m } = setup({ agent: { chunk: 0 } });
  await m.refresh();
  turn(a, "c1", "first");
  await m.kick("c1");
  await settle();
  turn(a, "c1", "second");
  await m.kick("c1");
  await settle();
  const st = s.stream("c1", "aaaaaaaa11");
  s.missing.add(st.segs[0].first_n);
  st.stale_from = 3;
  st.stale_reason = "differs";
  const r = await m.readConversation("c1");
  const sec = r?.sections[0];
  check(sec && sec.gaps.length === 1 && sec.gaps[0].first_n === 1 && sec.gaps[0].last_n === st.segs[0].last_n && sec.entries.every((e) => e.n > st.segs[0].last_n) && sec.entries.length === st.segs[1].entries.length, "a segment the site can't verify is a gap; the rest is read", sec);
  check(sec.stale_from === 3 && sec.stale_reason === "differs", "the stream's stale mark comes with what's read", sec);
}

// ---- the reconcile: the runner wins
{
  const { a, s, m, setPairing } = setup();
  await m.refresh();
  turn(a, "same", "equal");
  turn(a, "diff", "will differ");
  turn(a, "beyond", "mirror has more");
  turn(a, "elsewhere", "another run's");
  for (const c of ["same", "diff", "beyond", "elsewhere"]) { await m.kick(c); await settle(); }
  // (the runner's log now differs from what was uploaded: a message changed, and a log cut short)
  const d = a.logs.get("diff").find((e) => e.method === "chat.message");
  d.params.text = "changed on the runner";
  a.logs.set("beyond", a.logs.get("beyond").slice(0, 3)); // (positions 1-3 kept: 4 on are the mirror's alone)
  // (a new run of the agent holds "elsewhere" now, and doesn't hold "same"...)
  const runner = agent({ instance: "cccccccc33" });
  runner.logs = new Map([["elsewhere", [{ seq: 1, method: "chat.message", params: { conversation: "elsewhere", author: "person", id: "n1", text: "new run" } }]]]);
  // ... first the same run: equal, differs, beyond
  s.staleCalls.length = 0;
  a.sent.length = 0;
  await m.reconcile();
  await settle();
  const by = (c) => s.stream(c, "aaaaaaaa11");
  check(by("same").stale_from === null, "the same run, entries equal: nothing changes");
  const dn = expected(a, "diff").find((e) => e.k === "user").n;
  check(by("diff").stale_from === dn && by("diff").stale_reason === "differs", "the same run, a different entry: stale from that position (differs)", by("diff"));
  check(by("beyond").stale_from === 4 && by("beyond").stale_reason === "missing_on_runner", "a position the runner doesn't have: stale from there (missing_on_runner)", by("beyond"));
  check(a.sent.every(([mm, p]) => mm === "chat.resume" && TAG.test(p.tag) && p.after === 0), "the reconcile only reads the runner's log (S6e): tagged chat.resume, nothing else sent", a.sent);
  // ... then the new run
  setPairing(runner);
  s.staleCalls.length = 0;
  await m.reconcile();
  await settle();
  check(by("elsewhere").stale_from === 1 && by("elsewhere").stale_reason === "other_run", "another run's stream, in a conversation the live runner holds: stale from 1 (other_run)", by("elsewhere"));
  check(by("same").stale_from === null && !s.staleCalls.some((c) => c.locator === s.convs.get("same").locator), "a conversation the runner doesn't hold: nothing compared, nothing marked");
  s.staleCalls.length = 0;
  await m.reconcile();
  await settle();
  check(!s.staleCalls.some((c) => c.locator === s.convs.get("elsewhere").locator), "a stream already stale from that position: not marked again");
  check(runner.sent.every(([mm, p]) => mm === "chat.resume" && TAG.test(p.tag)), "the new runner too: only read", runner.sent);
}

// ---- one request at a time: a late part of a request whose wait ran out is never another request's answer
{
  const { a, s, m } = setup();
  await m.refresh();
  turn(a, "c1", "first");
  a.quiet = true;
  await m.kick("c1"); // (asked; no answer within the wait)
  await tick(350);
  const asked = a.sent.filter(([mm]) => mm === "chat.resume").length;
  await m.kick("c1"); // (the first request is draining: no second request is made)
  await settle();
  check(a.sent.filter(([mm]) => mm === "chat.resume").length === asked, "while a request whose wait ran out drains, no second request goes", a.sent.length);
  // (its late answer arrives: discarded, nothing uploaded from it; the request ends, and the refused kick runs)
  a.quiet = false;
  m.onReplay({ conversation: "c1", instance: "aaaaaaaa11", last: a.seq, done: true, running: [], tag: tagOf(a, "c1"), events: a.logs.get("c1").slice(3) }, a);
  check(!s.stream("c1", "aaaaaaaa11"), "the late answer is discarded, not taken for a later request's");
  await settle();
  await tick(50);
  await settle();
  check(canonical(s.entries("c1", "aaaaaaaa11")) === canonical(expected(a, "c1")), "once it has ended, the refused kick runs: the next request reads all of it from the cursor, nothing skipped", s.entries("c1", "aaaaaaaa11").length);
}

// ---- no answer in time, and none late either: once the request has drained, the upload runs again by itself
{
  const { a, s, m } = setup();
  await m.refresh();
  turn(a, "c1", "unanswered");
  a.quiet = true;
  void m.kick("c1");
  await tick(350); // (the wait runs out)
  a.quiet = false;
  check(!s.stream("c1", "aaaaaaaa11") && a.sent.filter(([mm]) => mm === "chat.resume").length === 1, "no answer within the wait: nothing uploaded, and nothing asked again while it drains");
  await tick(500); // (the drain ends: nothing late came)
  await settle();
  check(canonical(s.entries("c1", "aaaaaaaa11")) === canonical(expected(a, "c1")), "the drain over, with no other trigger: asked again and uploaded", a.sent.map(([, q]) => q.after));
}

// ---- the request ends while the partial answer is still being uploaded: the rest is still asked for, by itself
{
  const { a, s, m } = setup();
  await m.refresh();
  turn(a, "c1", "race", 3);
  const log = a.logs.get("c1");
  a.quiet = true;
  void m.kick("c1");
  await settle();
  // (part 1, then quiet: a partial answer, uploaded slowly; the rest of the answer, with done, arrives during that)
  s.appendDelay = 80;
  let once = false;
  s.onAppend = () => { if (once) return; once = true; setTimeout(() => m.onReplay({ conversation: "c1", instance: "aaaaaaaa11", last: a.seq, done: true, running: [], tag: tagOf(a, "c1"), events: log.slice(3) }, a), 10); };
  m.onReplay({ conversation: "c1", instance: "aaaaaaaa11", last: a.seq, done: false, running: [], tag: tagOf(a, "c1"), events: log.slice(0, 3) }, a);
  a.quiet = false;
  for (let i = 0; i < 20 && canonical(s.entries("c1", "aaaaaaaa11")) !== canonical(expected(a, "c1")); i++) await tick(50);
  s.appendDelay = 0;
  s.onAppend = null;
  check(canonical(s.entries("c1", "aaaaaaaa11")) === canonical(expected(a, "c1")), "the request ended during the partial upload: the rest is asked for and uploaded with no other trigger", a.sent.map(([, q]) => q.after));
}

// ---- an agent that never answers: asked again by itself at most a few times, then only on a real trigger
{
  const { a, m, setPairing } = setup();
  await m.refresh();
  turn(a, "c1", "never");
  a.quiet = true;
  void m.kick("c1");
  await tick(3200); // (three misses: each 300 ms waiting and 400 ms draining)
  const n = a.sent.filter(([mm]) => mm === "chat.resume").length;
  await tick(1500);
  check(n >= 3 && n <= 4 && a.sent.filter(([mm]) => mm === "chat.resume").length === n, "no answer, again and again: asked by itself a few times, then no more until a real trigger", n);
  // (another pairing: missed answers start again from none, so it's asked again by itself after a miss)
  const b = agent();
  b.logs = a.logs;
  b.quiet = true;
  setPairing(b);
  void m.kick("c1");
  await tick(1600);
  check(b.sent.filter(([mm]) => mm === "chat.resume").length >= 2, "another pairing: a miss is asked again by itself (the count starts again)", b.sent.length);
  a.quiet = false;
}

// ---- one tag per request: a part of an older request is never read as a newer one's, however late it comes
{
  const { a, s, m } = setup();
  await m.refresh();
  turn(a, "c1", "tags");
  const tags = new Set();
  for (let i = 0; i < 20; i++) tags.add((await import("./mirror.ts")).requestTag());
  check([...tags].every((t) => TAG.test(t) && t.length === 16) && tags.size === 20, "each request tag is mirror and 10 random letters (16 characters, as the agent takes), never repeated", [...tags].slice(0, 3));
  a.quiet = true;
  void m.kick("c1");
  await settle();
  const old = tagOf(a, "c1");
  await tick(350); // (its wait runs out)
  await tick(450); // (and its drain: nothing came)
  await settle();
  const fresh = tagOf(a, "c1");
  check(fresh !== old && TAG.test(fresh) && a.sent.filter(([mm]) => mm === "chat.resume").length === 2, "after the wait and the drain, the next request has a new tag", { old, fresh });
  // (the old request's complete answer arrives now, exact in every field but its tag: the new request is untouched)
  const env = { conversation: "c1", instance: "aaaaaaaa11", last: a.seq, done: true, running: [], events: a.logs.get("c1").slice(0, 2) };
  check(m.onReplay({ ...env, tag: old }, a) === true && !s.stream("c1", "aaaaaaaa11"), "the old tag's complete answer, after the drain: dropped, nothing uploaded from it");
  // (the right tag, but from another pairing, or of another run: dropped too)
  m.onReplay({ ...env, tag: fresh, events: a.logs.get("c1") }, agent());
  m.onReplay({ ...env, tag: fresh, instance: "bbbbbbbb22", events: a.logs.get("c1") }, a);
  m.onReplay({ ...env, tag: fresh, conversation: "c2", events: [] }, a);
  await settle();
  check(!s.stream("c1", "aaaaaaaa11"), "the new tag from another pairing, of another run, or for another conversation: dropped");
  // (the new request's own answer: taken whole)
  m.onReplay({ ...env, tag: fresh, events: a.logs.get("c1") }, a);
  await settle();
  check(canonical(s.entries("c1", "aaaaaaaa11")) === canonical(expected(a, "c1")), "its own tag's answer: taken, all of it uploaded once");
  a.quiet = false;
}

// ---- astra2's case: a reconcile's old answer, cut short, arriving after its wait and drain, during a newer reconcile
{
  const { a, s, m } = setup();
  await m.refresh();
  turn(a, "c1", "first");
  await m.kick("c1");
  await settle();
  turn(a, "c1", "second");
  await m.kick("c1");
  await settle();
  const all = a.logs.get("c1");
  a.quiet = true;
  const r1 = m.reconcile();
  await settle();
  const oldTag = tagOf(a, "c1");
  // (the old answer as it was when asked: only the first turn, said done)
  const oldAnswer = { conversation: "c1", instance: "aaaaaaaa11", last: all[5].seq, done: true, running: [], tag: oldTag, events: all.slice(0, 6) };
  await tick(350);
  await tick(450);
  await r1;
  const r2 = m.reconcile();
  await settle();
  const newTag = tagOf(a, "c1");
  m.onReplay(oldAnswer, a); // (late, after the drain, during the newer reconcile)
  await settle();
  m.onReplay({ conversation: "c1", instance: "aaaaaaaa11", last: a.seq, done: true, running: [], tag: newTag, events: all }, a);
  await r2;
  await settle();
  check(newTag !== oldTag && s.stream("c1", "aaaaaaaa11").stale_from === null, "the old, cut answer coming late is ignored: no false stale mark, the runner's whole log confirms both turns", s.stream("c1", "aaaaaaaa11"));
  a.quiet = false;
}

// ---- a conflict stops this run's uploads for good; a deleted copy is made again; a log that dropped entries stops
{
  const { a, s, m, kept } = setup();
  await m.refresh();
  turn(a, "c1", "mine");
  const loc = (await (await s.fetch("/api/mirror/v1/conversations", { method: "POST", headers: { "x-sb-mirror-csrf": "tok" }, body: JSON.stringify({ conversation: "c1" }) })).json()).locator;
  const theirs = expected(a, "c1").map((e) => (e.k === "user" ? { ...e, text: "not mine" } : e));
  await s.fetch(`/api/mirror/v1/append/${loc}`, { method: "POST", headers: { "x-sb-mirror-csrf": "tok", "x-sb-mirror-range": `aaaaaaaa11 1 ${theirs.length} ${theirs[0].seq} ${theirs.at(-1).seq}` }, body: JSON.stringify({ schema: 1, allowlist: 1, log_instance: "aaaaaaaa11", entries: theirs }) });
  kept.cursors = null;
  const m2 = new Mirror({ fetch: s.fetch, pairing: () => a, loadCursors: () => ({ c1: { locator: loc, instance: "aaaaaaaa11", seq: 0, n: 1 } }), storeCursors: (c) => { kept.cursors = JSON.parse(JSON.stringify(c)); }, changed: () => {}, replayMs: 300, quietMs: 20, drainMs: 400 });
  a.mirror = m2;
  await m2.refresh();
  await m2.kick("c1");
  await settle();
  const appends = () => s.calls.filter(([mm, p]) => mm === "POST" && p.startsWith("/api/mirror/v1/append/")).length;
  const n0 = appends(), stale0 = s.staleCalls.length;
  turn(a, "c1", "more");
  await m2.kick("c1");
  await settle();
  await m2.kick("c1");
  await settle();
  check(kept.cursors?.c1?.blocked === "conflict" && appends() === n0 && s.staleCalls.length === stale0, "after a conflict: no more appends and no more marks for that run, whatever the triggers", { blocked: kept.cursors?.c1?.blocked, appends: appends() - n0 });
}
{
  const { a, s, m, kept } = setup();
  await m.refresh();
  turn(a, "c1", "one");
  await m.kick("c1");
  await settle();
  const old = s.convs.get("c1").locator;
  // (another device deletes this conversation's copy)
  await s.fetch(`/api/mirror/v1/conversations/${old}`, { method: "DELETE", headers: { "x-sb-mirror-csrf": "tok" } });
  turn(a, "c1", "two");
  await m.kick("c1");
  await settle();
  check(!kept.cursors.c1, "an upload to a copy deleted elsewhere: the cursor is forgotten", kept.cursors);
  await m.kick("c1");
  await settle();
  check(s.convs.get("c1")?.locator && s.convs.get("c1").locator !== old && canonical(s.entries("c1", "aaaaaaaa11")) === canonical(expected(a, "c1")), "the next upload makes the copy again, from the start of what the agent still has");
}
{
  const { a, s, m, kept } = setup();
  await m.refresh();
  turn(a, "c1", "one");
  await m.kick("c1");
  await settle();
  const before = s.entries("c1", "aaaaaaaa11").length;
  turn(a, "c1", "two");
  turn(a, "c1", "three");
  a.dropped.set("c1", a.logs.get("c1")[8].seq); // (the agent dropped entries just after the cursor)
  await m.kick("c1");
  await settle();
  check(kept.cursors.c1.blocked === "reset" && s.entries("c1", "aaaaaaaa11").length === before, "entries after the cursor gone from the agent's log (reset): this run's stream stops rather than join across a hole", kept.cursors.c1);
}

// ---- the reconcile by the agent's number
{
  const { a, s, m } = setup();
  await m.refresh();
  turn(a, "old", "kept long ago", 3);
  turn(a, "skip", "will skip");
  for (const c of ["old", "skip"]) { await m.kick(c); await settle(); }
  // (the agent dropped its oldest entries of "old": the rest equal; the reconcile can't confirm the dropped ones, and
  //  says nothing of them)
  a.dropped.set("old", a.logs.get("old")[3].seq);
  // (the runner has an allowlisted entry the stream skipped, between two the stream has)
  const sk = a.logs.get("skip");
  const t = sk[1].params.turn_id;
  sk.splice(3, 0, { seq: sk[2].seq + 0.5, method: "turn.event", params: { conversation: "skip", turn_id: t, event: { type: "turn_error", code: "x" } } });
  sk.forEach((e, i) => (e.seq = 1000 + i)); // (renumbered: the stream's numbers no longer exist on the runner...)
  await m.reconcile();
  await settle();
  check(s.stream("old", "aaaaaaaa11").stale_from === null, "entries the agent dropped at its bounds: not marked (reset is read), the rest equal", s.stream("old", "aaaaaaaa11"));
  check(s.stream("skip", "aaaaaaaa11").stale_from === 1 && s.stream("skip", "aaaaaaaa11").stale_reason === "missing_on_runner", "compared by number: a stream whose numbers the runner doesn't hold is unconfirmed from its first", s.stream("skip", "aaaaaaaa11"));
}
{
  const { a, s, m } = setup();
  await m.refresh();
  turn(a, "gap", "a turn");
  await m.kick("gap");
  await settle();
  // (the runner holds an allowlisted entry, between two the stream has, that the stream doesn't)
  const g = a.logs.get("gap");
  const t = g[1].params.turn_id;
  const st = s.stream("gap", "aaaaaaaa11");
  const e2 = st.segs[0].entries[1], e3 = st.segs[0].entries[2];
  // (make room: a seq between e2 and e3 that the runner has, the stream doesn't)
  for (const g2 of st.segs) for (const e of g2.entries) if (e.n >= 3) e.seq += 100;
  for (const e of g) if (e.seq >= e3.seq - 100) e.seq += 100;
  g.splice(2, 0, { seq: e2.seq + 1, method: "turn.event", params: { conversation: "gap", turn_id: t, event: { type: "turn_error", code: "skipped" } } });
  g.sort((x, y) => x.seq - y.seq);
  await m.reconcile();
  await settle();
  check(st.stale_from === 3 && st.stale_reason === "differs", "an entry of the runner's the stream skipped, between two it has: stale from the next one (differs)", { from: st.stale_from, reason: st.stale_reason });
}

// ---- the reconcile reads the runner's log whole, request by request; never from a partial answer
{
  const { a, s, m } = setup();
  await m.refresh();
  turn(a, "c1", "x", 3);
  turn(a, "c2", "y", 3);
  await m.kick("c1");
  await settle();
  await m.kick("c2");
  await settle();
  // (the runner's log of c1 differs late in it; of c2, not at all; each answer stops early, every two entries)
  a.logs.get("c1").at(-2).params.event = { type: "turn_error", code: "changed" };
  const at = expected(a, "c1").find((e) => e.k === "turn_error")?.n;
  a.chunk = 2;
  a.sent.length = 0;
  await m.reconcile();
  await settle();
  const asks = a.sent.filter(([mm, q]) => mm === "chat.resume" && q.conversation === "c1").map(([, q]) => q.after);
  check(s.stream("c1", "aaaaaaaa11").stale_from === at && s.stream("c1", "aaaaaaaa11").stale_reason === "differs", "an agent that stops early: the reconcile reads on, each request once the one before has ended, and marks where it differs", { got: s.stream("c1", "aaaaaaaa11").stale_from, at, asks });
  check(asks.length >= 4 && asks[0] === 0 && asks.every((v, i) => i === 0 || v > asks[i - 1]), "each request from the highest number read", asks);
  check(s.stream("c2", "aaaaaaaa11").stale_from === null, "read whole, equal: nothing marked");
}
{
  const { a, s, m } = setup();
  await m.refresh();
  turn(a, "c1", "x", 3);
  await m.kick("c1");
  await settle();
  a.logs.get("c1").at(-2).params.event = { type: "turn_error", code: "changed" };
  // (entries dropped between two pages: the log can't be read whole now, nothing is concluded)
  a.chunk = 2;
  const real = a.notify;
  let n = 0;
  a.notify = (mm, q) => { if (mm === "chat.resume" && ++n === 2) a.dropped.set("c1", q.after + 1); return real(mm, q); };
  await m.reconcile();
  await settle();
  check(s.stream("c1", "aaaaaaaa11").stale_from === null, "a reset on a later page: no conclusion, nothing marked", s.stream("c1", "aaaaaaaa11"));
}

// ---- a reconcile under way stops when the mirror is turned off
{
  const { a, s, m } = setup();
  await m.refresh();
  turn(a, "c1", "x", 5);
  await m.kick("c1");
  await settle();
  a.chunk = 2;
  a.sent.length = 0;
  const r = m.reconcile();
  await tick(100); // (its first request answered in part; it waits for that one to end)
  s.on = false;
  await m.refresh();
  await r;
  await settle();
  const n = a.sent.filter(([mm]) => mm === "chat.resume").length;
  await tick(600);
  check(n <= 2 && a.sent.filter(([mm]) => mm === "chat.resume").length === n, "turned off during a reconcile: no more of the runner's log is asked for", n);
  a.chunk = 0;
}

// ---- all a request asked for, not said done: the caller has it, and the request drains until it ends
{
  const { a, s, m } = setup();
  await m.refresh();
  turn(a, "c1", "x");
  const log = a.logs.get("c1");
  a.quiet = true;
  void m.kick("c1");
  await settle();
  m.onReplay({ conversation: "c1", instance: "aaaaaaaa11", last: a.seq, done: false, running: [], tag: tagOf(a, "c1"), events: log }, a);
  await settle();
  check(canonical(s.entries("c1", "aaaaaaaa11")) === canonical(expected(a, "c1")), "everything up to last, without done: taken whole");
  turn(a, "c1", "more");
  void m.kick("c1");
  await settle();
  const asked = a.sent.filter(([mm]) => mm === "chat.resume").length;
  // (its trailing part: never read as the next request's answer)
  m.onReplay({ conversation: "c1", instance: "aaaaaaaa11", last: a.seq, done: true, running: [], tag: tagOf(a, "c1"), events: a.logs.get("c1").slice(log.length) }, a);
  check(asked === 1, "no second request while it still drained", asked);
  a.quiet = false;
  await settle();
  await tick(50);
  await settle();
  check(canonical(s.entries("c1", "aaaaaaaa11")) === canonical(expected(a, "c1")) && a.sent.filter(([mm]) => mm === "chat.resume").length === 2, "its trailing part discarded; once it ended, the refused upload ran and asked for the rest", a.sent.map(([, q]) => q.after));
}

// ---- a list that can't be read is not an empty one
{
  const { a, s, m } = setup();
  await m.refresh();
  turn(a, "c1", "x");
  await m.kick("c1");
  await settle();
  const before = (await m.remote(true)).length;
  s.failList = true;
  let threw = false;
  try { await m.remote(true); } catch { threw = true; }
  check(threw && m.cached().length === before && before === 1, "a list that fails (503): an error, and the last list stays", { threw, cached: m.cached().length });
  s.failList = false;
}

// ---- deleting
{
  const { a, s, m, kept } = setup();
  await m.refresh();
  turn(a, "c1", "x");
  turn(a, "c2", "y");
  await m.kick("c1");
  await settle();
  await m.kick("c2");
  await settle();
  const loc = s.convs.get("c1").locator;
  check(await m.deleteConversation(loc) && !s.convs.has("c1") && !kept.cursors.c1 && kept.cursors.c2, "deleting one conversation's mirrored copy forgets its cursor only");
  check(await m.disable() && !m.on() && Object.keys(kept.cursors).length === 0, "turning it off: off, and every cursor forgotten");
}

const failed = results.filter(([ok]) => !ok).length;
console.log(failed ? `test-mirror-client: ${failed} failed` : `ok: the log mirror's page side, ${results.length} checks`);
process.exit(failed ? 1 : 0);
