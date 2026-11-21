// ci: web-runner order=170 runner=bun
// The page's side of a pairing (agent-pair.ts) against a fake sagebrush-mcp: a loopback WebSocket that answers
// the hello and sends verbs, and an in-memory workspace behind forAgent.  What it shows: the hello, nothing done
// before the person's grant, the grant's scope, the frame and call limits, and that revoking (or expiry) cuts
// the agent off at once and forgets the kept grant.
//   bun web/workspace/test-agent-pair.mjs
import { failHint, agentSays, onlyCurrent, readConnect, ONLY_CODE, SAFARI, CHROME_ALLOW, OTHER_FAIL } from "./agent-ui.ts";
import { handOver, takeHandoff, HANDOFF_KEY, HANDOFF_MS } from "./pair-handoff.ts";
import { AgentPairing, AgentError, CHANGED_WHILE_RUNNING, parseStrict, actorOf, parseReloadRecord, reloadDecision, takeReloadRecord, putReloadRecord, markReloadLeft, RELOAD_KEY, RETURN_MS } from "./agent-pair.ts";

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
        if (typeof m.method === "string" && m.method.startsWith("tasks.") && S.onTask) return void S.onTask(ws, m);
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
  const W = { calls: [], actor: null, hang: false, store: new Map(), trash: new Map([["/Trash/z.txt", { path: "/Trash/z.txt", trashed: { from: "/A/z.txt", at: 1, id: "t1" } }]]), trashHold: null, trashCalls: 0, restoreArgs: [], versionBytes: new Uint8Array([1, 2, 3]), conflictOn: new Set() };
  W.trashEntry = async (p) => { W.trashCalls++; const e = W.trash.get(p) ?? null; if (W.trashHold) await W.trashHold; return e; }; // (read, then held: what changes meanwhile happens after authorization saw it)
  W.holdReads = () => { let r; W.readHold = new Promise((res) => (r = res)); return () => { W.readHold = null; r(); }; };
  W.hold = () => { let r; W.trashHold = new Promise((res) => (r = res)); return () => { W.trashHold = null; r(); }; };
  const entry = (p) => ({ path: p, kind: p.endsWith(".ipynb") ? "notebook" : "file", created: 1, updated: 2, ref: "INTERNAL", fid: "FID" });
  W.verbsFor = (actor) => {
    W.actor = actor;
    const v = {
      list: async (f) => [...files.keys()].filter((p) => p.startsWith(f + "/")).map(entry),
      stat: async (p) => (files.has(p) ? entry(p) : null),
      read: async (p) => { if (W.hang) await new Promise(() => {}); W.reads = (W.reads ?? 0) + 1; if (W.readHold) await W.readHold; if (!files.has(p)) throw Object.assign(new Error("no such entry"), { code: "missing" }); return { entry: entry(p), content: files.get(p), rev: 1 }; },
      write: async (p, c) => { if (W.conflictOn.has(p)) throw Object.assign(new Error("changed elsewhere"), { code: "conflict" }); files.set(p, c); return { entry: entry(p), rev: 2 }; },
      create: async (p) => { files.set(p, ""); return entry(p); }, mkdir: async (p) => ({ path: p, kind: "folder" }),
      rename: async (a, b) => { files.set(b, files.get(a)); files.delete(a); return entry(b); }, duplicate: async (p) => entry(p),
      remove: async (p) => entry(p), history: async () => [], version: async () => W.versionBytes,
      // (as Workspace.restore: with expect, only that very entry, else "missing" and nothing moved)
      restore: async (p, expect) => { W.restoreArgs.push(expect); const cur = W.trash.get(p); if (!expect || !cur || cur.trashed.id !== expect.trashed?.id) throw Object.assign(new Error("already restored or deleted"), { code: "missing" }); W.trash.delete(p); files.set(cur.trashed.from, "restored"); return entry(cur.trashed.from); },
    };
    return Object.fromEntries(Object.entries(v).map(([k, f]) => [k, async (...a) => { W.calls.push(k); return f(...a); }]));
  };
  W.storeApi = { agentGrants: async () => Object.fromEntries(W.store), putAgentGrant: async (id, g) => { if (g === null) W.store.delete(id); else W.store.set(id, g); } };
  W.files = files;
  return W;
}
const page = { origin: "http://127.0.0.1:1", path: "/test" };
const mk = (S, W, how = { code: "abcd-efgh ijkl" }, now) => new AgentPairing(S.port, how, { verbsFor: W.verbsFor, store: W.storeApi, trashEntry: W.trashEntry, page, ...(now ? { now } : {}) });

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
// ---- a remembered agent reconnected twice: its session kept across the reconnect (T1, found by git-proto at
// b72938d8a). sagebrush-mcp gives a session only for a code's hello (pairing.py: result["session"] only when it made
// one), so a session's hello is answered without one; the grant kept on Allow must still hold the session in force,
// or the next reconnect has none.
{
  const pairBySession = (ws, m) => ws.send(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { protocol: 1, agent: { name: "Claude Code", client: "claude-code", version: "2.0" }, wants: { write: true, run: false } } }));
  const S = server(pairBySession), W = fakeWs();
  const P = mk(S, W, { session: "SECRET", pairingId: "abc123" });
  await P.paired();
  ok(P.hello && P.hello.session === undefined, "a session's hello is answered without a session, as sagebrush-mcp answers it");
  await P.allow({ folders: ["/A"], write: true, expires: Date.now() + 3_600_000 }, true);
  const kept = W.store.get("abc123");
  ok(kept?.session === "SECRET", `remembered again on a reconnect: the session in force is kept, not lost (${JSON.stringify(kept?.session)})`);
  await P.revoke("test");
  // (the second reconnect, from what was kept)
  W.store.set("abc123", kept);
  const S2 = server(pairBySession), P2 = mk(S2, W, { session: kept.session, pairingId: "abc123" });
  await P2.paired();
  ok(S2.got[0].params.session === "SECRET", `…so the next reconnect sends it, and pairs (${JSON.stringify(S2.got[0].params.session)})`);
  S.srv.stop(true); S2.srv.stop(true);
}
// ---- frames
{
  const S = server((ws) => ws.send("x".repeat(9 * 1024))), W = fakeWs(), P = mk(S, W);
  try { await P.paired(); } catch {}
  ok(await until(() => S.closed?.code === 4009), `over 8 KiB before the hello has paired: closed 4009 (${S.closed?.code})`);
  S.srv.stop(true);
}
{
  const S = server((ws, m) => ws.send(`{"jsonrpc":"2.0","id":"p1","id":"p1","result":{}}`)), W = fakeWs(), P = mk(S, W);
  try { await P.paired(); } catch {}
  ok(await until(() => S.closed?.code === 4007), `a repeated key: closed 4007 (${S.closed?.code})`);
  S.srv.stop(true);
}
{
  const S = server(pairOk), W = fakeWs(), P = mk(S, W);
  await P.paired();
  await P.allow({ folders: ["/A"], write: true, expires: null }, false);
  S.sock.send(JSON.stringify({ jsonrpc: "2.0", id: "s1", method: "workspace.read", params: { path: "/A/" + "x".repeat(12 * 2 ** 20) } }));
  ok(await until(() => S.closed?.code === 4009), `over 12 MiB after pairing: closed 4009 (${S.closed?.code})`);
  S.srv.stop(true);
}
{
  const S = server(pairOk), W = fakeWs(), P = mk(S, W);
  await P.paired();
  await P.allow({ folders: ["/A"], write: true, expires: null }, false);
  S.sock.send(JSON.stringify({ jsonrpc: "2.0", id: "evil", method: "workspace.read", params: { path: "/A/x.txt" } }));
  ok(await until(() => S.closed?.code === 4002) && W.calls.length === 0, "a request id the server doesn't make: closed 4002, nothing run");
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
// ---- a restore whose authorization is held (its Trash lookup): revoke, expiry, the 9th call, a swapped entry
{
  const S = server(pairOk), W = fakeWs(), P = mk(S, W);
  await P.paired();
  await P.allow({ folders: ["/A"], write: true, expires: null }, false);
  const go = W.hold();
  void S.request("workspace.restore", { path: "/Trash/z.txt" }, { wait: 3000 });
  await until(() => W.trashCalls === 1);
  await P.revoke();
  go();
  await sleep(200);
  ok(!W.calls.includes("restore") && W.files.get("/A/z.txt") === undefined, "revoked while a restore was being authorized: the workspace is never touched");
  S.srv.stop(true);
}
{
  const S = server(pairOk), W = fakeWs();
  let t = 5_000_000;
  const P = mk(S, W, { code: "x" }, () => t);
  await P.paired();
  await P.allow({ folders: ["/A"], write: true, expires: t + 60_000 }, false);
  const go = W.hold();
  const r = S.request("workspace.restore", { path: "/Trash/z.txt" }, { wait: 3000 });
  await until(() => W.trashCalls === 1);
  t += 120_000; // (the grant's end passes while the lookup is held)
  go();
  const a = await r;
  ok(a.error?.data?.code === "invalid" && /expired/.test(a.error.data.message) && !W.calls.includes("restore"), `the grant expired while a restore was being authorized: refused, nothing restored (${a.error?.data?.message})`);
  S.srv.stop(true);
}
{
  const S = server(pairOk), W = fakeWs(), P = mk(S, W);
  await P.paired();
  await P.allow({ folders: ["/A"], write: true, expires: null }, false);
  const go = W.hold();
  for (let i = 0; i < 8; i++) void S.request("workspace.restore", { path: "/Trash/z.txt" }, { wait: 5000 });
  await until(() => W.trashCalls === 8);
  const ninth = await S.request("workspace.restore", { path: "/Trash/z.txt" });
  ok(ninth.error?.data?.code === "limit" && W.trashCalls === 8, `a 9th restore while 8 are being authorized: limit, before any lookup of its own (${W.trashCalls} lookups)`);
  go();
  S.srv.stop(true);
}
{
  const S = server(pairOk), W = fakeWs(), P = mk(S, W);
  await P.paired();
  await P.allow({ folders: ["/A"], write: true, expires: null }, false);
  const go = W.hold();
  const r = S.request("workspace.restore", { path: "/Trash/z.txt" }, { wait: 3000 });
  await until(() => W.trashCalls === 1);
  // (meanwhile someone else puts another entry at that path in Trash: one removed from /B, outside the grant)
  W.trash.set("/Trash/z.txt", { path: "/Trash/z.txt", trashed: { from: "/B/z.txt", at: 2, id: "t2" } });
  go();
  const a = await r;
  ok(W.restoreArgs.length === 1 && W.restoreArgs[0]?.trashed?.id === "t1", "the restore names the very entry authorized (expect)");
  ok(a.error?.data?.code === "missing" && W.files.get("/B/z.txt") === undefined && W.trash.get("/Trash/z.txt").trashed.id === "t2", "an entry swapped in meanwhile isn't restored: missing, nothing moved");
  S.srv.stop(true);
}
{
  const S = server(pairOk), W = fakeWs(), P = mk(S, W);
  await P.paired();
  await P.allow({ folders: ["/A"], write: true, expires: null }, false);
  const r = await S.request("workspace.restore", { path: "/Trash/z.txt" });
  ok(r.result?.entry?.path === "/A/z.txt" && W.files.get("/A/z.txt") === "restored", "an untouched restore inside the grant goes through");
  S.srv.stop(true);
}
// ---- contents out: the same 8 MiB bound as in, and the frame bound
{
  const S = server(pairOk), W = fakeWs(), P = mk(S, W);
  await P.paired();
  await P.allow({ folders: ["/A"], write: true, expires: null }, false);
  const M = 8 * 2 ** 20;
  W.files.set("/A/exact.txt", "a".repeat(M));
  W.files.set("/A/over.txt", "a".repeat(M + 1));
  W.files.set("/A/bin", new Uint8Array(M + 1).fill(255));
  W.files.set("/A/big.ipynb", { cells: [], s: "a".repeat(M) });
  W.files.set("/A/ctl.txt", "\u0001".repeat(2.2 * 2 ** 20));
  const w = { wait: 8000 };
  const e1 = await S.request("workspace.read", { path: "/A/exact.txt" }, w);
  ok(e1.result?.content?.text?.length === M, "read: exactly 8 MiB of text is sent");
  const e2 = await S.request("workspace.read", { path: "/A/over.txt" }, w);
  ok(e2.error?.data?.code === "limit" && /8388609 bytes/.test(e2.error.data.message), "read: 8 MiB + 1 of text is refused with its size");
  const e3 = await S.request("workspace.read", { path: "/A/bin" }, w);
  ok(e3.error?.data?.code === "limit", "read: 8 MiB + 1 of binary is refused");
  const e4 = await S.request("workspace.read", { path: "/A/big.ipynb" }, w);
  ok(e4.error?.data?.code === "limit", "read: a document over 8 MiB as JSON is refused");
  W.versionBytes = new Uint8Array(M + 1);
  const e5 = await S.request("workspace.version", { path: "/A/x.txt", index: 0 }, w);
  ok(e5.error?.data?.code === "limit", "version: over 8 MiB is refused");
  W.conflictOn.add("/A/over.txt");
  const e6 = await S.request("workspace.write", { path: "/A/over.txt", content: { text: "x" }, base: 1 }, w);
  ok(e6.error?.data?.code === "conflict" && !("current" in e6.error.data) && /bytes/.test(e6.error.data.currentOmitted ?? ""), "a conflict whose current contents are over 8 MiB: said without them, and why");
  W.conflictOn.add("/A/x.txt");
  const e7 = await S.request("workspace.write", { path: "/A/x.txt", content: { text: "x" }, base: 1 }, w);
  ok(e7.error?.data?.code === "conflict" && e7.error.data.current?.content?.text === "hello", "a conflict within the bound carries the current contents");
  const e8 = await S.request("workspace.read", { path: "/A/ctl.txt" }, w);
  ok(e8.error?.data?.code === "limit" && /as a message/.test(e8.error.data.message), "an answer whose message would pass 12 MiB (escaping) is refused, not sent");
  S.srv.stop(true);
}
// ---- after the LAST wait, before anything is said: the same grant, in force now
{
  const S = server(pairOk), W = fakeWs();
  let t = 7_000_000;
  const P = mk(S, W, { code: "x" }, () => t);
  await P.paired();
  await P.allow({ folders: ["/A"], write: true, expires: t + 60_000 }, false);
  const go = W.holdReads();
  const r = S.request("workspace.read", { path: "/A/x.txt" }, { wait: 3000 });
  await until(() => W.reads === 1);
  t += 120_000; // (the grant ends while the read is held)
  go();
  const a = await r;
  ok(a.error?.data?.code === "invalid" && !JSON.stringify(a).includes("hello"), `a read that finishes after the grant expired says nothing of what it read (${a.error?.data?.message})`);
  S.srv.stop(true);
}
{
  const S = server(pairOk), W = fakeWs(), P = mk(S, W);
  await P.paired();
  await P.allow({ folders: ["/A"], write: true, expires: null }, false);
  const go = W.holdReads();
  const r = S.request("workspace.read", { path: "/A/x.txt" }, { wait: 1500 });
  await until(() => W.reads === 1);
  await P.revoke();
  go();
  const a = await r;
  ok(!JSON.stringify(a).includes("hello"), "a read that finishes after revoke: its contents never sent");
  S.srv.stop(true);
}
{
  // (an error of the page's own, an AgentError, raised after the wait: the same check before it is said)
  const S = server(pairOk), W = fakeWs();
  let t = 7_000_000;
  const P = mk(S, W, { code: "x" }, () => t);
  await P.paired();
  await P.allow({ folders: ["/A"], write: true, expires: t + 60_000 }, false);
  W.files.set("/A/huge.txt", "y".repeat(8 * 2 ** 20 + 1));
  const go = W.holdReads();
  const r = S.request("workspace.read", { path: "/A/huge.txt" }, { wait: 3000 });
  await until(() => W.reads === 1);
  t += 120_000;
  go();
  const a = await r;
  ok(a.error?.data?.code === "invalid" && /grant changed or expired/.test(a.error.data.message), `an AgentError (over the content bound) raised after the grant expired: the grant's answer, not the error's (${a.error?.data?.code})`);
  S.srv.stop(true);
}
{
  const S = server(pairOk), W = fakeWs(), P = mk(S, W);
  await P.paired();
  await P.allow({ folders: ["/A"], write: true, expires: null }, false);
  W.conflictOn.add("/A/x.txt");
  const go = W.holdReads();
  const r = S.request("workspace.write", { path: "/A/x.txt", content: { text: "mine" }, base: 1 }, { wait: 3000 });
  await until(() => W.reads === 1); // (the conflict's recovery read, held)
  await P.allow({ folders: ["/B"], write: true, expires: null }, false); // (the grant replaced: /A no longer)
  go();
  const a = await r;
  ok(a.error?.data?.code === "invalid" && !JSON.stringify(a).includes("hello") && !("current" in (a.error?.data ?? {})), `a conflict's recovery read that finishes after the grant moved to /B: nothing of /A said (${a.error?.data?.message})`);
  S.srv.stop(true);
}
{
  const S = server(pairOk), W = fakeWs(), P = mk(S, W);
  await P.paired();
  await P.allow({ folders: ["/A"], write: true, expires: null }, false);
  W.files.set("/A/ctl.txt", "\u0001".repeat(2.2 * 2 ** 20));
  W.conflictOn.add("/A/ctl.txt");
  const a = await S.request("workspace.write", { path: "/A/ctl.txt", content: { text: "x" }, base: 1 }, { wait: 8000 });
  const bytes = new TextEncoder().encode(JSON.stringify(a)).length;
  ok(a.error?.data?.code === "conflict" && !("current" in a.error.data) && /frame|bytes/.test(a.error.data.currentOmitted ?? "") && bytes <= 12 * 2 ** 20, `a conflict whose current contents would pass the frame bound (escaping): said without them (${bytes} bytes)`);
  S.srv.stop(true);
}
{
  const S = server(pairOk), W = fakeWs(), P = mk(S, W);
  await P.paired();
  await P.allow({ folders: ["/A"], write: true, expires: null }, false);
  W.files.set("/A/big.txt", "\u0001".repeat(2.2 * 2 ** 20));
  const a = await S.request("workspace.read", { path: "/A/big.txt" }, { wait: 8000 });
  const bytes = new TextEncoder().encode(JSON.stringify(a)).length;
  ok(a.error?.data?.code === "limit" && bytes <= 12 * 2 ** 20, `a read whose answer escapes past the frame bound: a limit error, not the frame (${bytes} bytes)`);
  S.srv.stop(true);
}

// ---- A14: the reload record (plan r3.1 §1-§2 + r3.2): its closed parse (U-3), its decision (U-7, U-8), take/put
{
  const scope = { workspace: "sagebrush-ws", page: "http://127.0.0.1:1/agents/" };
  const good = { v: 1, pairingId: "a".repeat(24), session: "B".repeat(43), port: 4321, agent: { name: "Claude Code", client: "claude-code" }, grant: { folders: ["/notes"], write: true, expires: null }, workspace: scope.workspace, page: scope.page, leftAt: 1000 };
  const js = (o) => JSON.stringify(o);
  ok(JSON.stringify(parseReloadRecord(js(good))) === js(good), "U-3.ok: an exact record parses as itself");
  const { leftAt, ...noLeft } = good;
  ok(parseReloadRecord(js(noLeft)) !== null, "U-3.noleft: a record without leftAt parses (a page still open)");
  const bad = {
    "not-json": "{", "array": "[]", "big": js({ ...good, page: "x".repeat(5000) }), "extra-key": js({ ...good, x: 1 }), "missing-key": js({ ...noLeft, port: undefined }),
    "v": js({ ...good, v: 2 }), "pairingId": js({ ...good, pairingId: "zz" }), "session": js({ ...good, session: "short" }), "port-0": js({ ...good, port: 0 }), "port-str": js({ ...good, port: "4321" }),
    "agent-missing": js({ ...good, agent: undefined }), "agent-extra": js({ ...good, agent: { ...good.agent, v: "1" } }), "agent-long": js({ ...good, agent: { name: "n".repeat(81), client: "c" } }),
    "grant-extra": js({ ...good, grant: { ...good.grant, x: true } }), "grant-run-false": js({ ...good, grant: { ...good.grant, run: false } }), "folders-empty": js({ ...good, grant: { ...good.grant, folders: [] } }), "folder-relative": js({ ...good, grant: { ...good.grant, folders: ["notes"] } }),
    "write-str": js({ ...good, grant: { ...good.grant, write: "true" } }), "expires-str": js({ ...good, grant: { ...good.grant, expires: "3600000" } }), "expires-inf": js({ ...good, grant: { ...good.grant, expires: 1 } }).replace('"expires":1', '"expires":1e999'),
    "leftAt-str": js({ ...good, leftAt: "1000" }), "leftAt-inf": js(good).replace('"leftAt":1000', '"leftAt":1e999'), "workspace-empty": js({ ...good, workspace: "" }), "dup-key": js(good).replace('"v":1', '"v":1,"v":1'),
  };
  for (const [id, raw] of Object.entries(bad)) ok(parseReloadRecord(raw) === null, `U-3.${id}: malformed, so no record`);
  ok(parseReloadRecord(null) === null, "U-3.null: no stored value, no record");
  const d = (r, navType, now) => reloadDecision(r, { scope, navType, now });
  ok(RETURN_MS === 10 * 60 * 1000, "U-7.window: one constant, 10 minutes (A5 item 2)");
  ok(d(good, "reload", 1000 + RETURN_MS) === "silent", "U-7.silent: a reload, fresh (age = 10 min), same scope: silent");
  ok(d(good, "reload", 1000 + RETURN_MS + 1) === "click", "U-7.stale: older than 10 min: kept for one click");
  ok(d(good, "reload", 999) === "click", "U-7.future: a leftAt in the future fails freshness: kept for one click");
  ok(d(good, "navigate", 1500) === "silent" && d(good, "back_forward", 1000 + RETURN_MS) === "silent", "U-7.return: a navigation back (Files and back, or Back) within 10 min, same scope: silent (A5 item 2)");
  ok(d(good, "navigate", 1000 + RETURN_MS + 1) === "discard" && d(good, "back_forward", 1000 + RETURN_MS + 1) === "discard", "U-7.return-stale: a navigation back older than 10 min: discarded, nothing kept for a click");
  ok(d(good, "navigate", 999) === "discard", "U-7.return-future: a navigation with a leftAt in the future: discarded");
  ok(d(good, "prerender", 1500) === "discard" && d(good, "", 1500) === "discard", "U-7.other-nav: any other navigation type: discarded");
  ok(d(noLeft, "navigate", 1500) === "discard", "U-7.return-noleft: a navigation with no leftAt: discarded");
  ok(d({ ...good, page: "http://127.0.0.1:1/other/" }, "navigate", 1500) === "discard", "U-7.return-scope: a navigation to another page: discarded");
  ok(d(noLeft, "reload", 1500) === "discard", "U-7.noleft: no leftAt (a copy taken while the original lived, as a new tab's): discarded");
  ok(d({ ...good, workspace: "other" }, "reload", 1500) === "discard", "U-7.scope-ws: another workspace: discarded, nothing kept for a click (R1-d)");
  ok(d({ ...good, page: "http://127.0.0.1:1/other/" }, "reload", 1500) === "discard", "U-7.scope-page: another page: discarded (R1-d)");
  const timed = { ...good, grant: { ...good.grant, expires: 5000 } };
  ok(d({ ...timed, leftAt: 4990 }, "reload", 4999) === "silent", "U-8.before: now = expires - 1, fresh: silent");
  ok(d({ ...timed, leftAt: 4990 }, "reload", 5000) === "discard", "U-8.at: now = expires: discarded (R1-e)");
  ok(d({ ...timed, leftAt: 4990 }, "reload", 5001) === "discard", "U-8.after: now = expires + 1: discarded");
  ok(d({ ...timed, leftAt: 4990 }, "navigate", 5000) === "discard", "U-8.click: an expired record is never kept for a click");
  // take with this page's scope (A5): another page's record is left where it is; this page's own, or one that can't be
  // read, is taken as before
  {
    const m = new Map();
    const st = { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => void m.set(k, String(v)), removeItem: (k) => void m.delete(k) };
    m.set(RELOAD_KEY, js(good));
    const other = takeReloadRecord(st, { workspace: scope.workspace, page: "http://127.0.0.1:1/" });
    ok(other.kind === "none" && m.has(RELOAD_KEY), "U-9.other-page: another page's record, taken with this page's scope: left where it is", other);
    const mine = takeReloadRecord(st, scope);
    ok(mine.kind === "ok" && !m.has(RELOAD_KEY), "U-9.own: this page's record: taken and removed");
    m.set(RELOAD_KEY, "{not json");
    const bad = takeReloadRecord(st, scope);
    ok(bad.kind === "bad" && !m.has(RELOAD_KEY), "U-9.bad: a record that can't be read: taken (removed), as before");
    m.set(RELOAD_KEY, js({ ...good, workspace: "other" }));
    const ws2 = takeReloadRecord(st, scope);
    ok(ws2.kind === "ok" && !m.has(RELOAD_KEY), "U-9.workspace: this page's address, another workspace: taken (the decision discards it)");
  }
  // take/put/markLeft over a Storage-like map; and storage that throws
  const store = () => { const m = new Map(); return { m, getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => void m.set(k, String(v)), removeItem: (k) => void m.delete(k) }; };
  const own = { workspace: noLeft.workspace, page: noLeft.page };
  const s1 = store(); putReloadRecord(s1, noLeft); markReloadLeft(s1, 777, own);
  ok(parseReloadRecord(s1.getItem(RELOAD_KEY))?.leftAt === 777, "U-1.leftAt: pagehide writes leftAt onto the held record");
  // (A5: another page's pagehide (a board passed through on the way) leaves the record byte for byte; so does this
  //  page's address in another workspace)
  {
    const sx = store(); putReloadRecord(sx, { ...noLeft, leftAt: 5 }); const raw0 = sx.getItem(RELOAD_KEY);
    markReloadLeft(sx, 999, { ...own, page: own.page + "board/" });
    ok(sx.getItem(RELOAD_KEY) === raw0, "U-1.other-page: another page's pagehide leaves the record byte for byte (its leftAt never renewed)");
    markReloadLeft(sx, 999, { ...own, workspace: own.workspace + "-other" });
    ok(sx.getItem(RELOAD_KEY) === raw0, "U-1.other-workspace: the same page in another workspace leaves it byte for byte too");
    markReloadLeft(sx, 999, own);
    ok(parseReloadRecord(sx.getItem(RELOAD_KEY))?.leftAt === 999, "U-1.own-again: its own page's pagehide renews it");
  }
  const taken = takeReloadRecord(s1);
  ok(taken.kind === "ok" && taken.record.leftAt === 777 && s1.getItem(RELOAD_KEY) === null, "R1-c: take returns the record and removes it before any attempt");
  ok(takeReloadRecord(s1).kind === "none", "R1-c: a second take finds nothing (this page's next reload makes no attempt)");
  const s2 = store(); s2.setItem(RELOAD_KEY, "{bad"); ok(takeReloadRecord(s2).kind === "bad" && s2.getItem(RELOAD_KEY) === null, "U-3.take-bad: a malformed stored record is removed and is \"bad\" (not absent: no silent fallback)");
  const thrower = { getItem() { throw new Error("denied"); }, setItem() { throw new Error("denied"); }, removeItem() { throw new Error("denied"); } };
  ok(takeReloadRecord(thrower).kind === "bad" && takeReloadRecord(null).kind === "none", "U-3.storage: storage that throws on read is \"bad\"; no storage is \"none\"");
  putReloadRecord(thrower, good); markReloadLeft(thrower, 1, own); ok(true, "U-3.storage-write: writing to storage that throws doesn't throw");
  // S1: a record that reads but can't be removed is never used (consumed before any attempt, or not at all)
  const s3 = store(); s3.setItem(RELOAD_KEY, JSON.stringify(good)); s3.removeItem = () => { throw new Error("denied"); };
  const t3 = takeReloadRecord(s3);
  ok(parseReloadRecord(s3.getItem(RELOAD_KEY)) !== null && t3.kind === "bad" && !("record" in t3), "U-11.remove-throws: an exact record whose removal throws is \"bad\": no record is handed out");
  // S3: the 4 KiB bound in UTF-8 bytes, reading and writing; an unfitting write stores nothing and drops an older entry
  const wide = { ...good, grant: { ...good.grant, folders: Array.from({ length: 6 }, (_, i) => `/f${i}/` + Array.from({ length: 3 }, () => "é".repeat(120)).join("/")) } };
  const wideRaw = JSON.stringify(wide), narrowRaw = JSON.stringify({ ...wide, grant: { ...wide.grant, folders: wide.grant.folders.map((f) => f.replace(/é/g, "e")) } });
  ok(wideRaw.length <= 4096 && new TextEncoder().encode(wideRaw).length > 4096 && parseReloadRecord(narrowRaw) !== null && parseReloadRecord(wideRaw) === null, "U-12.bytes-read: under 4096 characters but over 4096 UTF-8 bytes is refused (the same record in ASCII parses)");
  const s4 = store(); putReloadRecord(s4, good); putReloadRecord(s4, wide);
  ok(s4.getItem(RELOAD_KEY) === null, "U-12.bytes-write: a record over the byte bound isn't written, and the older entry is removed (nothing oversized stored)");
  const s5 = store(); putReloadRecord(s5, { ...good, extra: 1 });
  ok(s5.getItem(RELOAD_KEY) === null, "U-12.shape-write: a record the reader wouldn't take back exactly isn't written");
}
// ---- A14: the record kept by AgentPairing itself (U-1, U-2, U-4, U-5, U-6), against the fake server
{
  const SESSION = "A".repeat(42) + "w"; // (43 base64url characters: 32 bytes)
  const pair43 = (agent = { name: "Claude Code", client: "claude-code" }) => (ws, m) => ws.send(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { protocol: 1, agent: { ...agent, version: "2.0" }, wants: { write: true, run: false }, ...("code" in m.params ? { session: SESSION } : {}) } }));
  const memStore = () => { const m = new Map(); return { m, getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => void m.set(k, String(v)), removeItem: (k) => void m.delete(k) }; };
  const scope = { workspace: "sagebrush-workspace/0123456789abcdef", page: "http://127.0.0.1:1/agents/" };
  const mkR = (S, W, store, o = {}) => new AgentPairing(S.port, o.how ?? { code: "abcd" }, { verbsFor: W.verbsFor, store: W.storeApi, trashEntry: W.trashEntry, page, ...(o.now ? { now: o.now } : {}), ...(o.WebSocketImpl ? { WebSocketImpl: o.WebSocketImpl } : {}), reload: { storage: store, scope, leaving: o.leaving ?? (() => false) } });
  const held = (store) => parseReloadRecord(store.getItem(RELOAD_KEY));
  const NOW = 1_800_000_000_000;

  // U-1: written for every unremembered grant (page, 1 hour, 1 day), exactly as allowed; never for a remembered one
  for (const [id, expires, remember] of [["U-1.page", null, false], ["U-1.hour", NOW + 3_600_000, false], ["U-1.day", NOW + 86_400_000, false], ["U-1.remembered", NOW + 3_600_000, true]]) {
    const S = server(pair43()), W = fakeWs(), st = memStore(), P = mkR(S, W, st, { now: () => NOW });
    await P.paired();
    await P.allow({ folders: ["/A"], write: true, expires }, remember);
    const r = held(st);
    if (remember) ok(r === null && st.m.size === 0 && W.store.size === 1, `${id}: a remembered grant writes no reload record (IndexedDB keeps it, as before)`);
    else ok(r !== null && r.session === SESSION && r.pairingId === P.id && r.port === S.port && r.agent.name === "Claude Code" && r.agent.client === "claude-code" && r.grant.folders.join() === "/A" && r.grant.write === true && r.grant.expires === expires && r.workspace === scope.workspace && r.page === scope.page && !("leftAt" in r) && W.store.size === 0, `${id}: the record is written, exactly the grant allowed (expires ${expires === null ? "null" : "+" + (expires - NOW)}), with no leftAt while the page lives`);
    await P.revoke(); S.srv.stop(true);
  }

  // U-2: what each end does to the record (one id per path)
  {
    const S = server(pair43()), W = fakeWs(), st = memStore(), P = mkR(S, W, st);
    await P.paired(); await P.allow({ folders: ["/A"], write: false, expires: null }, false);
    const before = held(st);
    await P.revoke("revoked by the person");
    ok(before !== null && st.m.size === 0 && P.lostRecord === null, "U-2.revoke: the person's Revoke removes the record, and keeps none in memory");
    S.srv.stop(true);
  }
  {
    const S = server(pair43()), W = fakeWs(), st = memStore();
    let t = NOW;
    const P = mkR(S, W, st, { now: () => t });
    await P.paired(); await P.allow({ folders: ["/A"], write: false, expires: NOW + 60 }, false);
    const before = held(st);
    await until(() => P.state === "closed", 3000);
    ok(before !== null && P.closeReason === "the grant expired" && st.m.size === 0 && P.lostRecord === null, "U-2.expiry: an expiry removes the record (timer and record both gone), nothing kept for a click", { reason: P.closeReason });
    S.srv.stop(true);
  }
  {
    const S = server(pair43()), W = fakeWs(), st = memStore(), P = mkR(S, W, st);
    await P.paired(); await P.allow({ folders: ["/A"], write: true, expires: null }, false);
    const before = held(st);
    S.sock.close(1011, "gone");
    await until(() => P.state === "closed", 3000);
    ok(before !== null && st.m.size === 0 && P.lostRecord?.pairingId === before.pairingId && P.lostRecord.session === SESSION, "U-2.loss: an involuntary close takes the record out of storage and keeps it in memory for one [Reconnect]");
    S.srv.stop(true);
  }
  {
    let leaving = false;
    const S = server(pair43()), W = fakeWs(), st = memStore(), P = mkR(S, W, st, { leaving: () => leaving });
    await P.paired(); await P.allow({ folders: ["/A"], write: true, expires: null }, false);
    leaving = true; // (pagehide: the page is going, as on a reload)
    S.sock.close(1001, "going away");
    await until(() => P.state === "closed", 3000);
    ok(held(st)?.pairingId === P.id && P.lostRecord === null, "U-2.leaving: a close while the page leaves keeps the record in storage, for the reload's restore");
    S.srv.stop(true);
  }

  // U-4: an older pairing (an older gen) touches nothing: neither its late allow() nor its close
  {
    const S1 = server(pair43()), S2 = server(pair43()), W = fakeWs(), st = memStore();
    const P1 = mkR(S1, W, st);
    await P1.paired();
    const P2 = mkR(S2, W, st);
    await P2.paired(); await P2.allow({ folders: ["/B"], write: false, expires: null }, false);
    const r2 = held(st);
    await P1.allow({ folders: ["/A"], write: true, expires: null }, false);
    ok(r2 !== null && held(st)?.pairingId === P2.id && held(st).grant.folders.join() === "/B", "U-4.allow: a stale pairing's late allow() doesn't write the record");
    S1.sock.close(1011, "gone");
    await until(() => P1.state === "closed", 3000);
    ok(held(st)?.pairingId === P2.id && P1.lostRecord === null, "U-4.close: a stale pairing's close doesn't remove the newer pairing's record");
    await P2.revoke(); S1.srv.stop(true); S2.srv.stop(true);
  }

  // U-5: a revoke during a restore wins: the attempt ends, a late hello answer does nothing, nothing is written
  {
    let late = null;
    const S = server((ws, m) => (late = () => pair43()(ws, m))), W = fakeWs(), st = memStore();
    const P = mkR(S, W, st, { how: { session: SESSION, pairingId: "0123456789abcdef01234567", agent: { name: "Claude Code", client: "claude-code" } } });
    const settled = P.paired().then(() => "paired", () => "rejected");
    await until(() => late !== null, 3000);
    await P.revoke("revoked by the person");
    try { late(); } catch {}
    await sleep(200);
    let allowed = "threw";
    try { await P.allow({ folders: ["/A"], write: true, expires: null }, false); allowed = "allowed"; } catch {}
    ok((await settled) === "rejected" && P.state === "closed" && allowed === "threw" && st.m.size === 0, "U-5: a revoke during a restore's hello wins: the attempt is rejected, a late answer and a late allow() do nothing, no record written");
    S.srv.stop(true);
  }

  // U-6: identity: a restore's session answered by another agent (name or client) is closed, not paired
  for (const [id, agent] of [["U-6.name", { name: "Other Agent", client: "claude-code" }], ["U-6.client", { name: "Claude Code", client: "codex" }]]) {
    const S = server(pair43(agent)), W = fakeWs(), st = memStore();
    const P = mkR(S, W, st, { how: { session: SESSION, pairingId: "0123456789abcdef01234567", agent: { name: "Claude Code", client: "claude-code" } } });
    const r = await P.paired().then(() => "paired", (e) => e.code);
    await until(() => S.closed !== null, 3000);
    ok(r === "identity" && P.state === "closed" && S.closed !== null && P.grant === null && st.m.size === 0, `${id}: a hello from another agent's ${id.split(".")[1]} on this page's session is discarded closed`, { r, state: P.state });
    S.srv.stop(true);
  }
  // (U-6.order: the same, with a socket whose close is heard at once, as Bun 1.3's is (a browser's comes later): the
  //  answer is still why it was closed, said before the close; and an agent's refusal of the hello keeps its own code)
  class HeardAtOnce extends WebSocket { close(code, reason) { super.close(code, reason); this.onclose?.({ code: code ?? 1005, reason: reason ?? "" }); } }
  {
    const S = server(pair43({ name: "Other Agent", client: "claude-code" })), W = fakeWs(), st = memStore();
    const P = mkR(S, W, st, { WebSocketImpl: HeardAtOnce, how: { session: SESSION, pairingId: "0123456789abcdef01234567", agent: { name: "Claude Code", client: "claude-code" } } });
    const r = await P.paired().then(() => "paired", (e) => e.code);
    ok(r === "identity" && P.state === "closed", "U-6.order: with a close heard at once, another agent's answer is still refused as identity, not as a plain close", { r, state: P.state });
    S.srv.stop(true);
  }
  {
    const S = server((ws, m) => ws.send(JSON.stringify({ jsonrpc: "2.0", id: m.id, error: { code: -32001, message: "no", data: { code: "expired", message: "this session expired" } } }))), W = fakeWs(), st = memStore();
    const P = mkR(S, W, st, { WebSocketImpl: HeardAtOnce, how: { session: SESSION, pairingId: "0123456789abcdef01234567", agent: { name: "Claude Code", client: "claude-code" } } });
    const r = await P.paired().then(() => "paired", (e) => e.code);
    ok(r === "expired" && P.state === "closed", "U-6.order: with a close heard at once, the agent's refusal of the hello keeps its own code", { r, state: P.state });
    S.srv.stop(true);
  }
  {
    const S = server(pair43()), W = fakeWs(), st = memStore();
    const P = mkR(S, W, st, { how: { session: SESSION, pairingId: "0123456789abcdef01234567", agent: { name: "Claude Code", client: "claude-code" } } });
    const r = await P.paired().then(() => "paired", (e) => e.code);
    ok(r === "paired" && P.state === "paired", "U-6.same: the same agent's answer pairs (the identity check isn't a blanket refusal)");
    await P.revoke(); S.srv.stop(true);
  }
}
// ---- A14 r2: astra's S3 (the live grant is never cut to fit) and S4 (allow() after its await)
{
  const SESSION = "A".repeat(42) + "w";
  const pair43 = (ws, m) => ws.send(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { protocol: 1, agent: { name: "Claude Code", client: "claude-code", version: "2.0" }, wants: { write: true, run: false }, ...("code" in m.params ? { session: SESSION } : {}) } }));
  const memStore = () => { const m = new Map(); return { m, getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => void m.set(k, String(v)), removeItem: (k) => void m.delete(k) }; };
  const scope = { workspace: "sagebrush-workspace/0123456789abcdef", page: "http://127.0.0.1:1/agents/" };
  const mkR = (S, W, store, o = {}) => new AgentPairing(S.port, { code: "abcd" }, { verbsFor: W.verbsFor, store: o.storeApi ?? W.storeApi, trashEntry: W.trashEntry, page, reload: { storage: store, scope, leaving: () => false } });
  {
    const S = server(pair43), W = fakeWs(), st = memStore(), P = mkR(S, W, st);
    await P.paired();
    const folders = Array.from({ length: 6 }, (_, i) => `/f${i}/` + Array.from({ length: 3 }, () => "é".repeat(120)).join("/"));
    await P.allow({ folders, write: true, expires: null }, false);
    ok(P.state === "granted" && P.grant?.folders.join("|") === folders.join("|") && st.m.size === 0, "U-12.live: an exact grant whose record would pass 4 KiB stays exactly as allowed, and no record is stored");
    await P.revoke(); S.srv.stop(true);
  }
  {
    // (an allow() suspended at its await; then a revoke; then it goes on: nothing of it may come back)
    const S = server(pair43), W = fakeWs(), st = memStore(), P = mkR(S, W, st);
    await P.paired();
    const pending = P.allow({ folders: ["/A"], write: true, expires: Date.now() + 200 }, false);
    await P.revoke("revoked by the person");
    await pending.catch(() => {});
    const right = P.state; // (at once, before its 200 ms expiry could close it again)
    await sleep(400);
    ok(right === "closed" && P.state === "closed" && P.grant === null && st.m.size === 0 && P.closeReason === "revoked by the person", "U-13.pending: a revoke while allow() waits wins: no granted state, no record, and no expiry timer fires after", { right, state: P.state, reason: P.closeReason });
    S.srv.stop(true);
  }
  {
    // (the same with a remembered grant whose keep is held: the revoke and the store's release in that order)
    const S = server(pair43), W = fakeWs(), st = memStore();
    let release;
    const held = new Promise((r) => (release = r));
    const storeApi = { agentGrants: W.storeApi.agentGrants, putAgentGrant: async (id, g) => { if (g !== null) await held; return W.storeApi.putAgentGrant(id, g); } };
    const P = mkR(S, W, st, { storeApi });
    await P.paired();
    const pending = P.allow({ folders: ["/A"], write: true, expires: Date.now() + 3_600_000 }, true);
    await sleep(50);
    await P.revoke("revoked by the person");
    release();
    await pending.catch(() => {});
    // (at once, as the allow() settles, before the socket's close event could close it again (sock.onclose → end()),
    //  and again after: a mutant whose allow() goes on is caught in either order (the grader's K14-ae ruling))
    const right = P.state;
    await sleep(100);
    ok(right === "closed" && P.state === "closed" && P.grant === null && st.m.size === 0, "U-13.pending-kept: a revoke while a remembered allow() waits on its store wins: still closed after the store goes on", { right, state: P.state });
    S.srv.stop(true);
  }
}
// ---- chat plan PR 3: the grant's id (Q1), git_branch's routing, and notebook.edit's branch check
{
  const S = server(pairOk), W = fakeWs();
  const owners = [];
  const verbsFor = (actor, host) => { owners.push(host?.owner); const v = W.verbsFor(actor); v.holdChange = async (p) => { W.checked = (W.checked ?? []).concat(p); if (p.startsWith("/Branches/theirs/")) throw Object.assign(new Error("this branch was made under another connection: ask the person to remove it, or make a new one with git_branch"), { code: "invalid" }); W.held = (W.held ?? 0) + 1; return () => { W.held--; }; }; return v; };
  const branches = [];
  let edits = 0;
  const holds = [], heldAtApply = [];
  const { gitBranchParams, gitBranchProblem } = await import("./git-branch.ts");
  const gitBranch = { params: gitBranchParams, problem: gitBranchProblem, run: async (a) => { branches.push(a); if (a.name === "slow") await new Promise((r) => setTimeout(r, 200)); return { branch: `agent/${a.name}`, worktree: `/Branches/${a.name}/`, files: 1, bytes: 1, next: "n" }; } };
  const P = new AgentPairing(S.port, { code: "abcd" }, { verbsFor, gitBranch, store: W.storeApi, trashEntry: W.trashEntry, page, notebookEdit: async (e, may, hold) => { holds.push(!!hold); if (hold) { const release = await hold(); heldAtApply.push(W.held); release(); } edits++; return { ok: true }; } });
  await P.paired();
  await P.allow({ folders: ["/"], write: true, expires: Date.now() + 3_600_000 }, true);
  const id1 = P.grant.id;
  ok(/^[0-9a-f]{32}$/.test(id1) && owners.at(-1)() === id1, "a grant gets a page-made random id, the owner forAgent is given");
  ok([...W.store.values()].some((k) => k.grant.id === id1), "a remembered grant is kept with its id");
  await P.allow({ folders: ["/", "/A"], write: true, expires: Date.now() + 3_600_000 }, true);
  ok(P.grant.id === id1, "the same pairing's grant changed: the same id");
  await P.allow({ folders: ["/"], write: true, expires: Date.now() + 3_600_000, id: "zz" }, true);
  ok(P.grant.id === id1, "an id that isn't one: not taken");
  const r = await S.request("workspace.git_branch", { name: "fix-plots" });
  const b = branches.at(-1);
  ok(r.result?.branch === "agent/fix-plots" && b.name === "fix-plots" && b.owner === id1 && b.folders.join() === "/" && b.actor === "agent:Claude-Code" && b.live() === true, "git_branch: the page's, for this grant's id, its folders, while it is in force");
  const bad = await S.request("workspace.git_branch", { name: "Fix" });
  ok(bad.error?.data?.message === "a branch name is 1 to 40 of a-z, 0-9 and -, starting with a letter or digit" && branches.length === 1, "a name that isn't one: said as cleared, nothing called");
  const extra = await S.request("workspace.git_branch", { name: "ok", to: "/A" });
  ok(extra.error?.data?.code === "invalid" && branches.length === 1, "git_branch with another parameter: refused by the schema");
  // (notebook.edit in /Branches: the page gets `hold`, the branches' check holding the workspace's lock (holdChange)
  //  until the page releases it after its apply; refused, nothing applied)
  P.hello.features = ["notebook.edit"];
  const edit = (path) => ({ conversation: "c", path, ref: "r", base: 1, insert: [{ source: "1", after: null }], was: {} });
  const e1 = await S.request("notebook.edit", edit("/Branches/theirs/n.ipynb"));
  ok(e1.error?.data?.message === "this branch was made under another connection: ask the person to remove it, or make a new one with git_branch" && edits === 0 && W.checked?.includes("/Branches/theirs/n.ipynb"), `notebook.edit in another grant's branch: refused by the hold, nothing applied (${JSON.stringify(e1.error?.data ?? e1.result).slice(0, 160)})`);
  const e2 = await S.request("notebook.edit", edit("/A/doc.ipynb"));
  ok(e2.result?.ok === true && edits === 1 && !W.checked.includes("/A/doc.ipynb") && holds[1] === false, `notebook.edit outside /Branches: no hold, no wait on the workspace's lock (${JSON.stringify(e2.error?.data ?? e2.result).slice(0, 160)})`);
  const e3 = await S.request("notebook.edit", edit("/Branches/mine/n.ipynb"));
  ok(e3.result?.ok === true && edits === 2 && W.checked.includes("/Branches/mine/n.ipynb") && heldAtApply.at(-1) === 1 && W.held === 0, "notebook.edit in /Branches: the hold kept through the apply, then released");
  // (revoked while it runs: live() goes false; a new grant after it is a new owner)
  const slow = S.request("workspace.git_branch", { name: "slow" });
  await until(() => branches.at(-1)?.name === "slow");
  await P.revoke("revoked by the person");
  ok(branches.at(-1).live() === false, "revoked during git_branch: its live() is false at once");
  await slow;
  S.srv.stop(true);
  const S2 = server(pairOk), P2 = new AgentPairing(S2.port, { code: "abcd" }, { verbsFor, gitBranch, store: W.storeApi, trashEntry: W.trashEntry, page });
  await P2.paired();
  await P2.allow({ folders: ["/"], write: true, expires: null }, false);
  ok(/^[0-9a-f]{32}$/.test(P2.grant.id) && P2.grant.id !== id1, "a new pairing's grant: a new id (a new owner)");
  const P2ro = await S2.request("workspace.git_branch", { name: "x" });
  ok(P2ro.result?.branch === "agent/x", "git_branch through a grant until this page closes");
  await P2.allow({ folders: ["/A"], write: true, expires: null }, false);
  const nb = await S2.request("workspace.git_branch", { name: "y" });
  ok(nb.error?.data?.message === "branches go in /Branches, which your grant doesn't include: ask the person to allow it, or work in the folders you have", "narrowed without /Branches: refused as cleared");
  await P2.allow({ folders: ["/"], write: false, expires: null }, false);
  const ro = await S2.request("workspace.git_branch", { name: "y" });
  ok(ro.error?.data?.message === "the grant is read only: ask the person to allow changes", "read only: refused with git_branch's own text");
  S2.srv.stop(true);
  // (a resumption with its id: the same owner; a page without git_branch says it isn't a verb)
  const S3 = server(pairOk), P3 = new AgentPairing(S3.port, { code: "abcd" }, { verbsFor, store: W.storeApi, trashEntry: W.trashEntry, page });
  await P3.paired();
  await P3.allow({ folders: ["/"], write: true, expires: null, id: id1 }, false);
  ok(P3.grant.id === id1, "a resumption of a kept grant keeps its id");
  const nv = await S3.request("workspace.git_branch", { name: "z" });
  ok(/not a verb/.test(nv.error?.data?.message ?? ""), "a page without git_branch: not a verb there");
  S3.srv.stop(true);
}
// ---- the branch history's verbs (git_commit, git_status, git_wait): routed to the page's own module (gitVerbs, served as
// the run verbs are); a git_commit that succeeds is one of the agent's changes, counted and told once; nothing else is
{
  const S = server(pairOk), W = fakeWs();
  const calls = [];
  let refuse = false;
  const gitVerbs = { async serve(method, params, side) {
    calls.push(method);
    if (refuse) return side.fail("conflict", "refused by the page's module");
    side.reply({ method });
  } };
  const P = new AgentPairing(S.port, { code: "abcd" }, { verbsFor: (actor) => W.verbsFor(actor), gitVerbs, store: W.storeApi, trashEntry: W.trashEntry, page });
  await P.paired();
  await P.allow({ folders: ["/"], write: true, expires: null }, false);
  let told = 0;
  P.onChange(() => told++);
  const c0 = P.changes, t0 = told;
  const r1 = await S.request("workspace.git_commit", { name: "b", message: "m" });
  ok(r1.result?.method === "workspace.git_commit" && P.changes === c0 + 1 && told === t0 + 1, `git_commit through the pairing: the page's module answers; one change, counted and told once (${P.changes - c0}, ${told - t0})`);
  const r2 = await S.request("workspace.git_status", { name: "b" });
  const r3 = await S.request("workspace.git_wait", { name: "b" });
  ok(r2.result?.method === "workspace.git_status" && r3.result?.method === "workspace.git_wait" && P.changes === c0 + 1 && told === t0 + 1, "git_status and git_wait: answered, nothing counted or told");
  refuse = true;
  const r4 = await S.request("workspace.git_commit", { name: "b", message: "m" });
  ok(r4.error?.data?.code === "conflict" && P.changes === c0 + 1 && told === t0 + 1, "a git_commit the page's module refuses: said, nothing counted");
  refuse = false;
  ok(calls.join() === "workspace.git_commit,workspace.git_status,workspace.git_wait,workspace.git_commit", `each routed to the page's module (${calls.join()})`);
  const r5 = await S.request("workspace.git_branchx", { name: "b" });
  ok(/not a verb/.test(r5.error?.data?.message ?? "") && calls.length === 4, "a method of another name: not routed there");
  S.srv.stop(true);
  // (a page that doesn't offer branches: the three are no verb there, and nothing is counted)
  const S2 = server(pairOk), P2 = new AgentPairing(S2.port, { code: "abcd" }, { verbsFor: (actor) => W.verbsFor(actor), store: W.storeApi, trashEntry: W.trashEntry, page });
  await P2.paired();
  await P2.allow({ folders: ["/"], write: true, expires: null }, false);
  const n1 = await S2.request("workspace.git_commit", { name: "b", message: "m" });
  ok(/not a verb/.test(n1.error?.data?.message ?? "") && P2.changes === 0, "a page without branches: git_commit is no verb there, nothing counted");
  S2.srv.stop(true);
}
// (the reload record keeps the grant's id; one without an id is still read (a new owner on restore), a bad one isn't)
{
  // (written by allow(): the record holds the very id of the grant in force)
  const S = server((ws, msg) => ws.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocol: 1, agent: { name: "Claude Code", client: "claude-code" }, wants: {}, session: "A".repeat(42) + "w" } }))), W = fakeWs(), m = new Map();
  const storage = { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v), removeItem: (k) => m.delete(k) };
  const P = new AgentPairing(S.port, { code: "abcd" }, { verbsFor: W.verbsFor, store: W.storeApi, trashEntry: W.trashEntry, page, reload: { storage, scope: { workspace: "w", page: "p" }, leaving: () => false } });
  await P.paired();
  await P.allow({ folders: ["/A"], write: true, expires: null }, false);
  ok(parseReloadRecord(m.get(RELOAD_KEY) ?? null)?.grant.id === P.grant.id && /^[0-9a-f]{32}$/.test(P.grant.id), "the reload record written by allow() keeps the grant's id");
  S.srv.stop(true);
  const rec = { v: 1, pairingId: "a".repeat(24), session: "S".repeat(43), port: 9, agent: { name: "n", client: "c" }, grant: { folders: ["/"], write: true, expires: null, id: "0".repeat(32) }, workspace: "w", page: "p" };
  ok(parseReloadRecord(JSON.stringify(rec))?.grant.id === "0".repeat(32), "the reload record: the grant's id read back");
  const { id: _i, ...noId } = rec.grant;
  ok(parseReloadRecord(JSON.stringify({ ...rec, grant: noId })) !== null, "a record without an id (from before): still read");
  ok(parseReloadRecord(JSON.stringify({ ...rec, grant: { ...rec.grant, id: "XYZ" } })) === null, "a record with an id that isn't one: no record");
}
// The line under a failed Connect names Safari only in Safari, Chrome's permission only in Chromium, and is browser-neutral
// elsewhere (a Firefox user was told "Safari can't …": the board's B2 on #917)
{
  const ff = failHint("Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0");
  ok(ff === OTHER_FAIL && !/Safari|Chrome/.test(ff), "a failed Connect in Firefox gets the browser-neutral line");
  ok(failHint("Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15") === SAFARI, "in Safari: Safari's reason");
  ok(failHint("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0 Safari/537.36") === CHROME_ALLOW, "in Chrome: its permission");
  ok(failHint("Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0 Safari/537.36 Edg/149.0") === CHROME_ALLOW, "in Edge: Chrome's permission");
  ok(![SAFARI, CHROME_ALLOW, OTHER_FAIL].some((t) => t.length > 110 || /\n/.test(t)), "each is one short line");
}
{
  // Connect's one field (decided Nov 19 2026): the agent's link as pasted, with or without https://, or "CODE PORT" /
  // "CODE:PORT"; a code alone only with the port its ?pair link came with, else: ask the agent for its link
  const C = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const is = (r, code, port) => !("error" in r) && r.code === code && r.port === port;
  ok(is(readConnect(`https://sagebrush.space/board/?pair=${C}&port=49589`), C, 49589), "the link, pasted");
  ok(is(readConnect(`  sagebrush.space/board/?pair=${C}&port=49589 `), C, 49589), "the link without https://, spaces around it");
  ok(is(readConnect(`https://sagebrush.space/board/?port=7&pair=${C}`), C, 7), "the link, its parameters in either order");
  ok(is(readConnect(`${C} 49589`), C, 49589) && is(readConnect(`${C}:49589`), C, 49589) && is(readConnect(`${C} : 49589`), C, 49589), "CODE PORT and CODE:PORT");
  ok(is(readConnect(C, "49589"), C, 49589), "a code alone, with the port its ?pair link came with");
  ok(readConnect(C).error === ONLY_CODE && /link/.test(ONLY_CODE) && !/port/i.test(ONLY_CODE), "a code alone, no port: ask the agent for its link (no port to find)");
  ok(/no port/.test(readConnect(`https://sagebrush.space/board/?pair=${C}`).error ?? ""), "a link with no port: ask for it again");
  ok(/port isn't right/.test(readConnect(`${C} 70000`).error ?? "") && /port isn't right/.test(readConnect(`https://x/board/?pair=${C}&port=0`).error ?? ""), "a port out of range");
  let threw = null;
  const bad = ["https://sagebrush.space/board/?pair=%&port=7", "https://sagebrush.space/board/?pair=%E0%A4&port=7"].map((l) => { try { return readConnect(l); } catch (e) { threw = e; return null; } });
  ok(!threw && bad.every((r) => /isn't right/.test(r?.error ?? "")), "a malformed %-escape in the code: the inline error, nothing thrown", { threw: String(threw), bad });
  ok(/Paste/.test(readConnect("  ").error ?? "") && /isn't the agent's link/.test(readConnect("https://sagebrush.space/agents/").error ?? ""), "nothing, or another link");
}
{
  // (the grant dialog's name for the agent: its program only when it differs from the name, never the same word twice)
  ok(agentSays("claude-code", "claude-code") === "claude-code (as it says)", "one name for both: said once", agentSays("claude-code", "claude-code"));
  ok(agentSays("Claude Code", "claude-code") === "Claude Code (as it says, claude-code)", "a name and a different program: both");
  ok(agentSays("Codex", "") === "Codex (as it says)", "no program: the name alone");
}
{
  // the board page's handover of a bare pairing link to the notebook page (pair-handoff.ts): within the tab, once, fresh
  const mem = new Map();
  globalThis.sessionStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => void mem.set(k, String(v)), removeItem: (k) => void mem.delete(k) };
  const L = { code: "ABCDEFGHIJKLMNOPQRSTUVWXYZ", port: "49589" };
  ok(handOver(L, 1000) && mem.has(HANDOFF_KEY), "handed over: stored in the tab");
  ok(takeHandoff("/board/", 1001) === null && mem.has(HANDOFF_KEY), "a page other than the notebook page neither takes nor deletes it");
  const got = takeHandoff("/", 1001);
  ok(got?.code === L.code && got?.port === L.port && !mem.has(HANDOFF_KEY), "the notebook page takes it, deleting it as it reads");
  ok(takeHandoff("/", 1002) === null, "once only: a second read (a reload) finds nothing");
  handOver(L, 1000);
  ok(takeHandoff("/", 1000 + HANDOFF_MS) === null && !mem.has(HANDOFF_KEY), "a stale one is deleted, never used");
  mem.set(HANDOFF_KEY, JSON.stringify({ code: "<x>", port: "1", at: 1000 }));
  ok(takeHandoff("/", 1001) === null && !mem.has(HANDOFF_KEY), "a malformed one is deleted, never used");
  globalThis.sessionStorage = { getItem: () => null, setItem: () => { throw new Error("refused"); }, removeItem: () => {} };
  ok(handOver(L, 1000) === false, "storage refused: not handed over (the board page keeps the link and pairs there)");
  globalThis.sessionStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  ok(handOver(L, 1000) === false, "storage that doesn't keep it: not handed over either");
  delete globalThis.sessionStorage;
}
{
  // (a creation is told to the page only by the pairing the page has adopted: an older or superseded one's never is)
  const told = [], P1 = { n: 1 }, P2 = { n: 2 };
  let cur = P1;
  const cb = onlyCurrent(() => cur, (c, p) => told.push([c.op, p.n]));
  cb({ op: "a" }, P1);
  cur = P2;
  cb({ op: "b" }, P1);
  cb({ op: "c" }, P2);
  cur = null;
  cb({ op: "d" }, P2);
  ok(JSON.stringify(told) === JSON.stringify([["a", 1], ["c", 2]]), "a creation reaches the page only from the pairing it has adopted then", told);
}
// ---- what an agent creates, and whether it may run once by itself (the conditions decided Nov 18 2026): only the last
// document this pairing created, under the grant still in force, with May run code and Everything
{
  const S = server(pairOk), W = fakeWs();
  let now = Date.now();
  const told = [];
  const P = new AgentPairing(S.port, { code: "abcd-efgh ijkl" }, { verbsFor: W.verbsFor, store: W.storeApi, trashEntry: W.trashEntry, page, now: () => now, onCreated: (c) => told.push(c) });
  await P.paired();
  await P.allow({ folders: ["/"], write: true, run: true, expires: now + 60_000 }, false);
  const r = await S.request("workspace.create", { path: "/A/new.ipynb" });
  const c = told[0];
  ok(r.result && told.length === 1 && c === P.created && c.kind === "notebook" && c.ref === "INTERNAL" && /^[A-Za-z0-9_-]{8,}$/.test(c.op) && c.grant === P.grant.id && c.updated === 2, "a create under the grant: told to the page once, with its op, identity, grant and revision", c);
  ok(P.mayRunCreated(c), "Everything and May run code, the grant in force: it may run");
  ok(!P.mayRunCreated({ ...c }), "a copy of the record, not the pairing's own: never");
  await S.request("workspace.mkdir", { path: "/A/sub" });
  ok(told.length === 1 && P.created === c, "a folder made: nothing told, nothing kept");
  await S.request("workspace.create", { path: "/A/two.ipynb" });
  const c2 = told[1];
  ok(c2 && !P.mayRunCreated(c) && P.mayRunCreated(c2), "a later creation: only the last may run");
  now += 61_000;
  ok(!P.mayRunCreated(c2), "the grant expired: never");
  now -= 61_000;
  await P.noRun();
  ok(!P.mayRunCreated(c2), "May run code turned off: never");
  await P.revoke();
  ok(!P.mayRunCreated(c2), "revoked: never");
  S.srv.stop(true);
}
for (const [what, grant] of [["a folder, not Everything", { folders: ["/A"], write: true, run: true, expires: null }], ["no May run code", { folders: ["/"], write: true, run: false, expires: null }]]) {
  const S = server(pairOk), W = fakeWs();
  const P = mk(S, W);
  await P.paired();
  await P.allow(grant, false);
  const r = await S.request("workspace.create", { path: "/A/n.ipynb" });
  ok(r.result && P.created && !P.mayRunCreated(P.created), `${what}: never runs by itself`);
  await P.revoke();
  S.srv.stop(true);
}
// ---- a local pairing's port: 1 to 65535, an integer, refused otherwise before anything is made, whether or not this
// runtime has BroadcastChannel (the editors' channel is made only after; a regression: it once took the port check's
// place, so with BroadcastChannel every port was admitted)
{
  const W = fakeWs();
  const make = (port) => { try { new AgentPairing(port, { code: "abcd-efgh ijkl" }, { verbsFor: W.verbsFor, store: W.storeApi, trashEntry: W.trashEntry, page, WebSocketImpl: class { constructor() { throw new Error("no socket for a refused port"); } } }); return "admitted"; } catch (e) { return e instanceof AgentError && e.code === "invalid" && /1 to 65535/.test(e.message) ? "refused" : "other: " + e.message; } };
  const bad = [0, -1, 65536, 1.5, NaN];
  const BC = globalThis.BroadcastChannel;
  ok(typeof BC === "function" && bad.every((p) => make(p) === "refused"), "with BroadcastChannel: ports 0, -1, 65536, 1.5 and NaN are refused", bad.map(make));
  try {
    delete globalThis.BroadcastChannel;
    ok(typeof globalThis.BroadcastChannel === "undefined" && bad.every((p) => make(p) === "refused"), "without BroadcastChannel: the same ports refused", bad.map(make));
  } finally { globalThis.BroadcastChannel = BC; }
  // (over a runner's link there is no local port: none is checked, with or without BroadcastChannel)
  const viaLink = () => { try { const P = new AgentPairing(0, { link: { socket: () => ({ send() {}, close() {}, addEventListener() {}, removeEventListener() {} }), ready: () => undefined, send: () => "ok", owe: () => true, answer() {}, disconnect: async () => {} }, computer: "box" }, { verbsFor: W.verbsFor, store: W.storeApi, trashEntry: W.trashEntry, page }); P.drop?.("test"); return "admitted"; } catch (e) { return "refused: " + e.message; } };
  const withBc = viaLink();
  let withoutBc;
  try { delete globalThis.BroadcastChannel; withoutBc = viaLink(); } finally { globalThis.BroadcastChannel = BC; }
  ok(withBc === "admitted" && withoutBc === "admitted", "a pairing over a runner's link: no port is checked (port 0 admitted), with or without BroadcastChannel", { withBc, withoutBc });
}
// ---- a .tex this agent made runs once by itself in the editor that shows it (decided Nov 19 2026,
// agent-made-tex.ts): an editor asks over the site's channel whether the file at a revision may; the pairing says
// yes once, for the .tex it last created or built (done, unchanged since), at that revision, under mayRunCreated's
// conditions; and tells the editors when it made one
{
  const S = server(pairOk), W = fakeWs();
  const revs = new Map(), base = W.verbsFor;
  W.verbsFor = (actor) => { const v = base(actor); return { ...v, create: async (p, ...a) => ({ ...(await v.create(p, ...a)), rev: revs.get(p) ?? 0 }), stat: async (p) => { const e = await v.stat(p); return e && { ...e, rev: revs.get(p) ?? 0 }; } }; };
  let builds = 0, during = null;
  const runVerbs = { serve: async (method, params, ctx) => { builds++; during?.(); ctx.reply({ ok: true, ended: "done" }); } };
  let now = Date.now();
  const P = new AgentPairing(S.port, { code: "abcd-efgh ijkl" }, { verbsFor: W.verbsFor, store: W.storeApi, trashEntry: W.trashEntry, page, now: () => now, runVerbs });
  const ed = new BroadcastChannel("sagebrush-agent-made"), heard = [];
  ed.onmessage = (e) => heard.push(e.data);
  let n = 0;
  const ask = async (fid, rev) => { const id = "q" + ++n; ed.postMessage({ t: "tex-may-run", id, fid, rev }); await sleep(120); return heard.some((m) => m.t === "tex-may-run" && m.id === id && m.ok === true); };
  const told = (rev) => heard.some((m) => m.t === "tex-made" && m.fid === "FID" && m.rev === rev);
  await P.paired();
  await P.allow({ folders: ["/"], write: true, run: true, expires: now + 60_000 }, false);
  await S.request("workspace.create", { path: "/A/paper.tex" });
  ok(await until(() => told(0)) && P.created?.fid === "FID" && P.created.rev === 0, "a .tex created: the editors told its fid and revision", heard);
  ok(!(await ask("FID", 1)) && !(await ask("OTHER", 0)), "another revision, another file: no answer");
  ok(await ask("FID", 0), "the revision it created, the grant in force with Everything and May run code: yes");
  ok(!(await ask("FID", 0)), "asked again: no answer, its one run spent");
  // (built: done, and the file unchanged meanwhile; then a build during which it changed: nothing kept)
  revs.set("/A/paper.tex", 3);
  const b = await S.request("workspace.latex_build", { path: "/A/paper.tex" });
  ok(b.result?.ok === true && builds === 1 && await until(() => told(3)) && P.built?.rev === 3 && P.built.fid === "FID", "a .tex built (done, unchanged since): kept at its revision, the editors told", { built: P.built, heard });
  ok(await ask("FID", 3) && !(await ask("FID", 3)), "built: yes once, then spent");
  during = () => revs.set("/A/paper.tex", 4);
  const kept = P.built;
  await S.request("workspace.latex_build", { path: "/A/paper.tex" });
  await sleep(150);
  ok(builds === 2 && P.built === kept && !told(4) && !(await ask("FID", 4)), "a build during which the file changed: nothing kept, nothing told, no answer");
  during = null;
  revs.set("/A/paper.tex", 5);
  await S.request("workspace.latex_build", { path: "/A/paper.tex" });
  await until(() => told(5));
  now += 61_000;
  ok(!(await ask("FID", 5)), "the grant expired: no answer");
  // (expired by the clock, its timer not fired yet: a latex_build reads nothing for a run by itself)
  const stats = () => W.calls.filter((c) => c === "stat").length;
  const st0 = stats(), served0 = builds;
  await S.request("workspace.latex_build", { path: "/A/paper.tex" });
  ok(stats() === st0, "the grant expired (its timer not fired yet): a latex_build reads nothing for the .tex's run by itself", { stats: stats() - st0, served: builds - served0 });
  now -= 61_000;
  await P.noRun();
  ok(!(await ask("FID", 5)), "May run code turned off: no answer");
  await P.revoke();
  ok(!(await ask("FID", 5)), "revoked: no answer");
  ed.close();
  S.srv.stop(true);
}
// ---- edit.turn: a notebook.edit carries the turn it came from, added by the agent's server; taken out before the edit's
// grammar is checked and handed to the page's apply beside the edit; only when both ends said it
{
  const S = server(pairOk), W = fakeWs();
  const seen = [];
  const P = new AgentPairing(S.port, { code: "abcd-efgh ijkl" }, { verbsFor: W.verbsFor, store: W.storeApi, trashEntry: W.trashEntry, page, notebookEdit: async (e, may, hold, turnId) => { seen.push({ e, turnId }); return { ok: true, inserted: [] }; } });
  await P.paired();
  await P.allow({ folders: ["/"], write: true, expires: null }, false);
  await until(() => S.got.some((m) => m.method === "page.features"));
  ok(S.got.find((m) => m.method === "page.features").params.features.includes("edit.turn"), "a page that edits notebooks offers edit.turn (page.features)");
  const edit = (extra = {}) => ({ conversation: "c", path: "/A/doc.ipynb", ref: "r", base: 1, insert: [{ source: "1", after: null }], was: {}, ...extra });
  const send = async (params) => { const n = seen.length; const r = await S.request("notebook.edit", params); return { r, got: seen.length > n ? seen.at(-1) : null }; };
  P.hello.features = ["notebook.edit"];
  const b0 = await send(edit({ turn_id: "t1" }));
  ok(b0.got === null && b0.r.error?.data?.code === "invalid", "the agent didn't say edit.turn: an edit with turn_id is refused by the edit's grammar, nothing applied", b0.r);
  P.hello.features = ["notebook.edit", "edit.turn"];
  const b1 = await send(edit({ turn_id: "t1" }));
  ok(b1.got?.turnId === "t1" && !("turn_id" in b1.got.e) && b1.r.result?.ok === true, "both said it: the turn taken out of the edit and handed beside it", b1.got);
  const b2 = await send(edit());
  ok(b2.got === null && b2.r.error?.data?.code === "invalid", "both said it: an edit without turn_id is refused, nothing applied (it can't pass the turn's check by leaving it out)", b2.r);
  P.hello.features = ["notebook.edit"];
  const b3 = await send(edit());
  ok(b3.got && b3.got.turnId === undefined, "an agent that didn't say edit.turn: an edit without turn_id as before, no turn handed", b3.got);
  P.hello.features = ["notebook.edit", "edit.turn"];
  for (const bad of [5, "", "x".repeat(129), null]) {
    const b = await send(edit({ turn_id: bad }));
    ok(b.got === null && b.r.error?.data?.code === "invalid", `a turn_id that isn't an id (${JSON.stringify(bad).slice(0, 20)}): refused, nothing applied`, b.r);
  }
  await P.revoke();
  S.srv.stop(true);
}
// ---- run.context: a run verb's call carries the chat and the turn it came from, added by the agent's server; taken out
// before the params are checked and handed to the run beside them, both or neither; only when both ends said it
{
  const S = server(pairOk), W = fakeWs();
  const seen = [];
  const runVerbs = { serve: async (method, params, ctx) => { seen.push({ params, context: ctx.context }); ctx.reply({ ok: true, ended: "done" }); } };
  const P = new AgentPairing(S.port, { code: "abcd-efgh ijkl" }, { verbsFor: W.verbsFor, store: W.storeApi, trashEntry: W.trashEntry, page, runVerbs });
  await P.paired();
  await P.allow({ folders: ["/"], write: true, run: true, expires: null }, false);
  await until(() => S.got.some((m) => m.method === "page.features"));
  ok(S.got.find((m) => m.method === "page.features").params.features.includes("run.context"), "a page with run verbs offers run.context (page.features)");
  {
    // (A2-1: said before the grant, so a server never takes the grant from a page whose features it doesn't know yet)
    await until(() => S.got.some((m) => m.method === "grant.changed"));
    const at = (method) => S.got.findIndex((m) => m.method === method);
    ok(at("page.features") >= 0 && at("page.features") < at("grant.changed"), "page.features is sent before grant.changed", S.got.map((m) => m.method));
  }
  const run = async (params) => { const n = seen.length; const r = await S.request("workspace.run_notebook", params); return { r, got: seen.length > n ? seen.at(-1) : null }; };
  const a0 = await run({ path: "/A/doc.ipynb", conversation: "c1", turn_id: "t1" });
  ok(a0.got?.params.conversation === "c1" && a0.got.context === undefined, "the agent didn't say run.context: its params as they are, no context (the run's own check refuses them)", a0.got);
  P.hello.features = ["run.context"];
  const a1 = await run({ path: "/A/doc.ipynb", timeout_s: 5, conversation: "c1", turn_id: "t1" });
  ok(JSON.stringify(a1.got?.params) === JSON.stringify({ path: "/A/doc.ipynb", timeout_s: 5 }) && a1.got.context?.conversation === "c1" && a1.got.context.turnId === "t1", "both said it: the chat and the turn taken out of the params and handed beside them", a1.got);
  const a2 = await run({ path: "/A/doc.ipynb", conversation: "c1" });
  ok(JSON.stringify(a2.got?.params) === JSON.stringify({ path: "/A/doc.ipynb" }) && a2.got.context === undefined, "the chat without the turn: taken out, no context", a2.got);
  const a3 = await run({ path: "/A/doc.ipynb" });
  ok(a3.got && a3.got.context === undefined, "neither: no context", a3.got);
  for (const bad of [{ conversation: 5, turn_id: "t1" }, { conversation: "c1", turn_id: "" }, { conversation: "c1", turn_id: "x".repeat(129) }]) {
    const b = await run({ path: "/A/doc.ipynb", ...bad });
    ok(b.got === null && b.r.error?.data?.code === "invalid", `a chat or turn that isn't an id (${JSON.stringify(bad).slice(0, 60)}): refused, nothing run`, b.r);
  }
  await P.revoke();
  S.srv.stop(true);
}
{
  // (a folder, not Everything: told nothing to run, and no answer)
  const S = server(pairOk), W = fakeWs(), base = W.verbsFor;
  W.verbsFor = (actor) => { const v = base(actor); return { ...v, create: async (p, ...a) => ({ ...(await v.create(p, ...a)), rev: 0 }) }; };
  const P = mk(S, W);
  const ed = new BroadcastChannel("sagebrush-agent-made"), heard = [];
  ed.onmessage = (e) => heard.push(e.data);
  await P.paired();
  await P.allow({ folders: ["/A"], write: true, run: true, expires: null }, false);
  await S.request("workspace.create", { path: "/A/p.tex" });
  await until(() => heard.length > 0);
  ed.postMessage({ t: "tex-may-run", id: "qa", fid: "FID", rev: 0 });
  await sleep(150);
  ok(P.created?.rev === 0 && !heard.some((m) => m.id === "qa"), "a folder's grant, not Everything: a created .tex never runs by itself (no answer)", heard);
  await P.revoke();
  ed.close();
  S.srv.stop(true);
}
// ---- U-9: a single entry's answer has its page's address (url), from that very entry, the one the verb returned under
// the grant: no other read, and nothing once the grant has changed
{
  const S = server(pairOk), W = fakeWs();
  W.files.set("/A/p.tex", "\\begin{document}\\end{document}");
  W.files.set("/A/d.csv", "1,2");
  // (the verb's own entry carries one fid, a stat another: the url must be the verb's)
  const base = W.verbsFor;
  W.verbsFor = (actor) => { const v = base(actor); return { ...v, read: async (p) => { const r = await v.read(p); return { ...r, entry: { ...r.entry, fid: "AUTHFID" } }; }, stat: async (p) => { const e = await v.stat(p); return e && { ...e, fid: p === "/A/p.tex" && W.otherFid ? "OTHER" : e.fid }; } }; };
  const P = mk(S, W);
  await P.paired();
  await P.allow({ folders: ["/A"], write: true, expires: null }, false);
  W.calls.length = 0;
  W.otherFid = true;
  const rd = (await S.request("workspace.read", { path: "/A/p.tex" })).result;
  ok(rd?.entry?.url === page.origin + "/?tex=AUTHFID" && W.calls.join() === "read" && !("fid" in rd.entry) && !("ref" in rd.entry), "U-9a: read's entry has url, from the very entry the read returned (no stat, no other read); still no fid or ref of its own", { entry: rd?.entry, calls: W.calls });
  W.otherFid = false;
  const nb = (await S.request("workspace.stat", { path: "/A/doc.ipynb" })).result;
  const mk1 = (await S.request("workspace.create", { path: "/A/new.ipynb" })).result;
  const ls = (await S.request("workspace.list", { folder: "/A" })).result;
  const csv = (await S.request("workspace.stat", { path: "/A/d.csv" })).result;
  const dir = (await S.request("workspace.mkdir", { path: "/A/sub" })).result;
  ok(nb?.entry?.url === page.origin + "/?nb=INTERNAL" && mk1?.entry?.url === page.origin + "/?nb=INTERNAL" && ls?.entries?.every((e) => !("url" in e)) && !("url" in (csv?.entry ?? {})) && !("url" in (dir?.entry ?? {})),
    "U-9b: stat and create have it (a notebook: its page by ref); list's entries, a data file and a folder have none", { nb: nb?.entry, made: mk1?.entry, csv: csv?.entry, dir: dir?.entry });
  S.srv.stop(true);
}
{
  // (the grant revoked while the read runs: nothing of it is sent, no url either, and nothing more is read for one)
  const S = server(pairOk), W = fakeWs();
  W.files.set("/A/p.tex", "x");
  const P = mk(S, W);
  await P.paired();
  await P.allow({ folders: ["/A"], write: true, expires: null }, false);
  W.calls.length = 0;
  const go = W.holdReads();
  const r = S.request("workspace.read", { path: "/A/p.tex" }, { wait: 1500 });
  await until(() => W.reads === 1);
  await P.revoke();
  go();
  const a = await r;
  ok(!JSON.stringify(a ?? null).includes("url") && !JSON.stringify(a ?? null).includes("FID") && W.calls.join() === "read", "U-9c: revoked while the read runs: no url and nothing of it sent, and no stat or second read after", { a, calls: W.calls });
  S.srv.stop(true);
}
{
  // (the grant expired while the read ran: the answer is CHANGED_WHILE_RUNNING, with no url, and no stat)
  const S = server(pairOk), W = fakeWs();
  W.files.set("/A/p.tex", "x");
  let t = 9_000_000;
  const P = mk(S, W, { code: "x" }, () => t);
  await P.paired();
  await P.allow({ folders: ["/A"], write: true, expires: t + 60_000 }, false);
  W.calls.length = 0;
  const go = W.holdReads();
  const r = S.request("workspace.read", { path: "/A/p.tex" }, { wait: 3000 });
  await until(() => W.reads === 1);
  t += 120_000;
  go();
  const a = await r;
  ok(a?.error?.data?.code === "invalid" && a.error.data.message === CHANGED_WHILE_RUNNING && !JSON.stringify(a).includes("url") && W.calls.join() === "read", "U-9d: expired once the read resolved: CHANGED_WHILE_RUNNING, no url, no stat", { err: a?.error?.data, calls: W.calls });
  S.srv.stop(true);
}
console.log(failures ? `${failures} failed` : "all passed");
// ---- Delegate's requests (tasks-client.ts, pair-delegate-plan-r3.3 §2.5, over AgentPairing.own): the page asks, the
// agent answers by id; only with a negotiated hello that lists delegate.1 (the agent's hello over the wire, never set by
// hand), once granted, only tasks.*; at most TASK_REQUESTS.pending; each request, and each answer's raw frame, at most
// TASK_REQUESTS.frameBytes; each within its timeout; all ended with the pairing
{
  const { TASK_REQUESTS, DELEGATE_FEATURE, TaskClient } = await import("./tasks-client.ts");
  // (an agent whose hello offers Delegate, and one whose hello doesn't)
  const pairDelegate = (ws, m) => ws.send(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { protocol: 1, agent: { name: "Claude Code", client: "claude-code", version: "2.0" }, wants: { write: true, run: false }, session: "SECRET", features: [DELEGATE_FEATURE, "chat.resume"] } }));
  const why = async (p) => { try { await p; return "resolved"; } catch (e) { return e?.code ?? String(e); } };
  {
    const S = server(pairOk), W = fakeWs();
    const heard = [];
    S.onTask = (ws, m) => heard.push(m);
    const P = mk(S, W);
    await P.paired();
    await P.allow({ folders: ["/"], write: true, expires: null }, false);
    ok((await why(TaskClient.of(P).request("tasks.list", {}))) === "forbidden" && heard.length === 0 && !(P.hello.features ?? []).includes(DELEGATE_FEATURE), "an agent whose negotiated hello doesn't list delegate.1: refused (forbidden), nothing sent");
    await P.revoke();
    S.srv.stop(true);
  }
  const S = server(pairDelegate), W = fakeWs();
  const heard = [];
  let answer = (ws, m) => ws.send(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { tasks: [], echo: m.method } }));
  S.onTask = (ws, m) => { heard.push(m); answer(ws, m); };
  const P = mk(S, W);
  await P.paired();
  ok(P.hello.features.includes(DELEGATE_FEATURE) && TaskClient.of(P).offered(), "a hello that lists delegate.1 keeps it through the page's negotiation (FEATURES), and the client sees it offered", P.hello.features);
  ok((await why(TaskClient.of(P).request("tasks.list", {}))) === "closed" && heard.length === 0, "before the grant: refused (closed), nothing sent");
  await P.allow({ folders: ["/"], write: true, expires: null }, false);
  const r1 = await TaskClient.of(P).request("tasks.list", {});
  const r2 = await TaskClient.of(P).request("tasks.get", { task: "a".repeat(32), after: 0 });
  ok(r1?.echo === "tasks.list" && r2?.echo === "tasks.get" && heard.map((m) => m.id).join() === "p2,p3", "negotiated delegate.1, granted: answered by id, the page's ids p2, p3, ... (the hello was p1)", heard.map((m) => m.id));
  ok(heard.every((m) => m.jsonrpc === "2.0" && typeof m.params === "object"), "each a JSON-RPC 2.0 request with its params");
  ok((await why(TaskClient.of(P).request("workspace.read", { path: "/A/x.txt" }))) === "bad_request" && heard.length === 2, "a method not in TASK_METHODS: refused (bad_request), nothing sent");
  answer = (ws, m) => ws.send(JSON.stringify({ jsonrpc: "2.0", id: m.id, error: { code: -32000, message: "the task moved on", data: { code: "stale" } } }));
  ok((await why(TaskClient.of(P).request("tasks.close", { task: "a".repeat(32), proposal: null, seq: 1 }))) === "stale", "an error answer: rejected with the agent's code (data.code)");
  // (an outgoing request over TASK_REQUESTS.frameBytes: refused before sending)
  const big = await why(TaskClient.of(P).request("tasks.start", { title: "t", prompt: "x".repeat(TASK_REQUESTS.frameBytes), target: "local", run: false, docs: [] }));
  ok(big === "too_large" && heard.length === 3, "a request over TASK_REQUESTS.frameBytes (4 MiB, under the connection's own 12 MiB): refused (too_large), nothing sent");
  // (an incoming answer: its raw frame, as received, at most TASK_REQUESTS.frameBytes, else refused before its result or
  //  error reaches the caller; the envelope, whitespace and multibyte characters all counted)
  const L = TASK_REQUESTS.frameBytes, enc = new TextEncoder();
  const frameOf = (id, n, { error = false, ch = "x", pad = 0 } = {}) => {
    const shell = (fill) => JSON.stringify(error ? { jsonrpc: "2.0", id, error: { code: -32000, message: fill, data: { code: "stale" } } } : { jsonrpc: "2.0", id, result: { tasks: [], fill } });
    const base = enc.encode(shell("")).length + pad;
    const per = enc.encode(ch).length, k = Math.floor((n - base) / per);
    let t = shell(ch.repeat(k)) + " ".repeat(pad);
    const got = enc.encode(t).length;
    return got < n ? t + " ".repeat(n - got) : t;
  };
  const sizes = [];
  const sendSized = (n, o) => { answer = (ws, m) => { const t = frameOf(m.id, n, o); sizes.push(enc.encode(t).length); ws.send(t); }; };
  sendSized(L);
  ok((await why(TaskClient.of(P).request("tasks.list", {}))) === "resolved" && sizes.at(-1) === L, "an answer of exactly 4 MiB (its raw frame, padded with whitespace): taken", sizes.at(-1));
  sendSized(L + 1);
  ok((await why(TaskClient.of(P).request("tasks.list", {}))) === "too_large" && sizes.at(-1) === L + 1, "an answer one byte over 4 MiB (the extra byte whitespace after the JSON): refused (too_large)", sizes.at(-1));
  sendSized(L + 40, { ch: "漢" });
  ok((await why(TaskClient.of(P).request("tasks.list", {}))) === "too_large", "a result over 4 MiB in UTF-8 but under it in characters (漢): refused (too_large)");
  sendSized(L + 40, { error: true });
  ok((await why(TaskClient.of(P).request("tasks.list", {}))) === "too_large", "an error over 4 MiB (ASCII): refused (too_large), its code not handed on");
  sendSized(L + 40, { error: true, ch: "é" });
  ok((await why(TaskClient.of(P).request("tasks.list", {}))) === "too_large", "an error over 4 MiB in UTF-8 (é): refused (too_large)");
  ok(P.state === "granted", "after the over-limit answers the pairing is still up (its own 12 MiB frames unchanged)");
  // (the limit: at most TASK_REQUESTS.pending at once; unanswered ones end with the pairing)
  answer = () => {};
  const before = heard.length;
  const held = Array.from({ length: TASK_REQUESTS.pending }, () => why(TaskClient.of(P).request("tasks.list", {})));
  await until(() => heard.length === before + TASK_REQUESTS.pending);
  ok((await why(TaskClient.of(P).request("tasks.list", {}))) === "busy" && heard.length === before + TASK_REQUESTS.pending, `at most ${TASK_REQUESTS.pending} pending: the next is refused (busy), not sent`);
  // (an answer to an id the page never used, or no longer waits for: dropped, the connection kept)
  S.sock.send(JSON.stringify({ jsonrpc: "2.0", id: "p999", result: { tasks: [] } }));
  await sleep(100);
  ok(P.state === "granted" && S.closed === null, "an answer to an unknown id: dropped, the connection kept");
  await P.revoke();
  const ended = await Promise.all(held);
  ok(ended.every((c) => c === "closed"), "the pairing ended: every pending request rejected (closed)", ended);
  S.srv.stop(true);
  {
    // (a timeout: rejected; its late answer dropped)
    const S2 = server(pairDelegate), W2 = fakeWs();
    let late = null;
    S2.onTask = (ws, m) => { late = () => ws.send(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { tasks: [] } })); };
    const P2 = mk(S2, W2);
    await P2.paired();
    await P2.allow({ folders: ["/"], write: true, expires: null }, false);
    let code = null;
    try { await TaskClient.of(P2).request("tasks.list", {}, { timeoutMs: 150 }); } catch (e) { code = e.code; }
    late?.();
    await sleep(100);
    ok(code === "timeout" && P2.state === "granted", "no answer in time: rejected (timeout); its late answer is dropped, the connection kept", { code, state: P2.state });
    await P2.revoke();
    S2.srv.stop(true);
  }
}

process.exit(failures ? 1 : 0);
