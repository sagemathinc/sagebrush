import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { corpus, certify } from "./argsort-certificate";
import { R } from "../src/runtime/index";
import { NDArray, toDtype } from "../src/runtime/numpy";
import { callObj } from "../src/runtime/object";
import { execFileSync } from "node:child_process";

const sort = (values: Float64Array) => callObj(R.importModule("_numpy").argsort, [new NDArray(toDtype("float64"), values, [values.length], [1])]).data as Float64Array;

test("numeric argsort corpus has independent permutation/order/stability certificates", () => {
  for (const { values } of corpus()) certify(values, sort(values));
  for (const n of [0, 1, 2, 3, 7, 31, 33, 63, 64, 65, 129, 1025]) {
    const values = Float64Array.from({ length: n }, (_, i) => (i * 13) % 7);
    certify(values, sort(values));
  }
  assert.throws(() => certify(new Float64Array([1, 1]), [1, 0]), /original order/);
  assert.throws(() => certify(new Float64Array([1, 2]), [0, 0]), /unique/);
  assert.throws(() => certify(new Float64Array([1, 2]), [1, 0]), /sorted/);
  assert.throws(() => certify(new Float64Array([1, 2]), [0, 2]), /index range/);
});

test("numeric fallback uses no boxed or native-comparator index sort", () => {
  const code = `globalThis.__SAGEBRUSH_NO_WASM__ = true;
const {R}=require(${JSON.stringify(require.resolve("../src/runtime/index"))});
const {NDArray,toDtype}=require(${JSON.stringify(require.resolve("../src/runtime/numpy"))});
const {callObj}=require(${JSON.stringify(require.resolve("../src/runtime/object"))});
const m=R.importModule('_numpy');
const a=new NDArray(toDtype('float64'),Float64Array.from({length:1025},(_,i)=>(i*13)%47),[1025],[1]);
const old=Array.prototype.sort, typed=Float64Array.prototype.sort;
Array.prototype.sort=function(){if(this.length>32)throw Error('boxed sort');return old.apply(this,arguments)};
Float64Array.prototype.sort=function(c){if(c!==undefined)throw Error('native comparator sort');return typed.call(this)};
const typed32=Uint32Array.prototype.sort;
Uint32Array.prototype.sort=function(c){if(c!==undefined)throw Error('native uint32 comparator sort');return typed32.call(this)};
const r=callObj(m.argsort,[a]);
require(${JSON.stringify(require.resolve("./argsort-certificate"))}).certify(a.data,r.data);
console.log('typed fallback certified');`;
  const r = spawnSync(process.execPath, ["-e", code], { encoding: "utf8", timeout: 30_000 });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "typed fallback certified\n");
});

test("forced JavaScript argsort matches NumPy stable order across axes, views and complex specials", () => {
  const source = `import numpy as np
xs = [np.array([0.0, -0.0, float('nan'), 3.0, -2.0, float('inf'), -float('inf'), 3.0]),
      np.arange(105.0).reshape(3,5,7)[::-1,::2,::-2],
      np.broadcast_to(np.array([3.0,1.0,1.0]),(4,3)),
      np.empty((0,3)), np.empty((3,0)),
      np.array([2**40, -2**40, 7, 7, 0], dtype=np.int64),
      np.array([True,False,True,False])]
cs = [complex(r,i) for r in [0.0,-1.0,float('nan')] for i in [0.0,-2.0,float('nan')]]
xs.append(np.array(cs+cs,dtype=complex).reshape(3,6).T[::-1])
for x in xs:
 for axis in range(x.ndim):
  print(np.argsort(x,axis=axis,kind='stable').tolist())
 print(np.argsort(x,axis=None,kind='stable').tolist())
`;
  const want = execFileSync("python3", ["-c", source], { encoding: "utf8", timeout: 30_000 });
  const got = execFileSync(process.execPath, [require.resolve("../src/cli"), "-c", source], { encoding: "utf8", timeout: 60_000, env: { ...process.env, SAGEBRUSH_NO_WASM: "1" } });
  assert.equal(got, want);
});

test("failed-wasm fallback reuses host buffers, admits before allocation and propagates interrupts", () => {
  const code = `let allocated=0;
for(const name of ['Float64Array','Uint32Array']) {const Base=globalThis[name];globalThis[name]=class extends Base {constructor(...a){super(...a);if(!(a[0] instanceof ArrayBuffer))allocated+=this.byteLength}};}
const {R}=require(${JSON.stringify(require.resolve("../src/runtime/index"))});
const np=require(${JSON.stringify(require.resolve("../src/runtime/numpy"))});
const O=require(${JSON.stringify(require.resolve("../src/runtime/object"))});
const ops=require(${JSON.stringify(require.resolve("../src/runtime/ops"))});
const kernels=require(${JSON.stringify(require.resolve("../src/runtime/kernels"))});
kernels.wasmKernels(); let grows=0;
WebAssembly.Memory.prototype.grow=function(){grows++;throw new RangeError('WebAssembly.Memory.grow(): Maximum memory size exceeded')};
const n=10001, a=new np.NDArray(np.toDtype('float64'),Float64Array.from({length:n},(_,i)=>n-i),[n],[1]);
const m=R.importModule('_numpy'), call=()=>O.callObj(m.argsort,[a]);
const assert=require('node:assert/strict');
const bound=64*n; np.ARRAY_LIMITS.bytes=bound-1; allocated=0;
assert.throws(call,e=>O.isinstance(e,O.T.MemoryError));assert.equal(allocated,0);assert.equal(grows,0);
np.ARRAY_LIMITS.bytes=bound;allocated=0;const out=call();
assert.equal(allocated,20*n);assert.equal(grows,1);assert.equal(out.data[0],n-1);assert.equal(out.data[n-1],0);
const stop=new Error('interrupt control');let polls=0;ops.pollInterrupt=()=>{if(++polls===3)throw stop};
assert.throws(call,e=>e===stop);assert.equal(polls,3);assert.equal(a.data[0],n);assert.equal(a.data[n-1],1);
console.log('20 bytes/element; admission and interrupt controls pass');`;
  const r = spawnSync(process.execPath, ["-e", code], { encoding: "utf8", timeout: 30_000 });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /20 bytes\/element/);
});

test("a refused wasm grow falls back, but an unrelated error remains terminal", () => {
  for (const refused of [true, false]) {
    const code = `const original=WebAssembly.Memory.prototype.grow; let grows=0;
WebAssembly.Memory.prototype.grow=function(){grows++;throw ${refused ? 'new RangeError("WebAssembly.Memory.grow(): Maximum memory size exceeded")' : 'new Error("unrelated failure")'}};
const {wasmArgsort}=require(${JSON.stringify(require.resolve("../src/runtime/kernels"))});
const x=Float64Array.from({length:10000},(_,i)=>10000-i), out=new Float64Array(x.length);
try { const used=wasmArgsort(x,out,0); console.log(used,grows); } catch(e) { console.log(e.message,grows); }`;
    const r = spawnSync(process.execPath, ["-e", code], { encoding: "utf8", timeout: 30_000 });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), refused ? "false 1" : "unrelated failure 1");
  }
});
