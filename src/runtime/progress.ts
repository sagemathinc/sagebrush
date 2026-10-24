// Live progress (design-estimates-progress r4 §6): 32 per-call slots of 24
// u32 words in a SharedArrayBuffer beside R.INTR (when the page is
// cross-origin isolated, as INTR is; otherwise a plain array that only this
// thread reads), plus a 32-bit occupancy bitmap after them.  The layout is
// engine/interrupt/src/progress.rs's (encode/decode below are the same):
//
//   0 seq (seqlock)   1 flags   2-3 call_id   4-5 parent_id   6 generation
//   7 op   8 stage   9 stage_index | stage_count << 16   10-11 done
//   12-13 total   14-15 work   16 memory_now KiB   17 memory_peak KiB
//   18 unit   19 time_fraction   20-21 started_ms   22-23 reserved (zero)
//
// Writers: Python routines (the builtin module _progress) and the engine's
// frames, which the engine writes in its own memory and this host copies in
// the engine's existing `sagebrush.interrupted` import (engine.ts; at most
// every 250 ms, and whenever a frame begins or ends), so the engine has no
// new import.  The reader, snapshot(), may run on any thread that has the
// buffer; it never makes a writer wait.  Progress never changes a result or
// stops a computation: a failure here is logged once and turns progress off.

export const SLOTS = 32;
export const WORDS = 24;
export const SAT53 = 2 ** 53 - 1;
export const SAT16 = 0xfffe;
export const HOST_NAMES = 0x80000000;
export const UNTRACKED_REASON = "all 32 progress slots are in use";
/** The longest interval between two copies of a running call's counts. */
export let COPY_EVERY_MS = 250;

export const F = {
  IN_USE: 1 << 0,
  TOTAL_UNKNOWN: 1 << 1,
  STAGE_COUNT_UNKNOWN: 1 << 2,
  FRACTION: 1 << 3,
  BEYOND_FORECAST: 1 << 4,
  DONE_SATURATED: 1 << 5,
  WORK_SATURATED: 1 << 6,
  MEMORY_SATURATED: 1 << 7,
  TOTAL_SATURATED: 1 << 8,
  EARLY_PART_UNTRACKED: 1 << 9,
  STAGE_INDEX_SATURATED: 1 << 10,
  STAGE_COUNT_SATURATED: 1 << 11,
  ALL: (1 << 12) - 1,
};

const g = globalThis as any;
const shared = typeof SharedArrayBuffer === "function" && (g.crossOriginIsolated || (typeof g.process === "object" && !!g.process.versions?.node));
/** The slots, then the bitmap (word SLOTS * WORDS). */
export const PROGRESS: Int32Array = shared ? new Int32Array(new SharedArrayBuffer(4 * (SLOTS * WORDS + 1))) : new Int32Array(SLOTS * WORDS + 1);
const BITMAP = SLOTS * WORDS;

/** One slot, decoded (the values as reported; encode saturates them). */
export interface Slot {
  inUse: boolean;
  callId: number;
  parentId: number;
  generation: number;
  op: number;
  stage: number;
  stageIndex: number;
  stageIndexSaturated?: boolean;
  /** null: unknown */
  stageCount: number | null;
  stageCountSaturated?: boolean;
  done: number;
  doneSaturated?: boolean;
  /** null: unknown */
  total: number | null;
  totalSaturated?: boolean;
  work: number;
  workSaturated?: boolean;
  memoryNowKiB: number;
  memoryPeakKiB: number;
  memorySaturated?: boolean;
  unit: number;
  /** null: absent */
  fraction: number | null;
  beyondForecast: boolean;
  earlyPartUntracked: boolean;
  startedMs: number;
}

export function emptySlot(): Slot {
  return { inUse: false, callId: 0, parentId: 0, generation: 0, op: 0, stage: 0, stageIndex: 0, stageCount: null, done: 0, total: null, work: 0, memoryNowKiB: 0, memoryPeakKiB: 0, unit: 0, fraction: null, beyondForecast: false, earlyPartUntracked: false, startedMs: 0 };
}

function put64(w: Uint32Array, i: number, v: number) {
  w[i] = v % 2 ** 32;
  w[i + 1] = Math.floor(v / 2 ** 32);
}
const get64 = (w: Uint32Array, i: number) => w[i] + w[i + 1] * 2 ** 32;
const sat53 = (v: number): [number, boolean] => (v > SAT53 ? [SAT53, true] : [Math.max(0, Math.floor(v)), false]);

/** The slot's 24 words (seq 0, the reserved words zero). */
export function encode(s: Slot): Uint32Array {
  const w = new Uint32Array(WORDS);
  let f = s.inUse ? F.IN_USE : 0;
  put64(w, 2, s.callId);
  put64(w, 4, s.parentId);
  w[6] = s.generation;
  w[7] = s.op;
  w[8] = s.stage;
  let index = s.stageIndex;
  if (index > SAT16 || s.stageIndexSaturated) {
    f |= F.STAGE_INDEX_SATURATED;
    index = SAT16;
  }
  let count: number;
  if (s.stageCount === null) {
    f |= F.STAGE_COUNT_UNKNOWN;
    count = 0xffff;
  } else if (s.stageCount > SAT16 || s.stageCountSaturated) {
    f |= F.STAGE_COUNT_SATURATED;
    count = SAT16;
  } else count = s.stageCount;
  w[9] = (index | (count << 16)) >>> 0;
  const [done, ds] = sat53(s.done);
  if (ds || s.doneSaturated) f |= F.DONE_SATURATED;
  put64(w, 10, done);
  if (s.total === null) {
    f |= F.TOTAL_UNKNOWN;
    w[12] = w[13] = 0xffffffff;
  } else {
    const [t, ts] = sat53(s.total);
    if (ts || s.totalSaturated) f |= F.TOTAL_SATURATED;
    put64(w, 12, t);
  }
  const [work, ws] = sat53(s.work);
  if (ws || s.workSaturated) f |= F.WORK_SATURATED;
  put64(w, 14, work);
  const kib = (v: number) => {
    if (v > 0xffffffff) {
      f |= F.MEMORY_SATURATED;
      return 0xffffffff;
    }
    return Math.max(0, Math.floor(v));
  };
  w[16] = kib(s.memoryNowKiB);
  w[17] = kib(s.memoryPeakKiB);
  if (s.memorySaturated) f |= F.MEMORY_SATURATED;
  w[18] = s.unit;
  if (s.fraction !== null) {
    f |= F.FRACTION;
    const x = Number.isNaN(s.fraction) ? 0 : Math.min(1, Math.max(0, s.fraction));
    w[19] = Math.round(x * 0xffffffff);
  }
  if (s.beyondForecast) f |= F.BEYOND_FORECAST;
  if (s.earlyPartUntracked) f |= F.EARLY_PART_UNTRACKED;
  put64(w, 20, s.startedMs);
  w[1] = f >>> 0;
  return w;
}

/** The slot the words hold. */
export function decode(w: Uint32Array): Slot {
  const f = w[1], pos = w[9];
  return {
    inUse: !!(f & F.IN_USE),
    callId: get64(w, 2),
    parentId: get64(w, 4),
    generation: w[6],
    op: w[7],
    stage: w[8],
    stageIndex: pos & 0xffff,
    stageIndexSaturated: !!(f & F.STAGE_INDEX_SATURATED),
    stageCount: f & F.STAGE_COUNT_UNKNOWN ? null : pos >>> 16,
    stageCountSaturated: !!(f & F.STAGE_COUNT_SATURATED),
    done: get64(w, 10),
    doneSaturated: !!(f & F.DONE_SATURATED),
    total: f & F.TOTAL_UNKNOWN ? null : get64(w, 12),
    totalSaturated: !!(f & F.TOTAL_SATURATED),
    work: get64(w, 14),
    workSaturated: !!(f & F.WORK_SATURATED),
    memoryNowKiB: w[16],
    memoryPeakKiB: w[17],
    memorySaturated: !!(f & F.MEMORY_SATURATED),
    unit: w[18],
    fraction: f & F.FRACTION ? w[19] / 0xffffffff : null,
    beyondForecast: !!(f & F.BEYOND_FORECAST),
    earlyPartUntracked: !!(f & F.EARLY_PART_UNTRACKED),
    startedMs: get64(w, 20),
  };
}

// ---- the slot buffer (one writer per slot: its owner)

function claim(buf: Int32Array = PROGRESS): number {
  for (;;) {
    const cur = Atomics.load(buf, BITMAP) >>> 0;
    if (cur === 0xffffffff) return -1;
    let i = 0;
    while (cur & (1 << i)) i++;
    const next = (cur | (1 << i)) | 0;
    if (Atomics.compareExchange(buf, BITMAP, cur | 0, next) === (cur | 0)) return i;
  }
}

/** Writes slot i under the seqlock. */
export function store(i: number, w: Uint32Array, buf: Int32Array = PROGRESS) {
  const b = i * WORDS;
  const s = Atomics.load(buf, b);
  Atomics.store(buf, b, (s + 1) | 0);
  for (let k = 1; k < WORDS; k++) Atomics.store(buf, b + k, w[k] | 0);
  Atomics.store(buf, b, (s + 2) | 0);
}

/** Clears slot i, then frees it in the bitmap (in that order). */
function release(i: number, buf: Int32Array = PROGRESS) {
  store(i, new Uint32Array(WORDS), buf);
  Atomics.and(buf, BITMAP, ~(1 << i));
}

/** A consistent copy of slot i, or null after 4 torn reads. */
export function read(i: number, buf: Int32Array = PROGRESS): Uint32Array | null {
  const b = i * WORDS;
  for (let tries = 0; tries < 4; tries++) {
    const s1 = Atomics.load(buf, b);
    if (s1 & 1) continue;
    const w = new Uint32Array(WORDS);
    for (let k = 0; k < WORDS; k++) w[k] = Atomics.load(buf, b + k);
    if (Atomics.load(buf, b) === s1) return w;
  }
  return null;
}

// ---- calls

let nextId = 1;
let generation = 1;
/** The calls running on this thread, innermost last (a new call's parent). */
const stack: Call[] = [];
const untracked = new Map<number, Call>();
let failed = false;

/** Names a host registers (a Python routine's op, stage or unit), by index - HOST_NAMES. */
const hostNames: string[] = [];
/** The engine's static tables (progress_tables), once the engine has loaded. */
let engineTables: { ops: string[]; stages: string[]; units: string[] } | null = null;

export function setEngineTables(t: { ops: string[]; stages: string[]; units: string[] }) {
  engineTables = t;
}

/** The index of a host-registered name (registered at first use). */
export function nameIndex(name: string): number {
  let i = hostNames.indexOf(name);
  if (i < 0) {
    hostNames.push(name);
    i = hostNames.length - 1;
  }
  return HOST_NAMES + i;
}

/** The names behind the indices: the engine's tables (once it has loaded)
 *  and this host's registered names. */
export function tables() {
  return { ops: engineTables?.ops ?? [], stages: engineTables?.stages ?? [], units: engineTables?.units ?? [], host_names: HOST_NAMES, host: hostNames.slice() };
}

function nameOf(kind: "ops" | "stages" | "units", i: number): string {
  if (i >= HOST_NAMES) return hostNames[i - HOST_NAMES] ?? "";
  return engineTables?.[kind][i] ?? (i === 0 ? "" : `#${i}`);
}

/** One call's progress, from begin() until end(). */
export class Call {
  readonly id: number;
  readonly parentId: number;
  readonly startedMs: number;
  slot: number;
  early = false;
  ended = false;
  lastMs = 0;
  readonly s: Slot;

  constructor(op: number, parentId: number) {
    this.id = nextId++;
    this.parentId = parentId;
    this.startedMs = Date.now();
    this.s = { ...emptySlot(), inUse: true, callId: this.id, parentId, generation, op, startedMs: this.startedMs };
    this.slot = claim();
    if (this.slot < 0) untracked.set(this.id, this);
  }

  /** Writes the counts, at most every COPY_EVERY_MS (cheap to call at every poll). */
  publish() {
    const t = Date.now();
    if (t - this.lastMs >= COPY_EVERY_MS) this.flush(t);
  }

  /** Writes the counts now. */
  flush(t: number = Date.now()) {
    if (this.ended || failed) return;
    this.lastMs = t;
    try {
      if (this.slot < 0) {
        const i = claim();
        if (i < 0) return;
        this.slot = i;
        this.early = true;
        untracked.delete(this.id);
      }
      this.s.earlyPartUntracked = this.early;
      store(this.slot, encode(this.s));
    } catch (e) {
      disable(e);
    }
  }

  end() {
    if (this.ended) return;
    this.ended = true;
    const k = stack.lastIndexOf(this);
    if (k >= 0) stack.splice(k, 1);
    if (this.slot >= 0) release(this.slot);
    else untracked.delete(this.id);
  }
}

function disable(e: unknown) {
  if (failed) return;
  failed = true;
  try {
    console.error(`sagebrush: progress reporting is off for this session (${e})`);
  } catch {
    // nothing to tell it with
  }
}

/** Starts a call (its parent: the innermost call running here, or `parentId`). */
export function begin(op: number, parentId?: number): Call {
  const c = new Call(op, parentId ?? stack[stack.length - 1]?.id ?? 0);
  stack.push(c);
  c.flush();
  return c;
}

/** The innermost call running here, if any. */
export function current(): Call | undefined {
  return stack[stack.length - 1];
}

/** Ends every call of the current engine generation that `owned` lists and
 *  starts a new generation (the engine instance was dropped). */
export function newGeneration() {
  generation++;
}

export function currentGeneration() {
  return generation;
}

// ---- the reader

const SNAPSHOT_TRIES = 4;

/** progress/1 records of every call in progress now: the tracked ones from
 *  the slots, the untracked ones from this host (no counts). */
export function snapshot(buf: Int32Array = PROGRESS): any[] {
  const out: any[] = [];
  const now = Date.now();
  const bits = Atomics.load(buf, BITMAP) >>> 0;
  for (let i = 0; i < SLOTS; i++) {
    if (!(bits & (1 << i))) continue;
    let w: Uint32Array | null = null;
    for (let k = 0; k < SNAPSHOT_TRIES && !w; k++) w = read(i, buf);
    if (!w) continue;
    const s = decode(w);
    if (s.inUse) out.push(record(s, now));
  }
  for (const c of untracked.values())
    out.push({ schema: "sagebrush.progress/1", call_id: c.id, parent_id: c.parentId, op: nameOf("ops", c.s.op), status: "untracked", reason: UNTRACKED_REASON, elapsed_s: Math.max(0, (now - c.startedMs) / 1000) });
  return out;
}

/** The progress/1 record of a decoded slot. */
export function record(s: Slot, now: number = Date.now()): any {
  const r: any = {
    schema: "sagebrush.progress/1",
    call_id: s.callId,
    parent_id: s.parentId,
    op: nameOf("ops", s.op),
    status: "running",
    stage: nameOf("stages", s.stage),
    stage_index: s.stageIndex,
    count: { done: s.done, unit: nameOf("units", s.unit), label: "counted" } as any,
    elapsed_s: Math.max(0, (now - s.startedMs) / 1000),
    beyond_forecast: s.beyondForecast,
  };
  if (s.stageCount !== null) r.stage_count = s.stageCount;
  if (s.total !== null) r.count.total = s.total;
  if (s.doneSaturated || s.totalSaturated) r.count.saturated = true;
  if (s.fraction !== null) r.time_fraction = { value: s.fraction, label: "estimated fraction" };
  if (s.work) r.work_spent = s.work;
  if (s.memoryNowKiB) r.memory_now_bytes = s.memoryNowKiB * 1024;
  if (s.memoryPeakKiB) r.memory_peak_bytes = s.memoryPeakKiB * 1024;
  if (s.earlyPartUntracked) r.early_part_untracked = true;
  return r;
}

// ---- the engine's frames (engine.ts calls these)

/** The engine's frame area, as the engine laid it out (progress.rs): word 0
 *  the layout version, 1 an epoch, 2 the depth, then 24-word frames. */
const FRAME_HEADER = 4;
/** The area's length in words: the header and 32 frames (progress.rs FRAMES). */
export const FRAME_WORDS = FRAME_HEADER + 32 * WORDS;
let engineCalls: { serial: number; call: Call }[] = [];
let lastEpoch = -1;
let lastCopy = 0;

/** Called inside the engine's interrupted() import: copies the frames into
 *  slots when a frame began or ended, or COPY_EVERY_MS after the last copy. */
export function syncFrames(area: Uint32Array | null) {
  if (!area || failed) return;
  try {
    if (area[0] !== 1) return;
    const epoch = area[1], now = Date.now();
    if (epoch === lastEpoch && now - lastCopy < COPY_EVERY_MS) return;
    lastEpoch = epoch;
    lastCopy = now;
    const depth = Math.min(area[2], (area.length - FRAME_HEADER) / WORDS);
    // frames that ended, or were replaced at the same depth
    let keep = 0;
    while (keep < engineCalls.length && keep < depth && engineCalls[keep].serial === area[FRAME_HEADER + keep * WORDS + 2]) keep++;
    for (let i = engineCalls.length - 1; i >= keep; i--) engineCalls[i].call.end();
    engineCalls.length = keep;
    for (let d = 0; d < depth; d++) {
      const fw = area.subarray(FRAME_HEADER + d * WORDS, FRAME_HEADER + (d + 1) * WORDS);
      const f = decode(fw);
      if (d >= engineCalls.length) {
        const parent = d > 0 ? engineCalls[d - 1].call.id : undefined;
        engineCalls.push({ serial: fw[2], call: begin(f.op, parent) });
      }
      const c = engineCalls[d].call;
      Object.assign(c.s, { stage: f.stage, stageIndex: f.stageIndex, stageIndexSaturated: f.stageIndexSaturated, stageCount: f.stageCount, stageCountSaturated: f.stageCountSaturated, done: f.done, doneSaturated: f.doneSaturated, total: f.total, totalSaturated: f.totalSaturated, work: f.work, workSaturated: f.workSaturated, memoryNowKiB: f.memoryNowKiB, memoryPeakKiB: f.memoryPeakKiB, memorySaturated: f.memorySaturated, unit: f.unit, fraction: f.fraction, beyondForecast: f.beyondForecast });
      c.flush(now);
    }
  } catch (e) {
    disable(e);
  }
}

/** The engine call returned, raised or trapped: its frames' calls end. */
export function endFrames(trapped: boolean) {
  for (let i = engineCalls.length - 1; i >= 0; i--) engineCalls[i].call.end();
  engineCalls = [];
  lastEpoch = -1;
  if (trapped) newGeneration();
}

/** Tests only: the copy interval. */
export function setCopyInterval(ms: number) {
  COPY_EVERY_MS = ms;
}

/** Tests only: whether reporting was turned off by a failure, and reset it. */
export function resetForTests() {
  const was = failed;
  failed = false;
  return was;
}
