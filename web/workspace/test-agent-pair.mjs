// The page's side of a pairing (agent-pair.ts) against a fake sagebrush-mcp: a loopback WebSocket that answers
// the hello and sends verbs, and an in-memory workspace behind forAgent.  What it shows: the hello, nothing done
// before the person's grant, the grant's scope, the frame and call limits, and that revoking (or expiry) cuts
// the agent off at once and forgets the kept grant.
//   bun web/workspace/test-agent-pair.mjs
import { AgentPairing, parseStrict, actorOf } from "./agent-pair.ts";

let failures = 0;
const ok = (c, msg) => { console.log((c ? "ok   " : "FAIL ") + msg); if (!c) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (f, ms = 3000) => { const t = Date.now(); while (Date.now() - t < ms) { if (f()) return true; await sleep(10); } return false; };

// ---- a fake server: records what the page sends; `script` decides the hello's answer
function server(answerHello) {
  const S = { got: [], closed: null, sock: null, pending: new Map(), n: 0 };
  S.srv = Bun.serve({
    port: 0, hostname: "127.0.0.1",
    fetch(req, srv) { return srv.upgrade(req) ? undefined : new Response("no", { status: 400 }); },
    websocket: {
      open(ws) { S.sock = ws; },
      message(ws, data) {
        const m = JSON.parse(String(data));
        S.got.push(m);
        if (m.method === "hello") return void answerHello(ws, m);
        if (m.id && S.pending.has(m.id)) { S.pending.get(m.id)(m); S.pending.delete(m.id); }
      },
      close(ws, code, reason) { S.closed = { code, reason }; },
    },
  });
  S.port = S.srv.port;
  S.request = (method, params, raw) => new Promise((resolve) => {
    const id = raw?.id ?? "s" + ++S.n;
    S.pending.set(id, resolve);
    S.sock.send(raw?.text ?? JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    setTimeout(() => { if (S.pending.has(id)) { S.pending.delete(id); resolve({ timeout: true }); } }, raw?.wait ?? 1500);
  });
  return S;
}
const pairOk = (ws, m) => ws.send(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { protocol: 1, agent: { name: "Claude Code", client: "claude-code", version: "2.0" }, wants: { write: true, run: false }, session: "SECRET" } }));

// ---- a fake workspace: files by path; calls counted
function fakeWs() {
  const files = new Map([["/A/x.txt", "hello"], ["/A/doc.ipynb", { cells: [] }], ["/B/y.txt", "secret"]]);
  const W = { calls: [], actor: null, hang: false, store: new Map() };
  const entry = (p) => ({ path: p, kind: p.endsWith(".ipynb") ? "notebook" : "file", created: 1, updated: 2, ref: "INTERNAL", fid: "FID" });
  W.verbsFor = (actor) => {
    W.actor = actor;
    const v = {
      list: async (f) => [...files.keys()].filter((p) => p.startsWith(f + "/")).map(entry),
      stat: async (p) => (files.has(p) ? entry(p) : null),
      read: async (p) => { if (W.hang) await new Promise(() => {}); if (!files.has(p)) throw Object.assign(new Error("no such entry"), { code: "missing" }); return { entry: entry(p), content: files.get(p), rev: 1 }; },
      write: async (p, c) => { files.set(p, c); return { entry: entry(p), rev: 2 }; },
      create: async (p) => { files.set(p, ""); return entry(p); }, mkdir: async (p) => ({ path: p, kind: "folder" }),
      rename: async (a, b) => { files.set(b, files.get(a)); files.delete(a); return entry(b); }, duplicate: async (p) => entry(p),
      remove: async (p) => entry(p), restore: async (p) => entry(p), history: async () => [], version: async () => new Uint8Array([1, 2, 3]),
    };
    return Object.fromEntries(Object.entries(v).map(([k, f]) => [k, async (...a) => { W.calls.push(k); return f(...a); }]));
  };
  W.storeApi = { agentGrants: async () => Object.fromEntries(W.store), putAgentGrant: async (id, g) => { if (g === null) W.store.delete(id); else W.store.set(id, g); } };
  W.files = files;
  return W;
}
const page = { origin: "http://127.0.0.1:1", path: "/test" };
const mk = (S, W, how = { code: "abcd-efgh ijkl" }, now) => new AgentPairing(S.port, how, { verbsFor: W.verbsFor, store: W.storeApi, trashedFrom: async () => null, page, ...(now ? { now } : {}) });

// ---- parseStrict
let dup = false;
try { parseStrict('{"a":1,"b":{"c":2,"c":3}}'); } catch { dup = true; }
ok(dup, "parseStrict: a nested repeated key is refused");
dup = false;
try { parseStrict('{"a":1,"\\u0061":2}'); } catch { dup = true; }
ok(dup, "parseStrict: a key repeated through an escape is refused");
ok(JSON.stringify(parseStrict('{"a":{"a":1},"b":[{"a":2},{"a":3}],"s":"{\\"a\\":1,\\"a\\":2}"}')) === '{"a":{"a":1},"b":[{"a":2},{"a":3}],"s":"{\\"a\\":1,\\"a\\":2}"}', "parseStrict: the same key in different objects, and braces inside strings, are fine");
ok(actorOf("Claude Code", "claude-code") === "agent:Claude-Code" && actorOf("", "") === "agent:agent" && actorOf("x".repeat(99), "") === "agent:" + "x".repeat(64), "actorOf: a name forAgent takes");

// ---- the hello
{
  const S = server(pairOk), W = fakeWs(), P = mk(S, W);
  const h = await P.paired();
  const hello = S.got[0];
  ok(hello.method === "hello" && hello.params.code === "abcdefghijkl" && !("session" in hello.params) && hello.params.protocol === 1, "the hello carries the code (spaces and dashes taken out), and no session");
  ok(h.agent.name === "Claude Code" && P.state === "paired", "paired: the agent's name as it says");
  // (nothing before the grant)
  const r = await S.request("workspace.read", { path: "/A/x.txt" });
  ok(r.error?.data?.code === "invalid" && /grant/.test(r.error.data.message) && W.calls.length === 0, "before the grant: a verb is refused, and the workspace never called");
  await P.allow({ folders: ["/A"], write: true, expires: null }, false);
  await until(() => S.got.some((m) => m.method === "grant.changed"));
  const g = S.got.find((m) => m.method === "grant.changed");
  ok(g && g.id === undefined && g.params.folders.join() === "/A" && g.params.write === true && g.params.run === false, "grant.changed: a notification with the grant");
  ok(W.actor === "agent:Claude-Code", "the agent's changes credited to agent:<name> (forAgent)");
  const r2 = await S.request("workspace.read", { path: "/A/x.txt" });
  ok(r2.result?.content?.text === "hello" && r2.result.rev === 1 && !("ref" in r2.result.entry) && !("fid" in r2.result.entry), "a read inside the grant: {text}, and the entry without internal ids");
  const r3 = await S.request("workspace.read", { path: "/B/y.txt" });
  ok(r3.error?.data?.code === "invalid" && W.calls.filter((c) => c === "read").length === 1, "a read outside the grant is refused before the workspace");
  const r4 = await S.request("workspace.write", { path: "/A/../B/y.txt", content: { text: "pwned" }, base: 1 });
  ok(r4.error && W.files.get("/B/y.txt") === "secret", "a write through .. is refused; the file outside is untouched");
  const r5 = await S.request("workspace.drop", { path: "/A/x.txt" });
  ok(r5.error?.data?.code === "invalid" && /not a verb/.test(r5.error.data.message), "an unknown verb is refused");
  const r6 = await S.request("workspace.read", { path: "/A/x.txt", follow: true });
  ok(r6.error?.data?.code === "invalid" && /isn't a parameter/.test(r6.error.data.message), "params that break the schema are refused");
  const r7 = await S.request("workspace.read", { path: "/A/doc.ipynb" });
  ok(r7.result?.content?.json?.cells !== undefined, "a document as {json}");
  const r8 = await S.request("workspace.write", { path: "/A/x.txt", content: { text: "é".repeat(4 * 2 ** 20 + 1) }, base: 1 }, { wait: 5000 });
  ok(r8.error?.data?.code === "limit" && /bytes/.test(r8.error.data.message) && W.files.get("/A/x.txt") === "hello", "contents over 8 MiB refused with their size, nothing written");
  const r9 = await S.request("workspace.write", { path: "/A/x.txt", content: { base64: btoa("hi") }, base: 1 });
  ok(r9.result?.rev === 2 && P.changes === 1, "a write inside the grant, counted");
  // (revoke: the server told, the socket closed, the agent cut off)
  await P.revoke();
  ok(await until(() => S.closed !== null), "revoke closes the socket");
  ok(S.got.some((m) => m.method === "grant.changed" && Object.keys(m.params).length === 0), "revoke sends grant.changed {}");
  ok(P.state === "closed" && P.grant === null, "revoked: no grant left in the page");
  S.srv.stop(true);
}
// ---- a refused hello
{
  const S = server((ws, m) => { ws.send(JSON.stringify({ jsonrpc: "2.0", id: m.id, error: { code: -32000, message: "refused", data: { code: "refused", message: "wrong code" } } })); ws.close(1008, "wrong code"); });
  const W = fakeWs(), P = mk(S, W);
  let err = null;
  try { await P.paired(); } catch (e) { err = e; }
  ok(err && /wrong code/.test(err.message) && P.state === "closed", "a refused hello: the refusal said, nothing paired");
  S.srv.stop(true);
}
// ---- a session hello
{
  const S = server(pairOk), W = fakeWs();
  const P = mk(S, W, { session: "SECRET", pairingId: "abc123" });
  await P.paired();
  ok(S.got[0].params.session === "SECRET" && !("code" in S.got[0].params) && P.id === "abc123", "a remembered agent: the hello carries the session, not a code");
  S.srv.stop(true);
}
// ---- frames
{
  const S = server((ws) => ws.send("x".repeat(9 * 1024))), W = fakeWs(), P = mk(S, W);
  try { await P.paired(); } catch {}
  ok(await until(() => S.closed?.code === 1009), `over 8 KiB before the hello has paired: closed 1009 (${S.closed?.code})`);
  S.srv.stop(true);
}
{
  const S = server((ws, m) => ws.send(`{"jsonrpc":"2.0","id":"p1","id":"p1","result":{}}`)), W = fakeWs(), P = mk(S, W);
  try { await P.paired(); } catch {}
  ok(await until(() => S.closed?.code === 1007), `a repeated key: closed 1007 (${S.closed?.code})`);
  S.srv.stop(true);
}
{
  const S = server(pairOk), W = fakeWs(), P = mk(S, W);
  await P.paired();
  await P.allow({ folders: ["/A"], write: true, expires: null }, false);
  S.sock.send(JSON.stringify({ jsonrpc: "2.0", id: "s1", method: "workspace.read", params: { path: "/A/" + "x".repeat(12 * 2 ** 20) } }));
  ok(await until(() => S.closed?.code === 1009), `over 12 MiB after pairing: closed 1009 (${S.closed?.code})`);
  S.srv.stop(true);
}
{
  const S = server(pairOk), W = fakeWs(), P = mk(S, W);
  await P.paired();
  await P.allow({ folders: ["/A"], write: true, expires: null }, false);
  S.sock.send(JSON.stringify({ jsonrpc: "2.0", id: "evil", method: "workspace.read", params: { path: "/A/x.txt" } }));
  ok(await until(() => S.closed?.code === 1002) && W.calls.length === 0, "a request id the server doesn't make: closed 1002, nothing run");
  S.srv.stop(true);
}
// ---- limits: 8 in flight, then 100 a second (burst 200)
{
  const S = server(pairOk), W = fakeWs(), P = mk(S, W);
  await P.paired();
  await P.allow({ folders: ["/A"], write: true, expires: null }, false);
  W.hang = true;
  for (let i = 0; i < 8; i++) void S.request("workspace.read", { path: "/A/x.txt" }, { wait: 60000 });
  await until(() => W.calls.length === 8);
  const r = await S.request("workspace.read", { path: "/A/x.txt" });
  ok(r.error?.data?.code === "limit" && r.error.data.retryAfterMs === 250, "a 9th call in flight: limit, retryAfterMs 250");
  S.srv.stop(true);
}
{
  const S = server(pairOk), W = fakeWs();
  let t = 1_000_000;
  const P = mk(S, W, { code: "x" }, () => t);
  await P.paired();
  await P.allow({ folders: ["/A"], write: true, expires: null }, false);
  const rs = await Promise.all(Array.from({ length: 201 }, () => S.request("workspace.stat", { path: "/A/x.txt" }, { wait: 5000 })));
  const lim = rs.filter((r) => r.error?.data?.code === "limit");
  ok(rs.filter((r) => r.result).length === 200 && lim.length === 1 && lim[0].error.data.retryAfterMs > 0, `a burst of 200, then limit with retryAfterMs (${lim.length} refused)`);
  t += 1000;
  const r = await S.request("workspace.stat", { path: "/A/x.txt" });
  ok(!!r.result, "a second later, calls go through again");
  S.srv.stop(true);
}
// ---- expiry, and the kept grant
{
  const S = server(pairOk), W = fakeWs(), P = mk(S, W);
  await P.paired();
  await P.allow({ folders: ["/A"], write: false, expires: Date.now() + 300 }, true);
  ok(W.store.size === 1 && [...W.store.values()][0].session === "SECRET" && [...W.store.values()][0].grant.folders.join() === "/A", "remembered: the grant and session kept in the workspace");
  const r = await S.request("workspace.write", { path: "/A/x.txt", content: { text: "no" }, base: 1 });
  ok(r.error && /read only/.test(r.error.data.message), "a read-only grant refuses a write");
  ok(await until(() => S.closed !== null, 2000), "the grant expires: the socket closes by itself");
  ok(S.got.some((m) => m.method === "grant.changed" && Object.keys(m.params).length === 0) && W.store.size === 0, "expired: grant.changed {} sent, and the kept grant forgotten");
  S.srv.stop(true);
}
{
  const S = server(pairOk), W = fakeWs(), P = mk(S, W);
  await P.paired();
  await P.allow({ folders: ["/A"], write: true, expires: null }, true);
  ok(W.store.size === 0, "\"until this page closes\" is never kept, even when remembered");
  S.srv.stop(true);
}
console.log(failures ? `${failures} failed` : "all passed");
process.exit(failures ? 1 : 0);
