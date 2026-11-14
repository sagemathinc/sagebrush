// The Terminal commands' bridge (design-term-3b2 r1, SEC/ENGINE/owner/SIZE CLEAR): python, python3, sage, matlab and
// magma, each run start to end in a fresh worker of the notebook's build, its files answered live through the
// command's own run (ShellRun.commandPort, web/shell/host.ts).  Built as its own chunk (dist/shell/term-bridge.js),
// loaded by terminal.js on the first command; one bridge per ShellHost.
//
// - Bound to the page: the run, the principal, the worker are the page's; the request's cwd is shape only, and every
//   path the program uses is checked at use by the run's own checks, in the run's one queue, charged to its one ledger.
// - One live command worker per host, at most 16 waiting, their stdin held under a refundable reservation.
// - The worker: a plain module worker for the person's own Terminal (the Console's policy); a shell with limited
//   access is refused, never given a plain worker.  Only the messages a command needs are accepted.
// - Reads: one replaceable slot of the file read last, filled atomically, re-admitted at every use.  Writes: a check
//   before the body moves that charges nothing, then the commit in its own turn of the queue, checked again and charged
//   once.  A write already past its locked admission when the command is cancelled finishes (D8); nothing later does.
// - A command's end is accepted only when its channel is idle and its file work has drained; it settles once, its
//   worker, channel, slot and payload gone first.
// - Stop (any cause the run latches on, the exec's signal included): the channel cancelled, the worker's interrupt
//   flag set, and the worker ended after the shell's 2 s grace.
import { readCommand, type RunPlan } from "../../src/term-command";
import { PageChannel, ProtocolError, CAP, PATH_MAX, type Header, type Handled } from "../term-sync";
import type { CmdRequest, CmdAnswer } from "./loader";
import type { Bridge, CommandPort } from "./host";
import { outArgs, decodeSegments, lineArgs } from "../term-prompt-wire";

/** The bounds of one command's request, as the module and the loader enforce them (loader.ts CMD_BOUNDS). */
export const BOUNDS = { argv: 1024, argvBytes: 65536, stdinBytes: 8 * 2 ** 20 } as const;
/** At most this many commands wait for the live one (plan r1.7 §3.2: the default pipeline_width). */
export const QUEUE = 16;
/** The shell's Stop grace (host.ts STOP_GRACE_MS). */
export const GRACE_MS = 2000;
/** The module's output backstop (limits.ts OUTPUT_BACKSTOP). */
export const BACKSTOP = 32 * 2 ** 20;

export interface WorkerLike {
  postMessage(m: unknown, transfer?: Transferable[]): void;
  terminate(): void;
  onmessage: ((e: { data: any }) => void) | null;
  onerror: ((e: any) => void) | null;
}
export interface BridgeOptions {
  /** (tests) the worker to run a command in; the default is the notebook's build beside this chunk */
  worker?: () => WorkerLike;
  /** (tests) the grace before an unresponsive worker is ended, in ms */
  graceMs?: number;
  /** (tests) whether the page is cross-origin isolated */
  isolated?: () => boolean;
  /** (tests) the first generation (generations run to 2^31-1 and never wrap) */
  firstGen?: number;
}

const utf8 = (s: string) => new TextEncoder().encode(s).length;
const ok = (code: number, stdout: string, stderr: string): CmdAnswer => ({ ok: { code, stdout, stderr } });
const words = (name: string, text: string, code: number) => ok(code, "", `${name}: ${text}\n`);

// ------------------------------------------------------------------ the operations' exact shapes (r1 §4.1)

const str = (x: unknown): x is string => typeof x === "string";
const nat = (x: unknown): x is number => typeof x === "number" && Number.isSafeInteger(x) && x >= 0;
const bool = (x: unknown): x is boolean => typeof x === "boolean";
const pathOk = (x: unknown) => str(x) && x.startsWith("/") && utf8(x) <= PATH_MAX;
const fidOk = (x: unknown) => str(x) && x.length > 0 && x.length <= 128;
const keys = (a: object, k: string[]) => Object.keys(a).length === k.length && Object.keys(a).every((x) => k.includes(x));
/** Whether a header is exactly one of the worker's operations (web/shims/fs.ts), its fields in range. */
export function headerOk(h: Header): boolean {
  const a = h.args as any;
  if (!a || typeof a !== "object" || Array.isArray(a)) return false;
  const body = h.length !== undefined;
  if (body !== (h.op === "write")) return false;
  switch (h.op) {
    case "stat":
    case "list":
    case "open":
      return keys(a, ["path"]) && pathOk(a.path);
    case "read":
      return keys(a, ["path", "fid", "pos", "max"]) && pathOk(a.path) && fidOk(a.fid) && nat(a.pos) && nat(a.max) && a.max <= CAP;
    case "openw":
      return keys(a, ["path", "create", "trunc", "excl"]) && pathOk(a.path) && bool(a.create) && bool(a.trunc) && bool(a.excl);
    case "access":
      return keys(a, ["path", "write"]) && pathOk(a.path) && a.write === true;
    case "mkdir":
      return keys(a, ["path", "recursive"]) && pathOk(a.path) && bool(a.recursive);
    case "remove":
      return keys(a, ["path", "folder", "recursive"]) && pathOk(a.path) && (a.folder === null || bool(a.folder)) && bool(a.recursive);
    case "rename":
      return keys(a, ["from", "to"]) && pathOk(a.from) && pathOk(a.to);
    case "write":
      if (!nat(h.length) || h.length > CAP || !pathOk(a.path)) return false;
      if (a.mode === "replace") return keys(a, ["path", "mode"]);
      if (a.mode === "append") return keys(a, ["path", "mode"]) || (keys(a, ["path", "fid", "mode"]) && fidOk(a.fid));
      if (a.mode === "at") return keys(a, ["path", "fid", "mode", "rev", "pos"]) && fidOk(a.fid) && nat(a.rev) && nat(a.pos) && a.pos + h.length <= Number.MAX_SAFE_INTEGER;
      return false;
  }
  return false;
}

// ------------------------------------------------------------------ one command's file channel (r1 §4)

type Slot = { path: string; fid: string; rev: number; bytes: Uint8Array } | null;
type Entry = { kind: string; fid?: string; rev?: number; size?: number; updated?: number; path?: string };

/** The handler of one command's PageChannel, over its run's port. `inflight` counts what it has started and not finished. */
export function fileHandler(port: CommandPort) {
  let slot: Slot = null;
  let inflight = 0;
  const ws = () => port.ws();
  const stat = async (p: string): Promise<Entry | undefined> => (p === "/" ? { kind: "folder", fid: "/", rev: 0, size: 0, updated: 0 } : ((await ws().stat(p, { admit: port.check })) as any));
  // (a data file at p, or the refusal for what is there; a notebook or board is refused in this PR, r1 §4.2)
  const dataFile = (p: string, e: Entry | undefined, missing = "ENOENT"): Entry => {
    if (!e) throw port.refuse(missing, p, missing === "EBADF" ? "the file was removed" : undefined);
    if (e.kind === "folder") throw port.refuse("EISDIR", p);
    if (e.kind !== "file") throw port.refuse("EACCES", p, "a notebook or board: open it in its editor");
    return e;
  };
  // (the bytes of the file at p, which must still be fid: the slot if its key still holds, else one atomic read)
  const bytesOf = async (p: string, fid: string): Promise<{ rev: number; bytes: Uint8Array }> => {
    const e = dataFile(p, await stat(p), "EBADF");
    if (e.fid !== fid) throw port.refuse("EBADF", p, "the file was removed");
    if (slot && slot.path === p && slot.fid === fid && slot.rev === (e.rev ?? 0)) return slot;
    slot = null;
    const r = await port.readCapped(p);
    if (r.entry.fid !== fid) throw port.refuse("EBADF", p, "the file was removed");
    slot = { path: p, fid, rev: r.entry.rev ?? 0, bytes: r.content };
    return slot;
  };
  const alive = (p: string) => {
    if (!port.live()) throw port.refuse("EBADF", p, "this run has ended");
  };
  const answered = (r: { ok: unknown } | { err: { code: string; message: string } }, bytes = false): Handled =>
    "err" in r ? { error: { code: r.err.code, message: r.err.message } } : bytes ? { bytes: r.ok as Uint8Array } : { json: r.ok };

  // a write: its whole new content, from the file as it is now (append: that fid's file, or the path's; at: only on the
  // revision the descriptor holds); `null` base for a file to create
  const compose = async (p: string, a: any, body: Uint8Array | null, length: number): Promise<{ base: { fid: string; rev: number } | null; size: number; content: Uint8Array | null }> => {
    const e = await stat(p);
    if (e && e.kind === "folder") throw port.refuse("EISDIR", p);
    if (e && e.kind !== "file") throw port.refuse("EACCES", p, "a notebook or board: edit it in its editor");
    if (a.fid !== undefined && (!e || e.fid !== a.fid)) throw port.refuse("EBADF", p, "the file was removed");
    if (a.mode === "at" && (e!.rev ?? 0) !== a.rev) throw port.refuse("ECONFLICT", p);
    const base = e ? { fid: e.fid!, rev: e.rev ?? 0 } : null;
    const cur = e?.size ?? 0;
    const size = a.mode === "replace" ? length : a.mode === "append" ? cur + length : Math.max(cur, a.pos + length);
    if (size > port.limits.write_bytes!) throw port.over("write_bytes");
    if (!body) return { base, size, content: null };
    if (a.mode === "replace" || !e) return { base, size, content: a.mode === "at" ? place(new Uint8Array(0), body, a.pos) : body };
    const now = (await bytesOf(p, e.fid!)).bytes;
    return { base, size, content: a.mode === "append" ? place(now, body, now.length) : place(now, body, a.pos) };
  };

  const handler = async (h: Header): Promise<Handled> => {
    if (!headerOk(h)) throw new ProtocolError(`a malformed ${String(h.op).slice(0, 20)} request`);
    const a = h.args as any;
    // (each path the worker names, canonical first: Trash refused, and checked at use under the lock)
    let p: string;
    try {
      p = port.canon(a.path ?? a.from);
    } catch (err) {
      const code = (err as any)?.code;
      return { error: { code: typeof code === "string" && /^E[A-Z]+$/.test(code) ? code : "EINVAL", message: String((err as Error)?.message ?? err).slice(0, 200) } };
    }
    inflight++;
    try {
      switch (h.op) {
        case "stat":
          return answered(
            await port.turn(p, async () => {
              await port.flush(p);
              const e = await stat(p);
              if (!e) throw port.refuse("ENOENT", p);
              alive(p);
              return { kind: e.kind === "folder" ? "folder" : "file", size: e.size ?? 0, mtime: e.updated ?? 0, fid: e.fid ?? "ref:" + p, rev: e.rev ?? 0 };
            }),
          );
        case "list":
          return answered(
            await port.turn(p, async () => {
              await port.flush(p);
              const names = (await port.list(p)).map((x) => x.name);
              alive(p);
              return names;
            }),
          );
        case "open":
          return answered(
            await port.turn(p, async () => {
              await port.flush(p);
              const e = dataFile(p, await stat(p));
              alive(p);
              return { fid: e.fid, rev: e.rev ?? 0, size: e.size ?? 0 };
            }),
          );
        case "read":
          return answered(
            await port.turn(p, async () => {
              const b = (await bytesOf(p, a.fid)).bytes;
              alive(p);
              const from = Math.min(a.pos, b.length);
              return b.subarray(from, Math.min(b.length, from + a.max));
            }),
            true,
          );
        case "access":
          return answered(
            await port.turn(p, async () => {
              port.mutating(p);
              const e = await stat(p);
              if (!e) throw port.refuse("ENOENT", p);
              if (e.kind !== "file" && e.kind !== "folder") throw port.refuse("EACCES", p, "a notebook or board: edit it in its editor");
              alive(p);
              return true;
            }),
          );
        case "openw":
          return answered(
            await port.turn(p, async () => {
              port.mutating(p);
              await port.flush(p);
              const e = await stat(p);
              if (e && e.kind === "folder") throw port.refuse("EISDIR", p);
              if (e && e.kind !== "file") throw port.refuse("EACCES", p, "a notebook or board: edit it in its editor");
              if (e && a.create && a.excl) throw port.refuse("EEXIST", p);
              if (!e && !a.create) throw port.refuse("ENOENT", p);
              // (a create or a truncation, even to zero bytes, is a change: committed before the open succeeds)
              if (!e) return await port.commit(p, new Uint8Array(0), null);
              if (a.trunc && (e.size ?? 0) > 0) return await port.commit(p, new Uint8Array(0), { fid: e.fid!, rev: e.rev ?? 0 });
              return { fid: e.fid, rev: e.rev ?? 0 };
            }),
          );
        case "mkdir":
          return answered(await port.turn(p, async () => (await port.mkdir(p, a.recursive), true)));
        case "rename":
          return answered(await port.turn(p, async () => (await port.mv(p, port.canon(a.to)), true)));
        case "remove":
          return answered(
            await port.turn(p, async () => {
              const q = p;
              if (a.folder !== null) {
                port.mutating(q);
                await port.flush(q);
                const e = await stat(q);
                if (!e) throw port.refuse("ENOENT", q);
                if (a.folder && e.kind !== "folder") throw port.refuse("ENOTDIR", q);
                if (!a.folder && e.kind === "folder") throw port.refuse("EISDIR", q);
                if (a.folder && (await port.list(q)).length) throw port.refuse("ENOTEMPTY", q, "Directory not empty");
              }
              await port.rm(q, a.folder === null ? a.recursive : !!a.folder);
              return true;
            }),
          );
        case "write": {
          // (the check before the body moves: the run's fence, the grant and write, the kind, the descriptor's identity,
          // its revision, the whole content's size, and room left in ops and written_bytes; it charges nothing)
          const pre = await port.turn(p, async () => {
            const q = p;
            port.mutating(q);
            await port.flush(q);
            const c = await compose(q, a, null, h.length!);
            const used = port.ledger();
            if (used.ops + 1 > port.limits.ops!) throw port.over("ops");
            if (used.written_bytes + c.size > port.limits.written_bytes!) throw port.over("written_bytes");
            return true;
          });
          if ("err" in pre) return answered(pre);
          // (the commit, when the body is in: its own turn, everything checked again on the file as it is then, the one
          // locked charge in port.commit; lost to a change meanwhile, ECONFLICT, never tried again)
          return {
            admit: async (body: Uint8Array) => {
              inflight++;
              try {
                if (body.length !== h.length) throw new ProtocolError("a body of another length than its header's");
                return answered(
                  await port.turn(p, async () => {
                    const q = p;
                    port.mutating(q);
                    const c = await compose(q, a, body, body.length);
                    const at = await port.commit(q, c.content!, c.base);
                    if (slot?.path === q) slot = null;
                    return { fid: at.fid, rev: at.rev, size: c.content!.length };
                  }),
                ) as any;
              } finally {
                inflight--;
              }
            },
          };
        }
      }
      throw new ProtocolError("an unknown operation");
    } finally {
      inflight--;
    }
  };
  return {
    handler,
    /** nothing this handler started is still running */
    quiet: () => inflight === 0,
    /** (r1 §2.2 step 10) drop the slot */
    drop: () => void (slot = null),
    /** (tests) the slot's size */
    held: () => slot?.bytes.length ?? 0,
  };
}

// `body` written into `base` at `at` (a gap is zeros), as a new array
function place(base: Uint8Array, body: Uint8Array, at: number): Uint8Array {
  const out = new Uint8Array(Math.max(base.length, at + body.length));
  out.set(base);
  out.set(body, at);
  return out;
}

// ------------------------------------------------------------------ the host's commands (r1 §2.2, §3, §5, §6)

/** The bridge of one ShellHost: its queue, its generations, its one live worker. */
export function bridge(o: BridgeOptions = {}): Bridge & { stats(): { live: number; waiting: number; reserved: number; workers: number } } {
  const isolated = o.isolated ?? (() => (globalThis as any).crossOriginIsolated === true);
  const make = o.worker ?? (() => new Worker(new URL("../sagebrush-worker.js", import.meta.url), { type: "module", name: "sagebrush-term" }) as unknown as WorkerLike);
  const grace = o.graceMs ?? GRACE_MS;
  let gen = (o.firstGen ?? 1) - 1;
  let busy = false;
  let workers = 0;
  let reserved = 0;
  const waiting: { go: () => void; drop: () => void }[] = [];

  // the turn of the live worker: at once, or after those waiting; false if the command was stopped first.  Its stdin's
  // reservation is taken before it waits and released exactly once (started, stopped or failed)
  function acquire(port: CommandPort, bytes: number): Promise<boolean> | "full" {
    if (!busy && !waiting.length) {
      busy = true;
      return Promise.resolve(true);
    }
    if (waiting.length >= QUEUE) return "full";
    reserved += bytes;
    return new Promise((res) => {
      let done = false;
      const settle = (v: boolean) => {
        if (done) return;
        done = true;
        reserved -= bytes;
        off();
        const i = waiting.indexOf(e);
        if (i >= 0) waiting.splice(i, 1);
        res(v);
      };
      const e = { go: () => settle(true), drop: () => settle(false) };
      waiting.push(e);
      // (a Stop of this command's run cancels this entry only: another run's entries are untouched)
      const off = port.onStop(() => settle(false));
    });
  }
  function release() {
    busy = false;
    const next = waiting.shift();
    if (next) {
      busy = true;
      next.go();
    }
  }

  async function run(port: CommandPort, r: CmdRequest): Promise<CmdAnswer> {
    const name = r.name;
    if (!port.live()) return { err: { message: "this run has ended" } };
    // (the bounds again, as the page's own policy, before any copy)
    if (r.argv.length > BOUNDS.argv) return words(name, `more than ${BOUNDS.argv} arguments; the Terminal accepts up to ${BOUNDS.argv}`, 2);
    if (r.argv.reduce((n, a) => n + utf8(a), 0) > BOUNDS.argvBytes) return words(name, "the arguments are longer than the Terminal accepts (64 KiB)", 2);
    if (r.stdin.byteLength > BOUNDS.stdinBytes) return words(name, "the input is longer than the Terminal accepts (8 MiB)", 2);
    if (!isolated()) return words(name, "can't run here: it needs shared memory, which this app or page doesn't offer (it runs in the Terminal at sagebrush.space in a desktop web browser)", 126);
    if (port.principal !== "person") return words(name, "can't run yet in a shell with limited access (an agent's or a document's); it runs in a Terminal the person opens", 126);
    // (a prompt only for the person's own line at the panel: the host gives this command the panel's prompt surface
    // only then, and a bare name with the keyboard as its stdin is the one form that opens one)
    const plan = readCommand(name, r.argv, r.cwd, r.stdinRedirected, !!port.prompt && r.argv.length === 0 && !r.stdinRedirected);
    if (plan.run !== true) return ok(plan.code, plan.stdout, plan.stderr);
    const turn = acquire(port, r.stdin.byteLength);
    if (turn === "full") return words(name, `too many commands are waiting in the Terminal (${QUEUE})`, 2);
    if (!(await turn)) return { err: { message: "the command was stopped" } };
    try {
      if (!port.live()) return { err: { message: "the command was stopped" } };
      if (gen >= CAP) return words(name, "the Terminal has run too many commands; reopen it", 126);
      return await once(port, plan, r, ++gen);
    } finally {
      release();
    }
  }

  // One command in one worker, settled once.
  function once(port: CommandPort, plan: RunPlan, r: CmdRequest, g: number): Promise<CmdAnswer> {
    return new Promise((resolve) => {
      const files = fileHandler(port);
      // (a prompt: its two operations answered here, the rest are file operations as for any command)
      const surface = plan.source.kind === "prompt" ? port.prompt : null;
      const handler = surface ? promptHandler(surface) : files.handler;
      let w: WorkerLike | null = null, page: PageChannel | null = null, intr: SharedArrayBuffer | null = null;
      let timer: ReturnType<typeof setTimeout> | null = null, settled = false, ended = false;
      let allowance = 0;
      const offStop = port.onStop(() => stop());
      // (teardown before the answer: the Stop's registration and timer, the worker, its listeners, the channel, the slot)
      const settle = (a: CmdAnswer) => {
        if (settled) return;
        settled = true;
        offStop();
        surface?.bindInterrupt(null);
        surface?.end();
        if (timer) clearTimeout(timer);
        timer = null;
        end();
        files.drop();
        page = null;
        resolve(a);
      };
      function end() {
        if (ended || !w) return;
        ended = true;
        w.onmessage = w.onerror = null;
        w.terminate();
        workers--;
      }
      // (a fault: the command cancelled, the run latched (row 5); settled when what was admitted has finished, D8)
      const fault = (why: string) => {
        if (settled) return;
        stop();
        port.fault(`the Terminal's ${plan.mode} command ${why}`);
        drained().then(() => settle({ err: { message: why } }));
      };
      // (the run's queue drained: a turn after everything this command enqueued; it answers at once once latched)
      const drained = () => port.turn("", async () => true).then(() => undefined);
      function stop() {
        if (settled) return;
        page?.cancel();
        if (intr) Atomics.or(new Int32Array(intr), 0, 1);
        // (before its ready: no channel and nothing admitted, so the worker is ended at once)
        if (!w || !page) return settle({ err: { message: "the command was stopped" } });
        timer ??= setTimeout(() => {
          timer = null;
          drained().then(() => settle({ err: { message: "the command was stopped" } }));
        }, grace);
      }
      // A prompt's operations (web/term-prompt-wire.ts): `out` checked whole, charged to the run's ledger, drawn by the
      // panel and only then answered; `line` answered by what the person types.  Anything else is a file operation.
      // A malformed request is the command's fault: cancelled, latched, ended.
      function promptHandler(sf: NonNullable<typeof surface>) {
        return async (h: Header): Promise<Handled> => {
          if (h.op === "out") {
            // (its shape checked whole here, its text within one statement's bytes and the omitted line (what one
            //  flush can carry), so the body admitted is bounded; more than the run has left is the run's output_bytes
            //  limit, below, not a broken request)
            const a = outArgs(h.args, h.length, sf.bounds.inBytes + 128);
            if (!a) {
              fault("sent an output request that isn't the protocol's");
              return { error: { code: "EPROTO", message: "not the protocol's" } };
            }
            return {
              admit: async (body) => {
                const segs = decodeSegments(body, a.segs);
                if (!segs) {
                  fault("sent output that isn't the protocol's");
                  return { error: { code: "EPROTO", message: "not the protocol's" } };
                }
                const bytes = body.length - a.segs * 5;
                if (!port.live()) return { error: { code: "ECANCELED", message: "the command was stopped" } };
                // (charged as drawn; past output_bytes the run's limit is hit, latched, and the prompt stopped)
                if (!port.charge(bytes)) {
                  stop();
                  return { error: { code: "ECANCELED", message: "the output limit was reached" } };
                }
                await sf.out(segs);
                return { json: { ok: true } };
              },
            };
          }
          if (h.op === "line") {
            // (what an input may take is never more than the bounds the page gave the prompt: lineArgs)
            const a = lineArgs(h.args, h.length, sf.bounds);
            if (!a) {
              fault("sent an input request that isn't the protocol's");
              return { error: { code: "EPROTO", message: "not the protocol's" } };
            }
            return { json: await sf.line(a) };
          }
          return files.handler(h);
        };
      }
      try {
        w = make();
      } catch (err) {
        return settle({ err: { message: `its worker couldn't start: ${String((err as Error)?.message ?? err).slice(0, 200)}` } });
      }
      workers++;
      w.onerror = (e: any) => fault(`lost its worker (${String(e?.message ?? "an error").slice(0, 200)})`);
      w.onmessage = (e) => {
        const m = e.data;
        if (settled || !m || typeof m !== "object") return;
        if (m.fsSync || m.fsMore) {
          const mg = (m.fsSync ?? m.fsMore)?.gen;
          if (mg !== g || !page) return;
          page.onMessage(m).catch((err) => fault(`broke the file protocol (${String(err?.message ?? err).slice(0, 200)})`));
          return;
        }
        if (m.ready) {
          if (page) return fault("said it was ready twice");
          if (!port.live()) return stop();
          intr = m.interrupt instanceof SharedArrayBuffer ? m.interrupt : null;
          // (the prompt's Ctrl+C: the language's interrupt only (the flag), never the channel's Stop)
          if (surface) {
            const flag = intr;
            surface.bindInterrupt(flag ? () => void Atomics.or(new Int32Array(flag), 0, 1) : null);
            surface.begin(plan.mode);
          }
          page = new PageChannel(g, handler);
          allowance = Math.max(0, port.allowance());
          const stdin = new Uint8Array(r.stdin);
          const size = port.size();
          w!.postMessage(
            {
              term: {
                gen: g, plan, cwd: r.cwd, stdin,
                env: size ? { COLUMNS: size.cols, LINES: size.rows } : {},
                out: { allowance, backstop: BACKSTOP },
                sync: { control: page.control, data: page.data },
                ...(surface ? { prompt: surface.bounds } : {}),
              },
            },
            [stdin.buffer],
          );
          return;
        }
        if (m.termDone) return done(m.termDone);
        if (m.initFailed !== undefined || m.termRefused !== undefined) {
          // (before the command is sent there is no file work: the engine's refusal, 126.  After it, the end of a
          // command whose file work may be in flight: a fault, cancelled, latched and drained before it settles)
          if (page) return fault(`was refused after it started (${String(m.initFailed ?? m.termRefused).slice(0, 200)})`);
          return settle(ok(126, "", `${plan.argv0}: ${String(m.initFailed ?? m.termRefused).slice(0, 500)}\n`));
        }
        // (the runtime's own loading notices: nothing to do)
        if ("libLoading" in m || "libChunk" in m || "offlineMissing" in m || "pkgUsed" in m || "pkgsetUsed" in m) return;
        fault(`sent what a command doesn't (${Object.keys(m).slice(0, 3).join(", ").slice(0, 60)})`);
      };
      // (the engine's default limits, as the Console's interpreter starts with)
      w.postMessage({ init: { limits: null } });

      // the end (r1 §2.2 step 9): accepted only on a quiet channel and drained file work, its fields whole
      async function done(d: any) {
        if (!page || !files.quiet() || !page.idle()) return fault("ended while one of its file requests was still being answered");
        if (d?.gen !== g) return fault("ended with another generation");
        const ints = (x: unknown) => Number.isSafeInteger(x) && (x as number) >= 0;
        const c = d.output;
        const cap = Math.min(allowance, BACKSTOP);
        if (!ints(d.code) || d.code > 255 || typeof d.stdout !== "string" || typeof d.stderr !== "string" || !c || !ints(c.producedBytes) || !ints(c.deliveredBytes) || typeof c.exceeded !== "boolean" || typeof c.truncated !== "boolean") return fault("ended with a malformed result");
        // (N1: what comes back is within the run's allowance and the backstop, and its count holds)
        const bytes = utf8(d.stdout) + utf8(d.stderr);
        if (bytes > cap || c.deliveredBytes !== bytes || c.producedBytes < bytes || c.exceeded !== c.producedBytes > allowance || c.truncated !== (!c.exceeded && c.producedBytes > cap)) return fault("ended with an output count that doesn't hold");
        await drained();
        if (settled) return;
        if (!port.live()) return settle({ err: { message: "the command was stopped" } });
        if (c.exceeded) port.limitHit("output_bytes");
        settle(ok(c.truncated ? 126 : d.code, d.stdout, d.stderr));
      }
    });
  }

  return {
    run,
    stats: () => ({ live: busy ? 1 : 0, waiting: waiting.length, reserved, workers }),
  };
}
