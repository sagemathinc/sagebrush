// The remote kernel's UI, as a preview (sagebrush-remote.js, loaded only by
// a page opened with ?remote=1; web/build.ts builds it, and it is served
// wherever the page is: the site, `sagebrush notebook`, the app).  It joins what P1a and P1b built: a RemoteKernel
// (remote-kernel.js) on a RemoteClient (remote-client.js, DPoP), with every
// run approved by a RemoteGate (remote-gate.js), to a gateway.
//
// There is no gateway yet, so the preview's is simulated, in this page: the
// in-memory gateway of the tests (remote-fake.js), whose runs execute on a
// second interpreter in this browser, apart from the notebook's own (as a
// remote kernel's variables are apart).  Everything up to the gateway is the
// real path: the Connect sheet, the person's consent at each Run, each run
// checked and admitted right before it is sent, DPoP-signed requests, the
// event stream and the notes.  Nothing leaves the page, and nothing is billed.
//
// The network between the page and the gateway is simulated too, from the
// address (parseNetwork): &latency=MS (the round trip; each way gets half),
// &jitter=MS (each one-way delay varies by up to +-half of it) and
// &loss=P (0..0.5: each reply, and each streamed event, is lost with that
// chance; a lost reply was processed, a lost event breaks its stream).
// Every request and every answer is delayed, interrupts and restarts too,
// and a stream's events stay in order, as on one connection.
//
//   const remote = await import("sagebrush-remote.js");
//   const sw = remote.remoteSwitch(page);    // the page: see remoteSwitch
//   await sw.connect(notebookId);            // the Connect sheet, then the kernel, installed on that notebook
//   sw.leave();                              // on any switch: whatever is pending or installed ends
//   (createNotebook({remoteGate: remote.gateFor}) gives each remote kernel the page's gate)

import { RemoteClient } from "./remote-client.js";
import { RemoteKernel } from "./remote-kernel.js";
import { RemoteGate } from "./remote-gate.js";
import { FakeGateway } from "./remote-fake.js";

// (the simulated gateway's address: https, as the client requires; never fetched, its fetch is the fake's)
const PREVIEW_BASE = "https://compute.preview.invalid/api/compute/v1";
const NO_NETWORK = Object.freeze({ latency: 0, jitter: 0, loss: 0 });
const abortError = () => Object.assign(new Error("The operation was aborted."), { name: "AbortError" });

/**
 * The simulated network, from the page's address: {latency, jitter} in ms (latency is the round trip) and
 * loss, a probability.  Missing, empty or malformed values are 0; each is clamped to its range.
 */
export function parseNetwork(search) {
  const q = new URLSearchParams(search ?? "");
  const num = (k, hi) => {
    const v = q.get(k);
    if (v === null || v.trim() === "") return 0;
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(hi, Math.max(0, n)) : 0;
  };
  return Object.freeze({ latency: num("latency", 10000), jitter: num("jitter", 5000), loss: num("loss", 0.5) });
}

/** The network's description for the status line: "", or " · 200 ms" (+ jitter, loss). */
export function networkText(net) {
  if (!net || !(net.latency || net.jitter || net.loss)) return "";
  return ` · ${net.latency} ms` + (net.jitter ? ` ±${net.jitter / 2}` : "") + (net.loss ? ` · ${Math.round(net.loss * 100)}% loss` : "");
}
const INTERACT_NOTE = "(interactive controls aren't shown from a remote kernel yet)\n";

/** SHA-256, hex: the approvals' hash (remote-approval.ts). */
export async function sha256Hex(text) {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  let s = "";
  for (const b of d) s += b.toString(16).padStart(2, "0");
  return s;
}

/** The page's remote gate for a remote kernel: createNotebook's opts.remoteGate. */
export function gateFor(kernel, page) {
  return new RemoteGate({ kernel, hash: sha256Hex, page });
}

/**
 * The simulated gateway: the tests' fake, whose kernel is `local` (a
 * Kernel, web/notebook/types.ts), each run executed there with exactly the
 * options the run's payload carries, its output streamed as the gateway's
 * events while it runs.  Stop and Restart reach the local interpreter too.
 */
export class PreviewGateway extends FakeGateway {
  constructor(local, { network = NO_NETWORK, random = Math.random, ...opts } = {}) {
    super({ base: PREVIEW_BASE, ...opts });
    this.local = local;
    this.payloads = new Map(); // request -> its payload, until its run starts
    this.kernel = (code, run) => this.runLocal(code, run);
    this.net = network;
    this.random = random;
    this.lost = 0; // (replies and stream events the simulated network lost)
    if (network.latency || network.jitter || network.loss) this.fetch = (url, init) => this.netFetch(String(url), init ?? {});
  }

  // ---- the simulated network

  // one way's delay, in ms
  oneWay() {
    const { latency, jitter } = this.net;
    return Math.max(0, latency / 2 + (jitter ? (this.random() * 2 - 1) * (jitter / 2) : 0));
  }
  lose() {
    if (!(this.net.loss > 0 && this.random() < this.net.loss)) return false;
    this.lost++;
    return true;
  }
  // (a wait that an abort ends at once, as a real request's would)
  wait(ms, signal) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(abortError());
      const t = setTimeout(() => { signal?.removeEventListener?.("abort", onAbort); resolve(); }, ms);
      const onAbort = () => { clearTimeout(t); reject(abortError()); };
      signal?.addEventListener?.("abort", onAbort, { once: true });
    });
  }
  async netFetch(url, init) {
    await this.wait(this.oneWay(), init.signal); // (the request, on its way)
    const res = await this.handle(url, init);
    const stream = (res.headers.get("Content-Type") ?? "").startsWith("text/event-stream");
    // (a lost reply: the gateway did the work; the page never hears of it)
    if (!stream && this.lose()) {
      await this.wait(this.oneWay(), init.signal);
      throw new TypeError("network error (the simulated network lost this reply)");
    }
    await this.wait(this.oneWay(), init.signal); // (the answer's head, on its way back)
    if (!stream || !res.body) return res;
    return new Response(this.delayed(res.body, init.signal), { status: res.status, headers: res.headers });
  }
  // A stream's chunks, each delayed by its own one-way delay, delivered in order (one connection): a chunk
  // is due at the later of its own arrival and the one before it.  A lost chunk breaks the stream.
  delayed(body, signal) {
    const net = this;
    const reader = body.getReader();
    let last = 0, chain = Promise.resolve(), stopped = false;
    return new ReadableStream({
      start(controller) {
        const fail = (e) => { if (!stopped) { stopped = true; reader.cancel().catch(() => {}); controller.error(e); } };
        signal?.addEventListener?.("abort", () => fail(abortError()), { once: true });
        (async () => {
          for (;;) {
            const { value, done } = await reader.read();
            const due = (last = Math.max(last, performance.now() + net.oneWay()));
            chain = chain.then(async () => {
              if (stopped) return;
              await net.wait(Math.max(0, due - performance.now()), signal);
              if (stopped) return;
              if (done) { stopped = true; return controller.close(); }
              if (net.lose()) return fail(new TypeError("network error (the simulated network broke this stream)"));
              controller.enqueue(value);
            }).catch(fail);
            if (done) return;
          }
        })().catch((e) => { chain = chain.then(() => fail(e)); });
      },
      cancel(reason) { stopped = true; return reader.cancel(reason); },
    });
  }

  post_runs(b, body) {
    if (body && typeof body.request === "string" && !this.runs.has(body.request) && body.payload) this.payloads.set(body.request, body.payload);
    const res = super.post_runs(b, body);
    // (a run the fake refused never starts: its payload isn't kept)
    if (!this.runs.has(body?.request)) this.payloads.delete(body?.request);
    return res;
  }

  runLocal(code, run) {
    const p = this.payloads.get(run.request) ?? {};
    this.payloads.delete(run.request);
    const opts = {
      mode: typeof p.mode === "string" ? p.mode : "python",
      ...(p.cell ? { cell: String(p.cell) } : {}),
      ...(Array.isArray(p.forget) && p.forget.length ? { forget: [...p.forget] } : {}),
      ...(p.mangle ? { mangle: true } : {}),
      ...(p.seed ? { seed: p.seed } : {}),
      ...(p.scoped && typeof p.scoped === "object" ? { scoped: { ...p.scoped } } : {}),
    };
    // (output after the run's terminal, e.g. once a restart settled it, goes nowhere)
    const emit = (ev) => { if (!run.outcome) this.emitEvent(run, ev); };
    return new Promise((resolve) => {
      let ended = false;
      const end = (outcome) => { if (!ended) { ended = true; resolve({ events: [], outcome }); } };
      this.local.execute(code, opts, {
        start() {},
        out: (text, isError) => emit({ type: "stream", name: isError ? "stderr" : "stdout", text: String(text) }),
        display: (data) => emit({ type: "display", data }),
        interact: () => emit({ type: "stream", name: "stderr", text: INTERACT_NOTE }),
        clear: () => emit({ type: "clear" }),
        done: (ms, info) => end(info?.error ? { status: "error", ms, ...(info.interrupted ? { ename: "KeyboardInterrupt" } : {}) } : { status: "ok", ms }),
        stopped: () => end({ status: "error", ename: "KeyboardInterrupt", ms: 0 }),
        skipped: () => end({ status: "refused", reason: "cancelled" }),
      });
    });
  }

  post_interrupt(b, body) {
    const res = super.post_interrupt(b, body);
    if (body?.epoch === b.epoch) this.local.interrupt();
    return res;
  }

  post_restart(b, body) {
    const before = b.incarnation;
    const res = super.post_restart(b, body);
    if (b.incarnation !== before) this.local.restart();
    return res;
  }
}

/**
 * Start a remote kernel on the simulated gateway, for the notebook `notebook`
 * (its id), running on `local` (a fresh interpreter: its variables are the
 * remote kernel's).  Resolves to {kernel, gateway, close()} once it is bound,
 * or rejects with why.
 */
export async function startPreview({ notebook, local, onStatus = () => {}, network = NO_NETWORK }) {
  const gateway = new PreviewGateway(local, { network });
  let token = null;
  const client = await RemoteClient.create({ base: gateway.base, token: () => token, fetch: gateway.fetch });
  token = gateway.issueToken(client.jkt);
  local.start?.();
  const kernel = new RemoteKernel({ client, notebook: String(notebook ?? "notebook"), requireGate: true });
  kernel.preview = true;
  kernel.gateway = gateway; // (the simulated gateway, for the page's tests: what it was asked and ran)
  const off = kernel.on("status", (text) => onStatus(statusText(text, network)));
  await kernel.start();
  if (!kernel.ready) {
    off();
    kernel.close();
    local.close?.();
    throw new Error("the remote kernel did not start");
  }
  return {
    kernel,
    gateway,
    close() {
      off();
      kernel.close();
      local.close?.();
    },
  };
}

/** The status line's text for a remote kernel's status (the preview says so, and what network it simulates). */
export function statusText(text, network = NO_NETWORK) {
  const t = String(text ?? "");
  return /^ready \(remote\)/.test(t)
    ? `Remote compute (preview, simulated${networkText(network)}) · ${t.replace(/^ready \(remote\)/, "ready")}`
    : `Remote compute (preview): ${t}`;
}

// ------------------------------------------------------------- the switch

/**
 * The page's switch to and from remote compute: at most one connection
 * attempt is current, and only the current one may change anything.  Every
 * attempt takes a new token, with its notebook, before its first await;
 * leave() (the person chose This browser, opened another notebook, or the
 * page replaced the kernel) and every newer attempt end it, pending or not:
 * its sheet is settled as cancelled, and a kernel it binds afterwards is
 * closed, never installed.  After each await, and in its status callback,
 * an attempt does nothing unless it is still current.
 *
 *   page: {
 *     currentId()       the notebook shown
 *     picked()          the picker's value ("local" | "gpu")
 *     pickLocal()       set the picker to This browser (nothing else)
 *     status(text)      the status line
 *     reactive()        whether the notebook is reactive (a remote kernel runs only there)
 *     makeLocal()       a fresh interpreter for the simulated gateway
 *     network()         (optional) the simulated network, parseNetwork's
 *     setKernel(k)      make k the shown notebook's kernel
 *   }
 * `deps` replaces the sheet, its cancellation and startPreview (tests).
 */
export function remoteSwitch(page, deps = {}) {
  const sheet = deps.sheet ?? (() => connectSheet());
  const cancelSheet = deps.cancelSheet ?? closeSheet;
  const start = deps.start ?? startPreview;
  let attempt = 0; // (the current attempt's token; every leave and every new attempt changes it)
  let on = null; // {id, r}: the kernel installed now
  const sw = {
    get attempt() { return attempt; },
    active: () => on !== null,
    installed: () => on,
    /** End the current attempt and the installed kernel, whatever their state. */
    leave() {
      attempt++;
      cancelSheet();
      if (on) {
        const { r } = on;
        on = null;
        r.close();
      }
    },
    /** Connect the notebook `id`: resolves to the installed {kernel, close} or null (cancelled, superseded, failed). */
    async connect(id) {
      sw.leave(); // (a newer attempt supersedes any other)
      const mine = attempt;
      const current = () => mine === attempt;
      const live = () => current() && page.currentId() === id && page.picked() === "gpu";
      // (only the current attempt may touch the picker or the status line)
      const back = (why) => {
        if (!current()) return null;
        attempt++;
        page.pickLocal();
        if (why) page.status(why);
        return null;
      };
      if (!page.reactive()) return back("remote compute runs only in the reactive notebook");
      let answer;
      try {
        answer = await sheet();
      } catch (e) {
        return back(`Remote compute (preview): ${e?.message ?? e}`);
      }
      if (!current()) return null; // (superseded: whoever did it settled this sheet and owns the picker)
      if (!answer || !live()) return back();
      let r;
      try {
        r = await start({ notebook: id, local: page.makeLocal(), network: page.network?.() ?? NO_NETWORK, onStatus: (t) => { if (current()) page.status(t); } });
      } catch (e) {
        return back(`Remote compute (preview): ${e?.message ?? e}`);
      }
      if (!live()) {
        r.close(); // (a stale bind: closed, never installed)
        return back();
      }
      on = { id, r };
      page.setKernel(r.kernel);
      return r;
    },
  };
  return sw;
}

// ------------------------------------------------------------- the Connect sheet

const CSS = `
#remotedlg { border: 1px solid var(--line); border-radius: 10px; background: var(--cell); color: var(--fg); padding: 16px 18px; width: min(560px, 92vw); }
#remotedlg::backdrop { background: rgba(0,0,0,.35); }
#remotedlg h2 { margin: 0 0 8px; font-size: 17px; }
#remotedlg .preview { margin: 0 0 10px; padding: 8px 10px; border-radius: 6px; background: var(--code); font-size: 13px; }
#remotedlg ul { margin: 6px 0 10px; padding-left: 20px; font-size: 14px; }
#remotedlg li { margin: 3px 0; }
#remotedlg .cap { display: flex; gap: 8px; align-items: center; font-size: 14px; }
#remotedlg .cap input { width: 5em; font: inherit; }
#remotedlg .note { color: var(--muted); font-size: 12px; margin: 4px 0 12px; }
#remotedlg .acts { display: flex; gap: 8px; justify-content: flex-end; }
`;

/** The Connect sheet's text (the plan's §5 consent copy and §9.1 cap field, marked as a preview). */
export const SHEET = {
  title: "Connect remote compute",
  backend: "Backend: simulated, in this browser (later: RunPod (GPU), an SSH host, a cluster)",
  preview: "Preview: this connects to a simulated gateway in this page. Your cells run through the remote kernel's path, approvals included, but execute in this browser. Nothing is sent anywhere, and nothing is billed.",
  intro: "When it is real, connecting gives Sagebrush:",
  points: [
    "full control of the Sagebrush compute space, which all of your account's notebooks share;",
    "code that runs there can read the sandbox's keys;",
    "you can revoke access in CoCalc at any time; new code stops within a few seconds.",
  ],
  approve: "Only the cells you run are sent, each exactly as it is on screen when you run it. A cell that changes before it is sent isn't run.",
  cap: "Proposed spending cap: $",
  capNote: "You'll confirm the cap on CoCalc's page; that's the one that counts.",
  allow: "Connect",
  cancel: "Cancel",
};

// (the sheet shown now: {settle}; a newer sheet, or closeSheet, settles it with null)
let openSheet = null;

/** Settle the Connect sheet shown now, if any, as cancelled (it closes, and its promise resolves to null). */
export function closeSheet() {
  openSheet?.settle(null);
}

/**
 * Show the Connect sheet; resolves to {cap} if the person connects, or null
 * (Cancel, Escape, or a newer sheet or closeSheet() settled it).
 * `doc` is the page's document (tests give their own).
 */
export function connectSheet(doc = document) {
  closeSheet();
  if (!doc.getElementById("remotedlgcss")) {
    const st = doc.createElement("style");
    st.id = "remotedlgcss";
    st.textContent = CSS;
    doc.head.append(st);
  }
  const el = (tag, text, props = {}) => Object.assign(doc.createElement(tag), text == null ? {} : { textContent: text }, props);
  const dlg = el("dialog", null, { id: "remotedlg" });
  dlg.setAttribute("aria-labelledby", "remotetitle");
  const ul = el("ul");
  for (const p of SHEET.points) ul.append(el("li", p));
  const capIn = el("input", null, { type: "number", min: "1", max: "1000", step: "1", value: "10", id: "remotecap" });
  capIn.setAttribute("aria-label", "Proposed spending cap in dollars");
  const cap = el("label", null, { className: "cap" });
  cap.append(SHEET.cap, capIn);
  const ok = el("button", SHEET.allow, { className: "primary", id: "remoteallow" });
  const no = el("button", SHEET.cancel, { id: "remotecancel" });
  const acts = el("div", null, { className: "acts" });
  acts.append(no, ok);
  dlg.append(el("h2", SHEET.title, { id: "remotetitle" }), el("p", SHEET.backend, { className: "note" }), el("p", SHEET.preview, { className: "preview" }), el("div", SHEET.intro), ul, el("p", SHEET.approve), cap, el("p", SHEET.capNote, { className: "note" }), acts);
  doc.body.append(dlg);
  return new Promise((resolve) => {
    // (exactly once: the dialog goes, and the answer is given; a later click or close does nothing)
    let settled = false;
    const sheet = {
      settle(answer) {
        if (settled) return;
        settled = true;
        if (openSheet === sheet) openSheet = null;
        if (dlg.open) dlg.close();
        dlg.remove();
        resolve(answer);
      },
    };
    openSheet = sheet;
    ok.addEventListener("click", () => {
      const n = Number(capIn.value);
      sheet.settle({ cap: Number.isFinite(n) && n >= 1 ? Math.min(1000, Math.floor(n)) : 10 });
    });
    no.addEventListener("click", () => sheet.settle(null));
    dlg.addEventListener("close", () => sheet.settle(null));
    if (typeof dlg.showModal === "function") dlg.showModal();
    else dlg.setAttribute("open", "");
    // (focus on the text first, not on Connect: Enter doesn't connect)
    dlg.tabIndex = -1;
    dlg.focus?.();
  });
}
