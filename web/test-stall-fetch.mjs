// ci: web-runner order=590 runner=bun
// fetchMoving (web/stall-fetch.js), the bound on the library chunks' fetches: a response that stops ends within the
// bound, saying so (stalled), whether nothing came at all or the body stopped part way; a slow response that keeps
// moving finishes however long it takes in all; an answer that isn't ok is HTTP <status>; a caller's own abort is
// its own; and no timer is left behind.
// Against a local server, with the bound made short for the test (its third argument).
//   bun web/test-stall-fetch.mjs
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { fetchMoving, stalledError, STALL_LIMIT_MS } from "./stall-fetch.js";

const held = [];
const server = createServer((req, res) => {
  held.push(res);
  if (req.url === "/silent") return; // (never answers)
  if (req.url === "/stops") {
    // (headers and a first piece, then nothing)
    res.writeHead(200, { "content-type": "application/octet-stream" });
    res.write(Buffer.alloc(1000, 1));
    return;
  }
  if (req.url === "/slow") {
    // (12 pieces 150 ms apart: 1.8 s in all, longer than the 600 ms bound, never 600 ms without data)
    res.writeHead(200, { "content-type": "application/octet-stream" });
    let i = 0;
    const t = setInterval(() => {
      res.write(Buffer.alloc(100, i));
      if (++i === 12) {
        clearInterval(t);
        res.end();
      }
    }, 150);
    return;
  }
  if (req.url === "/missing") {
    res.writeHead(404);
    return res.end("no");
  }
  res.writeHead(200);
  res.end("ok");
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
const BOUND = 600;
let checks = 0;
const timed = async (f) => {
  const t = performance.now();
  try {
    return { value: await f(), ms: performance.now() - t };
  } catch (error) {
    return { error, ms: performance.now() - t };
  }
};

try {
  assert.equal(STALL_LIMIT_MS, 20000);
  assert.equal(stalledError(20000).message, "no data for 20 s");
  checks++;

  const silent = await timed(() => fetchMoving(base + "/silent", {}, BOUND));
  assert.equal(silent.error?.stalled, true, "a server that never answers: stalled, " + silent.error);
  assert.equal(silent.error.message, "no data for 0.6 s");
  assert.ok(silent.ms >= BOUND - 50 && silent.ms < BOUND + 1500, `…within the bound: ${silent.ms.toFixed(0)} ms`);
  checks++;

  const stops = await timed(() => fetchMoving(base + "/stops", {}, BOUND));
  assert.equal(stops.error?.stalled, true, "a body that stops part way: stalled, " + stops.error);
  assert.ok(stops.ms >= BOUND - 50 && stops.ms < BOUND + 1500, `…within the bound after its last data: ${stops.ms.toFixed(0)} ms`);
  checks++;

  // (the control: slow but moving, it finishes, in more time than the bound)
  const slow = await timed(() => fetchMoving(base + "/slow", {}, BOUND));
  assert.ok(slow.value instanceof Uint8Array, "a slow body that keeps moving finishes: " + slow.error);
  assert.equal(slow.value.byteLength, 1200);
  assert.equal(slow.value[1199], 11);
  assert.ok(slow.ms > BOUND * 2, `…taking longer in all than the bound: ${slow.ms.toFixed(0)} ms`);
  checks++;

  const missing = await timed(() => fetchMoving(base + "/missing", {}, BOUND));
  assert.equal(missing.error?.message, "HTTP 404");
  assert.equal(missing.error.status, 404);
  assert.notEqual(missing.error.stalled, true);
  checks++;

  // (a caller's own signal: its abort is the caller's error, not a stall, and before the bound)
  const own = new AbortController();
  setTimeout(() => own.abort(new Error("the caller's")), 100);
  const mine = await timed(() => fetchMoving(base + "/silent", { signal: own.signal }, BOUND));
  assert.notEqual(mine.error?.stalled, true, "a caller's abort isn't a stall: " + mine.error);
  assert.equal(mine.error?.message, "the caller's");
  assert.ok(mine.ms < BOUND, `…and ends then: ${mine.ms.toFixed(0)} ms`);
  checks++;

  const ok = await fetchMoving(base + "/ok", {}, BOUND);
  assert.equal(new TextDecoder().decode(ok), "ok");
  checks++;

  // (nothing left pending: the process would otherwise be kept alive by a timer)
  const active = process.getActiveResourcesInfo().filter((r) => r === "Timeout");
  assert.equal(active.length, 0, "no timer left behind: " + active.join(","));
  checks++;
  console.log(`ok: fetchMoving, ${checks} checks`);
} finally {
  for (const r of held) r.destroy();
  server.close();
}
