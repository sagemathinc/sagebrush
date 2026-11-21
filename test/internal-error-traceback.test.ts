import test from "node:test";
import assert from "node:assert/strict";
import { R, execModule } from "../src/compile";
import { toPyExc } from "../src/runtime/object";

// An internal error (a JavaScript error the runtime did not expect, made a
// SystemError by toPyExc) caught by Python code: its traceback prints from
// the frame that caught it, as any exception's, and its message keeps the
// JavaScript stack. Its stack was read as text for the message first, which
// left no call sites, and printing it failed with NotImplementedError ("which
// frame caught this exception is unknown"), as an @interact function's error
// did on the page.
test("an internal error caught by Python code prints its traceback from the catching frame", () => {
  R.builtins.__sb_test_internal__ = function sbTestInternal() {
    throw new RangeError("The number NaN cannot be converted to a BigInt because it is not an integer");
  };
  const out: string[] = [];
  R.builtins.__sb_test_out__ = (s: any) => { out.push(String(s)); return null; };
  try {
    execModule([
      "import traceback",
      "def g():",
      "    return __sb_test_internal__()",
      "def run():",
      "    try:",
      "        g()",
      "    except Exception as err:",
      "        __sb_test_out__(type(err).__name__)",
      "        __sb_test_out__(''.join(traceback.format_exception(err)))",
      "run()",
    ].join("\n"), "internal_tb.py", "internal_tb");
  } finally {
    delete R.builtins.__sb_test_internal__;
    delete R.builtins.__sb_test_out__;
  }
  assert.equal(out[0], "SystemError");
  assert.match(out[1], /^Traceback \(most recent call last\):\n  File "internal_tb.py", line 6, in run\n/);
  assert.match(out[1], /line 3, in g\n/);
  assert.match(out[1], /SystemError: internal error: RangeError: The number NaN cannot be converted to a BigInt because it is not an integer\n    at sbTestInternal /);
});

// The same error made a Python one twice: a runtime catch that converts it only to ask its type, then rethrows it
// (types.ts, format.ts, json.ts), and then the except that catches it. Its call sites are kept on it, so the second
// conversion has them too; Error.prepareStackTrace is as it was.
test("an internal error converted twice still prints its traceback; Error.prepareStackTrace is restored", () => {
  const prev = (Error as any).prepareStackTrace;
  R.builtins.__sb_test_twice__ = function sbTestTwice() {
    try {
      throw new RangeError("converted twice");
    } catch (e: any) {
      toPyExc(e);
      throw e;
    }
  };
  const out: string[] = [];
  R.builtins.__sb_test_out__ = (s: any) => { out.push(String(s)); return null; };
  try {
    execModule([
      "import traceback",
      "def g():",
      "    return __sb_test_twice__()",
      "def run():",
      "    try:",
      "        g()",
      "    except Exception as err:",
      "        __sb_test_out__(''.join(traceback.format_exception(err)))",
      "run()",
    ].join("\n"), "internal_tb2.py", "internal_tb2");
  } finally {
    delete R.builtins.__sb_test_twice__;
    delete R.builtins.__sb_test_out__;
  }
  assert.match(out[0], /^Traceback \(most recent call last\):\n  File "internal_tb2.py", line 6, in run\n/);
  assert.match(out[0], /SystemError: internal error: RangeError: converted twice\n    at sbTestTwice /);
  assert.equal((Error as any).prepareStackTrace, prev);
});
