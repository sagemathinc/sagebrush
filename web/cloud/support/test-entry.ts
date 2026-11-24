// The Worker that web/cloud/support/test-support.mjs runs in Miniflare: the shared entry, as src/prod.ts has it when
// TEST_PROD is "1" and as src/dev.ts has it otherwise.  Tests only:
// - /__test/read reads its own body with the length given in X-Declared (and the deadline in X-Deadline), as the API does with Content-Length (a
//   client's HTTP stack won't send a body whose length differs from its Content-Length, and Cloudflare's edge
//   refuses one, so the reader is tested here);
// - /__test/logs: this isolate's log lines since the last call (Miniflare doesn't hand console output over);
// - /__test/clock?at=<ms>: the backstop's clock, fixed at that instant (at=real restores the real one);
// - X-Witness: 1, /__test/cancels-reset: the body's cancellations counted (state's cancels);
// - /__test/hold?on=1|0 and /__test/state: while on, an admitted request waits right after its bounded read,
//   holding its slot and its bytes; state reports the admission count and the bytes held.
import { supportWorker } from "./src/index.ts";
import { _inFlight, readRequestBody, type SupportEnv } from "./support.ts";

const lines: string[] = [];
const original = console.log.bind(console);
console.log = (...args: unknown[]) => {
  lines.push(args.map(String).join(" "));
  original(...args);
};

// (each held request polls the flag with timers of its own: workerd won't resume a request on a promise that
// another request resolves)
let holding = false;
let held = 0;
let heldBytes = 0;
let maxHeldBytes = 0;
async function onBodyRead(bytes: number): Promise<void> {
  if (!holding) return;
  held++;
  heldBytes += bytes;
  maxHeldBytes = Math.max(maxHeldBytes, heldBytes);
  try {
    while (holding) await new Promise((r) => setTimeout(r, 10));
  } finally {
    held--;
    heldBytes -= bytes;
  }
}

// (X-Witness: the body reaches the Worker through a stream of this entry's own whose cancel(reason) hook is
// counted, so a test can see that the reader really cancelled the body it gave up on)
let cancels = 0;
function witnessed(request: Request): Request {
  if (request.body === null) return request;
  const inner = request.body.getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(c) {
      const { done, value } = await inner.read();
      if (done) c.close();
      else c.enqueue(value);
    },
    cancel(reason) {
      cancels++;
      return inner.cancel(reason);
    },
  });
  return new Request(request.url, { method: request.method, headers: request.headers, body, duplex: "half" } as RequestInit);
}

// (/__test/clock?at=<ms>: the backstop's clock, fixed at that instant until set again; at=real restores the real one)
let clockAt: number | null = null;
const backstopNow = () => clockAt ?? Date.now();
const dev = supportWorker({ prod: false, onBodyRead, backstopNow });
const prod = supportWorker({ prod: true, onBodyRead, backstopNow });

export default {
  async fetch(request: Request, env: SupportEnv & { TEST_PROD?: string }) {
    const url = new URL(request.url);
    if (url.pathname === "/__test/logs") return Response.json(lines.splice(0));
    if (url.pathname === "/__test/clock") {
      const at = url.searchParams.get("at");
      clockAt = at === "real" ? null : Number(at);
      return Response.json({ ok: clockAt === null || Number.isSafeInteger(clockAt) });
    }
    if (url.pathname === "/__test/hold") {
      holding = url.searchParams.get("on") === "1";
      if (holding) maxHeldBytes = 0;
      return Response.json({ ok: true });
    }
    if (url.pathname === "/__test/state") return Response.json({ inFlight: _inFlight(), held, heldBytes, maxHeldBytes, cancels });
    if (url.pathname === "/__test/cancels-reset") {
      cancels = 0;
      return Response.json({ ok: true });
    }
    if (request.headers.get("x-witness") === "1") request = witnessed(request);
    if (url.pathname === "/__test/read") {
      // (X-Deadline, when given, replaces BODY_DEADLINE_MS, so a stalled stream's cancellation is tested quickly)
      const deadline = request.headers.get("x-deadline");
      const declared = Number(request.headers.get("x-declared"));
      const r = deadline ? await readRequestBody(request, declared, Number(deadline)) : await readRequestBody(request, declared);
      return Response.json(typeof r === "string" ? { result: r } : { result: "ok", bytes: r.length });
    }
    return (env.TEST_PROD === "1" ? prod : dev).fetch(request, env);
  },
  scheduled(controller: unknown, env: SupportEnv & { TEST_PROD?: string }) {
    return (env.TEST_PROD === "1" ? prod : dev).scheduled(controller, env);
  },
};
