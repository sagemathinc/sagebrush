// ci: web-sync.1 order=17
// The log mirror's page side against the real Worker (M2 design r4, §7): the page's mirror.ts and session.ts, bundled
// for node, talking to M1's routes in Miniflare (the MirrorAccount object, D1 with every share migration, R2), with a
// fake paired agent that keeps a log and gives chat.resume's tag back. One row (or more) per row of the test contract
// this PR closes: S6d (a runner log that disagrees), S6e (a spy on pairing.notify), S7b (labels), S7c (read-only),
// allowlist a (every kind the fake agent emits) and d (a pasted secret), and the copy pins.
//
//   node web/cloud/mirror/test-mirror-page.mjs
import { createRequire } from "node:module";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { migrations } from "../share/migrations.mjs";
import { dispatch } from "../../miniflare-dispatch.mjs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(here, "../../site/package.json"));
const { Miniflare, convertV4MiniflareOptions } = require("miniflare");

const SITE = "https://sagebrush.test";
const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";

let failures = 0, count = 0;
const ok = (cond, what, detail) => { count++; if (!cond) { failures++; console.log("FAIL", what, detail === undefined ? "" : JSON.stringify(detail).slice(0, 600)); } };
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

const tmp = mkdtempSync(join(tmpdir(), "mirror-page-test-"));
const bundle = (src, name) => {
  const out = join(tmp, name);
  writeFileSync(out, execFileSync("bun", ["build", join(here, src), "--format", "esm", "--target", "node"], { encoding: "utf8", maxBuffer: 1 << 26 }));
  return import(pathToFileURL(out).href);
};
const M = await bundle("../../workspace/agent-chat/mirror.ts", "mirror.mjs");
const S = await bundle("../../workspace/agent-chat/session.ts", "session.mjs");
const F = await bundle("../../workspace/agent-chat/mirror-format.ts", "format.mjs");

const script = execFileSync("bun", ["build", join(here, "test-entry.ts"), "--format", "esm", "--target", "browser", "--external", "cloudflare:workers"], { encoding: "utf8", maxBuffer: 1 << 26 });
const b64url = (b) => Buffer.from(b).toString("base64url");
const bindings = { SESSION_KEY: "session-key", SHARE_DEV: "1", DEV_AUTH_TOKEN: "dev-token", MIRROR_ACCOUNTS: [A, B].join(","), MIRROR_KEK_CURRENT: "1", MIRROR_KEK_V1: b64url(randomBytes(32)), BUDGET_CLAIMS: "on" };
const mf = new Miniflare(convertV4MiniflareOptions({
  workers: [{ name: "mirror", modules: true, script, compatibilityDate: "2026-10-01", d1Databases: ["SHARE_DB"], r2Buckets: ["SHARE_BUCKET", "MIRROR_BUCKET"], bindings,
    durableObjects: { MIRROR_ACCOUNT: { className: "TestMirrorAccount", useSQLite: true } } }],
}));
const db = await mf.getD1Database("SHARE_DB");
for (const { path: m } of migrations())
  for (const s of readFileSync(m, "utf8").replace(/--.*$/gm, "").split(";").map((s) => s.trim()).filter(Boolean)) await db.prepare(s).run();
const site = (path, init = {}) => dispatch(mf, SITE + path, { redirect: "manual", ...init });
async function session(account_id) {
  const r = await site("/auth/dev", { method: "POST", headers: { origin: SITE, "content-type": "application/json" }, body: JSON.stringify({ token: "dev-token", account_id }) });
  return (r.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).find((c) => c.startsWith("__Host-sb_session="));
}

/** A fake agent: a log per conversation in one run; chat.resume answered as the agent does, its tag given back. */
function agent(instance) {
  const a = {
    state: "granted", hello: { agent: { name: "Claude" }, features: ["chat.resume", "chat.resume.tag"], log: { instance } }, sent: [], logs: new Map(), seq: 0, mirror: null,
    log(conversation, method, params) { a.seq++; const l = a.logs.get(conversation) ?? []; l.push({ seq: a.seq, method, params: { conversation, ...params } }); a.logs.set(conversation, l); return a.seq; },
    notify(m, params) {
      a.sent.push([m, structuredClone(params)]);
      if (m === "chat.resume") {
        const all = (a.logs.get(params.conversation) ?? []).filter((e) => e.seq > params.after);
        const last = (a.logs.get(params.conversation) ?? []).at(-1)?.seq ?? 0;
        setTimeout(() => a.mirror?.onReplay({ conversation: params.conversation, instance, last, running: [], events: structuredClone(all), done: true, ...(params.tag !== undefined ? { tag: params.tag } : {}) }, a), 0);
      }
      return true;
    },
    notifyWhy(m, p) { return a.notify(m, p) ? "ok" : "full"; },
  };
  return a;
}

/** A signed-in page of `account`: its Mirror, its pairing (or none), its own cursors. */
async function page(account, pairing = null) {
  const cookie = await session(account);
  let cursors = null;
  const p = { pairing };
  const m = new M.Mirror({
    fetch: (path, init = {}) => site(path, { ...init, headers: { ...(init.headers ?? {}), cookie, origin: SITE } }),
    pairing: () => p.pairing,
    loadCursors: () => cursors,
    storeCursors: (c) => { cursors = structuredClone(c); },
    changed: () => {},
    replayMs: 5000,
  });
  if (pairing) pairing.mirror = m;
  p.mirror = m;
  p.pair = (a) => { p.pairing = a; if (a) a.mirror = m; };
  await m.refresh();
  return p;
}

/** Every kind the fake agent's log can hold, the excluded ones included, each with a field the allowlist must drop. */
const SECRET = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ab";
const DROPPED = ["cat ~/.ssh/id_rsa", "PRIVATE OUTPUT", "deep thoughts", "secret detail", "artifact body text", "/home/me/secret/notes.md", "stack trace here", "page-token-123", "usage-marker", "unknown-kind"];
function everything(a, conv) {
  a.log(conv, "chat.message", { author: "person", id: "u1", text: `my token is ${SECRET} please keep it` });
  a.log(conv, "chat.message", { author: "agent", id: "x1", text: "an agent-authored message isn't the person's" });
  const t = "T" + a.seq;
  a.log(conv, "turn.event", { turn_id: t, event: { type: "turn_started" } });
  a.log(conv, "turn.event", { turn_id: t, event: { type: "message_revised", message: "m1", revision: 0 } });
  a.log(conv, "turn.event", { turn_id: t, event: { type: "text_delta", message: "m1", revision: 0, text: "Here is the answer." } });
  a.log(conv, "turn.event", { turn_id: t, event: { type: "thinking_delta", text: "deep thoughts" } });
  a.log(conv, "turn.event", { turn_id: t, event: { type: "tool_call_started", call: "c1", tool: "Bash", args: { command: "cat ~/.ssh/id_rsa" }, summary: "List the folder" } });
  a.log(conv, "turn.event", { turn_id: t, event: { type: "tool_call_output", call: "c1", text: "PRIVATE OUTPUT" } });
  a.log(conv, "turn.event", { turn_id: t, event: { type: "tool_call_finished", call: "c1", status: "ok", duration_ms: 1200, output: "PRIVATE OUTPUT", summary: "Listed 3 files" } });
  a.log(conv, "turn.event", { turn_id: t, event: { type: "attention", id: "q1", kind: "tool", state: "approved", title: "Run a command", detail: "secret detail", token: "page-token-123" } });
  a.log(conv, "turn.event", { turn_id: t, event: { type: "artifact", id: "a1", kind: "markdown", title: "Notes", body: "artifact body text", path: "/home/me/secret/notes.md" } });
  a.log(conv, "turn.event", { turn_id: t, event: { type: "usage", output_tokens: 7, marker: "usage-marker" } });
  a.log(conv, "turn.event", { turn_id: t, event: { type: "turn_error", code: "rate_limited", message: "stack trace here" } });
  a.log(conv, "turn.event", { turn_id: t, event: { type: "unknown_kind", text: "unknown-kind" } });
  a.log(conv, "chat.receipt", { id: "u1", state: "delivered" });
  a.log(conv, "turn.event", { turn_id: t, event: { type: "turn_finished", outcome: "completed" } });
}
const expected = (a, conv) => { let n = 0; return (a.logs.get(conv) ?? []).map(F.normalize).filter(Boolean).map((d) => ({ ...d, n: ++n })); };

// ---- allowlist a and d: what a page uploads, read back on another device
const run1 = agent("aaaaaaaa00000001");
const p1 = await page(A, run1);
ok(p1.mirror.status.available && !p1.mirror.on(), "a signed-in, entitled page: the mirror is available and off", p1.mirror.status);
ok(await p1.mirror.enable() && p1.mirror.on(), "turned on through the Worker");
ok(typeof p1.mirror.status.quota === "number" && p1.mirror.status.quota > 0, "status says the account's quota, for the storage line", p1.mirror.status);
everything(run1, "conv-all");
await p1.mirror.kick("conv-all");
const p2 = await page(A); // (another device: no pairing at all)
const read = await p2.mirror.readConversation("conv-all");
const entries = read?.sections[0]?.entries ?? [];
ok(read && read.sections.length === 1 && F.canonical(entries) === F.canonical(expected(run1, "conv-all")), "another device reads back exactly what the allowlist keeps of every kind, positions from 1 (allowlist a)", { got: entries.map((e) => e.k), want: expected(run1, "conv-all").map((e) => e.k) });
const stored = JSON.stringify(entries);
ok(DROPPED.every((s) => !stored.includes(s)), "nothing excluded reaches the account: arguments, output, thinking, card detail and token, artifact body and path, usage, error text, unknown kinds", DROPPED.filter((s) => stored.includes(s)));
ok(!stored.includes("an agent-authored message"), "a message not the person's is left out");
ok(entries.some((e) => e.k === "user" && e.text.includes(SECRET)), "a secret pasted into a message is uploaded as written (allowlist d: not redaction)");
ok(run1.sent.every(([m, q]) => m === "chat.resume" && /^mirror[a-z]{10}$/.test(q.tag)), "uploading sent the agent nothing but tagged chat.resume (S6e)", run1.sent.map(([m]) => m));

// ---- S7b: labels; S7c: a mirrored conversation is inert and read-only
{
  const blocks = M.present(read.sections[0]);
  ok(blocks.some((b) => b.k === "user") && blocks.some((b) => b.k === "turn" && b.parts.some((p) => p.k === "text" && p.text === "Here is the answer.")) && blocks.every((b) => !b.unconfirmed), "presented as inert blocks: the person's message, the turn's text, nothing unconfirmed yet", blocks.map((b) => b.k));
  const turn = blocks.find((b) => b.k === "turn");
  ok(turn.parts.some((p) => p.k === "approval" && p.state === "approved") && turn.parts.some((p) => p.k === "artifact" && p.title === "Notes") && turn.parts.some((p) => p.k === "tool" && p.status === "ok"), "an approval, an artifact and a tool are plain records (nothing to answer or open)", turn.parts);
  ok(!JSON.stringify(blocks).match(/"(answer|open|onclick|instance|token)"/), "no record carries anything actionable");
  // (S7c: as a thread of the session, marked as the mirror's: every send path refuses it)
  const sent = [];
  const pairing = { state: "granted", hello: { agent: { name: "Claude" }, features: ["chat.resume", "chat.steer"], log: { instance: "aaaaaaaa00000001" } }, notify(m, q) { sent.push([m, q]); return true; }, notifyWhy(m, q) { sent.push([m, q]); return "ok"; } };
  const s = new S.ChatSession({ load: () => null, store: () => {}, pairing: () => pairing, mayDemo: () => true, demo: () => { sent.push(["demo"]); return { interrupt() {}, answer() {}, done: new Promise(() => {}) }; }, emitted: () => {}, changed: () => {}, notSent: () => {} });
  const thread = { id: "conv-all", title: M.mirrorTitle(read.sections), entries: [], artifacts: [], applied_seq: 0, source: "mirror", agent: true };
  s.state.threads.push(thread);
  s.select(thread.id);
  ok(s.submit("continue it", "sent") === false && s.submit("steer it", "steer") === false && s.submit("queue it", "queued") === false, "S7c: submit refuses the mirrored conversation in every mode");
  s.next(thread);
  s.interrupt(thread);
  s.resume();
  ok(sent.length === 0, "S7c: and nothing of it ever goes to the runner (no message, interrupt, resume or demo)", sent);
  ok(M.mirrorTitle(read.sections).startsWith("my token is"), "its title is its first message's first line");
}

// ---- S6d: a runner log that disagrees; the runner wins, and every device sees the mark
{
  const run = agent("bbbbbbbb00000002");
  const pa = await page(B, run);
  await pa.mirror.enable();
  for (const c of ["same", "differs", "short"]) {
    run.log(c, "chat.message", { author: "person", id: "u-" + c, text: "hello " + c });
    const t = "T" + run.seq;
    run.log(c, "turn.event", { turn_id: t, event: { type: "turn_started" } });
    run.log(c, "turn.event", { turn_id: t, event: { type: "message_revised", message: "m", revision: 0 } });
    run.log(c, "turn.event", { turn_id: t, event: { type: "text_delta", message: "m", revision: 0, text: "answer for " + c } });
    run.log(c, "turn.event", { turn_id: t, event: { type: "turn_finished", outcome: "completed" } });
    await pa.mirror.kick(c);
  }
  // (the runner's log, as a page that pairs again finds it: one entry changed, one log cut short)
  run.logs.get("differs")[3].params.event.text = "a different answer";
  run.logs.set("short", run.logs.get("short").slice(0, 2));
  const pb = await page(B, run); // (a second page of the account, paired with the same runner)
  run.sent.length = 0;
  await pb.mirror.reconcile();
  const list = await pb.mirror.remote(true);
  const st = (c) => list.find((x) => x.conversation === c)?.streams[0];
  ok(st("same").stale_from === null, "S6d: the runner's log equal to the stream: nothing marked", st("same"));
  ok(st("differs").stale_from === 4 && st("differs").stale_reason === "differs", "S6d: an entry the runner has differently: stale from that position (differs), in the account's object", st("differs"));
  ok(st("short").stale_from === 3 && st("short").stale_reason === "missing_on_runner", "S6d: positions the runner doesn't have: stale from the first (missing_on_runner)", st("short"));
  ok(run.sent.every(([m, q]) => m === "chat.resume" && /^mirror[a-z]{10}$/.test(q.tag) && q.after === 0 && Object.keys(q).sort().join() === "after,conversation,instance,tag"), "S6e: the reconcile only read the runner: tagged chat.resume, nothing else, no mirror data in it", run.sent);
  // (a third device, not paired: it sees the mark, and draws from there on as not confirmed)
  const pc = await page(B);
  const r = await pc.mirror.readConversation("differs");
  const blocks = M.present(r.sections[0]);
  ok(r.sections[0].stale_from === 4 && r.sections[0].stale_reason === "differs", "S6d: another device reads the mark with the stream", r.sections[0]);
  ok(blocks.find((b) => b.k === "user")?.unconfirmed === false && blocks.find((b) => b.k === "turn")?.unconfirmed === true, "S7b: what comes before the mark is shown as uploaded; the turn from it on as not confirmed", blocks.map((b) => [b.k, b.n, b.unconfirmed]));
  ok(M.reasonText("differs") === M.MIRROR_COPY.reasons.differs && M.reasonText("bogus") === null, "S7b: a reason the page knows has its words; any other, none");
  // (a new run of the agent holds "same" now: the old run's stream is another run's)
  const run2 = agent("cccccccc00000003");
  run2.log("same", "chat.message", { author: "person", id: "n1", text: "after a restart" });
  pb.pair(run2);
  await pb.mirror.reconcile();
  const l2 = await pb.mirror.remote(true);
  const same = l2.find((x) => x.conversation === "same").streams.find((x) => x.log_instance === "bbbbbbbb00000002");
  ok(same.stale_from === 1 && same.stale_reason === "other_run", "S6d: a conversation the live runner holds, a stream of another run: stale from 1 (other_run)", same);
  ok(run2.sent.every(([m, q]) => m === "chat.resume" && /^mirror[a-z]{10}$/.test(q.tag)), "S6e: only read, again", run2.sent);
  // (the mark only widens: a page can't clear it, nor move it later)
  const loc = l2.find((x) => x.conversation === "differs").locator;
  ok(await pb.mirror.markStale(loc, "bbbbbbbb00000002", 5, "conflict"), "a later mark is answered...");
  const l3 = await pb.mirror.remote(true);
  const d3 = l3.find((x) => x.conversation === "differs").streams[0];
  ok(d3.stale_from === 4 && d3.stale_reason === "differs", "...and changes nothing: the mark stays at 4, its reason with it", d3);
}

// ---- the copy pins (design §5, COPY)
{
  const C = M.MIRROR_COPY;
  const all = JSON.stringify(C);
  ok(C.on.includes("Sagebrush and Cloudflare can read your mirrored history.") && !/while this is on/i.test(all), "who can read it: Sagebrush and Cloudflare, without \"while this is on\"");
  ok(C.deleted === "Mirrored history deleted" && C.deleting === "Deleting mirrored history…" && !/erase|cryptographic|permanent/i.test(all), "\"deleted\", never erased, cryptographically or permanently");
  ok(!/redact|removed|filtered|secure/i.test(all), "no redacted, removed, filtered or secure claims about what is pasted");
  ok(C.on.includes("Anything you paste into a message is uploaded as written."), "a paste is uploaded as written");
  ok(!/\$|price|membership|included|per month|free plan|free of charge/i.test(all), "no price or entitlement wording (ruling Q3; \"free storage\" is about room, as cleared)");
  ok(C.full === "There isn't enough free storage to mirror new messages. Mirroring will resume when there's room.", "the storage-full line, as cleared");
  ok(C.switch === "Keep your agent conversations in your Sagebrush account" && C.confirmOffButton === "Turn off and delete" && C.deleteOne === "Delete this conversation's mirrored copy", "the switch, the confirmation's button and the per-conversation delete, as cleared");
  ok(C.storage("12 MB", "5 GB") === "Mirror: 12 MB of your 5 GB", "the storage line");
  // (every other string, exactly, as COPY reviews it)
  const exact = {
    off: "Your conversations live on the computer that runs your agent. With this on, they're also uploaded to your account while this page is open and connected to your agent, so you can read them on your other devices. It counts toward your account's storage.",
    on: "Uploaded by your pages: your messages, the agent's replies, and a short record of each turn and tool. Tool output, files and command output aren't uploaded. Sagebrush and Cloudflare can read your mirrored history. Anything you paste into a message is uploaded as written.",
    confirmOff: "Turn off and delete your mirrored history? This stops uploads and starts deleting your mirrored copy. Your conversations stay on your agent's computer.",
    updateAgent: "Update the agent to mirror this conversation",
    section: "Uploaded by your page",
    otherRun: "Uploaded by your page; not confirmed by your agent",
    unconfirmed: "Not confirmed by your agent",
    gap: "Part of this conversation couldn't be read",
    readOnly: "This is the copy in your account, and it's read-only. To continue this conversation, connect the agent that has it.",
    badge: "mirror",
    viewCopy: "View the mirrored copy",
    keptMirrored: "Chats are kept in this browser and mirrored to your Sagebrush account.",
    untitled: "Mirrored conversation",
  };
  const off = Object.entries(exact).filter(([k, v]) => C[k] !== v);
  ok(off.length === 0, "every string exactly as reviewed", off.map(([k]) => k));
  ok(JSON.stringify(C.reasons) === JSON.stringify({ differs: "it differs from your agent's history", missing_on_runner: "your agent doesn't have it", other_run: "it's from another run of your agent", conflict: "another page uploaded something different here" }), "each stale reason's words, exactly", C.reasons);
  ok(C.storage("12 MB", null) === "Mirror: 12 MB", "the storage line without a quota");
}

// ---- turning it off
{
  ok(await p1.mirror.disable() && !p1.mirror.on() && p1.mirror.status.state === "off", "turned off: off, and the account's copy is being deleted", p1.mirror.status);
  ok((await p1.mirror.remote(true)).length === 0, "nothing listed once off");
}

console.log(`${count - failures}/${count} mirror page tests passed`);
await mf.dispose();
process.exit(failures ? 1 : 0);
