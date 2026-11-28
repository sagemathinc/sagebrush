// ci: web-runner order=372 runner=bun
// The agents chat's turn view and reducer (web/workspace/agent-chat/view.ts, events.ts): what turn events carry into
// the thread is checked as it's applied (states and kinds from their sets, an artifact's language a short name, counts
// numbers), and the view escapes and checks again what it draws, for a thread kept from before (localStorage).
//   bun web/workspace/agent-chat/test-view.mjs
const fakeEl = () => ({ className: "", innerHTML: "", querySelectorAll: () => [] });
globalThis.document = { createElement: fakeEl };
const { apply, newThread, errorLine } = await import("./events.ts");
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
// (a steer's line: what the agent said became of it; a hostile receipt or reason is never written into the page)
{
  const tag = (e) => userNode({ kind: "user", id: "s", mode: "steer", text: "go", ...e }, hooks.md).innerHTML.match(/<div class="tag">(.*?)<\/div>/)?.[1];
  check(tag({}) === "Steering: Claude reads it at its next step", "a steer, no receipt yet: steering", tag({}));
  check(tag({ receipt: "delivered" }) === "Delivered to the running turn", "delivered", tag({ receipt: "delivered" }));
  check(tag({ receipt: "queued", receipt_reason: "ended" }) === "Queued, runs next: the turn ended first", "queued, the turn ended first");
  check(tag({ receipt: "queued", receipt_reason: "codex" }) === "Queued, runs next: this agent takes it after the turn", "queued, Codex");
  check(tag({ receipt: "queued", receipt_reason: HOSTILE }) === "Queued, runs next" && tag({ receipt: HOSTILE }) === "Steering: Claude reads it at its next step", "a hostile receipt or reason: fixed words only");
  check(userNode({ kind: "user", id: "s", mode: "steer", text: "go" }, hooks.md).className === "user steer", "class steer");
  check(tag({ receipt: "rejected" }) === "Not delivered: the agent dropped it when the turn ended", "rejected: fixed words", tag({ receipt: "rejected" }));
  check(tag({ receipt: "rejected", receipt_reason: "busy" }) === "Not delivered: the agent had too many messages waiting" && tag({ receipt: "rejected", receipt_reason: HOSTILE }) === "Not delivered: the agent dropped it when the turn ended", "rejected (busy), and a hostile reason: fixed words only");
  check(tag({ settled: true }) === "Sent during the turn" && tag({ receipt: "steering", settled: true }) === "Sent during the turn", "settled without a final receipt: Sent during the turn");
  check(tag({ receipt: "delivered", settled: true }) === "Delivered to the running turn" && tag({ receipt: "queued", settled: true }).startsWith("Queued"), "settled never hides a receipt that says what became of it");
}

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

// ---- W3: turn_info, the model and thinking level under the agent's name: only as reported, each field as last said,
// nothing before the first, nothing from another turn, every value checked again and escaped
{
  const th = newThread("ti", "T");
  let n = 0;
  const te = (turn_id, e) => apply(th, { seq: ++n, turn_id, ...e }, 1000);
  te("i1", { type: "turn_started" });
  const info = (id) => { const d = turnNode(th, th.entries.find((e) => e.kind === "turn" && e.turn_id === id), hooks).innerHTML; return /<div class="who-info">([^<]*)<\/div>/.exec(d)?.[1] ?? null; };
  check(info("i1") === null, "W3: nothing shown before the first turn_info");
  te("i1", { type: "turn_info", model: "claude-opus-5-5" });
  check(info("i1") === "claude-opus-5-5", "W3: the model, as the agent gave it (no name mapping)", info("i1"));
  te("i1", { type: "turn_info", effort: "high" });
  check(info("i1") === "claude-opus-5-5 · thinking: high", "W3: an effort later in the turn joins the model", info("i1"));
  te("i1", { type: "turn_info", effort: "low" });
  check(info("i1") === "claude-opus-5-5 · thinking: low", "W3: a changed effort replaces it", info("i1"));
  te("i1", { type: "turn_info", model: HOSTILE, effort: "Very High" });
  check(info("i1") === "claude-opus-5-5 · thinking: low", "W3: malformed fields change nothing", info("i1"));
  te("i2", { type: "turn_started" });
  check(info("i2") === null, "W3: a new turn shows nothing until its own turn_info (nothing carried over)");
  te("i2", { type: "turn_info", effort: "medium" });
  check(info("i2") === "thinking: medium", "W3: an effort alone, without a model", info("i2"));
  te("i2", { type: "turn_info", model: "claude-opus-5-5[1m]" });
  check(info("i2") === "claude-opus-5-5[1m] · thinking: medium", "W3: a model id with a context suffix, as given", info("i2"));
  te("i2", { type: "turn_finished", outcome: "completed" });
  te("i2", { type: "turn_info", effort: "max" });
  check(info("i2") === "claude-opus-5-5[1m] · thinking: medium", "W3: nothing said after the turn's end changes it", info("i2"));
  // (a thread kept from before, with a hostile info in storage: escaped where drawn)
  const kept = th.entries.find((e) => e.kind === "turn" && e.turn_id === "i2");
  kept.info = { model: HOSTILE };
  check(!bad(turnNode(th, kept, hooks).innerHTML) && info("i2") === null, "W3: a malformed stored info is checked again and not drawn");
}

// ---- a Claude sign-in failure (#1804): the agent's closed reasons in the page's own words, whatever text came with
//      them; Claude Code's own text, with its advice about a long-lived token, never drawn. Any other error as before
{
  const RAW = "Failed to authenticate: this login reached its time limit and cannot be renewed. Run `claude auth login` to sign in again, or use `claude setup-token` and set CLAUDE_CODE_OAUTH_TOKEN for unattended jobs";
  const EXPIRED = "Your Claude sign-in expired. On the computer running your agent, run `claude auth login` in a terminal, then send your message again.";
  const NOT_IN = "Claude Code isn't signed in on the computer running your agent. There, run `claude auth login` in a terminal, then send your message again.";
  const drawn = (code, message) => {
    const th = newThread("s-" + code, "S");
    apply(th, { seq: 1, turn_id: "s1", type: "turn_started" }, 1000);
    apply(th, { seq: 2, turn_id: "s1", type: "turn_error", code, message }, 1000);
    apply(th, { seq: 3, turn_id: "s1", type: "turn_finished", outcome: "error", code }, 1000);
    const m = /<div class="turn-error">([^<]*)<\/div>/.exec(turnNode(th, th.entries.find((e) => e.kind === "turn"), hooks).innerHTML);
    return m ? m[1] : null;
  };
  const unesc = (s) => s?.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
  const expired = unesc(drawn("claude_login_expired", RAW));
  check(expired === EXPIRED && !/setup-token|CLAUDE_CODE_OAUTH_TOKEN|Failed to authenticate/.test(expired), "SI-1: claude_login_expired is drawn in the page's words alone, even with Claude Code's own text beside it", expired);
  const notIn = unesc(drawn("claude_not_signed_in", "Not logged in · Please run /login"));
  check(notIn === NOT_IN, "SI-2: claude_not_signed_in is drawn in the page's words", notIn);
  const other = unesc(drawn("authentication_failed", "Invalid API key · Fix external API key"));
  check(other === "Error: Invalid API key · Fix external API key", "SI-3: any other error keeps its own text, after \"Error: \"", other);
  const proto = ["constructor", "__proto__", "toString"].map((c) => errorLine(c, "m"));
  check(proto.every((x) => x === "Error: m"), "SI-4: a code that is an Object property name is just another code", proto);
  check(errorLine("claude_login_expired", "claude_login_expired") === EXPIRED && errorLine("is_error", "is_error") === "Error: is_error", "SI-5: a mirrored turn's error (its code only) says the same", null);
}

// ---- #1789: a thinking block whose text isn't shown streams deltas with none: no "Thinking" disclosure until some
// text comes; one kept from before (an empty part) draws nothing either
{
  const th = newThread("t-th", "T");
  let n = 0;
  const e = (x) => apply(th, { seq: ++n, turn_id: "k1", ...x }, 1000);
  e({ type: "turn_started" });
  e({ type: "thinking_delta", text: "" });
  e({ type: "thinking_delta", text: "" });
  e({ type: "thinking_delta", text: "  " });
  const turn = th.entries.find((x) => x.kind === "turn");
  check(!turn.parts.some((p) => p.kind === "thinking") && !/Thinking/.test(turnNode(th, turn, hooks).innerHTML), "#1789: thinking deltas with no text make no part and no Thinking disclosure", turn.parts);
  e({ type: "thinking_delta", text: "Let me look at the files." });
  e({ type: "thinking_delta", text: " Then plot." });
  const html = turnNode(th, turn, hooks).innerHTML;
  check(/<details class="thinking"><summary>Thinking<\/summary><div>Let me look at the files\. Then plot\.<\/div><\/details>/.test(html), "#1789: once text comes, the disclosure shows it", html);
  const kept = newThread("t-th2", "T");
  apply(kept, { seq: 1, turn_id: "k2", type: "turn_started" }, 1000);
  const kt = kept.entries.find((x) => x.kind === "turn");
  kt.parts.push({ kind: "thinking", text: "" });
  check(!/Thinking/.test(turnNode(kept, kt, hooks).innerHTML), "#1789: an empty thinking part kept from before draws nothing", turnNode(kept, kt, hooks).innerHTML);
}

// ---- diffHtml (Codex audit S12): the changed middle's table admitted within DIFF_PRODUCT_LIMIT, counted before it is
// made; past it, the middle shown removed then added with a note. Every output still is the change: its "-" and " "
// lines are the old text, its "+" and " " lines the new one
{
  const { diffHtml, DIFF_PRODUCT_LIMIT, DIFF_TOO_LARGE } = await import("./view.ts");
  const { TEXT_DIFF_PRODUCT_LIMIT } = await import("../../notebook/text-overlap.ts");
  check(DIFF_PRODUCT_LIMIT === TEXT_DIFF_PRODUCT_LIMIT, "diff: the same bound as the notebook merge's", [DIFF_PRODUCT_LIMIT, TEXT_DIFF_PRODUCT_LIMIT]);
  const unesc = (x) => x.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
  const lines = (html) => [...html.matchAll(/<div class="dl( del| add| note)?">([\s\S]*?)<\/div>/g)].map((m) => [m[1]?.trim() ?? "", unesc(m[2])]);
  const sides = (html) => { const L = lines(html).filter(([k]) => k !== "note"); return [L.filter(([k]) => k !== "add").map(([, t]) => t.slice(1)).join("\n"), L.filter(([k]) => k !== "del").map(([, t]) => t.slice(1)).join("\n")]; };
  const changed = (html) => lines(html).filter(([k]) => k === "del" || k === "add").length;
  const noted = (html) => lines(html).some(([k, t]) => k === "note" && t === DIFF_TOO_LARGE);
  // (the diff before this bound, kept as the reference: its changed-line count is the shortest)
  const old = (before, after) => {
    const a = before.split("\n"), b = after.split("\n"), n = a.length, m = b.length;
    const L = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = a[i] === b[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    return 2 * 0 + (n - L[0][0]) + (m - L[0][0]);
  };
  let seed = 7;
  const rnd = (k) => ((seed = (seed * 1103515245 + 12345) % 2147483648) % k);
  let same = 0, shortest = 0, N = 400;
  for (let c = 0; c < N; c++) {
    const mk = () => Array.from({ length: rnd(9) }, () => "abcd"[rnd(4)]).join("\n");
    const x = mk(), y = mk();
    const h = diffHtml(x, y);
    const [sx, sy] = sides(h);
    if (sx === x && sy === y) same++;
    if (changed(h) === old(x, y)) shortest++;
  }
  check(same === N && shortest === N, `diff: ${N} small random diffs: each is the change, and as short as before (${same} the change, ${shortest} shortest)`);
  const distinct = (k, tag) => Array.from({ length: k }, (_, i) => `${tag}${i}`).join("\n");
  const at = diffHtml(distinct(2000, "a"), distinct(2000, "b"));
  check(!noted(at) && changed(at) === 4000, "diff: a middle of exactly DIFF_PRODUCT_LIMIT cells (2000 x 2000) gets its table, no note");
  const past = diffHtml(distinct(2001, "a"), distinct(2000, "b"));
  const [px, py] = sides(past);
  check(noted(past) && px === distinct(2001, "a") && py === distinct(2000, "b"), "diff: one row past the bound (2001 x 2000): the note, and the middle removed then added, still the change");
  const big = Array.from({ length: 200000 }, (_, i) => `line ${i}`), edited = big.slice();
  edited[100000] = "changed";
  const t0 = performance.now(), mid = diffHtml(big.join("\n"), edited.join("\n")), ms = performance.now() - t0;
  check(!noted(mid) && changed(mid) === 2 && sides(mid)[1] === edited.join("\n"), `diff: 200,000 lines with one changed: the head and tail taken first, no table, no note (${ms.toFixed(0)} ms)`);
  const t1 = performance.now(), hostile = diffHtml(distinct(20000, "x"), distinct(20000, "y")), ms1 = performance.now() - t1;
  check(noted(hostile) && ms1 < 2000, `diff: 20,000 x 20,000 distinct lines (400 M cells) is refused its table and returns at once (${ms1.toFixed(0)} ms)`);
  check(!/<img/i.test(diffHtml(HOSTILE, HOSTILE + "\n" + HOSTILE)) && !/<img/i.test(diffHtml(distinct(2001, HOSTILE), distinct(2000, HOSTILE))), "diff: lines escaped (no tag survives), in both forms");
}

const failed = results.filter(([ok]) => !ok);
if (failed.length) { console.log(`FAIL: ${failed.length} of ${results.length}`); process.exit(1); }
console.log(`ok: the agents chat's view and its checks, ${results.length} checks`);
