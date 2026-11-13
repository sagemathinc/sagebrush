// The page side of test_remote_agent_page.py: the Agents page's real agent leg (web/workspace/agent-relay.ts), its
// pairing over that leg (agent-pair.ts) and its permission cards (agent-cards.ts), with a real WebCrypto P-256 key and
// real DPoP proofs, the leg's socket bridged over stdio to the test, which plays the relay in front of a real runner
// with the vendored sagebrush-agent as its child. The workspace is a small one in memory.
// Lines in: "R <text>" a message from the relay to this page; "CLOSE" the socket closed; "C <json>" a command.
// Lines out: "W <text>" a message to the relay; "E <json>" an event.
//   bun engine/py/remote_agent_page.mjs <remote_id>
import { createInterface } from "node:readline";
import { AgentLeg, legKey, digestGate, DIGEST_CHARGE } from "../../web/workspace/agent-relay.ts";
import { AgentPairing } from "../../web/workspace/agent-pair.ts";
import { PermissionCards } from "../../web/workspace/agent-cards.ts";
import { permissionDigest } from "../../web/workspace/agent-canon.ts";

const [remoteId, kind] = process.argv.slice(2); // (kind: the agent kind to ask for, if any)
const say = (kind, o) => process.stdout.write(kind + " " + (typeof o === "string" ? o : JSON.stringify(o)) + "\n");

class StdioSocket {
  constructor() {
    this.readyState = 0;
    this.bufferedAmount = 0;
    this.handlers = { open: [], message: [], close: [], error: [] };
    StdioSocket.it = this;
    setTimeout(() => { this.readyState = 1; this.fire("open", {}); }, 0);
  }
  addEventListener(kind, f) { this.handlers[kind].push(f); }
  fire(kind, e) { for (const f of this.handlers[kind]) f(e); }
  send(text) { say("W", text); }
  close(code) { if (this.readyState === 3) return; this.readyState = 3; say("E", { t: "socket-close", code }); setTimeout(() => this.fire("close", { code: code ?? 1000, reason: "" }), 0); }
}

// (the workspace: files in memory, as the page's verbs give them)
const files = new Map();
const entry = (p) => ({ path: p, kind: "file", created: 1, updated: 1, size: (files.get(p) ?? "").length, rev: 1 });
const verbs = {
  list: async () => [...files.keys()].map(entry),
  stat: async (p) => (files.has(p) ? entry(p) : null),
  read: async (p) => { if (!files.has(p)) throw Object.assign(new Error("no such file"), { code: "missing" }); return { entry: entry(p), content: files.get(p), rev: 1 }; },
  write: async (p, c) => { files.set(p, String(c)); return { entry: entry(p), rev: 2 }; },
  create: async (p, o = {}) => { files.set(p, String(o.content ?? "")); return entry(p); },
  mkdir: async (p) => ({ path: p, kind: "folder", created: 1, updated: 1 }),
};
const store = { agentGrants: async () => ({}), putAgentGrant: async () => {} };

const key = await legKey();
const leg = new AgentLeg({ remoteId, url: "wss://relay.invalid/page", key, WebSocket: StdioSocket, ...(kind ? { agent: kind } : {}) });
let pairing = null;
const cards = new PermissionCards({ current: () => pairing, gate: digestGate, charge: DIGEST_CHARGE });
leg.on("end", (e) => say("E", { t: "end", end: e }));
leg.on("notice", (text) => say("E", { t: "notice", text }));
leg.on("open", (r) => {
  say("E", { t: "open", frame: r.frame, gen: r.gen, agent: r.agent, agents: r.agents });
  pairing = new AgentPairing(0, { link: leg, computer: "test" }, { verbsFor: () => verbs, store, trashEntry: async () => null, page: { origin: "https://sagebrush.space", path: "/agents/" } });
  pairing.paired().then((h) => say("E", { t: "paired", child: h.child, agent: h.agent }), (e) => say("E", { t: "pair-failed", why: String(e?.message ?? e) }));
  pairing.onNotification((method, params) => {
    if (method === "turn.event" && params?.event?.type === "attention" && params.event.state === "open") cards.admit(params.conversation, params.event);
    say("E", { t: "notify", method, params });
  });
});
leg.start();

createInterface({ input: process.stdin }).on("line", async (line) => {
  if (line === "CLOSE") return StdioSocket.it.readyState === 3 ? undefined : (StdioSocket.it.readyState = 3, StdioSocket.it.fire("close", { code: 1000, reason: "" }));
  if (line.startsWith("R ")) return StdioSocket.it.fire("message", { data: line.slice(2) });
  if (!line.startsWith("C ")) return;
  const c = JSON.parse(line.slice(2));
  if (c.do === "grant") { await pairing.allow({ folders: ["/"], write: true, expires: null }, false); return say("E", { t: "granted" }); }
  if (c.do === "chat") return say("E", { t: "sent", r: pairing.notifyWhy("chat.message", { conversation: c.conversation ?? "c1", id: c.id, author: "person", text: c.text }) });
  if (c.do === "answer") { cards.answer(c.id, c.allow, undefined, undefined, cards.instanceOf(c.id)); await cards.pending; return say("E", { t: "answered", id: c.id }); }
  if (c.do === "permission") {
    // (a hand-made answer: a wrong digest, or a right action's digest under another request_id)
    const digest = c.digest ?? await permissionDigest({ child: pairing.hello.child, conversation: c.card.conversation, request: c.digestRequest, tool: c.card.action.tool, input: c.card.action.input });
    return say("E", { t: "sent", r: pairing.notifyWhy("chat.permission", { request_id: c.id, behavior: "allow", digest }) });
  }
  if (c.do === "sized") {
    // (a chat message whose envelope is exactly `bytes`: its text padded to land on it)
    const base = (s) => JSON.stringify({ jsonrpc: "2.0", method: "chat.message", params: { conversation: "c1", id: c.id, author: "person", text: "é\"\\" + s } });
    const pad = c.bytes - leg.envelopeBytes(base(""));
    const text = "é\"\\" + "x".repeat(pad);
    return say("E", { t: "sent", bytes: leg.envelopeBytes(base("x".repeat(pad))), r: pairing.notifyWhy("chat.message", { conversation: "c1", id: c.id, author: "person", text }) });
  }
  if (c.do === "files") return say("E", { t: "files", files: Object.fromEntries([...files].map(([k, v]) => [k, v.length])) });
  if (c.do === "disconnect") { await pairing.revoke("revoked by the person"); return say("E", { t: "disconnected" }); }
});
