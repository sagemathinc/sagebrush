// The workspace's admit option (plan-bash-shell r3 §2.3, §9.1: "admit covers every identity"), in a real
// browser: for each verb, admit is asked about every path the grant check needs, holding the lock, before
// anything changes; a grant covering only one of the paths is refused, with nothing changed; a folder grant
// names the folder's fid and follows it; agents never get admit.  Run by test-workspace-admit.mjs.
import * as W from "./ws.js";

const enc = (s) => new TextEncoder().encode(s);
const dec = (b) => new TextDecoder().decode(b);

// A folder grant, as ShellHost's principals make one: admitted if the entry, or a folder above it, is one of the
// granted folders, by fid (design/capabilities.md §6).  `seen` records every check.  The refusal is an object of
// its own, so a test can tell it is what the verb rejected with.
class Refused extends Error {}
function grant(...fids) {
  const g = new Set(fids), seen = [];
  const admit = (c) => {
    seen.push({ op: c.op, role: c.role, path: c.path, entry: c.entry?.path ?? null, chain: c.chain.map((e) => e.path) });
    const ok = c.chain.some((e) => g.has(e.fid)) || (c.entry?.kind === "folder" && g.has(c.entry.fid));
    if (!ok) throw new Refused(`EACCES ${c.path}`);
  };
  return { admit, seen, g };
}

export async function run() {
  const out = [];
  const check = (ok, what) => out.push([!!ok, what]);
  // (a case that throws is a failed check, said, not a lost run)
  try {
    await cases(check);
  } catch (e) {
    check(false, `the cases threw: ${e?.constructor?.name}: ${e?.message}`);
  }
  return out;
}

async function cases(check) {
  localStorage.clear();
  const w = await W.Workspace.open({ name: "admit-cases", mainName: "admit-cases-main" });
  const A = await w.mkdir("/A"), B = await w.mkdir("/B");
  await w.create("/A/f.txt", { content: enc("a") });
  await w.create("/B/g.txt", { content: enc("b") });
  const nOps = async () => (await w.ops()).length;
  // (a refusal: rejects with admit's own object, and the workspace's op log is unchanged)
  async function refused(what, f) {
    const before = await nOps();
    let err = null;
    try { await f(); } catch (e) { err = e; }
    const after = await nOps();
    check(err instanceof Refused && after === before, `${what}: refused with admit's error, nothing logged (${err?.constructor?.name}: ${err?.message}; ops ${before} -> ${after})`);
    return err;
  }

  // ---- stat: present and absent, refused alike (an absent path in B isn't told apart from a present one)
  {
    const a = grant(A.fid);
    check((await w.stat("/A/f.txt", { admit: a.admit }))?.path === "/A/f.txt", "stat in the granted folder answers");
    await refused("stat of a file outside the grant", () => w.stat("/B/g.txt", { admit: a.admit }));
    await refused("stat of an absent path outside the grant", () => w.stat("/B/none.txt", { admit: a.admit }));
    const s = a.seen.find((x) => x.path === "/B/none.txt");
    check(s && s.entry === null && s.chain.join() === "/B", `the absent path's check carries the folders above it: ${JSON.stringify(s)}`);
  }

  // ---- readUpTo
  {
    const a = grant(A.fid);
    check(dec((await w.readUpTo("/A/f.txt", 100, { admit: a.admit })).content) === "a", "readUpTo in the grant reads");
    await refused("readUpTo outside the grant", () => w.readUpTo("/B/g.txt", 100, { admit: a.admit }));
  }

  // ---- list: the folder refused whole; with the top admitted, entries outside the grant left out
  {
    const a = grant(A.fid);
    check((await w.list("/A", { admit: a.admit })).map((e) => e.path).join() === "/A/f.txt", "list of the granted folder");
    await refused("list of a folder outside the grant", () => w.list("/B", { admit: a.admit }));
    const top = (c) => { if (c.path === "/" && c.role === "target") return; a.admit(c); };
    const all = (await w.list("/", { recursive: true, admit: top })).map((e) => e.path).sort();
    check(all.join() === "/A,/A/f.txt", `a recursive list from the top shows only what the grant covers: ${all}`);
  }

  // ---- create: the destination, by the folders above it, including a parent that isn't there yet
  {
    const a = grant(A.fid), b = grant(B.fid);
    await refused("create in a folder outside the grant", () => w.create("/B/new.txt", { content: enc("x"), admit: a.admit }));
    check(!(await w.stat("/B/new.txt")), "nothing made");
    await refused("create under an absent folder outside the grant", () => w.create("/B/sub/new.txt", { content: enc("x"), admit: a.admit }));
    check(!(await w.stat("/B/sub")), "the absent folder isn't made either");
    const e = await w.create("/B/sub/new.txt", { content: enc("x"), admit: b.admit });
    const s = b.seen.find((x) => x.op === "create");
    check(e.path === "/B/sub/new.txt" && s.role === "target" && s.entry === null && s.chain.join() === "/B", `create under an absent folder, granted by the folder above it: ${JSON.stringify(s)}`);
  }

  // ---- mkdir
  {
    const a = grant(A.fid);
    await refused("mkdir outside the grant", () => w.mkdir("/B/d1/d2", { admit: a.admit }));
    check(!(await w.stat("/B/d1")), "no folder made");
    check((await w.mkdir("/A/d1/d2", { admit: a.admit })).path === "/A/d1/d2", "mkdir inside the grant");
  }

  // ---- write
  {
    const a = grant(A.fid);
    await refused("write outside the grant", () => w.write("/B/g.txt", enc("changed"), { admit: a.admit }));
    check(dec((await w.readUpTo("/B/g.txt", 100)).content) === "b", "the file is unchanged");
    const before = (await w.stat("/A/f.txt")).rev;
    check((await w.write("/A/f.txt", enc("a2"), { admit: a.admit })).rev === before + 1, "write inside the grant");
  }

  // ---- rename: both ends; a grant on one of them only is refused, either way round
  {
    const a = grant(A.fid), b = grant(B.fid), ab = grant(A.fid, B.fid);
    await refused("rename into a folder outside the grant (source granted)", () => w.rename("/A/f.txt", "/B/f.txt", { admit: a.admit }));
    await refused("rename out of a folder outside the grant (destination granted)", () => w.rename("/A/f.txt", "/B/f.txt", { admit: b.admit }));
    check((await w.stat("/A/f.txt")) && !(await w.stat("/B/f.txt")), "nothing moved");
    const roles = b.seen.filter((x) => x.op === "rename").map((x) => `${x.role}:${x.path}`);
    check(roles[0] === "source:/A/f.txt", `the source is asked first: ${roles}`);
    await w.rename("/A/f.txt", "/B/f.txt", { admit: ab.admit });
    const both = ab.seen.filter((x) => x.op === "rename").map((x) => `${x.role}:${x.path}`).join();
    check(both === "source:/A/f.txt,destination:/B/f.txt" && (await w.stat("/B/f.txt")), `rename with both ends granted: ${both}`);
    await w.rename("/B/f.txt", "/A/f.txt");
  }

  // ---- duplicate: both ends, the destination once it is chosen
  {
    const a = grant(A.fid), b = grant(B.fid), ab = grant(A.fid, B.fid);
    await refused("duplicate into a folder outside the grant", () => w.duplicate("/A/f.txt", "/B/copy.txt", { admit: a.admit }));
    await refused("duplicate out of a folder outside the grant", () => w.duplicate("/A/f.txt", "/B/copy.txt", { admit: b.admit }));
    check(!(await w.stat("/B/copy.txt")), "no copy made");
    await w.duplicate("/A/f.txt", "/B/copy.txt", { admit: ab.admit });
    const both = ab.seen.filter((x) => x.op === "duplicate").map((x) => `${x.role}:${x.path}`).join();
    check(both === "source:/A/f.txt,destination:/B/copy.txt", `duplicate with both ends granted: ${both}`);
    const c = grant(A.fid);
    await w.duplicate("/A/f.txt", undefined, { admit: c.admit });
    const chosen = c.seen.filter((x) => x.role === "destination").map((x) => x.path);
    check(chosen.length === 1 && chosen[0].startsWith("/A/f (2)"), `a chosen name is asked about too: ${chosen}`);
  }

  // ---- remove
  {
    const a = grant(A.fid);
    await refused("remove outside the grant", () => w.remove("/B/g.txt", undefined, undefined, { admit: a.admit }));
    check(await w.stat("/B/g.txt"), "not moved to Trash");
  }

  // ---- the grant names the folder's fid: it follows a rename, and a folder made again is another
  {
    const a = grant(A.fid);
    await w.rename("/A", "/A2");
    check((await w.create("/A2/after-rename.txt", { content: enc("x"), admit: a.admit })).path === "/A2/after-rename.txt", "a folder grant follows its folder's rename");
    await w.rename("/A2", "/A");
    await w.mkdir("/C");
    const C = await w.stat("/C"), c = grant(C.fid);
    await w.remove("/C");
    await w.mkdir("/C");
    await refused("a folder removed and made again is another: its old grant doesn't cover it", () => w.create("/C/x.txt", { content: enc("x"), admit: c.admit }));
  }

  // ---- what admit is given: the entry there now, by identity
  {
    let seen = null;
    const probe = (c) => { if (c.op === "write") seen = c; };
    const now = await w.stat("/B/g.txt");
    await w.write("/B/g.txt", enc("b2"), { admit: probe });
    check(seen?.entry?.fid === now.fid && seen.entry.rev === now.rev && seen.chain.map((e) => e.fid).join() === B.fid, "write's admit is given the file's entry (fid, rev) and its folder's");
  }

  // ---- the host's alone: an agent's admit is dropped; a bad admit is invalid
  {
    const ag = w.forAgent("agent:test");
    const deny = () => { throw new Refused("never"); };
    check((await ag.create("/B/agent.txt", { content: enc("x"), admit: deny })).path === "/B/agent.txt", "an agent's create ignores admit");
    check((await ag.stat("/B/agent.txt", { admit: deny }))?.path === "/B/agent.txt", "an agent's stat ignores admit");
    check((await ag.list("/B", { admit: deny })).length >= 1, "an agent's list ignores admit");
    await ag.rename("/B/agent.txt", "/B/agent2.txt", { admit: deny });
    check(await w.stat("/B/agent2.txt"), "an agent's rename ignores admit");
    let bad = null;
    try { await w.stat("/A", { admit: "yes" }); } catch (e) { bad = e; }
    check(bad instanceof W.WorkspaceError && bad.code === "invalid", `a non-function admit is invalid: ${bad?.code}`);
  }
  w.close();
}
