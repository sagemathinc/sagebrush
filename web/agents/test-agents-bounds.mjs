// ci: web-artifacts.1 order=5 runner=bun
// The agents chats' bounds (BH-1; William, Nov 3: "no history ever grows without bounds"), on events.ts alone, at
// 200,000 events: every level stays within CHAT_BOUNDS as each event is applied, never later; what goes is the oldest,
// counted; a running turn and the chats named to keep never go; and each operation's time is bounded (the MAX of
// every apply and bound is reported, with the whole run's).
//   bun web/agents/test-agents-bounds.mjs
import { apply, boundEntries, boundSaved, newThread, savedBytes, CHAT_BOUNDS as B } from "./events.ts";

let checks = 0;
const fails = [];
const ok = (cond, what) => { checks++; console.log((cond ? "ok   " : "FAIL ") + what); if (!cond) fails.push(what); };
const N = 200_000;
const now = performance.now.bind(performance);
const t0 = now();

// (one event at a time, timed: the max apply time is the bound on any one admission)
let maxApply = 0;
function feed(thread, d, turn_id, time) {
  const a = now();
  const r = apply(thread, { ...d, seq: thread.applied_seq + 1, turn_id }, time);
  maxApply = Math.max(maxApply, now() - a);
  return r;
}

// 1. 200k events as many short turns: entries never past the bound, at every step; the oldest go, counted
{
  const t = newThread("a", "many turns");
  let peak = 0, turns = 0;
  for (let i = 0; i < N; i += 4, turns++) {
    const id = "t" + turns;
    feed(t, { type: "turn_started" }, id, i);
    feed(t, { type: "message_revised", message: "m", revision: 1 }, id, i);
    feed(t, { type: "text_delta", message: "m", revision: 1, text: "answer " + turns }, id, i);
    feed(t, { type: "turn_finished", outcome: "completed" }, id, i + 1);
    peak = Math.max(peak, t.entries.length);
  }
  ok(peak <= B.entries && t.entries.length === B.entries, `1: ${turns} turns (${N} events): entries never past ${B.entries} (peak ${peak})`);
  ok(t.dropped?.entries === turns - B.entries, `…the oldest went, counted: ${t.dropped?.entries} = ${turns - B.entries}`);
  ok(t.entries[0].turn_id === "t" + (turns - B.entries) && t.entries.at(-1).turn_id === "t" + (turns - 1), "…and what's kept is the newest, in order");
}

// 2. one turn of 200k events: its text, tool output and parts each within their bound; the turn says what wasn't kept
{
  const t = newThread("b", "one long turn");
  feed(t, { type: "turn_started" }, "x", 0);
  feed(t, { type: "message_revised", message: "m", revision: 1 }, "x", 0);
  for (let i = 0; i < N / 4; i++) feed(t, { type: "text_delta", message: "m", revision: 1, text: "0123456789".repeat(10) }, "x", i);
  const turn = t.entries[0], msg = turn.parts.find((p) => p.kind === "message");
  ok(msg.text.length === B.text && msg.truncated === true, `2: ${N / 4} text deltas of 100: the message keeps ${B.text} code units, marked cut (${msg.text.length})`);
  feed(t, { type: "tool_call_started", call: "c0", tool: "bash" }, "x", 1);
  for (let i = 0; i < N / 4; i++) feed(t, { type: "tool_output", call: "c0", text: "x".repeat(100) }, "x", i);
  ok(turn.tools.c0.output.length === B.text && turn.tools.c0.body_cut === true, `…a tool's output keeps ${B.text}, marked cut`);
  for (let i = 1; i < N / 4; i++) feed(t, { type: "tool_call_started", call: "c" + i, tool: "bash" }, "x", i);
  for (let i = 0; i < N / 4; i++) feed(t, { type: "thinking_delta", text: "t" + (i % 2 ? "" : " ") }, "x", i);
  ok(turn.parts.length <= B.parts && Object.keys(turn.tools).length <= B.tools, `…${N / 4} tool calls: parts ${turn.parts.length} <= ${B.parts}, tools ${Object.keys(turn.tools).length} <= ${B.tools}`);
  ok(turn.cut?.parts > 0, `…and the turn counts what wasn't kept (${turn.cut?.parts})`);
  ok(turn.parts.filter((p) => p.kind === "thinking").every((p) => p.text.length <= B.text), "…every thinking part within the text bound");
  feed(t, { type: "artifact", id: "big", kind: "markdown", title: "Big", body: "y".repeat(B.text * 3) }, "x", 2);
  ok(t.artifacts[0].body.length === B.text, "…an artifact's body within the text bound");
  for (let i = 0; i < 300; i++) feed(t, { type: "artifact", id: "a" + i, kind: "markdown", title: "A" + i, body: "z" }, "x", 3);
  ok(t.artifacts.length === B.artifacts && t.dropped?.artifacts === 301 - B.artifacts && t.artifacts[0].id === "a" + (300 - B.artifacts), `…${301} artifacts: ${B.artifacts} kept, the oldest gone, counted (${t.dropped?.artifacts})`);
  feed(t, { type: "turn_finished", outcome: "completed" }, "x", 4);
}

// 3. the saved chats: at most `threads`, never past `bytes`, the kept ones and running turns never dropped
{
  const saved = { threads: [] };
  for (let i = 0; i < 300; i++) {
    const t = newThread("th" + i, "chat " + i);
    t.entries.push({ kind: "user", id: "u" + i, text: "hello " + i, mode: "sent", time: i });
    saved.threads.push(t);
  }
  const keep = new Set(["th0", "th1"]);
  const a = now(); const r = boundSaved(saved, keep); const dt = now() - a;
  ok(saved.threads.length === B.threads && r.threads === 300 - B.threads, `3: 300 chats: ${B.threads} kept (${r.threads} let go)`);
  ok(saved.threads.some((t) => t.id === "th0") && saved.threads.some((t) => t.id === "th1"), "…the chats named to keep stay, though oldest");
  ok(saved.threads.every((t) => keep.has(t.id) || Number(t.id.slice(2)) >= 300 - B.threads + 2), "…the others let go are the least recently used");
  // big entries: the byte bound, the oldest entries first, a running turn never
  const big = "w".repeat(B.text);
  for (const t of saved.threads.slice(0, 40)) for (let j = 0; j < 4; j++) t.entries.push({ kind: "user", id: t.id + "-" + j, text: big, mode: "sent", time: 1000 + j });
  const run = saved.threads[5];
  run.entries.push({ kind: "turn", turn_id: "live", state: "running", parts: [{ kind: "message", id: "m", revision: 1, text: big, truncated: false }], tools: {}, attention: {}, started: 0 });
  const before = savedBytes(saved);
  const b = now(); const r2 = boundSaved(saved, keep); const dt2 = now() - b;
  const after = savedBytes(saved);
  ok(before > B.bytes && after <= B.bytes, `…${(before / 2 ** 20).toFixed(1)} MiB of chats bounded to ${(after / 2 ** 20).toFixed(2)} MiB <= ${B.bytes / 2 ** 20} MiB (${r2.entries} entries let go)`);
  ok(run.entries.some((e) => e.kind === "turn" && e.turn_id === "live"), "…a running turn is never let go");
  ok(Math.max(dt, dt2) < 2000, `…each bound in ${Math.max(dt, dt2).toFixed(0)} ms (< 2000)`);
}

// 4. the person's own entries (page.ts submit): boundEntries keeps the chat within the bound as each is added
{
  const t = newThread("c", "notes");
  let peak = 0;
  for (let i = 0; i < N / 10; i++) { t.entries.push({ kind: "user", id: "n" + i, text: "note " + i, mode: "note", time: i }); boundEntries(t); peak = Math.max(peak, t.entries.length); }
  ok(peak <= B.entries && t.dropped?.entries === N / 10 - B.entries, `4: ${N / 10} notes: never past ${B.entries} (peak ${peak}), the oldest counted`);
}

const total = now() - t0;
ok(maxApply < 50, `the max time of any one apply over the run: ${maxApply.toFixed(2)} ms (< 50)`);
ok(total < 120_000, `the whole run: ${(total / 1000).toFixed(1)} s (< 120)`);
console.log(fails.length ? `${fails.length} of ${checks} failed` : `${checks}/${checks} passed`);
process.exit(fails.length ? 1 : 0);
