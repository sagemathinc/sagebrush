// ci: web-browser/notebook order=225 runner=bun
// The shell module's Terminal commands (host level 4, plan-term-3a r1.7 §3.1): optional/bash's module, bundled as
// the publisher bundles it (scripts/js-bundle.mjs), run in bun on a MessageChannel, with a test double of the page that answers its file calls and its cmd.requests.
// Checks:
// - the commands are registered only when the init names them, and the init takes only the fixed set, each once;
// - a cmd.request is data only: exactly {id, run, req, name, argv, stdin, stdinRedirected, cwd}, argv the words as
//   bash expanded them, stdin exactly the bytes given (just-bash's byte strings), cwd the shell's own; the answer's
//   text encoded as UTF-8 for the next stage;
// - stdinRedirected, both ways: alone, a pipe (an empty one too), `<`, `<<<` on a group, a while loop's `<`, a
//   command substitution, eval and a variable (the fallback), a forged mark;
// - the bounds, at and past each one, refused before anything is sent;
// - the answer: the status and text passed through; a malformed or refused answer is 126 with the reason; Stop
//   ends a waiting command at once with 130, and a late answer is dropped;
// - a pipeline's commands run in order, the second given the first's output;
// - the page's own check of a request's payload (web/shell/loader.ts cmdRequestOf).
//   bun web/shell/test-terminal-commands.mjs
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const here = new URL(".", import.meta.url).pathname;
let failures = 0;
const ok = (cond, name) => {
  console.log((cond ? "ok   " : "FAIL ") + name);
  if (!cond) failures++;
};
setTimeout(() => {
  console.log("FAIL the test did not end within 120 s");
  process.exit(1);
}, 120_000).unref();

const root = join(here, "..", "..");
const tmp = mkdtempSync(join(tmpdir(), "terminal-commands-"));
process.on("exit", () => rmSync(tmp, { recursive: true, force: true }));
execFileSync(process.execPath, [join(root, "scripts", "js-bundle.mjs"), join(root, "optional", "bash"), join(tmp, "shell.js")], { stdio: ["ignore", "ignore", "inherit"] });
const M = await import(join(tmp, "shell.js"));
const L = await import(join(here, "loader.ts"));
const enc = new TextEncoder(), dec = new TextDecoder();

// A module on its own channel, with the page's double: files under /w (f.txt, u.txt), everything else absent.
async function shell(commands) {
  const { port1, port2 } = new MessageChannel();
  const results = new Map(), requests = [];
  let ready, configured;
  // (answer(r) decides each cmd.request's answer: an object to post, or null to hold it)
  const page = { answer: (r) => ({ ok: { code: 0, stdout: `${r.name} ${JSON.stringify(r.argv)}\n`, stderr: "" } }), requests, port: port1 };
  const FILES = { "/w/f.txt": "from f\n", "/w/u.txt": "é\n" };
  port1.onmessage = (e) => {
    const { name, payload } = e.data;
    if (name === "shell.ready") ready?.(payload);
    else if (name === "shell.configured") configured?.(payload);
    else if (name === "shell.result") results.get(payload.id)?.(payload);
    else if (name === "cmd.request") {
      requests.push(payload);
      const a = page.answer(payload);
      if (a) port1.postMessage({ cmd: { id: payload.id, req: payload.req, ...a } });
    } else if (name === "fs.request") {
      const [p] = payload.args;
      const isDir = p === "/w" || p === "/";
      const a = payload.op === "exists" ? { ok: isDir || p in FILES }
        : payload.op === "stat" ? (isDir || p in FILES ? { ok: { kind: isDir ? "folder" : "file", size: 0, mtime: 0, identity: p } } : { err: { code: "ENOENT", message: `${p}: No such file or directory` } })
        : payload.op === "read" && p in FILES ? { ok: enc.encode(FILES[p]) }
        : { err: { code: "ENOENT", message: `${p}: No such file or directory` } };
      port1.postMessage({ fs: { id: payload.id, req: payload.req, ...a } });
    }
  };
  const r = new Promise((res) => (ready = res));
  M.start(port2);
  await r;
  const c = new Promise((res) => (configured = res));
  port1.postMessage({ init: { limits: { maxOutputSize: 32 * 2 ** 20 }, pipelineWidth: 16, ...(commands ? { commands } : {}) } });
  page.configured = await c;
  let next = 1;
  page.run = (script, opts = {}) => {
    const id = next++;
    const p = new Promise((res) => results.set(id, res));
    port1.postMessage({ exec: { id, run: "R", script, cwd: "/w", allowance: 64 * 2 ** 20 } });
    if (opts.abortAfterMs !== undefined) setTimeout(() => port1.postMessage({ abort: { id } }), opts.abortAfterMs);
    return p.then((o) => ({ ...o, id }));
  };
  return page;
}
const exit = (o) => o.exit ?? { code: -1, stdout: "", stderr: JSON.stringify(o) };

// ---------------------------------------------------------------- registration
{
  const off = await shell();
  ok(!off.configured.error, `an init without commands is taken (${off.configured.error ?? "ok"})`);
  for (const name of M.TERMINAL_COMMANDS) {
    const r = exit(await off.run(`${name} x`));
    ok(r.code === 127 && off.requests.length === 0, `without commands, ${name} isn't there (127, nothing sent: ${JSON.stringify(r.stderr)})`);
  }
  for (const [bad, why] of [[["python", "node"], "a name outside the set"], [["python", "python"], "a name twice"], ["python", "not a list"]]) {
    const s = await shell(bad);
    ok(typeof s.configured.error === "string" && /some of python, python3, sage, matlab, magma, each once/.test(s.configured.error), `an init with ${why} is refused (${s.configured.error})`);
  }
  ok(JSON.stringify(M.TERMINAL_COMMANDS) === JSON.stringify([...L.TERMINAL_COMMANDS]), "the module's set and the page's are the same five names");
  ok(M.ARGV_MAX === L.CMD_BOUNDS.argv && M.ARGV_BYTES === L.CMD_BOUNDS.argvBytes && M.STDIN_BYTES === L.CMD_BOUNDS.stdinBytes, "the module's bounds and the page's are the same");
}

// ---------------------------------------------------------------- the request: data only
const S = await shell([...M.TERMINAL_COMMANDS]);
{
  S.requests.length = 0;
  const r = exit(await S.run(`python 'a b' "$HOME" '$(x)' ';' ""`));
  const q = S.requests[0];
  ok(r.code === 0 && S.requests.length === 1, `one command, one request (${r.code}, ${S.requests.length})`);
  ok(JSON.stringify(Object.keys(q).sort()) === JSON.stringify(["argv", "cwd", "id", "name", "req", "run", "stdin", "stdinRedirected"]), `the request has exactly its fields (${Object.keys(q).sort()})`);
  ok(JSON.stringify(q.argv) === JSON.stringify(["a b", "/", "$(x)", ";", ""]) && q.name === "python" && q.run === "R", `argv is the words as bash expanded them, never re-joined (${JSON.stringify(q.argv)})`);
  ok(q.stdin instanceof Uint8Array && q.stdin.byteLength === 0 && q.cwd === "/w", `stdin is bytes, cwd the shell's (${q.cwd})`);
  S.requests.length = 0;
  await S.run(`cd / && python3 -c 1`);
  ok(S.requests[0]?.cwd === "/" && S.requests[0]?.name === "python3", `cwd follows cd, and the name is as typed (${S.requests[0]?.cwd}, ${S.requests[0]?.name})`);
  S.requests.length = 0;
  await S.run(`python < u.txt`);
  ok(dec.decode(S.requests[0]?.stdin) === "é\n" && S.requests[0].stdin.byteLength === 3, `a file's bytes are stdin exactly (${S.requests[0] && [...S.requests[0].stdin]})`);
  for (const [script, want] of [["echo é | python", "é\n"], ["printf '€' | python", "€"], ["python <<< 'aé'", "aé\n"]]) {
    S.requests.length = 0;
    await S.run(script);
    ok(dec.decode(S.requests[0]?.stdin) === want && S.requests[0].stdin.byteLength === enc.encode(want).length, `${JSON.stringify(script)}: stdin is its UTF-8 bytes (${S.requests[0] && [...S.requests[0].stdin]})`);
  }
  S.answer = () => ({ ok: { code: 0, stdout: "é€\n", stderr: "" } });
  const w = exit(await S.run(`python | wc -c`));
  const t = exit(await S.run(`python`));
  ok(w.stdout === "6\n" && t.stdout === "é€\n", `the answer's text reaches the next stage as UTF-8, and the terminal as text (${JSON.stringify(w.stdout)}, ${JSON.stringify(t.stdout)})`);
  S.answer = (r) => ({ ok: { code: 0, stdout: `${r.name} ${JSON.stringify(r.argv)}\n`, stderr: "" } });
}

// ---------------------------------------------------------------- stdinRedirected, both ways
for (const [script, want, note] of [
  ["python", false, "alone"],
  ["python x.py", false, "with a file"],
  ["echo hi | python", true, "a pipe"],
  ["true | python", true, "an empty pipe (just-bash gives it the same empty stdin as alone)"],
  ["python < f.txt", true, "<"],
  ["python 0< f.txt", true, "0<"],
  ["python <<< hi", true, "<<<"],
  ["python 2< f.txt", true, "`2<`: just-bash gives it to stdin, so the command has input (just-bash's own difference)"],
  ["{ python x; } <<< here", true, "<<< on a group"],
  ["while read l; do python w; done < f.txt", true, "a while loop's <"],
  ["echo $(python s)", false, "a command substitution"],
  ["eval 'python e'", false, "eval with nothing given (the fallback)"],
  ["echo q | eval 'python e'", true, "eval given input (the fallback)"],
  ["x=python; $x d", false, "a name from a variable (the fallback)"],
  ["__SAGEBRUSH_STDIN=r python f", false, "a mark the script writes itself"],
  ["f() { python f; }; echo q | f", true, "a function given input (the fallback)"],
  ["f() { python f; }; true | f", false, "a function given an empty pipe (the stated miss)"],
  ["echo q | __SAGEBRUSH_STDIN=t python f", true, "a forged mark can't hide a pipe"],
]) {
  S.requests.length = 0;
  await S.run(script);
  const q = S.requests.find((r) => r.name === "python");
  ok(q && q.stdinRedirected === want, `stdinRedirected is ${want}: ${note} (${JSON.stringify(script)} -> ${q?.stdinRedirected})`);
}

// ---------------------------------------------------------------- the bounds
{
  const cases = [
    [`python ${"a ".repeat(1024)}`, true, "1024 arguments"],
    [`python ${"a ".repeat(1025)}`, "python: more than 1024 arguments; the Terminal accepts up to 1024\n", "1025 arguments"],
    [`python ${"b".repeat(65536)}`, true, "64 KiB of arguments exactly"],
    [`python ${"b".repeat(65535)} é`.replace(" é", "é"), "python: the arguments are longer than the Terminal accepts (64 KiB)\n", "64 KiB + 1 byte (a 2-byte character at the end)"],
    [`sage ${"c".repeat(65537)}`, "sage: the arguments are longer than the Terminal accepts (64 KiB)\n", "the name as typed in the refusal"],
  ];
  for (const [script, want, note] of cases) {
    S.requests.length = 0;
    const r = exit(await S.run(script));
    if (want === true) ok(r.code === 0 && S.requests.length === 1, `${note}: sent (${r.code}, ${S.requests.length})`);
    else ok(r.code === 2 && r.stderr === want && r.stdout === "" && S.requests.length === 0, `${note}: refused with status 2, nothing sent (${r.code}, ${JSON.stringify(r.stderr.slice(0, 90))})`);
  }
  // (stdin at and past 8 MiB: a file of exactly that many bytes, then one more)
  for (const [extra, sent] of [[0, true], [1, false]]) {
    const big = await shell(["python"]);
    const n = 8 * 2 ** 20 + extra;
    big.requests.length = 0;
    const r = exit(await big.run(`printf '%${n}s' '' | python`));
    if (sent) ok(r.code === 0 && big.requests[0]?.stdin.byteLength === n, `8 MiB of stdin exactly: sent (${big.requests[0]?.stdin.byteLength})`);
    else ok(r.code === 2 && r.stderr === "python: the input is longer than the Terminal accepts (8 MiB)\n" && big.requests.length === 0, `8 MiB + 1 byte of stdin: refused with status 2, nothing sent (${JSON.stringify(r.stderr)})`);
  }
}

// ---------------------------------------------------------------- the answer
{
  S.answer = (r) => ({ ok: { code: 3, stdout: "out\n", stderr: "err\n" } });
  let r = exit(await S.run(`python; echo "st=$?"`));
  ok(r.stdout === "out\nst=3\n" && r.stderr === "err\n" && r.code === 0, `the status and text pass through (${JSON.stringify(r)})`);
  S.answer = () => ({ ok: { code: 256, stdout: "", stderr: "" } });
  r = exit(await S.run(`python`));
  ok(r.code === 126 && r.stderr === "python: the page's answer was malformed\n", `a status out of 0..255 is 126 (${JSON.stringify(r)})`);
  S.answer = () => ({ ok: { code: 0, stdout: 1, stderr: "" } });
  r = exit(await S.run(`magma`));
  ok(r.code === 126 && r.stderr === "magma: the page's answer was malformed\n", `text that isn't a string is 126 (${JSON.stringify(r)})`);
  S.answer = () => ({ err: { message: "the interactive prompt isn't available" } });
  r = exit(await S.run(`matlab`));
  ok(r.code === 126 && r.stderr === "matlab: the interactive prompt isn't available\n", `a refused answer is 126 with the page's reason (${JSON.stringify(r)})`);
  // (Stop: the command is held; the abort ends it at once with 130, and the late answer is dropped)
  S.requests.length = 0;
  S.answer = () => null;
  const t0 = performance.now();
  r = exit(await S.run(`python; echo after=$?`, { abortAfterMs: 50 }));
  const ms = performance.now() - t0;
  ok(S.requests.length === 1 && ms < 1500 && !/after=0/.test(r.stdout), `Stop ends a waiting command at once (${Math.round(ms)} ms, ${JSON.stringify(r)})`);
  const q = S.requests[0];
  S.port.postMessage({ cmd: { id: q.id, req: q.req, ok: { code: 0, stdout: "late\n", stderr: "" } } });
  S.answer = (x) => ({ ok: { code: 0, stdout: `${x.name}\n`, stderr: "" } });
  r = exit(await S.run(`python`));
  ok(r.code === 0 && r.stdout === "python\n", `a late answer is dropped, and the next invocation runs (${JSON.stringify(r)})`);
}

// ---------------------------------------------------------------- a pipeline
{
  S.requests.length = 0;
  S.answer = (x) => ({ ok: { code: 0, stdout: `${x.argv[0]}<${dec.decode(x.stdin)}>\n`, stderr: "" } });
  const r = exit(await S.run(`python a | python b | python3 c`));
  ok(S.requests.map((q) => q.argv[0]).join() === "a,b,c" && r.stdout === "c<b<a<>\n>\n>\n", `a pipeline's commands run in order, each given the one before's output (${JSON.stringify(r.stdout)})`);
  ok(S.requests.map((q) => q.stdinRedirected).join() === "false,true,true", "only the first stage of the pipeline is unredirected");
}

// ---------------------------------------------------------------- the page's check of a payload
{
  const good = { req: 1, name: "python", argv: ["a"], stdin: new Uint8Array(1), stdinRedirected: false, cwd: "/w" };
  ok(L.cmdRequestOf(good) !== null, "a well-formed request passes the page's check");
  for (const [k, v, note] of [
    ["name", "node", "a name outside the set"], ["name", "PYTHON", "a name in another case"], ["argv", "a b", "argv as a string"],
    ["argv", ["a", 1], "argv with a number"], ["argv", Array(1025).fill("a"), "1025 arguments"], ["argv", ["x".repeat(65537)], "64 KiB + 1 of arguments"],
    ["stdin", "text", "stdin as a string"], ["stdin", new Uint8Array(8 * 2 ** 20 + 1), "8 MiB + 1 of stdin"], ["stdinRedirected", 1, "stdinRedirected not a boolean"],
    ["cwd", "w", "a relative cwd"], ["req", 1.5, "a req that isn't an integer"],
  ]) ok(L.cmdRequestOf({ ...good, [k]: v }) === null, `the page refuses ${note}`);
  ok(L.cmdRequestOf({ ...good, argv: Array(1024).fill("a") }) !== null && L.cmdRequestOf({ ...good, stdin: new Uint8Array(8 * 2 ** 20) }) !== null, "the page takes each bound exactly");
}

console.log(failures ? `${failures} FAILED` : "all ok");
process.exit(failures ? 1 : 0);
