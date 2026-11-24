// ci: checks.3 order=141
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { once } from "node:events";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deadline, waitFor, WAIT_MS, TestTimeout } from "../web/test-deadline.mjs";
import { until } from "../web/test-broker-lib.mjs";
import { waitForPort } from "./wait-for-port.mjs";

assert.equal(WAIT_MS, 30000);
assert.equal(await deadline("evaluate", "2 + 2", () => 4), 4);
let signal;
const start = performance.now();
await assert.rejects(deadline("evaluate", "never settles", (s) => { signal = s; return new Promise(() => {}); }, 30),
  e => e instanceof TestTimeout && /evaluate\(never settles\) timed out after [\d.]+ s/.test(e.message));
assert(signal.aborted);
assert(performance.now() - start < 1000);
await assert.rejects(deadline("bad", "budget", () => 1, Infinity), /finite and positive/);
let polls = 0;
assert.equal(await waitFor("waitFor", "bar visible", () => ++polls === 2, 500), true);
await assert.rejects(waitFor("waitFor", "bar visible", () => false, 30), /waitFor\(bar visible\) timed out/);
await assert.rejects(until(() => new Promise(() => {}), 30, "hung evaluation"), /broker.until\(hung evaluation\) timed out/);
// An explicitly longer legitimate operation succeeds.
assert.equal(await deadline("evaluate", "slow but legitimate", () => new Promise(r => setTimeout(() => r(7), 60)), 250), 7);

const server = createServer();
server.listen(0, "127.0.0.1"); await once(server, "listening");
const port = server.address().port;
await waitForPort(port, 500);
await new Promise(r => server.close(r));
await assert.rejects(waitForPort(port, 40), /waitForPort\(127.0.0.1:\d+ listening\) timed out/);
const delayed = createServer();
const listening = setTimeout(() => delayed.listen(port, "127.0.0.1"), 80);
try { await waitForPort(port, 1000); }
finally { clearTimeout(listening); await new Promise(r => delayed.close(r)); }

const dir = mkdtempSync(join(tmpdir(), "test-deadlines-"));
try {
  const file = join(dir, "probe.test.mjs");
  const run = source => {
    writeFileSync(file, 'import {test} from "node:test";\n' + source);
    return spawnSync(process.execPath, ["--test", "--test-timeout=100", file], { encoding: "utf8", timeout: 3000 });
  };
  const hung = run('test("named hung test", async () => { await new Promise(r => setTimeout(r, 2000)); });');
  assert.notEqual(hung.status, 0);
  assert.match(hung.stdout, /named hung test/);
  assert.match(hung.stdout, /timed out|testTimeoutFailure/);
  const longer = run('test("legitimate longer test", {timeout:500}, async () => { await new Promise(r => setTimeout(r, 150)); });');
  assert.equal(longer.status, 0, longer.stdout + longer.stderr);
} finally { rmSync(dir, { recursive: true, force: true }); }

const ci = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
for (const line of ci.split("\n").filter(l => l.includes("node --test "))) assert(line.includes("--test-timeout=300000"), line);
const servers = [...ci.matchAll(/python3 web\/serve\.py 8765 &[\s\S]*?kill -0 "\$server_pid"/g)];
assert.equal(servers.length, 9);
for (const [block] of servers) {
  assert(block.indexOf("trap cleanup_server EXIT") < block.indexOf("node scripts/wait-for-port.mjs 8765"));
  assert(block.includes("node scripts/wait-for-port.mjs 8765"));
  assert(!block.includes("sleep 1"));
}
console.log("test-test-timeouts: deadlines, hung polls, readiness, node per-test override and CI wiring pass");
