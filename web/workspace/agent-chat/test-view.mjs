// ci: web-runner order=372 runner=bun
// The agents chat's turn view and reducer (web/workspace/agent-chat/view.ts, events.ts): what turn events carry into
// the thread is checked as it's applied (states and kinds from their sets, an artifact's language a short name, counts
// numbers), and the view escapes and checks again what it draws, for a thread kept from before (localStorage).
//   bun web/workspace/agent-chat/test-view.mjs
const fakeEl = () => ({ className: "", innerHTML: "", querySelectorAll: () => [] });
globalThis.document = { createElement: fakeEl };
const { apply, newThread } = await import("./events.ts");
const { turnNode, userNode, toolHtml, artifactLabel } = await import("./view.ts");

const results = [];
const check = (ok, what, detail) => { results.push([!!ok, what]); if (!ok) console.log("FAIL", what, JSON.stringify(detail)?.slice(0, 500)); };
const hooks = { answer() {}, openArtifact() {}, md: (s) => s.replace(/</g, "&lt;") };
const HOSTILE = '"><img src=x onerror=alert(1)>';
const bad = (html) => /<img|onerror|<script/i.test(html);

// ---- through apply, as the page receives them
const t = newThread("t1", "T");
let seq = 0;
const ev = (e) => apply(t, { seq: ++seq, turn_id: "u1", ...e }, 1000);
ev({ type: "turn_started" });
ev({ type: "artifact", id: "a1", kind: "code", title: "x.py", lang: HOSTILE, body: "1" });
ev({ type: "artifact", id: "a2", kind: "code", title: "y.py", lang: "python", body: "2" });
ev({ type: "artifact", id: "a3", kind: HOSTILE, title: "z", body: "3" });
ev({ type: "tool_call_started", call: "c1", tool: "terminal", name: "sh", summary: "ls" });
ev({ type: "tool_call_finished", call: "c1", status: HOSTILE, duration_ms: "9" });
ev({ type: "tool_call_started", call: "c2", tool: "constructor", name: "n", summary: "s" });
ev({ type: "tool_call_finished", call: "c2", status: "ok", duration_ms: 12 });
ev({ type: "attention", id: "q1", kind: "approval", state: HOSTILE, title: "T" });
ev({ type: "attention", id: "q2", kind: "approval", state: "open", title: "Allow?" });
ev({ type: "turn_usage", usage: { output_tokens: HOSTILE } });
ev({ type: "turn_finished", outcome: HOSTILE });
const turn = t.entries.find((e) => e.kind === "turn");
check(t.artifacts.length === 2 && t.artifacts[0].lang === undefined && t.artifacts[1].lang === "python", "apply: an artifact's language kept only as a short name; an unknown kind left out", t.artifacts);
check(turn.tools.c1.status === "unknown" && turn.tools.c1.duration_ms === undefined && turn.tools.c2.status === "ok" && turn.tools.c2.duration_ms === 12, "apply: a tool's status from its set (else unknown), its duration a number", turn.tools);
check(!turn.attention.q1 && turn.attention.q2?.state === "open" && turn.parts.filter((p) => p.kind === "attention").length === 1, "apply: a prompt with a state outside its set left out", turn.attention);
check(turn.usage === undefined && turn.outcome === "error" && turn.state === "error", "apply: usage with a count that isn't a number left out; an unknown outcome is an error", { usage: turn.usage, outcome: turn.outcome });
const html = turnNode(t, turn, hooks).innerHTML;
check(!bad(html) && /class="tool unknown"/.test(html) && /<span class="ti">•<\/span>sh|<span class="ti">•<\/span>n/.test(html), "the turn drawn: nothing hostile, the tool's class from its set, an unknown tool's icon the default", html.slice(0, 600));
check(/Code · python/.test(artifactLabel(t.artifacts[1])) && artifactLabel(t.artifacts[0]) === "Code", "the card's label: the language when it's a name, none otherwise", [artifactLabel(t.artifacts[0]), artifactLabel(t.artifacts[1])]);

// ---- a thread kept from before (localStorage), never through apply: the view checks and escapes on its own
const kept = { kind: "code", id: "k", title: "k", lang: HOSTILE, body: "" };
check(!bad(artifactLabel(kept)) && artifactLabel(kept) === "Code", "a kept artifact with a hostile language: its label shows none (as text, never markup)", artifactLabel(kept));
check(!bad(artifactLabel({ ...kept, lang: "<b>x" })) && artifactLabel({ ...kept, lang: "c++" }) === "Code · c++", "…a language with markup characters isn't a name; c++ is", [artifactLabel({ ...kept, lang: "<b>x" }), artifactLabel({ ...kept, lang: "c++" })]);
const tool = toolHtml({ call: "x", tool: "terminal", name: "sh", summary: "ls", status: HOSTILE, output: "" });
check(!bad(tool) && /^<details class="tool other"/.test(tool), "a kept tool with a hostile status: its class is other", tool.slice(0, 200));
const keptTurn = { kind: "turn", turn_id: "k", state: "completed", outcome: "completed", parts: [{ kind: "attention", id: "a" }], tools: {}, attention: { a: { id: "a", kind: "approval", state: HOSTILE, title: "t" } }, started: 0, finished: 1, usage: { output_tokens: HOSTILE } };
const kh = turnNode({ ...newThread("k", "k"), entries: [keptTurn] }, keptTurn, hooks).innerHTML;
check(!bad(kh) && /class="attention other"/.test(kh) && /0 tokens/.test(kh), "a kept prompt with a hostile state, usage not a number: class other, 0 tokens", kh.slice(0, 400));
const u = userNode({ kind: "user", id: "u", mode: HOSTILE, text: "hi" }, hooks.md);
check(u.className === "user other", "a kept message with a hostile mode: class other", u.className);

// ---- an agent's ids are keys, never a prototype's (daybreak3's E932-1): "__proto__" and "constructor" as a tool's call
// and a prompt's id, in a turn made here and in one kept from before (an ordinary object, as JSON.parse makes it)
{
  const p = newThread("p", "P");
  let n = 0;
  const pe = (e) => apply(p, { seq: ++n, turn_id: "v1", ...e }, 1000);
  pe({ type: "turn_started" });
  for (const id of ["__proto__", "constructor"]) {
    pe({ type: "tool_call_started", call: id, tool: "terminal", name: "sh", summary: id });
    pe({ type: "attention", id, kind: "approval", state: "open", title: "Q " + id });
  }
  pe({ type: "tool_output", call: "toString", text: "x" });
  pe({ type: "turn_finished", outcome: "completed" });
  const pt = p.entries.find((e) => e.kind === "turn");
  const tools = Object.values(pt.tools), atts = Object.values(pt.attention);
  check(Object.getPrototypeOf(pt.tools) === null && Object.getPrototypeOf(pt.attention) === null && tools.length === 2 && atts.length === 2 && tools.every((x) => x.status === "unknown") && pt.parts.filter((x) => x.kind === "attention").length === 2 && Object.getPrototypeOf({}) === Object.prototype && !("summary" in Object.prototype),
    "ids __proto__ and constructor: ordinary entries (each tool ended unknown with the turn, each prompt a part); no prototype changed; an unknown call's output dropped", { tools, atts: atts.map((x) => x.id) });
  const ph = turnNode(p, pt, hooks).innerHTML;
  check((ph.match(/<details class="tool/g) ?? []).length === 2 && (ph.match(/data-attention=/g) ?? []).length === 2, "…both drawn, tools and prompts", ph.slice(0, 300));
  // (a kept turn: JSON's ordinary objects; an own "__proto__" key is data, and a part naming an id with no entry draws nothing)
  const keptP = JSON.parse('{"kind":"turn","turn_id":"w","state":"completed","outcome":"completed","parts":[{"kind":"tool","call":"__proto__"},{"kind":"tool","call":"toString"},{"kind":"attention","id":"constructor"}],"tools":{"__proto__":{"call":"__proto__","tool":"terminal","name":"sh","summary":"s","status":"ok","output":""}},"attention":{},"started":0}');
  const kph = turnNode({ ...newThread("w", "w"), entries: [keptP] }, keptP, hooks).innerHTML;
  check((kph.match(/<details class="tool/g) ?? []).length === 1 && !/data-attention=/.test(kph), "a kept turn: its own __proto__ tool drawn; an inherited toString or constructor never", kph.slice(0, 300));
}
// (a running turn kept across a reload (JSON: ordinary objects) whose events go on: __proto__ is still an own entry,
//  never the record's prototype)
{
  const r = newThread("r", "R");
  let n = 0;
  const re = (th, e) => apply(th, { seq: ++n, turn_id: "y1", ...e }, 1000);
  re(r, { type: "turn_started" });
  const back = JSON.parse(JSON.stringify(r));
  re(back, { type: "tool_call_started", call: "__proto__", tool: "terminal", name: "sh", summary: "s" });
  re(back, { type: "attention", id: "__proto__", kind: "approval", state: "open", title: "Q" });
  const bt = back.entries.find((e) => e.kind === "turn");
  check(Object.getPrototypeOf(bt.tools) === Object.prototype && Object.getPrototypeOf(bt.attention) === Object.prototype && Object.hasOwn(bt.tools, "__proto__") && Object.hasOwn(bt.attention, "__proto__"),
    "a turn kept across a reload, its events going on: __proto__ is an own entry, the records' prototypes unchanged", { tools: Object.keys(bt.tools), att: Object.keys(bt.attention) });
}
// (grader's P6, P7 on #932 r2: in a kept turn, inherited names are never entries: a prompt "constructor" becomes a part
//  and is drawn; tool_output for calls "constructor" and "toString" that never started adds nothing and writes nowhere)
{
  const k = newThread("k6", "K");
  let n = 0;
  const ke = (th, e) => apply(th, { seq: ++n, turn_id: "z1", ...e }, 1000);
  ke(k, { type: "turn_started" });
  const kb = JSON.parse(JSON.stringify(k));
  ke(kb, { type: "attention", id: "constructor", kind: "approval", state: "open", title: "Q ctor" });
  ke(kb, { type: "tool_output", call: "constructor", text: "x" });
  ke(kb, { type: "tool_output", call: "toString", text: "y" });
  const kt = kb.entries.find((e) => e.kind === "turn");
  const kh = turnNode(kb, kt, hooks).innerHTML;
  check(kt.parts.some((x) => x.kind === "attention" && x.id === "constructor") && /data-attention="constructor"/.test(kh), "a kept turn: a prompt with id constructor becomes a part and is drawn", kt.parts);
  check(Object.keys(kt.tools).length === 0 && Object.output === undefined && Function.prototype.output === undefined && Object.prototype.output === undefined, "a kept turn: tool_output for calls constructor and toString that never started adds nothing, and writes onto no prototype", Object.keys(kt.tools));
}
// ---- usage and durations: finite, not negative, numbers (daybreak3's E932-2), as applied and again where drawn
{
  const q = newThread("q", "Q");
  let n = 0;
  const qe = (e) => apply(q, { seq: ++n, turn_id: "w1", ...e }, 1000);
  qe({ type: "turn_started" });
  qe({ type: "turn_usage", usage: { output_tokens: 5, input_tokens: HOSTILE, extra: HOSTILE } });
  const qt = q.entries.find((e) => e.kind === "turn");
  check(JSON.stringify(qt.usage) === '{"input_tokens":0,"output_tokens":5}', "usage: a fresh object of the two counts, a bad one 0, nothing else kept", qt.usage);
  for (const v of [-1, Infinity, NaN, "7"]) {
    qe({ type: "turn_usage", usage: { output_tokens: v, input_tokens: 1 } });
  }
  check(qt.usage.output_tokens === 5, "…an output count that is negative, infinite, NaN or text changes nothing", qt.usage);
  const draw = (usage, dur) => {
    const k = { kind: "turn", turn_id: "z", state: "completed", outcome: "completed", parts: [{ kind: "tool", call: "c" }], tools: { c: { call: "c", tool: "terminal", name: "sh", summary: "s", status: "error", output: "", duration_ms: dur } }, attention: {}, usage, started: 0, finished: 0 };
    return turnNode({ ...newThread("z", "z"), entries: [k] }, k, hooks).innerHTML;
  };
  const shown = [["12", "9"], [-3, -5], [Infinity, Infinity], [1e400, NaN]].map(([u, d]) => draw({ output_tokens: u }, d));
  check(shown.every((x) => /0 tokens/.test(x) && !/ s<|NaN|Infinity|-/.test(x.replace(/data-[a-z-]+/g, ""))), "a kept turn's usage and a tool's duration that aren't finite, non-negative numbers: 0 tokens, no duration", shown.map((x) => x.slice(-120)));
  check(/12 tokens/.test(draw({ output_tokens: 12 }, 1500)) && /1\.5 s/.test(draw({ output_tokens: 12 }, 1500)), "…and good ones shown", draw({ output_tokens: 12 }, 1500).slice(-200));
}

// ---- grader's rows on #932: a hostile name with no spaces, the 32-character bound, negative and non-finite numbers
// from the wire (JSON's 1e400 is Infinity), and a tool finished "running"
{
  const g = newThread("g", "G");
  let n = 0;
  const ge = (e) => apply(g, { seq: ++n, turn_id: "x1", ...e }, 1000);
  ge({ type: "turn_started" });
  const L32 = "a".repeat(32), L33 = "a".repeat(33);
  ge({ type: "artifact", id: "s1", kind: "code", title: "s", lang: '"><svg/onload=alert(1)>', body: "" });
  ge({ type: "artifact", id: "s2", kind: "code", title: "s", lang: L33, body: "" });
  ge({ type: "artifact", id: "s3", kind: "code", title: "s", lang: L32, body: "" });
  check(g.artifacts[0].lang === undefined && g.artifacts[1].lang === undefined && g.artifacts[2].lang === L32, "a language with no spaces but markup characters is dropped; 33 characters dropped, 32 kept", g.artifacts.map((a) => a.lang));
  const wire = JSON.parse('[{"d":-5},{"d":1e400},{"u":-1},{"u":1e400}]');
  ge({ type: "tool_call_started", call: "d1", tool: "terminal", name: "sh", summary: "s" });
  ge({ type: "tool_call_finished", call: "d1", status: "ok", duration_ms: wire[0].d });
  ge({ type: "tool_call_started", call: "d2", tool: "terminal", name: "sh", summary: "s" });
  ge({ type: "tool_call_finished", call: "d2", status: "ok", duration_ms: wire[1].d });
  ge({ type: "tool_call_started", call: "r1", tool: "terminal", name: "sh", summary: "s" });
  ge({ type: "tool_call_finished", call: "r1", status: "running" });
  ge({ type: "turn_usage", usage: { output_tokens: wire[2].u } });
  ge({ type: "turn_usage", usage: { output_tokens: wire[3].u } });
  const gt = g.entries.find((e) => e.kind === "turn");
  check(gt.tools.d1.duration_ms === undefined && gt.tools.d2.duration_ms === undefined, "durations -5 and 1e400 (Infinity, from JSON) are left out", [gt.tools.d1.duration_ms, gt.tools.d2.duration_ms]);
  check(gt.usage === undefined, "output counts -1 and 1e400 (from JSON): the usage is left out", gt.usage);
  check(gt.tools.r1.status === "unknown", "a tool finished with status running is unknown, not left spinning", gt.tools.r1.status);
  ge({ type: "turn_finished", outcome: "completed" });
  const gh = turnNode(g, gt, hooks).innerHTML;
  check(!/-0\.0 s|-5\.0 s|Infinity|NaN/.test(gh) && !bad(gh), "…and none of them is drawn (no -0.0 s, no Infinity s)", gh.slice(0, 300));
}

const failed = results.filter(([ok]) => !ok);
if (failed.length) { console.log(`FAIL: ${failed.length} of ${results.length}`); process.exit(1); }
console.log(`ok: the agents chat's view and its checks, ${results.length} checks`);
