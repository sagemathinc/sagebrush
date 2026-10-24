import test from "node:test";
import assert from "node:assert/strict";
import { Followers, PENDING_MAX, MAX_CLIENTS, framePolicyOf, localPage } from "../src/board-open";

// `sagebrush board open`'s pieces without a browser (src/board-open.ts; the server end to end:
// web/test-board-open.mjs).

// a fake event stream: what it was sent, what waits in it (writableLength), and whether it was closed
function stream(stalled = false) {
  const s = { sent: 0, writableLength: 0, destroyed: false, ended: false,
    write(t: string) { if (stalled) s.writableLength += Buffer.byteLength(t); else s.sent += Buffer.byteLength(t); return !stalled; },
    destroy() { s.destroyed = true; }, end() { s.ended = true; } };
  return s;
}

test("board open: a page that stops reading is closed once what waits for it would pass the bound, which it never does (daybreak2's LIM-BOARDOPEN-2)", () => {
  const f = new Followers();
  const slow = stream(true), fast = stream();
  assert.ok(f.add(slow) && f.add(fast));
  const event = `event: board\ndata: ${"a".repeat(64)}\n\n`;
  let most = 0, n = 0;
  // revisions and heartbeats, on and on
  while (!slow.destroyed && n < 100_000) {
    f.broadcast(n % 10 ? event : ": .\n\n");
    most = Math.max(most, slow.writableLength);
    n++;
  }
  assert.ok(slow.destroyed, "the stalled page is closed");
  assert.ok(most <= PENDING_MAX, `what waited for it stayed within ${PENDING_MAX} bytes: ${most}`);
  assert.equal(f.size, 1, "...and dropped");
  const before = fast.sent;
  f.broadcast(event);
  assert.ok(!fast.destroyed && fast.sent > before, "a page that keeps up goes on getting events");
});

test("board open: at most MAX_CLIENTS pages follow at once", () => {
  const f = new Followers();
  for (let i = 0; i < MAX_CLIENTS; i++) assert.ok(f.add(stream()));
  assert.equal(f.add(stream()), false);
  f.close();
  assert.equal(f.size, 0);
});

test("board open: the frame's policy, read from _headers, with framing refused; none if the frame isn't sandboxed", () => {
  const h = "/board/*\n  Content-Security-Policy: default-src 'self'\n/frame/*\n  Content-Security-Policy: default-src 'self'; sandbox allow-scripts allow-popups; frame-ancestors *\n  Cache-Control: x\n/runner/*\n  Content-Security-Policy: y\n";
  assert.equal(framePolicyOf(h), "default-src 'self'; sandbox allow-scripts allow-popups; frame-ancestors 'none'");
  assert.equal(framePolicyOf(h.replace("sandbox allow-scripts allow-popups; ", "")), null);
  assert.equal(framePolicyOf("/board/*\n  Content-Security-Policy: x\n"), null);
});

test("board open: the page is the frame's, marked as this computer's, with its key, name and engine site; or none", () => {
  const frame = '<html><head><title>t</title></head><body><script type="application/json" id="sb-doc" data-sb-from="parent">null</script></body></html>';
  const p = localPage(frame, { key: "ab".repeat(24), name: "x</script>.board.json", engineSite: "https://sagebrush.space/" })!;
  assert.match(p, /id="sb-doc" data-sb-from="local"/);
  assert.ok(!p.includes('data-sb-from="parent"'));
  assert.ok(p.includes('"engineSite":"https://sagebrush.space/"') && p.includes("x\\u003c/script\\u003e.board.json"), "its data, its < and > escaped");
  const odd = localPage(frame, { key: "k", name: "a<!--b&c\u2028d\u2029e", engineSite: "s" })!;
  const data = /id="sb-local">(.*?)<\/script>/.exec(odd)![1];
  assert.ok(!/[<>&\u2028\u2029]/.test(data), "no <, >, &, U+2028 or U+2029 in the page's data: " + data);
  assert.equal(JSON.parse(data).name, "a<!--b&c\u2028d\u2029e", "...which reads back as the name exactly");
  assert.equal(localPage(frame.replace('data-sb-from="parent"', ""), { key: "k", name: "n", engineSite: "s" }), null);
  assert.equal(localPage(frame + frame, { key: "k", name: "n", engineSite: "s" }), null);
});
