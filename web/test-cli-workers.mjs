// The bundle's own workers, started through the launcher (the npm package's
// command): board check's interpreter, the notebook's sessions and the
// Jupyter kernel each start require.main's file, which is the launcher, in a
// worker thread, and must get the bundle there, not a program of their own.
// So: `board check` runs a board's code item (through the launcher, as `npx
// sagebrush board check` does), under Node and, when they are here, Deno and
// Bun (whose Worker has no stdout or stderr of its own); and a worker the
// launcher starts as the notebook's session or as the kernel says it is ready;
// and `sagebrush notebook` runs a cell, under each of those runtimes.
//   node web/test-cli-workers.mjs [launcher]
//   (default packages/sagebrush/bin/sagebrush.cjs, with the bundle node
//   scripts/build-cli.mjs puts beside it in dist/)
import { spawn, spawnSync } from "node:child_process";
import { request } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { freePort } from "./test-port.mjs";

const launcher = process.argv[2] ?? new URL("../packages/sagebrush/bin/sagebrush.cjs", import.meta.url).pathname;
const dir = mkdtempSync(join(tmpdir(), "sb-workers-"));
let failed = 0;
const check = (ok, what, detail = "") => {
  console.log(`${ok ? "ok" : "FAIL"} ${what}${ok || !detail ? "" : `: ${detail}`}`);
  if (!ok) failed++;
};

// board check: its code item run, and right
const board = join(dir, "t.board.json");
writeFileSync(board, JSON.stringify({
  format: "sagebrush-board", version: 1, title: "workers", layout: "graph",
  nodes: [{ id: "a", text: "Is $2^{32}+1$ prime?" }, { id: "b", code: "2**32+1" }],
  edges: [{ from: "a", to: "b" }],
}));
const has = (cmd) => spawnSync(cmd, ["--version"], { stdio: "ignore" }).status === 0;
const runtimes = [["node", [process.execPath, launcher]]];
if (has("deno")) runtimes.push(["deno", ["deno", "run", "-A", launcher]]);
if (has("bun")) runtimes.push(["bun", ["bun", launcher]]);
for (const [name, [cmd, ...args]] of runtimes) {
  const r = spawnSync(cmd, [...args, "board", "check", board, "--json"], { encoding: "utf8", timeout: 120_000 });
  let report = null;
  try { report = JSON.parse(r.stdout); } catch {}
  const item = report?.code?.items?.[0];
  check(r.status === 0 && report?.ok === true, `${name}: board check through the launcher passes`, `status ${r.status}, ${(r.stdout + r.stderr).slice(0, 300)}`);
  check(item?.status === "ok", `${name}: board check runs the code item`, JSON.stringify(item ?? null).slice(0, 300));
}

// a worker on the launcher, as the notebook's session and as the kernel: ready
const ready = (workerData) => new Promise((resolve) => {
  const w = new Worker(launcher, { workerData, stdout: true, stderr: true });
  w.stdout.resume();
  w.stderr.resume();
  const done = (v) => { clearTimeout(t); void w.terminate(); resolve(v); };
  const t = setTimeout(() => done("no message in 60 s"), 60_000);
  w.on("message", (m) => { if (m?.ready) done(true); });
  w.on("error", (e) => done(String(e?.message ?? e)));
  w.on("exit", (code) => done(`exited (${code})`));
});
const nb = await ready({ sagebrushNotebook: { dir } });
check(nb === true, "a notebook session on the launcher starts", String(nb));
const kernel = await ready({ sagebrushKernel: "python" });
check(kernel === true, "the kernel on the launcher starts", String(kernel));

// `sagebrush notebook` through the launcher, end to end as its page does it:
// a session's events, then a Sage cell `2+3` sent to it, whose result is 5
const notebookRuns = (cmd, args, port) => new Promise((resolve) => {
  const p = spawn(cmd, [...args, "notebook", dir, "--port", String(port), "--no-browser"], { stdio: ["ignore", "pipe", "pipe"] });
  let out = "", err = "", events = null, settled = false;
  const done = (v) => {
    if (settled) return;
    settled = true;
    clearTimeout(t);
    events?.destroy();
    p.kill();
    resolve(v);
  };
  const t = setTimeout(() => done(`no result in 90 s; server said: ${(out + err).slice(0, 300)}`), 90_000);
  p.stderr.on("data", (b) => { err += b; });
  p.on("exit", (code) => done(`the server exited (${code}): ${(out + err).slice(0, 300)}`));
  p.stdout.on("data", async (b) => {
    out += b;
    const m = /http:\/\/127\.0\.0\.1:(\d+)\/\?token=([0-9a-f]+)/.exec(out);
    if (!m || events) return;
    const [, port, token] = m;
    events = {};
    try {
      // the token for the cookie, as the browser trades it
      const first = await fetch(`http://127.0.0.1:${port}/?token=${token}`, { redirect: "manual" });
      const cookie = (first.headers.get("set-cookie") ?? "").split(";")[0];
      const base = `http://127.0.0.1:${port}/nb/t.ipynb/api/session/s1`;
      let text = "";
      events = request(`${base}/events`, { headers: { cookie } }, (res) => {
        res.setEncoding("utf8");
        res.on("data", (d) => {
          text += d;
          for (const line of text.split("\n")) {
            if (!line.startsWith("data: ")) continue;
            const msg = JSON.parse(line.slice(6));
            if (msg.id === 1 && msg.done) done(/\b5\b/.test(text) ? true : `the cell finished without 5: ${text.slice(0, 300)}`);
          }
        });
      });
      events.end();
      await fetch(`${base}/send`, { method: "POST", headers: { cookie }, body: JSON.stringify({ id: 1, code: "2+3", sage: true }) });
    } catch (e) {
      done(String(e?.message ?? e));
    }
  });
});
for (const [name, [cmd, ...args]] of runtimes) {
  const r = await notebookRuns(cmd, args, await freePort());
  check(r === true, `${name}: a notebook cell through the launcher runs (2+3 is 5)`, String(r));
}

if (failed) {
  console.log(`${failed} failed`);
  process.exit(1);
}
console.log("all passed");
