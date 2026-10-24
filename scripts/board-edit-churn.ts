// The churn fixture of plan-board-open-edit r7 §8.2: `board open --edit`'s hub under many tabs, with outside
// writes, old bases, compaction, releases (tombstones made, replaced at TAB_TOMBSTONES, reactivated),
// reconnects and boards near EDIT_MAX; run under a V8 heap capped at MEMORY_MAX plus a fixed margin, so a
// hub that held more than its ledger allows dies here.  It also asserts the ledger never passed MEMORY_MAX.
//
//   node --expose-gc --max-old-space-size=<(MEMORY_MAX + MARGIN) in MiB> dist/scripts/board-edit-churn.js \
//     [--tabs 256] [--rounds 40] [--board-mib 8] [--memory-mib 1024]
//
// The margin (MARGIN_MIB below) is the implementation's own: the runtime, the test's own boards and the
// patchflow module.  Measured once with --no-hub (the same boards and snapshots made and hashed, nothing
// submitted; the hub holding only P₀): VM2, node 26, Oct 24 2026, 256 tabs, 2 rounds: peak heap 200 MiB
// at --board-mib 4 and 537 MiB at --board-mib 15.  MARGIN_MIB is 640, the larger with 1.2x headroom.  Not in the default suite (minutes, and
// gigabytes): run on a build VM, its output reported with the change that needs it.
import * as fs from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createHash } from "crypto";
import { EditHub } from "../src/board-edit-hub";
import { defaultLimits } from "../src/board-edit-limits";
import { editRecords } from "../web/board/lossless";

export const MARGIN_MIB = 640;
const arg = (name: string, d: number) => { const i = process.argv.indexOf("--" + name); return i > 0 ? Number(process.argv[i + 1]) : d; };
const NO_HUB = process.argv.includes("--no-hub");
const TABS = arg("tabs", 256), ROUNDS = arg("rounds", 40), BOARD_MIB = arg("board-mib", 8), MEMORY_MIB = arg("memory-mib", 1024);
const MiB = 1024 * 1024;
const { mergeStrings3 } = require("patchflow");
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
// (a seeded generator: the same run every time)
let seed = 12345;
const rand = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);

const nodesFor = (bytes: number) => Math.max(1, Math.floor(bytes / 360));
const board = (n: number, round: number, who: string) => ({
  format: "sagebrush-board", version: 1, title: "churn",
  nodes: Array.from({ length: n }, (_, i) => ({ id: "n" + i, text: `node ${i} ` + "x".repeat(300), ...(i % 97 === 0 ? { x: round, by: who } : {}) })),
  edges: Array.from({ length: Math.floor(n / 10) }, (_, i) => ({ from: "n" + i, to: "n" + (i + 1) })),
});
const snap = (d: any) => editRecords(d).map((r) => JSON.stringify(r)).join("\n");

async function main() {
  const dir = fs.mkdtempSync(join(tmpdir(), "sb-churn-"));
  const file = join(dir, "churn.board.json");
  const n = nodesFor(BOARD_MIB * MiB);
  fs.writeFileSync(file, JSON.stringify(board(n, 0, "start"), null, 2) + "\n");
  let now = 1_000_000;
  const limits = { ...defaultLimits(), MEMORY_MAX: MEMORY_MIB * MiB, MAX_CLIENTS: Math.max(TABS, 1), TAB_TOMBSTONES: Math.max(16, Math.floor(TABS / 4)), MERGE_MS: 60_000, MERGE_WORK: 1_000_000_000, BODY_MAX: Math.min(16 * MiB, Math.floor((MEMORY_MIB * MiB) / 36)) };
  const hub = new EditHub(file, limits, { mergeStrings3, now: () => now });
  const started = await hub.start(fs.readFileSync(file));
  if (!started.ok) throw new Error(started.why);
  const tabs = Array.from({ length: TABS }, (_, i) => ({ id: "tab" + i, gen: 0, base: hub.H.seq, live: true }));
  for (const t of tabs) hub.connect(t.id);
  const counts: Record<string, number> = {};
  const count = (k: string) => (counts[k] = (counts[k] ?? 0) + 1);
  let peakHeap = 0, peakRss = 0;
  const sample = () => { const m = process.memoryUsage(); peakHeap = Math.max(peakHeap, m.heapUsed + m.external + m.arrayBuffers); peakRss = Math.max(peakRss, m.rss); };
  const t0 = Date.now();
  let done = 0;
  for (let round = 1; round <= ROUNDS; round++) {
    for (const t of tabs) {
      const roll = rand();
      if (!t.live) {
        // (a released tab comes back: reactivated from its tombstone, or unknown if replaced)
        if (roll < 0.5) { hub.connect(t.id); t.live = true; count("reconnect"); }
        continue;
      }
      if (roll < 0.05 && !NO_HUB) { hub.release(t.id); t.live = false; count("release"); continue; }
      // (a base: the latest, or one some heads back, or (rarely) one long gone)
      const base = roll < 0.7 ? hub.H.seq : roll < 0.95 ? Math.max(1, hub.H.seq - Math.floor(rand() * 20)) : 1;
      const s = snap(board(n, round, t.id));
      // (--no-hub: the same boards and snapshots made and hashed, nothing submitted: the margin)
      if (NO_HUB) { sha(s); ++t.gen; sample(); now += 50; continue; }
      const r = hub.submit(t.id, ++t.gen, base, s, sha(s));
      count(Object.keys(r).find((k) => k !== "op" && k !== "seq") ?? "?");
      if ("accepted" in r) { t.base = r.seq; hub.adopted(t.id, r.seq); }
      if ("included" in r || "unknownTab" in r || "mismatch" in r) t.gen = Math.max(t.gen, (r as any).included ?? 0);
      sample();
      if (rand() < 0.02) {
        // (an outside program writes the file)
        const outside = JSON.stringify(board(n, round, "outside"), null, 2) + "\n";
        fs.writeFileSync(file, outside);
        await hub.observe(Buffer.from(outside));
        count("outside");
        sample();
      }
      now += 50;
      if (hub.due(now)) { const w = await hub.save(); count(w.saved ? "saved" : "save-" + w.why); sample(); }
      await hub.tickPrevs(150);
      // (progress, every 32 tabs: so a run cut short still says how far it got)
      if (++done % 32 === 0) process.stderr.write(`progress: round ${round}, ${done} steps, ${Math.round((Date.now() - t0) / 1000)} s, heap peak ${Math.round(peakHeap / MiB)} MiB, ledger peak ${Math.round(hub.ledger.peak / MiB)} MiB, ${JSON.stringify(counts)}\n`);
      hub.staleTabs.clear();
      hub.events.length = 0;
    }
    if (round % 5 === 0) process.stderr.write(`round ${round}: heap peak ${Math.round(peakHeap / MiB)} MiB, ledger peak ${Math.round(hub.ledger.peak / MiB)} MiB, ${JSON.stringify(counts)}\n`);
  }
  const result = { tabs: TABS, rounds: ROUNDS, boardMiB: BOARD_MIB, memoryMiB: MEMORY_MIB, marginMiB: MARGIN_MIB, seconds: Math.round((Date.now() - t0) / 1000), peakHeapMiB: Math.round(peakHeap / MiB), peakRssMiB: Math.round(peakRss / MiB), ledgerPeakMiB: Math.round(hub.ledger.peak / MiB), counts };
  console.log(JSON.stringify(result));
  fs.rmSync(dir, { recursive: true, force: true });
  if (hub.ledger.peak > limits.MEMORY_MAX) { console.error(`the ledger passed MEMORY_MAX: ${hub.ledger.peak} > ${limits.MEMORY_MAX}`); process.exit(1); }
  if (peakHeap > limits.MEMORY_MAX + MARGIN_MIB * MiB) { console.error(`the heap passed MEMORY_MAX + the margin: ${peakHeap}`); process.exit(1); }
}
main().catch((e) => { console.error(e); process.exit(1); });
