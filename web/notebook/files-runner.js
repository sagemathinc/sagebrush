// The runner's files-mode frame (runner-worker.js): its page, a srcdoc, and
// its one inline script, by itself, so that a page whose policy the frame
// inherits can allow that script by its hash (web/csp.ts: /frame/*).
// (its script tags built at run time: this module is bundled into pages'
// inline scripts, where a literal </script ends the page's script, and a
// literal <script after a <!-- makes the parser skip the page's own end tag)
const LT = String.fromCharCode(60);
const SCRIPT = LT + "script>", END_SCRIPT = LT + "/script>";
export const FILES_RUNNER_SCRIPT = `
(() => {
  let started = false;
  addEventListener("message", (e) => {
    if (started || e.source !== parent || !e.data || e.data.sagebrushRunnerFiles !== 1 || e.ports.length !== 1) return;
    started = true;
    const port = e.ports[0], f = e.data.files || {};
    try {
      const url = (name, type) => URL.createObjectURL(new Blob([f[name]], { type }));
      const files = { "sagebrush-engine.wasm": url("sagebrush-engine.wasm", "application/wasm"), "sagebrush-precompiled.json": url("sagebrush-precompiled.json", "application/json") };
      const script = new Blob(["self.__SB_FILES__ = " + JSON.stringify(files) + ";\\n", f["sagebrush-worker.js"]], { type: "text/javascript" });
      const w = new Worker(URL.createObjectURL(script), { name: String(e.data.name || "") });
      w.onmessage = (m) => { let d = m.data; if (d && d.ready) d = { ...d, interrupt: null }; port.postMessage(d); };
      w.onerror = (ev) => port.postMessage({ runnerError: String(ev.message || "an error in the interpreter") });
      port.onmessage = (m) => w.postMessage(m.data);
      port.postMessage({ runnerReady: true });
    } catch (err) {
      port.postMessage({ runnerError: String((err && err.message) || err) });
    }
  });
})();
`;
export const FILES_RUNNER = `<!doctype html><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' blob:; worker-src blob:; connect-src blob:; base-uri 'none'; form-action 'none'">
${SCRIPT}${FILES_RUNNER_SCRIPT}${END_SCRIPT}`;
