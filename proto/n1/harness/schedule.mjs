// N1-0 schedules (pre-registration r5 §4): seeded, reproducible label orders, and the
// independent validator that is the gate.  The generator only proposes; a schedule is
// written (and later frozen) only if validate() accepts it.
//
//   node schedule.mjs main <seed> <os>         -> schedule-<os>.json on stdout
//   node schedule.mjs control <seed> <class>   -> controls-<os>-<class>.json body on stdout
//
// Main: labels 1a, 1b, 2, 3; 7 rounds; each label's count per position is 1 or 2.
// Escalation: the same 4 labels and positions, 14 rounds, counts 3 or 4, and over all
// 21 rounds counts 5 or 6.  Controls: labels "1" and "1+p", 7 rounds, counts 4 and 3.
import { createHash } from "node:crypto";

export const MAIN_LABELS = ["1a", "1b", "2", "3"];
export const CONTROL_LABELS = ["1", "1+p"];

// A deterministic stream of uniform integers from a seed string: sha256(seed ":" n),
// the first 6 bytes of each digest.  (Not Math.random: the schedule must be re-derivable.)
export function stream(seed) {
  let n = 0;
  return {
    int(k) {
      if (!Number.isInteger(k) || k < 1) throw new Error(`stream.int: bad bound ${k}`);
      const h = createHash("sha256").update(`${seed}:${n++}`).digest();
      return h.readUIntBE(0, 6) % k;
    },
  };
}

function shuffle(arr, rnd) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = rnd.int(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// A random 4x4 Latin square over `labels`: the cyclic square with its rows, columns and
// symbols permuted.  Row r is a round's order (position -> label).
function latin(labels, rnd) {
  const k = labels.length;
  const rows = shuffle([...Array(k).keys()], rnd), cols = shuffle([...Array(k).keys()], rnd);
  const sym = shuffle(labels, rnd);
  return rows.map((r) => cols.map((c) => sym[(r + c) % k]));
}

// counts[label][position] over a list of orders.
export function counts(orders, labels) {
  const out = Object.fromEntries(labels.map((l) => [l, Array(labels.length).fill(0)]));
  for (const o of orders) o.forEach((l, p) => out[l][p]++);
  return out;
}

function eachCountIn(orders, labels, allowed) {
  const c = counts(orders, labels);
  return labels.every((l) => c[l].every((x) => allowed.includes(x)));
}

function isPermutation(o, labels) {
  return o.length === labels.length && new Set(o).size === labels.length && o.every((l) => labels.includes(l));
}

// The gate.  Returns [] if the schedule meets §4, else a list of reasons.
export function validate(s) {
  const bad = [];
  if (s.kind === "main") {
    const L = MAIN_LABELS;
    if (!Array.isArray(s.rounds) || s.rounds.length !== 7) bad.push("main: not 7 rounds");
    else {
      if (!s.rounds.every((o) => isPermutation(o, L))) bad.push("main: a round is not a permutation of 1a,1b,2,3");
      else if (!eachCountIn(s.rounds, L, [1, 2])) bad.push("main: a label's count in some position is not 1 or 2");
    }
    if (!Array.isArray(s.escalation) || s.escalation.length !== 14) bad.push("escalation: not 14 rounds");
    else {
      if (!s.escalation.every((o) => isPermutation(o, L))) bad.push("escalation: a round is not a permutation");
      else if (!eachCountIn(s.escalation, L, [3, 4])) bad.push("escalation: a count is not 3 or 4");
      else if (Array.isArray(s.rounds) && s.rounds.length === 7 && !eachCountIn([...s.rounds, ...s.escalation], L, [5, 6]))
        bad.push("main + escalation: a count over 21 rounds is not 5 or 6");
    }
  } else if (s.kind === "control") {
    const L = CONTROL_LABELS;
    if (!Array.isArray(s.rounds) || s.rounds.length !== 7) bad.push("control: not 7 rounds");
    else if (!s.rounds.every((o) => isPermutation(o, L))) bad.push("control: a round is not a permutation of 1,1+p");
    else {
      const c = counts(s.rounds, L);
      const a = c["1"][0], b = c["1+p"][0];
      if (!((a === 4 && b === 3) || (a === 3 && b === 4))) bad.push("control: first-position counts are not 4 and 3");
    }
  } else bad.push(`unknown kind ${s.kind}`);
  return bad;
}

// Main + escalation.  The first 7 rounds are a full Latin square plus three rows of a
// second square L; L's fourth row is exactly each label's missing position, so the
// escalation (three full squares plus that row and a row deranged from it) brings every
// combined count to 5 or 6.
export function mainSchedule(seed, os) {
  const rnd = stream(`main:${os}:${seed}`);
  const A = latin(MAIN_LABELS, rnd), L = latin(MAIN_LABELS, rnd);
  const first = shuffle([...A, L[0], L[1], L[2]], rnd);
  const row4 = L[3];
  let other;
  do other = shuffle(MAIN_LABELS, rnd);
  while (other.some((l, p) => row4[p] === l));
  const esc = shuffle([...latin(MAIN_LABELS, rnd), ...latin(MAIN_LABELS, rnd), ...latin(MAIN_LABELS, rnd), row4, other], rnd);
  const s = { kind: "main", os, seed: String(seed), labels: MAIN_LABELS, rounds: first, escalation: esc };
  s.counts = { rounds: counts(first, MAIN_LABELS), escalation: counts(esc, MAIN_LABELS), all21: counts([...first, ...esc], MAIN_LABELS) };
  const bad = validate(s);
  if (bad.length) throw new Error(`generated schedule failed its gate: ${bad.join("; ")}`);
  return s;
}

export function controlSchedule(seed, os, cls) {
  const rnd = stream(`control:${os}:${cls}:${seed}`);
  const fourFirst = CONTROL_LABELS[rnd.int(2)];
  const other = CONTROL_LABELS.find((l) => l !== fourFirst);
  const orders = shuffle([...Array(4).fill([fourFirst, other]), ...Array(3).fill([other, fourFirst])], rnd).map((o) => o.slice());
  const s = { kind: "control", os, class: cls, seed: String(seed), labels: CONTROL_LABELS, rounds: orders, counts: counts(orders, CONTROL_LABELS) };
  const bad = validate(s);
  if (bad.length) throw new Error(`generated control schedule failed its gate: ${bad.join("; ")}`);
  return s;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [kind, seed, os, cls] = process.argv.slice(2);
  if (!seed || !os || (kind === "control" && !cls) || !["main", "control"].includes(kind)) {
    process.stderr.write("usage: node schedule.mjs main <seed> <os> | control <seed> <os> <class>\n");
    process.exit(2);
  }
  const s = kind === "main" ? mainSchedule(seed, os) : controlSchedule(seed, os, cls);
  process.stdout.write(JSON.stringify(s, null, 1) + "\n");
}
