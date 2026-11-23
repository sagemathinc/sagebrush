// ci: none (imported by the stand-in agent, test-delegate-host.mjs, not a suite itself)
// The stand-in agent's notes (agent memory v1, design/workspace-agent-protocol.md §7, draft): the memory.* page
// requests and the memory turn events, from notes kept in memory, as the protocol says and no more. CI can't import the
// agent's own repo, so this is what the page's lanes (C, E) are built and tested against until the agent's lands.
//   - Allowed only when the hello lists memory.1, the page's features list memory.1, and the last grant holds memory:
//     every memory.* is refused forbidden otherwise.
//   - Scopes: "own", or a tag id the grant enables. A note outside the grant answers not_found (never forbidden), and
//     list never counts it.
//   - A proposal is saved only by memory.save naming its pending id and current revision; save, edit and delete are
//     idempotent by decision_id (the same request, the same answer; another request with that id, conflict).
//   - Limits as §7.2: UTF-8 bytes with the metadata (name, description and scope count with the body).
// Controls for the rows: H.memory.propose(...) (as the model's memory_propose would, emitting memory_proposal on a
// turn), H.memory.used(...), H.memory.outside(note) (an edit made outside Sagebrush), H.memory.secret (a substring the
// scan refuses), H.memory.full (the store refuses saves).
const enc = new TextEncoder();
const hex = (n) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => b.toString(16).padStart(2, "0")).join("");
const bytes = (s) => enc.encode(s).length;

export const MEMORY_LIMITS = { note: 8 * 1024, store: 10 * 1024 * 1024, pending: 8, listPage: 200, query: 200, tags: 16 };
const HEX32 = /^[0-9a-f]{32}$/;
const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
// (a tag id, lane D's frozen format: 128 bits in lowercase base32, sagebrush-agent lib/tags.mjs)
export const TAG = /^[a-z2-7]{25}[aeimquy4]$/;
const DAY = 24 * 3600 * 1000;

/** The memory part of the stand-in agent: `H` is the delegate host (its send, answer, refuse, grant). */
export function memoryHost(H, { now = () => Date.now() } = {}) {
  const M = { notes: new Map(), pending: new Map(), ledger: new Map(), commits: 0, secret: null, full: false, decided: [] };
  const scopeKey = (s) => (s === "own" ? "own" : s && typeof s === "object" && TAG.test(s.tag ?? "") && Object.keys(s).length === 1 ? "tag:" + s.tag : null);
  const granted = () => {
    const m = H.grant?.memory;
    // (lane D's enabled: at most 16, strictly ascending, each a tag id; anything else is no grant at all)
    if (!m || !Array.isArray(m.tags) || m.tags.length > 16 || !m.tags.every((t, i) => TAG.test(t) && (i === 0 || m.tags[i - 1] < t))) return null;
    return new Set(["own", ...m.tags.map((t) => "tag:" + t)]);
  };
  const visible = (key) => granted()?.has(key) ?? false;
  const size = (n) => bytes(n.name) + bytes(n.description) + bytes(n.body) + bytes(n.scopeKey);
  const used = () => [...M.notes.values()].reduce((a, n) => a + size(n), 0);
  const scopeOut = (key) => (key === "own" ? "own" : { tag: key.slice(4) });
  const view = (n) => ({ note: n.note, scope: scopeOut(n.scopeKey), name: n.name, description: n.description, bytes: size(n), revision: n.revision, modified: n.modified, expires: n.expires, state: n.state !== "ok" ? n.state : n.expires !== null && n.expires <= now() ? "expired" : "ok", proposed_by: n.proposed_by });
  const checkFields = (f) => {
    if (typeof f.name !== "string" || !NAME.test(f.name)) return "bad_request";
    if (typeof f.description !== "string" || !f.description || f.description.length > 200 || /\n/.test(f.description)) return "bad_request";
    if (typeof f.body !== "string") return "bad_request";
    if (f.expires !== null && f.expires !== undefined && !Number.isSafeInteger(f.expires)) return "bad_request";
    if (bytes(f.name) + bytes(f.description) + bytes(f.body) + bytes(f.scopeKey) > MEMORY_LIMITS.note) return "too_large";
    if (M.secret && [f.name, f.description, f.body].some((x) => x.includes(M.secret))) return "secret";
    return null;
  };
  // (idempotent by decision_id, as §6.1's merge_id: each id keeps its request and its answer, whatever it was; the same
  //  exact request gets the same answer again, another request under that id is refused conflict)
  const once = (id, p, f) => {
    if (!HEX32.test(p.decision_id ?? "")) return { error: "bad_request" };
    const key = JSON.stringify(p);
    const prior = M.ledger.get(p.decision_id);
    if (prior) return prior.key === key ? prior.result : { error: "conflict" };
    const result = f();
    M.ledger.set(p.decision_id, { key, result });
    return result;
  };
  const commit = () => ++M.commits;

  /** The model's memory_propose, as the agent would emit it on a turn. Returns the proposal. */
  M.propose = (send, { op = "new", note, scope = "own", name, description, body, expires } = {}) => {
    const key = scopeKey(scope);
    if (!key || !visible(key)) return null;
    if (M.pending.size >= MEMORY_LIMITS.pending) return null;
    const pr = { pending: hex(16), revision: 1, op, ...(note ? { note } : {}), scope, name, description, body, expires: expires ?? now() + 90 * DAY };
    M.pending.set(pr.pending, pr);
    send({ type: "memory_proposal", ...pr });
    return pr;
  };
  /** A new revision of a proposal (the model revising it): the card is replaced. */
  M.revise = (send, pending, change) => {
    const pr = M.pending.get(pending);
    Object.assign(pr, change, { revision: pr.revision + 1 });
    send({ type: "memory_proposal", ...pr });
    return pr;
  };
  M.used = (send, notes) => send({ type: "memory_used", notes: notes.map((n) => ({ note: n.note, name: n.name, revision: n.revision })) });
  M.outside = (note, body) => {
    const n = M.notes.get(note);
    Object.assign(n, { body, state: "outside_edit", revision: n.revision + 1, modified: now() });
  };
  M.add = ({ scope = "own", name, description, body = "", expires = null }) => {
    const n = { note: hex(16), scopeKey: scopeKey(scope), name, description, body, revision: 1, modified: now(), expires, state: "ok", proposed_by: "Claude Code" };
    M.notes.set(n.note, n);
    commit();
    return n;
  };

  M.handle = (m) => {
    const p = m.params ?? {};
    if (!granted()) return H.refuse(m.id, "forbidden");
    const r = request(m.method, p);
    return r.error ? H.refuse(m.id, r.error) : H.answer(m.id, r);
  };
  function request(method, p) {
    switch (method) {
      case "memory.list": {
        if (p.query !== undefined && (typeof p.query !== "string" || p.query.length > MEMORY_LIMITS.query)) return { error: "bad_request" };
        const want = p.scope === undefined ? null : scopeKey(p.scope);
        if (p.scope !== undefined && !want) return { error: "bad_request" };
        const q = p.query?.toLowerCase();
        let all = [...M.notes.values()].filter((n) => visible(n.scopeKey) && (!want || n.scopeKey === want) && (!q || [n.name, n.description, n.body].some((x) => x.toLowerCase().includes(q))));
        all.sort((a, b) => (a.note < b.note ? -1 : 1));
        if (p.after) all = all.filter((n) => n.note > p.after);
        const page = all.slice(0, MEMORY_LIMITS.listPage);
        return { notes: page.map(view), next: all.length > page.length ? page.at(-1).note : null, usage: { bytes: used(), limit: MEMORY_LIMITS.store }, path: "/home/person/.local/share/sagebrush-agent/memory" };
      }
      case "memory.get": {
        const n = M.notes.get(p.note);
        if (!n || !visible(n.scopeKey)) return { error: "not_found" };
        return { ...view(n), body: n.body };
      }
      case "memory.save": return once(null, p, () => {
        const pr = M.pending.get(p.pending);
        if (!pr) return { error: "not_found" };
        if (p.revision !== pr.revision) return { error: "stale" };
        const f = { ...pr, ...(p.edit ?? {}) };
        const key = scopeKey(f.scope);
        if (!key) return { error: "bad_request" };
        // (the grant rechecked at commit: a scope the grant no longer holds is stale)
        if (!visible(key)) return { error: "stale" };
        const bad = checkFields({ ...f, scopeKey: key });
        if (bad) return { error: bad };
        if (M.full || used() + bytes(f.name) + bytes(f.description) + bytes(f.body) > MEMORY_LIMITS.store) return { error: "full" };
        let n;
        if (pr.op === "edit") {
          n = M.notes.get(pr.note);
          if (!n || !visible(n.scopeKey)) return { error: "not_found" };
          Object.assign(n, { scopeKey: key, name: f.name, description: f.description, body: f.body, expires: f.expires, revision: n.revision + 1, modified: now() });
        } else {
          if ([...M.notes.values()].some((x) => x.scopeKey === key && x.name === f.name)) return { error: "conflict" };
          n = { note: hex(16), scopeKey: key, name: f.name, description: f.description, body: f.body, revision: 1, modified: now(), expires: f.expires ?? null, state: "ok", proposed_by: "Claude Code" };
          M.notes.set(n.note, n);
        }
        M.pending.delete(p.pending);
        commit();
        M.decided.push({ pending: p.pending, outcome: "saved", note: n.note });
        return { note: n.note, revision: n.revision };
      });
      case "memory.dismiss": {
        const pr = M.pending.get(p.pending);
        if (!pr) return { error: "not_found" };
        if (p.revision !== pr.revision) return { error: "stale" };
        M.pending.delete(p.pending);
        M.decided.push({ pending: p.pending, outcome: "dismissed" });
        return {};
      }
      case "memory.edit": return once(null, p, () => {
        const n = M.notes.get(p.note);
        if (!n || !visible(n.scopeKey)) return { error: "not_found" };
        if (p.revision !== n.revision) return { error: "stale" };
        const key = p.scope === undefined ? n.scopeKey : scopeKey(p.scope);
        if (!key || !visible(key)) return { error: "not_found" };
        const f = { name: p.name ?? n.name, description: p.description ?? n.description, body: p.body ?? n.body, expires: p.expires === undefined ? n.expires : p.expires, scopeKey: key };
        const bad = checkFields(f);
        if (bad) return { error: bad };
        Object.assign(n, f, { revision: n.revision + 1, modified: now(), state: "ok" });
        commit();
        return { note: n.note, revision: n.revision };
      });
      case "memory.delete": return once(null, p, () => {
        const n = M.notes.get(p.note);
        if (!n || !visible(n.scopeKey)) return { error: "not_found" };
        if (p.revision !== n.revision) return { error: "stale" };
        M.notes.delete(p.note);
        commit();
        return { deleted: true };
      });
      case "memory.accept": return once(null, p, () => {
        const n = M.notes.get(p.note);
        if (!n || !visible(n.scopeKey)) return { error: "not_found" };
        if (p.revision !== n.revision || n.state !== "outside_edit") return { error: "stale" };
        n.state = "ok";
        commit();
        return { note: n.note, revision: n.revision };
      });
      default: return { error: "bad_request" };
    }
  }
  return M;
}
