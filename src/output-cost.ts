// What a display costs against an output budget (board run's: the worker,
// src/notebook-session.ts, and the main thread, src/board-run.ts collect,
// charge it the same): its strings, its MIME types' names and an envelope
// for the message itself, so that an empty one isn't free (HARD-58F-1).
export const DISPLAY_ENVELOPE = 64;

export function displayCost(bundle: Record<string, unknown>): number {
  let n = DISPLAY_ENVELOPE;
  for (const [k, v] of Object.entries(bundle)) n += k.length + (typeof v === "string" ? v.length : 0);
  return n;
}
