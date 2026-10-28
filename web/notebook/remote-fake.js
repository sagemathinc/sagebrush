// A fake of CoCalc's compute gateway, in memory, for remote-kernel.js's
// tests (test-remote-kernel.mjs): a test double, never part of a page
// (nothing a page loads imports it).  It checks DPoP proofs as the gateway
// does (RFC 9449: signature, htm, htu, iat, nonce, ath, the token's key,
// jti once), keeps bindings with their epoch, incarnation and restart
// version, refuses a run while the kernel is busy, runs the two phases of a
// run (prep, then user) with the restart fence's checks (the pinned restart
// version and incarnation at user allocation, the incarnation again where
// the user phase is delivered), and streams events as text/event-stream.
// Like fetch, it honours the request's AbortSignal at every wait, and it
// refuses to follow a redirect unless asked to.
//
// What its "kernel" does is the test's: fake.kernel = async (code, run) =>
// ({events, outcome}); returning null means the run was killed (run.killed
// resolves on a restart).  Faults, pauses and interceptions: fake.prep,
// fake.faults, fake.pause(point), fake.intercept(method, re, opts),
// fake.raw(method, re, () => Response).

import { b64url, jwkThumbprint } from "./remote-client.js";

const enc = new TextEncoder();
const dec = new TextDecoder();
const fromB64url = (s) => {
  const t = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(t + "===".slice((t.length + 3) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};
const sha256 = async (text) => new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(text)));
const abortError = () => Object.assign(new Error("The operation was aborted."), { name: "AbortError" });
// (a promise that rejects when `signal` aborts, never otherwise)
const aborted = (signal) => new Promise((_, reject) => {
  if (!signal) return;
  if (signal.aborted) return reject(abortError());
  signal.addEventListener("abort", () => reject(abortError()), { once: true });
});

// (a prep result -> the request's terminal, the plan's §2.3 table)
const PREP = {
  "missing-helper": (b) => ({ status: "restarted-before-run", incarnation: b.incarnation }),
  "wrong-incarnation": (b) => ({ status: "restarted-before-run", incarnation: b.incarnation }),
  "wrong-binding": () => ({ status: "setup-failed", detail: "kernel belongs to another binding" }),
  "setup-failed": () => ({ status: "setup-failed", detail: "seed: an error" }),
  interrupted: () => ({ status: "stopped", reason: "interrupted" }),
  "helper-error": () => ({ status: "setup-failed", detail: "helper error: NameError" }),
  malformed: () => ({ status: "setup-failed", detail: "no valid response from the kernel helper" }),
};

export class FakeGateway {
  constructor({ base = "https://cocalc.test/api/compute/v1", requireNonce = true } = {}) {
    this.base = base;
    this.basePath = new URL(base).pathname;
    this.requireNonce = requireNonce;
    this.nonce = "nonce-1";
    this.tokens = new Map(); // token -> jkt
    this.jtis = new Set();
    this.bindings = new Map();
    this.runs = new Map();
    this.nextBinding = 1;
    this.calls = []; // [method, path] of each request whose proof was accepted
    this.fetches = []; // every URL fetch was called with (before any check)
    this.insecure = []; // credential-bearing requests that followed a redirect (must stay empty)
    this.proofs = []; // the decoded {header, claims} of each proof seen
    this.executions = []; // user phases that reached the kernel: {request, incarnation, code}
    this.prep = () => "ok";
    this.kernel = async (code) => ({ events: [{ type: "stream", name: "stdout", text: `ran: ${code}\n` }], outcome: { status: "ok", ms: 1 } });
    this.complete = (code) => ({ matches: [code + "_x"], prefix: code });
    this.faults = { loseReply: 0, oversizeAck: 0, breakStream: 0, bigEvent: false, staleNonceAlways: false, takeover: [], restartRefused: null, silentStream: false, redirectTo: null };
    this.pauses = new Map();
    this.intercepts = [];
    this.raws = [];
    this.applied = null; // (a test's override of a takeover's applied_before_takeover)
    this.inFlight = null;
    this.fetch = (url, init) => this.handle(String(url), init ?? {});
  }

  issueToken(jkt) {
    const t = `tok-${this.tokens.size + 1}-${Math.random().toString(36).slice(2)}`;
    this.tokens.set(t, jkt);
    return t;
  }
  rotateNonce() { this.nonce = `nonce-${Math.random().toString(36).slice(2)}`; }

  /** Pause the next run reaching `point`: {reached (resolves to the run), release()}. */
  pause(point) {
    let release, reached;
    const p = new Promise((r) => (release = r));
    const hit = new Promise((r) => (reached = r));
    this.pauses.set(point, { p, reached });
    return { reached: hit, release: () => release() };
  }
  async gate(point, run) {
    const g = this.pauses.get(point);
    if (!g) return;
    this.pauses.delete(point);
    g.reached(run);
    await g.p;
  }

  /**
   * The next request matching (method, path re), once its proof is accepted:
   *   respond: {status, body}  answer this instead (skip: true, the default, means it isn't processed at all)
   *   skip: false              process it, then answer `respond` instead of the real answer
   *   pause: true              hold the answer (late reply) until release(); an abort rejects it, as fetch does
   *   ignoreAbort: true        (with pause) the held answer is delivered even after an abort: a late answer
   *   lose: true               process it, then fail as if the reply were lost
   *   after: () => {}          called once it is processed (e.g. another tab takes the binding over)
   *   mutate: (data) => data   process it, then answer its real JSON as changed by mutate (in place, or returned)
   * -> {reached, release}
   */
  intercept(method, re, opts = {}) {
    let release, reached;
    const gate = new Promise((r) => (release = r));
    const hit = new Promise((r) => (reached = r));
    this.intercepts.push({ method, re, opts, gate, reached });
    return { reached: hit, release: () => release() };
  }
  /** The next request matching (method, path re) answers `make()`'s Response, unprocessed (proof still checked). */
  raw(method, re, make) { this.raws.push({ method, re, make }); }

  json(status, data, extra = {}) {
    return new Response(data === undefined ? "" : JSON.stringify(data), { status, headers: { "Content-Type": "application/json", "DPoP-Nonce": this.nonce, ...extra } });
  }

  // RFC 9449 §4.3, in the gateway's order; null if the proof is good, else the refusal.
  async verify(method, url, headers) {
    const auth = headers.Authorization ?? "";
    const token = auth.startsWith("DPoP ") ? auth.slice(5) : null;
    const jkt = token && this.tokens.get(token);
    if (!jkt) return this.json(401, { error: "invalid_token" });
    const proof = headers.DPoP;
    if (typeof proof !== "string" || proof.length > 4096) return this.json(401, { error: "invalid_dpop_proof" });
    const parts = proof.split(".");
    if (parts.length !== 3) return this.json(401, { error: "invalid_dpop_proof" });
    let header, claims;
    try {
      header = JSON.parse(dec.decode(fromB64url(parts[0])));
      claims = JSON.parse(dec.decode(fromB64url(parts[1])));
    } catch {
      return this.json(401, { error: "invalid_dpop_proof" });
    }
    this.proofs.push({ header, claims });
    const jwk = header?.jwk;
    if (header?.typ !== "dpop+jwt" || header?.alg !== "ES256" || !jwk || Object.keys(jwk).sort().join() !== "crv,kty,x,y" || jwk.kty !== "EC" || jwk.crv !== "P-256") {
      return this.json(401, { error: "invalid_dpop_proof" });
    }
    const key = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    const ok = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, fromB64url(parts[2]), enc.encode(`${parts[0]}.${parts[1]}`));
    if (!ok) return this.json(401, { error: "invalid_dpop_proof" });
    const u = new URL(url);
    if (claims.htm !== method || claims.htu !== u.origin + u.pathname) return this.json(401, { error: "invalid_dpop_proof" });
    const now = Math.floor(Date.now() / 1000);
    if (!(claims.iat >= now - 60 && claims.iat <= now + 5)) return this.json(401, { error: "invalid_dpop_proof" });
    if (this.requireNonce && (this.faults.staleNonceAlways || claims.nonce !== this.nonce)) {
      if (this.faults.staleNonceAlways) this.rotateNonce();
      return this.json(401, { error: "use_dpop_nonce" }, { "WWW-Authenticate": 'DPoP error="use_dpop_nonce"' });
    }
    if (claims.ath !== b64url(await sha256(token))) return this.json(401, { error: "invalid_dpop_proof" });
    if ((await jwkThumbprint(jwk)) !== jkt) return this.json(401, { error: "invalid_dpop_proof" });
    if (typeof claims.jti !== "string" || claims.jti.length < 22 || this.jtis.has(claims.jti)) return this.json(401, { error: "invalid_dpop_proof" });
    this.jtis.add(claims.jti);
    return null;
  }

  async handle(url, init) {
    this.fetches.push(url);
    const signal = init.signal;
    if (signal?.aborted) throw abortError();
    const method = init.method ?? "GET";
    const headers = init.headers ?? {};
    // (a redirect: followed only if the client allows it; then its credentials would go to the target)
    if (this.faults.redirectTo) {
      const to = this.faults.redirectTo;
      this.faults.redirectTo = null;
      if (init.redirect === "error") throw new TypeError("fetch failed: a redirect was refused");
      this.insecure.push({ url: to, authorization: headers.Authorization, dpop: headers.DPoP });
      return this.json(200, {});
    }
    const refused = await this.verify(method, url, headers);
    if (signal?.aborted) throw abortError();
    if (refused) return refused;
    const u = new URL(url);
    const path = u.pathname.slice(this.basePath.length);
    this.calls.push([method, path]);
    const raw = this.raws.findIndex((x) => x.method === method && x.re.test(path));
    if (raw >= 0) return this.raws.splice(raw, 1)[0].make();
    const i = this.intercepts.findIndex((x) => x.method === method && x.re.test(path));
    const it = i >= 0 ? this.intercepts.splice(i, 1)[0] : null;
    const skip = it?.opts.respond && it.opts.skip !== false;
    const body = init.body ? JSON.parse(init.body) : null;
    let res = skip ? null : await this.route(method, path, u, body, signal);
    it?.opts.after?.();
    if (it?.opts.respond) res = this.json(it.opts.respond.status, it.opts.respond.body);
    else if (it?.opts.mutate && res) {
      const data = await res.json();
      res = this.json(res.status, it.opts.mutate(data) ?? data);
    }
    if (it?.opts.pause) {
      it.reached();
      // (ignoreAbort: the answer arrives anyway, as one already on its way does)
      await (it.opts.ignoreAbort ? it.gate : Promise.race([it.gate, aborted(signal)]));
    }
    if (it?.opts.lose) throw new TypeError("network error (the fake lost this reply)");
    // (a control op whose own answer was delivered is known to its sender: a later
    // takeover lists only those whose answer was lost or replaced)
    if (!it?.opts.respond && body?.op_id) {
      for (const b of this.bindings.values()) b.applied = b.applied.filter((a) => a.op_id !== body.op_id);
    }
    return res;
  }

  async route(method, path, u, body, signal) {
    let m;
    if (method === "POST" && path === "/bindings") return this.bind(body);
    if ((m = path.match(/^\/bindings\/([^/]+)\/(runs|interrupt|restart|complete|takeover)$/)) && method === "POST") {
      const b = this.bindings.get(m[1]);
      if (!b) return this.json(404, { error: "not-found" });
      return this[`post_${m[2]}`](b, body);
    }
    if ((m = path.match(/^\/bindings\/([^/]+)\/runs\/([^/]+)(\/events)?$/)) && method === "GET") {
      const id = decodeURIComponent(m[2]);
      const run = this.runs.get(id);
      if (!run || run.binding !== m[1]) return this.json(404, { error: "not-found" });
      if (m[3]) return this.stream(run, Number(u.searchParams.get("after")) || 0, signal);
      return this.json(200, { request: run.request, state: run.outcome ? "done" : "running", ...(run.outcome ? { outcome: run.outcome } : {}) });
    }
    return this.json(404, { error: "not-found" });
  }

  bind(body) {
    const binding = `b${this.nextBinding++}`;
    this.bindings.set(binding, { binding, epoch: 1, incarnation: 1, restartVersion: 0, state: "ready", busy: null, client: body?.client, applied: [] });
    return this.json(200, { binding, epoch: 1, incarnation: 1, state: "ready" });
  }

  post_runs(b, body) {
    if (b.state === "quarantined") return this.json(410, { error: "quarantined" });
    if (b.state === "fencing") return this.json(409, { error: "fencing" });
    if (body.epoch !== b.epoch) return this.json(409, { error: "epoch" });
    const digest = JSON.stringify(body.payload);
    const had = this.runs.get(body.request);
    if (had) {
      if (had.digest !== digest) return this.json(409, { error: "conflict" });
      return this.ack(had, had.outcome ? "done" : "running");
    }
    if (b.busy) return this.json(409, { error: "busy" });
    let killed;
    const run = {
      request: body.request, binding: b.binding, digest, code: body.payload.code, events: [], outcome: null, listeners: new Set(),
      pinnedRestartVersion: b.restartVersion, pinnedIncarnation: b.incarnation, userSending: false, delivered: false,
      killed: new Promise((r) => (killed = r)),
    };
    run.kill = killed;
    this.runs.set(run.request, run);
    b.busy = run.request;
    this.process(b, run);
    return this.ack(run, "admitted");
  }
  // (a run's acknowledgement, first or resent: lost, or over the client's 1 MiB cap, if asked)
  ack(run, state) {
    if (this.faults.loseReply > 0) {
      this.faults.loseReply--;
      throw new TypeError("network error (the fake lost this reply)");
    }
    if (this.faults.oversizeAck > 0) {
      this.faults.oversizeAck--;
      return this.json(202, { request: run.request, state, pad: "x".repeat(1024 * 1024 + 10) });
    }
    return this.json(202, { request: run.request, state });
  }

  // a run's two phases, with the restart fence's checks ([G] §6.4, §6.2.4)
  async process(b, run) {
    await Promise.resolve();
    await this.gate("before-prep", run);
    if (run.outcome) return;
    const prep = this.prep(run);
    if (prep !== "ok") return this.terminal(b, run, (PREP[prep] ?? PREP.malformed)(b));
    await this.gate("after-prep", run); // (a) prep done(ok), not yet validated
    await this.gate("before-user-alloc", run); // (b) validated, not yet allocated
    if (run.outcome) return; // (fenced when the restart was admitted)
    // the atomic allocation: the pins must still hold
    if (run.pinnedRestartVersion !== b.restartVersion) return this.terminal(b, run, { status: "stopped", reason: "kernel restarted" });
    if (run.pinnedIncarnation !== b.incarnation) return this.terminal(b, run, { status: "setup-failed", detail: "kernel changed" });
    run.userSending = true;
    await this.gate("after-user-alloc", run); // (c) allocated, the RPC not yet delivered
    if (run.outcome) return;
    // the receiver: an op from a retired incarnation is refused before admission
    if (b.incarnation !== run.pinnedIncarnation) return this.terminal(b, run, { status: "refused", reason: "stale-incarnation" });
    run.delivered = true;
    this.executions.push({ request: run.request, incarnation: b.incarnation, code: run.code });
    this.emitEvent(run, { type: "start" });
    const r = await Promise.race([Promise.resolve(this.kernel(run.code, run)), run.killed.then(() => null)]);
    if (!r || run.outcome) return; // (killed: its terminal was settled by the restart)
    for (const ev of r.events ?? []) this.emitEvent(run, ev);
    await this.gate("before-terminal", run);
    if (run.outcome) return;
    this.terminal(b, run, r.outcome ?? { status: "ok", ms: 0 });
  }

  emitEvent(run, ev) {
    const e = { seq: run.events.length + 1, ...ev };
    run.events.push(e);
    for (const f of run.listeners) f(e);
  }
  terminal(b, run, outcome) {
    if (run.outcome) return; // (one terminal: never rewritten)
    run.outcome = outcome;
    this.emitEvent(run, { type: "terminal", outcome });
    if (b.busy === run.request) b.busy = null;
  }

  stream(run, after, signal) {
    const fake = this;
    let listener = null;
    const body = new ReadableStream({
      start(controller) {
        signal?.addEventListener?.("abort", () => { run.listeners.delete(listener); try { controller.error(abortError()); } catch {} }, { once: true });
        // (a body that never produces anything: only an abort or a cancel ends it)
        if (fake.faults.silentStream) { fake.faults.silentStream = false; return; }
        const send = (e) => {
          if (e.seq <= after) return;
          if (fake.faults.bigEvent && e.type !== "terminal") {
            fake.faults.bigEvent = false;
            controller.enqueue(enc.encode(`id: ${e.seq}\ndata: ${JSON.stringify({ seq: e.seq, type: "stream", name: "stdout", text: "x".repeat(897 * 1024 + 10) })}\n\n`));
            return;
          }
          controller.enqueue(enc.encode(`id: ${e.seq}\ndata: ${JSON.stringify(e)}\n\n`));
          if (fake.faults.breakStream > 0 && e.type !== "terminal") {
            fake.faults.breakStream--;
            run.listeners.delete(listener);
            controller.error(new Error("the fake broke this stream"));
            return "broken";
          }
          if (e.type === "terminal") {
            run.listeners.delete(listener);
            controller.close();
            return "closed";
          }
        };
        for (const e of run.events) if (send(e)) return;
        listener = (e) => send(e);
        run.listeners.add(listener);
      },
      cancel() { run.listeners.delete(listener); },
    });
    return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream", "DPoP-Nonce": this.nonce } });
  }

  post_interrupt(b, body) {
    if (body.epoch !== b.epoch) return this.json(409, { error: "epoch" });
    const run = b.busy && this.runs.get(b.busy);
    if (run?.delivered && !run.outcome) this.terminal(b, run, { status: "error", ename: "KeyboardInterrupt", ms: 1 });
    return this.json(200, { ok: true });
  }

  // a restart: admitted (the fence on runs whose user phase isn't sending),
  // then committed at the receiver (a new incarnation; delivered runs killed)
  post_restart(b, body) {
    if (body.epoch !== b.epoch) return this.json(409, { error: "epoch" });
    if (this.faults.restartRefused) return this.json(200, { outcome: { status: "refused", reason: this.faults.restartRefused } });
    b.restartVersion++;
    for (const run of this.runs.values()) {
      if (run.binding === b.binding && !run.outcome && !run.userSending) this.terminal(b, run, { status: "stopped", reason: "kernel restarted" });
    }
    b.incarnation++;
    for (const run of this.runs.values()) {
      if (run.binding === b.binding && !run.outcome && run.delivered) {
        this.terminal(b, run, { status: "stopped", reason: "kernel restarted" });
        run.kill();
      }
    }
    // (an allocated user phase not yet delivered stays: the receiver refuses it when it arrives)
    if (b.busy && this.runs.get(b.busy)?.outcome) b.busy = null;
    b.applied.push({ op_id: body.op_id, kind: "restart" });
    return this.json(200, { outcome: { status: "done", incarnation: b.incarnation } });
  }

  post_complete(b, body) {
    if (body.epoch !== b.epoch) return this.json(409, { error: "epoch" });
    return this.json(200, this.complete(String(body.code)));
  }

  post_takeover(b, body) {
    const state = this.faults.takeover.length ? this.faults.takeover.shift() : "ready";
    if (state === "quarantined") {
      b.state = "quarantined";
      return this.json(200, { state: "quarantined" });
    }
    if (state === "fencing") {
      b.state = "fencing";
      return this.json(200, { epoch: b.epoch, state: "fencing" });
    }
    b.state = "ready";
    b.epoch++;
    b.client = body?.client;
    const applied = this.applied ?? b.applied.splice(0);
    return this.json(200, { epoch: b.epoch, state: "ready", incarnation: b.incarnation, applied_before_takeover: applied, in_flight: this.inFlight ?? [] });
  }
}
