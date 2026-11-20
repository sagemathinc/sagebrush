// ci: web-runner order=374 runner=bun
// Which browsers run code in the sandboxed runner (web/notebook/runner-browser.js): every one, WebKit's too (Safari, and
// iOS browsers built on it, whose runner starts a data: worker), from the user agents those browsers send. A page's own
// run in Chromium, Firefox and WebKit is web/share/test-runner-engines.mjs.
//   bun web/notebook/test-runner-browser.mjs
let n = 0;
const fails = [];
const ok = (c, what) => { n++; if (!c) { fails.push(what); console.log("FAIL " + what); } else console.log("ok   " + what); };
import { runnerBrowser } from "./runner-browser.js";
const runs = async (nav) => runnerBrowser(nav);
const chromium = (ua) => ({ userAgent: ua, userAgentData: { brands: [] } });
const plain = (ua) => ({ userAgent: ua });
const CASES = [
  ["Chrome on Linux", chromium("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36"), true],
  ["Edge on Windows", chromium("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0"), true],
  ["headless Chromium", chromium("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/141.0.0.0 Safari/537.36"), true],
  ["Firefox on Linux", plain("Mozilla/5.0 (X11; Linux x86_64; rv:145.0) Gecko/20100101 Firefox/145.0"), true],
  ["Firefox on macOS", plain("Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:145.0) Gecko/20100101 Firefox/145.0"), true],
  ["Safari on macOS", plain("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.1 Safari/605.1.15"), true],
  ["Safari on iPhone", plain("Mozilla/5.0 (iPhone; CPU iPhone OS 26_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.1 Mobile/15E148 Safari/604.1"), true],
  ["Chrome on iPhone (WebKit)", plain("Mozilla/5.0 (iPhone; CPU iPhone OS 26_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/141.0.0.0 Mobile/15E148 Safari/604.1"), true],
  ["Firefox on iPad (WebKit)", plain("Mozilla/5.0 (iPad; CPU OS 26_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/145.0 Mobile/15E148 Safari/605.1.15"), true],
  // (a Chromium page whose userAgentData is gone, as web/test-runner-pill.mjs makes one: the runner too)
  ["Chromium without userAgentData", plain("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36"), true],
];
for (const [what, nav, want] of CASES) {
  const got = await runs(nav);
  ok(got === want, `${what}: ${want ? "runs in the runner" : "no runner"} (${got})`);
}
ok((await runs(undefined)) === false, "outside a browser (no navigator): no runner");
// (both pages that run code in the runner decide by this check, not by Chromium's userAgentData: the notebook page and
// the board, whose gate a Firefox leg doesn't reach)
{
  const { readFileSync } = await import("node:fs");
  const read = (f) => readFileSync(new URL(f, import.meta.url), "utf8");
  for (const [what, file, gate] of [["the notebook page", "../index.html", /const RUNNER = [^\n]*crossOriginIsolated === true && RUNNER_BROWSER && !window\.__TAURI__;/], ["the board", "../board/page.ts", /crossOriginIsolated === true && RUNNER_BROWSER && !\(window as any\)\.__TAURI__/]]) {
    const src = read(file);
    ok(gate.test(src) && !/"userAgentData" in navigator/.test(src) && /import \{ RUNNER_BROWSER \} from "\.\.?\/(notebook\/)?runner-browser\.js";/.test(src), `${what} (${file.slice(3)}) runs code in the runner by RUNNER_BROWSER, never by userAgentData`);
  }
}
console.log(fails.length ? `${fails.length} of ${n} failed` : `${n}/${n} passed`);
process.exit(fails.length ? 1 : 0);
