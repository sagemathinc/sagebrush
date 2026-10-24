// The shell worker's bootstrap (plan-bash-shell r3 §6): a same-origin core
// script, served with its own Content-Security-Policy (web/csp-policy.mts
// shellWorkerPolicy, in _headers and in the service worker's own response):
// no network (connect-src 'none'), no eval, no further workers; scripts only
// from this site and from blob: URLs.  So whatever the module does, the
// worker can't reach the network.
//
// The page (web/shell/loader.ts) posts it, once, the module's text, already
// checked against its package set's pins, and a MessagePort.  The text
// becomes a blob: module, imported here and nowhere else (the page's realm
// never evaluates it), and its URL is revoked once imported.  The module's
// start(port) then speaks the shell host protocol on that port.
self.onmessage = async (e) => {
  self.onmessage = null;
  const { text, port } = e.data ?? {};
  if (typeof text !== "string" || !(port instanceof MessagePort)) return;
  const url = URL.createObjectURL(new Blob([text], { type: "text/javascript" }));
  try {
    const mod = await import(url);
    URL.revokeObjectURL(url);
    if (typeof mod.start !== "function") throw new Error("the shell module has no start()");
    mod.start(port);
  } catch (err) {
    URL.revokeObjectURL(url);
    port.postMessage({ name: "boot.failed", payload: { message: String((err && err.message) || err) } });
  }
};
