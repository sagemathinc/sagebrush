// ci: web-runner order=168 runner=bun
// The web tools' cards (step 4, egress.turn): the agent's fetch and the built-in search, checked key by key in the one
// form the agent sends (agent-egress.ts); their three answers, each with its own action and digest (agent-cards.ts); the
// card as the chat draws it (view.ts); and the tool rows' fixed label for a summary in another form (events.ts).
//   bun web/workspace/test-agent-egress.mjs
import { egressOf, turnInputOf, visible, webSummary, WEB_FETCH, WEB_SEARCH } from "./agent-egress.ts";
import { PermissionCards } from "./agent-cards.ts";
import { digestGate, DIGEST_CHARGE } from "./agent-relay.ts";
import { permissionDigest } from "./agent-canon.ts";
import { newThread, apply } from "./agent-chat/events.ts";
import { turnNode } from "./agent-chat/view.ts";
import { FEATURES } from "./agent-pair.ts";

let failures = 0;
const ok = (c, msg, detail) => { console.log((c ? "ok   " : "FAIL ") + msg + (c || detail === undefined ? "" : " " + JSON.stringify(detail).slice(0, 300))); if (!c) failures++; };
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

const fetchIn = (o = {}) => ({ origin: "https://github.com", path: "/sagebrush/repo/blob/main/README.md", reason: "the README", ...o });
const searchIn = (o = {}) => ({ provider: "Anthropic", reason: "", ...o });

// ---- (1) the request, key by key
{
  const good = egressOf(WEB_FETCH, fetchIn());
  ok(good !== "bad" && good?.kind === "fetch" && good.host === "github.com", "a fetch in the agent's form: its origin, host and path", good);
  ok(egressOf("WebFetch", { url: "https://x/" }) === null && egressOf("mcp__sagebrush_page__workspace_write", {}) === null, "other tools aren't web cards");
  const bad = {
    "an extra key": fetchIn({ url: "https://github.com/?q=secret" }),
    "a missing reason": (({ reason, ...r }) => r)(fetchIn()),
    "a query in the path": fetchIn({ path: "/search?q=secret" }),
    "a fragment in the path": fetchIn({ path: "/a#b" }),
    "a space in the path": fetchIn({ path: "/a b" }),
    "a control in the path": fetchIn({ path: "/a\u0000b" }),
    "a non-ASCII path": fetchIn({ path: "/é" }),
    "a broken escape": fetchIn({ path: "/a%G1" }),
    "a split escape": fetchIn({ path: "/a%4" }),
    "a path not from /": fetchIn({ path: "a" }),
    "a path over 200 bytes": fetchIn({ path: "/" + "a".repeat(200) }),
    "an uppercase host": fetchIn({ origin: "https://GitHub.com" }),
    "a trailing dot": fetchIn({ origin: "https://github.com." }),
    "a port": fetchIn({ origin: "https://github.com:443" }),
    "http": fetchIn({ origin: "http://github.com" }),
    "userinfo": fetchIn({ origin: "https://a@github.com" }),
    "an IPv4 literal": fetchIn({ origin: "https://127.0.0.1" }),
    "a decimal host": fetchIn({ origin: "https://2130706433" }),
    "an IPv6 literal": fetchIn({ origin: "https://[::1]" }),
    "a Unicode host": fetchIn({ origin: "https://gіthub.com" }),
    "a path on the origin": fetchIn({ origin: "https://github.com/" }),
    "a reason over 200 characters": fetchIn({ reason: "r".repeat(201) }),
    "a search with terms": searchIn({ query: "secret" }),
    "a search's provider not a name": searchIn({ provider: "<b>x</b>" }),
  };
  const passed = Object.entries(bad).filter(([, i]) => egressOf(i.provider !== undefined || i.query !== undefined ? WEB_SEARCH : WEB_FETCH, i) !== "bad").map(([k]) => k);
  ok(passed.length === 0, `each other form is refused (shown with Deny only): ${Object.keys(bad).length} forms`, passed);
  ok(egressOf(WEB_FETCH, fetchIn({ path: "/" + "a".repeat(199) + "…" })) !== "bad" && egressOf(WEB_FETCH, fetchIn({ path: "/%E2%80%AE" })) !== "bad", "a path the agent cut (200 bytes, then …) and an escape kept as it is are its form");
  ok(egressOf(WEB_FETCH, fetchIn({ origin: "https://xn--gthub-n4a.com" })) !== "bad", "a punycode host is its form (shown in ASCII)");
  ok(egressOf(WEB_FETCH, fetchIn({ reason: "r".repeat(200) })) !== "bad" && egressOf(WEB_FETCH, fetchIn({ reason: "😀".repeat(200) })) !== "bad", "a reason of 200 characters, counted as Unicode scalars");
}

// ---- (2) the "for this turn" action matches its request exactly, or there's none
{
  const eg = egressOf(WEB_FETCH, fetchIn());
  const t = (input, tool = "egress.turn") => turnInputOf(eg, { tool, input });
  ok(JSON.stringify(t({ origin: "https://github.com" })) === '{"origin":"https://github.com"}', "the same origin: the turn action");
  const off = ["https://GitHub.com", "https://github.com.", "https://github.com:443", "https://xn--github-xyz.com", "https://api.github.com", "http://github.com"].filter((o) => t({ origin: o }) !== null);
  ok(off.length === 0, "an origin that differs by case, a trailing dot, a port, punycode, a subdomain or scheme: none", off);
  ok(t({ origin: "https://github.com", path: "/" }) === null && t({ origin: "https://github.com" }, "egress.always") === null && turnInputOf(eg, null) === null, "an extra key, another tool, or no action: none");
  const s = egressOf(WEB_SEARCH, searchIn());
  ok(turnInputOf(s, { tool: "egress.turn", input: { provider: "Anthropic" } }) !== null && turnInputOf(s, { tool: "egress.turn", input: { origin: "https://github.com" } }) === null && turnInputOf(eg, { tool: "egress.turn", input: { provider: "Anthropic" } }) === null, "a search's turn action is its provider's, never an origin's, and the reverse");
}

// ---- (3) the cards: three answers, each with its own action and digest
const mk = (features = ["permission.digest", "egress.turn"]) => ({ state: "granted", link: {}, hello: { child: "ch", features }, sent: [], notify(m, p) { this.sent.push({ m, ...p }); return true; } });
const card = (id, action, turn_action) => ({ type: "attention", id, kind: "permission", state: "open", title: "?", child: "ch", conversation: "conv", request_id: id, action, ...(turn_action ? { turn_action } : {}) });
const FETCH = { tool: WEB_FETCH, input: fetchIn() };
const TURN = { tool: "egress.turn", input: { origin: "https://github.com" } };
const D = (tool, input, id) => permissionDigest({ child: "ch", conversation: "conv", request: id, tool, input });
{
  const p = mk();
  const cards = new PermissionCards({ current: () => p, gate: digestGate, charge: DIGEST_CHARGE, egressTurn: true });
  const v = cards.view("conv", "t1", card("e1", FETCH, TURN));
  ok(v?.buttons === "three" && v.turn_label === "Allow github.com for this turn" && v.allow === "Allow this request" && v.title === "Allow this agent to connect to github.com for the rest of this turn?", "both sides offer egress.turn and the turn action matches: three buttons, worded from the checked origin", v);
  ok(v.summary === "https://github.com/sagebrush/repo/blob/main/README.md" && v.reason === "Reason: the README" && v.detail === "", "the card shows the origin and path, and the reason after the fixed sentences; no raw request", v);
  ok(cards.answer("e1", "turn", "conv", "t1", cards.instanceOf("e1")) === true, "For this turn claims the card");
  await cards.pending;
  ok(p.sent.length === 1 && p.sent[0].behavior === "allow_turn" && p.sent[0].digest === (await D("egress.turn", { origin: "https://github.com" }, "e1")) && p.sent[0].digest !== (await D(WEB_FETCH, fetchIn(), "e1")), "…answered allow_turn with the digest of the turn action, never the request's", p.sent);
  ok(cards.answer("e1", true, "conv", "t1", cards.instanceOf("e1")) === false, "…once only: Allow after it answers nothing");
}
{
  const p = mk();
  const cards = new PermissionCards({ current: () => p, gate: digestGate, charge: DIGEST_CHARGE, egressTurn: true });
  cards.view("conv", "t1", card("e2", FETCH, TURN));
  cards.answer("e2", true, "conv", "t1", cards.instanceOf("e2"));
  await cards.pending;
  ok(p.sent.length === 1 && p.sent[0].behavior === "allow" && p.sent[0].digest === (await D(WEB_FETCH, fetchIn(), "e2")) && p.sent[0].digest !== (await D("egress.turn", { origin: "https://github.com" }, "e2")), "Allow this request: allow, with the request's digest, never the turn action's", p.sent);
}
{
  // (no "for this turn" unless both sides offer it and the action matches; then "turn" answers nothing)
  const cases = {
    "this page doesn't offer it": [mk(), false, TURN],
    "the agent doesn't offer it": [mk(["permission.digest"]), true, TURN],
    "no turn action": [mk(), true, undefined],
    "a turn action for another origin": [mk(), true, { tool: "egress.turn", input: { origin: "https://gist.github.com" } }],
  };
  for (const [what, [p, offered, ta]] of Object.entries(cases)) {
    const cards = new PermissionCards({ current: () => p, gate: digestGate, charge: DIGEST_CHARGE, egressTurn: offered });
    const v = cards.view("conv", "t1", card("e3", FETCH, ta));
    const turned = cards.answer("e3", "turn", "conv", "t1", cards.instanceOf("e3"));
    await cards.pending;
    ok(v?.buttons === "two" && !v.turn_label && v.title === "Allow this agent to connect to github.com for this request?" && turned === false && p.sent.length === 0, `${what}: two buttons, and For this turn can't be sent`, { v, sent: p.sent });
  }
}
{
  const p = mk();
  const cards = new PermissionCards({ current: () => p, gate: digestGate, charge: DIGEST_CHARGE, egressTurn: true });
  const v = cards.view("conv", "t1", card("e4", { tool: WEB_FETCH, input: fetchIn({ path: "/s?q=secret" }) }, TURN));
  ok(v?.buttons === "deny" && !JSON.stringify(v).includes("secret"), "a fetch in another form (a query): Deny only, and nothing of it shown", v);
  ok(cards.answer("e4", true, "conv", "t1", cards.instanceOf("e4")) === false && cards.answer("e4", "turn", "conv", "t1", cards.instanceOf("e4")) === false, "…an Allow of either kind answers nothing");
  ok(cards.answer("e4", false, "conv", "t1", cards.instanceOf("e4")) === true && p.sent.length === 1 && p.sent[0].behavior === "deny", "…Deny answers deny");
}
{
  const p = mk();
  const cards = new PermissionCards({ current: () => p, gate: digestGate, charge: DIGEST_CHARGE, egressTurn: true });
  const v = cards.view("conv", "t1", card("e5", { tool: WEB_SEARCH, input: searchIn({ reason: "look it up" }) }, { tool: "egress.turn", input: { provider: "Anthropic" } }));
  ok(v?.buttons === "three" && v.turn_label === "Allow search for this turn" && v.allow === "Allow this search" && v.summary === "" && /Anthropic/.test(v.body), "a search: its provider named, no terms shown, three buttons", v);
  cards.answer("e5", "turn", "conv", "t1", cards.instanceOf("e5"));
  await cards.pending;
  ok(p.sent[0]?.behavior === "allow_turn" && p.sent[0].digest === (await D("egress.turn", { provider: "Anthropic" }, "e5")), "…For this turn: the digest of the search's own turn action", p.sent);
}

// ---- (4) the card as drawn, and the model's text shown visibly
{
  ok(visible("go ‮evil") === "go \\u{202e}evil" && visible("a\nb​c") === "a\\u{000a}b\\u{200b}c", "control, bidi and zero-width characters written out visibly");
  const p = mk();
  const cards = new PermissionCards({ current: () => p, gate: digestGate, charge: DIGEST_CHARGE, egressTurn: true });
  const v = cards.view("conv", "t1", card("e6", { tool: WEB_FETCH, input: fetchIn({ reason: "fetch ‮<img src=x>" }) }, TURN));
  const t = newThread("conv", "chat");
  apply(t, { seq: 1, turn_id: "t1", type: "turn_started" });
  apply(t, { seq: 2, turn_id: "t1", ...v });
  // (no DOM here: the node's HTML as written; the browser row clicks the real one)
  const shown = globalThis.document;
  globalThis.document = { createElement: () => ({ innerHTML: "", className: "", querySelectorAll: () => [] }) };
  let html = "";
  try { html = turnNode(t, t.entries.find((e) => e.kind === "turn"), { answer() {}, openArtifact() {}, md: (s) => s }).innerHTML; }
  finally { globalThis.document = shown; }
  const buttons = [...html.matchAll(/<button[^>]*data-approve="([^"]*)"[^>]*>([^<]*)<\/button>/g)].map((m) => `${m[1]}:${m[2]}`);
  ok(JSON.stringify(buttons) === JSON.stringify(["turn:Allow github.com for this turn", "1:Allow this request", "0:Deny"]), "three buttons, in order, Deny last", buttons);
  const reason = /<div class="att-reason">([^<]*)<\/div>/.exec(html)?.[1];
  ok(!/<img|<a /.test(html) && reason === "Reason: fetch \\u{202e}&lt;img src=x&gt;", "the reason is plain text, its bidi character written out; nothing is a link", reason);
}

// ---- (4b) each drawn button, clicked through the view's own handler, wired to the cards as the page wires them
for (const [which, want] of [["turn", "allow_turn"], ["1", "allow"], ["0", "deny"]]) {
  const p = mk();
  const cards = new PermissionCards({ current: () => p, gate: digestGate, charge: DIGEST_CHARGE, egressTurn: true });
  const t = newThread("conv", "chat");
  apply(t, { seq: 1, turn_id: "t1", type: "turn_started" });
  apply(t, { seq: 2, turn_id: "t1", ...cards.view("conv", "t1", card("b-" + which, FETCH, TURN)) });
  const shown = globalThis.document, buttons = [];
  globalThis.document = { createElement: () => { const el = { innerHTML: "", className: "", querySelectorAll: (sel) => {
    if (sel !== "[data-approve]") return [];
    const card = /data-attention="([^"]*)" data-instance="([^"]*)"/.exec(el.innerHTML);
    for (const m of el.innerHTML.matchAll(/data-approve="([^"]*)"/g)) buttons.push({ dataset: { approve: m[1] }, closest: () => ({ dataset: { attention: card[1], instance: card[2] } }) });
    return buttons;
  } }; return el; } };
  try { turnNode(t, t.entries.find((e) => e.kind === "turn"), { answer: (att, yes, turn, instance) => cards.answer(att, yes, "conv", turn, instance), openArtifact() {}, md: (x) => x }); }
  finally { globalThis.document = shown; }
  buttons.find((b) => b.dataset.approve === which).onclick();
  await cards.pending;
  const tool = want === "allow_turn" ? "egress.turn" : WEB_FETCH, input = want === "allow_turn" ? { origin: "https://github.com" } : fetchIn();
  ok(p.sent.length === 1 && p.sent[0].behavior === want && (want === "deny" || p.sent[0].digest === (await D(tool, input, "b-" + which))), `the drawn ${which === "turn" ? "For this turn" : which === "1" ? "Allow this request" : "Deny"} button answers ${want}${want === "deny" ? "" : ", with its own action's digest"}`, p.sent);
}

// ---- (5) the tool rows: a web tool's summary in another form is replaced by a fixed label, nothing of it kept
{
  ok(webSummary(WEB_FETCH, "https://github.com/a/b") === "https://github.com/a/b" && webSummary(WEB_SEARCH, "Anthropic") === "Anthropic", "a web row's summary in the agent's form is kept");
  ok(webSummary(WEB_FETCH, "https://github.com/s?q=secret") === "(address withheld)" && webSummary("web_fetch", "https://evil.com/#tok") === "(address withheld)" && webSummary(WEB_SEARCH, "secret terms here?") === "(search withheld)" && webSummary(WEB_FETCH, undefined) === "(address withheld)", "a query, a fragment or search terms: the fixed label");
  ok(webSummary("mcp__sagebrush_page__workspace_read", "/a?b") === "/a?b", "other tools' rows unchanged");
  const t = newThread("conv", "chat");
  apply(t, { seq: 1, turn_id: "t1", type: "tool_call_started", call: "c1", tool: "tool", name: WEB_FETCH, summary: "https://x.com/?token=secret" });
  apply(t, { seq: 2, turn_id: "t1", type: "tool_call_finished", call: "c1", status: "ok", summary: "https://x.com/?token=again", body: "" });
  ok(!JSON.stringify(t).includes("secret") && !JSON.stringify(t).includes("again") && t.entries[0].tools.c1.summary === "(address withheld)", "the thread keeps only the label, started or finished", t.entries[0].tools.c1);
}

// ---- (6) the feature
ok(FEATURES.includes("egress.turn"), "the pairing takes egress.turn from an agent's hello");

console.log(failures ? `FAIL: ${failures} of the web cards' checks` : "ok: the web cards' checks");
process.exit(failures ? 1 : 0);
