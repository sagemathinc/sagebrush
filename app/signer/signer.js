// The approvals window's page (app/src-tauri/src/signer.rs): bundled with the app, shown only in the window Rust makes.
// For now it shows nothing to approve: the keys and the pending list come in later changes.  In a self-test
// (window.__SB_SIGNER_PROBE__, which only the app sets, and only then) it tries its stand-in signing command (the
// positive: it must sign), then, in the controls, loads another local server's page in a frame or goes there itself
// (which must never reach the command).
// A self-test's diagnostic (only when its probe is present): if the call is refused, the page reloads itself once with
// ?probe=refused-acl or ?probe=refused, a fixed code the app logs; a reloaded page doesn't call again.
(() => {
  const probe = window.__SB_SIGNER_PROBE__;
  if (!probe) return;
  const status = document.getElementById("status");
  if (location.search.includes("probe=")) { status.textContent = "probe: reported"; return; }
  const invoke = window.__TAURI__?.core?.invoke;
  (async () => {
    try { status.textContent = "probe: " + (await invoke("signer_probe_sign", { msg: "the signer page" })); }
    catch (e) {
      status.textContent = "probe refused: " + (e?.message ?? e);
      const acl = /not allowed/i.test(String(e?.message ?? e));
      location.replace(location.pathname + "?probe=" + (acl ? "refused-acl" : "refused"));
      return;
    }
    if (probe.control === "csp-off" && probe.other) {
      const f = document.createElement("iframe");
      f.src = probe.other + "/sframe";
      document.body.append(f);
    }
    if (probe.control === "guard-off" && probe.other) setTimeout(() => { location.href = probe.other + "/stop"; }, 1500);
  })();
})();
