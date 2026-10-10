// Smoke test of the sagebrush-web modules, run before they are published:
//   node cdn/smoke.mjs
const sb = await import("./sagebrush-engine.mjs");
const py = await import("./pyparse.mjs");
const got = JSON.stringify(sb.call("factor_integer", { n: "18446744073709551617" }));
if (got !== JSON.stringify([["274177", 1], ["67280421310721", 1]])) throw new Error(`factor_integer(2^64 + 1) gave ${got}`);
if (JSON.stringify(sb.aplist([0, -1, 1, -10, -20], 7)) !== "[[2,-2],[3,-1],[5,1],[7,-2]]") throw new Error("aplist of 11a1");
if (py.parse("x = 1\n").body.length !== 1) throw new Error("pyparse");
let raised = false;
try { py.parse("x = [1, 2 3]\n"); } catch { raised = true; }
if (!raised) throw new Error("pyparse accepted a syntax error");
console.log(`sagebrush-web ok (${sb.wasmBytes} bytes of wasm)`);
