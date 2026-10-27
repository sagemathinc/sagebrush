// ShellHost's cases (plan-bash-shell r3 §9 step 2, addendum D8 r3's step-2 tests), run in the page by
// test-shell-host.mjs: the real shell module in its worker, a real Workspace, and ShellHost between them.
import { startShell, ShellHost, MAX_PENDING, STOP_GRACE_MS as HOST_GRACE, boundedJson, TooLarge, W } from "/host-bundle.js";
// (r3 §4.3's grace, as the plan says it: the host's constant is checked against it, never taken as the truth)
const STOP_GRACE_MS = 2000;

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
async function fresh(name, { start, wrap, limits, readBytes } = {}) {
  localStorage.clear();
  const ws = await W.Workspace.open({ name: `host-${name}-${++nth}`, mainName: `host-${name}-main-${nth}`, ...(limits ? { limits } : {}) });
  const host = new ShellHost(wrap ? wrap(ws) : ws, start ?? ((signal) => startShell(D.S, "/", { signal }).then((x) => x.shell)), readBytes ? { readBytes } : {});
  return { ws, host };
}
// A view of `ws` for the host whose verbs first run `hooks[verb](...args)` if one is set: only for the host's
// own call, not for the workspace's calls inside it (depth), so a hook is one concurrent event or one fault.
const VERBS = ["stat", "list", "readUpTo", "read", "write", "create", "mkdir", "rename", "duplicate", "remove"];
function hookable(hooks) {
  return (ws) => {
    const v = Object.create(ws);
    let depth = 0;
    for (const verb of VERBS) v[verb] = async function (...args) {
      const h = depth === 0 ? hooks[verb] : undefined;
      depth++;
      try {
        if (h) await h(...args);
        return await ws[verb].apply(this, args);
      } finally {
        depth--;
      }
    };
    return v;
  };
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
  const groups = { oracle, lexical, basics, identity, grants, classify, provenance, conformance, pending, stop, startup, fence, documents, liveness, listing, actors, boundary, oldShell, frozen, census };
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
  check(r.stdout === "  indented\n", `a here-document keeps its lines' leading whitespace, as bash does: ${JSON.stringify(r.stdout)}`);
}

// ---------------------------------------------------------------- write identity (CORR-BASH-2, §3.2)
async function identity(check) {
  const hooks = {};
  const { ws, host } = await fresh("identity", { wrap: hookable(hooks) });
  const reset = async (p, content) => {
    if (await ws.stat(p)) await ws.remove(p);
    if (content !== undefined) await ws.create(p, { content: enc(content) });
  };
  // a buffered write's target removed and made again, at the same rev, before the commit
  await reset("/f", "old\n");
  hooks.write = async (p, _b, o) => { if (p === "/f" && o?.fid) { delete hooks.write; await ws.remove("/f"); await ws.create("/f", { content: enc("replacement\n") }); } };
  let r = await host.exec(PERSON, "echo new > f");
  check(r.kind === "exit" && r.code === 1 && /\/f: changed elsewhere/.test(r.stderr) && (await read(ws, "/f")) === "replacement\n" && (await ws.stat("/f")).rev === 0, `a replacement at the same rev is ECONFLICT, and left as it is (${JSON.stringify(r)})`);
  // an append from another tab between the open and the commit
  await reset("/f", "old\n");
  hooks.write = async (p, _b, o) => { if (p === "/f" && o?.fid) { delete hooks.write; await ws.write("/f", enc("old\nother tab\n")); } };
  r = await host.exec(PERSON, "echo more >> f");
  check(r.code === 1 && /changed elsewhere/.test(r.stderr) && (await read(ws, "/f")) === "old\nother tab\n", `a concurrent append is ECONFLICT, never interleaved (D3) (${JSON.stringify(r)})`);
  // the one append observation: the file changed between the open's stat and its read
  await reset("/f", "old\n");
  hooks.readUpTo = async (p) => { if (p === "/f") { delete hooks.readUpTo; await ws.write("/f", enc("changed\n")); } };
  r = await host.exec(PERSON, "echo more >> f");
  check(r.code === 1 && /changed elsewhere/.test(r.stderr) && (await read(ws, "/f")) === "changed\n", `an append's observation is one read: a change between the stat and the read is ECONFLICT, never a mixed observation (${JSON.stringify(r)})`);
  // two creators of one absent path: exactly one wins, the other's file untouched
  await reset("/c");
  hooks.create = async (p) => { if (p === "/c") { delete hooks.create; await ws.create("/c", { content: enc("theirs\n") }); } };
  r = await host.exec(PERSON, "echo mine > c");
  check(r.code === 1 && /\/c: changed elsewhere/.test(r.stderr) && (await read(ws, "/c")) === "theirs\n", `of two creators exactly one wins (${JSON.stringify(r)})`);
  // a re-opened append keeps the run's observation: another tab's change between two iterations is ECONFLICT,
  // never taken in (between iteration 1's commit and iteration 2's open: the `cat g` in between)
  await reset("/f", "old\n");
  await reset("/g", "g\n");
  hooks.readUpTo = async (p) => { if (p === "/g") { delete hooks.readUpTo; await ws.write("/f", enc("old\nother tab\n")); } };
  r = await host.exec(PERSON, "for i in 1 2; do echo $i >> f; cat g > /dev/null; done");
  check(r.code === 1 && /changed elsewhere/.test(r.stderr) && (await read(ws, "/f")) === "old\nother tab\n", `a re-opened append isn't observed again: another tab's change between iterations is ECONFLICT (${JSON.stringify(r)})`);
  // a notebook or board is never written
  await ws.create("/nb.ipynb", { content: { cells: [{ cell_type: "code", source: "1" }] } });
  r = await host.exec(PERSON, "echo x > nb.ipynb; echo after");
  const nb = await ws.read("/nb.ipynb");
  check(r.code === 1 && /edit it in its editor/.test(r.stderr) && nb.content.cells.length === 1, `a notebook as a redirection's target is refused (EACCES), unchanged (${JSON.stringify(r)})`);
  r = await host.exec(PERSON, "grep -c cells nb.ipynb");
  check(r.code === 0 && r.stdout === "1\n", `a notebook reads as its JSON text (${JSON.stringify(r)})`);
  // the run's own commits are its observation: appends in a loop pass, one op each; a loop's one redirection, one op
  await reset("/l");
  r = await host.exec(PERSON, "for i in 1 2 3; do echo $i >> l; done");
  check(r.code === 0 && (await read(ws, "/l")) === "1\n2\n3\n" && r.ops.length === 3, `appends in a loop: one op per iteration (${r.ops.length})`);
  await reset("/l");
  r = await host.exec(PERSON, "for i in 1 2 3; do echo $i; done >> l");
  check(r.code === 0 && (await read(ws, "/l")) === "1\n2\n3\n" && r.ops.length === 1, `a loop's one redirection: one op (rule 9) (${r.ops.length})`);
}

// ---------------------------------------------------------------- the mediator's grants (CORR-BASH-1, §2.2)
async function grants(check) {
  const { ws, host } = await fresh("grants");
  const A = await ws.mkdir("/A"), B = await ws.mkdir("/B");
  await ws.create("/A/f", { content: enc("a\n") });
  await ws.create("/B/g", { content: enc("b\n") });
  const grant = (over = {}) => ({ kind: "grant", actor: "agent:test", folders: new Set([A.fid]), write: true, live: () => "ok", ...over });
  const g = grant();
  const ops0 = (await opsOf(ws)).length;
  const runs = {
    "cat /B/g": (r) => r.code !== 0 && r.stdout === "",
    "cat /A/../B/g": (r) => r.code !== 0 && r.stdout === "",
    "echo x > /B/n": (r) => r.code === 1 && /\/B\/n: Permission denied/.test(r.stderr),
    "ls /B": (r) => r.code !== 0 && r.stdout === "",
    "cp /B/g /A/g2": (r) => r.code !== 0,
    "cp /A/f /B/f2": (r) => r.code !== 0,
    "mv /A/f /B/f": (r) => r.code !== 0,
    "mv /B/g /A/g": (r) => r.code !== 0,
    "cp -r /A /B/A2": (r) => r.code !== 0,
    "rm /B/g": (r) => r.code !== 0,
    "mkdir /B/d": (r) => r.code !== 0,
    "touch /B/t": (r) => r.code !== 0,
  };
  for (const [script, ok] of Object.entries(runs)) {
    const r = await host.exec(g, script);
    check(r.kind === "exit" && ok(r), `a grant to /A: ${script} is refused (${JSON.stringify(r).slice(0, 300)})`);
  }
  check((await opsOf(ws)).length === ops0 && (await read(ws, "/B/g")) === "b\n" && (await read(ws, "/A/f")) === "a\n" && !(await ws.stat("/A/g")) && !(await ws.stat("/A/g2")), "and nothing changed: no op logged, both files as they were");
  let r = await host.exec(g, "ls /");
  check(r.code === 0 && r.stdout === "A\n", `ls / shows only what the grant covers (${JSON.stringify(r)})`);
  r = await host.exec(g, "cat /A/f; echo x > /A/n; cat /A/n");
  check(r.code === 0 && r.stdout === "a\nx\n", `inside the grant it reads and writes (${JSON.stringify(r)})`);
  // the grant follows its folder's fid
  await ws.rename("/A", "/A2");
  r = await host.exec(g, "cat /A2/f");
  check(r.code === 0 && r.stdout === "a\n", `the grant follows its folder's rename (${JSON.stringify(r)})`);
  await ws.rename("/A2", "/A");
  // read-only: every mutation EROFS before the verb
  r = await host.exec(grant({ write: false }), "cat /A/f; echo x > /A/ro; echo after");
  check(r.code === 1 && r.stdout === "a\n" && /Read-only/.test(r.stderr) && !(await ws.stat("/A/ro")), `a read-only grant reads, and can't mutate (${JSON.stringify(r)})`);
  // revoked or expired during the run: refused at the next use, the run aborted (row 3), nothing after admitted
  for (const why of ["revoked", "expired"]) {
    let uses = 0;
    const gr = grant({ live: () => (++uses > 2 ? why : "ok") });
    r = await host.exec(gr, `cat /A/f; echo x > /A/${why}1; echo y > /A/${why}2`);
    check(r.kind === "unavailable" && r.row === 3 && r.reason === "access was revoked" && !(await ws.stat(`/A/${why}1`)) && !(await ws.stat(`/A/${why}2`)), `a grant ${why} during the run: row 3, and nothing more admitted (${JSON.stringify(r)})`);
  }
  // the person: the whole workspace; an agent's changes are credited to it
  r = await host.exec(PERSON, "cat /B/g");
  check(r.code === 0 && r.stdout === "b\n", "the person reads anywhere");
  const before = (await opsOf(ws)).length;
  r = await host.exec(grant({ actor: "agent:tester" }), "echo z > /A/byagent");
  const mine = (await opsOf(ws)).slice(before);
  check(r.code === 0 && mine.length === 1 && mine[0].by === "agent:tester", `a grant's actor is the op log's: ${JSON.stringify(mine.map((o) => o.by))}`);
}

// ---------------------------------------------------------------- D8 point 5: rows 1–5, the fence (D8-3)
// For each row, an event injected at the open of /A/fault and at its final write, in four positions: the
// host's group, a subshell, a group, a function, each followed by a write to /A/other.  The outcome is the
// row's type whatever the shell's status, nothing pending is committed, and /A/other is never admitted.  A
// refusal (D8) in the same places stays ordinary.
async function classify(check) {
  const hooks = {};
  const { ws, host } = await fresh("classify", { wrap: hookable(hooks) });
  const A = await ws.mkdir("/A");
  let live = "ok";
  const g = { kind: "grant", actor: "agent:test", folders: new Set([A.fid]), write: true, live: () => live };
  const positions = {
    host: "true > /A/pend; echo x > /A/fault; echo later > /A/other",
    subshell: "true > /A/pend; (echo x > /A/fault); echo later > /A/other",
    group: "true > /A/pend; { echo x > /A/fault; }; echo later > /A/other",
    function: "true > /A/pend; f() { echo x > /A/fault; }; f; echo later > /A/other",
  };
  let run = null;
  const rows = {
    1: () => run.stop(),
    2: () => host.endShell("lost on purpose"),
    3: () => { live = "revoked"; },
    5: () => { throw new TypeError("injected fault"); },
    refusal: () => { throw new W.WorkspaceError("conflict", "/A/fault was changed elsewhere"); },
  };
  for (const [row, act] of Object.entries(rows)) {
    for (const at of ["open", "commit"]) {
      for (const [pos, script] of Object.entries(positions)) {
        for (const p of ["/A/fault", "/A/other", "/A/pend"]) if (await ws.stat(p)) await ws.remove(p);
        await ws.create("/A/pend", { content: enc("kept\n") });
        live = "ok";
        let admittedAfter = 0, stats = 0;
        const fire = async () => { delete hooks.stat; delete hooks.create; await act(); };
        // (at the open: the redirection's own stat, the second of /A/fault; the first is just-bash's exists probe)
        hooks.stat = async (p) => { if (p === "/A/other") admittedAfter++; if (at === "open" && p === "/A/fault" && ++stats === 2) await fire(); };
        hooks.create = async (p) => { if (at === "commit" && p === "/A/fault") await fire(); };
        run = host.run(g);
        const r = await run.invoke(script);
        delete hooks.stat;
        delete hooks.create;
        const other = await ws.stat("/A/other"), pend = await read(ws, "/A/pend");
        const what = `row ${row}, at the ${at}, in the ${pos}: ${JSON.stringify(r).slice(0, 240)}; /A/other ${other ? "written" : "absent"}, /A/pend ${JSON.stringify(pend)}`;
        if (row === "refusal") {
          // (ordinary: the refusal ends the innermost block (D8); the host's group, or the block, then the script goes on)
          const nested = pos !== "host";
          check(r.kind === "exit" && r.code === (nested ? 0 : 1) && !!other === nested && pend === "" && /\/A\/fault: changed elsewhere/.test(r.stderr), `a refusal stays ordinary: ${what}`);
        } else {
          const kind = { 1: "interrupted", 2: "unavailable", 3: "unavailable", 5: "unavailable" }[row];
          check(r.kind === kind && r.row === Number(row) && !other && admittedAfter === 0 && pend === "kept\n", `typed and fenced: ${what}`);
        }
      }
    }
  }
}

// ---------------------------------------------------------------- provenance (D8-3), with a stand-in module
async function provenance(check) {
  const hooks = {};
  const { ws, host } = await fresh("provenance", { wrap: hookable(hooks), start: (signal) => startShell(D.STAND, "/", { signal }).then((x) => x.shell) });
  const missing = { op: "read", args: ["/nodir/x"] };
  const inv = (run, c) => run.invoke(JSON.stringify(c));
  let r = await inv(host.run(PERSON), { steps: [missing], report: "reject-first-refusal" });
  check(r.kind === "exit" && r.code === 1 && r.stdout === "" && r.stderr === "stand-in rejection\n", `a genuine refusal that rejects exec(): ordinary status 1, its output lost (${JSON.stringify(r)})`);
  r = await inv(host.run(PERSON), { steps: [missing], report: "reject-null" });
  check(r.kind === "unavailable" && r.row === 5, `a handled refusal, then a rejection naming none: row 5 (${JSON.stringify(r)})`);
  r = await inv(host.run(PERSON), { steps: [missing], report: "reject-id:0123456789abcdef" });
  check(r.kind === "unavailable" && r.row === 5, `a rejection naming an id that is no refusal of this invocation's: row 5 (${JSON.stringify(r)})`);
  // another invocation's refusal, in the same run
  const run = host.run(PERSON);
  const first = await inv(run, { steps: [missing], report: "exit" });
  check(first.kind === "exit", `(the run's first invocation: ${JSON.stringify(first)})`);
  r = await inv(run, { steps: [], report: "reject-first-refusal" });
  check(r.kind === "unavailable" && r.row === 5, `a rejection with no refusal of its own: row 5 (${JSON.stringify(r)})`);
  // forged run ids are refused, never executed
  let seen = 0;
  hooks.stat = async () => { seen++; };
  hooks.readUpTo = async () => { seen++; };
  r = await inv(host.run(PERSON), { steps: [{ op: "stat", args: ["/"] }, { op: "read", args: ["/x"] }], report: "exit", forge: true });
  delete hooks.stat;
  delete hooks.readUpTo;
  check(r.kind === "exit" && r.stdout === '["EBADF","EBADF"]' && seen === 0, `requests under a fabricated run id are refused (EBADF) and never executed (${JSON.stringify(r)}, ${seen} workspace calls)`);
  // a run that has ended admits nothing
  const ended = host.run(PERSON);
  ended.stop();
  r = await inv(ended, { steps: [{ op: "stat", args: ["/"] }], report: "exit" });
  check(r.kind === "interrupted", `a run stopped before it starts runs nothing (${JSON.stringify(r)})`);
  void ws;
}

// ---------------------------------------------------------------- FS conformance (r3 §3.1, §3.4)
async function conformance(check) {
  const hooks = {};
  const { ws, host } = await fresh("conformance", { wrap: hookable(hooks), limits: { ...W.LIMITS, maxFolderEntries: 40 } });
  const sh = (s) => host.exec(PERSON, s);
  let r = await sh("mkdir a/b");
  check(r.code === 1 && !(await ws.stat("/a")), `mkdir without -p needs the parent (${JSON.stringify(r)})`);
  r = await sh("mkdir -p a/b && mkdir a; echo rc=$?");
  check(r.stdout === "rc=1\n" && (await ws.stat("/a/b"))?.kind === "folder", `mkdir -p makes the parents; mkdir of an existing folder is EEXIST (${JSON.stringify(r)})`);
  await ws.create("/f", { content: enc("f\n") });
  r = await sh("touch f; touch t; ls t");
  check(r.code === 0 && (await ws.stat("/f")).rev === 0 && (await read(ws, "/t")) === "" && r.ops.length === 1, `touch: an existing file unchanged, a new one created (${JSON.stringify(r.ops)})`);
  r = await sh("mv f g; cat g");
  check(r.code === 0 && r.stdout === "f\n" && same(r.ops.map((o) => o.verb), ["rename"]), `mv: one rename op (${JSON.stringify(r.ops)})`);
  r = await sh("mv g t; echo rc=$?");
  check(r.stdout === "rc=1\n" && (await read(ws, "/g")) === "f\n", `mv onto an existing file is refused (mv -f is deferred) (${JSON.stringify(r)})`);
  r = await sh("cp g h; cat h");
  check(r.code === 0 && r.stdout === "f\n" && same(r.ops.map((o) => o.verb), ["duplicate"]), `cp: one duplicate (${JSON.stringify(r.ops)})`);
  await ws.mkdir("/d/e");
  await ws.create("/d/x", { content: enc("x") });
  await ws.create("/d/e/y", { content: enc("y") });
  r = await sh("cp -r d d2; cat d2/e/y");
  check(r.code === 0 && r.stdout === "y" && r.ops.length === 4, `cp -r: exactly F + D ops (2 files, 2 folders: ${JSON.stringify(r.ops.map((o) => o.verb + " " + (o.to ?? o.path)))})`);
  await ws.create("/d/nb.ipynb", { content: { cells: [] } });
  r = await sh("cp -r d d3; echo rc=$?");
  check(r.stdout === "rc=1\n" && !(await ws.stat("/d3")), `cp -r of a folder holding a notebook copies nothing (${JSON.stringify(r)})`);
  r = await sh("rm h; ls /Trash");
  check(r.code !== 0 || true, "(rm)");
  check(!(await ws.stat("/h")) && (await ws.list("/Trash")).some((e) => e.path.startsWith("/Trash/h")), "rm puts the file in Trash");
  r = await sh("rm d2; echo rc=$?; rm -r d2; echo rc=$?");
  check(r.stdout === "rc=1\nrc=0\n" && !(await ws.stat("/d2")), `rm of a folder needs -r; rm -r moves it to Trash, one op (${JSON.stringify(r)})`);
  r = await sh("cat /Trash/h; echo rc=$?; rm -r /; echo rc=$?");
  check(r.stdout === "rc=1\nrc=1\n" && (await ws.stat("/a")), `Trash isn't the shell's, and / can't be removed (${JSON.stringify(r)})`);
  // the workspace's refusals keep their words
  hooks.rename = async () => { delete hooks.rename; throw new W.WorkspaceError("busy", "a large move is still being applied here: try again in a moment"); };
  r = await sh("mv g g2");
  check(r.code === 1 && /large move is still being applied/.test(r.stderr), `busy is EBUSY, said (${JSON.stringify(r)})`);
  r = await sh("mkdir full; for i in $(seq 40); do echo $i > full/f$i; done; echo 41 > full/f41; echo rc=$?");
  check(r.stdout === "" && r.code === 1 && /\/full\/f41: a folder holds at most 40 entries: \/full is full/.test(r.stderr) && (await ws.list("/full")).length === 40, `a full folder (maxFolderEntries): the write one past the cap is ENOSPC, said, and ends the group (D8) (${JSON.stringify(r).slice(0, 300)})`);
  // (touch makes a pending creation, as an open of > does (rule 2): its refusal comes when it is committed, at the end)
  r = await sh("touch full/late; echo rc=$?");
  check(r.stdout === "rc=0\n" && r.code === 1 && /\/full\/late: a folder holds at most 40 entries/.test(r.stderr) && !(await ws.stat("/full/late")), `touch in a full folder: refused at the invocation's end, said, status 1 (${JSON.stringify(r).slice(0, 300)})`);
  // D11: a large folder's mv and rm are one op each, settled before the next request
  const old = { ...W.D11 };
  W.configureD11({ chunk: 10, page: 10 });
  try {
    await ws.mkdir("/big");
    for (let i = 0; i < 25; i++) await ws.create(`/big/f${i}`, { content: enc(String(i)) });
    const n0 = (await opsOf(ws)).length;
    // (the first request after each verb: is the large move's rewrite still under way?)
    const pendingAfter = [];
    let moved = false;
    hooks.rename = async () => { moved = true; };
    hooks.remove = async () => { moved = true; };
    hooks.stat = async () => { if (moved) { moved = false; pendingAfter.push(!!(await W.rewriting(ws.ws))); } };
    r = await sh("mv big big2; ls big2 | wc -l; rm -r big2; ls / | grep -c big");
    delete hooks.rename;
    delete hooks.remove;
    delete hooks.stat;
    check(same(pendingAfter, [false, false]), `mv and rm wait for the large move's rewrite to settle before the next request (${JSON.stringify(pendingAfter)})`);
    const logged = (await opsOf(ws)).slice(n0);
    check(/^\s*25\n0\n$/.test(r.stdout) && same(logged.map((o) => o.op), ["rename", "remove"]) && same(r.ops.map((o) => o.verb), ["rename", "remove"]), `a large mv and a large rm through D11: one op each, settled before the next command (${JSON.stringify(r).slice(0, 300)}; logged ${logged.map((o) => o.op)})`);
  } finally {
    W.configureD11(old);
  }
}

// ---------------------------------------------------------------- EMFILE (r3 §3.3 rule 2)
async function pending(check) {
  const { ws, host } = await fresh("pending");
  const r = await host.exec(PERSON, `mkdir pend; for i in $(seq ${MAX_PENDING + 1}); do true > pend/p$i; done`);
  check(r.code === 1 && /more than 64 redirections are pending/.test(r.stderr) && (await ws.list("/pend")).length === MAX_PENDING, `the 65th pending redirection is EMFILE; the 64 are committed at the end (${JSON.stringify(r).slice(0, 300)})`);
}

// ---------------------------------------------------------------- Stop (r3 §4.3; D8 "Also found")
// The CPU-only loop's Stop comes LOOP_STOP_MS after the loop starts, not at a wall-clock time from exec: the script's
// first command is a file call (`[ -e /m ]`, ws.stat through the host), and the loop starts once it has answered.  So
// the view's stat of /m (the host's own call) records when its answer is ready, and only then schedules the abort: an
// abort while the worker still waits on that answer would test the file-call path instead (and pass, interrupted too).
const LOOP_STOP_MS = 20;
const LOOP = "[ -e /m ]; while true; do :; done";
function loopStart(hooks, then) {
  let t = null;
  const wrap = (ws) => {
    const v = hookable(hooks)(ws);
    const stat = v.stat;
    let depth = 0;
    v.stat = async function (p, ...rest) {
      depth++;
      try {
        return await stat.call(this, p, ...rest);
      } finally {
        if (--depth === 0 && p === "/m" && t === null) {
          t = performance.now();
          then?.();
        }
      }
    };
    return v;
  };
  return { wrap, at: () => t };
}
async function stop(check) {
  const hooks = {};
  let ac = new AbortController();
  let tAbort = null;
  const loop = loopStart(hooks, () => setTimeout(() => ((tAbort = performance.now()), ac.abort()), LOOP_STOP_MS));
  const { ws, host } = await fresh("stop", { wrap: loop.wrap });
  let r = await host.exec(PERSON, LOOP, { signal: ac.signal });
  let t0 = tAbort;
  let ms = performance.now() - (t0 ?? NaN);
  // (the module sees the abort only when its worker takes a message, between macrotasks: in a run, only while it waits
  // for a file call's answer, which the fence refuses after a Stop anyway.  The pinned just-bash itself checks its signal
  // only there.  So a CPU-only loop is ended by just-bash's own default of 100,000 commands in this step, and by the
  // 2 s grace once step 3 passes +Infinity for every own-computation key that is off, plan r3 §5 A; probe in packet r3)
  check(loop.at() !== null && tAbort !== null && tAbort > loop.at(),
    `the CPU-only loop's Stop came after its file call had answered (stat of /m answered at ${loop.at()?.toFixed(1)} ms, Stop at ${tAbort?.toFixed(1)} ms): otherwise it landed during the file call`);
  check(r.kind === "interrupted" && ms < STOP_GRACE_MS + 600,
    `Stop during a CPU-only loop, ${LOOP_STOP_MS} ms into it: interrupted, by the cap or the grace (${JSON.stringify(r)}, ${Math.round(ms)} ms after the Stop)`);
  {
    const { wrap, at: tc } = loopStart({});
    const { host: hc } = await fresh("stop-control", { wrap });
    const rc = await hc.exec(PERSON, LOOP);
    const loopMs = performance.now() - (tc() ?? NaN);
    check(rc.kind === "exit" && rc.code === 126 && /too many commands executed \(>100000\)/.test(rc.stderr),
      `known until step 3: an unstopped CPU-only loop ends at just-bash's default 100,000 commands (${JSON.stringify(rc).slice(0, 200)})`);
    // (the margin the case above needs: the loop must outlast its Stop by far, or the cap could end it first)
    check(loopMs >= 5 * LOOP_STOP_MS,
      `the runner is too fast for the CPU-only Stop case's margin: the loop reached the cap ${Math.round(loopMs)} ms after it started, under ${5 * LOOP_STOP_MS} ms (5x its Stop at ${LOOP_STOP_MS} ms)`);
  }
  r = await host.exec(PERSON, "echo fresh");
  check(r.kind === "exit" && r.stdout === "fresh\n", `and the next run works (${JSON.stringify(r)})`);
  ac = new AbortController();
  setTimeout(() => ac.abort(), 300);
  t0 = performance.now();
  r = await host.exec(PERSON, "i=0; while true; do echo $i >> n; i=$((i+1)); done", { signal: ac.signal });
  ms = performance.now() - t0;
  const n = (await opsOf(ws)).length;
  // (Stop latches the fence, so the loop's next append is refused: it ends within a request, abort or not)
  check(r.kind === "interrupted" && ms < 1500, `Stop during a loop of appends ends it at once (${Math.round(ms)} ms)`);
  await new Promise((res) => setTimeout(res, 300));
  check(r.kind === "interrupted" && (await opsOf(ws)).length === n, `Stop during a loop of appends: interrupted, and nothing admitted after it (${JSON.stringify(r).slice(0, 200)})`);
  // a shell that doesn't unwind (a stand-in that never answers): the worker is ended after the 2 s grace
  const { host: h2 } = await fresh("stop-grace", { start: (signal) => startShell(D.STAND, "/", { signal }).then((x) => x.shell) });
  ac = new AbortController();
  setTimeout(() => ac.abort(), 300);
  t0 = performance.now();
  r = await h2.exec(PERSON, JSON.stringify({ steps: [], report: "hang" }), { signal: ac.signal });
  ms = performance.now() - t0;
  check(r.kind === "interrupted" && ms >= STOP_GRACE_MS && ms < STOP_GRACE_MS + 600, `a shell that doesn't unwind within 2 s: its worker ended at the grace, interrupted (${JSON.stringify(r)}, ${Math.round(ms)} ms after a Stop at 300 ms)`);
  r = await h2.exec(PERSON, JSON.stringify({ steps: [], report: "exit" }));
  check(r.kind === "exit" && r.stdout === "[]", `and the next run gets a fresh worker (${JSON.stringify(r)})`);
}

// ---------------------------------------------------------------- r2: Stop covers startup (CORR-BASH-S2-1, LIMIT-BASH-S2-1)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// A start of the real shell after `delay` ms (or never), each shell counted: its exec calls and its end.
function counted(delay) {
  const c = { starts: 0, dispatched: 0, ended: 0, shells: [], signals: [] };
  // (this start ignores its signal, as a start that can't be cancelled would: the host must still end what comes)
  c.start = async (signal) => {
    c.starts++;
    c.signals.push(signal);
    if (delay === Infinity) await new Promise(() => {});
    await sleep(delay);
    const { shell } = await startShell(D.S, "/");
    const w = {
      S: shell.S, version: shell.version, hostReq: shell.hostReq,
      get state() { return shell.state; },
      exec: (...a) => { c.dispatched++; return shell.exec(...a); },
      terminate: () => { c.ended++; shell.terminate(); },
    };
    c.shells.push(w);
    return w;
  };
  return c;
}
async function startup(check) {
  check(HOST_GRACE === STOP_GRACE_MS, `the host's Stop grace is r3 §4.3's 2 s (${HOST_GRACE} ms)`);
  const stopAt = (ms) => { const ac = new AbortController(); setTimeout(() => ac.abort(), ms); return ac.signal; };
  // a start that never answers: settled at the grace, nothing dispatched
  {
    const c = counted(Infinity);
    const { host } = await fresh("start-never", { start: c.start });
    const t0 = performance.now();
    const r = await host.exec(PERSON, "echo never", { signal: stopAt(300) });
    const ms = performance.now() - t0;
    check(r.kind === "interrupted" && c.dispatched === 0 && ms >= 300 + STOP_GRACE_MS - 50 && ms < 300 + STOP_GRACE_MS + 600, `Stop during a start that never answers: interrupted at the grace, nothing dispatched (${JSON.stringify(r)}, ${Math.round(ms)} ms, ${c.dispatched} dispatched)`);
    check(c.signals.length === 1 && c.signals[0].aborted, `...and its start's signal is aborted at the grace (${c.signals.map((x) => x.aborted)})`);
  }
  // a real start whose worker never says ready: the grace cancels it, and its worker is ended (the page's
  // count of live workers); the next run's start is another, with its own signal, and runs
  {
    const signals = [];
    const start = (signal) => (signals.push(signal), startShell(signals.length === 1 ? D.NEVER : D.S, "/", { signal }).then((x) => x.shell));
    const { host } = await fresh("start-never-real", { start });
    const before = { ...window.workers };
    let r = await host.exec(PERSON, "echo never", { signal: stopAt(300) });
    await sleep(100);
    const after = { ...window.workers };
    check(r.kind === "interrupted" && signals[0].aborted && after.made === before.made + 1 && after.live === before.live,
      `Stop during a real start that never gets ready: interrupted at the grace, its signal aborted, its worker ended (${JSON.stringify(r)}, workers ${JSON.stringify(before)} -> ${JSON.stringify(after)})`);
    r = await host.exec(PERSON, "echo next");
    check(r.kind === "exit" && r.stdout === "next\n" && signals.length === 2 && !signals[1].aborted && window.workers.live === after.live + 1,
      `the next run starts a fresh worker, its own signal untouched by the first's abort (${JSON.stringify(r)}, ${signals.map((x) => x.aborted)})`);
    host.endShell("the case is over");
    check(window.workers.live === after.live, `and ending it ends that worker (${window.workers.live} live)`);
  }
  // a real start whose fetch never answers: the grace cancels it, and the fetch is closed (the server's count)
  {
    const { host } = await fresh("start-hang", { start: (signal) => startShell(D.HANG, "/", { signal }).then((x) => x.shell) });
    const before = { ...window.workers };
    const r = await host.exec(PERSON, "echo hang", { signal: stopAt(300) });
    let h = null;
    for (let i = 0; i < 40; i++) {
      h = await (await fetch("/hang-state")).json();
      if (h.open === 0) break;
      await sleep(50);
    }
    check(r.kind === "interrupted" && h.total === 1 && h.open === 0 && window.workers.made === before.made,
      `Stop during a start whose fetch never answers: interrupted, the fetch closed, no worker made (${JSON.stringify(r)}, ${JSON.stringify(h)})`);
  }
  // a start that answers after the grace: settled at the grace; the late worker is ended when it comes, never installed
  {
    const c = counted(3000);
    const { host } = await fresh("start-late", { start: c.start });
    const t0 = performance.now();
    let r = await host.exec(PERSON, "echo late", { signal: stopAt(300) });
    const ms = performance.now() - t0;
    check(r.kind === "interrupted" && c.dispatched === 0 && ms < 300 + STOP_GRACE_MS + 600, `Stop during a start that comes late: interrupted at the grace (${Math.round(ms)} ms)`);
    await sleep(3500 - ms);
    check(c.shells.length === 1 && c.ended === 1 && c.shells[0].state === "closed" && c.dispatched === 0, `the late worker is ended when it comes, and runs nothing (${c.ended} ended, ${c.dispatched} dispatched)`);
    r = await host.exec(PERSON, "echo next");
    check(r.kind === "exit" && r.stdout === "next\n" && c.starts === 2, `the next run starts a fresh shell (${c.starts} starts)`);
  }
  // a start that answers within the grace: settled as it comes, not dispatched; that worker is ended
  {
    const c = counted(800);
    const { host } = await fresh("start-within", { start: c.start });
    const t0 = performance.now();
    const r = await host.exec(PERSON, "echo within", { signal: stopAt(300) });
    const ms = performance.now() - t0;
    check(r.kind === "interrupted" && c.dispatched === 0 && c.ended === 1 && ms < 1500, `Stop during a start that answers within the grace: interrupted when it comes, nothing dispatched, its worker ended (${Math.round(ms)} ms)`);
  }
  // an already-aborted signal: nothing started at all
  {
    const c = counted(0);
    const { host } = await fresh("start-aborted", { start: c.start });
    const ac = new AbortController();
    ac.abort();
    const r = await host.exec(PERSON, "echo x", { signal: ac.signal });
    check(r.kind === "interrupted" && c.starts === 0 && c.dispatched === 0, `an already-aborted Stop: interrupted, no start (${c.starts} starts)`);
  }
}

// ---------------------------------------------------------------- r2: the fence per workspace verb (CORR-BASH-S2-2)
// "After its admit": the hook wraps the verb's admit so Stop comes once the verb is admitted, while it runs.
const afterAdmit = (opts, then) => {
  const orig = opts.admit;
  opts.admit = (c) => { orig(c); then(c); };
};
async function fence(check) {
  const hooks = {};
  const { ws, host } = await fresh("fence", { wrap: hookable(hooks) });
  let run;
  // finalization: Stop during the first pending commit: that one finishes, the second is never made
  hooks.create = (p, o) => { if (p === "/a") { delete hooks.create; afterAdmit(o, () => run.stop()); } };
  run = host.run(PERSON);
  let r = await run.invoke("true > a; true > b");
  check(r.kind === "interrupted" && (await ws.stat("/a")) && !(await ws.stat("/b")) && same(r.ops.map((x) => x.path), ["/a"]), `Stop in the first pending commit: /a (admitted) committed, /b not, typed (${JSON.stringify(r)})`);
  // Stop during the last pending commit: it finishes, and the outcome is still typed, never ordinary
  hooks.create = (p, o) => { if (p === "/c") { delete hooks.create; afterAdmit(o, () => run.stop()); } };
  run = host.run(PERSON);
  r = await run.invoke("true > c");
  check(r.kind === "interrupted" && (await ws.stat("/c")), `Stop during the last pending commit: committed, and typed (${JSON.stringify(r)})`);
  // cp -r stopped in its mkdir: the mkdir finishes, no duplicate follows
  await ws.mkdir("/src");
  await ws.create("/src/x", { content: enc("x") });
  await ws.create("/src/y", { content: enc("y") });
  hooks.mkdir = (p, o) => { if (p === "/dst") { delete hooks.mkdir; afterAdmit(o, () => run.stop()); } };
  run = host.run(PERSON);
  r = await run.invoke("cp -r src dst; echo after > after");
  check(r.kind === "interrupted" && (await ws.stat("/dst")) && !(await ws.stat("/dst/x")) && !(await ws.stat("/dst/y")) && !(await ws.stat("/after")), `cp -r stopped in its mkdir: no duplicate after it (${JSON.stringify(r.ops)})`);
  // the flush before a mv: Stop in it, the mv never happens
  hooks.create = (p, o) => { if (p === "/f") { delete hooks.create; afterAdmit(o, () => run.stop()); } };
  run = host.run(PERSON);
  r = await run.invoke("true > f; mv f g");
  check(r.kind === "interrupted" && (await ws.stat("/f")) && !(await ws.stat("/g")), `Stop in the flush before mv: the mv never happens (${JSON.stringify(r.ops)})`);
  // Stop during cp -r's preflight walk: nothing copied
  hooks.list = (p) => { if (p === "/src") { delete hooks.list; run.stop(); } };
  run = host.run(PERSON);
  r = await run.invoke("cp -r src dst2");
  check(r.kind === "interrupted" && !(await ws.stat("/dst2")), `Stop during cp -r's walk: nothing copied (${JSON.stringify(r)})`);
  // a request waiting for the workspace's lock when Stop comes does nothing once it gets it
  let release;
  const held = ws.locked(() => new Promise((res) => (release = res)));
  run = host.run(PERSON);
  const going = run.invoke("echo x > waited");
  await sleep(400);
  run.stop();
  await sleep(100);
  release();
  await held;
  r = await going;
  check(r.kind === "interrupted" && !(await ws.stat("/waited")), `a verb waiting for the lock when Stop comes changes nothing (${JSON.stringify(r)})`);
}

// ---------------------------------------------------------------- r2: document reads (F10; CORR-BASH-S2-3, LIMIT-BASH-S2-2, D3-1)
async function documents(check) {
  // the serializer: exactly JSON.stringify(v, null, 1) + "\n", and it stops at the cap
  const docs = [{ cells: [{ cell_type: "code", source: "print('é')", outputs: [] }], metadata: { k: [1, 2.5, null, true, "x\ny"] } }, { title: "b", nodes: [], empty: {}, list: [] }, { a: undefined, b: () => 1, c: [undefined, 1], d: new Date(0) }];
  for (const d of docs) check(new TextDecoder().decode(boundedJson(d, 1e6)) === JSON.stringify(d, null, 1) + "\n", `boundedJson is JSON.stringify(v, null, 1) + "\\n": ${JSON.stringify(d).slice(0, 60)}`);
  let reads = 0;
  const big = { cells: Array.from({ length: 2000 }, (_, i) => ({ cell_type: "code", source: "x".repeat(100) + i })) };
  const counting = new Proxy(big.cells, { get(t, k) { if (typeof k === "string" && /^\d+$/.test(k)) reads++; return t[k]; } });
  let err = null;
  try { boundedJson({ cells: counting }, 2000); } catch (e) { err = e; }
  check(err instanceof TooLarge && reads > 0 && reads < 50, `over the cap, the walk stops there: ${reads} of 2000 cells read before TooLarge`);
  // a document over the shell's read cap is refused (EFBIG), never read out whole
  const { ws, host } = await fresh("documents", { readBytes: 2000 });
  await ws.create("/nb.ipynb", { content: big });
  // (and its whole text is never made: no JSON.stringify in the page produces more than a cell's worth meanwhile)
  const stringify = JSON.stringify;
  let longest = 0;
  JSON.stringify = function (...a) { const t = stringify.apply(this, a); if (typeof t === "string") longest = Math.max(longest, t.length); return t; };
  let r;
  try {
    r = await host.exec(PERSON, "wc -c < nb.ipynb");
  } finally {
    JSON.stringify = stringify;
  }
  check(r.kind === "exit" && r.code === 1 && r.stdout === "" && longest < 2000, `a notebook over the read cap isn't read, nor serialized whole (the longest JSON text made meanwhile: ${longest} chars) (${JSON.stringify(r).slice(0, 200)})`);
  // (just-bash words every input error as missing; the host's own answer, through the stand-in, is EFBIG)
  const { ws: w1, host: h1 } = await fresh("documents-cap", { readBytes: 2000, start: (signal) => startShell(D.STAND, "/", { signal }).then((x) => x.shell) });
  await w1.create("/nb.ipynb", { content: big });
  r = await h1.run(PERSON).invoke(JSON.stringify({ steps: [{ op: "read", args: ["/nb.ipynb"] }], report: "exit" }));
  check(r.kind === "exit" && r.stdout === '["EFBIG"]', `the host answers a read of it EFBIG (${JSON.stringify(r)})`);
  await ws.create("/small.board.json", { content: { title: "s", nodes: [] } });
  r = await host.exec(PERSON, "cat small.board.json");
  check(r.code === 0 && r.stdout === JSON.stringify((await ws.read("/small.board.json")).content, null, 1) + "\n", `a board under the cap reads as its JSON text (${JSON.stringify(r).slice(0, 160)})`);
  // revoked between the host's stat and the document's read: no bytes, row 3
  const hooks = {};
  const { ws: w2, host: h2 } = await fresh("documents-race", { wrap: hookable(hooks) });
  const A = await w2.mkdir("/A");
  await w2.create("/A/nb.ipynb", { content: { cells: [{ cell_type: "code", source: "SECRET" }] } });
  let live = "ok";
  const g = { kind: "grant", actor: "agent:test", folders: new Set([A.fid]), write: true, live: () => live };
  hooks.read = (p) => { if (p === "/A/nb.ipynb") { delete hooks.read; live = "revoked"; } };
  r = await h2.exec(g, "cat /A/nb.ipynb");
  check(r.kind === "unavailable" && r.row === 3 && !JSON.stringify(r).includes("SECRET"), `revoked between the stat and the read: row 3, no bytes (${JSON.stringify(r)})`);
}

// ---------------------------------------------------------------- r2: liveness on every path, write and kind at the commit (CORR-BASH-S2-3)
async function liveness(check) {
  const hooks = {};
  const { ws, host } = await fresh("liveness", { wrap: hookable(hooks) });
  const A = await ws.mkdir("/A");
  let live = "ok", write = true;
  const g = { kind: "grant", actor: "agent:test", folders: new Set([A.fid]), get write() { return write; }, live: () => live };
  // the top's fast path: a revoked grant's `test -d /` is row 3
  live = "revoked";
  let r = await host.exec(g, "test -d / && echo y");
  check(r.kind === "unavailable" && r.row === 3, `stat of the top with a revoked grant: row 3 (${JSON.stringify(r)})`);
  // (one request at a time, through the stand-in: stat of the top, and exists of the top)
  for (const op of ["stat", "exists"]) {
    const { host: hs } = await fresh("liveness-" + op, { start: (signal) => startShell(D.STAND, "/", { signal }).then((x) => x.shell) });
    const gr = { kind: "grant", actor: "agent:test", folders: new Set([A.fid]), write: true, live: () => "revoked" };
    const q = await hs.run(gr).invoke(JSON.stringify({ steps: [{ op, args: ["/"] }], report: "exit" }));
    check(q.kind === "unavailable" && q.row === 3, `${op} of the top alone, with a revoked grant: row 3 (${JSON.stringify(q)})`);
  }
  // a pending path's fast path: revoked after the open, the next probe of it is row 3
  live = "ok";
  hooks.stat = (p, o) => { if (p === "/A/p") { delete hooks.stat; afterAdmit(o, () => (live = "revoked")); } };
  r = await host.exec(g, "true > /A/p; test -e /A/p && echo y");
  check(r.kind === "unavailable" && r.row === 3 && !(await ws.stat("/A/p")), `a pending path probed after a revocation: row 3, nothing committed (${JSON.stringify(r)})`);
  // write withdrawn between the open and the commit: refused at the commit
  live = "ok";
  hooks.create = (p) => { if (p === "/A/w") { delete hooks.create; write = false; } };
  r = await host.exec(g, "echo x > /A/w");
  check(r.kind === "exit" && r.code === 1 && r.stderr === "bash: /A/w: Read-only file system (this shell may only read)\n" && !(await ws.stat("/A/w")), `write withdrawn between the open and the commit: refused at the commit, once (${JSON.stringify(r)})`);
  write = true;
  // revoked at the final flush of a pending creation: row 3, not 5
  hooks.create = (p) => { if (p === "/A/z") { delete hooks.create; live = "revoked"; } };
  r = await host.exec(g, "true > /A/z");
  check(r.kind === "unavailable" && r.row === 3 && !(await ws.stat("/A/z")), `revoked at the final commit: row 3 (${JSON.stringify(r)})`);
  live = "ok";
  // a copy's source replaced after the walk: the duplicate's own admit refuses it
  await ws.mkdir("/A/src");
  await ws.create("/A/src/x", { content: enc("x") });
  hooks.duplicate = async (p) => { if (p === "/A/src/x") { delete hooks.duplicate; await ws.remove("/A/src/x"); await ws.mkdir("/A/src/x"); } };
  r = await host.exec(g, "cp -r /A/src /A/dst");
  check(r.kind === "exit" && r.code === 1 && !(await ws.stat("/A/dst/x")), `a copy's source replaced by a folder after the walk isn't duplicated (${JSON.stringify(r)})`);
}

// ---------------------------------------------------------------- r2: listing filters only what is out of scope (D3-2, sync-client's note)
async function listing(check) {
  const hooks = {};
  const { ws, host } = await fresh("listing", { wrap: hookable(hooks) });
  const A = await ws.mkdir("/A");
  await ws.create("/A/one", { content: enc("1") });
  await ws.mkdir("/A/sub");
  await ws.create("/A/sub/two", { content: enc("2") });
  let live = "ok", fault = false;
  const g = { kind: "grant", actor: "agent:test", folders: new Set([A.fid]), write: true, live: () => { if (fault) throw new TypeError("a fault in the check"); return live; } };
  // revoked during the children's checks: row 3, never a shorter listing
  hooks.list = (p, o) => { delete hooks.list; afterAdmit(o, (c) => { if (c.role === "target") live = "revoked"; }); };
  let r = await host.exec(g, "ls /A");
  check(r.kind === "unavailable" && r.row === 3, `revoked during ls's child checks: row 3 (${JSON.stringify(r)})`);
  live = "ok";
  hooks.list = (p, o) => { delete hooks.list; afterAdmit(o, (c) => { if (c.role === "target") fault = true; }); };
  r = await host.exec(g, "ls /A");
  fault = false;
  check(r.kind === "unavailable" && r.row === 5, `a fault in ls's child checks: row 5 (${JSON.stringify(r)})`);
  // the same in cp -r's walk: and no destination made
  hooks.list = (p, o) => { delete hooks.list; afterAdmit(o, (c) => { if (c.role === "target") live = "revoked"; }); };
  r = await host.exec(g, "cp -r /A/sub /A/sub2");
  check(r.kind === "unavailable" && r.row === 3 && !(await ws.stat("/A/sub2")), `revoked during cp -r's walk: row 3, nothing made (${JSON.stringify(r)})`);
  live = "ok";
  hooks.list = (p, o) => { delete hooks.list; afterAdmit(o, (c) => { if (c.role === "target") fault = true; }); };
  r = await host.exec(g, "cp -r /A/sub /A/sub3");
  fault = false;
  check(r.kind === "unavailable" && r.row === 5 && !(await ws.stat("/A/sub3")), `a fault during cp -r's walk: row 5, nothing made (${JSON.stringify(r)})`);
}

// ---------------------------------------------------------------- r2: attribution is explicit (ID-BASH-STEP2-D3-1)
async function actors(check) {
  const { ws, host } = await fresh("actors");
  const A = await ws.mkdir("/A");
  const base = { kind: "grant", folders: new Set([A.fid]), write: true, live: () => "ok" };
  for (const actor of [undefined, "", "bob", "agent:", "agent:a b", "Person"]) {
    let err = null;
    try { await host.exec({ ...base, ...(actor === undefined ? {} : { actor }) }, "echo x > /A/never"); } catch (e) { err = e; }
    check(err instanceof TypeError && !(await ws.stat("/A/never")), `a grant whose actor is ${JSON.stringify(actor)} is refused before any work (${err?.message})`);
  }
  const before = (await opsOf(ws)).length;
  await host.exec({ ...base, actor: "person" }, "echo p > /A/byperson");
  await host.exec({ ...base, actor: "agent:claude-1" }, "echo a > /A/byagent");
  const by = (await opsOf(ws)).slice(before).map((o) => `${o.path} ${o.by}`);
  check(same(by, ["/A/byperson person", "/A/byagent agent:claude-1"]), `the op log's author is the grant's actor, exactly: ${JSON.stringify(by)}`);
}

// ---------------------------------------------------------------- r2: each invocation ends clean (F9; CORR-BASH-S2-4)
async function boundary(check) {
  const hooks = {};
  const { ws, host } = await fresh("boundary", { wrap: hookable(hooks) });
  // a pending creation refused at the end (another creator won): the next invocation sees the winner, no retry
  let creates = 0;
  hooks.create = async (p) => { if (p === "/a") { creates++; if (creates === 1) await ws.create("/a", { content: enc("theirs\n") }); } };
  const run = host.run(PERSON);
  let r = await run.invoke("true > a");
  check(r.kind === "exit" && r.code === 1 && /\/a: changed elsewhere/.test(r.stderr), `invocation 1: the pending creation is refused at its end (${JSON.stringify(r)})`);
  r = await run.invoke("cat a");
  check(r.kind === "exit" && r.code === 0 && r.stdout === "theirs\n" && creates === 1, `invocation 2 reads the winner's bytes, and nothing is tried again (${JSON.stringify(r)}, ${creates} creates)`);
  delete hooks.create;
  // a pending truncation refused at the end (changed elsewhere): the next invocation reads the file as it is
  await ws.create("/f", { content: enc("old\n") });
  let writes = 0;
  hooks.write = async (p, b, o) => { if (p === "/f" && o?.admit) { writes++; if (writes === 1) await ws.write("/f", enc("new\n")); } };
  r = await run.invoke("true > f");
  check(r.kind === "exit" && r.code === 1 && /\/f: changed elsewhere/.test(r.stderr), `invocation 3: the pending truncation is refused at its end (${JSON.stringify(r)})`);
  r = await run.invoke("cat f");
  check(r.code === 0 && r.stdout === "new\n" && writes === 1, `invocation 4 reads the file as it is, and nothing is tried again (${JSON.stringify(r)}, ${writes} writes)`);
  delete hooks.write;
  // observations don't carry over: another writer between two invocations isn't a conflict (each is its own bash -c)
  await ws.create("/g", { content: enc("x\n") });
  r = await run.invoke("echo a >> g");
  await ws.write("/g", enc("y\n"));
  r = await run.invoke("echo b >> g");
  check(r.code === 0 && (await read(ws, "/g")) === "y\nb\n", `an append in a later invocation opens the file afresh (${JSON.stringify(r)}, g ${JSON.stringify(await read(ws, "/g"))})`);
  // (F7) a pending creation is visible to the rest of its own invocation
  r = await run.invoke("touch t; test -e t && echo y; ls t");
  check(r.code === 0 && r.stdout === "y\nt\n" && (await ws.stat("/t")), `a new touch is seen by later commands of the invocation, and committed at its end (${JSON.stringify(r)})`);
}

// ---------------------------------------------------------------- r2: an old shell is refused on the workspace (F12; CORR-BASH-S2-5)
async function oldShell(check) {
  let dispatched = 0;
  const { ws, host } = await fresh("old-shell", { start: (signal) => startShell(D.OLD, "/", { signal }).then(({ shell }) => ({ S: shell.S, version: shell.version, hostReq: shell.hostReq, get state() { return shell.state; }, exec: (...a) => { dispatched++; return shell.exec(...a); }, terminate: () => shell.terminate() })) });
  const r = await host.exec(PERSON, "echo x > n");
  check(r.kind === "unavailable" && r.row === 2 && /older shell; update the set/.test(r.reason) && dispatched === 0 && !(await ws.stat("/n")), `a 0.1.0 shell (host_req 1) is refused before dispatch on the workspace (${JSON.stringify(r)})`);
  // (the loader alone still starts it: the refusal is the workspace surface's, not the loader's)
  const { shell } = await startShell(D.OLD, "/");
  check(shell.hostReq === 1 && shell.version === "0.1.0", `the loader still starts it standalone (host_req ${shell.hostReq}, ${shell.version})`);
  shell.terminate();
  const { shell: cur } = await startShell(D.S, "/");
  check(cur.hostReq === 2, `the current shell's verified host_req is 2 (${cur.hostReq})`);
  cur.terminate();
}

// ---------------------------------------------------------------- grader's G-S2-1: the host's own accepted differences, exactly
// Each row of test/bash-step2-known.json's "host", run through ShellHost and compared on exit, stdout and stderr.
// A row with no "frozen" yet is reported with what the host gives, to freeze.
async function frozen(check) {
  for (const row of D.step2.host) {
    const { ws, host } = await fresh("frozen-" + row.id, row.id === "touch-full-and" ? { limits: { ...W.LIMITS, maxFolderEntries: 40 } } : {});
    await ws.create("/g", { content: enc("g\n") });
    await ws.create("/t", { content: enc("t\n") });
    let principal = PERSON;
    if (row.id === "touch-full-and") {
      await ws.mkdir("/full");
      for (let i = 1; i <= 40; i++) await ws.create(`/full/f${i}`, { content: enc("") });
    }
    if (row.principal === "grant-A") {
      const A = await ws.mkdir("/A");
      await ws.mkdir("/B");
      await ws.create("/B/g", { content: enc("secret\n") });
      principal = { kind: "grant", actor: "agent:test", folders: new Set([A.fid]), write: true, live: () => "ok" };
    }
    const r = await host.exec(principal, row.script);
    const got = { exit: r.kind === "exit" ? r.code : r.kind, stdout: r.stdout, stderr: r.stderr };
    if (!row.frozen) check(false, `RECORD host ${row.id}: ${JSON.stringify(got)}`);
    else check(same(got, row.frozen), `host ${row.id} (${row.script}): ${same(got, row.frozen) ? "as frozen" : `got ${JSON.stringify(got)}, frozen ${JSON.stringify(row.frozen)}`} [${row.plan}]`);
  }
}

// ---------------------------------------------------------------- grader's G-S2-2: a missing-path and refused-path census per command
async function census(check) {
  const { ws, host } = await fresh("census");
  await ws.mkdir("/cen");
  await ws.create("/cen/f", { content: enc("f\n") });
  const A = await ws.mkdir("/A");
  await ws.create("/A/f", { content: enc("f\n") });
  await ws.mkdir("/B");
  await ws.create("/B/secret", { content: enc("secret\n") });
  const g = { kind: "grant", actor: "agent:test", folders: new Set([A.fid]), write: true, live: () => "ok" };
  // (by script: a command may have more than one refused row, as rm has for a path that exists and one that doesn't)
  const recorded = new Map((D.step2.census.refused ?? []).map((x) => [x.script, x]));
  const exercised = new Set();
  for (const b of D.step2.census.baseline) {
    // missing, as the person: what step 1 showed on InMemoryFs (grader's baseline), exactly
    const r = await host.exec(PERSON, b.script, { cwd: "/cen" });
    const got = { stderr: r.stderr, exit: r.code };
    if (b.stderr === null) check(!!b.frozen && same(got, b.frozen), `census missing ${b.command}: ${JSON.stringify(got)}${b.frozen ? ` (frozen ${JSON.stringify(b.frozen)})` : " RECORD"}`);
    else check(same(got, { stderr: b.stderr, exit: b.exit }), `census missing ${b.command} (${b.script}): ${same(got, { stderr: b.stderr, exit: b.exit }) ? "as in step 1" : `got ${JSON.stringify(got)}, step 1 ${JSON.stringify({ stderr: b.stderr, exit: b.exit })}`}`);
    // refused: the same command on a path outside a grant, recorded
    const script = b.script.replace(/\bmissing\b/, "/B/secret").replace(/ f$/, " /A/f");
    const q = await host.exec(g, script, { cwd: "/A" });
    const gotR = { script, stderr: q.stderr, exit: q.code };
    const want = recorded.get(script);
    exercised.add(script);
    if (!want || want.command !== b.command) check(false, `RECORD census refused ${b.command}: ${JSON.stringify(gotR)}`);
    else check(same(gotR, { script: want.script, stderr: want.stderr, exit: want.exit }), `census refused ${b.command} (${script}): ${same(gotR, { script: want.script, stderr: want.stderr, exit: want.exit }) ? "as recorded" : `got ${JSON.stringify(gotR)}, recorded ${JSON.stringify(want)}`}`);
  }
  // the other recorded rows (rm of an absent path outside the grant), each run as recorded
  for (const [script, want] of recorded) {
    if (exercised.has(script)) continue;
    const q = await host.exec(g, script, { cwd: "/A" });
    const gotR = { script, stderr: q.stderr, exit: q.code };
    check(same(gotR, { script: want.script, stderr: want.stderr, exit: want.exit }), `census refused ${want.command} (${script}): ${same(gotR, { script, stderr: want.stderr, exit: want.exit }) ? "as recorded" : `got ${JSON.stringify(gotR)}, recorded ${JSON.stringify(want)}`}`);
  }
  // rm tells nothing about what exists outside the grant: an absent path's refusal is an existing one's, its name aside
  const gone = recorded.get("rm /B/nosuch"), there = recorded.get("rm /B/secret");
  check(!!gone && !!there && gone.exit === there.exit && gone.stderr === there.stderr.replaceAll("/B/secret", "/B/nosuch"),
    `rm of an absent and an existing path outside the grant: the same words and status (${JSON.stringify(gone)}, ${JSON.stringify(there)})`);
}
