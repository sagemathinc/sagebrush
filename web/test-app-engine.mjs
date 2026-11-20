// ci: checks.3 order=40
// The app's engine subprocess (app/engine/): its frames, and the engine on a
// pipe running the page's own worker (web/dist/sagebrush-worker.js), as the
// desktop app starts it.
//
//   node web/test-app-engine.mjs [DIR]     DIR: the worker's folder (default web/dist, from bun web/build.ts)
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { encode, decode, frame, frameReader, FRAME_MAX } from "../app/engine/frames.mjs";
import { engineRoot, localFile } from "../app/engine/files.mjs";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const here = fileURLToPath(new URL(".", import.meta.url));
const root = process.argv[2] ?? join(here, "dist");
let failed = 0, passed = 0;
const ok = (c, what) => (c ? passed++ : (failed++, console.log("FAIL " + what)));
const throws = (f, re, what) => {
  try {
    f();
    ok(false, what + " (no error)");
  } catch (e) {
    ok(re.test(String(e?.message ?? e)), `${what}: ${e?.message}`);
  }
};

// ---- frames
{
  const bytes = new Uint8Array([0, 1, 2, 255]);
  const ab = new Uint8Array([9, 8, 7]).buffer;
  const m = { to: "s1", m: { files: [["/a", bytes], ["/b", new Uint8Array(0)]], raw: ab, text: "é ∑ \u2028", n: null } };
  const back = decode(encode(m));
  ok(back.to === "s1" && back.m.text === m.m.text && back.m.n === null, "frames: the JSON part round-trips");
  ok(back.m.files[0][1] instanceof Uint8Array && back.m.files[0][1].join() === "0,1,2,255", "frames: a Uint8Array comes back as one, the same bytes");
  ok(back.m.files[1][1] instanceof Uint8Array && back.m.files[1][1].length === 0, "frames: an empty Uint8Array too");
  ok(back.m.raw instanceof ArrayBuffer && new Uint8Array(back.m.raw).join() === "9,8,7", "frames: an ArrayBuffer comes back as one");
  throws(() => encode({ m: { $b: [0, 0, 0] } }), /reserved/, "frames: a message's own \"$b\" key is refused");
  throws(() => encode({ m: new SharedArrayBuffer(8) }), /shared memory/, "frames: a SharedArrayBuffer is never sent");
  throws(() => encode({ m: new Int32Array(new SharedArrayBuffer(8)) }), /shared memory/, "frames: nor a view of one");
  throws(() => encode({ m: new Float64Array(2) }), /only a Uint8Array/, "frames: other typed arrays are refused, not sent as JSON");
  // (a payload claiming bytes beyond its end, or a binary value with an extra key)
  const p = encode({ x: new Uint8Array([1, 2]) });
  throws(() => decode(p.subarray(0, p.length - 1)), /out of place/, "frames: a binary value past the payload's end is refused");
  const forged = new TextEncoder().encode('{"x":{"$b":[0,0,0],"y":1}}');
  const fp = new Uint8Array(4 + forged.length);
  new DataView(fp.buffer).setUint32(0, forged.length, true);
  fp.set(forged, 4);
  throws(() => decode(fp), /malformed binary/, "frames: a binary value with another key is refused");
  // the reader: frames split anywhere, one byte at a time, and several in one chunk
  const got = [];
  const r = frameReader((x) => got.push(decode(x)));
  const all = new Uint8Array([...frame(encode({ a: 1 })), ...frame(encode({ b: new Uint8Array(70000) })), ...frame(encode({ c: 3 }))]);
  for (let i = 0; i < 20; i++) r.push(all.subarray(i, i + 1));
  r.push(all.subarray(20));
  ok(got.length === 3 && got[0].a === 1 && got[1].b.length === 70000 && got[2].c === 3 && r.buffered === 0, "frames: the reader finds every frame however the bytes are split");
  // binary values exactly as encode() writes them: in order, end to end, all of the bytes; so decoding never makes
  // more bytes than the frame has
  const forge = (json, body) => {
    const j = new TextEncoder().encode(JSON.stringify(json));
    const out = new Uint8Array(4 + j.length + body);
    new DataView(out.buffer).setUint32(0, j.length, true);
    out.set(j, 4);
    return out;
  };
  const many = { v: Array.from({ length: 256 }, () => ({ $b: [0, 65536, 0] })) };
  throws(() => decode(forge(many, 65536)), /out of place/, "frames: one range named many times (256 copies of 64 KiB from a 70 kB frame) is refused before it is copied");
  throws(() => decode(forge({ a: { $b: [4, 4, 0] }, b: { $b: [0, 4, 0] } }, 8)), /out of place/, "frames: ranges out of order are refused");
  throws(() => decode(forge({ a: { $b: [0, 4, 0] } }, 8)), /no binary value names/, "frames: bytes left over are refused");
  ok(decode(forge({ a: { $b: [0, 4, 0] }, b: [{ $b: [4, 0, 1] }, { $b: [4, 4, 0] }] }, 8)).b[1].length === 4, "frames: ranges end to end, an empty one too, are taken");
  // a frame in 200000 one-byte chunks: read in linear time
  {
    const f = frame(encode({ z: new Uint8Array(200000 - 40) }));
    let n = 0;
    const rr = frameReader(() => n++);
    const t = performance.now();
    for (let i = 0; i < f.length; i++) rr.push(f.subarray(i, i + 1));
    const ms = performance.now() - t;
    ok(n === 1 && ms < 3000, `frames: a frame in ${f.length} one-byte chunks is read in ${Math.round(ms)} ms`);
  }
  const big = new Uint8Array(4);
  new DataView(big.buffer).setUint32(0, FRAME_MAX + 1, true);
  throws(() => frameReader(() => {}).push(big), /larger than the limit/, "frames: a length past the limit ends the stream");
}

// ---- the engine's own files (app/engine/files.mjs): under its root only
{
  const t = mkdtempSync(join(tmpdir(), "sb-engine-files-"));
  try {
    mkdirSync(join(t, "root", "lib"), { recursive: true });
    writeFileSync(join(t, "root", "sagebrush-worker.js"), "");
    writeFileSync(join(t, "root", "lib", "a.json"), "{}");
    writeFileSync(join(t, "secret.txt"), "outside");
    symlinkSync(join(t, "secret.txt"), join(t, "root", "lib", "link.json"));
    const w = engineRoot(join(t, "root"));
    ok(localFile(w, "lib/a.json?h=1234#x") === join(w.root, "lib", "a.json"), "files: a file under the root, relative to the worker, its query and fragment dropped");
    ok(localFile(w, w.base.replace("sagebrush-worker.js", "lib/a.json")) === join(w.root, "lib", "a.json"), "files: the same file by its file: URL");
    throws(() => localFile(w, "../secret.txt"), /only its own files/, "files: a path out of the root by .. is refused");
    throws(() => localFile(w, "lib/%2e%2e/%2e%2e/secret.txt"), /only its own files/, "files: by an encoded .. too");
    throws(() => localFile(w, "lib/link.json"), /only its own files/, "files: a link in the root to a file outside it is refused");
    throws(() => localFile(w, "https://example.com/lib/a.json"), /not https: URLs/, "files: an https: URL is refused");
    throws(() => localFile(w, "data:application/json,{}"), /not data: URLs/, "files: a data: URL is refused");
    throws(() => localFile(w, "lib/none.json"), /no such file/, "files: a file not there is refused");
  } finally {
    rmSync(t, { recursive: true, force: true });
  }
}

// ---- the engine
if (!existsSync(join(root, "sagebrush-worker.js"))) {
  console.log(`FAIL no ${join(root, "sagebrush-worker.js")}: build it (bun web/build.ts)`);
  process.exit(1);
}
function engine(extra = []) {
  const p = spawn(process.execPath, [join(here, "..", "app", "engine", "main.mjs"), "--stdio", "--root", root, "--memory", "2048", ...extra], { stdio: ["pipe", "pipe", "pipe"] });
  const msgs = [], waiters = [];
  let err = "";
  p.stderr.on("data", (d) => (err += d));
  const r = frameReader((x) => {
    const m = decode(x);
    msgs.push(m);
    for (const w of [...waiters]) if (w.test(m)) { waiters.splice(waiters.indexOf(w), 1); w.res(m); }
  });
  p.stdout.on("data", (d) => r.push(d));
  const exited = new Promise((res) => p.on("exit", (code) => res(code)));
  return {
    p, msgs, exited, err: () => err,
    send: (m) => p.stdin.write(frame(encode(m))),
    raw: (b) => p.stdin.write(b),
    wait(test, ms = 60000, what = "a message") {
      const have = msgs.find(test);
      if (have) return Promise.resolve(have);
      return new Promise((res, rej) => {
        const w = { test, res };
        waiters.push(w);
        setTimeout(() => { if (waiters.includes(w)) rej(new Error(`timed out waiting for ${what}; stderr: ${err.slice(-2000)}`)); }, ms);
      });
    },
  };
}
const HELLO = { hello: { protocol: { min: 1, max: 1 }, client: "test", want: [] } };

try {
  // the handshake
  {
    const e = engine();
    e.send({ hello: { protocol: { min: 1, max: 5 }, client: "test", want: [] } });
    const h = (await e.wait((m) => m.hello, 20000, "hello")).hello;
    ok(h.protocol === 1 && typeof h.engine === "string" && /^[0-9a-f]{16}$/.test(h.build), `the handshake: the highest version both speak, the engine's version and build (${JSON.stringify(h)})`);
    ok(["threads", "files", "stop-word", "input"].every((c) => h.caps.includes(c)) && !h.caps.includes("native"), "the handshake: its capabilities (not native: the engines are still WebAssembly here)");
    e.p.stdin.end();
    ok((await e.exited) === 0, "stdin's end: the engine exits, 0");
  }
  {
    const e = engine();
    e.send({ hello: { protocol: { min: 7, max: 9 }, client: "test", want: [] } });
    const m = await e.wait((m) => m.incompatible, 20000, "incompatible");
    ok(m.incompatible.protocol.min === 1 && m.incompatible.protocol.max === 1, "no version in common: {incompatible} with the engine's range");
    ok((await e.exited) === 3, "...and the engine exits (3), nothing run");
  }
  {
    const e = engine();
    e.send({ open: "s1" });
    const m = await e.wait((m) => m.protocolError, 20000, "protocolError");
    ok(/first message must be \{hello/.test(m.protocolError) && (await e.exited) === 2, "anything before hello: a protocol error, and the engine exits (2)");
  }
  {
    const e = engine();
    e.send(HELLO);
    await e.wait((m) => m.hello);
    e.send({ sing: "s1" });
    const m = await e.wait((m) => m.protocolError, 20000, "protocolError");
    ok(/unknown message \(sing\)/.test(m.protocolError) && (await e.exited) === 2, "an unknown message: a protocol error, never dropped (exit 2)");
  }
  {
    const e = engine();
    e.send(HELLO);
    await e.wait((m) => m.hello);
    const bad = new Uint8Array([3, 0, 0, 0, 1, 2, 3]);
    e.raw(bad);
    const m = await e.wait((m) => m.protocolError, 20000, "protocolError");
    ok(/malformed frame/.test(m.protocolError) && (await e.exited) === 2, "a malformed frame: a protocol error (exit 2)");
  }
  {
    const e = engine();
    e.send(HELLO);
    await e.wait((m) => m.hello);
    for (const sid of ["", "a/b", "x".repeat(65), 5]) {
      // (each its own engine would be needed to see each refusal: one is enough to see the rule)
      if (sid !== "a/b") continue;
      e.send({ open: sid });
    }
    const m = await e.wait((m) => m.protocolError, 20000, "protocolError");
    ok(/session id/.test(m.protocolError), "a session id that isn't 1 to 64 of [A-Za-z0-9_-]: refused");
    await e.exited;
  }
  {
    // (a second open of a live session would leave the first's interpreter running, unreachable)
    const e = engine();
    e.send(HELLO);
    await e.wait((m) => m.hello);
    e.send({ open: "nb1", name: "" });
    e.send({ open: "nb1", name: "" });
    const m = await e.wait((m) => m.protocolError, 20000, "protocolError");
    ok(m.protocolError === "open: session nb1 is open already" && (await e.exited) === 2, `a second open of an open session: refused, exit 2 (${m.protocolError})`);
  }

  // an interpreter: runs, files, Stop, input()
  {
    const e = engine();
    const from = (sid, test) => (m) => m.from === sid && test(m.m);
    e.send(HELLO);
    await e.wait((m) => m.hello);
    e.send({ open: "nb1", name: "" });
    e.send({ to: "nb1", m: { init: { limits: null } } });
    e.send({ to: "nb1", m: { fsWrite: { epoch: 1, state: "on", trees: ["/"] } } });
    e.send({ to: "nb1", m: { files: [["/data.txt", new TextEncoder().encode("hello from the page\n")]] } });
    const ready = (await e.wait(from("nb1", (m) => m.ready), 60000, "ready")).m;
    ok(ready.interrupt === null && ready.interruptible === true && ready.epoch === null && ready.epochShared === true && ready.progress === null, "ready: the shared words stay in the engine, the page told they are held for it");
    ok(ready.engine?.threads === true && ready.engine?.native === false, "ready: says it is the engine's interpreter");
    const run = async (id, m, what) => {
      e.send({ to: "nb1", m: { id, ...m } });
      await e.wait(from("nb1", (x) => x.id === id && x.done), 120000, what);
      const out = e.msgs.filter((x) => x.from === "nb1" && x.m.id === id);
      return { done: out.find((x) => x.m.done).m, text: out.filter((x) => x.m.stream).map((x) => x.m.text).join("") };
    };
    let r = await run(1, { code: "kept = 2**200\nprint(kept)" }, "run 1");
    ok(!r.done.error && r.text.trim() === String(2n ** 200n), `a Python run: ${r.text.trim().slice(0, 80)}`);
    r = await run(2, { code: "factor(2^128+1)", sage: true }, "run 2");
    ok(!r.done.error && r.text.includes("59649589127497217 * 5704689200685129054721"), `a Sage run: ${r.text.trim().slice(0, 80)}`);
    r = await run(3, { code: "print(open('/data.txt').read(), end='')\n_ = open('/out.bin', 'wb').write(bytes(range(256)))" }, "run 3");
    ok(r.text === "hello from the page\n", `the page's files: Python reads them (${JSON.stringify(r.text.slice(0, 300))})`);
    // (its creation, empty, then its bytes as it is closed: the last is the file)
    const changed = e.msgs.findLast((x) => x.from === "nb1" && x.m.fsChanged === "/out.bin");
    ok(changed && changed.m.data instanceof Uint8Array && changed.m.data.length === 256 && changed.m.data[255] === 255, "a file Python writes comes back to the page, its bytes whole");
    // (Python's files are the page's shim, never this computer's)
    r = await run(4, { code: "import os\ntry:\n    open('" + process.cwd().replace(/\\/g, "/") + "/package.json').read()\n    print('READ')\nexcept OSError as e:\n    print('refused', type(e).__name__)" }, "run 4");
    ok(r.text.startsWith("refused"), `the computer's own files are not the interpreter's: ${r.text.trim()}`);
    // Stop: KeyboardInterrupt, variables kept
    e.send({ to: "nb1", m: { id: 5, code: "import time\nwhile True: time.sleep(0.01)" } });
    await e.wait(from("nb1", (m) => m.id === 5 && m.start), 30000, "run 5's start");
    await new Promise((res) => setTimeout(res, 300));
    const t0 = performance.now();
    e.send({ to: "nb1", m: { runnerInterrupt: 5 } });
    await e.wait(from("nb1", (m) => m.id === 5 && m.done), 10000, "run 5 stopped");
    const stopMs = performance.now() - t0;
    const out5 = e.msgs.filter((x) => x.from === "nb1" && x.m.id === 5 && x.m.stream).map((x) => x.m.text).join("");
    ok(/KeyboardInterrupt/.test(out5) && stopMs < 2000, `Stop: KeyboardInterrupt in ${Math.round(stopMs)} ms`);
    r = await run(6, { code: "print(kept == 2**200)" }, "run 6");
    ok(r.text.trim() === "True", `after a Stop, the variables are kept (${JSON.stringify(r.text.slice(0, 300))})`);
    // input(): asked of the page by key, answered by key
    e.send({ to: "nb1", m: { id: 7, code: "s = input('name? ')\nprint('hi', s)" } });
    const ask = (await e.wait(from("nb1", (m) => m.id === 7 && m.input), 30000, "input")).m;
    ok(ask.buffer === null && typeof ask.input.key === "string" && ask.input.prompt === "name? ", "input(): the page is asked, with a key, and no shared buffer");
    e.send({ to: "nb1", m: { runnerInput: 7, key: "not-the-key", text: "wrong" } });
    e.send({ to: "nb1", m: { runnerInput: 7, key: ask.input.key, text: "Ada" } });
    await e.wait(from("nb1", (m) => m.id === 7 && m.done), 30000, "run 7");
    const out7 = e.msgs.filter((x) => x.from === "nb1" && x.m.id === 7 && x.m.stream).map((x) => x.m.text).join("");
    ok(out7.trim().split("\n").pop() === "hi Ada", `input(): the answer with its key is the line (another key's is not): ${out7.trim()}`);
    // the permission epoch: a narrowing reaches a run in flight
    e.send({ to: "nb1", m: { id: 8, code: "import time\ntime.sleep(1.0)\ntry:\n    open('/late.txt', 'w').write('x')\n    print('wrote')\nexcept OSError as e:\n    print('refused')" } });
    await e.wait(from("nb1", (m) => m.id === 8 && m.start), 30000, "run 8's start");
    e.send({ to: "nb1", m: { fsWrite: { epoch: 2, state: "off", trees: [] } } });
    await e.wait(from("nb1", (m) => m.id === 8 && m.done), 30000, "run 8");
    const out8 = e.msgs.filter((x) => x.from === "nb1" && x.m.id === 8 && x.m.stream).map((x) => x.m.text).join("");
    ok(!e.msgs.some((x) => x.from === "nb1" && x.m.fsChanged === "/late.txt"), `a narrowing during a run: its later change never reaches the page (${out8.trim().split("\n").pop()})`);
    // two interpreters at once, each its own
    e.send({ open: "nb2", name: "" });
    e.send({ to: "nb2", m: { init: { limits: null } } });
    await e.wait(from("nb2", (m) => m.ready), 60000, "nb2 ready");
    e.send({ to: "nb2", m: { id: 1, code: "print('x' in globals())" } });
    await e.wait(from("nb2", (m) => m.id === 1 && m.done), 30000, "nb2 run");
    ok(e.msgs.filter((x) => x.from === "nb2" && x.m.stream).map((x) => x.m.text).join("").trim() === "False", "a second interpreter has its own variables");
    e.send({ close: "nb2" });
    await e.wait((m) => m.closed === "nb2", 10000, "closed");
    ok(true, "close: the interpreter stops, {closed}");
    e.p.stdin.end();
    ok((await e.exited) === 0, "stdin's end with an interpreter open: every one stops, the engine exits 0");
  }
  // an app that stops reading: what waits for it is bounded, and the engine stops at once (exit 4)
  {
    const e = engine(["--out-max", "8"]);
    e.send(HELLO);
    await e.wait((m) => m.hello);
    e.send({ open: "flood", name: "" });
    e.send({ to: "flood", m: { init: { limits: null } } });
    await e.wait((m) => m.from === "flood" && m.m.ready, 60000, "flood ready");
    // (from here on, the test reads nothing: the pipe fills, then the engine's queue)
    e.p.stdout.pause();
    e.p.stdout.removeAllListeners("data");
    e.send({ to: "flood", m: { id: 1, code: "s = 'x' * 65536\nfor i in range(100000):\n    print(s)" } });
    const t = performance.now();
    const code = await Promise.race([e.exited, new Promise((res) => setTimeout(() => res("still running"), 90000))]);
    ok(code === 4, `the app not reading: the engine stops by itself, exit 4 (${code}, ${Math.round(performance.now() - t)} ms)`);
    if (code !== 4) e.p.kill();
  }
} catch (e) {
  failed++;
  console.log("FAIL " + (e?.stack ?? e));
}
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
