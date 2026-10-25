// ShellHost's cases (plan-bash-shell r3 §9 step 2, addendum D8 r3's step-2 tests), run in the page by
// test-shell-host.mjs: the real shell module in its worker, a real Workspace, and ShellHost between them.
import { startShell, ShellHost, MAX_PENDING, W } from "/host-bundle.js";

const enc = (s) => new TextEncoder().encode(s);
const dec = (b) => new TextDecoder().decode(b);
// bytes as a string when they are UTF-8, else their values (as the oracle writes them)
const text = (b) => {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(b);
  } catch {
    return [...b];
  }
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const PERSON = { kind: "person" };

let D;
let nth = 0;
// A workspace of its own for a group of cases, and a host over it.  `wrap(ws)` lets a case put a view of the
// workspace between the host and it (a hook before a verb: a concurrent change, a fault).
async function fresh(name, { start, wrap, limits } = {}) {
  localStorage.clear();
  const ws = await W.Workspace.open({ name: `host-${name}-${++nth}`, mainName: `host-${name}-main-${nth}`, ...(limits ? { limits } : {}) });
  const host = new ShellHost(wrap ? wrap(ws) : ws, start ?? (() => startShell(D.S, "/").then((x) => x.shell)));
  return { ws, host };
}
// A view of `ws` whose `verb` runs `before(args)` first, once per call while `when(args)` holds.
function hooked(ws, verb, before, when = () => true) {
  const v = Object.create(ws);
  v[verb] = async function (...args) {
    if (when(...args)) await before(...args);
    return ws[verb].apply(this, args);
  };
  return v;
}
const read = async (ws, p) => {
  try {
    return text((await ws.readUpTo(p, 2 ** 20)).content);
  } catch (e) {
    if (e instanceof W.WorkspaceError && e.code === "missing") return null;
    throw e;
  }
};
const opsOf = async (ws) => (await ws.ops()).filter((o) => o.origin !== "server");

export async function run(only) {
  D = await (await fetch("/data.json")).json();
  const out = [];
  const check = (ok, what) => out.push([!!ok, what]);
  const groups = { oracle, lexical, basics };
  for (const [name, g] of Object.entries(groups)) {
    if (only && !only.split(",").includes(name)) continue;
    try {
      await g(check);
    } catch (e) {
      check(false, `${name}: the cases threw: ${e?.constructor?.name}: ${e?.message}\n${e?.stack ?? ""}`.slice(0, 1500));
    }
  }
  return out;
}

// ---------------------------------------------------------------- the frozen oracle, through the mediator
// Every redirection case of #116 (test/bash-oracle-cases.json) in a folder of its own, cwd there: the final
// files, exit and stdout are GNU bash's (test/bash-oracle.json), or exactly the accepted difference
// (test/bash-known.json, D1 D2 D6 D7 D8), or exactly what test/bash-step2-known.json says the host does
// instead.  Stderr where those record it, in the host's words: "bash: <path>: <reason>" (D8 point 2).
async function oracle(check) {
  const { ws, host } = await fresh("oracle");
  const want = new Map(D.oracle.redirections.map((x) => [x.id, x]));
  for (const c of D.cases.redirections) {
    const at = "/" + c.id;
    await ws.mkdir(at);
    for (const [name, content] of Object.entries(D.cases.setup)) await ws.create(`${at}/${name}`, { content: typeof content === "string" ? enc(content) : new Uint8Array(content) });
    const r = await host.exec(PERSON, c.script, { cwd: at });
    const files = {};
    for (const name of D.cases.observe) files[name] = await read(ws, `${at}/${name}`);
    const k = D.known.redirections[c.id], h = D.step2.redirections[c.id];
    const o = want.get(c.id);
    const expected = { exit: o.exit, stdout: o.stdout, files: o.files, ...(k?.differs ?? {}), ...(h?.differs ?? {}) };
    delete expected.calls;
    const hostWords = (s) => s.replace(/ENOENT: (\S+)/g, (_, p) => `bash: ${at}${p}: No such file or directory`);
    if (typeof expected.stderr === "string") expected.stderr = hostWords(expected.stderr);
    const got = { exit: r.kind === "exit" ? r.code : r.kind, stdout: r.kind === "exit" ? text(enc(r.stdout)) : null, files, ...("stderr" in expected ? { stderr: r.stderr } : {}) };
    check(same(got, expected), `oracle ${c.id} (${c.script}): ${same(got, expected) ? "as expected" : `got ${JSON.stringify(got)}, expected ${JSON.stringify(expected)}`}${k ? ` [${k.plan}]` : ""}${h ? ` [${h.plan}]` : ""}`);
  }
}

// ---------------------------------------------------------------- the wrapper's two lexical cases (N-119-3)
// Frozen as accepted differences (plan-bash-step2-wrapper-lexical-r1): through the host's own `{ SCRIPT\n}`,
// an unterminated here-document and a final backslash are refused with status 2 and the parse error.
async function lexical(check) {
  const { host } = await fresh("lexical");
  for (const c of D.step2.lexical) {
    const r = await host.exec(PERSON, c.script);
    const got = { exit: r.code, stdout: r.stdout, stderr: r.stderr };
    check(same(got, c.host), `lexical ${JSON.stringify(c.script)}: ${same(got, c.host) ? "as frozen" : `got ${JSON.stringify(got)}, frozen ${JSON.stringify(c.host)}`} (bash: ${c.bash})`);
  }
}

// ---------------------------------------------------------------- basics
async function basics(check) {
  const { ws, host } = await fresh("basics");
  const before = (await ws.list("/", { recursive: true })).map((e) => e.path).join();
  let r = await host.exec(PERSON, "true");
  check(r.kind === "exit" && r.code === 0 && (await ws.list("/", { recursive: true })).map((e) => e.path).join() === before && (await opsOf(ws)).length === 0, `constructing the shell and running true writes nothing (${JSON.stringify(r)})`);
  r = await host.exec(PERSON, "echo hi > n; cat n; echo x > /dev/null; cat /dev/null");
  check(r.kind === "exit" && r.stdout === "hi\n" && (await read(ws, "/n")) === "hi\n" && !(await ws.stat("/dev")), `a redirection commits, cat reads it back, and /dev/null never reaches the workspace (${JSON.stringify(r)})`);
  check(same(r.ops.map((o) => o.verb + " " + o.path), ["create /n"]), `one op for the redirection: ${JSON.stringify(r.ops)}`);
  r = await host.exec(PERSON, "cat <<EOF\n  indented\nEOF");
  check(r.stdout === "  indented\n", `a here-document keeps its lines' leading whitespace, as bash does (rawScript): ${JSON.stringify(r.stdout)}`);
}
