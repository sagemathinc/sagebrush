// The GPU kernel's preview (remote-ui.js): its simulated gateway, whose runs
// execute on a local interpreter (here a stub Kernel that records what it is
// asked), and startPreview's kernel.  Run by test-remote-kernel.mjs (CI's
// board-unit job): runUiTests(check) -> the number of controls run.  The
// Connect sheet and the page's wiring are checked in a browser
// (web/test-remote-preview.mjs).
import { RemoteClient } from "./remote-client.js";
import { RemoteKernel, NOTES } from "./remote-kernel.js";
import { PreviewGateway, startPreview, statusText, gateFor, sha256Hex, SHEET, remoteSwitch, parseNetwork, networkText } from "./remote-ui.js";
import { RemoteGate } from "./remote-gate.js";

const fast = (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5)));
const within = (p, ms = 3000) => Promise.race([p.then((v) => ({ v }), (e) => ({ e })), new Promise((r) => setTimeout(() => r({ timeout: true }), ms))]);
async function until(cond, ms = 3000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) return false;
    await new Promise((r) => setTimeout(r, 5));
  }
  return true;
}

// A local interpreter, as the preview uses one: it records each execute, and
// answers with the script the test gives it (null: never answers until
// interrupted or restarted).
function stubLocal() {
  const k = {
    executed: [], interrupts: 0, restarts: 0, starts: 0, closed: 0, script: null, pending: null,
    start() { k.starts++; },
    close() { k.closed++; },
    execute(code, opts, sink) {
      k.executed.push({ code, opts });
      const s = k.script?.(code, opts) ?? { out: [[`ran ${code}\n`, false]], done: [3, { error: false }] };
      sink.start?.();
      for (const [t, e] of s.out ?? []) sink.out(t, e);
      for (const d of s.displays ?? []) sink.display(d);
      if (s.clear) sink.clear();
      if (s.interact) sink.interact({});
      if (s.hang) { k.pending = sink; return; }
      if (s.stopped) return sink.stopped("stopped");
      if (s.skipped) return sink.skipped();
      sink.done(...s.done);
    },
    interrupt() { k.interrupts++; k.pending?.done(1, { error: true, interrupted: true }); k.pending = null; },
    restart() { k.restarts++; k.pending?.stopped("restarted"); k.pending = null; },
  };
  return k;
}

function sink() {
  let end;
  const s = {
    outs: [], displays: [], clears: 0, terminal: null,
    ended: new Promise((r) => (end = r)),
    start() {}, interact() {},
    out(t, e) { s.outs.push([t, !!e]); },
    display(b) { s.displays.push(b); },
    clear() { s.clears++; },
    done(ms, x) { s.terminal ??= ["done", x ?? {}]; end(); },
    stopped(m) { s.terminal ??= ["stopped", m]; end(); },
    skipped(x) { s.terminal ??= ["skipped", x ?? {}]; end(); },
  };
  return s;
}

async function ungated(local, gwOpts = {}) {
  const gw = new PreviewGateway(local, gwOpts);
  let token = null;
  const client = await RemoteClient.create({ base: gw.base, token: () => token, fetch: gw.fetch });
  token = gw.issueToken(client.jkt);
  const kernel = new RemoteKernel({ client, notebook: "nb-ui", clientId: "u1", sleep: fast });
  await kernel.start();
  return { gw, kernel };
}
async function runOn(kernel, code, opts = {}) {
  const s = sink();
  kernel.execute(code, { mode: "python", ...opts }, s);
  const t = await within(s.ended, 5000);
  return t.timeout ? null : s;
}

export async function runUiTests(check) {
  let n = 0;
  const c = (ok, what) => { n++; check(ok, `remote-ui: ${what}`); };

  // 1. a run executes on the local interpreter, with exactly its payload's options
  {
    const local = stubLocal();
    const { gw, kernel } = await ungated(local);
    c(kernel.ready && local.starts === 0, "the simulated gateway binds (startPreview, not the gateway, starts the interpreter)");
    const seed = "a".repeat(64);
    const s = await runOn(kernel, "x = 1", { mode: "sage", cell: "c-1", forget: ["y"], mangle: true, seed, scoped: { z: "c-0" } });
    const ex = local.executed[0];
    c(s?.terminal?.[0] === "done" && s.terminal[1].error === false, "it ends done(ok)");
    c(ex?.code === "x = 1" && ex.opts.mode === "sage" && ex.opts.cell === "c-1" && JSON.stringify(ex.opts.forget) === '["y"]' && ex.opts.mangle === true && ex.opts.seed === seed && ex.opts.scoped?.z === "c-0",
      "the local interpreter got the payload's code, mode, cell, forget, mangle, seed and scoped");
    c(s.outs.length === 1 && s.outs[0][0] === "ran x = 1\n" && s.outs[0][1] === false, "its stdout comes back as the gateway's stream event");
    c(gw.payloads.size === 0, "the payload is dropped once its run starts");
    const s2 = await runOn(kernel, "y");
    c(local.executed[1]?.opts.mode === "python" && !("cell" in local.executed[1].opts) && !("mangle" in local.executed[1].opts) && !("seed" in local.executed[1].opts), "a plain run carries no options it wasn't given");
    c(s2?.terminal?.[0] === "done", "and it runs");
  }

  // 2. output kinds and terminals
  {
    const local = stubLocal();
    const { kernel } = await ungated(local);
    local.script = () => ({ out: [["warn\n", true]], displays: [{ "text/plain": "42" }], clear: true, interact: true, done: [5, { error: true }] });
    const s = await runOn(kernel, "boom");
    c(s?.outs.some(([t, e]) => t === "warn\n" && e) && s.displays.some((d) => d["text/plain"] === "42") && s.clears === 1, "stderr, a display and a clear come back");
    c(s.outs.some(([t]) => /interactive controls/.test(t)), "an @interact says it isn't shown, rather than vanishing");
    c(s.terminal?.[0] === "done" && s.terminal[1].error === true, "an error ends done(error)");
    local.script = () => ({ stopped: true });
    const s2 = await runOn(kernel, "stop me");
    c(s2?.terminal?.[0] === "done" && s2.terminal[1].error === true && s2.terminal[1].interrupted === true, "a locally stopped run ends as an interrupted error");
    local.script = () => ({ skipped: true });
    const s3 = await runOn(kernel, "skip me");
    c(s3?.terminal?.[0] === "skipped" || (s3?.terminal?.[0] === "stopped" && typeof s3.terminal[1] === "string"), "a locally skipped run is not run (no success)");
  }

  // 3. Stop and Restart reach the local interpreter
  {
    const local = stubLocal();
    const { gw, kernel } = await ungated(local);
    local.script = () => ({ hang: true });
    const s = sink();
    kernel.execute("long", { mode: "python" }, s);
    c(await until(() => local.pending), "a long run is executing locally");
    kernel.interrupt();
    const t = await within(s.ended, 3000);
    c(!t.timeout && s.terminal?.[1]?.interrupted === true && local.interrupts === 1, "Stop: the gateway ends it as interrupted, and the local interpreter is interrupted");
    local.script = () => ({ hang: true });
    const s2 = sink();
    kernel.execute("long2", { mode: "python" }, s2);
    await until(() => local.pending);
    const inc = gw.bindings.get(kernel.binding).incarnation;
    kernel.restart();
    const t2 = await within(s2.ended, 3000);
    c(!t2.timeout && s2.terminal?.[0] === "stopped" && s2.terminal[1] === NOTES.stoppedRestart, "Restart: the run is stopped by the restart");
    c(await until(() => local.restarts === 1) && gw.bindings.get(kernel.binding).incarnation === inc + 1, "and the local interpreter restarts with the gateway's new incarnation");
    local.script = null;
    // (once the restart's answer is in: a run asked before that belongs to the old generation, and is stopped)
    await until(() => kernel.ready && !kernel.lifeOps);
    const s3 = await runOn(kernel, "after");
    c(s3?.terminal?.[0] === "done", `the kernel runs again after the restart (${JSON.stringify(s3?.terminal)})`);
  }

  // 4. a refused run keeps no payload
  {
    const local = stubLocal();
    const { gw, kernel } = await ungated(local);
    const b = gw.bindings.get(kernel.binding);
    b.busy = "someone-else"; // (another tab's run holds the kernel)
    const s = await runOn(kernel, "while busy");
    c(s?.terminal?.[0] === "stopped" || s?.terminal?.[0] === "skipped", "a run refused as busy doesn't run");
    c(gw.payloads.size === 0 && local.executed.length === 0, "and no payload is kept for it, nothing ran locally");
  }

  // 5. startPreview: a gated kernel, its status, and close()
  {
    const local = stubLocal();
    const statuses = [];
    const r = await startPreview({ notebook: "nb-5", local, onStatus: (t) => statuses.push(t) });
    c(r.kernel.ready && r.kernel.remote && r.kernel.requireGate && r.kernel.preview === true && local.starts === 1, "startPreview: a ready remote kernel that requires a gate; the interpreter started");
    c(statuses.includes("Remote compute (preview, simulated) · ready"), `its status says it's the simulated preview (${JSON.stringify(statuses)})`);
    const s = await runOn(r.kernel, "unapproved");
    c(s?.terminal?.[0] === "stopped" && s.terminal[1] === NOTES.noGate && local.executed.length === 0, "a run without the page's gate is never sent");
    const gate = gateFor(r.kernel, { reactive: () => null, config: () => Object.freeze({ mode: "python", seedNamespace: "", reactive: true }) });
    c(gate instanceof RemoteGate && gate.kernel === r.kernel, "gateFor makes the page's RemoteGate for the kernel");
    r.close();
    c(r.kernel.closed && local.closed === 1, "close(): the kernel and the local interpreter are closed");
  }

  // 6. text
  {
    c(statusText("connecting…") === "Remote compute (preview): connecting…" && statusText("ready (remote)") === "Remote compute (preview, simulated) · ready", "status text");
    c((await sha256Hex("abc")) === "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", "the approvals' hash is SHA-256, hex");
    c(/simulated/.test(SHEET.preview) && /nothing is billed/i.test(SHEET.preview) && SHEET.capNote === "You'll confirm the cap on CoCalc's page; that's the one that counts.", "the Connect sheet says it's simulated, unbilled, and carries the plan's cap note");
  }
  // 7. the switch: one current attempt; held sheets and binds across switches and newer attempts (astra P1D-A1)
  {
    const deferred = () => { let resolve, reject; const p = new Promise((a, b) => { resolve = a; reject = b; }); return { p, resolve, reject }; };
    // A page as index.html's: the notebook shown, the picker, the status line and the kernel installed.
    const world = () => {
      const w = { id: "A", pick: "gpu", statuses: [], installs: [], sheets: [], starts: [], closed: [] };
      w.page = {
        currentId: () => w.id,
        picked: () => w.pick,
        pickLocal: () => { w.pick = "local"; },
        status: (t) => w.statuses.push(t),
        reactive: () => true,
        makeLocal: () => ({}),
        setKernel: (k) => w.installs.push(k),
      };
      // (each sheet and each bind is held until the test settles it; cancelSheet settles the open sheet with null, as closeSheet does)
      w.deps = {
        sheet: () => { const d = deferred(); w.sheets.push(d); return d.p; },
        cancelSheet: () => { for (const d of w.sheets) d.resolve(null); },
        start: (o) => {
          const d = deferred();
          const r = { kernel: { tag: `k${w.starts.length + 1}`, notebook: o.notebook }, onStatus: o.onStatus, close() { w.closed.push(r.kernel.tag); } };
          w.starts.push({ d, r, o });
          return d.p.then(() => r);
        },
      };
      w.sw = remoteSwitch(w.page, w.deps);
      // (index.html's leave: the switch's, and the picker back to This browser)
      w.leave = () => { w.sw.leave(); w.pick = "local"; };
      return w;
    };
    const flush = () => new Promise((r) => setTimeout(r, 5));

    // 7a. the plain flow: sheet, bind, installed on the notebook it began on
    {
      const w = world();
      const done = w.sw.connect("A");
      await flush();
      w.sheets[0].resolve({ cap: 10 });
      await flush();
      w.starts[0].d.resolve();
      const r = await done;
      c(r === w.starts[0].r && w.installs.length === 1 && w.installs[0] === r.kernel && w.sw.active() && w.pick === "gpu", "switch: sheet, bind, installed (once), picker on GPU");
      w.leave();
      c(!w.sw.active() && w.closed.includes(r.kernel.tag), "switch: leave() closes the installed kernel");
    }
    // 7b. another notebook opened while the sheet is up: the sheet is settled, nothing binds, the picker is local
    {
      const w = world();
      const done = w.sw.connect("A");
      await flush();
      w.id = "B";
      w.leave();
      const r = await done;
      c(r === null && w.starts.length === 0 && w.installs.length === 0 && w.pick === "local", "switch: a notebook switch during the sheet settles it; nothing binds or installs");
    }
    // 7c. a switch while the bind is held: the stale bind is closed, never installed; its late status and error go nowhere
    {
      const w = world();
      const done = w.sw.connect("A");
      await flush();
      w.sheets[0].resolve({ cap: 10 });
      await flush();
      w.id = "B";
      w.leave();
      const before = w.statuses.length;
      w.starts[0].o.onStatus("GPU kernel (preview): connecting…");
      w.starts[0].d.resolve();
      const r = await done;
      c(r === null && w.installs.length === 0 && w.closed.includes("k1") && w.pick === "local", "switch: a bind finishing after a switch is closed, not installed");
      c(w.statuses.length === before, "switch: a superseded attempt's status callback writes nothing");
    }
    // 7d. A-B-A: away and back before the old bind finishes: the old one never installs; the new attempt does
    {
      const w = world();
      const old = w.sw.connect("A");
      await flush();
      w.sheets[0].resolve({ cap: 10 });
      await flush();
      w.id = "B"; w.leave(); // (to B)
      w.id = "A"; w.pick = "gpu"; // (back to A, GPU chosen again)
      const fresh = w.sw.connect("A");
      await flush();
      w.starts[0].d.resolve(); // (the OLD bind finishes now, while the new sheet is up)
      c((await old) === null && w.installs.length === 0 && w.closed.includes("k1"), "switch: A-B-A: the superseded bind closes, even though the notebook and the picker match again");
      w.sheets[1].resolve({ cap: 10 });
      await flush();
      w.starts[1].d.resolve();
      const r = await fresh;
      c(r?.kernel.tag === "k2" && w.installs.length === 1 && w.installs[0].tag === "k2" && w.pick === "gpu", "switch: A-B-A: only the newest attempt installs");
    }
    // 7e. GPU, local, GPU, with the first bind held; then the NEWER sheet is cancelled after the older bind resolves
    {
      const w = world();
      const old = w.sw.connect("A");
      await flush();
      w.sheets[0].resolve({ cap: 10 });
      await flush();
      w.leave(); // (This browser)
      w.pick = "gpu";
      const fresh = w.sw.connect("A");
      await flush();
      w.starts[0].d.resolve(); // (the older bind resolves)
      await old;
      w.sheets[1].resolve(null); // (the newer sheet: Cancel)
      const r = await fresh;
      c(r === null && w.installs.length === 0 && w.closed.includes("k1") && !w.sw.active() && w.pick === "local", "switch: a newer Cancel after an older bind resolved: nothing installed, the old kernel closed, picker local");
    }
    // 7f. two GPU choices in a row: the first sheet is settled by the second; only the second can install
    {
      const w = world();
      const first = w.sw.connect("A");
      await flush();
      const second = w.sw.connect("A");
      c((await first) === null && w.pick === "gpu", "switch: a newer attempt settles the older sheet without touching the picker");
      await flush();
      w.sheets[1].resolve({ cap: 10 });
      await flush();
      w.starts[0].d.resolve();
      c((await second)?.kernel.tag === "k1" && w.installs.length === 1 && w.starts.length === 1, "switch: and only the newer one binds and installs");
    }
    // 7g. a stale failure: the older bind rejects after a newer attempt began: its error neither resets the picker nor writes the status
    {
      const w = world();
      const old = w.sw.connect("A");
      await flush();
      w.sheets[0].resolve({ cap: 10 });
      await flush();
      const fresh = w.sw.connect("A");
      await flush();
      const before = w.statuses.length;
      w.starts[0].d.reject(new Error("bind failed"));
      c((await old) === null && w.pick === "gpu" && w.statuses.length === before, "switch: a superseded attempt's failure changes neither the picker nor the status");
      w.sheets[1].resolve({ cap: 10 });
      await flush();
      w.starts[1].d.reject(new Error("the gateway said no"));
      c((await fresh) === null && w.pick === "local" && /the gateway said no/.test(w.statuses.at(-1) ?? ""), "switch: the current attempt's failure puts the picker back and says why");
    }
    // 7h. the real sheet: a newer sheet or closeSheet settles the older one as cancelled (no DOM needed beyond a stub)
    {
      const { connectSheet, closeSheet } = await import("./remote-ui.js");
      const stubDoc = () => {
        const mk = (tag) => {
          const el = { tag, children: [], listeners: {}, open: false, style: {}, attrs: {}, id: "",
            append(...a) { el.children.push(...a); }, remove() { el.removed = true; },
            setAttribute(k, v) { el.attrs[k] = v; }, addEventListener(t, f) { (el.listeners[t] ??= []).push(f); },
            showModal() { el.open = true; }, close() { if (!el.open) return; el.open = false; for (const f of el.listeners.close ?? []) f(); }, focus() {} };
          return el;
        };
        const byId = new Map();
        return { head: mk("head"), body: mk("body"), createElement: mk, getElementById: (id) => byId.get(id) ?? null, _byId: byId };
      };
      const d = stubDoc();
      const p1 = connectSheet(d);
      const p2 = connectSheet(d);
      c((await p1) === null, "sheet: a newer sheet settles the older one as cancelled");
      closeSheet();
      c((await p2) === null, "sheet: closeSheet settles the open one as cancelled");
    }
  }
  // 8. the simulated network (&latency, &jitter, &loss)
  {
    const net = parseNetwork("?remote=1&latency=200&jitter=50&loss=10");
    c(net.latency === 200 && net.jitter === 50 && net.loss === 0.1 && Object.isFrozen(net), "network: the address's latency, jitter and loss");
    const bad = parseNetwork("?latency=-5&jitter=abc&loss=90");
    const none = parseNetwork("?remote=1&latency=");
    c(parseNetwork("?loss=0.5").loss === 0.005 && networkText(parseNetwork("?latency=400&loss=0.5")) === " · 400 ms · 0.5% loss" && parseNetwork("?loss=50").loss === 0.5, "network: loss is in percent (&loss=10 is 10%; &loss=0.5 is 0.5%), and the status line shows the rate used");
    c(bad.latency === 0 && bad.jitter === 0 && bad.loss === 0.5 && none.latency === 0 && parseNetwork("?latency=1e9").latency === 10000, "network: negative or malformed values are 0, the rest clamped (loss <= 0.5, latency <= 10 s)");
    c(networkText(none) === "" && networkText(net) === " · 200 ms ±25 · 10% loss" && statusText("ready (remote)", net) === "Remote compute (preview, simulated · 200 ms ±25 · 10% loss) · ready", "network: the status line says which network it simulates");

    // every request and answer is delayed: a run's round trips take at least the latency each
    const local = stubLocal();
    const { kernel } = await ungated(local, { network: parseNetwork("?latency=80") });
    const t0 = performance.now();
    const s = await runOn(kernel, "slow net");
    const took = performance.now() - t0;
    c(s?.terminal?.[0] === "done" && took >= 160, `network: a run (POST, then its event stream) takes >= two round trips (${Math.round(took)} ms)`);

    // a stream's events stay in order under jitter, as on one connection
    const local2 = stubLocal();
    const { kernel: k2 } = await ungated(local2, { network: parseNetwork("?latency=20&jitter=40") });
    local2.script = () => ({ out: Array.from({ length: 40 }, (_, i) => [`line ${i}\n`, false]), done: [1, { error: false }] });
    const s2 = await runOn(k2, "many lines");
    c(s2?.terminal?.[0] === "done" && s2.outs.map(([t]) => t).join("") === Array.from({ length: 40 }, (_, i) => `line ${i}\n`).join(""), "network: 40 events under jitter arrive in order, each once");

    // loss: a lost reply (the run's POST answer) is resent once, identically; the gateway admits the run once
    const seq = (xs) => { let i = 0; return () => (i < xs.length ? xs[i++] : 0.99); };
    const local3 = stubLocal();
    // (random draws in order: the bind's delays and loss draw, then the run POST's: lose its reply)
    const { gw: gw3, kernel: k3 } = await ungated(local3, { network: { latency: 0, jitter: 0, loss: 0.5 }, random: seq([0.99]) });
    gw3.random = seq([0.1]); // (with no jitter only loss draws: the run's POST reply is the first, lost)
    const lost0 = gw3.lost;
    const s3 = await runOn(k3, "lose my reply");
    c(gw3.lost > lost0, `network: a reply was lost (${gw3.lost - lost0})`);
    c(s3?.terminal?.[0] === "done" && local3.executed.filter((x) => x.code === "lose my reply").length === 1, `network: the run still completes, executed exactly once (${JSON.stringify(s3?.terminal)})`);

    // loss in a stream: it breaks; the page reconnects after its last event and gets the rest, nothing twice
    const local4 = stubLocal();
    const { gw: gw4, kernel: k4 } = await ungated(local4, { network: { latency: 0, jitter: 0, loss: 0.5 }, random: () => 0.99 });
    local4.script = () => ({ out: Array.from({ length: 10 }, (_, i) => [`e${i}\n`, false]), done: [1, { error: false }] });
    let draws = 0;
    gw4.random = () => (++draws === 6 ? 0.1 : 0.99); // (draws: the POST reply, then each stream event; the 5th event is lost)
    const s4 = await runOn(k4, "break my stream");
    c(gw4.lost >= 1 && s4?.terminal?.[0] === "done" && s4.outs.map(([t]) => t).join("") === Array.from({ length: 10 }, (_, i) => `e${i}\n`).join(""), `network: a broken stream resumes; every event once, in order (lost ${gw4.lost})`);
  }
  return n;
}
