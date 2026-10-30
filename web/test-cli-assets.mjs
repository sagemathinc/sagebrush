// The CLI bundle's notebook server (`sagebrush notebook`) serves every file
// the page loads: the scripts it references (found in the page itself, so a
// new one cannot be forgotten), KaTeX and the notices, at the top and under
// /nb/<notebook>/.  The app-only files the page names (APP_ONLY) are the
// other way round: the CLI must answer 404 for them, so it can't start
// serving one silently.  No browser needed.
//   node web/test-cli-assets.mjs [bundle]      (default build/cli/pyjs.cjs)
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freePort } from "./test-port.mjs";

const bundle = process.argv[2] ?? new URL("../build/cli/pyjs.cjs", import.meta.url).pathname;
const dir = mkdtempSync(join(tmpdir(), "sb-assets-"));
const port = await freePort(); // (test-port.mjs: several runs share a machine)
const server = spawn(process.execPath, [bundle, "notebook", dir, "--port", String(port), "--no-browser"], { stdio: ["ignore", "pipe", "inherit"] });
let printed = "";
server.stdout.on("data", (d) => (printed += d));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (let i = 0; i < 100 && !/token=/.test(printed); i++) await sleep(100);
let fail = 0;
// (named by the page but deliberately not served by the CLI: the app
// self-test's COI diagnosis, loaded by selftest() only under
// SAGEBRUSH_APP_SELFTEST, web/notebook/selftest-diagnose.js)
const APP_ONLY = ["sagebrush-selftest.js"];
const verdict = (name, status) => (APP_ONLY.includes(name) ? status === 404 : status === 200);
// (the verdict's own control: an app-only file served, or a page file
// missing, must fail)
for (const [n, s, want] of [["sagebrush-selftest.js", 404, true], ["sagebrush-selftest.js", 200, false], ["sagebrush-history.js", 200, true], ["sagebrush-history.js", 404, false]]) {
  if (verdict(n, s) !== want) { fail++; console.log(`FAIL the verdict's control: ${n} ${s}`); }
}
try {
  const token = /token=(\w+)/.exec(printed)?.[1];
  if (!token) throw new Error("the server printed no URL with a token: " + printed);
  const base = `http://127.0.0.1:${port}`;
  const get = (p) => fetch(base + p, { headers: { Cookie: `sagebrush_token=${token}` }, redirect: "manual" });
  const page = await (await get("/nb/probe.ipynb/")).text();
  if (!/<html/i.test(page)) throw new Error("no notebook page: " + page.slice(0, 200));
  // every sagebrush-*.js the page names, KaTeX's stylesheet, the notices
  const names = [...new Set(page.match(/sagebrush-[a-z0-9]+\.js\b/g) ?? [])].filter((n) => !["sagebrush-worker.js", "sagebrush-notebook.js"].includes(n));
  // (each app-only file must be one the page names: otherwise its 404 proves nothing)
  for (const n of APP_ONLY) {
    const named = names.includes(n);
    if (!named) fail++;
    console.log((named ? "ok   " : "FAIL ") + `the page names the app-only ${n}`);
  }
  // (and the files it fetches: the documentation search index)
  for (const f of [...names, "katex/katex.min.css", "THIRD-PARTY-NOTICES.txt", ...new Set(page.match(/fetch\("([\w.-]+\.json)"\)/g)?.map((m) => /"(.+)"/.exec(m)[1]) ?? [])]) {
    for (const p of [`/${f}`, `/nb/probe.ipynb/${f}`]) {
      const r = await get(p);
      const ok = verdict(f, r.status);
      if (!ok) fail++;
      console.log((ok ? "ok   " : "FAIL ") + p + " " + r.status + (APP_ONLY.includes(f) ? " (app-only: must be 404)" : ""));
    }
  }
  // a directory named like a notebook gets an answer (not a pending request)
  const { mkdirSync } = await import("node:fs");
  mkdirSync(join(dir, "folder.ipynb"));
  const r = await Promise.race([get("/api/file?path=folder.ipynb"), sleep(5000).then(() => null)]);
  const okDir = r !== null && r.status >= 400;
  if (!okDir) fail++;
  console.log((okDir ? "ok   " : "FAIL ") + "a directory named folder.ipynb " + (r ? r.status : "no response"));
} catch (e) {
  console.log("FAIL " + e.message);
  fail++;
} finally {
  server.kill();
}
// `sagebrush board open`'s page, from the bundle's own copy (src/board-open.ts): the frame's page, marked as
// this computer's, with the policy the site serves the frame with, and the file's text by the page's key
{
  const { writeFileSync } = await import("node:fs");
  const file = join(dir, "probe.board.json"), text = JSON.stringify({ format: "sagebrush-board", version: 1, title: "Probe", nodes: [{ id: "a", text: "hello" }] });
  writeFileSync(file, text);
  const bport = await freePort();
  const b = spawn(process.execPath, [bundle, "board", "open", file, "--port", String(bport), "--no-browser"], { stdio: ["ignore", "pipe", "inherit"] });
  let out = "";
  b.stdout.on("data", (d) => (out += d));
  for (let i = 0; i < 100 && !/token=/.test(out); i++) await sleep(100);
  const check = (cond, name) => { if (!cond) fail++; console.log((cond ? "ok   " : "FAIL ") + name); };
  try {
    const m = /http:\/\/127\.0\.0\.1:(\d+)\/\?token=(\w+)/.exec(out);
    check(!!m, "board open: prints its URL");
    const r = await fetch(`http://127.0.0.1:${m[1]}/`, { headers: { Cookie: `sagebrush_board_${m[1]}=${m[2]}` } });
    const page = await r.text(), csp = r.headers.get("content-security-policy") ?? "";
    check(r.status === 200 && page.includes('data-sb-from="local"') && page.includes('id="sb-local"'), "board open: its page, from the bundle");
    check(/\bsandbox allow-scripts\b/.test(csp) && /frame-ancestors 'none'/.test(csp), "board open: the frame's policy, sandboxed, not framed");
    check(page.includes('"engineSite":"https://sagebrush.space/"'), "board open: away from a checkout's built engine, the page's engine comes from sagebrush.space");
    const key = JSON.parse(/id="sb-local">(\{.*?\})<\/script>/.exec(page)[1]).key;
    check((await (await fetch(`http://127.0.0.1:${m[1]}/board?key=${key}`)).text()) === text, "board open: the file's text, by the page's key");
  } catch (e) {
    check(false, "board open: " + e.message);
  } finally {
    b.kill();
  }
}
console.log(fail ? `${fail} failures` : "every asset served");
process.exit(fail ? 1 : 0);
