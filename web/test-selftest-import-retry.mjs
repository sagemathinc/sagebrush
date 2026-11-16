// ci: web-browser/terminal.4 order=61 chrome
// The app's self-test imports its diagnosis module (web/index.html, selftest()) bounded at 15 s, and on a timeout
// imports it once more under another URL (?retry=1): on the macOS and Windows web views a request to the app's page
// server is now and then never answered while every other one is.  Here that code, as web/index.html has it (its
// bound shortened to 1.5 s), runs in Chrome against a server that never answers the module's first request:
//   - the retry loads it, and the log says the timeout, the retry and that the retry loaded it;
//   - a server that answers at once: no retry, nothing more logged;
//   - a server that answers neither: two timeouts logged, no module, no claim that the retry loaded it.
//   CHROME=google-chrome node web/test-selftest-import-retry.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer as httpServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const html = readFileSync(new URL("index.html", import.meta.url), "utf8");
let failures = 0;
const ok = (c, what) => { console.log((c ? "ok   " : "FAIL ") + what); if (!c) failures++; };
setTimeout(() => { console.log("FAIL the test did not end within 90 s"); process.exit(1); }, 90_000).unref();

// (the code, as the page has it: from the import helper to the end of its try/catch; and the page's bounded())
const FROM = "    const stImport = (q) =>";
const END = 'infoLines = await st.diagnoseLines(kernel);\n    } catch (e) {\n      console.log("diagnose import: " + e);\n    }';
const a = html.indexOf(FROM), b = html.indexOf(END, a);
const code = a < 0 || b < 0 ? "" : html.slice(a, b + END.length);
ok(code.includes('stImport("?retry=1")') && code.includes("15000"), "web/index.html's self-test import, with its retry, is found");
const boundedLine = html.split("\n").find((l) => l.startsWith("const bounded = "));
ok(!!boundedLine, "web/index.html's bounded() is found");

// the page: the code in a function, its bound 1.5 s, with what it needs stood in for; what it logged, whether it got
// the module and the module's lines, posted back
const pageFor = (report) => `<!doctype html><script type="module">
const logs = [];
console.log = (s) => logs.push(String(s));
${boundedLine}
window.__sbSelftestHeld = () => ["(what held the server)"];
const kernel = { name: "stand-in" };
let st = null, infoLines = [];
const importAt = performance.now();
${code.replace("15000", "1500")}
fetch(${JSON.stringify(report)}, { method: "POST", body: JSON.stringify({ logs, loaded: !!st, infoLines }) });
</script>`;

// the page's server: the page, and the module, its first request (no query) answered or never, ?retry=1 likewise
const MODULE = 'export const diagnoseLines = async (k) => ["diagnosed " + k.name];';
const serve = (page, { first, retry }) => new Promise((resolve) => {
  const seen = [];
  const server = httpServer((req, res) => {
    seen.push(req.url);
    if (req.url === "/") return res.writeHead(200, { "content-type": "text/html" }).end(page());
    if (req.url === "/sagebrush-selftest.js" && !first) return; // (never answered)
    if (req.url === "/sagebrush-selftest.js?retry=1" && !retry) return;
    if (req.url.startsWith("/sagebrush-selftest.js")) return res.writeHead(200, { "content-type": "text/javascript" }).end(MODULE);
    res.writeHead(404).end();
  });
  server.listen(0, "127.0.0.1", () => resolve({ server, seen, url: `http://127.0.0.1:${server.address().port}/` }));
});

const reports = [];
const reportServer = httpServer((req, res) => { let s = ""; req.on("data", (d) => (s += d)); req.on("end", () => { reports.push(s); res.writeHead(200, { "access-control-allow-origin": "*" }).end(); }); });
await new Promise((r) => reportServer.listen(0, "127.0.0.1", r));
const REPORT = `http://127.0.0.1:${reportServer.address().port}/`;

// one case in its own Chrome: the page's report, or null after 10 s
const run = async (answers) => {
  const n = reports.length;
  const { server, seen, url } = await serve(() => pageFor(REPORT), answers);
  const profile = mkdtempSync(join(tmpdir(), "sb-retry-"));
  const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", "--disable-gpu", `--user-data-dir=${profile}`, url], { stdio: "ignore", detached: true });
  const t0 = Date.now();
  while (reports.length === n && Date.now() - t0 < 10_000) await new Promise((r) => setTimeout(r, 100));
  try { process.kill(-chrome.pid, "SIGKILL"); } catch {}
  server.close();
  server.closeAllConnections?.();
  rmSync(profile, { recursive: true, force: true });
  return { report: reports.length > n ? JSON.parse(reports.at(-1)) : null, seen };
};

if (code && boundedLine) {
  const lost = await run({ first: false, retry: true });
  const l = lost.report?.logs ?? [];
  ok(lost.report?.loaded === true && lost.report.infoLines[0] === "diagnosed stand-in",
    "a first request never answered: the retry loads the module and its lines are read: " + JSON.stringify(lost.report));
  ok(l[0] === "diagnose import: Error: timed out after 1.5 s" && l.includes("diagnose import: (what held the server)")
    && l.includes("diagnose import: retrying once under another URL") && l.at(-1) === "diagnose import: the retry loaded it",
    "...and the log says the timeout, what held the server, the retry, and that the retry loaded it: " + JSON.stringify(l));
  ok(lost.seen.includes("/sagebrush-selftest.js") && lost.seen.includes("/sagebrush-selftest.js?retry=1"), "...asking the server twice, the second time under ?retry=1: " + JSON.stringify(lost.seen));

  const fine = await run({ first: true, retry: true });
  ok(fine.report?.loaded === true && fine.report.logs.length === 0 && !fine.seen.includes("/sagebrush-selftest.js?retry=1"),
    "a server that answers: the module loads, nothing is logged, no retry: " + JSON.stringify(fine.report) + " " + JSON.stringify(fine.seen));

  const none = await run({ first: false, retry: false });
  const nl = none.report?.logs ?? [];
  ok(none.report?.loaded === false && nl.filter((s) => s === "diagnose import: Error: timed out after 1.5 s").length === 2 && !nl.includes("diagnose import: the retry loaded it"),
    "a server that answers neither: two timeouts logged, no module, never \"the retry loaded it\": " + JSON.stringify(none.report));
}
reportServer.close();
console.log(failures ? `${failures} FAILED` : "all passed");
process.exit(failures ? 1 : 0);
