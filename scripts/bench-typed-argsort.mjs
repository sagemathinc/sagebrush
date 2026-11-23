// Build TypeScript first; outputs a reproducible, certified shared-host table.
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { performance } from "node:perf_hooks";
const require = createRequire(import.meta.url);
globalThis.__SAGEBRUSH_NO_WASM__ = true;
const { corpus, certify, realOrder } = require("../dist/test/argsort-certificate.js");
const { R } = require("../dist/src/runtime/index.js");
const { NDArray, toDtype } = require("../dist/src/runtime/numpy.js");
const { callObj } = require("../dist/src/runtime/object.js");
const cases = corpus(), m = R.importModule("_numpy"), dt = toDtype("float64");
const encoded = cases.map(({ values }) => Array.from(values, (v) => Number.isFinite(v) ? v : String(v)));
const reference = JSON.parse(execFileSync("python3", ["-c", `import sys,json,time,numpy as np
rows=[]
for values in json.load(sys.stdin):
 a=np.array([float(x) for x in values]); ts=[]
 for _ in range(3):
  t=time.perf_counter(); ix=np.argsort(a,kind='stable'); ts.append((time.perf_counter()-t)*1000)
 rows.append([min(ts),ix.tolist()])
print(json.dumps([np.__version__,rows]))`], { input: JSON.stringify(encoded), encoding: "utf8", maxBuffer: 10 ** 7 }));
const hash = (v) => createHash("sha256").update(Buffer.from(v.buffer, v.byteOffset, v.byteLength)).digest("hex");
console.log(`# Numeric argsort measurements\n\nShared host; min of 3; Node ${process.version}, NumPy ${reference[0]}. No dedicated-VM speed claim.\n`);
console.log("| Case | Typed route ms | Boxed reference ms | NumPy ms | Input SHA256 | Index SHA256 |\n| --- | ---: | ---: | ---: | --- | --- |");
for (let c = 0; c < cases.length; c++) {
  const { name, values } = cases[c], times = [], boxed = [];
  let out;
  for (let run = 0; run < 3; run++) {
    const a = new NDArray(dt, values, [values.length], [1]);
    let t = performance.now(); out = callObj(m.argsort, [a]).data; times.push(performance.now() - t);
    t = performance.now(); Array.from(values, (_, i) => i).sort((i, j) => realOrder(values[i], values[j]) || i - j); boxed.push(performance.now() - t);
    certify(values, out);
  }
  const want = reference[1][c];
  if (!Array.from(out).every((i, k) => i === want[1][k])) throw Error(`NumPy differs: ${name}`);
  console.log(`| ${name} | ${Math.min(...times).toFixed(3)} | ${Math.min(...boxed).toFixed(3)} | ${want[0].toFixed(3)} | ${hash(values)} | ${hash(out)} |`);
}
