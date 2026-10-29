// The LaTeX editor's performance marks (plan sbspace r5 §6): named User Timing marks with a small detail, read by the
// TIMING harness (in its run packet, not in the site). No behaviour depends on them. Bounded: past MAX_MARKS of its own, the editor
// clears its marks (and only its own: by name).
const MAX_MARKS = 2000;
const NAMES = new Set<string>();
let count = 0;
export function mark(name: string, detail: Record<string, unknown>) {
  try {
    if (++count > MAX_MARKS) { for (const n of NAMES) performance.clearMarks(n); count = 1; }
    NAMES.add(name);
    performance.mark(name, { detail });
  } catch {}
}
