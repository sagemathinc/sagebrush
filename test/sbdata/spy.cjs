// The replay tests' network spy (test/sbdata/HARNESS.md; replay-layer r2 §4):
// loaded with `node --require` (Node 24 runs --require preloads in every
// Worker thread, --import ones only in the main thread: probed), so it is
// installed in the main realm AND in a worker that runs Python.  In each
// realm: globalThis.fetch, XMLHttpRequest and __SAGEBRUSH_FETCH_SYNC__
// throw and record; process.getBuiltinModule refuses (and records) the
// network modules.  A positive control: each realm calls fetch itself once
// at install, recorded as "positive".  Records go to
// $SB_SPY_DIR/<pid>-<threadId>.jsonl.  This is no general network sandbox.
"use strict";
const { appendFileSync } = require("node:fs");
const { threadId } = require("node:worker_threads");

const dir = process.env.SB_SPY_DIR;
if (dir) {
  const file = `${dir}/${process.pid}-${threadId}.jsonl`;
  const rec = (kind, what) => appendFileSync(file, JSON.stringify({ threadId, kind, what: String(what).slice(0, 200) }) + "\n");
  let installing = true;
  rec("installed", threadId);
  const trap = (name) => function (...a) {
    rec(installing ? "positive" : "network", `${name} ${a[0]}`);
    throw new Error(`network refused by the test spy: ${name}`);
  };
  globalThis.fetch = trap("fetch");
  globalThis.XMLHttpRequest = function () {
    rec("network", "XMLHttpRequest");
    throw new Error("network refused by the test spy: XMLHttpRequest");
  };
  globalThis.__SAGEBRUSH_FETCH_SYNC__ = trap("__SAGEBRUSH_FETCH_SYNC__");
  const NET = new Set(["http", "https", "http2", "net", "tls", "dgram", "dns", "undici"]);
  const get = process.getBuiltinModule && process.getBuiltinModule.bind(process);
  if (get) {
    process.getBuiltinModule = (id) => {
      if (NET.has(String(id).replace(/^node:/, ""))) {
        rec("network", `getBuiltinModule ${id}`);
        throw new Error(`network refused by the test spy: ${id}`);
      }
      return get(id);
    };
  }
  try {
    globalThis.fetch("http://spy.invalid/");
  } catch {}
  installing = false;
}
