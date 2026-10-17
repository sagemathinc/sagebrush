// time in the browser (lib/_pytime.py): the zone Chrome is in (its TZ), from
// the pinned zone data (tzdata/, web/tzdata-chunks.mts) the worker fetches
// and checks the first time time is imported (web/lib-lazy.ts), on the full
// page in headless Chromium, compared with CPython reading the same zone
// files (TZDIR); and how long that first import takes. Serve web/dist first:
//   bun web/build.ts && bash web/run-tests.sh time
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { devtoolsPort } from "./test-port.mjs";
const here = dirname(fileURLToPath(import.meta.url));
const base = process.env.SB_URL ?? "http://127.0.0.1:8765/";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = (c, msg) => { console.log((c ? "ok   " : "FAIL ") + msg); if (!c) process.exitCode = 1; };
const CELL = [
  "import _time",
  "_t0 = _time.perf_counter()",
  "import time",
  "_t1 = _time.perf_counter()",
  "import datetime",
  "print(time.tzname, time.timezone, time.altzone, time.daylight)",
  "print(tuple(time.localtime(1593561600)), time.localtime(1593561600).tm_zone)",
  "print(tuple(time.localtime(0)), time.localtime(0).tm_zone, time.localtime(0).tm_gmtoff)",
  "print(time.strftime('%Z %z', time.localtime(1700000000)), time.strftime('%Z', (2020, 1, 1, 0, 0, 0, 0, 1, 1)))",
  "print(time.mktime((2020, 11, 1, 1, 30, 0, 0, 1, -1)), time.mktime((2020, 3, 8, 2, 30, 0, 0, 1, 1)))",
  "print(datetime.datetime.fromtimestamp(1604210400), datetime.datetime(2020, 7, 1, 12).astimezone())",
  // (zoneinfo over the pinned tzdata as the tzdata package: the index's zones,
  // each zone's file fetched as it is first used)
  "import zoneinfo",
  "print(len(zoneinfo.available_timezones()), [(z.utcoffset(datetime.datetime(2026, 7, 1)), z.tzname(datetime.datetime(2026, 1, 1))) for z in map(zoneinfo.ZoneInfo, ['Europe/London', 'Australia/Lord_Howe', 'America/Sao_Paulo'])])",
].join("\n");
const SHOWN = CELL.split("\n").filter((l) => l.startsWith("print")).length;

async function inZone(tz) {
  // (CPython over the same pinned files: what the page must print)
  const want = execFileSync("python3", ["-c", CELL.replace("import _time", "import time as _time")], { encoding: "utf8", env: { ...process.env, TZ: tz, TZDIR: join(here, "..", "tzdata", "zoneinfo"), PYTHONTZPATH: join(here, "..", "tzdata", "zoneinfo") } }).trim();
  let port = Number(process.env.CDP_PORT) || 0;
  const profile = mkdtempSync(join(tmpdir(), "sb-time-"));
  const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", "--disable-gpu", `--remote-debugging-port=${port}`, "--window-size=1000,700", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore", env: { ...process.env, TZ: tz } });
  try {
    if (!port) port = await devtoolsPort(profile);
    let targets;
    for (let i = 0; i < 300; i++) { try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); break; } catch { await sleep(100); } }
    const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
    await new Promise((r) => (ws.onopen = r));
    let n = 0; const waiting = new Map();
    ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result ?? m.error); waiting.delete(m.id); } };
    const send = (method, params = {}) => new Promise((r) => { const id = ++n; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
    const ev = async (expression) => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 500)); return r.result?.value; };
    const until = async (expr, ms = 60000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(expr)) return true; await sleep(100); } throw new Error("timeout: " + expr); };
    await send("Page.navigate", { url: base });
    await until("window.sagebrush && document.querySelectorAll('#cells .cell').length > 0 && sagebrush.kernel?.ready");
    ok((await ev("Intl.DateTimeFormat().resolvedOptions().timeZone")) === tz, `Chrome is in ${tz}`);
    // (a new notebook, as web/test-kernels.mjs makes one)
    const k = await ev("sagebrush.kernel.uid");
    await ev(`document.querySelector('#filebtn').click(); document.querySelector('[data-f="new"]').click(); true`);
    await until(`sagebrush.kernel.uid !== ${k} && sagebrush.kernel.ready`, 15000);
    await sleep(300);
    const run = async (code) => {
      await ev(`(() => { const nb = sagebrush.notebook; nb.setInput(nb.cells()[0], ${JSON.stringify(code)}); return true; })()`);
      await ev(`(async () => { const nb = sagebrush.notebook; await nb.run(nb.cells()[0]); return true; })()`);
      // (the output, once the run has printed its last line or an error)
      try {
        await until(`/import time took|Error|Traceback/.test(sagebrush.notebook.cells()[0].out.textContent)`, 60000);
      } catch {}
      return (await ev("sagebrush.notebook.cells()[0].el.textContent")).trim();
    };
    const all = await run(CELL + "\nprint('import time took %.0f ms' % ((_t1 - _t0) * 1000))");
    const got = all;
    const lines = (await ev("sagebrush.notebook.cells()[0].out.textContent")).trim().split("\n");
    const same = lines.slice(0, SHOWN).join("\n") === want;
    ok(same, `${tz}: the page prints CPython's output over the same zone data` + (same ? "" : `:\n${lines.join("\n")}\n--- the cell:\n${got.slice(0, 2000)}\n--- CPython:\n${want}`));
    console.log(`     ${tz}: ${lines[SHOWN] ?? "(no timing)"}` + (tz === "UTC" ? " (no zone data fetched)" : " (with the zone data's index and the zone's file fetched and checked)"));
  } finally {
    chrome.kill();
    try { rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch {}
  }
}

try {
  // (UTC first: no zone data fetched, the first import's cost without it)
  for (const tz of ["UTC", "America/New_York", "Australia/Lord_Howe"]) await inZone(tz);
} catch (e) {
  ok(false, String(e?.stack ?? e));
}
