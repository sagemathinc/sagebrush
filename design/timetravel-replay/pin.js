// Pins a worker's sources of nondeterminism before the runtime loads.
// Parameters come in the worker's name: {epoch, seed, tick}.
const p = JSON.parse(self.name || "{}");
if (p.seed !== undefined) {
  let s = p.seed >>> 0;
  const next = () => { // mulberry32
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  Math.random = next;
  const gv = crypto.getRandomValues.bind(crypto);
  crypto.getRandomValues = (a) => {
    const b = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
    for (let i = 0; i < b.length; i++) b[i] = Math.floor(next() * 256);
    return a;
  };
  void gv;
  // a virtual clock: starts at the recorded epoch, advances `tick` ms per read
  let virt = 0;
  const tick = p.tick ?? 0.001;
  const read = () => (virt += tick);
  const epoch = p.epoch ?? 1791680000000;
  Date.now = () => Math.floor(epoch + read());
  performance.now = () => read();
  const RealDate = Date;
  globalThis.Date = class extends RealDate {
    constructor(...a) { if (a.length) super(...a); else super(RealDate.now()); }
    static now() { return RealDate.now(); }
  };
}
