// Numbers for a chart: a range, and its sum.
export function range(n) {
  return Array.from({ length: n }, (_, i) => i);
}

export function sum(xs) {
  return xs.reduce((a, b) => a + b, 0);
}
