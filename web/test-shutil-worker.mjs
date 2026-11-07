// ci: web-runner order=122 chrome
// shutil and its os calls on the browser's file system (P3b-2, the design note astra and daybreak2 cleared), in
// headless Chromium against the built worker (web/worker.ts, web/shims/fs.ts):
//   - test/shutil_cases.py, run in a worker, prints what CPython 3.14 prints for it, line for line;
//   - descriptors keep their file through a rename, an unlink and a replacement, as CPython's do (IDENTITY, against
//     CPython too), and closed, unknown and wrong-way descriptors are its EBADF;
//   - the files permission (web/shims/fs.ts mayChange) is checked at every change, never once at an open: a
//     descriptor opened while allowed is refused at its next write once the permission is off; os.open's create and
//     truncate, chmod, utime and every shutil write path are refused before any effect, the page told of each
//     refusal and of no change; reads and /tmp still work;
//   - what the browser's file system doesn't do (O_DIRECTORY, a folder, O_TRUNC read-only, dir_fd) is
//     NotImplementedError before any effect;
//   - chmod and utime are session-local: no change message to the page, and a new worker on the same files has none.
//   bun web/build.ts, then node web/test-shutil-worker.mjs
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { devtoolsPort } from "./test-port.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = mkdtempSync(join(tmpdir(), "sb-shutil-"));
const CASES = readFileSync(join(here, "..", "test", "shutil_cases.py"), "utf8");
// (a descriptor's file through a rename, an unlink and a replacement; bad descriptors: CPython prints the same)
const IDENTITY = [
  "import os",
  "fd = os.open('id.txt', os.O_CREAT | os.O_RDWR)",
  "os.write(fd, b'one'); os.rename('id.txt', 'id2.txt'); os.write(fd, b'two'); print(open('id2.txt').read())",
  "os.unlink('id2.txt'); print(os.write(fd, b'3'), os.lseek(fd, 0, 0), os.read(fd, 10), os.path.exists('id2.txt'), os.fstat(fd).st_size)",
  "os.close(fd)",
  "open('r.txt', 'w').write('old'); open('other.txt', 'w').write('other')",
  "fd = os.open('r.txt', os.O_RDWR); os.replace('other.txt', 'r.txt'); os.write(fd, b'X'); os.lseek(fd, 0, 0)",
  "print(os.read(fd, 10), open('r.txt').read()); os.close(fd)",
  "ro = os.open('r.txt', os.O_RDONLY); wo = os.open('w.txt', os.O_CREAT | os.O_WRONLY)",
  "for f in [lambda: os.read(77, 1), lambda: os.close(77), lambda: os.write(ro, b'x'), lambda: os.read(wo, 1), lambda: os.fstat(77)]:",
  "    try: f()",
  "    except OSError as e: print(type(e).__name__, e.errno, e.strerror)",
  "os.close(ro); os.close(wo)",
  "print(sorted(os.listdir('.')))",
].join("\n");
const cpyDir = (tag) => mkdtempSync(join(tmp, `cpy-${tag}-`));
const cpython = (code, tag) => execFileSync("python3", ["-c", code], { cwd: cpyDir(tag), encoding: "utf8", env: { PATH: process.env.PATH ?? "", HOME: tmp } });
const wantCases = cpython(CASES, "cases"), wantIdentity = cpython(IDENTITY, "id");
const serve = spawn("python3", [join(here, "serve.py"), "0"], { stdio: ["ignore", "pipe", "inherit"] });
const port = await new Promise((r) => serve.stdout.once("data", (d) => r(Number(String(d).trim().split(/\s+/).pop()))));
const profile = join(tmp, "profile");
const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", "--password-store=basic", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
const cdp = await devtoolsPort(profile);
let targets;
for (let i = 0; i < 300; i++) {
  try {
    targets = await (await fetch(`http://127.0.0.1:${cdp}/json`)).json();
    break;
  } catch {
    await sleep(100);
  }
}
const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let n = 0;
const waiting = new Map();
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && waiting.has(m.id)) {
    waiting.get(m.id)(m.result ?? m.error);
    waiting.delete(m.id);
  }
};
const send = (method, params = {}) => new Promise((r) => { const id = ++n; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400));
  return r.result?.value;
};
const fails = [];
const check = (ok, what) => {
  console.log((ok ? "ok   " : "FAIL ") + what);
  if (!ok) fails.push(what);
};
// (one worker kept for a session, on the page: its files, its folder and its permission, then runs, each with its
// stdout and stderr and the change and refusal messages it sent)
const start = (name, dir, writable, files = []) => ev(`(() => {
  const w = new Worker("sagebrush-worker.js", { type: "module" });
  const s = (window.__sessions ??= {})[${JSON.stringify(name)}] = { w, changed: [], refused: [], runs: new Map(), next: 1 };
  w.onmessage = (e) => {
    const m = e.data;
    if (m?.fsChanged !== undefined) s.changed.push(m.fsChanged);
    if (m?.fsRefused !== undefined) s.refused.push(m.fsRefused);
    const r = s.runs.get(m?.id);
    if (!r) return;
    if (m.stream) r.out[m.stream] += m.text;
    if (m.done) { s.runs.delete(m.id); r.res({ ...r.out, error: m.error ?? null }); }
  };
  w.postMessage({ files: ${JSON.stringify(files)}.map(([p, t]) => [p, new TextEncoder().encode(t)]) });
  w.postMessage({ startDir: ${JSON.stringify(dir)} });
  w.postMessage({ fsWritable: ${writable} });
  w.postMessage({ init: { limits: null } });
  return true;
})()`);
const run = (name, code) => ev(`new Promise((res) => {
  const s = window.__sessions[${JSON.stringify(name)}];
  const id = s.next++;
  const r = { res, out: { stdout: "", stderr: "" } };
  s.runs.set(id, r);
  setTimeout(() => { if (s.runs.has(id)) { s.runs.delete(id); res({ ...r.out, timeout: true }); } }, 120000);
  s.w.postMessage({ id, code: ${JSON.stringify(code)} });
})`);
const setWritable = (name, on) => ev(`(window.__sessions[${JSON.stringify(name)}].w.postMessage({ fsWritable: ${on} }), true)`);
const log = (name) => ev(`(() => { const s = window.__sessions[${JSON.stringify(name)}]; const r = { changed: [...s.changed], refused: [...s.refused] }; s.changed.length = 0; s.refused.length = 0; return r; })()`);
const stop = (name) => ev(`(window.__sessions[${JSON.stringify(name)}].w.terminate(), true)`);
const firstDiff = (want, got) => {
  const w = want.split("\n"), g = got.split("\n");
  for (let i = 0; i < Math.max(w.length, g.length); i++) if (w[i] !== g[i]) return `line ${i + 1}: CPython ${JSON.stringify(w[i])}, the worker ${JSON.stringify(g[i])}`;
  return null;
};
const ranOk = (r, what) => check(!r.timeout && r.error === null && r.stderr === "", `${what} ran (${r.timeout ? "timed out" : r.error ?? "no error"}${r.stderr ? ": " + r.stderr.slice(-300) : ""})`);

try {
  for (const m of ["Page.enable", "Runtime.enable"]) await send(m);
  await send("Page.navigate", { url: `http://127.0.0.1:${port}/` });
  await sleep(1500);

  // ---- the cases and the identities, as CPython prints them
  await start("cases", "/sh", true);
  const c = await run("cases", CASES);
  ranOk(c, "shutil_cases.py");
  const dc = firstDiff(wantCases, c.stdout);
  check(dc === null, dc ?? `shutil_cases.py: ${wantCases.split("\n").length - 1} lines, each as CPython 3.14 prints it`);
  await stop("cases");
  await start("id", "/id", true);
  const i = await run("id", IDENTITY);
  ranOk(i, "the identity program");
  const di = firstDiff(wantIdentity, i.stdout);
  check(di === null, di ?? `a descriptor keeps its file through rename, unlink and replace; bad descriptors are EBADF: ${wantIdentity.split("\n").length - 1} lines as CPython's`);
  await stop("id");

  // ---- the files permission: a held descriptor, then every change refused once it is off
  await start("perm", "/sh", true, [["/sh/keep.txt", "kept"], ["/sh/dir/x.txt", "x"]]);
  const a = await run("perm", "import os, shutil\nfrom pathlib import Path\nfd = os.open('keep.txt', os.O_WRONLY)\nprint(os.write(fd, b'K'), open('keep.txt').read())\nos.makedirs('/tmp', exist_ok=True)\nst0 = os.stat('keep.txt')");
  ranOk(a, "the allowed write");
  check(a.stdout === "1 Kept\n", `a write with the permission on lands (${JSON.stringify(a.stdout)})`);
  await log("perm");
  await setWritable("perm", false);
  const REFUSED = [
    "def t(f):",
    "    try:",
    "        f()",
    "        return 'done'",
    "    except PermissionError as e:",
    "        return 'PermissionError ' + str(e.errno)",
    "print(t(lambda: os.write(fd, b'X')), open('keep.txt').read())",
    "print(t(lambda: os.open('new.bin', os.O_CREAT | os.O_WRONLY)), os.path.exists('new.bin'))",
    "print(t(lambda: os.open('keep.txt', os.O_WRONLY | os.O_TRUNC)), open('keep.txt').read())",
    "print(t(lambda: os.chmod('keep.txt', 0o600)), t(lambda: os.utime('keep.txt', (1, 2))), os.stat('keep.txt').st_mode == st0.st_mode, os.stat('keep.txt').st_mtime == st0.st_mtime)",
    "print(t(lambda: shutil.copy('keep.txt', 'c.txt')), t(lambda: shutil.copy2('keep.txt', 'c2.txt')), t(lambda: shutil.copyfile('keep.txt', 'c3.txt')), os.path.exists('c.txt'), os.path.exists('c2.txt'), os.path.exists('c3.txt'))",
    "print(t(lambda: shutil.copytree('dir', 'dir2')), t(lambda: shutil.move('keep.txt', 'm.txt')), t(lambda: shutil.rmtree('dir')), t(lambda: Path('touched').touch()))",
    "print(os.path.exists('dir2'), os.path.exists('m.txt'), sorted(os.listdir('.')), os.listdir('dir'), os.path.exists('touched'))",
    "r = os.open('keep.txt', os.O_RDONLY); print(os.read(r, 10), os.fstat(r).st_size); os.close(r)",
    "s = os.open('/tmp/s.bin', os.O_CREAT | os.O_WRONLY); print(os.write(s, b'ok'), t(lambda: os.chmod('/tmp/s.bin', 0o600)), oct(os.stat('/tmp/s.bin').st_mode & 0o777)); os.close(s)",
  ].join("\n");
  const b = await run("perm", REFUSED);
  ranOk(b, "the refusals");
  const lines = b.stdout.split("\n");
  check(lines[0] === "PermissionError 13 Kept", `a descriptor opened while allowed: its next write is refused, the file unchanged (${lines[0]})`);
  check(lines[1] === "PermissionError 13 False", `os.open's O_CREAT refused, no file made (${lines[1]})`);
  check(lines[2] === "PermissionError 13 Kept", `os.open's O_TRUNC refused, the file unchanged (${lines[2]})`);
  check(lines[3] === "PermissionError 13 PermissionError 13 True True", `chmod and utime refused, mode and times unchanged (${lines[3]})`);
  check(lines[4] === "PermissionError 13 PermissionError 13 PermissionError 13 False False False", `shutil.copy, copy2 and copyfile refused, nothing written (${lines[4]})`);
  check(lines[5] === "PermissionError 13 PermissionError 13 PermissionError 13 PermissionError 13", `copytree, move, rmtree and Path.touch refused (${lines[5]})`);
  check(lines[6] === "False False ['dir', 'keep.txt'] ['x.txt'] False", `nothing made, moved or removed (${lines[6]})`);
  check(lines[7] === "b'Kept' 4", `reads still work with the permission off (${lines[7]})`);
  check(lines[8] === "2 done 0o600", `/tmp is scratch: created, written and chmod-ed (${lines[8]})`);
  const lb = await log("perm");
  check(lb.changed.every((p) => p.startsWith("/tmp")), `the page was told of no change outside /tmp (${JSON.stringify(lb.changed)})`);
  check(lb.refused.length >= 11 && lb.refused.every((p) => !p.startsWith("/tmp")), `the page was told of each refusal, none in /tmp (${lb.refused.length}: ${JSON.stringify(lb.refused)})`);

  // ---- permission back: a revoke between two writes of one descriptor
  await setWritable("perm", true);
  const c1 = await run("perm", "w = os.open('two.txt', os.O_CREAT | os.O_WRONLY); print(os.write(w, b'first'))");
  await setWritable("perm", false);
  const c2 = await run("perm", "print(t(lambda: os.write(w, b'second')), open('two.txt').read())");
  check(c1.stdout === "5\n" && c2.stdout === "PermissionError 13 first\n", `a revoke between two writes: the second refused, the first kept (${JSON.stringify(c1.stdout + c2.stdout)})`);

  // ---- unsupported here: NotImplementedError before any effect; and bad arguments: CPython's errors, no effect
  await setWritable("perm", true);
  await log("perm");
  const UNSUP = [
    "def u(f):",
    "    try:",
    "        f()",
    "        return 'done'",
    "    except (NotImplementedError, ValueError, TypeError, OSError) as e:",
    "        return type(e).__name__",
    "st1 = os.stat('keep.txt')",
    "print(u(lambda: os.open('keep.txt', os.O_RDONLY | os.O_DIRECTORY)), u(lambda: os.open('dir', os.O_RDONLY)), u(lambda: os.open('keep.txt', os.O_RDONLY | os.O_TRUNC)), u(lambda: os.open('keep.txt', os.O_RDONLY, dir_fd=3)), u(lambda: os.open('keep.txt', 3)))",
    "print(u(lambda: os.utime('keep.txt', (1, 2), ns=(1, 2))), u(lambda: os.utime('keep.txt', dir_fd=3)), u(lambda: os.chmod('keep.txt', 0o600, dir_fd=3)))",
    "print(open('keep.txt').read(), os.stat('keep.txt').st_mtime == st1.st_mtime, os.stat('keep.txt').st_mode == st1.st_mode)",
    "for f in [lambda: os.stat('keep.txt', dir_fd=3), lambda: os.lstat('keep.txt', dir_fd=3)]:",
    "    try:",
    "        f(); print('done')",
    "    except NotImplementedError as e:",
    "        print('NotImplementedError', e)",
  ].join("\n");
  const d = await run("perm", UNSUP);
  ranOk(d, "the unsupported calls");
  const dl = d.stdout.split("\n");
  check(dl[0] === "NotImplementedError NotImplementedError NotImplementedError NotImplementedError OSError", `O_DIRECTORY, a folder, O_TRUNC read-only and dir_fd: NotImplementedError; access mode 3: EINVAL (${dl[0]})`);
  check(dl[1] === "ValueError NotImplementedError NotImplementedError", `utime's times with ns: ValueError; dir_fd: NotImplementedError (${dl[1]})`);
  check(dl[2] === "Kept True True", `none of them changed anything (${dl[2]})`);
  check(dl[3] === "NotImplementedError dir_fd unavailable on this platform" && dl[4] === dl[3], `os.stat and os.lstat with dir_fd: NotImplementedError (${dl[3]}; ${dl[4]})`);
  check((await log("perm")).changed.length === 0, "the page was told of no change for them");

  // ---- the bounds (design note §Allocations, astra's OPEN-FLAGS-1): flags beyond a C int refused before any effect; a
  // descriptor's file at most a bytes object's 2**32 - 1 bytes, a seek past it EINVAL and a write past it EFBIG, with
  // nothing allocated or changed; a read's result exactly the bytes read, a count no bytes object holds MemoryError
  const BOUNDS = [
    "def b(f):",
    "    try:",
    "        return repr(f())",
    "    except (OSError, MemoryError, OverflowError) as e:",
    "        return type(e).__name__ + ' ' + str(getattr(e, 'errno', None))",
    "h = os.open('keep.txt', os.O_RDWR)",
    "print(b(lambda: os.lseek(h, 2**32, os.SEEK_SET)), b(lambda: os.lseek(h, 2**62, os.SEEK_SET)), b(lambda: os.lseek(h, 2**53 + 1, os.SEEK_SET)), os.lseek(h, 0, os.SEEK_CUR))",
    "print(b(lambda: os.lseek(h, 2**32 - 1, os.SEEK_SET)), b(lambda: os.write(h, b'ab')), b(lambda: os.write(h, b'')), os.fstat(h).st_size, b(lambda: os.lseek(h, 2**32 - 2, os.SEEK_SET)), b(lambda: os.write(h, b'ab')), os.fstat(h).st_size)",
    "print(os.fstat(h).st_size, os.lseek(h, 0, os.SEEK_SET), b(lambda: os.read(h, 2**32 - 1)), b(lambda: os.read(h, 2**32)), os.lseek(h, 0, os.SEEK_CUR))",
    "os.close(h)",
    "print(b(lambda: os.open('big.bin', 2**32 + os.O_CREAT + os.O_WRONLY)), os.path.exists('big.bin'), open('keep.txt').read())",
  ].join("\n");
  const g = await run("perm", BOUNDS);
  ranOk(g, "the bounds");
  const gl = g.stdout.split("\n");
  check(gl[0] === "OSError 22 OSError 22 OSError 22 0", `lseek past 2**32 - 1: EINVAL, the position kept (${gl[0]})`);
  check(gl[1] === "4294967295 OSError 27 0 4 4294967294 OSError 27 4", `a write ending past 2**32 - 1: EFBIG; one of 0 bytes there changes nothing (${gl[1]})`);
  check(gl[2] === "4 0 b'Kept' MemoryError None 4", `os.read(fd, 2**32 - 1) gives the 4 bytes there are; 2**32: MemoryError, the position kept (${gl[2]})`);
  check(gl[3] === "OverflowError None False Kept", `os.open with 2**32 + O_CREAT + O_WRONLY: OverflowError, no file made (${gl[3]})`);
  check((await log("perm")).changed.length === 0, "the page was told of no change for them");

  // ---- metadata: session-local, no change message, gone in a new worker
  const e = await run("perm", "os.chmod('keep.txt', 0o600); os.utime('keep.txt', (1_000_000_000, 1_000_000_000)); print(oct(os.stat('keep.txt').st_mode & 0o777), int(os.stat('keep.txt').st_mtime))");
  check(e.stdout === "0o600 1000000000\n", `chmod and utime shown by stat in the session (${JSON.stringify(e.stdout)})`);
  const le = await log("perm");
  check(le.changed.length === 0, `no change message for chmod or utime: the page keeps bytes only (${JSON.stringify(le.changed)})`);
  await stop("perm");
  await start("reload", "/sh", true, [["/sh/keep.txt", "Kept"]]);
  const f = await run("reload", "import os\nprint(oct(os.stat('keep.txt').st_mode & 0o777), int(os.stat('keep.txt').st_mtime) > 1_000_000_000)");
  check(f.stdout === "0o644 True\n", `a new worker on the same files: none of the session's chmod or utime (${JSON.stringify(f.stdout)})`);
  await stop("reload");
} catch (e) {
  check(false, "the test ran: " + String(e?.stack ?? e).slice(0, 400));
} finally {
  chrome.kill();
  serve.kill();
  await sleep(300);
  rmSync(tmp, { recursive: true, force: true });
}
console.log(fails.length ? `${fails.length} failed` : "all passed");
process.exit(fails.length ? 1 : 0);
