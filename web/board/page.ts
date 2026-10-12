// The board page (web/board/index.html): a synthetic board for now
// (?items=N&strokes=N), and window.boardBench for test/board-bench.mjs.
import { Board, synthetic, type Camera } from "./board";

const q = new URLSearchParams(location.search);
const board = new Board(document.getElementById("board")!);
const items = synthetic(Number(q.get("items") ?? 2000), Number(q.get("strokes") ?? 20000));
board.setItems(items);
board.setCamera({ x: 0, y: 0, z: 1 });
// first paint: the end of the first render after load
requestAnimationFrame(() => requestAnimationFrame(() => { (window as any).firstPaint = performance.now(); }));

// Measure frames while the camera moves along `path` (one camera per frame):
// the intervals between frames and the time render() takes in each.
async function bench(path: Camera[]) {
  const intervals: number[] = [], work: number[] = [];
  let last = performance.now();
  for (const c of path) {
    await new Promise<void>((r) => requestAnimationFrame(() => {
      const t0 = performance.now();
      board.setCamera(c);
      board.render();
      work.push(performance.now() - t0);
      intervals.push(t0 - last);
      last = t0;
      r();
    }));
  }
  const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(p * xs.length))];
  return {
    frames: path.length,
    interval: { p50: pct(intervals, 0.5), p95: pct(intervals, 0.95), max: Math.max(...intervals) },
    work: { p50: pct(work, 0.5), p95: pct(work, 0.95), max: Math.max(...work) },
    mounted: board.stats.mounted, mounts: board.stats.mounts, drawn: board.stats.drawn,
  };
}
(window as any).board = board;
(window as any).boardBench = bench;
