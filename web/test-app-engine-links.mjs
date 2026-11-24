// ci: checks.3 order=41
// A malicious notebook in the desktop app can't make links (SECURITY-MODEL.md; the app's workspace on disk,
// app/src-tauri/src/disk_fs.rs, refuses to follow links but doesn't race-proof that, because a notebook can't make
// one): Python run by the app's engine subprocess (app/engine/, as the desktop app starts it) tries every way it has
// to a symbolic link, a hard link, a junction or a special file (os, posix, pathlib, shutil), and to the computer's
// own file system (js, ctypes, _posixsubprocess, …); every one is refused, and what reaches the page (the files it
// writes back, which the app writes to disk) is only the ordinary files and folders asked for.  Then the same with a
// mutant: os.symlink given to Python by the run itself, as an engine that let one through would: the check fails.
//
//   node web/test-app-engine-links.mjs [DIR]     DIR: the worker's folder (default web/dist, from bun web/build.ts)
import { spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { encode, decode, frame, frameReader } from "../app/engine/frames.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const root = process.argv[2] ?? join(here, "dist");
let failed = 0, passed = 0;
const ok = (c, what) => (c ? (passed++, console.log("ok   " + what)) : (failed++, console.log("FAIL " + what)));

function engine() {
  const p = spawn(process.execPath, [join(here, "..", "app", "engine", "main.mjs"), "--stdio", "--root", root, "--memory", "2048"], { stdio: ["pipe", "pipe", "pipe"] });
  const msgs = [], waiters = [];
  let err = "";
  p.stderr.on("data", (d) => (err += d));
  const r = frameReader((x) => {
    const m = decode(x);
    msgs.push(m);
    for (const w of [...waiters]) if (w.test(m)) { waiters.splice(waiters.indexOf(w), 1); w.res(m); }
  });
  p.stdout.on("data", (d) => r.push(d));
  return {
    p, msgs,
    send: (m) => p.stdin.write(frame(encode(m))),
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

// (each attempt prints "<what>: refused <why>" or "<what>: MADE"; then the ordinary files asked for)
const ATTEMPTS = String.raw`
import os, pathlib, shutil
os.makedirs('/w/sub', exist_ok=True)
open('/w/a.txt', 'w').write('a')
open('/w/sub/b.txt', 'w').write('b')
def tryit(what, f):
    try:
        f()
        print(what + ': MADE')
    except Exception as e:
        print(what + ': refused ' + type(e).__name__)
tryit('os.symlink', lambda: os.symlink('/w/a.txt', '/w/s1'))
tryit('os.symlink to outside', lambda: os.symlink('/etc/passwd', '/w/s2'))
tryit('os.link', lambda: os.link('/w/a.txt', '/w/h1'))
tryit('os.mkfifo', lambda: os.mkfifo('/w/f1'))
tryit('os.mknod', lambda: os.mknod('/w/n1'))
tryit('pathlib symlink_to', lambda: pathlib.Path('/w/s3').symlink_to('/w/a.txt'))
tryit('pathlib hardlink_to', lambda: pathlib.Path('/w/h2').hardlink_to('/w/a.txt'))
tryit('shutil.copytree making a link', lambda: (os.makedirs('/w/t', exist_ok=True), shutil.copytree('/w/t', '/w/t2', symlinks=True, copy_function=lambda s, d: os.symlink(s, d))) and os.symlink('/w/a.txt', '/w/t2/s4'))
for name in ['posix', 'nt', '_posixsubprocess', 'ctypes', 'js', 'pyodide', '_winapi', 'msvcrt', 'fcntl']:
    def imp(name=name):
        m = __import__(name)
        if not any(hasattr(m, f) for f in ('symlink', 'link', 'CreateJunction', 'CDLL', 'globalThis', 'fork_exec')):
            raise ImportError('imported, with nothing to make links with')
    tryit('import ' + name, imp)
tryit('reading the computer\'s own /etc/hostname', lambda: open('/etc/hostname').read())
print('names', sorted(n for n in dir(os) if n in ('symlink', 'link', 'readlink', 'mkfifo', 'mknod', 'lchown', 'lchmod')))
`;

async function check(mutant) {
  const e = engine();
  const from = (sid, test) => (m) => m.from === sid && test(m.m);
  e.send({ hello: { protocol: { min: 1, max: 1 }, client: "test", want: [] } });
  await e.wait((m) => m.hello);
  e.send({ open: "nb1", name: "" });
  e.send({ to: "nb1", m: { init: { limits: null } } });
  e.send({ to: "nb1", m: { fsWrite: { epoch: 1, state: "on", trees: ["/"] } } });
  await e.wait(from("nb1", (m) => m.ready), 60000, "ready");
  // (the mutant: what an engine that let a link operation through would give Python)
  const code = (mutant ? "import os\nos.symlink = lambda a, b, target_is_directory=False: None\n" : "") + ATTEMPTS;
  e.send({ to: "nb1", m: { id: 1, code } });
  await e.wait(from("nb1", (m) => m.id === 1 && m.done), 120000, "the run");
  const text = e.msgs.filter((x) => x.from === "nb1" && x.m.id === 1 && x.m.stream).map((x) => x.m.text).join("");
  const made = text.split("\n").filter((l) => /: MADE$/.test(l));
  const names = /^names (.*)$/m.exec(text)?.[1] ?? "(none)";
  // (what the page is told of: the files the app would write to disk)
  const back = e.msgs.filter((x) => x.from === "nb1" && x.m.fsChanged !== undefined).map((x) => [x.m.fsChanged, x.m.data instanceof Uint8Array ? "file" : x.m.dir ? "dir" : x.m.deleted ? "deleted" : JSON.stringify(Object.keys(x.m))]);
  e.p.kill();
  return { text, made, names, back };
}

try {
  const r = await check(false);
  console.log(r.text.trim().split("\n").map((l) => "  " + l).join("\n"));
  ok(r.made.length === 0, `no link, special file or way out was made (${r.made.join("; ") || "none"})`);
  ok(r.names === "[]", `os has none of symlink, link, readlink, mkfifo, mknod, lchown, lchmod: ${r.names}`);
  const files = r.back.filter(([, k]) => k === "file").map(([p]) => p);
  ok(r.back.every(([p, k]) => k === "file" || k === "dir" || k === "deleted") && files.includes("/w/a.txt") && files.includes("/w/sub/b.txt") && !r.back.some(([p]) => /\/(s\d|h\d|f1|n1)$/.test(p)),
    `what reaches the page is only the ordinary files and folders asked for: ${JSON.stringify(r.back)}`);
  const m = await check(true);
  ok(m.made.length > 0 && m.names !== "[]", `the mutant (os.symlink let through) is caught: ${m.made.join("; ")}; names ${m.names}`);
} catch (e) {
  ok(false, String(e?.stack ?? e));
}
console.log(failed ? `${failed} failed, ${passed} passed` : `all ${passed} passed`);
process.exit(failed ? 1 : 0);
