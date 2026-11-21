// The Sagebrush engine as the app's subprocess, on stdin and stdout
// (app/engine/serve.mjs has the protocol):
//
//   node app/engine/main.mjs --stdio --root DIR [--memory MB]
//
// DIR: the page's worker and its files (web/dist, or app/dist); MB: each
// interpreter's heap (default: three quarters of this computer's memory; a
// limit per interpreter, not for the engine: app/engine/serve.mjs).
import { Socket } from "node:net";
import { serve } from "./serve.mjs";

const o = { stdio: false, root: null, memory: null, outMax: undefined, help: false };
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--stdio") o.stdio = true;
  else if (a === "--root") o.root = argv[++i];
  else if (a === "--memory") o.memory = Number(argv[++i]);
  // (tests: a smaller bound on the output waiting for the app, in MB)
  else if (a === "--out-max") o.outMax = Number(argv[++i]) * 2 ** 20;
  else if (a === "-h" || a === "--help") o.help = true;
  else {
    process.stderr.write(`unknown argument: ${a}\n`);
    process.exit(2);
  }
}
if (o.help || !o.stdio || !o.root) {
  process.stderr.write("usage: node app/engine/main.mjs --stdio --root DIR [--memory MB]\n");
  process.exit(o.help ? 0 : 2);
}
// (stdout as a non-blocking stream on every system: Node writes a pipe synchronously on Linux, so an app that stops
// reading would block this thread, Stop included, while the interpreters' messages pile up behind it; this way what
// waits is counted, writableLength, and bounded: serve's outMax)
const out = new Socket({ fd: 1, readable: false, writable: true });
serve({
  root: o.root,
  memory: o.memory,
  input: process.stdin,
  outMax: o.outMax,
  write: (b) => out.write(b),
  queued: () => out.writableLength,
  // (once what was written is out, so the last frame, a protocol error say, reaches the app; or at once, when the app
  // isn't reading)
  exit: (code, now) => (now ? process.exit(code) : out.write(new Uint8Array(0), () => process.exit(code))),
});
