// ci: none (imported by other suites, not one itself: web/agents/test-delegate.mjs)
// A stand-in Delegate host for the page's tests: a loopback WebSocket that pairs like sagebrush-agent (its hello lists
// delegate.1) and answers tasks.* from tasks kept in memory (design/workspace-agent-protocol.md §6.1), with task.event
// notifications. CI can't import the agent's own repo, so this is the agent's behavior as the protocol says it, no
// more: every tasks.* is refused (forbidden) unless the page's last grant.changed holds delegate: true, as the agent
// checks; a grant without it ends the tasks' turns (their status goes to interrupted). tasks.merged is idempotent by
// merge_id, as the agent's: the same request gets the same answer, another one with that merge_id is refused. Controls for the rows: `hold`
// (methods left unanswered until `release`), `fail` (methods answered with an error code), `pageSize` (tasks.get's events per answer).
import { blobId } from "../workspace/tasks-schema.ts";

const enc = new TextEncoder();
const hex = (n) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => b.toString(16).padStart(2, "0")).join("");

export function delegateHost({ features = ["delegate.1", "chat.resume"], pageSize = 50, session = "SECRET" } = {}) {
  const H = { staleCloses: 0, got: [], grant: null, sock: null, closed: false, tasks: new Map(), hold: new Set(), fail: new Map(), held: [], pageSize, changes: [], asks: [] };
  const send = (m) => H.sock?.send(JSON.stringify(m));
  const entryOf = (t) => ({ task: t.task, title: t.title, status: t.status, target: "local", run: t.run, round: t.round, seq: t.log.length, proposal: t.proposal, question: false, updated: t.updated });
  H.emit = (id, event) => {
    const t = H.tasks.get(id);
    const seq = t.log.length + 1;
    t.log.push({ seq, event });
    t.updated = Date.now() + seq;
    if (event.type === "task_status") t.status = event.status;
    if (event.type === "proposal") { t.round = event.round; t.proposal = event.commit; }
    if (H.grant?.delegate === true) send({ jsonrpc: "2.0", method: "task.event", params: { task: id, seq, event } });
    return seq;
  };
  // (a task: its base files, and its proposal's (path -> text, or null for a deleted file), each commit with its blobs)
  H.addTask = async ({ title = "A task", base = {}, proposal = null, status = "working", run = false } = {}) => {
    const t = { task: hex(16), title, status: "working", run, round: 0, proposal: null, updated: Date.now(), log: [], base: hex(20), commits: new Map() };
    const blobs = async (files) => Object.fromEntries(await Promise.all(Object.entries(files).map(async ([p, c]) => [p, c === null ? null : { content: c, blob: await blobId(enc.encode(typeof c === "string" ? c : "")) }])));
    t.commits.set(t.base, await blobs(base));
    H.tasks.set(t.task, t);
    H.emit(t.task, { type: "task_status", status: "working" });
    if (proposal) await H.propose(t.task, proposal);
    if (status !== "working" && status !== t.status) H.emit(t.task, { type: "task_status", status });
    return t;
  };
  H.propose = async (id, files) => {
    const t = H.tasks.get(id), commit = hex(20), base = t.commits.get(t.base);
    const at = {};
    for (const [p, c] of Object.entries(files)) if (c !== null) at[p] = { content: c, blob: await blobId(enc.encode(c)) };
    for (const [p, v] of Object.entries(base)) if (!(p in files)) at[p] = v;
    t.commits.set(commit, at);
    const changed = Object.keys(files).sort().map((path) => {
      const b = base[path] ?? null, n = at[path] ?? null;
      return { path, kind: path.endsWith(".ipynb") ? "notebook" : "file", change: !b ? "added" : !n ? "deleted" : "modified", base_blob: b?.blob ?? null, blob: n?.blob ?? null };
    });
    t.diffs = { ...(t.diffs ?? {}), [commit]: changed };
    H.emit(id, { type: "proposal", round: t.round + 1, base: t.base, commit, files: changed });
    H.emit(id, { type: "task_status", status: "proposal" });
    return commit;
  };
  const refuse = (id, code, message = code) => send({ jsonrpc: "2.0", id, error: { code: -32000, message, data: { code } } });
  const answer = (id, result) => send({ jsonrpc: "2.0", id, result });
  function task(m) {
    const p = m.params ?? {}, t = H.tasks.get(p.task);
    switch (m.method) {
      case "tasks.list": return answer(m.id, { tasks: [...H.tasks.values()].map(entryOf) });
      case "tasks.start": {
        const t2 = { task: hex(16), title: p.title, status: "working", run: p.run, round: 0, proposal: null, updated: Date.now(), log: [], base: hex(20), commits: new Map() };
        t2.commits.set(t2.base, Object.fromEntries(p.docs.map((d) => [d.path, { content: d.content, blob: "" }])));
        H.tasks.set(t2.task, t2);
        answer(m.id, { task: t2.task, base: t2.base, seq: 0 });
        H.emit(t2.task, { type: "task_status", status: "working" });
        return;
      }
      case "tasks.get": {
        if (!t) return refuse(m.id, "not_found");
        const reset = p.after > t.log.length;
        const from = reset ? 0 : p.after;
        const events = t.log.slice(from, from + H.pageSize);
        return answer(m.id, { task: entryOf(t), events, last: events.at(-1)?.seq ?? from, reset });
      }
      case "tasks.diff": {
        const files = t?.diffs?.[p.commit];
        if (!files) return refuse(m.id, "not_found");
        return answer(m.id, { task: t.task, base: t.base, commit: p.commit, round: t.round, seq: t.log.length, files });
      }
      case "tasks.file": {
        const f = t?.commits.get(p.commit)?.[p.path];
        if (!f) return refuse(m.id, "not_found");
        return answer(m.id, { blob: f.blob, content: f.content });
      }
      case "tasks.close": {
        if (!t) return refuse(m.id, "not_found");
        // (only the proposal as it was read: a task that moved on since is stale, and nothing is closed)
        if (p.proposal !== t.proposal || p.seq !== t.log.length) return refuse(m.id, "stale", "the task moved on");
        H.emit(t.task, { type: "task_status", status: "closed" });
        return answer(m.id, { status: "closed" });
      }
      case "tasks.merged": {
        if (!t) return refuse(m.id, "not_found");
        // (idempotent by the exact request: the same merge_id and bytes, the same answer; another payload, conflict)
        const key = JSON.stringify(p);
        H.ledger ??= new Map();
        const prior = H.ledger.get(p.merge_id);
        if (prior) return prior.key === key ? answer(m.id, prior.answer) : refuse(m.id, "conflict", "this merge_id was used with another request");
        if (t.status === "merged" || t.status === "closed") return refuse(m.id, "final", `the task is ${t.status}`);
        if (t.status !== "proposal" || p.proposal !== t.proposal || p.seq !== t.log.length) return refuse(m.id, "stale", "the task has moved on from that proposal");
        const want = t.diffs[t.proposal];
        if (p.files.length !== want.length || !p.files.every((f) => want.some((w) => w.path === f.path && w.blob === f.proposal_blob))) return refuse(m.id, "bad_request", "files must be exactly the proposal's changed paths");
        const full = p.files.every((f) => f.mine !== null && f.merged !== null);
        const result = { recorded: full ? "merge" : "receipt", commit: full ? hex(20) : null };
        H.ledger.set(p.merge_id, { key, answer: result });
        H.emit(t.task, { type: "task_status", status: "merged" });
        return answer(m.id, result);
      }
      case "tasks.ask": {
        // (as the agent checks: the task's latest proposal at its seq, and only the task's own documents)
        if (!t) return refuse(m.id, "not_found");
        if (t.status !== "proposal" || p.proposal !== t.proposal || p.seq !== t.log.length) return refuse(m.id, "stale");
        const own = t.commits.get(t.base) ?? {};
        // (and, as its schema checks: a note of 1 to 64 KiB; each current version a string of the task's, its kind by its path, no path twice)
        if (typeof p.note !== "string" || !p.note || enc.encode(p.note).length > 64 * 1024) return refuse(m.id, "bad_request");
        if (!Array.isArray(p.current) || new Set(p.current.map((d) => d.path)).size !== p.current.length) return refuse(m.id, "bad_request");
        if (!p.current.every((d) => Object.hasOwn(own, d.path) && typeof d.content === "string" && d.kind === (d.path.endsWith(".ipynb") ? "notebook" : "file"))) return refuse(m.id, "bad_request");
        H.asks.push({ task: t.task, note: p.note, current: p.current });
        answer(m.id, { status: "working", round: t.round });
        H.emit(t.task, { type: "task_status", status: "working" });
        return;
      }
      case "tasks.revoke": {
        if (!t) return refuse(m.id, "not_found");
        H.emit(t.task, { type: "task_status", status: "closed" });
        return answer(m.id, { status: "closed" });
      }
      default: return refuse(m.id, "bad_request");
    }
  }
  // (chat.brief, for an agent whose features list it: H.briefs maps a conversation to its answer, {title, brief,
  //  bytes, cut} or {error: code}; any other conversation is not_found. chat.brief_cancel answers a held draft of that
  //  conversation as stopped, as the agent does)
  H.briefs = new Map();
  function brief(m) {
    const a = H.briefs.get(m.params?.conversation);
    if (!a) return refuse(m.id, "not_found", "no such conversation");
    return a.error ? refuse(m.id, a.error, a.error) : answer(m.id, a);
  }
  // (the agent's own requests to the page: a workspace verb, as Pair's tools call them)
  let cn = 0;
  const calls = new Map();
  H.call = (method, params, ms = 10000) => new Promise((resolve, reject) => {
    const id = "s" + ++cn;
    calls.set(id, resolve);
    send({ jsonrpc: "2.0", id, method, params });
    setTimeout(() => { if (calls.delete(id)) reject(new Error("no answer to " + method)); }, ms);
  });
  /** Answer the held requests now, as if they had just come. */
  H.release = () => { for (const m of H.held.splice(0)) (m.method === "chat.brief" ? brief(m) : task(m)); };
  H.srv = Bun.serve({
    port: 0, hostname: "127.0.0.1",
    fetch(req, srv) { return srv.upgrade(req) ? undefined : new Response("no", { status: 400 }); },
    websocket: {
      open(ws) { H.sock = ws; H.closed = false; },
      message(ws, data) {
        const m = JSON.parse(String(data));
        H.got.push(m);
        if (m.method === undefined && calls.has(m.id)) { calls.get(m.id)(m); calls.delete(m.id); return; }
        if (m.method === "hello") return answer(m.id, { protocol: 1, agent: { name: "Claude Code", client: "claude-code", version: "2.0" }, wants: { write: true, run: false }, session, features });
        if (m.method === "grant.changed") {
          const g = Array.isArray(m.params?.folders) ? m.params : null;
          // (the switch off: the tasks' turns end, interrupted, not closed)
          if (H.grant?.delegate === true && g?.delegate !== true) for (const t of H.tasks.values()) if (t.status === "working") H.emit(t.task, { type: "task_status", status: "interrupted" });
          H.grant = g;
          H.changes.push(g);
          return;
        }
        if (m.method === "chat.brief") return void (H.hold.has(m.method) ? H.held.push(m) : brief(m));
        if (m.method === "chat.brief_cancel") {
          const i = H.held.findIndex((x) => x.method === "chat.brief" && x.params?.conversation === m.params?.conversation);
          if (i >= 0) refuse(H.held.splice(i, 1)[0].id, "stopped", "cancelled");
          return;
        }
        if (typeof m.method !== "string" || !m.method.startsWith("tasks.")) return;
        if (H.hold.has(m.method)) return void H.held.push(m);
        if (H.fail.has(m.method)) return refuse(m.id, H.fail.get(m.method));
        if (H.grant?.delegate !== true) return refuse(m.id, "forbidden");
        task(m);
      },
      // (only the current connection's close ends it: a page reloaded opens a new one, and the old one's close can come
      //  after it (a slow runner), which must not cut the new one off; such late closes are counted, to be reported)
      close(ws) { if (H.sock === ws) { H.closed = true; H.sock = null; } else H.staleCloses++; },
    },
  });
  H.port = H.srv.port;
  H.stop = () => H.srv.stop(true);
  return H;
}
