// The Sagebrush engine as the app's subprocess, on stdin and stdout
// (app/engine/serve.mjs has the protocol):
//
//   node app/engine/main.mjs --stdio --root DIR [--memory MB]
//
// DIR: the page's worker and its files (web/dist, or app/dist); MB: each
// interpreter's heap (default: three quarters of this computer's memory).
import { serve } from "./serve.mjs";

const o = { stdio: false, root: null, memory: null, help: false };
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--stdio") o.stdio = true;
  else if (a === "--root") o.root = argv[++i];
  else if (a === "--memory") o.memory = Number(argv[++i]);
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
serve({
  root: o.root,
  memory: o.memory,
  input: process.stdin,
  write: (b) => process.stdout.write(b),
  // (once what was written is out: the last frame, a protocol error say, reaches the app)
  exit: (code) => process.stdout.write(new Uint8Array(0), () => process.exit(code)),
});
