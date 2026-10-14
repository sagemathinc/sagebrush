import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { inflateSync } from "node:zlib";

// lib/matplotlib against matplotlib itself: the expected values below are what
// CPython's matplotlib 3.11.1 prints for the same programs.
const run = (program: string) => execFileSync(process.execPath, [__dirname + "/../src/cli.js", "-c", program], { encoding: "utf8" });

/** the RGBA rows of a data: URL PNG as lib/matplotlib writes it (filter 0 rows; RGBA or a palette) */
function png(url: string): number[][][] {
  const b = Buffer.from(url.slice(url.indexOf(",") + 1), "base64");
  let i = 8, w = 0, h = 0, kind = 0, plte: Buffer | null = null, trns: Buffer | null = null;
  const idat: Buffer[] = [];
  while (i < b.length) {
    const n = b.readUInt32BE(i), t = b.toString("latin1", i + 4, i + 8), d = b.subarray(i + 8, i + 8 + n);
    if (t === "IHDR") { w = d.readUInt32BE(0); h = d.readUInt32BE(4); kind = d[9]; }
    if (t === "PLTE") plte = d;
    if (t === "tRNS") trns = d;
    if (t === "IDAT") idat.push(d);
    i += 12 + n;
  }
  const raw = inflateSync(Buffer.concat(idat)), bpp = kind === 3 ? 1 : 4, rows: number[][][] = [];
  for (let y = 0; y < h; y++) {
    const row: number[][] = [];
    for (let x = 0; x < w; x++) {
      const o = y * (w * bpp + 1) + 1 + x * bpp;
      row.push(kind === 3 ? [plte![3 * raw[o]], plte![3 * raw[o] + 1], plte![3 * raw[o] + 2], trns ? trns[raw[o]] : 255] : [...raw.subarray(o, o + 4)]);
    }
    rows.push(row);
  }
  return rows;
}

test("imshow: limits, extent and clim as matplotlib's; row 0 at the top with origin='upper'", () => {
  const out = run(`
import matplotlib.pyplot as plt
import numpy as np
A = np.array([[0.0, 1.0, 2.0], [3.0, 4.0, np.nan]])
for kw in [{}, {"origin": "lower"}, {"extent": [0, 10, 0, 5]}, {"extent": [0, 10, 5, 0], "origin": "lower"}, {"aspect": "auto"}]:
    fig, ax = plt.subplots()
    im = ax.imshow(A, **kw)
    print(kw, tuple(float(v) for v in ax.get_xlim()), tuple(float(v) for v in ax.get_ylim()), [float(v) for v in im.get_extent()], tuple(float(v) for v in im.get_clim()))
fig, ax = plt.subplots()
im = ax.imshow(np.zeros((2, 3, 3), dtype=np.uint8))
print("rgb", tuple(float(v) for v in ax.get_xlim()), tuple(float(v) for v in ax.get_ylim()))
for origin in ["upper", "lower"]:
    fig, ax = plt.subplots()
    ax.imshow(np.array([[0, 0], [0, 9]]), cmap="gray", origin=origin)
    print(fig._repr_svg_())
`);
  const lines = out.split("\n");
  assert.deepEqual(lines.slice(0, 6), [
    "{} (-0.5, 2.5) (1.5, -0.5) [-0.5, 2.5, 1.5, -0.5] (0.0, 4.0)",
    "{'origin': 'lower'} (-0.5, 2.5) (-0.5, 1.5) [-0.5, 2.5, -0.5, 1.5] (0.0, 4.0)",
    "{'extent': [0, 10, 0, 5]} (0.0, 10.0) (0.0, 5.0) [0.0, 10.0, 0.0, 5.0] (0.0, 4.0)",
    "{'extent': [0, 10, 5, 0], 'origin': 'lower'} (0.0, 10.0) (5.0, 0.0) [0.0, 10.0, 5.0, 0.0] (0.0, 4.0)",
    "{'aspect': 'auto'} (-0.5, 2.5) (1.5, -0.5) [-0.5, 2.5, 1.5, -0.5] (0.0, 4.0)",
    "rgb (-0.5, 2.5) (1.5, -0.5)",
  ]);
  // the picture: the white cell (9) is row 1; with origin 'upper' it is drawn at the bottom
  // (the PNG as stored, not flipped), with 'lower' at the top (the PNG flipped vertically)
  const svgs = lines.slice(6).join("\n").split("</svg>").slice(0, 2);
  for (const [k, svg] of svgs.entries()) {
    const m = /<image href="(data:image\/png;base64,[^"]+)"[^>]*?(transform="matrix\(([^)]*)\)")?\/>/.exec(svg)!;
    assert.ok(m, "an image");
    const rows = png(m[1]);
    assert.deepEqual(rows[0][0], [0, 0, 0, 255]);
    assert.deepEqual(rows[1][1], [255, 255, 255, 255]);
    const flipped = m[3] !== undefined && m[3].split(" ")[3] === "-1";
    assert.equal(flipped, k === 1);
  }
});
