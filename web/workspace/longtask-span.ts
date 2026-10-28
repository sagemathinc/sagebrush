// The longest main-thread task a save is charged with (the sync-pins cost checks, sync-pins-cases.js): a long
// task counts toward a save for the part of it inside the save's span [t0, t1].  The main thread is busy for all
// of a task, so a save's own work, which starts at t0, can't run outside its span; a task that began before t0
// and ended inside it (setup garbage collected late) is that save's only for its overlap, and a task touching
// two saves is charged to each by its own intersection, the largest of them counted, never their sum.
// longestRaw: the whole of the longest task touching any save, reported beside it.

export interface TaskLike {
  startTime: number;
  duration: number;
}

export function saveLongest(tasks: TaskLike[], spans: [number, number][]): { longest: number; longestRaw: number } {
  const inter = (e: TaskLike, [a, b]: [number, number]) => Math.min(b, e.startTime + e.duration) - Math.max(a, e.startTime);
  let longest = 0, longestRaw = 0;
  for (const e of tasks) {
    const parts = spans.map((s) => inter(e, s)).filter((x) => x > 0);
    if (!parts.length) continue;
    longest = Math.max(longest, ...parts);
    longestRaw = Math.max(longestRaw, e.duration);
  }
  return { longest, longestRaw };
}

// the gate a save row passes: its in-save longest task under 50 ms (and, as a consistency check, no longer than
// its slowest save)
export const saveTaskGate = (x: { longest: number; ms: number }) => x.longest < 50 && x.longest <= x.ms + 1;
