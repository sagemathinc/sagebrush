// The interpreter in the runner (web/runner/index.html; design/runner.md): a
// drop-in for `new Worker("sagebrush-worker.js")` that puts the worker inside
// an <iframe sandbox="allow-scripts">, whose origin is opaque, so code that
// escaped Python's sandbox would have no storage, no page and no network.
//
//   new WorkerKernel({ createWorker: () => new RunnerWorker("/runner/", { name }) })
//
// Messages are relayed through the frame (page <-> frame by a MessagePort,
// frame <-> worker).  The interrupt flag stays in the frame, so Stop is a
// message (interrupt()).

export class RunnerWorker {
  /**
   * @param {string} src the runner page's URL
   * @param {{name?: string, sha256?: string}} [o] the worker's name (TimeTravel replay's
   *   parameters), and the SHA-256 its script must have
   */
  constructor(src, { name = "", sha256 } = {}) {
    this.onmessage = null;
    this.onerror = null;
    this.queue = [];
    this.port = null;
    this.interruptible = false;
    const ch = new MessageChannel();
    ch.port1.onmessage = (e) => {
      const d = e.data;
      if (!d || typeof d !== "object") return;
      if (d.runnerReady) {
        this.port = ch.port1;
        for (const m of this.queue) this.port.postMessage(m);
        this.queue = [];
        return;
      }
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
    f.src = src;
    // (the frame's origin is opaque, so "*" is the only target that reaches
    // it; what it carries, the port, is only useful to that frame)
    f.addEventListener("load", () => f.contentWindow?.postMessage({ sagebrushRunner: 1, name, sha256 }, "*", [ch.port2]), { once: true });
    document.body.appendChild(f);
  }
  postMessage(m) {
    if (this.port) this.port.postMessage(m);
    else this.queue.push(m);
  }
  /** Stop the run with this id (KeyboardInterrupt), if the frame has the flag. */
  get interrupt() {
    return this.interruptible ? (id) => this.postMessage({ runnerInterrupt: id }) : undefined;
  }
  terminate() {
    this.port?.close();
    this.frame.remove();
  }
}
