import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The Jupyter kernel over its shell and control sockets, for tests: the least ZeroMQ client that can (a DEALER,
// ZMTP 3.1, NULL mechanism, unsigned messages).
const DIST = __dirname + "/..";

const freePort = () => new Promise<number>((res) => {
  const s = net.createServer();
  s.listen(0, "127.0.0.1", () => {
    const p = (s.address() as net.AddressInfo).port;
    s.close(() => res(p));
  });
});

const frame = (body: Buffer, more: boolean, command = false) => {
  const flags = (more ? 1 : 0) | (command ? 4 : 0);
  if (body.length < 256) return Buffer.concat([Buffer.from([flags, body.length]), body]);
  const h = Buffer.alloc(9);
  h[0] = flags | 2;
  h.writeBigUInt64BE(BigInt(body.length), 1);
  return Buffer.concat([h, body]);
};

type Dealer = { send(f: Buffer[]): void; next(): Promise<Buffer[]>; close(): void };
/** A DEALER connected to port: send(frames), and the next message's frames. Connected once the first 64 bytes
 * have arrived (the ZMTP greeting's length; not otherwise checked), so something else holding the port that
 * closes the connection, or sends nothing within `wait` ms, is not taken for the kernel. */
function dealer(port: number, wait: number): Promise<Dealer> {
  return new Promise((res, rej) => {
    const s = net.connect(port, "127.0.0.1");
    let buf = Buffer.alloc(0), greeted = false, frames: Buffer[] = [];
    const messages: Buffer[][] = [], waiting: ((m: Buffer[]) => void)[] = [];
    const g = Buffer.alloc(64);
    g[0] = 0xff;
    g[9] = 0x7f;
    g[10] = 3;
    g[11] = 1;
    g.write("NULL", 12, "ascii");
    const silent = setTimeout(() => (s.destroy(), rej(new Error("fewer than 64 bytes received"))), wait);
    s.on("error", (e) => (clearTimeout(silent), rej(e)));
    s.on("close", () => (clearTimeout(silent), rej(new Error("closed before 64 bytes were received"))));
    s.on("connect", () => {
      const name = Buffer.from("READY"), key = Buffer.from("Socket-Type"), val = Buffer.from("DEALER"), len = Buffer.alloc(4);
      len.writeUInt32BE(val.length);
      s.write(Buffer.concat([g, frame(Buffer.concat([Buffer.from([name.length]), name, Buffer.from([key.length]), key, len, val]), false, true)]));
    });
    s.on("data", (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      if (!greeted) {
        if (buf.length < 64) return;
        greeted = true;
        clearTimeout(silent);
        buf = buf.subarray(64);
        res({
          send: (f) => s.write(Buffer.concat(f.map((x, i) => frame(x, i < f.length - 1)))),
          next: () => new Promise((r) => (messages.length ? r(messages.shift()!) : waiting.push(r))),
          close: () => s.destroy(),
        });
      }
      for (;;) {
        if (buf.length < 2) return;
        const flags = buf[0], long = flags & 2, at = long ? 9 : 2;
        if (buf.length < at) return;
        const size = long ? Number(buf.readBigUInt64BE(1)) : buf[1];
        if (buf.length < at + size) return;
        const body = Buffer.from(buf.subarray(at, at + size));
        buf = buf.subarray(at + size);
        if (flags & 4) continue; // (a command: the kernel's READY)
        frames.push(body);
        if (!(flags & 1)) {
          const m = frames;
          frames = [];
          if (waiting.length) waiting.shift()!(m);
          else messages.push(m);
        }
      }
    });
  });
}

/** A kernel started with args after its connection file: exec(code, silent, storeHistory) sends an execute_request on the shell socket
 * and gives its execute_reply's content; interrupt() sends an interrupt_request on the control socket; exited is
 * its exit status; stop() ends it.
 *
 * The five ports are free when chosen, but the kernel binds them only later, and a test running beside this one can
 * take one in between: a kernel that stops on EADDRINUSE before it is reached is started again on fresh ports, up to
 * `tries` times in all (attempts says how many it took). Any other early stop is the kernel's own, and is returned.
 * An attempt has `startupMs` (30 s) to reach the kernel's shell and control sockets; one that doesn't throws,
 * having closed its sockets, killed and reaped the kernel and removed its connection file's folder. (For the
 * tests of the harness itself: ports, the first attempt's five; kernel, the command run instead of the kernel,
 * given the connection file.) */
export async function startKernel(args: string[], env: Record<string, string> = {}, cwd?: string, opts: StartOptions = {}) {
  const tries = opts.tries ?? 3;
  for (let attempt = 1; ; attempt++) {
    const k = await startOnce(args, env, cwd, { ...opts, ports: attempt === 1 ? opts.ports : undefined });
    if (!/EADDRINUSE/.test(k.out.stderr) || attempt >= tries) return { ...k, attempts: attempt };
    k.close();
    await k.stop();
  }
}

interface StartOptions {
  tries?: number;
  startupMs?: number;
  ports?: number[];
  kernel?: (conn: string) => string[];
}

async function startOnce(args: string[], env: Record<string, string>, cwd: string | undefined, opts: StartOptions) {
  const dir = mkdtempSync(join(tmpdir(), "sb-kernel-conn-"));
  const ports = opts.ports ?? (await Promise.all([1, 2, 3, 4, 5].map(freePort)));
  const conn = join(dir, "kernel.json");
  writeFileSync(conn, JSON.stringify({ transport: "tcp", ip: "127.0.0.1", key: "", signature_scheme: "hmac-sha256",
    shell_port: ports[0], iopub_port: ports[1], stdin_port: ports[2], control_port: ports[3], hb_port: ports[4] }));
  const argv = opts.kernel?.(conn) ?? [join(DIST, "src", "cli.js"), "--jupyter-kernel", conn, "--mode", "python", ...args];
  const k = spawn(process.execPath, argv,
    { env: { ...process.env, SAGEBRUSH_NO_COMPILE_CACHE: "1", ...env }, stdio: ["ignore", "ignore", "pipe"], cwd });
  const out = { stderr: "" };
  k.stderr!.on("data", (d: Buffer) => (out.stderr += d));
  const exited = new Promise<number | null>((r) => k.on("exit", (c) => r(c)));
  const closed = new Promise<void>((r) => k.on("close", () => r()));
  const stop = async () => {
    k.kill("SIGKILL");
    await exited;
    rmSync(dir, { recursive: true, force: true });
  };
  // (one deadline for the attempt: the shell and control sockets and their first 64 bytes together)
  const deadline = Date.now() + (opts.startupMs ?? 30000);
  const connect = async (port: number) => {
    for (;;) {
      if (k.exitCode !== null) return null;
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`the kernel wasn't reached within ${opts.startupMs ?? 30000} ms: ` + out.stderr);
      const s = await dealer(port, Math.min(2000, left)).catch(() => null);
      if (s !== null) return s;
      await new Promise((r) => setTimeout(r, Math.min(50, Math.max(0, deadline - Date.now()))));
    }
  };
  const request = (sock: Dealer, type: string, content: any) => {
    const header = { msg_id: randomUUID(), session: randomUUID(), username: "test", date: new Date().toISOString(), msg_type: type, version: "5.3" };
    sock.send([Buffer.from("<IDS|MSG>"), Buffer.from(""), ...[header, {}, {}, content].map((x) => Buffer.from(JSON.stringify(x)))]);
  };
  let shell: Dealer | null = null, control: Dealer | null = null;
  try {
    shell = await connect(ports[0]);
    control = shell === null ? null : await connect(ports[3]);
  } catch (e: any) {
    // (a failed start leaves nothing behind: its sockets, its process, its folder)
    shell?.close();
    await stop();
    throw Object.assign(e, { pid: k.pid, dir });
  }
  // (stopped before it was reached: its stderr whole, for why)
  if (shell === null || control === null) await closed;
  const exec = async (code: string, silent = false, storeHistory = !silent): Promise<any> => {
    request(shell!, "execute_request", { code, silent, store_history: storeHistory, user_expressions: {}, allow_stdin: false, stop_on_error: true });
    for (;;) {
      const m = await shell!.next();
      const i = m.findIndex((f) => f.toString() === "<IDS|MSG>");
      const [h, , , c] = m.slice(i + 2, i + 6).map((f) => JSON.parse(f.toString()));
      if (h.msg_type === "execute_reply") return c;
    }
  };
  const interrupt = () => request(control!, "interrupt_request", {});
  return { started: shell !== null, exec, interrupt, exited, stop, out, close: () => (shell?.close(), control?.close()) };
}
