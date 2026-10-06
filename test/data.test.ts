import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const cli = (...args: string[]) => execFileSync(process.execPath, [__dirname + "/../src/cli.js", ...args], { encoding: "utf8" });
const py = (code: string) => execFileSync("python3", ["-c", code], { encoding: "utf8" });

test("zlib inflates what CPython's zlib deflates; base64; numpy.frombuffer", () => {
  const dir = mkdtempSync(join(tmpdir(), "sbz-"));
  py(`import zlib, gzip
d = b"".join(bytes([(i * 7919) % 251]) * (i % 5 + 1) for i in range(40000))
open("${dir}/z9", "wb").write(zlib.compress(d, 9)); open("${dir}/z1", "wb").write(zlib.compress(d, 1))
open("${dir}/gz", "wb").write(gzip.compress(d)); print(zlib.crc32(d))`);
  const out = cli("-c", `import zlib, base64, numpy as np
for f, w in (("z9", 15), ("z1", 15), ("gz", 31)):
    print(zlib.crc32(zlib.decompress(open("${dir}/" + f, "rb").read(), w)))
print(zlib.decompress(zlib.compress(b"stored blocks")))
print(base64.b64encode(b"\\x00\\xffab"), base64.b64decode("AP9hYg=="), base64.urlsafe_b64encode(b"\\xfb\\xff"))
print(np.frombuffer(np.array([1.5, -2], dtype=np.float32).tobytes(), dtype=np.float32), np.frombuffer(b"\\x00\\x01", dtype=">u2"))
`);
  const crc = py(`import zlib, gzip
d = b"".join(bytes([(i * 7919) % 251]) * (i % 5 + 1) for i in range(40000)); print(zlib.crc32(d))`).trim();
  const lines = out.trim().split("\n");
  assert.deepEqual(lines.slice(0, 3), [crc, crc, crc]);
  assert.equal(lines[3], "b'stored blocks'");
  assert.equal(lines[4], "b'AP9hYg==' b'\\x00\\xffab' b'-_8='");
  assert.equal(lines[5], "[ 1.5 -2. ] [1]");
});

test("scipy.io.loadmat reads MATLAB 5 files (compressed too) as scipy does; savemat", () => {
  const dir = mkdtempSync(join(tmpdir(), "sbmat-"));
  py(`import scipy.io as sio, numpy as np
sio.savemat("${dir}/a.mat", {"A": np.arange(12.).reshape(3, 4), "i": np.array([[1, -2]], dtype=np.int32), "s": "text",
            "st": {"x": 2.5}, "c": np.array([[1 + 2j]])}, do_compression=True)`);
  const out = cli("-c", `import scipy.io as sio
d = sio.loadmat("${dir}/a.mat")
print(d["A"].shape, d["A"][2, 3], d["i"].dtype, d["i"].tolist(), d["s"], d["st"]["x"].tolist(), d["c"][0, 0])
sio.savemat("${dir}/b.mat", {"B": d["A"] * 2, "t": "ok"})
`);
  assert.equal(out.trim(), "(3, 4) 11.0 int32 [[1, -2]] ['text'] [[2.5]] (1+2j)");
  assert.equal(py(`import scipy.io as sio; d = sio.loadmat("${dir}/b.mat"); print(d["B"][2, 3], d["t"][0])`).trim(), "22.0 ok");
});

test("k3d: a mesh with an attribute, a volume, points; binary scene, snapshot page", () => {
  const dir = mkdtempSync(join(tmpdir(), "sbk3d-"));
  const out = cli("-c", `import k3d, json, numpy as np
from k3d import matplotlib_color_maps
v = np.array([[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]], dtype=np.float64)
plot = k3d.plot(axes=['x^+', 'y', 'z'])
plot += k3d.mesh(v, np.array([[0, 1, 2], [0, 1, 3]]), attribute=[0, 1, 2, 3], color_map=matplotlib_color_maps.seismic, color_range=[0, 3], side='double')
plot += k3d.volume(np.ones((4, 5, 6), dtype=np.float32), bounds=[0, 1, 0, 1, 0, 1]) + k3d.points([[0.5, 0.5, 0.5]], point_size=0.1)
print(plot)
print(plot.description())
b = plot._repr_mimebundle_()
s = json.loads(b["application/vnd.sagebrush.scene3d+json"])
print(sorted(b), [o["type"] for o in s["objects"]], s["version"], s["colorbar"]["range"])
print(len(s["objects"][0]["indices"]), s["objects"][1]["shape"])
open("${dir}/p.html", "w").write(plot.get_snapshot())
`);
  const lines = out.trim().split("\n");
  assert.equal(lines[0], "Plot(3 objects)");
  assert.equal(lines[1], "3D plot: mesh of 2 triangles on 4 vertices, colored by an attribute from 0 to 3, volume of 6x5x4 voxels from 1 to 1, 1 points; x^+ from 0 to 1; y from 0 to 1; z from 0 to 1");
  assert.equal(lines[2], "['application/vnd.sagebrush.scene3d+json', 'image/svg+xml', 'text/plain'] ['mesh2', 'volume', 'points2'] 2 [0.0, 3.0]");
  assert.equal(lines[3], "32 [4, 5, 6]"); // base64 of 6 uint32
});
