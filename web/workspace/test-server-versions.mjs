// ci: none (not run by CI before test discovery, Nov 2 2026: a wiring candidate)
// A data file's versions on the sync server in its preview (version-history note r1, PR 1's page side:
// web/workspace/server-versions.ts), in headless Chromium against the built site, the server's two routes stood in by
// web/serve.py's overrides: GET /api/sync/v1/versions?fid= and GET /api/sync/v1/blob/<sha256>.  Listed below the
// device's own versions (the file's bytes now not); Restore writes a version's bytes, checked, over the file shown,
// keeping what it had as a version (undoable); bytes that aren't the version's are refused and change nothing; with no
// answer from the server, nothing is listed.
//   bun web/build.ts, then node web/workspace/test-server-versions.mjs
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { devtoolsPort } from "../test-port.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = mkdtempSync(join(tmpdir(), "sb-server-versions-"));
const overrides = join(tmp, "overrides.json");
writeFileSync(overrides, "{}");
const sha = (b) => createHash("sha256").update(b).digest("hex");
const serve = spawn("python3", [join(here, "..", "serve.py"), "0"], { stdio: ["ignore", "pipe", "inherit"], env: { ...process.env, SB_SERVE_OVERRIDES: overrides } });
const port = await new Promise((r) => serve.stdout.once("data", (d) => r(Number(String(d).trim().split(/\s+/).pop()))));
const base = `http://127.0.0.1:${port}/`;
const profile = join(tmp, "profile");
const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", "--password-store=basic", "--remote-debugging-port=0", "--window-size=1280,800", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
const cdp = await devtoolsPort(profile);
let targets;
for (let i = 0; i < 300; i++) { try { targets = await (await fetch(`http://127.0.0.1:${cdp}/json`)).json(); break; } catch { await sleep(100); } }
const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let n = 0; const waiting = new Map(); const errors = [];
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result ?? m.error); waiting.delete(m.id); }
  if (m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails?.exception?.description ?? JSON.stringify(m.params.exceptionDetails));
};
const send = (method, params = {}) => new Promise((r) => { const id = ++n; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (expression) => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 500)); return r.result.value; };
const until = async (expr, ms = 20000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(expr).catch(() => false)) return true; await sleep(150); } return false; };
const fails = [];
let checks = 0;
const check = (ok, what) => { checks++; console.log((ok ? "ok   " : "FAIL ") + what); if (!ok) fails.push(what); };
const W = "window.sagebrush?.workspace";
const P = "document.querySelector('.sbfprev')";
const text = (p) => ev(`${W}.read(${JSON.stringify(p)}).then((r) => new TextDecoder().decode(r.content))`);
const row = (p) => `document.querySelector('#wssidebar .frow[data-path=${JSON.stringify(p)}]')`;
const openPreview = async (p) => {
  await ev(`(() => { document.querySelector(".sbfprev .ph .x")?.click(); return 1; })()`);
  if (await ev(`document.querySelector('#wssidebar').hidden`)) await ev(`(document.querySelector("#wsfilesbtn").click(), 1)`);
  await until(`!!${row("/d")}`);
  if (!(await ev(`!!${row(p)}`))) await ev(`(${row("/d")}.click(), 1)`);
  await until(`!!${row(p)}`);
  await ev(`(${row(p)}.click(), 1)`);
  return until(`!!${P}`);
};
const NL = String.fromCharCode(10);
const NOW = "now: v3" + NL, OLD = "first: v1" + NL;
try {
  for (const m of ["Page.enable", "Runtime.enable"]) await send(m);
  await send("Page.navigate", { url: base });
  await until(`!!${W}`, 60000);
  await until(`!!document.querySelector("#wsfilesbtn") && !document.querySelector("#wsfilesbtn").hidden`, 60000);
  await ev(`(async () => { await ${W}.create("/d/data.csv", { content: ${JSON.stringify(NOW)} }); return 1; })()`);
  const e = await ev(`${W}.stat("/d/data.csv")`);
  check(/^[0-9a-f]{16}$/.test(e?.fid ?? "") && e.sha256 === sha(NOW), "(the file, its fid and its SHA-256: " + JSON.stringify([e?.fid, e?.sha256]) + ")");
  const oldFile = join(tmp, "old.bin"), badFile = join(tmp, "bad.bin"), list = join(tmp, "versions.json");
  writeFileSync(oldFile, OLD);
  writeFileSync(badFile, "not the version's bytes");
  const BAD = sha("what the version claimed");
  writeFileSync(list, JSON.stringify({ versions: [
    { sha256: sha(NOW), size: NOW.length, t: Date.now(), by: "person", seq: 3, path: "/d/data.csv" },
    { sha256: BAD, size: 24, t: Date.now() - 1800e3, by: "agent:robot", seq: 2, path: "/d/data.csv" },
    { sha256: sha(OLD), size: OLD.length, t: Date.now() - 3600e3, by: "person", seq: 1, path: "/d/data.csv" },
  ] }));
  writeFileSync(overrides, JSON.stringify({
    [`/api/sync/v1/versions?fid=${e.fid}`]: { file: list },
    [`/api/sync/v1/blob/${sha(OLD)}`]: { file: oldFile },
    [`/api/sync/v1/blob/${BAD}`]: { file: badFile },
  }));
  check(await openPreview("/d/data.csv"), "the file's preview opens");
  check(await until(`${P}.querySelector(".server-versions h3")?.textContent === "On the server (2)"`), "its server versions are listed below its own, the file's bytes now left out: " + (await ev(`${P}.querySelector(".server-versions")?.textContent ?? "(none)"`)));
  const rows = await ev(`[...${P}.querySelectorAll(".server-versions .vr")].map((r) => [r.dataset.sha256, r.querySelector("span").textContent])`);
  check(rows.length === 2 && rows[0][0] === BAD && rows[1][0] === sha(OLD) && rows[0][1].includes("an agent (robot)") && rows[1][1].includes(" you "), "…newest first, saying when, by whom and how large: " + JSON.stringify(rows));
  // bytes that aren't the version's: refused, nothing written
  await ev(`([...${P}.querySelectorAll(".server-versions .vr")][0].querySelectorAll("button")[1].click(), 1)`);
  check(await until(`document.body.textContent.includes("aren't that version's")`), "Restore of a version whose bytes don't match it: refused in words");
  check((await text("/d/data.csv")) === NOW && (await ev(`${W}.history("/d/data.csv").then((h) => h.length)`)) === 0, "…and the file is as it was, with no version made");
  // a version's bytes, checked: restored over the file shown, what it had kept as a version
  await openPreview("/d/data.csv");
  await until(`${P}.querySelectorAll(".server-versions .vr").length === 2`);
  await ev(`([...${P}.querySelectorAll(".server-versions .vr")][1].querySelectorAll("button")[1].click(), 1)`);
  check(await until(`${W}.read("/d/data.csv").then((r) => new TextDecoder().decode(r.content) === ${JSON.stringify(OLD)})`), "Restore of the oldest: the file has its bytes");
  check((await ev(`${W}.history("/d/data.csv").then((h) => h.length)`)) === 1 && (await ev(`${W}.history("/d/data.csv").then((h) => h[0].size)`)) === NOW.length, "…and what it had is kept as a version: the restore can be undone");
  // no answer from the server: nothing listed
  writeFileSync(overrides, "{}");
  await openPreview("/d/data.csv");
  await sleep(1500);
  check(!(await ev(`!!${P}.querySelector(".server-versions")`)), "with no answer from the server (sync off, offline): nothing is listed");
  check(errors.length === 0, "no exceptions in the page: " + errors.slice(0, 3).join(" | "));
} catch (err) {
  check(false, "threw: " + String(err?.stack ?? err).slice(0, 800));
} finally {
  chrome.kill(); serve.kill();
  rmSync(tmp, { recursive: true, force: true });
}
console.log(`${checks - fails.length}/${checks} checks passed`);
process.exit(fails.length ? 1 : 0);
