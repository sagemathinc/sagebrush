// The dispatcher fixtures (designated_errors.jsonl, designated_ok.jsonl)
// against the WebAssembly engine: the same answers as natively, and no trap
// (a 32-bit usize must not change a request's meaning).
//   node engine/web/tests/wasm_designated.mjs [path/to/sagebrush-engine.wasm]
import { readFileSync } from "node:fs";
const here = new URL(".", import.meta.url);
const wasmPath = process.argv[2] ?? new URL("../../../wasm/sagebrush-engine.wasm", here).pathname;
const module = new WebAssembly.Module(readFileSync(wasmPath));
let w = null;
const fresh = () => (w = new WebAssembly.Instance(module, { sagebrush: { interrupted: () => 0 } }).exports);
fresh();
function call(line) {
  const b = new TextEncoder().encode(line);
  const p = w.sb_alloc(b.length);
  new Uint8Array(w.memory.buffer, p, b.length).set(b);
  try {
    const r = w.sb_call(p, b.length);
    return new TextDecoder().decode(new Uint8Array(w.memory.buffer, r, w.sb_reply_len()));
  } catch (e) {
    fresh(); // a trapped instance is unusable
    return "TRAP " + e.message;
  }
}
let fail = 0;
for (const [file, want] of [["designated_errors.jsonl", '{"error"'], ["designated_ok.jsonl", '{"ok"']]) {
  for (const line of readFileSync(new URL(file, here), "utf8").split("\n").filter((l) => l.trim())) {
    const r = call(line);
    if (!r.startsWith(want)) { fail++; console.log("FAIL " + line + " -> " + r.slice(0, 200)); }
  }
}
// Stop in the a_p kernels (sagebrush_ap: the sieve and every prime check the host's flag, which this
// test answers): a Stop traps the call at once, early (in the sieve) or late (in the a_p loop), and a
// fresh instance works.  Before the checks existed, aplist never asked the host, so a Stop in the
// browser waited for the page's 2 s restart.
{
  let polls = 0, stopAt = Infinity;
  const inst = () => new WebAssembly.Instance(module, { sagebrush: { interrupted: () => (++polls >= stopAt ? 1 : 0) } }).exports;
  const req = new TextEncoder().encode(JSON.stringify({ fn: "aplist", a: [0, 0, 1, -1, 0], n: 2000000 }));
  const run = (x) => {
    const p = x.sb_alloc(req.length);
    new Uint8Array(x.memory.buffer, p, req.length).set(req);
    const t = performance.now();
    try {
      const r = x.sb_call(p, req.length);
      return { ms: performance.now() - t, reply: new TextDecoder().decode(new Uint8Array(x.memory.buffer, r, x.sb_reply_len())) };
    } catch (e) {
      return { ms: performance.now() - t, trap: String(e.message) };
    }
  };
  const full = run(inst());
  const total = polls;
  // Exact, and deterministic (one thread). It derives from n = 2e6 and SIEVE_BLOCK = 2^16 (engine/ap
  // primes_up_to, aplist), so a deliberate retune updates both together:
  //   the sieve's check_coarse calls, each a host poll: 2 (before and after the allocation)
  //     + one per SIEVE_BLOCK-stride block of each marking pass: 222 odd primes up to 1414, 1 block each,
  //       and 5 + 3 + 2 + 1 + 1 more for q = 3, 5, 7, 11, 13 = 234
  //     + one per SIEVE_BLOCK indices of the collection: ceil(999999 / 65536) = 16           = 252;
  //   aplist's per-prime check polls on every 1024th call, the first included:
  //     ceil(148933 primes / 1024)                                                           = 146;
  //   398 in all.  A dropped or thinned check changes it.
  const ok = full.reply?.startsWith('{"ok":[[2,') && total === 398;
  if (!ok) { fail++; console.log(`FAIL aplist(2e6) without a Stop: ${total} host polls (398 expected), ${(full.reply ?? full.trap).slice(0, 80)}`); }
  for (const [label, at] of [["in the sieve", 1], ["in the a_p loop", total - 2]]) {
    polls = 0; stopAt = at;
    const r = run(inst());
    if (!r.trap || r.ms > full.ms) { fail++; console.log(`FAIL Stop ${label} (poll ${at} of ${total}): ${r.trap ? `trapped after ${r.ms.toFixed(0)} ms (full call ${full.ms.toFixed(0)} ms)` : "not stopped"}`); }
  }
  polls = 0; stopAt = Infinity;
  const again = run(inst());
  if (again.reply !== full.reply) { fail++; console.log("FAIL a fresh instance after a Stop: a different aplist"); }
  if (ok) console.log(`wasm: aplist(2e6) polls the host ${total} times (${full.ms.toFixed(0)} ms); a Stop in the sieve or the a_p loop traps it`);
}
console.log(fail ? `${fail} failures` : "wasm: every designated request as expected");
process.exit(fail ? 1 : 0);
