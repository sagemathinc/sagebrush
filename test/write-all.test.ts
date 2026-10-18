import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

// writeAll (src/runtime/builtins.ts), the standard streams' write: all of the
// data, once, whatever the descriptor's writeSync does.  Each case runs in a
// child process whose fs.writeSync for fd 99 is replaced (the compiled
// runtime calls it through the module object), so that a writeAll that never
// returns fails by the timeout instead of hanging the tests.  CORR-0BE-1:
// the web build's fs shim takes all of the data and returns nothing, and in
// an embedding the page can have Node's process and SharedArrayBuffer too.
const BUILTINS = __dirname + "/../src/runtime/builtins.js";
function run(setup: string, payload = "abc"): { calls: unknown[][]; out: string } {
  const src = `
    const fs = require("fs");
    const real = fs.writeSync;
    const calls = [];
    let out = "";
    const fake = (fd, data, ...rest) => {
      if (fd !== 99) return real(fd, data, ...rest);
      calls.push([typeof data === "string" ? "string" : "bytes", ...rest]);
      ${setup}
    };
    fs.writeSync = fake;
    ${setup.includes("webShim") ? "fake.webShim = true;" : ""}
    ${setup.includes("NO_NODE") ? 'Object.defineProperty(process, "versions", { value: {} });' : ""}
    const { writeAll } = require(${JSON.stringify(BUILTINS)});
    writeAll(99, ${JSON.stringify(payload)});
    real(1, JSON.stringify({ calls, out }));`;
  return JSON.parse(execFileSync(process.execPath, ["-e", src], { timeout: 10_000, encoding: "utf8" }));
}
const whole = `out += typeof data === "string" ? data : Buffer.from(data).toString("utf8"); return undefined;`;

test("writeAll: a writeSync that returns no count wrote it all (Node's process and SharedArrayBuffer present)", () => {
  const r = run(whole);
  assert.equal(r.out, "abc");
  assert.equal(r.calls.length, 1);
});

test("writeAll: the web build's fs shim (marked webShim) gets one write of the string", () => {
  const r = run(`/* webShim */ ${whole}`);
  assert.equal(r.out, "abc");
  assert.deepEqual(r.calls, [["string"]]);
});

test("writeAll: without process.versions.node, one write of the string", () => {
  const r = run(`/* NO_NODE */ ${whole}`);
  assert.equal(r.out, "abc");
  assert.deepEqual(r.calls, [["string"]]);
});

test("writeAll: partial writes and EAGAIN resume where the last write ended", () => {
  const r = run(
    `if (calls.length === 2) { const e = new Error("EAGAIN"); e.code = "EAGAIN"; throw e; }
     const off = rest[0] ?? 0; out += Buffer.from(data).subarray(off, off + 2).toString("latin1"); return Math.min(2, data.length - off);`,
    "héllo wörld",
  );
  // (the bytes, collected as latin1 so that a cut inside a character is kept)
  assert.equal(Buffer.from(r.out, "latin1").toString("utf8"), "héllo wörld");
  // 13 bytes, 2 a write: 7 writes, and the one refused with EAGAIN
  assert.equal(r.calls.length, 8);
});
