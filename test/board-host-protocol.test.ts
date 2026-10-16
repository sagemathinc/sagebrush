import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

// The example host in web/board-host-protocol.md, run as written against
// simulated frames: the document a frame was loaded with gets one answer
// channel; a document it is navigated to (the same window: a WindowProxy
// outlives navigation) gets none, with the nonce or without; a second
// load closes the channel; a new board is a new frame (astra's SEC-596-1).
const repo = join(__dirname, "..", "..");
const md = readFileSync(join(repo, "web", "board-host-protocol.md"), "utf8");
const code = /```js\n(const FRAME[\s\S]*?)```/.exec(md)![1];

function host() {
  const frames: any[] = [], admitted: any[] = [];
  let onMessage: ((e: any) => void) | null = null;
  // (an iframe element: its window, what it was sent, its load events)
  const document = {
    createElement() {
      const el: any = { attrs: {}, loads: [] as (() => void)[], removed: false, posts: [] as any[] };
      // (a port given to the frame: when the host closes its end, known from the start, since a
      // "close" listened for only after it has come is never heard)
      el.contentWindow = { postMessage: (data: any, _target: string, transfer: any[] = []) => {
        const port = transfer[0];
        if (port) port.hostClosed = new Promise<void>((r) => port.once("close", () => r()));
        el.posts.push({ data, port });
      } };
      el.setAttribute = (k: string, v: string) => { el.attrs[k] = v; };
      el.addEventListener = (type: string, f: () => void) => { if (type === "load") el.loads.push(f); };
      el.remove = () => { el.removed = true; };
      return el;
    },
  };
  const container = { append: (el: any) => frames.push(el) };
  const api = new Function("document", "container", "addEventListener", "crypto", "MessageChannel", "checkSubmission", "admitDurably", "currentUser", "currentRevision", "shortReason",
    code + "\nreturn { showBoard };")(document, container, (type: string, f: any) => { if (type === "message") onMessage = f; }, { randomUUID }, MessageChannel,
    (posted: any, m: any) => (m?.sagebrush === "answers" && typeof m.id === "string" ? { ok: true, submission: { ...m, board: posted.name } } : { ok: false, id: m?.id, message: "not a submission" }),
    // (admitted after a while, as a durable save is: the reply is awaited, not expected by a tick)
    async (x: any) => { await new Promise((r) => setTimeout(r, 20)); admitted.push(x); }, "user", () => "r1", () => "failed");
  // (a document in a frame: it loads, and says ready from the frame's window)
  const load = (el: any) => { for (const f of el.loads) f(); };
  const ready = (el: any, nonce?: string) => onMessage!({ source: el.contentWindow, data: { sagebrush: "ready", version: 1, ...(nonce !== undefined ? { nonce } : {}) } });
  const nonceOf = (el: any) => /#sb-nonce=(.*)$/.exec(el.src)![1];
  // (answers on a port, and what came back: awaited, never a fixed tick,
  // which a loaded machine outlasts.  Taken: the host's reply.  Not taken:
  // the host's end closed, after which nothing on it can be; it closes when
  // the frame is navigated or replaced, so a port it still holds is a
  // failure, said after 5 s)
  const submit = (port: any, id: string, taken: boolean) => new Promise<any[]>((resolve, reject) => {
    const got: any[] = [];
    const done = () => { clearTimeout(timer); port.close(); resolve(got); };
    const timer = setTimeout(() => { port.close(); reject(new Error(taken ? `no reply to ${id} in 5 s: ${JSON.stringify(got)}` : `the host's end of the channel ${id} was sent on is still open after 5 s`)); }, 5000);
    port.onmessage = (e: any) => { got.push(e.data); if (taken) done(); };
    if (!taken) port.hostClosed.then(done);
    port.postMessage({ sagebrush: "answers", version: 1, id, answers: {} });
  });
  return { api, frames, admitted, load, ready, nonceOf, submit };
}

test("the document the frame was loaded with: one channel, its answers taken; a ready without the nonce, or a second one, gets nothing", async () => {
  const h = host();
  h.api.showBoard("{}", "d.board.json", "r1");
  const el = h.frames[0];
  assert.match(el.src, /^https:\/\/sagebrush\.space\/frame\/board\/#sb-nonce=[0-9a-f-]{36}$/);
  h.ready(el);
  assert.equal(el.posts.length, 0);
  h.ready(el, "not-it");
  assert.equal(el.posts.length, 0);
  h.ready(el, h.nonceOf(el));
  h.load(el);
  assert.equal(el.posts.length, 1);
  assert.deepEqual(el.posts[0].data, { sagebrush: "board", version: 1, text: "{}", name: "d.board.json", revision: "r1" });
  // (the same nonce again: nothing more)
  h.ready(el, h.nonceOf(el));
  assert.equal(el.posts.length, 1);
  const got = await h.submit(el.posts[0].port, "a1", true);
  assert.deepEqual(got, [{ sagebrush: "received", version: 1, id: "a1" }]);
  assert.equal(h.admitted.length, 1);
});

test("a frame navigated to another document (the same window): no channel for it, with the nonce or without, and the first channel closed (SEC-596-1)", async () => {
  const h = host();
  h.api.showBoard("{}", "d.board.json", "r1");
  const el = h.frames[0], nonce = h.nonceOf(el);
  h.ready(el, nonce);
  h.load(el);
  const first = el.posts[0].port;
  // (navigated: a second load of the element; that document says ready, even with the nonce it can't know)
  h.load(el);
  h.ready(el);
  h.ready(el, nonce);
  assert.equal(el.posts.length, 1);
  // (and what comes on the first channel now is not taken)
  const got = await h.submit(first, "a2", false);
  assert.deepEqual(got, []);
  assert.equal(h.admitted.length, 0);
  // (navigated before the document the host loaded said ready: nothing either)
  const g = host();
  g.api.showBoard("{}", "d.board.json", "r1");
  const e2 = g.frames[0];
  g.load(e2);
  g.load(e2);
  g.ready(e2, g.nonceOf(e2));
  assert.equal(e2.posts.length, 0);
});

test("a new board is a new frame with a new nonce; the old frame's window gets nothing", async () => {
  const h = host();
  h.api.showBoard("{}", "a.board.json", "r1");
  const a = h.frames[0];
  h.ready(a, h.nonceOf(a));
  const old = a.posts[0].port;
  h.api.showBoard("{}", "b.board.json", "r2");
  const b = h.frames[1];
  assert.equal(a.removed, true);
  assert.notEqual(h.nonceOf(a), h.nonceOf(b));
  h.ready(a, h.nonceOf(a));
  assert.equal(a.posts.length, 1);
  h.ready(b, h.nonceOf(b));
  assert.equal(b.posts[0].data.name, "b.board.json");
  assert.deepEqual(await h.submit(old, "a3", false), []);
  assert.deepEqual(await h.submit(b.posts[0].port, "b1", true), [{ sagebrush: "received", version: 1, id: "b1" }]);
});
