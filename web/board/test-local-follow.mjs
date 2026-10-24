// web/board/local-follow.ts, the way a board shown by `sagebrush board open` follows its file:
//   bun web/board/test-local-follow.mjs
// A fake server's events and reads, and fake timers: each revision read once and shown, the latest winning; a
// failed read tried again after a delay that doubles up to RETRY_MAX_MS, never at once and never in a loop,
// and recovered without another revision; at once when the events reconnect; nothing after stop (astra's
// CORR-BOARDOPEN-1).
import { localFollow, RETRY_FIRST_MS, RETRY_MAX_MS } from "./local-follow.ts";

let failures = 0;
const ok = (cond, name) => { console.log((cond ? "ok   " : "FAIL ") + name); if (!cond) failures++; };
const tick = () => new Promise((r) => setTimeout(r, 0));
const settle = async () => { for (let i = 0; i < 20; i++) await tick(); };
const rev = (n) => n.toString(16).padStart(64, "0");

function harness({ shown = "" } = {}) {
  const h = { reads: 0, shows: [], troubles: [], timers: [], fail: false, file: { revision: rev(1), doc: { n: 1 } }, es: null, stopped: false };
  h.stop = localFollow({
    events: () => (h.es = { listeners: [], addEventListener(t, f) { this.listeners.push(f); }, onerror: null, onopen: null, closed: false, close() { this.closed = true; } }),
    read: async () => { h.reads++; await tick(); if (h.fail) throw new Error("server busy"); return { revision: h.file.revision, doc: h.file.doc, notice: "", error: h.file.error }; },
    show: (d) => { h.shows.push(d.n); },
    trouble: (t) => h.troubles.push(t),
    shown,
    setTimeout: (f, ms) => { const t = { f, ms, done: false }; h.timers.push(t); return t; },
    clearTimeout: (t) => { t.done = true; },
  });
  h.say = (r) => h.es.listeners.forEach((f) => f({ data: r }));
  h.fire = async () => { const t = h.timers.find((x) => !x.done); if (!t) return null; t.done = true; t.f(); await settle(); return t.ms; };
  h.pending = () => h.timers.filter((x) => !x.done);
  return h;
}

// a revision: read once and shown
{
  const h = harness();
  h.say(rev(1));
  await settle();
  ok(h.reads === 1 && h.shows.join() === "1", "a revision is read once and shown");
  h.say(rev(1));
  await settle();
  ok(h.reads === 1, "...and the same revision said again isn't read again");
  h.stop();
}

// the shown revision first: not read again
{
  const h = harness({ shown: rev(1) });
  h.say(rev(1));
  await settle();
  ok(h.reads === 0, "the revision shown first isn't read again");
  h.stop();
}

// a failed read: tried again later, never at once; delays double to the cap; recovers without a new revision
{
  const h = harness();
  h.fail = true;
  h.say(rev(1));
  await settle();
  ok(h.reads === 1, "a failed read is not tried again at once (no loop): " + h.reads + " reads");
  ok(h.pending().length === 1 && h.pending()[0].ms === RETRY_FIRST_MS, `...a retry is set, after ${RETRY_FIRST_MS} ms`);
  ok(h.troubles.some((t) => t && "failed" in t), "...and the bar says reading failed");
  const delays = [];
  for (let i = 0; i < 8; i++) delays.push(await h.fire());
  ok(h.reads === 9, "each retry reads once: " + h.reads);
  ok(delays.every((d, i) => d === Math.min(RETRY_FIRST_MS * 2 ** i, RETRY_MAX_MS)) && delays.at(-1) === RETRY_MAX_MS, "...the delay doubles, up to " + RETRY_MAX_MS + " ms: " + delays.join(", "));
  ok(h.pending().length === 1, "...one retry waiting at a time");
  // more revisions while failing: no extra reads at once, the retry reads the latest
  h.file = { revision: rev(2), doc: { n: 2 } };
  h.say(rev(2));
  h.say(rev(2));
  await settle();
  ok(h.reads === 9 && h.pending().length === 1, "revisions said while reads fail don't add reads or retries");
  h.fail = false;
  await h.fire();
  ok(h.shows.join() === "2" && h.troubles.at(-1) === null, "the retry recovers, with no newer revision needed, and shows the latest");
  ok(h.pending().length === 0, "...and nothing waits after");
  // a later failure starts from the first delay again
  h.fail = true;
  h.file = { revision: rev(3), doc: { n: 3 } };
  h.say(rev(3));
  await settle();
  ok(h.pending().length === 1 && h.pending()[0].ms === RETRY_FIRST_MS, "after a success, the delay starts again from the first");
  h.stop();
  ok(h.pending().length === 0 && h.es.closed, "stop cancels the waiting retry and closes the events");
  const before = h.reads;
  h.say(rev(4));
  await settle();
  ok(h.reads === before, "...and nothing is read after stop");
}

// the events reconnect: a failed read tried again at once
{
  const h = harness();
  h.fail = true;
  h.say(rev(1));
  await settle();
  h.es.onerror();
  ok(h.troubles.some((t) => t && "stopped" in t), "the events failing: said");
  h.fail = false;
  h.es.onopen();
  await settle();
  ok(h.reads === 2 && h.shows.join() === "1", "the events back: the read tried again at once, and shown");
  ok(h.pending().every((t) => t.done), "...the waiting retry cancelled");
  ok(h.troubles.some((t) => t && "answering" in t), "...and the server's bar taken down");
  h.stop();
}

// a version that isn't a board: said, not retried (it is the file's own state)
{
  const h = harness();
  h.file = { revision: rev(5), error: "Unterminated string in JSON" };
  h.say(rev(5));
  await settle();
  ok(h.reads === 1 && h.shows.length === 0 && h.troubles.some((t) => t && t.error === "Unterminated string in JSON") && h.pending().length === 0, "a version that isn't a board: said, nothing shown, not retried");
  h.stop();
}

// the file changes while it is read: read again, the latest shown
{
  const h = harness();
  h.say(rev(1));
  h.file = { revision: rev(2), doc: { n: 2 } };
  h.say(rev(2));
  await settle();
  ok(h.shows.at(-1) === 2 && h.reads <= 2, "a revision said during a read: read again, the latest shown: " + h.shows.join() + " in " + h.reads + " reads");
  h.stop();
}

console.log(failures ? `${failures} failures` : "all passed");
process.exit(failures ? 1 : 0);
