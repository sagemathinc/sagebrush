import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

// The engine's error replies in pyjs (lib/sagebrush/_engine.py; rank-3 plan
// r3, section 3.5): a reply flagged "internal" (a failed proved invariant of
// the factoring engine) is a RuntimeError; the same message unflagged, and a
// real resource refusal, stay ValueError.
const CLI = __dirname + "/../src/cli.js";

test("pyjs: an internal factoring error is a RuntimeError, a resource refusal a ValueError", () => {
  const src = [
    "import json",
    "from sagebrush import _engine",
    "M = 'factor: internal error (x divides the residual after the pre-pass in small-subset pre-pass); please report it; not factored'",
    "real = _engine._sbengine",
    "class Fake:",
    "    def __init__(self, reply): self.reply = reply",
    "    def call(self, req): return json.dumps(self.reply)",
    "def kind(reply):",
    "    _engine._sbengine = Fake(reply) if reply is not None else real",
    "    try:",
    "        _engine.call('factor', f=['1', '1', '0', '0', '1'], **({} if reply is not None else {'work': 1}))",
    "    except Exception as e:",
    "        return type(e).__name__ + ' ' + ('resource' if 'resource limit exceeded' in str(e) else 'internal' if str(e) == M else str(e))",
    "    finally:",
    "        _engine._sbengine = real",
    "print(kind({'error': M, 'internal': True}))",
    "print(kind({'error': M}))",
    "print(kind(None))",
  ].join("\n");
  const out = execFileSync(process.execPath, [CLI, "-c", src], { encoding: "utf8", timeout: 120000 }).trim().split("\n");
  assert.deepEqual(out, ["RuntimeError internal", "ValueError internal", "ValueError resource"]);
});
