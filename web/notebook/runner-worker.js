// The interpreter in the runner (web/runner/index.html; design/runner.md): a
// drop-in for `new Worker("sagebrush-worker.js")` that puts the worker inside
// an <iframe sandbox="allow-scripts">, whose origin is opaque and which has no
// network, so code that escaped Python's sandbox would have no storage, no
// page and no way to send anything anywhere.
//
//   new WorkerKernel({ createWorker: () => new RunnerWorker("/runner/", { name }) })
//
// This page fetches what the interpreter needs (its script, its engine and
// precompiled library, and the shared files it was told to mount) and hands
// the bytes over; nothing else.  Messages are relayed through the frame (page
// <-> frame by a MessagePort, frame <-> worker).  The interrupt flag stays in
// the frame, so Stop is a message (interrupt()).
//
// With `fallback` (a function making a plain worker), a frame that doesn't
// answer within a few seconds is given up for that worker: offline, the
// frame can't load (a service worker doesn't serve a sandboxed frame), and
// the notebook page still works with the user's own notebooks.  A page
// running someone else's code (a shared collection) gives no fallback.

const OWN = /\/sagebrush-(engine\.wasm|precompiled\.json)$/;

export class RunnerWorker {
  /**
   * @param {string} src the runner page's URL
   * @param {{name?: string, fallback?: () => any}} [o] the worker's name (TimeTravel
   *   replay's parameters), and a plain worker to use if the frame doesn't answer
   */
  constructor(src, { name = "", fallback } = {}) {
    this.onmessage = null;
    this.onerror = null;
    this.queue = [];
    this.port = null;
    this.interruptible = false;
    this.closed = false;
    this.inner = null;
    const giveUp = () => {
      if (this.port || this.closed || this.inner || !fallback) return;
      console.warn("sagebrush: the runner did not start; Python runs in a plain worker");
      this.frame.remove();
      const w = (this.inner = fallback());
      w.onmessage = (e) => this.onmessage?.(e);
      w.onerror = (e) => this.onerror?.(e);
      for (const m of this.queue) w.postMessage(m);
      this.queue = [];
    };
    this.timer = fallback ? setTimeout(giveUp, 10000) : null;
    // what the interpreter may ask this page to fetch: its own files under
    // base, and the files it was told to mount (by URL)
    const runner = new URL(src, location.href);
    this.base = new URL("../", runner).href;
    this.mounted = new Set();
    const ch = new MessageChannel();
    ch.port1.onmessage = (e) => {
      const d = e.data;
      if (!d || typeof d !== "object" || this.closed) return;
      if (d.runnerReady) {
        if (this.inner) return;
        clearTimeout(this.timer);
        this.port = ch.port1;
        for (const m of this.queue) this.port.postMessage(m);
        this.queue = [];
        return;
      }
      if (typeof d.runnerFetch === "number") return void this.fetchFor(d.runnerFetch, d.url);
      if (typeof d.runnerError === "string") return this.onerror?.({ message: d.runnerError });
      if (d.ready) this.interruptible = !!d.interruptible;
      this.onmessage?.({ data: d });
    };
    const f = (this.frame = document.createElement("iframe"));
    f.setAttribute("sandbox", "allow-scripts");
    f.setAttribute("allow", "cross-origin-isolated");
    f.setAttribute("aria-hidden", "true");
    f.tabIndex = -1;
    f.style.display = "none";
    f.src = runner.href;
    const script = fetch(new URL("sagebrush-worker.js", this.base)).then((r) => {
      if (!r.ok) throw new Error(`the interpreter could not be loaded (HTTP ${r.status})`);
      return r.text();
    });
    // (the frame's origin is opaque, so "*" is the only target that reaches
    // it; what it carries, the port, is only useful to that frame)
    f.addEventListener("load", async () => {
      // (a frame that loaded but doesn't answer is an error page: offline, say)
      if (fallback) {
        clearTimeout(this.timer);
        this.timer = setTimeout(giveUp, 3000);
      }
      try {
        f.contentWindow?.postMessage({ sagebrushRunner: 1, name, base: this.base, script: await script }, "*", [ch.port2]);
      } catch (e) {
        this.onerror?.({ message: String(e?.message ?? e) });
      }
    }, { once: true });
    document.body.appendChild(f);
  }
  async fetchFor(id, url) {
    let bytes = null;
    try {
      const u = new URL(String(url));
      const allowed = this.mounted.has(u.href) || (u.href.startsWith(this.base) && OWN.test(u.pathname));
      if (allowed) {
        const r = await fetch(u.href);
        if (r.ok) bytes = await r.arrayBuffer();
      }
    } catch {}
    if (this.closed) return;
    this.port?.postMessage({ runnerFetched: id, url, bytes }, bytes ? [bytes] : []);
  }
  postMessage(m) {
    if (this.inner) return this.inner.postMessage(m);
    // (a shared collection's files: the interpreter may ask for these)
    if (m && Array.isArray(m.mount)) for (const [, r] of m.mount) if (r && typeof r.url === "string") this.mounted.add(new URL(r.url).href);
    if (this.port) this.port.postMessage(m);
    else this.queue.push(m);
  }
  /** Stop the run with this id (KeyboardInterrupt), if the frame has the flag. */
  get interrupt() {
    if (this.inner) return this.inner.interrupt;
    return this.interruptible ? (id) => this.postMessage({ runnerInterrupt: id }) : undefined;
  }
  terminate() {
    this.closed = true;
    clearTimeout(this.timer);
    this.inner?.terminate();
    this.port?.close();
    this.frame.remove();
  }
}
