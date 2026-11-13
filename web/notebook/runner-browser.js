// Whether this browser can run code in the runner, the opaque-origin sandboxed frame (design/runner.md): every browser
// but WebKit's (Safari, and every browser on iOS), whose worker doesn't start in that frame (design/runner.md, Next).
// Chromium and Firefox are tested; Firefox needs the runner's page to say Cross-Origin-Resource-Policy: cross-origin,
// as web/csp.ts writes it.  WebKit: "AppleWebKit" in the user agent without Chromium's navigator.userAgentData
// (Chromium's says "AppleWebKit" too).  Outside a browser: false.
export const runnerBrowser = (nav) => !!nav && !(/AppleWebKit\//.test(nav.userAgent ?? "") && !("userAgentData" in nav));
export const RUNNER_BROWSER = runnerBrowser(globalThis.navigator);
