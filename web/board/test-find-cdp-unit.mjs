// Negative controls for the waits that used to leave test-find silent.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { test } from "node:test";
import { CDPError, connectCDP, discoverPage } from "./find-test-cdp.mjs";

async function server(run, handler) {
  const http = createServer(handler);
  http.listen(0, "127.0.0.1");
  await once(http, "listening");
  try { await run(`http://127.0.0.1:${http.address().port}/json`); }
  finally { http.closeAllConnections(); await new Promise((resolve) => http.close(resolve)); }
}

test("target discovery bounds a silent HTTP server", async () => {
  await server((url) => assert.rejects(discoverPage(url, 100), /browser startup: target discovery.*timed out after 100 ms/), () => {});
});
test("target discovery also bounds a body that never finishes", async () => {
  await server((url) => assert.rejects(discoverPage(url, 100), /target discovery.*timed out after 100 ms/), (_, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.write("[");
  });
});
test("target discovery retries missing page targets and returns its debugger URL", async () => {
  let requests = 0;
  await server(async (url) => assert.equal(await discoverPage(url, 2000), "ws://example/page"), (_, res) => {
    res.end(JSON.stringify(++requests === 1 ? [] : [{ type: "page", webSocketDebuggerUrl: "ws://example/page" }]));
  });
  assert.equal(requests, 2);
});

class Socket extends EventTarget {
  static last;
  constructor() { super(); Socket.last = this; this.sent = []; this.closed = false; }
  emit(type, fields = {}) { this.dispatchEvent(Object.assign(new Event(type), fields)); }
  message(value) { this.emit("message", { data: JSON.stringify(value) }); }
  send(value) { this.sent.push(JSON.parse(value)); }
  close() { this.closed = true; this.emit("close", { code: 1000 }); }
}
async function connected(options = {}) {
  const opening = connectCDP("ws://example", { ms: 100, Socket, ...options });
  const ws = Socket.last;
  ws.emit("open");
  return { cdp: await opening, ws };
}

test("a socket that never opens times out and closes", async () => {
  await assert.rejects(connectCDP("ws://example", { ms: 100, Socket }), /WebSocket open timed out after 100 ms/);
  assert.ok(Socket.last.closed);
});
for (const type of ["error", "close"]) {
  test(`socket ${type} during open rejects immediately`, async () => {
    const opening = connectCDP("ws://example", { ms: 2000, Socket });
    Socket.last.emit(type, { code: 1006 });
    await assert.rejects(opening, /CDP WebSocket/);
    assert.ok(Socket.last.closed);
  });
  test(`socket ${type} rejects all pending calls with their labels`, async () => {
    const { cdp, ws } = await connected({ ms: 2000 });
    const first = cdp.send("Runtime.evaluate", {}, "5,000 notes");
    const second = cdp.send("Page.enable", {}, "board startup");
    const failures = Promise.all([
      assert.rejects(first, /5,000 notes: Runtime.evaluate: CDP WebSocket/),
      assert.rejects(second, /board startup: Page.enable: CDP WebSocket/),
    ]);
    ws.emit(type, { code: 1006 });
    await failures;
    await assert.rejects(cdp.send("Page.navigate"), /CDP WebSocket/);
  });
}
test("an unanswered call fails with its phase and method, even beside a healthy call", async () => {
  const { cdp, ws } = await connected();
  const stalled = cdp.send("Runtime.evaluate", {}, "repeated item IDs");
  const failure = assert.rejects(stalled, /repeated item IDs: Runtime.evaluate.*timed out after 100 ms/);
  const healthy = cdp.send("Page.enable");
  ws.message({ id: ws.sent[1].id, result: {} });
  assert.deepEqual(await healthy, {});
  await failure;
  assert.ok(ws.closed);
});
test("protocol errors reject as CDPError instead of looking like evaluation results", async () => {
  const { cdp, ws } = await connected();
  try {
    const call = cdp.send("Runtime.evaluate", {}, "document replacement");
    ws.message({ id: ws.sent[0].id, error: { code: -32000, message: "Execution context destroyed" } });
    await assert.rejects(call, (error) => error instanceof CDPError && /document replacement: Runtime.evaluate: CDP error.*context destroyed/.test(error.message));
  } finally { cdp.close(); }
});
test("successful replies clear deadlines; runtime events are still delivered", async () => {
  const events = [];
  const { cdp, ws } = await connected({ onEvent: (event) => events.push(event) });
  try {
    const call = cdp.send("Runtime.evaluate", { expression: "1" });
    ws.message({ method: "Runtime.exceptionThrown", params: { exceptionDetails: {} } });
    ws.message({ id: ws.sent[0].id, result: { result: { value: 1 } } });
    assert.equal((await call).result.value, 1);
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(ws.closed, false);
    assert.equal(events[0].method, "Runtime.exceptionThrown");
  } finally { cdp.close(); }
});
test("cleanup rejects pending calls and closes without awaiting a handshake", async () => {
  const { cdp, ws } = await connected();
  const call = cdp.send("Runtime.evaluate", {}, "cleanup control");
  cdp.close();
  await assert.rejects(call, /cleanup control: Runtime.evaluate: test cleanup/);
  assert.ok(ws.closed);
});
test("malformed replies and send errors fail pending calls", async () => {
  for (const kind of ["malformed", "send"]) {
    const { cdp, ws } = await connected();
    if (kind === "send") ws.send = () => { throw new Error("socket unavailable"); };
    const call = cdp.send("Runtime.evaluate", {}, "failure control");
    if (kind === "malformed") ws.emit("message", { data: "{" });
    await assert.rejects(call, /failure control: Runtime.evaluate.*(CDP message|send failed)/);
    assert.ok(ws.closed);
  }
});
