// The builtin module _progress: live progress for Python routines
// (progress.ts), behind lib/sagebrush/progress.py.  The CPython package
// provides the same functions natively (engine/py, sagebrush._native).
//
//   begin(op) -> call_id        a call starts (its parent: the innermost one)
//   update(call_id, json)       its counts, written at most every 250 ms
//   flush(call_id)              written now
//   end(call_id)                it ended (on success, error or interrupt)
//   snapshot() -> json          progress/1 records of every call in progress
//   tables() -> json            the names behind the indices

import * as Obj from "./object";
import { newBuiltinModule } from "./modules";
import * as P from "./progress";

const calls = new Map<number, P.Call>();

function update(c: P.Call, u: any) {
  const s = c.s;
  const num = (v: any) => (typeof v === "number" ? v : Number(v));
  if (u.stage !== undefined) s.stage = P.nameIndex(String(u.stage));
  if (u.unit !== undefined) s.unit = P.nameIndex(String(u.unit));
  if (u.stage_index !== undefined) s.stageIndex = num(u.stage_index);
  if (u.stage_count !== undefined) s.stageCount = u.stage_count === null ? null : num(u.stage_count);
  if (u.done !== undefined) s.done = num(u.done);
  if (u.total !== undefined) s.total = u.total === null ? null : num(u.total);
  if (u.work !== undefined) s.work = num(u.work);
  if (u.fraction !== undefined) s.fraction = u.fraction === null ? null : num(u.fraction);
  if (u.beyond_forecast !== undefined) s.beyondForecast = !!u.beyond_forecast;
  if (u.memory_now_bytes !== undefined) s.memoryNowKiB = Math.ceil(num(u.memory_now_bytes) / 1024);
  if (u.memory_peak_bytes !== undefined) s.memoryPeakKiB = Math.ceil(num(u.memory_peak_bytes) / 1024);
}

newBuiltinModule("_progress", (m) => {
  m.begin = Obj.builtin((op: any) => {
    const c = P.begin(P.nameIndex(String(op)));
    calls.set(c.id, c);
    return c.id;
  }, "begin");
  m.update = Obj.builtin((id: any, json: any) => {
    const c = calls.get(Number(id));
    if (c) {
      update(c, JSON.parse(String(json)));
      c.publish();
    }
    return null;
  }, "update");
  m.flush = Obj.builtin((id: any) => {
    calls.get(Number(id))?.flush();
    return null;
  }, "flush");
  m.end = Obj.builtin((id: any) => {
    const c = calls.get(Number(id));
    if (c) {
      calls.delete(c.id);
      c.end();
    }
    return null;
  }, "end");
  m.snapshot = Obj.builtin(() => JSON.stringify(P.snapshot()), "snapshot");
  m.tables = Obj.builtin(() => JSON.stringify(P.tables()), "tables");
});
