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

/** A DEALER connected to port: send(frames), and the next message's frames. */
function dealer(port: number): Promise<{ send(f: Buffer[]): void; next(): Promise<Buffer[]>; close(): void }> {
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
    s.on("error", rej);
    s.on("connect", () => {
      const name = Buffer.from("READY"), key = Buffer.from("Socket-Type"), val = Buffer.from("DEALER"), len = Buffer.alloc(4);
      len.writeUInt32BE(val.length);
      s.write(Buffer.concat([g, frame(Buffer.concat([Buffer.from([name.length]), name, Buffer.from([key.length]), key, len, val]), false, true)]));
      res({
        send: (f) => s.write(Buffer.concat(f.map((x, i) => frame(x, i < f.length - 1)))),
        next: () => new Promise((r) => (messages.length ? r(messages.shift()!) : waiting.push(r))),
        close: () => s.destroy(),
      });
    });
    s.on("data", (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      if (!greeted) {
        if (buf.length < 64) return;
        greeted = true;
        buf = buf.subarray(64);
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

/** A kernel started with args after its connection file: exec(code, silent) sends an execute_request on the shell socket
 * and gives its execute_reply's content; interrupt() sends an interrupt_request on the control socket; exited is
 * its exit status; stop() ends it. */
export async function startKernel(args: string[], env: Record<string, string> = {}, cwd?: string) {
  const dir = mkdtempSync(join(tmpdir(), "sb-kernel-conn-"));
  const ports = await Promise.all([1, 2, 3, 4, 5].map(freePort));
  const conn = join(dir, "kernel.json");
  writeFileSync(conn, JSON.stringify({ transport: "tcp", ip: "127.0.0.1", key: "", signature_scheme: "hmac-sha256",
    shell_port: ports[0], iopub_port: ports[1], stdin_port: ports[2], control_port: ports[3], hb_port: ports[4] }));
  const k = spawn(process.execPath, [join(DIST, "src", "cli.js"), "--jupyter-kernel", conn, "--mode", "python", ...args],
    { env: { ...process.env, SAGEBRUSH_NO_COMPILE_CACHE: "1", ...env }, stdio: ["ignore", "ignore", "pipe"], cwd });
  const out = { stderr: "" };
  k.stderr!.on("data", (d: Buffer) => (out.stderr += d));
  const exited = new Promise<number | null>((r) => k.on("exit", (c) => r(c)));
  const stop = async () => {
    k.kill("SIGKILL");
    await exited;
    rmSync(dir, { recursive: true, force: true });
  };
  const connect = async (port: number) => {
    for (let i = 0; i < 200; i++) {
      if (k.exitCode !== null) return null;
      const s = await dealer(port).catch(() => null);
      if (s !== null) return s;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error("the kernel never listened: " + out.stderr);
  };
  const request = (sock: Awaited<ReturnType<typeof dealer>>, type: string, content: any) => {
    const header = { msg_id: randomUUID(), session: randomUUID(), username: "test", date: new Date().toISOString(), msg_type: type, version: "5.3" };
    sock.send([Buffer.from("<IDS|MSG>"), Buffer.from(""), ...[header, {}, {}, content].map((x) => Buffer.from(JSON.stringify(x)))]);
  };
  const shell = await connect(ports[0]);
  const control = shell === null ? null : await connect(ports[3]);
  const exec = async (code: string, silent = false): Promise<any> => {
    request(shell!, "execute_request", { code, silent, store_history: !silent, user_expressions: {}, allow_stdin: false, stop_on_error: true });
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

