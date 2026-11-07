// N1-0 decision rule (pre-registration r5 §5).  Pure functions, no I/O.
//
// For one comparison (a label c against the baseline b = 1a) and one metric, each usable
// round r gives (x_c,r, x_b,r): per-process medians, smaller is better.  With the metric
// class's frozen (rho, a):
//   t_r = max(a, rho * x_b,r),  e_r = (x_c,r - x_b,r) / t_r.
// Order, frozen: fewer than 5 usable rounds -> undecided; every |e_r| <= 1 -> equivalent;
// every e_r of one strict sign and |median e| > 1 -> different; otherwise undecided.

export const MIN_ROUNDS = 5;

export function median(xs) {
  if (!xs.length) throw new Error("median of nothing");
  const s = xs.slice().sort((p, q) => p - q), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function effects(pairs, { rho, a }) {
  if (!(rho >= 0 && a >= 0) || (rho === 0 && a === 0)) throw new Error(`bad SESOI rho=${rho} a=${a}`);
  return pairs.map(({ xc, xb }) => {
    if (!Number.isFinite(xc) || !Number.isFinite(xb) || xb < 0 || xc < 0) throw new Error(`bad observation xc=${xc} xb=${xb}`);
    const t = Math.max(a, rho * xb);
    if (!(t > 0)) throw new Error(`t_r is not positive (rho=${rho}, a=${a}, xb=${xb})`);
    return (xc - xb) / t;
  });
}

// pairs: [{xc, xb}] for the usable rounds only (admitted, uncontaminated, stable).
export function decide(pairs, sesoi) {
  if (pairs.length < MIN_ROUNDS) return { status: "undecided", reason: "fewer than 5 usable rounds", n: pairs.length, e: [] };
  const e = effects(pairs, sesoi);
  if (e.every((x) => Math.abs(x) <= 1)) return { status: "equivalent", n: e.length, e, median: median(e) };
  const m = median(e);
  const oneSign = e.every((x) => x > 0) || e.every((x) => x < 0);
  if (oneSign && Math.abs(m) > 1) return { status: "different", better: m < 0 ? "candidate" : "baseline", n: e.length, e, median: m };
  return { status: "undecided", reason: "neither rule holds", n: e.length, e, median: m };
}

// One escalation only: a comparison decided on the first 7 rounds keeps that decision
// (the 14 are descriptive for it); an undecided one is decided again over all 21.
export function decideWithEscalation(first, extra, sesoi) {
  const d1 = decide(first, sesoi);
  if (d1.status !== "undecided") return { ...d1, escalated: false };
  if (extra === undefined) return { ...d1, escalated: false, needsEscalation: true };
  return { ...decide([...first, ...extra], sesoi), escalated: true };
}

// A/A: 1b against 1a must be equivalent for a ranked metric to be valid in a run.
export function aaValid(pairs, sesoi) {
  return decide(pairs, sesoi).status === "equivalent";
}

// A timing/memory control: the median of perturbed-minus-plain differences must fall in
// [0.5, 1.5] x the injected amount.  A byte control must recover exactly.
export function controlRecovered(diffs, injected, { exact = false } = {}) {
  if (!diffs.length) return false;
  if (exact) return diffs.every((d) => d === injected);
  const m = median(diffs);
  return m >= 0.5 * injected && m <= 1.5 * injected;
}
