// ci: web-browser/notebook order=227 runner=bun
// The file shim's mediated mode (web/shims/fs.ts mediate(); PR 3a (b1) design r4 §3), against a fake page that keeps
// files with an identity (fid) and a revision, answering synchronously as the file channel would.  Checks:
// - only the exact scratch roots stay local: /tmp, /tmp/a, /$pyjs/x; /tmpx, /tmp2, /w/tmp and /$pyjsx reach the page;
// - every read is a request: a change between two reads of one descriptor is seen;
// - a create or a truncation (even to zero bytes) is a change the page must commit; refused, nothing changes;
// - a positional write over a stale revision is refused (ESTALE), the page's bytes unchanged; an append keeps bytes
//   written elsewhere meanwhile and adds at the current end; a descriptor whose file was replaced is refused (EBADF);
// - a refused rename moves nothing; a write before an exception persists; mounts are refused;
// - a Stop on the channel ends the program by the runner's own cancel, never an ordinary error.
//   bun web/test-term-fs.mjs
import { join } from "node:path";

const here = new URL(".", import.meta.url).pathname;
const fs = await import(join(here, "shims", "fs.ts"));
let failures = 0;
const ok = (cond, name) => {
  console.log((cond ? "ok   " : "FAIL ") + name);
  if (!cond) failures++;
};
const enc = new TextEncoder(), dec = new TextDecoder();

// ---- the fake page: files {fid, rev, bytes}, folders; every request recorded
let nextFid = 1;
const page = { files: new Map(), folders: new Set(["/", "/w"]), log: [], refuse: new Set(), cancelled: false };
const fileAt = (p, bytes) => page.files.set(p, { fid: "f" + nextFid++, rev: 1, bytes });
class Refused extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}
const parent = (p) => p.slice(0, p.lastIndexOf("/")) || "/";
function request(h, opts = {}) {
  const { op, args } = h;
  page.log.push(op + " " + (args.path ?? args.from ?? ""));
  if (page.cancelled) throw Object.assign(new Error("stopped"), { cancelled: true });
  if (page.refuse.has(op)) throw new Refused("EACCES", `${args.path ?? args.from}: Permission denied`);
  const f = page.files.get(args.path);
  switch (op) {
    case "stat":
      if (f) return { json: { kind: "file", size: f.bytes.length, mtime: 1, fid: f.fid, rev: f.rev } };
      if (page.folders.has(args.path)) return { json: { kind: "folder", size: 0, mtime: 1, fid: "d:" + args.path, rev: 0 } };
      throw new Refused("ENOENT", `${args.path}: No such file or directory`);
    case "list":
      return { json: [...page.files.keys(), ...page.folders].filter((k) => k !== args.path && parent(k) === args.path).map((k) => k.slice(args.path.length + (args.path === "/" ? 0 : 1))) };
    case "open":
      if (!f) throw new Refused("ENOENT", `${args.path}: No such file or directory`);
      return { json: { fid: f.fid, rev: f.rev, size: f.bytes.length } };
    case "openw": {
      if (!f && !args.create) throw new Refused("ENOENT", `${args.path}: No such file or directory`);
      if (!f) fileAt(args.path, new Uint8Array(0));
      const g = page.files.get(args.path);
      if (args.trunc) (g.bytes = new Uint8Array(0)), g.rev++;
      return { json: { fid: g.fid, rev: g.rev } };
    }
    case "read": {
      const g = [...page.files.values()].find((x) => x.fid === args.fid);
      if (!g) throw new Refused("EBADF", "the file was removed");
      return { bytes: g.bytes.slice(args.pos, args.pos + args.max) };
    }
    case "write": {
      const body = opts.body;
      if (args.mode === "replace") {
        if (!f) fileAt(args.path, body);
        else (f.bytes = body), f.rev++;
        const g = page.files.get(args.path);
        return { json: { fid: g.fid, rev: g.rev, size: g.bytes.length } };
      }
      const g = [...page.files.entries()].find(([, x]) => x.fid === args.fid);
      if (args.fid !== undefined && !g) throw new Refused("EBADF", "the file was replaced or removed");
      const x = g ? g[1] : f;
      if (args.mode === "append") {
        const out = new Uint8Array(x.bytes.length + body.length);
        out.set(x.bytes), out.set(body, x.bytes.length);
        x.bytes = out, x.rev++;
        return { json: { fid: x.fid, rev: x.rev, size: out.length } };
      }
      if (x.rev !== args.rev) throw new Refused("ECONFLICT", `${args.path}: changed elsewhere`);
      const out = new Uint8Array(Math.max(x.bytes.length, args.pos + body.length));
      out.set(x.bytes), out.set(body, args.pos);
      x.bytes = out, x.rev++;
      return { json: { fid: x.fid, rev: x.rev, size: out.length } };
    }
    case "rename": {
      const g = page.files.get(args.from);
      page.files.delete(args.from);
      page.files.set(args.to, g);
      return { json: true };
    }
    case "remove":
      page.files.delete(args.path);
      return { json: true };
    case "mkdir":
      page.folders.add(args.path);
      return { json: true };
    case "access":
      return { json: true };
  }
  throw new Refused("EINVAL", "unknown op " + op);
}
class Stopped extends Error {}
fs.mediate({ request }, () => {
  throw new Stopped("KeyboardInterrupt");
});
const text = (p) => dec.decode(page.files.get(p)?.bytes ?? new Uint8Array(0));
const raised = (f) => {
  try {
    f();
    return null;
  } catch (e) {
    return e;
  }
};

// ---------------------------------------------------------------- scratch vs the page
{
  page.log.length = 0;
  fs.writeFileSync("/tmp/a", "x");
  fs.mkdirSync("/tmp/sub", { recursive: true });
  fs.writeFileSync("/tmp/sub/b", "y");
  fs.mkdirSync("/$pyjs", { recursive: true });
  fs.writeFileSync("/$pyjs/x", "z");
  ok(page.log.length === 0 && fs.readFileSync("/tmp/a", "utf8") === "x", "the exact scratch roots and their descendants stay local: nothing reaches the page");
  for (const p of ["/tmpx", "/tmp2", "/w/tmp", "/$pyjsx"]) {
    page.log.length = 0;
    fs.writeFileSync(p, "q");
    ok(page.log.join() === "write " + p && text(p) === "q", `${p} reaches the page`);
  }
}

// ---------------------------------------------------------------- reads
{
  fileAt("/w/r.txt", enc.encode("abcdef"));
  const fd = fs.openSync("/w/r.txt", 0);
  const b = new Uint8Array(3);
  fs.readSync(fd, b);
  ok(dec.decode(b) === "abc", "a read: the page's bytes");
  page.files.get("/w/r.txt").bytes = enc.encode("abcXYZ");
  page.log.length = 0;
  fs.readSync(fd, b);
  ok(dec.decode(b) === "XYZ" && page.log.join() === "read /w/r.txt", "a change between two reads of one descriptor is seen: the second read is its own request");
  ok(fs.readFileSync("/w/r.txt", "utf8") === "abcXYZ", "readFileSync reads the file as it is now");
  fs.closeSync(fd);
}

// ---------------------------------------------------------------- creates and truncations are changes
{
  fileAt("/w/t.txt", enc.encode("keep"));
  page.refuse.add("openw");
  const e = raised(() => fs.openSync("/w/t.txt", 1 | 512)); // O_WRONLY | O_TRUNC
  ok(e?.name === "PermissionDenied" && e.code === "EACCES" && text("/w/t.txt") === "keep", "a truncation to zero bytes refused: PermissionError, and the page's bytes unchanged");
  const e2 = raised(() => fs.onceOpen("/w/new.txt", false));
  ok(e2?.code === "EACCES" && !page.files.has("/w/new.txt"), "a create refused: nothing created");
  page.refuse.delete("openw");
}

// ---------------------------------------------------------------- concurrent changes
{
  fileAt("/w/c.txt", enc.encode("12345"));
  const fd = fs.openSync("/w/c.txt", 2); // O_RDWR
  page.files.get("/w/c.txt").bytes = enc.encode("changed"), page.files.get("/w/c.txt").rev++;
  const e = raised(() => fs.writeSync(fd, enc.encode("AB")));
  ok(e?.code === "ESTALE" && text("/w/c.txt") === "changed", `a positional write over a stale revision: refused (ESTALE), the page's bytes unchanged (${e?.code})`);
  const e2 = raised(() => fs.writeSync(fd, enc.encode("AB")));
  ok(e2?.code === "ESTALE", "and again: the descriptor's revision didn't move on a refusal");
  fs.closeSync(fd);

  fileAt("/w/log.txt", enc.encode("a\n"));
  const ad = fs.openSync("/w/log.txt", 1 | 1024); // O_WRONLY | O_APPEND
  const g = page.files.get("/w/log.txt");
  g.bytes = enc.encode("a\nelsewhere\n"), g.rev++;
  fs.writeSync(ad, enc.encode("mine\n"));
  ok(text("/w/log.txt") === "a\nelsewhere\nmine\n", "an append keeps the bytes written elsewhere meanwhile and adds at the current end");
  fileAt("/w/log.txt", enc.encode("a new file"));
  const e3 = raised(() => fs.writeSync(ad, enc.encode("more\n")));
  ok(e3?.code === "EBADF" && text("/w/log.txt") === "a new file", "an append through a descriptor whose file was replaced: refused (EBADF), nothing changes");
  fs.closeSync(ad);
}

// ---------------------------------------------------------------- renames, persistence, mounts, Stop
{
  fileAt("/w/m.txt", enc.encode("m"));
  page.refuse.add("rename");
  const e = raised(() => fs.renameSync("/w/m.txt", "/w/n.txt"));
  ok(e?.code === "EACCES" && page.files.has("/w/m.txt") && !page.files.has("/w/n.txt"), "a refused rename moves nothing");
  page.refuse.delete("rename");
  page.log.length = 0;
  fs.renameSync("/w/m.txt", "/w/n.txt");
  ok(page.log.join() === "rename /w/m.txt" && page.files.has("/w/n.txt"), "a rename is one request");
  ok(raised(() => fs.renameSync("/w/n.txt", "/tmp/n"))?.code === "EXDEV", "a rename between the workspace and scratch: EXDEV");

  const e2 = raised(() => {
    fs.writeFileSync("/w/p.txt", "before");
    throw new Error("the program's own error");
  });
  ok(e2?.message === "the program's own error" && text("/w/p.txt") === "before", "a write before an exception persists");
  ok(/can't be mounted/.test(raised(() => fs.mount([["/w/x", { url: "u", sha256: "0", size: 0 }]]))?.message ?? ""), "mounts are refused");

  page.cancelled = true;
  const e3 = raised(() => fs.readFileSync("/w/p.txt"));
  ok(e3 instanceof Stopped, "a Stop on the channel ends the program by the runner's cancel, never an ordinary error");
  ok(raised(() => fs.existsSync("/w/p.txt")) instanceof Stopped, "even where a missing file would be a quiet false");
}

console.log(failures ? `${failures} FAILED` : "all ok");
process.exit(failures ? 1 : 0);
