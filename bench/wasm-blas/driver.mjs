// One job = one freshly launched headless Chrome with a fresh user-data dir (daybreak2 a678e252 + the SIZE
// addendum): cache disabled and service workers bypassed BEFORE navigation; every CDP event kept (OUT.cdp.jsonl);
// a URL -> bytes ledger from Network.loadingFinished encodedDataLength up to the page's result marker
// ("SBRESULT" on the console; the page is never polled).
//   node driver.mjs URL OUT [timeout_s=600]       (SBWR_CHROME overrides the browser binary)
//
// No Chrome outlives the driver. Chrome runs under a small watchdog shell, in a process group of its own (G). As
// soon as the driver or Chrome is gone, the watchdog SIGKILLs every other member of G and removes the profile
// dir. That covers the exits no handler sees: SIGKILL of the driver, or of the driver's process group, which is
// not G (Nov 4: a Chrome tree outlived its killed driver on VM1). Every exit path the driver does see (normal,
// error, SIGINT, SIGTERM, SIGHUP, process exit) also kills G and removes the profile itself.
// Chrome's crash handlers (chrome_crashpad_handler) daemonize into sessions of their own, out of G's reach. Every
// process of this Chrome carries the profile dir, a fresh mkdtemp path unique to this run, in its arguments, so
// both the watchdog and the driver also SIGKILL exactly the processes whose arguments name that dir (never by a
// program name or a pattern). Both use the one matcher below: the watchdog runs this file as
//   node driver.mjs --kill-naming DIR SKIP_PID
// which reads each /proc/PID/cmdline split at its NUL argument boundaries (a newline inside one argument is part
// of that argument, never a boundary: astra, #645 DRIVER645-ARGV-1).
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { fileURLToPath } from "node:url";

// Does one argument name the profile dir: the dir itself, a path inside it, or --flag= either? "Inside" is
// lexical containment after resolving "." and ".." (posix.normalize), so <dir>/../elsewhere is not inside
// (astra, #645 DRIVER645-PATH-2).
function namesProfile(arg, dir) {
  return [arg, arg.replace(/^-[^=]*=/, "")].some((a) => {
    if (a !== dir && !a.startsWith(dir + "/")) return false;
    const n = posix.normalize(a);
    return n === dir || n === dir + "/" || n.startsWith(dir + "/");
  });
}
// SIGKILL every process (but this one and `skip`) that has an argument naming `dir`.
function killNamingProfile(dir, skip = []) {
  let pids = [];
  try { pids = readdirSync("/proc").filter((p) => /^\d+$/.test(p)); } catch { return; }
  for (const p of pids) {
    const pid = Number(p);
    if (pid === process.pid || skip.includes(pid)) continue;
    try {
      const argv = readFileSync(`/proc/${p}/cmdline`, "utf8").split("\0");
      if (argv.some((a) => namesProfile(a, dir))) process.kill(pid, "SIGKILL");
    } catch {}
  }
}
if (process.argv[2] === "--kill-naming") {
  const [dir, skip] = process.argv.slice(3);
  // (only ever a profile dir this driver makes: an absolute .../sbwr-udd-XXXXXX path)
  if (!/^\/.*\/sbwr-udd-[^/]+$/.test(dir ?? "")) process.exit(2);
  killNamingProfile(dir, [Number(skip)]);
  process.exit(0);
}

const [url, out, tArg = "600"] = process.argv.slice(2);
const CHROME = process.env.SBWR_CHROME ?? ["/usr/bin/google-chrome", "/usr/bin/chromium"].find(existsSync) ?? "google-chrome";
const udd = mkdtempSync(join(tmpdir(), "sbwr-udd-"));
const launchedAt = Date.now();
const WATCHDOG = [
  'D=$1; U=$2; N=$3; S=$4; shift 4',
  '"$@" & C=$!',
  'while kill -0 "$D" 2>/dev/null && kill -0 "$C" 2>/dev/null; do sleep 0.2; done',
  'for i in 1 2 3 4 5; do P=$(pgrep -g $$ | grep -vx $$); [ -z "$P" ] && break; kill -KILL $P 2>/dev/null; sleep 0.1; done',
  // (the watchdog's own arguments name the profile dir too, so it passes its pid to be skipped)
  '"$N" "$S" --kill-naming "$U" $$',
  'rm -rf -- "$U"',
].join("\n");
const chrome = spawn("sh", ["-c", WATCHDOG, "sh", String(process.pid), udd, process.execPath, fileURLToPath(import.meta.url), CHROME,
  "--headless=new", `--user-data-dir=${udd}`, "--remote-debugging-port=0", "--no-first-run",
  "--no-default-browser-check", "--disable-extensions",
  "--disable-sync", "--disable-default-apps", "--mute-audio",
  // (no --disable-component-update / --disable-background-networking: with them the first request waits about
  // 25 s in FIRST_PARTY_SETS_METADATA for component data that never comes; net-log, Nov 4)
  "--no-proxy-server", ...(process.env.SBWR_NETLOG ? [`--log-net-log=${process.env.SBWR_NETLOG}`] : []), ...(process.env.SBWR_FEAT ? [`--disable-features=${process.env.SBWR_FEAT}`] : []), "about:blank"], { detached: true, stdio: "ignore" });
// the watchdog is G's leader: -chrome.pid is all of G (watchdog, Chrome and every Chrome child)
let cleaned = false;
const cleanup = () => {
  if (cleaned) return;
  cleaned = true;
  try { process.kill(-chrome.pid, "SIGKILL"); } catch {}
  killNamingProfile(udd);
  // (synchronous, so signal handlers get it too: give the killed processes 300 ms to be gone, then remove the
  // profile; once before as well, in case the wait is cut short)
  try { rmSync(udd, { recursive: true, force: true }); } catch {}
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
  try { rmSync(udd, { recursive: true, force: true }); } catch {}
};
process.on("exit", cleanup);
for (const [sig, n] of [["SIGINT", 2], ["SIGTERM", 15], ["SIGHUP", 1]]) process.on(sig, () => { cleanup(); process.exit(128 + n); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cdpLog = out + ".cdp.jsonl";
writeFileSync(cdpLog, "");

async function main() {
  let port;
  for (let i = 0; i < 200 && !port; i++) {
    const f = join(udd, "DevToolsActivePort");
    if (existsSync(f)) port = Number(readFileSync(f, "utf8").split("\n")[0]);
    else await sleep(50);
  }
  if (!port) throw new Error("no DevToolsActivePort");
  const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  const page = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === "page");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((ok, bad) => { ws.onopen = ok; ws.onerror = bad; });
  let id = 0;
  const pending = new Map();
  const reqs = new Map(); // requestId -> {url, status, encoding, protocol, mime, bytes, finished}
  let resolveResult;
  const result = new Promise((r) => (resolveResult = r));
  let ledgerAtMarker = null, markerWallAt = null;
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    appendFileSync(cdpLog, ev.data + "\n");
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    const p = m.params;
    if (m.method === "Network.requestWillBeSent") {
      const r = reqs.get(p.requestId) ?? { url: p.request.url, redirects: [] };
      if (p.redirectResponse) r.redirects.push({ url: r.url, status: p.redirectResponse.status, bytes: p.redirectResponse.encodedDataLength });
      r.url = p.request.url;
      reqs.set(p.requestId, r);
    } else if (m.method === "Network.responseReceived") {
      const r = reqs.get(p.requestId) ?? { url: p.response.url, redirects: [] };
      const h = Object.fromEntries(Object.entries(p.response.headers).map(([k, v]) => [k.toLowerCase(), v]));
      Object.assign(r, { status: p.response.status, encoding: h["content-encoding"] ?? "identity", protocol: p.response.protocol, mime: p.response.mimeType, fromCache: p.response.fromDiskCache || p.response.fromServiceWorker || false });
      reqs.set(p.requestId, r);
    } else if (m.method === "Network.loadingFinished") {
      const r = reqs.get(p.requestId);
      if (r) { r.bytes = p.encodedDataLength; r.finished = true; }
    } else if (m.method === "Network.loadingFailed") {
      const r = reqs.get(p.requestId);
      if (r) r.failed = p.errorText;
    } else if (m.method === "Runtime.consoleAPICalled") {
      const s = p.args?.[0]?.value;
      if (typeof s === "string" && s.startsWith("SBRESULT ")) {
        ledgerAtMarker = [...reqs.values()].map((r) => ({ ...r }));
        markerWallAt = Date.now();
        resolveResult(JSON.parse(s.slice(9)));
      }
    }
  };
  const send = (method, params = {}) => new Promise((ok) => { const i = ++id; pending.set(i, ok); ws.send(JSON.stringify({ id: i, method, params })); });
  await send("Network.enable");
  if (process.env.SBWR_NOCD !== "1") await send("Network.setCacheDisabled", { cacheDisabled: true });
  if (process.env.SBWR_NOSW !== "1") await send("Network.setBypassServiceWorker", { bypass: true });
  if (process.env.SBWR_CLEAR === "1") await send("Network.clearBrowserCache"); // (fresh profile: already empty)
  await send("Runtime.enable");
  await send("Page.enable");
  // readiness navigation (excluded from the ledger and from timing): a fresh Chrome's first request may wait up to
  // ~25 s in FIRST_PARTY_SETS_METADATA (net-log, Nov 4; not cured by flags), browser startup rather than page cost.
  // /ready.html is a tiny static page of this server; the measured navigation starts after its load event, in the
  // same fresh process with the cache already disabled.
  const loaded = () => new Promise((ok) => { const prev = ws.onmessage; ws.onmessage = (ev) => { prev(ev); if (JSON.parse(ev.data).method === "Page.loadEventFired") { ws.onmessage = prev; ok(); } }; });
  const ready0 = Date.now();
  const rl = loaded();
  await send("Page.navigate", { url: new URL("/ready.html", url).href });
  await rl;
  const readyMs = Date.now() - ready0;
  const readyLedger = [...reqs.values()].map((r) => ({ url: r.url, status: r.status ?? null, bytes: r.bytes ?? null, finished: !!r.finished }));
  reqs.clear();
  appendFileSync(cdpLog, JSON.stringify({ sbwr: "measured navigation starts", ready_ms: readyMs }) + "\n");
  await send("Page.navigate", { url });
  const timer = sleep(Number(tArg) * 1000).then(() => ({ error: `timeout ${tArg}s` }));
  const res = await Promise.race([result, timer]);
  const ledger = (ledgerAtMarker ?? [...reqs.values()]).map((r) => ({ url: r.url, status: r.status, encoding: r.encoding, protocol: r.protocol, mime: r.mime, bytes: r.bytes ?? null, finished: !!r.finished, failed: r.failed ?? null, fromCache: r.fromCache ?? null, redirects: r.redirects }));
  const counted = ledger.filter((r) => r.finished && !r.failed && r.status >= 200 && r.status < 400);
  const total = counted.reduce((s, r) => s + r.bytes + r.redirects.reduce((t, x) => t + (x.bytes || 0), 0), 0);
  ws.close();
  const readyBytes = readyLedger.filter((r) => r.finished).reduce((s, r) => s + r.bytes, 0);
  return { url, ready_ms: readyMs, ready_fetched_bytes: readyBytes, ready_ledger: readyLedger,
    launch_to_result_ms: markerWallAt ? markerWallAt - launchedAt : null, // (wall clock: process launch -> the marker reaching the driver)
    launched_at: new Date(launchedAt).toISOString(), browser: version.Browser, protocol_version: version["Protocol-Version"], user_agent: version["User-Agent"], result: res,
    fetched_total_bytes: total, fetched_inclusive_bytes: total + readyBytes, ledger };
}

let rec;
try {
  rec = await main();
} catch (e) {
  rec = { url, result: { error: String(e && e.stack ? e.stack : e) } };
} finally {
  cleanup();
}
writeFileSync(out, JSON.stringify(rec) + "\n");
console.log(JSON.stringify({ url, ok: !rec.result.error, error: rec.result.error ?? null, marker_ms: rec.result.marker_ms ?? null, fetched: rec.fetched_total_bytes ?? null }));
process.exit(0); // (the pending timeout timer would otherwise keep Node alive)
