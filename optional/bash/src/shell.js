// The bash shell's module (plan-bash-shell r3, steps 1-3): just-bash 3.6.0 and
// its dependencies, bundled by scripts/optional-packages.mjs into one
// self-contained ES module, run only in the shell worker that
// web/shell/worker-boot.js starts (its own CSP: no network, no eval).
//
// The worker hands start() a MessagePort to the page.  Everything the module
// tells the page goes through hostCall, with a literal message name from
// web/shell/host-levels.json: the publisher computes host_req from those
// names, and refuses any other postMessage.  The protocol:
//   page -> module  {init: {limits, pipelineWidth}}          (step 3, once, before any exec: just-bash's
//                                                             executionLimits and bash.pipeline_width, from the
//                                                             page's validated config, web/shell/limits.ts)
//                   {exec: {id, run, script, stdin?, cwd, limits: {maxExecutionTimeMs}, allowance}}
//                                                            (one invocation of run `run`; its own remaining time,
//                                                             and the run's remaining output_bytes allowance)
//                   {abort: {id}}                            (Stop: the invocation's signal aborted)
//                   {fs: {id, req, ok: value} | {id, req, err: {code, message, refusal?}}}
//   module -> page  shell.ready {version}
//                   shell.configured {limits} | {error}      (step 3: the limits just-bash resolved, or the refusal)
//                   fs.request {id, run, req, op, args}      (a file call, to the page's mediator, ShellHost)
//                   shell.result {id, exit: {code, stdout, stderr}, output: {producedBytes, deliveredBytes, exceeded}}
//                                                            (exec() resolved: a real exit)
//                   shell.result {id, rejected: {message, refusal}, output: {...}}   (exec() rejected: never a status)
//                   shell.result {id, limit: {key, value}}   (step 3: refused before running, by this module's own
//                                                             check: only bash.pipeline_width)
// Output (step 3, @sagebrush's ruling C with astra5's conditions): each result is counted here, in exact UTF-8,
// stdout then stderr; only the prefix within the invocation's allowance, cut at a scalar boundary, is sent, with
// producedBytes (the whole result), deliveredBytes (what is sent) and exceeded (this module's flag) beside it, so the
// full result never crosses to the page.  just-bash's own maxOutputSize (the page's fixed backstop) bounds a result.
// The files are the workspace's, through the page's mediator (web/shell/host.ts): each IFileSystem
// method is one fs.request, and the mediator decides everything (r3 §2.2).  This side keeps nothing of
// the workspace: no cache, and none of just-bash's *Sync methods, so constructing the shell writes
// nothing (r3 §3.1).
//
// A refusal (the workspace's or the grant's answer, with an errno) is thrown into just-bash as a fresh
// error object, kept in the invocation's WeakSet; if exec() then rejects with one of those very objects,
// the result names its refusal (D8 point 5, provenance).  Anything else that rejects is reported
// unexplained (refusal null).  The page classifies; this side only reports.
import { Bash } from "../vendor/just-bash-3.6.0/browser.js";

export const VERSION = "0.3.0";

// The commands the first release registers (plan-bash-shell r3 §8), and no
// others: no network command, no python or js-exec, nothing deferred (tee,
// xargs, tar, gzip, sqlite3, ...).  The interpreter's own builtins (cd,
// export, test and 35 more, listed in ../README.md) are always there.
export const COMMANDS = [
  "ls", "cat", "head", "tail", "wc", "mkdir", "mv", "cp", "rm", "touch", "stat", "tree", "find",
  "grep", "sort", "uniq", "cut", "tr", "sed", "awk", "diff",
  "echo", "printf", "pwd", "basename", "dirname", "env", "true", "false", "seq",
  "jq",
];

const ERRNO = { ENOENT: -2, EACCES: -13, EEXIST: -17, ENOTDIR: -20, EISDIR: -21, EINVAL: -22, EMFILE: -24, EFBIG: -27, ENOSPC: -28, EROFS: -30, ENOTSUP: -95, EBUSY: -16, EBADF: -9, ECONFLICT: -1000 };
const enc = new TextEncoder();

// A string's bytes, by its encoding (r3 §3.3 rule 8): text as UTF-8, "binary"/"latin1" one byte per
// character; anything else EINVAL.
function bytesOf(content, options) {
  if (content instanceof Uint8Array) return content;
  const e = (typeof options === "string" ? options : options?.encoding) ?? "utf8";
  if (e === "utf8" || e === "utf-8") return enc.encode(content);
  if (e === "binary" || e === "latin1") {
    const b = new Uint8Array(content.length);
    for (let i = 0; i < content.length; i++) {
      const c = content.charCodeAt(i);
      if (c > 255) throw coded("EINVAL", `a binary write with a character past U+00FF`);
      b[i] = c;
    }
    return b;
  }
  throw coded("EINVAL", `the ${JSON.stringify(e)} encoding isn't supported`);
}
const latin1 = (b) => {
  let s = "";
  for (let i = 0; i < b.length; i += 8192) s += String.fromCharCode.apply(null, b.subarray(i, i + 8192));
  return s;
};
function textOf(b, options) {
  const e = (typeof options === "string" ? options : options?.encoding) ?? "utf8";
  if (e === "utf8" || e === "utf-8") return new TextDecoder().decode(b);
  if (e === "binary" || e === "latin1") return latin1(b);
  throw coded("EINVAL", `the ${JSON.stringify(e)} encoding isn't supported`);
}
function coded(code, message) {
  const err = new Error(message);
  err.code = code;
  err.errno = ERRNO[code];
  return err;
}
const normalize = (p) => {
  const out = [];
  for (const s of p.split("/")) {
    if (s === "" || s === ".") continue;
    if (s === "..") out.pop();
    else out.push(s);
  }
  return "/" + out.join("/");
};
// The UTF-8 length of `s`, as TextEncoder encodes it (a lone surrogate is U+FFFD, 3 bytes), and the end of its
// longest prefix of at most `budget` bytes that ends at a scalar boundary.
function utf8(s, budget = Infinity) {
  let n = 0, end = s.length;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    let w = 1, b;
    if (c <= 0x7f) b = 1;
    else if (c <= 0x7ff) b = 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) (b = 4), (w = 2);
    else b = 3;
    if (end === s.length && n + b > budget) end = i;
    n += b;
    i += w - 1;
  }
  return { bytes: n, end };
}
// A result's stdout and stderr within `cap` bytes, in that order (stdout's prefix first, then stderr's in what is
// left), each cut at a scalar boundary; with the whole result's size and what is kept.  `cap` is the smaller of the
// run's remaining allowance and just-bash's output bound (the page's fixed backstop): just-bash's collector bounds
// what it accounts, but a result it stopped still carries that much stdout plus its own diagnostic, so the final
// message is bounded here too (astra5 B3-A5-2).  `exceeded`: the whole result passed the ALLOWANCE (the page types it);
// `truncated`: it passed only the backstop, so what is sent is a prefix of an ordinary result (never typed).
function bounded(stdout, stderr, allowance, backstop) {
  const cap = Math.min(allowance, backstop);
  const o = utf8(stdout, cap), e = utf8(stderr, Math.max(0, cap - Math.min(o.bytes, cap)));
  const produced = o.bytes + e.bytes;
  if (produced <= cap) return { stdout, stderr, produced, delivered: produced, exceeded: false, truncated: false };
  const so = stdout.slice(0, o.end), se = o.end < stdout.length ? "" : stderr.slice(0, e.end);
  const exceeded = produced > allowance;
  return { stdout: so, stderr: se, produced, delivered: utf8(so).bytes + utf8(se).bytes, exceeded, truncated: !exceeded };
}
// The widest pipeline anywhere in a parsed script (bash.pipeline_width): an iterative walk of its AST.
function widestPipeline(ast) {
  let widest = 0;
  const stack = [ast], seen = new Set();
  while (stack.length) {
    const n = stack.pop();
    if (!n || typeof n !== "object" || seen.has(n)) continue;
    seen.add(n);
    if (n.type === "Pipeline" && Array.isArray(n.commands)) widest = Math.max(widest, n.commands.length);
    for (const v of Array.isArray(n) ? n : Object.values(n)) if (v && typeof v === "object") stack.push(v);
  }
  return widest;
}
const statOf = (s) => ({ isFile: s.kind === "file", isDirectory: s.kind === "folder", isSymbolicLink: false, mode: s.kind === "folder" ? 0o755 : 0o644, size: s.size, mtime: new Date(s.mtime), identity: s.identity });

export function start(port) {
  function hostCall(name, payload) {
    port.postMessage({ name, payload });
  }
  // (the invocations running, by id: each with its run, its pending file calls and the refusals it threw)
  const invocations = new Map();
  let nextReq = 1;

  // One file call: an fs.request, answered by the page.  A refusal is thrown as a fresh object of this
  // invocation's; `wording` gives a redirection's message bash's form (D8 point 2).
  function call(inv, op, args, wording) {
    const req = nextReq++;
    return new Promise((resolve, reject) => {
      inv.pending.set(req, { resolve, reject, wording, op, path: args[0] });
      hostCall("fs.request", { id: inv.id, run: inv.run, req, op, args });
    });
  }
  function answer(m) {
    const inv = invocations.get(m.id), p = inv?.pending.get(m.req);
    if (!p) return;
    inv.pending.delete(m.req);
    if (!m.err) return p.resolve(m.ok);
    // (a missing path in just-bash's own words, which its commands test for ("ENOENT", "no such file"); a
    // redirection's refusal as bash says it: "bash: <path>: <reason>")
    const message = p.wording ? `bash: ${m.err.message}` : m.err.code === "ENOENT" ? `ENOENT: no such file or directory, ${p.op} '${p.path}'` : m.err.message;
    const err = coded(m.err.code, message);
    if (typeof m.err.refusal === "string") {
      err.refusal = m.err.refusal;
      inv.thrown.add(err);
    }
    p.reject(err);
  }

  // just-bash's IFileSystem, onto the mediator (r3 §3.1).  /dev/null is the shell's own: written to, it
  // keeps nothing; read, it is empty; it never reaches the workspace.
  function fsFor(inv) {
    const isNull = (p) => normalize(p) === "/dev/null";
    const NULL_STAT = { isFile: true, isDirectory: false, isSymbolicLink: false, mode: 0o666, size: 0, mtime: new Date(0), identity: "null" };
    return {
      async readFile(p, options) {
        if (isNull(p)) return "";
        return textOf(await call(inv, "read", [normalize(p)]), options);
      },
      async readFileBytes(p) {
        if (isNull(p)) return "";
        return latin1(await call(inv, "read", [normalize(p)]));
      },
      async readFileBuffer(p) {
        if (isNull(p)) return new Uint8Array(0);
        return call(inv, "read", [normalize(p)]);
      },
      async writeFile(p, content, options) {
        if (isNull(p)) return;
        await call(inv, "write", [normalize(p), bytesOf(content, options)], true);
      },
      async appendFile(p, content, options) {
        if (isNull(p)) return;
        await call(inv, "append", [normalize(p), bytesOf(content, options)], true);
      },
      async exists(p) {
        if (isNull(p)) return true;
        return call(inv, "exists", [normalize(p)]);
      },
      async stat(p) {
        if (isNull(p)) return NULL_STAT;
        return statOf(await call(inv, "stat", [normalize(p)]));
      },
      async lstat(p) {
        if (isNull(p)) return NULL_STAT;
        return statOf(await call(inv, "stat", [normalize(p)]));
      },
      async mkdir(p, options) {
        await call(inv, "mkdir", [normalize(p), !!options?.recursive]);
      },
      async createExclusive(p, options) {
        await call(inv, options?.directory ? "mkdir" : "create", options?.directory ? [normalize(p), false] : [normalize(p)]);
      },
      async readdir(p) {
        return (await call(inv, "list", [normalize(p)])).map((e) => e.name);
      },
      async readdirWithFileTypes(p) {
        return (await call(inv, "list", [normalize(p)])).map((e) => ({ name: e.name, isFile: e.kind === "file", isDirectory: e.kind === "folder", isSymbolicLink: false }));
      },
      async rm(p, options) {
        await call(inv, "rm", [normalize(p), !!options?.recursive, !!options?.force]);
      },
      async cp(src, dest, options) {
        await call(inv, "cp", [normalize(src), normalize(dest), !!options?.recursive]);
      },
      async mv(src, dest) {
        await call(inv, "mv", [normalize(src), normalize(dest)]);
      },
      resolvePath(base, p) {
        return normalize(p.startsWith("/") ? p : base + "/" + p);
      },
      // (globs go through readdirWithFileTypes in 3.6.0; nothing here holds a list of every path)
      getAllPaths() {
        return [];
      },
      async realpath(p) {
        const q = normalize(p);
        if (!isNull(q) && !(await call(inv, "exists", [q]))) throw coded("ENOENT", `${q}: No such file or directory`);
        return q;
      },
      async utimes(p) {
        // (touch of an existing path changes nothing: r3 §3.1)
        if (!isNull(p) && !(await call(inv, "exists", [normalize(p)]))) throw coded("ENOENT", `${normalize(p)}: No such file or directory`);
      },
      async chmod(p) {
        throw coded("ENOTSUP", `${normalize(p)}: modes aren't kept in the workspace`);
      },
      async symlink(_t, p) {
        throw coded("ENOTSUP", `${normalize(p)}: the workspace has no links`);
      },
      async link(_t, p) {
        throw coded("ENOTSUP", `${normalize(p)}: the workspace has no links`);
      },
      async readlink(p) {
        throw coded("EINVAL", `${normalize(p)}: not a link`);
      },
    };
  }

  // (step 3: the limits, fixed once by the page's init before any exec; a second init is refused)
  let config = null;

  port.onmessage = async (e) => {
    const m = e.data;
    if (!m || typeof m !== "object") return;
    if (m.fs) return answer(m.fs);
    if (m.abort) return invocations.get(m.abort.id)?.ctl.abort();
    if (m.init) {
      if (config) return hostCall("shell.configured", { error: "the shell is already configured (one init per worker)" });
      const { limits, pipelineWidth } = m.init;
      if (!limits || typeof limits !== "object" || !Object.values(limits).every((v) => typeof v === "number") || !Number.isSafeInteger(pipelineWidth) || pipelineWidth < 1)
        return hostCall("shell.configured", { error: "an init takes {limits: {name: number}, pipelineWidth}" });
      let resolved;
      try {
        // (just-bash resolves and checks them; a probe instance, never run, constructed as every exec's is)
        resolved = { ...new Bash({ fs: fsFor({ id: -1, run: "", pending: new Map(), thrown: new WeakSet() }), cwd: "/", commands: COMMANDS, executionLimits: { ...limits } }).limits };
      } catch (err) {
        return hostCall("shell.configured", { error: String((err && err.message) || err) });
      }
      config = { limits: { ...limits }, pipelineWidth };
      return hostCall("shell.configured", { limits: resolved });
    }
    if (!m.exec || typeof m.exec.script !== "string" || typeof m.exec.run !== "string") return;
    const { id, run, script, stdin, cwd } = m.exec;
    if (!config) return hostCall("shell.result", { id, rejected: { message: "the shell isn't configured (no init)", refusal: null }, output: { producedBytes: 0, deliveredBytes: 0, exceeded: false, truncated: false } });
    const allowance = typeof m.exec.allowance === "number" && m.exec.allowance >= 0 ? m.exec.allowance : 0;
    // (the result's bound besides the allowance: just-bash's own output bound, from the init)
    const backstop = typeof config.limits.maxOutputSize === "number" && config.limits.maxOutputSize >= 0 ? config.limits.maxOutputSize : 0;
    // (an invocation sets only its own remaining time; every other limit is the init's)
    const t = m.exec.limits?.maxExecutionTimeMs;
    const executionLimits = { ...config.limits, ...(typeof t === "number" && t >= 0 ? { maxExecutionTimeMs: t } : {}) };
    // (bash.pipeline_width: from just-bash's own parse, before anything runs; a longer pipeline is refused whole.
    // A script that doesn't parse runs, and exec() reports its error as it always has)
    let widest = 0;
    try {
      const probe = new Bash({ fs: fsFor({ id: -1, run: "", pending: new Map(), thrown: new WeakSet() }), cwd: "/", commands: COMMANDS, executionLimits });
      probe.registerTransformPlugin({ name: "sagebrush-pipeline-width", transform: ({ ast }) => ((widest = widestPipeline(ast)), { ast }) });
      probe.transform(script);
    } catch {}
    if (widest > config.pipelineWidth) return hostCall("shell.result", { id, limit: { key: "pipeline_width", value: config.pipelineWidth } });
    const inv = { id, run, pending: new Map(), thrown: new WeakSet(), ctl: new AbortController() };
    invocations.set(id, inv);
    let r;
    try {
      r = await new Bash({ fs: fsFor(inv), cwd: typeof cwd === "string" ? cwd : "/", commands: COMMANDS, executionLimits }).exec(script, { ...(typeof stdin === "string" ? { stdin } : {}), signal: inv.ctl.signal });
    } catch (err) {
      // (a rejection is reported as one, with its refusal only if it is one this invocation threw: D8 point 5)
      const b = bounded("", String((err && err.message) || err), allowance, backstop);
      hostCall("shell.result", { id, rejected: { message: b.stderr, refusal: inv.thrown.has(err) ? err.refusal : null }, output: { producedBytes: b.produced, deliveredBytes: b.delivered, exceeded: b.exceeded, truncated: b.truncated } });
      return;
    } finally {
      invocations.delete(id);
    }
    const b = bounded(r.stdout, r.stderr, allowance, backstop);
    hostCall("shell.result", { id, exit: { code: r.exitCode, stdout: b.stdout, stderr: b.stderr }, output: { producedBytes: b.produced, deliveredBytes: b.delivered, exceeded: b.exceeded, truncated: b.truncated } });
  };
  hostCall("shell.ready", { version: VERSION });
}
