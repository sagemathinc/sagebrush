import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { libDir } from "../src/compile";
import { R } from "../src/runtime/index";
import { importModule } from "../src/runtime/modules";
import { isType } from "../src/runtime/object";

// Every function of every public builtin module takes the positional
// argument counts CPython's does (math.sqrt(4, 5) was 2.0: a JS function
// ignores extra arguments).  CPython's counts come from inspect.signature
// (test/module_arity_gen.py); a function inspect cannot read, or one CPython
// lacks, must still have its count checked.
void R;
const MODULES = ["math", "cmath", "os", "sys", "time", "gc", "types", "struct", "re", "binascii", "zlib", "array"];
const TEST = __dirname + "/../../test/";
// Functions whose signature inspect cannot read, with CPython's positional
// counts (from its own errors for 0 and 9 arguments); keyword-only
// parameters are not counted.  hexlify and b2a_hex refuse separators, so
// they may take fewer than CPython's.
const UNREADABLE: Record<string, Record<string, [number, number]>> = {
  binascii: { b2a_hex: [1, 3], hexlify: [1, 3] },
  cmath: { log: [1, 2] },
  math: { log: [1, 2] },
  gc: { set_threshold: [1, 3] },
  os: { chmod: [2, 2], get_terminal_size: [0, 1], link: [2, 2], register_at_fork: [0, 0], utime: [1, 2] },
  struct: { pack: [1, Infinity], pack_into: [3, Infinity] },
  sys: { getsizeof: [1, 2], set_asyncgen_hooks: [0, 2] },
  time: { asctime: [0, 1], clock_getres: [1, 1], clock_settime: [2, 2], clock_settime_ns: [2, 2], ctime: [0, 1], get_clock_info: [1, 1], gmtime: [0, 1], localtime: [0, 1], pthread_getcpuclockid: [1, 1], strftime: [1, 2], strptime: [1, 2] },
  zlib: { compressobj: [0, 6] },
};
const NARROWER = new Set(["binascii.b2a_hex", "binascii.hexlify"]);

test("every builtin module function checks its positional argument count, as CPython's signature (math.sqrt(4, 5) is a TypeError)", () => {
  // (the library on sys.path, as the CLI puts it: os needs posixpath)
  const path = importModule("sys").path;
  if (!path.includes(libDir())) path.push(libDir());
  const want = JSON.parse(execFileSync("python3", [TEST + "module_arity_gen.py", ...MODULES], { encoding: "utf8" }));
  const unchecked: string[] = [], differ: string[] = [];
  let compared = 0;
  for (const mod of MODULES) {
    const m = importModule(mod);
    for (const k of Object.keys(m)) {
      const f = m[k];
      if (typeof f !== "function" || isType(f)) continue;
      // (functions written in Python bind their own arguments)
      if (f.$pyfn === true && f.$globals !== undefined) continue;
      const got: [number, number] | undefined = f.$argRange;
      if (got === undefined) {
        unchecked.push(`${mod}.${k}`);
        continue;
      }
      let w = want[mod]?.[k];
      if (w === null) {
        // (an unreadable signature: the table above, which must list it)
        const u = UNREADABLE[mod]?.[k];
        if (u === undefined) {
          differ.push(`${mod}.${k}: CPython's signature is unreadable and UNREADABLE has no entry`);
          continue;
        }
        if (NARROWER.has(`${mod}.${k}`)) {
          if (got[0] < u[0] || got[1] > u[1]) differ.push(`${mod}.${k}: [${got[0]}, ${got[1]}] not within CPython [${u[0]}, ${u[1]}]`);
          continue;
        }
        w = u;
      }
      if (w === undefined) continue;
      compared++;
      const hi = w[1] === null ? Infinity : w[1];
      if (got[0] !== w[0] || got[1] !== hi) differ.push(`${mod}.${k}: [${got[0]}, ${got[1]}], CPython [${w[0]}, ${hi}]`);
    }
  }
  assert.deepEqual(unchecked, [], "functions without a count check");
  assert.deepEqual(differ, [], "counts unlike CPython's");
  assert.ok(compared >= 140, `compared ${compared}`);
});

test("calls with the wrong count raise TypeError, and the right ones (defaults, keywords) still work, as CPython (test/module_arity_cases.py)", () => {
  const want = execFileSync("python3", [TEST + "module_arity_cases.py"], { encoding: "utf8" });
  const got = execFileSync(process.execPath, [__dirname + "/../src/cli.js", TEST + "module_arity_cases.py"], { encoding: "utf8" });
  const w = want.split("\n"), g = got.split("\n");
  for (let i = 0; i < Math.max(w.length, g.length); i++) assert.equal(g[i], w[i], `line ${i + 1}`);
});
