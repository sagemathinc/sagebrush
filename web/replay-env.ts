// The worker's sources of nondeterminism, made reproducible for TimeTravel
// replay (design/timetravel-replay.md).  Imported first by web/worker.ts, so
// it is in place before the runtime reads the clock or asks for entropy.
//
// The page passes the parameters in the Worker's name, as JSON:
//   {seed: 64 hex digits}  the session's entropy: Math.random and
//                          crypto.getRandomValues (os.urandom, random.seed(),
//                          numpy's default_rng()) become a ChaCha20 stream
//                          from this seed.  No seed: the browser's entropy.
//   {startup: [...]}        replay: the clock values the original session read
//                          while starting.
// The clock is never pinned: a live session reads the real clock, and the
// values read during each run are recorded (at most CAP of them) and sent
// back with the run's `done`.  A replayed run is given the recorded values,
// returned in order; after them it reads the real clock again, and says how
// many more it read (the replay has then diverged).
const CAP = 10000;

const realDateNow = Date.now.bind(Date);
const realPerfNow = performance.now.bind(performance);
const RealDate = Date;

let params: { seed?: string; startup?: number[] } = {};
try {
  params = JSON.parse((self as any).name || "{}") ?? {};
} catch {}

// ------------------------------------------------------------ entropy: ChaCha20
// RFC 8439's block function, key = the seed, nonce 0: 64 bytes per block.
function chacha20(seedHex: string) {
  const key = new Uint32Array(8);
  for (let i = 0; i < 8; i++) key[i] = parseInt(seedHex.slice(8 * i, 8 * i + 8).padStart(8, "0"), 16) >>> 0;
  const st = new Uint32Array(16), x = new Uint32Array(16);
  st.set([0x61707865, 0x3320646e, 0x79622d32, 0x6b206574]);
  st.set(key, 4);
  let counter = 0;
  const block = new Uint8Array(64), words = new Uint32Array(block.buffer);
  let pos = 64;
  const rotl = (v: number, n: number) => (v << n) | (v >>> (32 - n));
  const qr = (a: number, b: number, c: number, d: number) => {
    x[a] += x[b]; x[d] = rotl(x[d] ^ x[a], 16);
    x[c] += x[d]; x[b] = rotl(x[b] ^ x[c], 12);
    x[a] += x[b]; x[d] = rotl(x[d] ^ x[a], 8);
    x[c] += x[d]; x[b] = rotl(x[b] ^ x[c], 7);
  };
  const refill = () => {
    st[12] = counter++;
    x.set(st);
    for (let i = 0; i < 10; i++) {
      qr(0, 4, 8, 12); qr(1, 5, 9, 13); qr(2, 6, 10, 14); qr(3, 7, 11, 15);
      qr(0, 5, 10, 15); qr(1, 6, 11, 12); qr(2, 7, 8, 13); qr(3, 4, 9, 14);
    }
    for (let i = 0; i < 16; i++) words[i] = (x[i] + st[i]) >>> 0; // (little-endian, as every browser)
    pos = 0;
  };
  const byte = () => {
    if (pos === 64) refill();
    return block[pos++];
  };
  const u32 = () => (byte() | (byte() << 8) | (byte() << 16) | (byte() << 24)) >>> 0;
  return {
    fill(a: Uint8Array) {
      for (let i = 0; i < a.length; i++) a[i] = byte();
    },
    // 53 random bits, as a double in [0, 1)
    float: () => ((u32() >>> 5) * 67108864 + (u32() >>> 6)) / 9007199254740992,
  };
}

if (typeof params.seed === "string" && /^[0-9a-f]{64}$/i.test(params.seed)) {
  const g = chacha20(params.seed);
  Math.random = g.float;
  const grv = (a: any) => {
    if (!ArrayBuffer.isView(a)) return crypto.getRandomValues(a); // (the browser's error)
    g.fill(new Uint8Array(a.buffer, a.byteOffset, a.byteLength));
    return a;
  };
  try {
    Object.defineProperty(crypto, "getRandomValues", { value: grv, configurable: true, writable: true });
  } catch {
    (crypto as any).getRandomValues = grv;
  }
}

// ------------------------------------------------------------ the clock
let recording: number[] | null = [];
let replaying: number[] | null = Array.isArray(params.startup) ? params.startup : null;
let replayPos = 0, extra = 0, overflow = false;

function clock(real: () => number): number {
  if (recording === null) return real(); // between runs
  let v: number;
  if (replaying !== null && replayPos < replaying.length) v = replaying[replayPos++];
  else {
    v = real();
    if (replaying !== null) extra++;
  }
  if (recording.length < CAP) recording.push(v);
  else overflow = true;
  return v;
}
Date.now = () => clock(realDateNow);
performance.now = () => clock(realPerfNow);
(globalThis as any).Date = new Proxy(RealDate, {
  construct(target, args, newTarget) {
    return Reflect.construct(target, args.length ? args : [Date.now()], newTarget);
  },
  apply(target, thisArg, args) {
    return args.length ? Reflect.apply(target, thisArg, args) : new RealDate(Date.now()).toString();
  },
});

export interface ClockRecord {
  /** the values read, in order (at most CAP) */
  clock: number[];
  /** more than CAP values were read: the run cannot be replayed exactly */
  overflow?: true;
  /** replay: the run read this many values beyond the recorded ones (it diverged) */
  extra?: number;
  /** replay: the run read fewer values than recorded (it diverged) */
  unused?: number;
}

function finish(): ClockRecord {
  const r: ClockRecord = { clock: recording ?? [] };
  if (overflow) r.overflow = true;
  if (replaying !== null) {
    if (extra) r.extra = extra;
    if (replayPos < replaying.length) r.unused = replaying.length - replayPos;
  }
  recording = null;
  replaying = null;
  replayPos = extra = 0;
  overflow = false;
  return r;
}

export const replayEnv = {
  /** whether the session's entropy is seeded */
  seeded: typeof params.seed === "string" && /^[0-9a-f]{64}$/i.test(params.seed),
  /** the real clock, for timing (not recorded) */
  now: realPerfNow,
  /** the clock values read while the worker started (call once, when ready) */
  endStartup: (): ClockRecord => finish(),
  /** a run starts: record its clock reads, replaying `clock` if given */
  begin(clock?: number[]) {
    recording = [];
    replaying = Array.isArray(clock) ? clock : null;
    replayPos = extra = 0;
    overflow = false;
  },
  /** the run ended: what it read */
  end: (): ClockRecord => finish(),
};
