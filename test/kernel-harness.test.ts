import test from "node:test";
import assert from "node:assert/strict";
import * as net from "node:net";
import { startKernel } from "./kernel-harness";

// The harness's kernel ports: chosen free, bound by the kernel later, so a test beside it can take one in
// between. One of the first attempt's ports is made taken here; the kernel stops on EADDRINUSE and the
// harness starts it again on fresh ports.
const hold = () => new Promise<net.Server>((res) => {
  const s = net.createServer((c) => c.destroy());
  s.listen(0, "127.0.0.1", () => res(s));
});
const portOf = (s: net.Server) => (s.address() as net.AddressInfo).port;
const free = async () => {
  const s = await hold();
  const p = portOf(s);
  await new Promise((r) => s.close(r));
  return p;
};

// (ports: shell, iopub, stdin, control, hb)
for (const [what, at] of [["stdin port", 2], ["shell port (the one the harness connects to)", 0]] as [string, number][]) {
  test(`a kernel whose ${what} is taken is started again on fresh ports`, async () => {
    const taken = await hold();
    const ports = await Promise.all([1, 2, 3, 4, 5].map(free));
    ports[at] = portOf(taken);
    const k = await startKernel([], {}, undefined, { ports });
    try {
      assert.ok(k.started, k.out.stderr);
      assert.equal(k.attempts, 2, k.out.stderr);
      assert.equal((await k.exec("x = 6 * 7")).status, "ok");
    } finally {
      k.close();
      await k.stop();
      taken.close();
    }
  });
}

// (the control: with one try, the same taken port is the kernel's EADDRINUSE, so the collision is real; and a
// kernel that stops for another reason is not started again)
test("with one try, a taken port stops the kernel with EADDRINUSE", async () => {
  const taken = await hold();
  const ports = await Promise.all([1, 2, 3, 4, 5].map(free));
  ports[2] = portOf(taken);
  const k = await startKernel([], {}, undefined, { ports, tries: 1 });
  try {
    assert.equal(k.attempts, 1);
    assert.match(k.out.stderr, /EADDRINUSE/);
    assert.notEqual(await k.exited, 0);
  } finally {
    k.close();
    await k.stop();
    taken.close();
  }
});

test("a kernel that stops for another reason is not started again", async () => {
  const k = await startKernel(["--pkgset", "not-a-set"]);
  try {
    assert.equal(k.started, false);
    assert.equal(k.attempts, 1);
    assert.doesNotMatch(k.out.stderr, /EADDRINUSE/);
  } finally {
    await k.stop();
  }
});
