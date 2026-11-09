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

const failed = results.filter(([ok]) => !ok);
if (failed.length) { console.log(`FAIL: ${failed.length} of ${results.length}`); process.exit(1); }
console.log(`ok: the agents chat's view and its checks, ${results.length} checks`);
