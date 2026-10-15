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

import { FILES_RUNNER } from "./files-runner.js";

// the files the runner may have the page fetch for its worker: the engine,
// the PNG module (fetched when Python first writes or reads a PNG) and the
// precompiled library, each checked by its SHA-256 in the worker
const OWN = /\/sagebrush-(engine\.wasm|raster\.wasm|precompiled\.json)$/;

// Files mode: the runner for a page that has the engine's files itself (a
// board downloaded as one HTML file).  A file:// page is never cross-origin
// isolated, so there is no SharedArrayBuffer and no broker: the frame (a
// srcdoc of its own, opaque, sandboxed) makes blob: URLs of the files, and
// the worker reads them (the engine by synchronous XHR, the precompiled
// library by fetch; __SB_FILES__ in web/worker.ts).  Its policy allows no
// network but those blob: URLs.  No interrupt flag: Stop restarts the
// worker.  (A srcdoc frame also inherits its parent's policy: the page must
// allow its inline script, as a downloaded file, with no policy, does, and
// the frame other sites show a board in does by its hash: files-runner.js.)
export class RunnerWorker {
  /**
   * @param {string} src the runner page's URL
   * @param {{name?: string, fallback?: () => any, files?: Record<string, ArrayBuffer>}} [o]
   *   the worker's name (TimeTravel replay's parameters); a plain worker to use
   *   if the frame doesn't answer; or, with src null, the engine's files
   *   themselves (sagebrush-worker.js, sagebrush-engine.wasm and
   *   sagebrush-precompiled.json), for files mode
   */
  constructor(src, { name = "", fallback, files } = {}) {
    this.onmessage = null;
    this.onerror = null;
    this.queue = [];
    this.port = null;
    this.interruptible = false;
    this.closed = false;
    this.inner = null;
    // (whether the interpreter has said anything: until then, what was sent
    // is kept in the queue too, for a fallback to be given)
    this.alive = false;
    this.keep = !!fallback;
    this.watchdog = null;
    const giveUp = () => {
      if (this.alive || this.closed || this.inner || !fallback) return;
      console.warn("sagebrush: the runner did not start; Python runs in a plain worker");
      clearTimeout(this.timer);
      clearTimeout(this.watchdog);
      this.port?.close();
      this.port = null;
      this.frame.remove();
      const w = (this.inner = fallback());
      w.onmessage = (e) => this.onmessage?.(e);
      w.onerror = (e) => this.onerror?.(e);
      for (const m of this.queue) w.postMessage(m);
      this.queue = [];
    };
    this.timer = fallback ? setTimeout(giveUp, 10000) : null;
    // a frame that answered but whose interpreter says nothing once it has
    // something to do (a browser where the worker can't start in it: WebKit)
    this.watch = () => {
      if (fallback && !this.alive && !this.watchdog) this.watchdog = setTimeout(giveUp, 8000);
    };
    // what the interpreter may ask this page to fetch: its own files under
    // base, and the files it was told to mount (by URL); in files mode,
    // nothing: it has its files already, and this page fetches nothing for
    // it (SEC-CAC-1)
    const runner = new URL(src ?? "about:blank", location.href);
    this.base = files ? null : new URL("../", runner).href;
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
        if (!fallback) this.queue = [];
        else if (this.queue.length) this.watch();
        return;
      }
      // (an error before the interpreter said anything: it didn't start)
      if (typeof d.runnerError === "string" && !this.alive && fallback) return giveUp();
      if (!this.alive) {
        this.alive = true;
        clearTimeout(this.watchdog);
        this.queue = [];
      }
      if (typeof d.runnerFetch === "number") return void this.fetchFor(d.runnerFetch, d.url);
      if (typeof d.runnerError === "string") return this.onerror?.({ message: d.runnerError });
      if (d.ready) this.interruptible = !!d.interruptible;
      this.onmessage?.({ data: d });
    };
    const f = (this.frame = document.createElement("iframe"));
    f.setAttribute("sandbox", "allow-scripts");
    f.setAttribute("aria-hidden", "true");
    f.tabIndex = -1;
    f.style.display = "none";
    if (files) {
      f.srcdoc = FILES_RUNNER;
      f.addEventListener("load", () => f.contentWindow?.postMessage({ sagebrushRunnerFiles: 1, name, files }, "*", [ch.port2]), { once: true });
      document.body.appendChild(f);
      return;
    }
    f.setAttribute("allow", "cross-origin-isolated");
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
        // (not this runner's to say once it is given up or closed: a fallback
        // runs now, CORR-FED-2; before that, with one, it is given up)
        if (this.closed || this.inner) return;
        if (fallback) return giveUp();
        this.onerror?.({ message: String(e?.message ?? e) });
      }
    }, { once: true });
    document.body.appendChild(f);
  }
  async fetchFor(id, url) {
    let bytes = null;
    try {
      const u = new URL(String(url));
      const allowed = !!this.base && (this.mounted.has(u.href) || (u.href.startsWith(this.base) && OWN.test(u.pathname)));
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
    if (!this.port) return void this.queue.push(m);
    this.port.postMessage(m);
    if (!this.alive && this.keep) {
      // (kept for a fallback, until the interpreter answers)
      this.queue.push(m);
      this.watch();
    }
  }
  /** Stop the run with this id (KeyboardInterrupt), if the frame has the flag. */
  get interrupt() {
    if (this.inner) return this.inner.interrupt;
    return this.interruptible ? (id) => this.postMessage({ runnerInterrupt: id }) : undefined;
  }
  terminate() {
    this.closed = true;
    clearTimeout(this.timer);
    clearTimeout(this.watchdog);
    this.inner?.terminate();
    this.port?.close();
    this.frame.remove();
  }
}
