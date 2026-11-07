// ci: web-artifacts.1 order=5 runner=bun
// The agents chats' bounds (BH-1; William, Nov 3: "no history ever grows without bounds"), on events.ts alone. Every
// expected value here is written out (the contract), never read from CHAT_BOUNDS, so a changed bound fails a check.
// - the hard caps hold at EVERY admission: the charge after each event is within the total and the turn's subcap, and
//   the saved JSON is never longer than the charge (checked at intervals and at the end); with all chats kept, >1000
//   running turns, 1000 tools at their largest, 100 artifacts at their largest and metadata at its longest;
// - each kind of loss is counted where the page says it (astra's DATA-1, DATA-2), structured bodies never cut into
//   invalid data, the eviction order fixed (running turns last: grader's B12), each count cap on its own (B4, B5),
//   each slice (B8, B9);
// - time: the MAX of any one admission, and the whole run.
//   bun web/agents/test-agents-bounds.mjs
import { apply, boundLoaded, esc, Ledger, newThread, CHAT_BOUNDS } from "./events.ts";

let checks = 0;
const fails = [];
const ok = (cond, what) => { checks++; console.log((cond ? "ok   " : "FAIL ") + what); if (!cond) fails.push(what); };
const now = performance.now.bind(performance);
const t0 = now();
// the contract, written out
const TOTAL = 1792 * 1024, TURN = 512 * 1024, TEXT = 256 * 1024, ARTS = 512 * 1024, BYTES = 4 * 2 ** 20;
ok(CHAT_BOUNDS.total === TOTAL && CHAT_BOUNDS.turn === TURN && CHAT_BOUNDS.text === TEXT && CHAT_BOUNDS.chatArtifacts === ARTS && CHAT_BOUNDS.bytes === BYTES && 2 * TOTAL < BYTES, "the bounds are the contract's (total 1.75 Mi units = 3.5 MiB < 4 MiB saved)");

let maxApply = 0, events = 0, worstOver = 0;
const jsonLen = (L) => JSON.stringify(L).length;
// (one event, timed, and the postcondition after it: the charge within the total and the turn's subcap)
function feed(g, thread, d, turn_id, time = events) {
  const a = now();
  const r = apply(thread, { ...d, seq: thread.applied_seq + 1, turn_id }, time, g);
  maxApply = Math.max(maxApply, now() - a);
  events++;
  const turn = thread.entries.findLast?.((e) => e.kind === "turn" && e.turn_id === turn_id);
  if ((g.L.size ?? 0) > g.B.total || (turn && (turn.size ?? 0) > g.B.turn)) worstOver = Math.max(worstOver, (g.L.size ?? 0) - g.B.total, (turn?.size ?? 0) - g.B.turn);
  return r;
}
const chats = (B = CHAT_BOUNDS, keepAll = false) => {
  const L = { threads: [], current: "" };
  const g = new Ledger(L, B, keepAll ? () => new Set(L.threads.map((t) => t.id)) : () => new Set([L.current]));
  return g;
};

// 1. many short turns (200k events): entries never past 1000 in a chat, the oldest counted
{
  const g = chats(); const t = g.newThread("a", "many"); g.L.current = "a";
  let peak = 0, turns = 0;
  for (let i = 0; i < 200_000; i += 4, turns++) {
    const id = "t" + turns;
    feed(g, t, { type: "turn_started" }, id);
    feed(g, t, { type: "message_revised", message: "m", revision: 1 }, id);
    feed(g, t, { type: "text_delta", message: "m", revision: 1, text: "answer " + turns }, id);
    feed(g, t, { type: "turn_finished", outcome: "completed" }, id);
    peak = Math.max(peak, t.entries.length);
  }
  ok(peak === 1000 && t.dropped.entries === turns - 1000 && g.L.lost.entries === turns - 1000, `1: ${turns} turns: entries peak 1000, the ${turns - 1000} oldest counted in the chat and in Lost`);
  ok(jsonLen(g.L) <= g.L.size, `…the saved JSON (${jsonLen(g.L)}) within its charge (${g.L.size})`);
}

// 2. B8 + DATA-2: a NEW thinking part longer than a text: kept to 262144, marked cut, counted
{
  const g = chats(); const t = g.newThread("b", "think"); g.L.current = "b";
  feed(g, t, { type: "thinking_delta", text: "x".repeat(300_000) }, "x");
  const turn = t.entries[0], p = turn.parts[0];
  ok(p.kind === "thinking" && p.text.length === 262144 && p.cut === true && turn.cut.text === 1, `2: a new thinking part of 300,000: 262144 kept, marked cut, counted (${p.text.length})`);
}

// 3. B4: the tools cap on its own (parts allow 2000; tools stop at 1000)
{
  const g = chats(); const t = g.newThread("c", "tools"); g.L.current = "c";
  for (let i = 0; i < 1001; i++) feed(g, t, { type: "tool_call_started", call: "c" + i, tool: "bash" }, "x");
  const turn = t.entries[0];
  ok(Object.keys(turn.tools).length === 1000 && turn.parts.length === 1000 && turn.cut.tools === 1 && !turn.cut.parts, "3: 1001 tool calls: 1000 kept, the 1001st counted as a tool (not a part)");
}

// 4. B5: the attention cap on its own
{
  const g = chats(); const t = g.newThread("d", "asks"); g.L.current = "d";
  for (let i = 0; i < 201; i++) feed(g, t, { type: "attention", id: "q" + i, kind: "tool", state: "open", title: "Allow?" }, "x");
  const turn = t.entries[0];
  ok(Object.keys(turn.attention).length === 200 && turn.cut.attention === 1, "4: 201 requests: 200 kept, the 201st counted");
}

// 5. B9: a whole tool body longer than a text: 262144 kept, marked cut
{
  const g = chats(); const t = g.newThread("e", "body"); g.L.current = "e";
  feed(g, t, { type: "tool_call_started", call: "c0", tool: "bash" }, "x");
  feed(g, t, { type: "tool_call_finished", call: "c0", status: "ok", duration_ms: 1, body: "y".repeat(300_000) }, "x");
  const tool = t.entries[0].tools.c0;
  ok(tool.output.length === 262144 && tool.body_cut === true, `5: a finished tool's body of 300,000: 262144 kept, marked cut (${tool.output.length})`);
}

// 6. DATA-2: a diff (and a notebook) body too large is LEFT OUT, never cut into invalid JSON; a code body keeps its start
{
  const g = chats(); const t = g.newThread("f", "arts"); g.L.current = "f";
  const big = JSON.stringify({ before: "a", after: "z".repeat(300_000) });
  feed(g, t, { type: "artifact", id: "d1", kind: "diff", title: "Diff", body: big }, "x");
  feed(g, t, { type: "artifact", id: "n1", kind: "notebook", title: "NB", body: JSON.stringify({ cells: ["q".repeat(300_000)] }) }, "x");
  feed(g, t, { type: "artifact", id: "k1", kind: "code", title: "Code", body: "c".repeat(300_000) }, "x");
  const [d1, n1, k1] = t.artifacts;
  ok(d1.body === "" && d1.omitted === big.length && n1.body === "" && n1.omitted > 262144, "6: a diff and a notebook too large: left out (omitted, their length), never cut");
  ok(k1.body.length > 0 && k1.truncated === 300_000 && k1.body.length <= 262144, `…a code body keeps its start, marked truncated (${k1.body.length} of ${k1.truncated})`);
  ok(t.artifacts.every((a) => (a.kind !== "diff" && a.kind !== "notebook") || a.body === "" || (() => { try { JSON.parse(a.body); return true; } catch { return false; } })()), "…every diff/notebook body kept parses");
  ok(t.dropped.bodies === 3 && g.L.lost.bodies === 3, "…each counted (the chat's and Lost's)");
}

// 7. DATA-1 + B12: the eviction order, at a small total: finished entries, then bodies, then whole chats not kept, and
//    LAST running turns, each counted; the turn being added to is never let go
{
  // (the turn's subcap above what the total leaves, so the total is what makes room; the running chat is kept, so its
  // running turn can only go at step 4, never as a whole chat)
  const B = { ...CHAT_BOUNDS, total: 60_000, turn: 59_000, chatArtifacts: 30_000, evictSteps: 64 };
  const L = { threads: [], current: "cur" };
  const g = new Ledger(L, B, () => new Set(["cur", "run2"]));
  const cur = g.newThread("cur", "current");
  const other = g.newThread("other", "other");
  const t2 = g.newThread("run2", "running elsewhere");
  for (let i = 0; i < 5; i++) g.addUser(cur, { kind: "user", id: "u" + i, text: "u".repeat(2000), mode: "note", time: i });
  feed(g, cur, { type: "artifact", id: "a1", kind: "code", title: "A", body: "b".repeat(8000) }, "art", 10);
  feed(g, cur, { type: "turn_finished", outcome: "completed" }, "art", 11);
  g.addUser(other, { kind: "user", id: "o", text: "o".repeat(2000), mode: "note", time: 12 });
  feed(g, t2, { type: "message_revised", message: "m", revision: 1 }, "r2", 13);
  feed(g, t2, { type: "text_delta", message: "m", revision: 1, text: "r".repeat(9000) }, "r2", 13);
  const lost0 = { ...g.L.lost };
  // (a running turn in the current chat grows: room is made)
  feed(g, cur, { type: "message_revised", message: "m", revision: 1 }, "live", 20);
  const order = [];
  let prev = { ...(g.L.lost ?? lost0) };
  for (let i = 0; i < 200; i++) {
    feed(g, cur, { type: "text_delta", message: "m", revision: 1, text: "L".repeat(500) }, "live", 21 + i);
    const L = g.L.lost ?? {};
    for (const k of ["entries", "bodies", "threads", "running"]) if ((L[k] ?? 0) > (prev[k] ?? 0)) order.push(k);
    prev = { ...L };
  }
  const first = (k) => order.indexOf(k);
  ok(first("entries") >= 0 && first("bodies") > first("entries") && first("threads") > first("bodies") && first("running") > first("threads"), `7: the eviction order: entries, then bodies, then a chat not kept, then a running turn last (${[...new Set(order)].join(" → ")})`);
  ok(cur.entries.some((e) => e.kind === "turn" && e.turn_id === "live"), "…the turn being added to is never let go");
  ok(g.L.lost.running >= 1 && g.L.lost.threads >= 1 && !g.L.threads.includes(other) && g.L.threads.includes(t2) && !t2.entries.some((e) => e.turn_id === "r2"), "…the running turn let go (its chat kept) and the chat not kept are counted");
  ok((g.L.size ?? 0) <= B.total && jsonLen(g.L) <= g.L.size, `…the charge within the total (${g.L.size} <= ${B.total}), the JSON within the charge`);
  // (whole chats let go, said after a reload: Lost is saved with them)
  const again = JSON.parse(JSON.stringify(g.L));
  ok(again.lost.threads >= 1, "…and Lost is in the saved form (said after a reload)");
}

// 8. daybreak2's adversarial maxima at the real bounds, ALL chats kept: 200 chats, each with running turns (>1000 in
//    all), 1000 tools with outputs at their largest, 100 artifacts at their largest, metadata at its longest; the
//    postcondition after every event
{
  const g = chats(CHAT_BOUNDS, true);
  const long = "M".repeat(4000); // (past the 1024 a name keeps)
  let running = 0;
  for (let c = 0; c < 200; c++) {
    const t = g.newThread("k" + c, long); if (c === 0) g.L.current = t.id;
    for (let r = 0; r < 6; r++, running++) {
      const id = `r${c}-${r}`;
      feed(g, t, { type: "turn_state", state: long }, id);
      feed(g, t, { type: "message_revised", message: long, revision: 1 }, id);
      feed(g, t, { type: "text_delta", message: long, revision: 1, text: "\u0001".repeat(3000) }, id); // (6x escapes)
      feed(g, t, { type: "tool_call_started", call: "c", tool: long, name: long, summary: long }, id);
      feed(g, t, { type: "tool_output", call: "c", text: "o".repeat(4000) }, id);
      feed(g, t, { type: "attention", id: "q", kind: long, state: "open", title: long, summary: long, detail: "d".repeat(40_000) }, id);
    }
  }
  ok(running > 1000 && worstOver === 0, `8a: 200 chats kept, ${running} running turns, metadata at its longest: never past the total or a turn's subcap (worst over ${worstOver})`);
  const one = g.L.threads[0];
  for (let i = 0; i < 1000; i++) feed(g, one, { type: "tool_call_started", call: "t" + i, tool: "bash" }, "big");
  for (let i = 0; i < 1000; i++) feed(g, one, { type: "tool_output", call: "t" + i, text: "z".repeat(TEXT) }, "big");
  const big = one.entries.find((e) => e.turn_id === "big");
  ok(worstOver === 0 && (big?.size ?? 0) <= TURN, `8b: 1000 tools each given 256Ki of output: the turn within ${TURN} (${big?.size}), the total held`);
  for (let i = 0; i < 100; i++) feed(g, one, { type: "artifact", id: "A" + i, kind: "code", title: long, body: "w".repeat(TEXT) }, "big");
  const arts = one.artifacts.reduce((n, a) => n + esc(a.body), 0);
  ok(worstOver === 0 && arts <= ARTS && one.artifacts.length <= 100, `8c: 100 more artifacts at their largest, the total full: the chat's bodies within ${ARTS} (${arts}), the total held`);
  {
    // (and in chats with room: the chat's artifact budget is what binds, the older bodies left out first)
    const h = chats(); const t = h.newThread("arts", "arts"); h.L.current = "arts";
    for (let i = 0; i < 100; i++) feed(h, t, { type: "artifact", id: "B" + i, kind: "code", title: "T", body: "v".repeat(TEXT) }, "x");
    const kept = t.artifacts.reduce((n, a) => n + esc(a.body), 0), withBody = t.artifacts.filter((a) => a.body.length > 0);
    ok(t.artifacts.length === 100 && kept <= ARTS && kept >= TEXT && withBody.at(-1)?.id === "B99" && t.dropped.bodies >= 98, `8c': 100 artifacts of 256Ki in a chat with room: ${withBody.length} bodies kept (${kept} <= ${ARTS}), the newest; the older left out, counted (${t.dropped.bodies})`);
  }
  const L = jsonLen(g.L);
  ok(L <= g.L.size && 2 * L <= BYTES, `8d: the saved JSON (${L}, ${(2 * L / 2 ** 20).toFixed(2)} MiB) within its charge (${g.L.size}) and 4 MiB`);
  ok(g.L.threads.length === 200, "…and all 200 chats kept (as asked), the losses taken from their contents instead");
}

// 9. chats saved before the bounds (legacy, as large as localStorage can hold): bounded as they load, counted
{
  const L = { threads: [], current: "L0" };
  for (let c = 0; c < 260; c++) {
    const t = newThread("L" + c, "old " + c);
    for (let i = 0; i < 20; i++) t.entries.push({ kind: "user", id: `${c}-${i}`, text: "p".repeat(1200), mode: "note", time: c * 100 + i });
    L.threads.push(t);
  }
  const a = now(); const g = boundLoaded(L, () => new Set(["L0"])); const dt = now() - a;
  ok(L.threads.length === 200 && L.lost.threads === 60 && (L.size ?? 0) <= TOTAL && jsonLen(L) <= L.size, `9: 260 old chats (${(6.2).toFixed(1)}M chars): 200 kept, 60 counted, within the total (${L.size}), in ${dt.toFixed(0)} ms`);
  ok(dt <= 50 * 10, `…loading's bound in ${dt.toFixed(0)} ms (once, at load)`);
}

const total = now() - t0;
ok(maxApply <= 16, `the MAX of any one admission over ${events.toLocaleString("en-US")} events: ${maxApply.toFixed(2)} ms (<= 16)`);
ok(total <= 10_000, `the whole run: ${(total / 1000).toFixed(1)} s (<= 10)`);
console.log(fails.length ? `${fails.length} of ${checks} failed` : `${checks}/${checks} passed`);
process.exit(fails.length ? 1 : 0);
