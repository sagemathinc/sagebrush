// The Sato-Tate histogram (an SVG string), apart from render.ts so that the
// page script can redraw it without loading KaTeX.
import { BOUND, type Orbit, type Space, primesUpTo } from "./model.ts";

/** A histogram of a_p / 2 p^((k-1)/2) against the Sato-Tate density. */
export function satoTateSvg(xs: number[], label: string): string {
  const bins = 24, h = new Array(bins).fill(0);
  for (const x of xs) h[Math.min(bins - 1, Math.max(0, Math.floor(((x + 1) / 2) * bins)))]++;
  const W = 480, H = 170, pad = 22, dx = (W - 2 * pad) / bins;
  const dens = h.map((c) => (c / xs.length) * (bins / 2)); // density on [-1, 1]
  const ymax = Math.max(0.75, ...dens) * 1.08;
  const y = (v: number) => H - pad - (v / ymax) * (H - 2 * pad);
  const bars = dens.map((v, i) => `<rect x="${(pad + i * dx + 0.5).toFixed(1)}" y="${y(v).toFixed(1)}" width="${(dx - 1).toFixed(1)}" height="${(H - pad - y(v)).toFixed(1)}" fill="var(--accent2)" opacity=".75"/>`).join("");
  let path = "";
  for (let i = 0; i <= 100; i++) {
    const t = -1 + i / 50, v = (2 / Math.PI) * Math.sqrt(Math.max(0, 1 - t * t));
    path += `${i ? "L" : "M"}${(pad + ((t + 1) / 2) * (W - 2 * pad)).toFixed(1)},${y(v).toFixed(1)}`;
  }
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" style="max-width:${W}px" role="img" aria-label="${label.replace(/"/g, "&quot;")}">${bars}<path d="${path}" fill="none" stroke="var(--err)" stroke-width="1.5"/>
<line x1="${pad}" x2="${W - pad}" y1="${H - pad}" y2="${H - pad}" stroke="var(--line)"/><text x="${pad}" y="${H - 6}" text-anchor="middle">−1</text><text x="${W / 2}" y="${H - 6}" text-anchor="middle">0</text><text x="${W - pad}" y="${H - 6}" text-anchor="middle">1</text></svg>`;
}

/** The cost of aplist(E, X) in the WebAssembly engine, independent of the
 *  curve (measured for X = 10^4 .. 10^7, web/atlas/README.md): seconds
 *  and peak bytes (mostly the reply). */
export function apCost(X: number): { seconds: number; bytes: number } {
  return { seconds: 0.008 + 3.2e-8 * X * Math.log(X), bytes: 1.2e6 + 11.5 * X };
}

export function normalizedAp(sp: Space, f: Orbit, upto = BOUND): number[] {
  const k = sp.weight;
  return primesUpTo(Math.min(upto, f.traces.length)).filter((p) => sp.level % p !== 0).map((p) => Number(f.traces[p - 1]) / (2 * Math.pow(p, (k - 1) / 2)));
}
