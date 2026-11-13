// Whether this browser can run code in the runner, the opaque-origin sandboxed frame (design/runner.md): every browser.
// Chromium and Firefox start its classic blob: worker; WebKit (Safari, and every browser on iOS) refuses that one under
// the frame's COEP, and the frame starts a data: worker instead (web/runner/index.html).  Firefox needs the runner's
// page to say Cross-Origin-Resource-Policy: cross-origin, as web/csp.ts writes it.  Each browser's own run is
// web/share/test-runner-engines.mjs.  Outside a browser: false.
export const runnerBrowser = (nav) => !!nav;
export const RUNNER_BROWSER = runnerBrowser(globalThis.navigator);
