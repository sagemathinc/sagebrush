import test from "node:test";
import assert from "node:assert/strict";
import { initParser, R } from "../src/compile";
import * as gc from "../src/runtime/gc";
import * as Obj from "../src/runtime/object";

// sys._sagebrush_heap_used() (src/runtime/modules.ts): V8's used heap after
// two full collections, not one; after one it still held 0.7 to 2.1 MB a
// second frees, and rare runs 4 to 8 MB more, so Magma mode's load heap
// went over its budget (https://github.com/sagemathinc/sagebrush/issues/1967).
// The builtin itself, called directly, with the collections and the heap
// statistics replaced, so the order of its steps is what is checked: two
// collections, then one read, floored; None, and no read, when either
// collection did not run.
test("sys._sagebrush_heap_used collects twice, then reads the used heap once", async () => {
  await initParser();
  const f = Obj.getattr(R.importModule("sys"), "_sagebrush_heap_used");
  const g = gc as any;
  const fullGc = g.fullGc, getBuiltinModule = process.getBuiltinModule;
  const cases: [boolean[], any, string[]][] = [
    [[true, true], 1234, ["gc", "gc", "read"]],
    [[false], null, ["gc"]],
    [[true, false], null, ["gc", "gc"]],
  ];
  try {
    for (const [outcomes, want, steps] of cases) {
      const events: string[] = [];
      let i = 0;
      g.fullGc = () => {
        events.push("gc");
        return outcomes[i++] ?? false;
      };
      (process as any).getBuiltinModule = (name: string) =>
        name === "node:v8"
          ? { getHeapStatistics: () => (events.push("read"), { used_heap_size: 1234.8 }) }
          : getBuiltinModule.call(process, name);
      assert.equal(Obj.callObj(f, []), want, JSON.stringify(outcomes));
      assert.deepEqual(events, steps, JSON.stringify(outcomes));
    }
  } finally {
    g.fullGc = fullGc;
    (process as any).getBuiltinModule = getBuiltinModule;
  }
});
